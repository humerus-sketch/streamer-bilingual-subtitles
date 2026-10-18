"""Stateful CPU-only 48 kHz speech enhancement; never opens audio devices.

Output retains the native algorithm's delay.  Its output sample index minus
``algorithmic_delay_samples`` is the corresponding input timeline index.
``process`` buffers incomplete native frames; ``flush`` drains delayed speech
with zero padding explicitly accounted separately from real captured samples.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import time
from typing import Any

import numpy as np

MODES = ("off", "deepfilternet3", "rnnoise")
SAMPLE_RATE = 48000
_FLOAT_POINTER = ctypes.POINTER(ctypes.c_float)


def _runtime_directory(runtime_dir: str | Path | None) -> Path:
    if runtime_dir is not None:
        return Path(runtime_dir).resolve()
    configured = os.environ.get("BILIBILI_AUDIO_ENHANCEMENT_RUNTIME")
    if configured:
        return Path(configured).resolve()
    return Path(__file__).resolve().parents[2] / ".runtime" / "audio-enhancement-20261018" / "runtime-causal-v2"


def _verified_file(root: Path, relative: str, expected: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise RuntimeError(f"audio_enhancement_runtime_file_missing: {relative}")
    if len(expected) != 64 or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError(f"audio_enhancement_runtime_checksum_mismatch: {relative}")
    return path


def get_enhancement_metadata(mode: str = "off", runtime_dir: str | Path | None = None) -> dict[str, Any]:
    if mode not in MODES:
        raise ValueError(f"unsupported_audio_enhancement: {mode}")
    if mode == "off":
        return {"mode": mode, "sampleRate": SAMPLE_RATE, "frameSize": 1,
                "algorithmicDelaySamples": 0, "algorithmicDelayMs": 0.0,
                "backend": "passthrough", "device": "cpu", "preservesRawInput": True}
    root = _runtime_directory(runtime_dir)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"audio_enhancement_runtime_missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or mode not in manifest.get("engines", {}):
        raise RuntimeError("audio_enhancement_manifest_invalid")
    entry = dict(manifest["engines"][mode])
    if entry.get("sampleRate") != SAMPLE_RATE or entry.get("frameSize") != 480:
        raise RuntimeError("audio_enhancement_native_frame_configuration_invalid")
    dll = _verified_file(root, entry["dll"], entry["dllSha256"])
    if mode == "deepfilternet3":
        if entry.get("modelVariant") != "DeepFilterNet3":
            raise RuntimeError("audio_enhancement_wrong_df3_model_variant")
        model = _verified_file(root, entry["model"], entry["modelSha256"])
        entry["modelPath"] = str(model)
    entry.update(mode=mode, dllPath=str(dll), device="cpu", preservesRawInput=True)
    entry["algorithmicDelayMs"] = entry["algorithmicDelaySamples"] * 1000 / SAMPLE_RATE
    return entry


class StreamingEnhancer:
    def __init__(self, metadata: dict[str, Any]):
        self.profile_metadata = dict(metadata)
        self.mode = metadata["mode"]
        self.sample_rate = SAMPLE_RATE
        self.frame_size = int(metadata["frameSize"])
        self.algorithmic_delay_samples = int(metadata["algorithmicDelaySamples"])
        self.input_samples_received = 0
        self.processed_input_samples = 0
        self.output_samples_emitted = 0
        self.padding_input_samples = 0
        self.processing_seconds = 0.0
        self.processed_frames = 0
        self._pending = np.empty(0, dtype=np.float32)
        self._flushed = False
        self._closed = False

    @property
    def pending_input_samples(self) -> int:
        return int(self._pending.size)

    @property
    def frame_buffer_delay_ms(self) -> float:
        return self.pending_input_samples * 1000 / SAMPLE_RATE

    def _check_open(self) -> None:
        if self._closed:
            raise RuntimeError("audio_enhancement_closed")

    def _process_frames(self, samples: np.ndarray) -> np.ndarray:
        output = np.empty_like(samples)
        t0 = time.perf_counter()
        for pos in range(0, samples.size, self.frame_size):
            self._process_frame(samples[pos:pos + self.frame_size], output[pos:pos + self.frame_size])
            self.processed_frames += 1
        self.processing_seconds += time.perf_counter() - t0
        if not np.isfinite(output).all():
            raise RuntimeError("audio_enhancement_nonfinite_output")
        return output

    def process(self, samples: np.ndarray) -> np.ndarray:
        self._check_open()
        if self._flushed:
            raise RuntimeError("audio_enhancement_already_flushed")
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim != 1 or not np.isfinite(samples).all():
            raise ValueError("audio_enhancement_requires_finite_mono_pcm")
        self.input_samples_received += int(samples.size)
        if self.mode == "off":
            self.processed_input_samples += int(samples.size)
            self.output_samples_emitted += int(samples.size)
            return samples.copy()
        combined = np.concatenate((self._pending, samples))
        complete = combined.size - combined.size % self.frame_size
        self._pending = combined[complete:].copy()
        if not complete:
            return np.empty(0, dtype=np.float32)
        output = self._process_frames(np.ascontiguousarray(combined[:complete]))
        self.processed_input_samples += complete
        self.output_samples_emitted += int(output.size)
        return output

    def flush(self) -> np.ndarray:
        self._check_open()
        if self._flushed:
            return np.empty(0, dtype=np.float32)
        self._flushed = True
        if self.mode == "off" or not self.input_samples_received:
            return np.empty(0, dtype=np.float32)
        real_remaining = self._pending.size
        wanted = real_remaining + self.algorithmic_delay_samples
        padded = ((wanted + self.frame_size - 1) // self.frame_size) * self.frame_size
        values = np.zeros(padded, dtype=np.float32)
        values[:real_remaining] = self._pending
        self.padding_input_samples += padded - real_remaining
        self.processed_input_samples += real_remaining
        self._pending = np.empty(0, dtype=np.float32)
        output = self._process_frames(values)[:wanted].copy()
        self.output_samples_emitted += int(output.size)
        return output

    def diagnostics(self) -> dict[str, Any]:
        return {**self.profile_metadata, "inputSamplesReceived": self.input_samples_received,
                "processedInputSamples": self.processed_input_samples,
                "outputSamplesEmitted": self.output_samples_emitted,
                "pendingInputSamples": self.pending_input_samples,
                "paddingInputSamples": self.padding_input_samples,
                "processingSeconds": self.processing_seconds, "processedFrames": self.processed_frames,
                "frameBufferDelayMs": self.frame_buffer_delay_ms}

    def close(self) -> None:
        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class _NativeEnhancer(StreamingEnhancer):
    def __init__(self, metadata: dict[str, Any]):
        super().__init__(metadata)
        # Absolute verified DLL path, without changing process/global DLL search paths.
        self._dll = ctypes.CDLL(metadata["dllPath"])
        self._state = None
        if self.mode == "rnnoise":
            self._dll.rnnoise_create.argtypes = [ctypes.c_void_p]
            self._dll.rnnoise_create.restype = ctypes.c_void_p
            self._dll.rnnoise_get_frame_size.argtypes = []
            self._dll.rnnoise_get_frame_size.restype = ctypes.c_int
            self._dll.rnnoise_process_frame.argtypes = [ctypes.c_void_p, _FLOAT_POINTER, _FLOAT_POINTER]
            self._dll.rnnoise_process_frame.restype = ctypes.c_float
            self._dll.rnnoise_destroy.argtypes = [ctypes.c_void_p]
            self._dll.rnnoise_destroy.restype = None
            self._state = self._dll.rnnoise_create(None)
            actual_frame = self._dll.rnnoise_get_frame_size()
        else:
            self._dll.df_create.argtypes = [ctypes.c_char_p, ctypes.c_float]
            self._dll.df_create.restype = ctypes.c_void_p
            self._dll.df_get_frame_length.argtypes = [ctypes.c_void_p]
            self._dll.df_get_frame_length.restype = ctypes.c_size_t
            self._dll.df_process_frame.argtypes = [ctypes.c_void_p, _FLOAT_POINTER, _FLOAT_POINTER]
            self._dll.df_process_frame.restype = ctypes.c_float
            self._dll.df_free.argtypes = [ctypes.c_void_p]
            self._dll.df_free.restype = None
            self._state = self._dll.df_create(metadata["modelPath"].encode("utf-8"), ctypes.c_float(100.0))
            if not self._state:
                raise RuntimeError("audio_enhancement_df_create_failed")
            actual_frame = self._dll.df_get_frame_length(self._state)
        if not self._state or actual_frame != self.frame_size:
            self.close()
            raise RuntimeError("audio_enhancement_native_initialization_failed")

    def _process_frame(self, samples: np.ndarray, output: np.ndarray) -> None:
        if self.mode == "rnnoise":
            native_input = np.ascontiguousarray(samples * np.float32(32768.0))
            self._dll.rnnoise_process_frame(self._state, output.ctypes.data_as(_FLOAT_POINTER), native_input.ctypes.data_as(_FLOAT_POINTER))
            output /= np.float32(32768.0)
        else:
            self._dll.df_process_frame(self._state, samples.ctypes.data_as(_FLOAT_POINTER), output.ctypes.data_as(_FLOAT_POINTER))

    def close(self) -> None:
        if self._state:
            if self.mode == "rnnoise":
                self._dll.rnnoise_destroy(self._state)
            else:
                self._dll.df_free(self._state)
            self._state = None
        super().close()


def create_enhancer(mode: str = "off", sample_rate: int = SAMPLE_RATE,
                    runtime_dir: str | Path | None = None) -> StreamingEnhancer:
    if sample_rate != SAMPLE_RATE:
        raise ValueError("audio_enhancement_requires_48000_hz")
    metadata = get_enhancement_metadata(mode, runtime_dir)
    return StreamingEnhancer(metadata) if mode == "off" else _NativeEnhancer(metadata)
