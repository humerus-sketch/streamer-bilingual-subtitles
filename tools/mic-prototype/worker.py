"""Selected microphone -> streaming Silero CPU VAD -> one local Whisper instance.

JSONL is the only stdout protocol. No OAuth, network download, or cloud translation
is performed here. Starting ``run`` explicitly opens the selected input device;
``devices`` and ``doctor`` never open it. Raw audio stays in RAM unless --record
was explicitly supplied. A VAD boundary is an estimate, not a semantic guarantee.
"""

from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass
import importlib.metadata
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import queue
import signal
import site
import sys
import threading
import time
import wave
from typing import Callable

import numpy as np


SAMPLE_RATE = 16000
VAD_FRAME = 512
PROTOCOL_VERSION = 1
RUNTIME_PRE_ROLL_MS = 1500
RUNTIME_POST_ROLL_MS = 300
RUNTIME_VAD_THRESHOLD = 0.35
RUNTIME_PAUSE_MS = 800
_DLL_HANDLES = []


def audio_error_code(error: BaseException) -> str:
    """Classify exception types without matching or exporting private exception text."""
    if isinstance(error, KeyboardInterrupt):
        return "audio_interrupted"
    if isinstance(error, ImportError):
        return "audio_dependency_missing"
    port_audio_error = getattr(sys.modules.get("sounddevice"), "PortAudioError", None)
    if isinstance(port_audio_error, type) and isinstance(error, port_audio_error):
        return "audio_device_unavailable"
    return "audio_runtime_failed"


def configure_cuda_dlls():
    """Only this process uses DLLs in its isolated environment, never system PATH."""
    if sys.platform != "win32":
        return []
    directories = []
    for packages in site.getsitepackages():
        for component in ("cublas", "cudnn"):
            path = Path(packages) / "nvidia" / component / "bin"
            if path.is_dir():
                directories.append(str(path))
                _DLL_HANDLES.append(os.add_dll_directory(str(path)))
    if directories:
        os.environ["PATH"] = os.pathsep.join(directories + [os.environ.get("PATH", "")])
    return directories


def perf_ms() -> float:
    return time.perf_counter_ns() / 1_000_000


class JsonEmitter:
    """One lock prevents ASR/control/capture-processor messages interleaving."""

    def __init__(self, stream=None):
        self.stream = stream if stream is not None else sys.stdout
        self.lock = threading.Lock()

    def __call__(self, event_type: str, **fields):
        event = {"type": event_type, "protocolVersion": PROTOCOL_VERSION,
                 "perfCounterMs": perf_ms(), "unixTimeMs": time.time_ns() / 1_000_000,
                 **fields}
        line = json.dumps(event, ensure_ascii=False, allow_nan=False)
        with self.lock:
            self.stream.write(line + "\n")
            self.stream.flush()


class StreamingResampler:
    """SoXR retains its filter state and reports output on the original time axis.

    The pending filter output is delayed, never retimestamped as fresh audio.
    Flush exactly once at the end of a continuous epoch; reset after a gap.
    """

    def __init__(self, input_rate: int):
        if input_rate <= 0:
            raise ValueError("input_rate must be positive")
        import soxr
        self.input_rate = input_rate
        self.stream = soxr.ResampleStream(input_rate, SAMPLE_RATE, 1,
                                          dtype="float32", quality="HQ")
        self.closed = False
        self.input_samples = 0
        self.output_samples = 0

    def feed(self, mono, final=False):
        if self.closed:
            raise RuntimeError("resampler has already been flushed")
        data = np.asarray(mono, dtype=np.float32)
        if data.ndim != 1 or not np.isfinite(data).all():
            raise ValueError("resampler requires finite mono samples")
        self.input_samples += len(data)
        result = self.stream.resample_chunk(data, last=final)
        self.output_samples += len(result)
        self.closed = bool(final)
        return result

    def delay_ms(self):
        return self.stream.delay() / SAMPLE_RATE * 1000


class SileroOnnx:
    """Streaming CPU VAD without torch, for two explicit upstream ONNX contracts.

    faster-whisper 1.2.1 bundles v6 input/h/c; upstream Silero's standalone
    input/state/sr is also accepted. Both take 512 new samples plus 64 context.
    """

    def __init__(self, model_path: str | Path | None = None, session=None):
        if session is None:
            import onnxruntime as ort
            if model_path is None:
                from faster_whisper.utils import get_assets_path
                model_path = Path(get_assets_path()) / "silero_vad_v6.onnx"
            if not Path(model_path).is_file():
                raise FileNotFoundError(f"VAD model not found: {model_path}")
            options = ort.SessionOptions()
            options.inter_op_num_threads = 1
            options.intra_op_num_threads = 1
            options.enable_cpu_mem_arena = False
            options.log_severity_level = 3
            session = ort.InferenceSession(str(model_path), sess_options=options,
                                           providers=["CPUExecutionProvider"])
        self.session = session
        input_names = {item.name for item in session.get_inputs()}
        if input_names not in ({"input", "state", "sr"}, {"input", "h", "c"}):
            raise ValueError(f"Unsupported Silero ONNX inputs: {sorted(input_names)}")
        self.contract = "h_c" if "h" in input_names else "state_sr"
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, 64), dtype=np.float32)

    def __call__(self, frame) -> float:
        x = np.asarray(frame, dtype=np.float32)
        if x.shape != (VAD_FRAME,) or not np.isfinite(x).all():
            raise ValueError("Silero requires exactly 512 finite mono samples")
        data = np.concatenate((self.context, x.reshape(1, -1)), axis=1)
        if self.contract == "h_c":
            output, self.h, self.c = self.session.run(None, {
                "input": data, "h": self.h, "c": self.c})
        else:
            output, self.state = self.session.run(None, {
                "input": data, "state": self.state,
                "sr": np.array(SAMPLE_RATE, dtype=np.int64)})
        probability = float(np.asarray(output).reshape(-1)[0])
        if not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError("VAD returned invalid probability")
        self.context = data[:, -64:].copy()
        return probability


class CausalVadGain:
    """Bounded low-level sidechain for VAD; ASR keeps the original PCM.

    The current frame and trailing one second determine gain. Normal-level
    frames and digital silence remain unchanged; no future samples are used.
    """

    def __init__(self, base_vad, raw_vad, enhance_quiet=True):
        self.base_vad = base_vad
        self.raw_vad = raw_vad
        self.enhance_quiet = enhance_quiet
        self.reset()

    def reset(self):
        self.parts = deque()
        self.samples = 0
        self.energy = 0.0
        self.frames = self.boosted_frames = 0
        self.max_gain_observed = 1.0
        self.base_vad.reset()
        self.raw_vad.reset()

    def __call__(self, frame):
        x = np.asarray(frame, dtype=np.float32)
        if x.shape != (VAD_FRAME,) or not np.isfinite(x).all():
            raise ValueError("VAD sidechain requires exactly 512 finite samples")
        energy = float(np.sum(x.astype(np.float64) ** 2))
        self.parts.append(x.copy())
        self.samples += len(x)
        self.energy += energy
        while self.samples > SAMPLE_RATE:
            first = self.parts.popleft()
            removed = min(len(first), self.samples - SAMPLE_RATE)
            self.energy -= float(np.sum(first[:removed].astype(np.float64) ** 2))
            self.samples -= removed
            if removed < len(first):
                self.parts.appendleft(first[removed:])
        current_rms = float(np.sqrt(energy / len(x)))
        history_rms = float(np.sqrt(max(0.0, self.energy) / self.samples))
        peak = float(np.max(np.abs(x)))
        gain = 1.0
        if self.enhance_quiet and peak > 0 and current_rms < 0.01 and history_rms < 0.01:
            gain = min(64.0, max(1.0, 10 ** (-26 / 20) / max(current_rms, history_rms)), 1.0 / peak)
        self.frames += 1
        self.boosted_frames += int(gain > 1)
        self.max_gain_observed = max(self.max_gain_observed, gain)
        # An amplified history must not change later normal-level decisions.
        # Both states advance causally using the same frozen ONNX weights.
        raw_probability = self.raw_vad(x)
        enhanced_probability = self.base_vad((x * gain).astype(np.float32))
        return enhanced_probability if gain > 1 else raw_probability

    def diagnostics(self):
        return {"mode": "bounded_causal_gain_raw_state" if self.enhance_quiet else "raw_pcm",
                "gainEnabled": self.enhance_quiet, "historySamples": SAMPLE_RATE,
                "activationRmsDbfs": -40, "targetRmsDbfs": -26, "maxGain": 64,
                "frames": self.frames, "boostedFrames": self.boosted_frames,
                "maxGainObserved": self.max_gain_observed, "asrPcmChanged": False,
                "rawVadStatePreserved": True, "sharedOnnxWeights": True}


def create_streaming_vad(model_path=None, enhance_quiet=True):
    enhanced = SileroOnnx(model_path)
    return CausalVadGain(enhanced, SileroOnnx(session=enhanced.session), enhance_quiet=enhance_quiet)


def runtime_vad_config(args):
    return {"threshold": RUNTIME_VAD_THRESHOLD,
            "negativeThreshold": round(RUNTIME_VAD_THRESHOLD - 0.15, 2),
            "pauseMs": args.pause_ms, "maxSegmentSeconds": args.max_segment_seconds,
            "preRollMs": RUNTIME_PRE_ROLL_MS, "postRollMs": RUNTIME_POST_ROLL_MS,
            "effectivePreRollMs": math.ceil(RUNTIME_PRE_ROLL_MS * SAMPLE_RATE / 1000 / VAD_FRAME)
                                   * VAD_FRAME / SAMPLE_RATE * 1000,
            "levelMode": getattr(args, "vad_level_mode", "raw"),
            "excludeAlreadySubmittedPostroll": True}


def create_runtime_segmenter(emit, args):
    # Retain delayed speech onsets; never send already-submitted tail PCM twice.
    return VadSegmenter(emit, args.pause_ms, args.max_segment_seconds,
                        pre_roll_ms=RUNTIME_PRE_ROLL_MS, post_roll_ms=RUNTIME_POST_ROLL_MS,
                        threshold=RUNTIME_VAD_THRESHOLD)


@dataclass
class AudioSegment:
    segment_id: int
    start_sample: int
    end_sample: int
    input_end_sample: int
    audio: np.ndarray
    forced_boundary: bool
    reason: str
    vad_commit_perf_ms: float
    audio_end_perf_ms: float = 0.0
    audio_timing_source: str = "unknown"
    enhancement: dict | None = None
    voiced_ranges: tuple | None = None
    speaker_admission: dict | None = None

    def metadata(self):
        return {"segmentId": self.segment_id, "revision": 1,
                "startSample": self.start_sample, "endSample": self.end_sample,
                "inputEndSample": self.input_end_sample, "sampleRate": SAMPLE_RATE,
                "audioDurationMs": len(self.audio) / SAMPLE_RATE * 1000,
                "audioEndPerfMs": self.audio_end_perf_ms,
                "audioEndSource": "vad_frame_end",
                "audioEndResolutionMs": VAD_FRAME / SAMPLE_RATE * 1000,
                "audioEndUncertaintyMs": None,
                "audioTimingSource": self.audio_timing_source,
                "audioClockUncertaintyMs": None,
                "vadCommitPerfMs": self.vad_commit_perf_ms,
                "forcedBoundary": self.forced_boundary, "boundaryReason": self.reason,
                "semanticBoundaryVerified": False,
                "enhancement": self.enhancement,
                "voicedRanges": [list(pair) for pair in self.voiced_ranges] if self.voiced_ranges is not None else None,
                "speakerAdmission": self.speaker_admission}


class VadSegmenter:
    """Pause-based segments with explicit forced cuts, no semantic claims.

    The ASR input includes pre/post padding; end_sample is the last VAD speech
    frame endpoint, independent of padding or the configured commit wait.
    """

    def __init__(self, emit: Callable, pause_ms=500, max_seconds=12,
                 pre_roll_ms=192, post_roll_ms=96, threshold=0.5):
        if not 64 <= pause_ms <= 3000 or not 2 <= max_seconds <= 30:
            raise ValueError("pause/max segment settings out of bounds")
        if not 0.1 <= threshold <= 0.95:
            raise ValueError("threshold out of bounds")
        self.emit = emit
        self.pause_samples = round(pause_ms * SAMPLE_RATE / 1000)
        self.max_samples = round(max_seconds * SAMPLE_RATE)
        self.pre_roll_frames = math.ceil(pre_roll_ms * SAMPLE_RATE / 1000 / VAD_FRAME)
        self.post_roll_samples = round(post_roll_ms * SAMPLE_RATE / 1000)
        self.threshold = threshold
        self.negative_threshold = max(0.01, threshold - 0.15)
        self.preroll = deque(maxlen=self.pre_roll_frames)
        self.parts = []
        self.start = self.speech_start = self.last_speech_end = None
        self.last_frame_end = None
        self.next_segment_id = 1
        self.long_notice = False
        self.continuation_speech_end = None
        self.continuation_parts = []
        self.voiced_ranges = []

    def feed(self, frame, start_sample: int, probability: float, valid_samples=None):
        x = np.asarray(frame, dtype=np.float32)
        valid = len(x) if valid_samples is None else valid_samples
        if x.shape != (VAD_FRAME,) or not 0 < valid <= VAD_FRAME:
            raise ValueError("invalid VAD frame")
        if not 0 <= probability <= 1 or not math.isfinite(probability):
            raise ValueError("invalid speech probability")
        if self.last_frame_end is not None and start_sample != self.last_frame_end:
            raise ValueError("non-contiguous segmenter input must be explicitly reset")
        end = start_sample + valid
        self.last_frame_end = end
        item = (start_sample, x[:valid].copy())
        if self.start is None:
            # A forced cut is not a new utterance: preserve the active speech
            # hysteresis until a full pause has elapsed, without resubmitting PCM.
            continuing = self.continuation_speech_end is not None
            start_threshold = self.negative_threshold if continuing else self.threshold
            if probability < start_threshold:
                self.preroll.append(item)
                if continuing:
                    self.continuation_parts.append(item)
                    # Process this low-probability frame before expiring the
                    # active hysteresis, as in the normal active-speech branch.
                    if end - self.continuation_speech_end >= self.pause_samples:
                        self.continuation_speech_end = None
                        self.continuation_parts = []
                return []
            previous = self.continuation_parts if continuing else list(self.preroll)
            self.parts = previous + [item]
            self.start = previous[0][0] if previous else start_sample
            self.speech_start = start_sample
            self.last_speech_end = end
            self.voiced_ranges = [(start_sample, end)]
            self.preroll.clear()
            self.continuation_speech_end = None
            self.continuation_parts = []
        else:
            self.parts.append(item)
            if probability >= self.negative_threshold:
                self.last_speech_end = end
                if self.voiced_ranges and self.voiced_ranges[-1][1] == start_sample:
                    self.voiced_ranges[-1] = (self.voiced_ranges[-1][0], end)
                else:
                    self.voiced_ranges.append((start_sample, end))

        if not self.long_notice and end - self.speech_start >= SAMPLE_RATE * 6:
            self.long_notice = True
            self.emit("long_speech_notice", startSample=self.speech_start,
                      message="No pause boundary yet; no semantic completion inferred")
        if end - self.last_speech_end >= self.pause_samples:
            segment = self._commit("pause", False)
            # Retain only trailing silence, never old speech, as the next pre-roll.
            for previous_item in self._tail_for_preroll:
                self.preroll.append(previous_item)
            return [segment]
        if end - self.speech_start >= self.max_samples:
            return [self._commit("max_duration", True)]
        return []

    def _commit(self, reason: str, forced: bool):
        available_end = self.parts[-1][0] + len(self.parts[-1][1])
        input_end = min(available_end, self.last_speech_end + self.post_roll_samples)
        pcm = np.concatenate([part for _, part in self.parts])[:input_end - self.start]
        segment = AudioSegment(self.next_segment_id, self.start, self.last_speech_end,
                               input_end, pcm, forced, reason, perf_ms())
        segment.voiced_ranges = tuple((max(at, self.start) - self.start, min(until, input_end) - self.start)
                                     for at, until in self.voiced_ranges
                                     if min(until, input_end) > max(at, self.start))
        self.next_segment_id += 1
        # Keep only audio not submitted to ASR. At a maximum-length cut the
        # final low-probability frames may extend beyond the 96 ms post-roll.
        self.continuation_parts = [(max(at, input_end), part[max(0, input_end - at):])
                                   for at, part in self.parts if at + len(part) > input_end] if reason == "max_duration" else []
        self._tail_for_preroll = [(max(at, input_end), part[max(0, input_end - at):])
                                  for at, part in self.parts[-self.pre_roll_frames:]
                                  if at + len(part) > input_end]
        self.parts = []
        self.voiced_ranges = []
        self.start = self.speech_start = self.last_speech_end = None
        self.long_notice = False
        self.preroll.clear()
        self.continuation_speech_end = segment.end_sample if reason == "max_duration" else None
        return segment

    def finish(self, reason="stop"):
        if self.start is None:
            self.continuation_speech_end = None
            self.continuation_parts = []
            return []
        return [self._commit(reason, True)]

    def reset_after_gap(self):
        if self.start is not None:
            raise RuntimeError("flush active speech before resetting a gap")
        self.preroll.clear()
        self.last_frame_end = None
        self.continuation_speech_end = None
        self.continuation_parts = []
        self.voiced_ranges = []


@dataclass
class CaptureBlock:
    native_start: int
    audio: np.ndarray
    adc_perf_ms: float
    timing_source: str
    input_overflow: bool = False
    status: str = ""


class BoundedCaptureBuffer:
    """The callback never waits for a consumer or invokes VAD/ASR/JSON output."""

    def __init__(self, max_samples: int):
        self.max_samples = max_samples
        self.items = deque()
        self.samples = 0
        self.dropped_samples = 0
        self.lock = threading.Lock()

    def push(self, block: CaptureBlock):
        if not self.lock.acquire(blocking=False):
            self.dropped_samples += len(block.audio)
            return False
        try:
            if self.samples + len(block.audio) > self.max_samples:
                self.dropped_samples += len(block.audio)
                return False
            self.items.append(block)
            self.samples += len(block.audio)
            return True
        finally:
            self.lock.release()

    def pop(self):
        with self.lock:
            if not self.items:
                return None
            block = self.items.popleft()
            self.samples -= len(block.audio)
            return block


def adc_perf_time(time_info, callback_perf_ms: float, frames: int, rate: int):
    """Map PortAudio's ADC clock to perf_counter through its currentTime pair."""
    adc = float(time_info.inputBufferAdcTime)
    current = float(time_info.currentTime)
    if math.isfinite(adc) and math.isfinite(current) and adc > 0 and current > 0:
        # Input buffer starts in the past. Large invalid offsets fail closed to
        # an explicitly less accurate arrival-time estimate.
        offset = (adc - current) * 1000
        if -10000 <= offset <= 100:
            return callback_perf_ms + offset, "portaudio_adc"
    return callback_perf_ms - frames / rate * 1000, "callback_arrival_estimate"


def enumerate_devices(sd=None):
    if sd is None:
        import sounddevice as sd
    apis = sd.query_hostapis()
    inventory = []
    for index, info in enumerate(sd.query_devices()):
        if info["max_input_channels"] <= 0:
            continue
        api = apis[info["hostapi"]]["name"]
        wasapi = "WASAPI" in api.upper()
        native_rate = round(info["default_samplerate"])
        supported = []
        extra = sd.WasapiSettings(exclusive=False) if wasapi else None
        for rate in sorted({16000, 44100, 48000, native_rate}):
            try:
                sd.check_input_settings(device=index, channels=1, dtype="float32",
                                        samplerate=rate, extra_settings=extra)
                supported.append(rate)
            except Exception:
                pass
        inventory.append({"index": index, "name": info["name"], "hostApi": api,
                          "hostApiIndex": info["hostapi"], "isWasapi": wasapi,
                          "maxInputChannels": info["max_input_channels"],
                          "defaultSampleRate": native_rate, "supportedRates": supported})
    return inventory


def load_whisper(model_dir: str, compute_type: str):
    if not Path(model_dir).is_dir():
        raise FileNotFoundError(f"Local Whisper directory not found: {model_dir}")
    from faster_whisper import WhisperModel
    return WhisperModel(model_dir, device="cuda", device_index=0,
                        compute_type=compute_type, cpu_threads=4,
                        num_workers=1, local_files_only=True)


def transcribe_audio(model, audio, beam_size=5):
    segments, info = model.transcribe(
        audio, language="ja", task="transcribe", beam_size=beam_size,
        temperature=0, vad_filter=False, condition_on_previous_text=False,
        without_timestamps=True)
    items = list(segments)  # The generator must be exhausted to execute GPU inference.
    text = "".join(item.text for item in items).strip()
    def finite_or_none(value):
        return float(value) if math.isfinite(value) else None
    return text, {"language": info.language,
                  "duration": info.duration,
                  "segments": [{"start": item.start, "end": item.end,
                                 "text": item.text,
                                 "avgLogprob": finite_or_none(item.avg_logprob),
                                 "noSpeechProb": finite_or_none(item.no_speech_prob)} for item in items]}


class AsrConsumer:
    def __init__(self, model, emit, max_pending=2, speaker_verifier=None):
        self.model = model
        self.emit = emit
        self.jobs = queue.Queue(maxsize=max_pending)
        self.thread = threading.Thread(target=self._run, name="single-whisper-asr", daemon=False)
        self.completed = self.failed = self.dropped = 0
        self.fatal = None
        self.speaker_verifier = speaker_verifier
        self.speaker_accepted = self.speaker_rejected = self.speaker_uncertain = 0

    def speaker_diagnostics(self):
        return {"enabled": self.speaker_verifier is not None,
                "accepted": self.speaker_accepted, "rejected": self.speaker_rejected,
                "uncertain": self.speaker_uncertain}

    def start(self):
        self.thread.start()

    def submit(self, segment: AudioSegment):
        # Announce the expected segment before waking the ASR consumer. Even an
        # overflow leaves an auditable expected-but-missing result in the log.
        self.emit("vad_segment", **segment.metadata(),
                  asrPending=min(self.jobs.maxsize, self.jobs.qsize()+1))
        try:
            self.jobs.put_nowait(segment)
            return True
        except queue.Full:
            self.dropped += 1
            self.emit("gap", reason="asr_queue_overflow", **segment.metadata(),
                      message="Speech was not transcribed; counted as a failed segment")
            return False

    def _run(self):
        while True:
            item = self.jobs.get()
            try:
                if item is None:
                    return
                if self.fatal:
                    self.failed += 1
                    self.emit("gap", reason="asr_unavailable", **item.metadata())
                    continue
                dequeued = started = perf_ms()
                phase = "asr"
                try:
                    if self.speaker_verifier is not None:
                        phase = "speaker_admission"
                        gate_started = perf_ms()
                        admission = self.speaker_verifier.verify(item.audio, voiced_ranges=item.voiced_ranges)
                        if not isinstance(admission, dict) or admission.get("decision") not in ("accepted", "rejected", "uncertain"):
                            raise ValueError("Invalid speaker admission result")
                        item.speaker_admission = {**admission, "gateStartPerfMs": gate_started,
                                                  "gateEndPerfMs": perf_ms()}
                        self.emit("speaker_decision", **item.metadata())
                        if admission["decision"] != "accepted":
                            if admission["decision"] == "rejected":
                                self.speaker_rejected += 1
                            else:
                                self.speaker_uncertain += 1
                            self.emit("gap", reason="speaker_rejected" if admission["decision"] == "rejected"
                                      else "speaker_uncertain", **item.metadata())
                            continue
                        self.speaker_accepted += 1
                    started = perf_ms()
                    phase = "asr"
                    ja, detail = transcribe_audio(self.model, item.audio)
                    ended = perf_ms()
                    if ja:
                        self.completed += 1
                        self.emit("asr_result", **item.metadata(), ja=ja,
                                  asrStartPerfMs=started, asrEndPerfMs=ended,
                                  asrMs=ended-started,
                                  asrQueueMs=dequeued-item.vad_commit_perf_ms,
                                  asrDequeuedPerfMs=dequeued,
                                  asrDetail=detail)
                    else:
                        self.failed += 1
                        self.emit("gap", reason="empty_asr", **item.metadata(),
                                  asrStartPerfMs=started, asrEndPerfMs=ended,
                                  message="VAD speech segment produced no Japanese text")
                except Exception as error:
                    self.failed += 1
                    self.fatal = f"{type(error).__name__}: {error}"
                    self.emit("worker_error", phase=phase, fatal=True, code=audio_error_code(error),
                              message=self.fatal, **item.metadata())
            finally:
                self.jobs.task_done()

    def finish(self):
        # Capture is already closed. Waiting here preserves final in-flight work.
        self.jobs.put(None)
        self.jobs.join()
        self.thread.join()


class AlignedEnhancement:
    """Trim native startup delay, while retaining its real availability wait.

    Output coordinates refer to original input samples. Zero padding only drains
    native state and never extends the captured/source duration.
    """

    def __init__(self, mode="off", rate=48000, assets=None, factory=None):
        self.mode, self.rate = mode, rate
        self.factory = factory
        if mode != "off" and factory is None:
            from audio_enhancement import create_enhancer
            self.factory = lambda: create_enhancer(mode, rate, assets)
        self.native = None
        self.epochs = 0
        self.closed_epochs = []
        self.epoch_input = self.epoch_output = 0
        self.skip = 0
        self.initialization_ms = 0.0
        self.metadata = {"mode": "off", "frameSize": 1,
                         "algorithmicDelaySamples": 0, "algorithmicDelayMs": 0.0,
                         "backend": "passthrough", "device": "cpu"}
        self.reset()

    def reset(self):
        if self.native is not None:
            raise RuntimeError("Enhancer must be drained before a new epoch")
        self.epochs += 1
        self.epoch_input = self.epoch_output = 0
        if self.mode != "off":
            started = perf_ms()
            self.native = self.factory()
            self.initialization_ms += perf_ms()-started
            self.metadata = dict(self.native.profile_metadata)
        self.skip = int(self.metadata["algorithmicDelaySamples"])

    def profile(self):
        profile = {**self.metadata, "requestedMode": self.mode,
                "appliedMode": self.mode, "nativeRate": self.rate,
                "asrPcmChanged": self.mode != "off",
                "vadSidechainChangesAsrPcm": False,
                "outputTimeline": "delay_compensated_original_samples"}
        profile["profileSha256"] = hashlib.sha256(json.dumps(profile, sort_keys=True,
            separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
        return profile

    def _aligned(self, output):
        data = np.asarray(output, dtype=np.float32)
        removed = min(self.skip, len(data))
        self.skip -= removed
        data = data[removed:]
        self.epoch_output += len(data)
        return data

    def process(self, data):
        if self.mode != "off" and self.native is None:
            raise RuntimeError("Enhanced epoch has already been flushed")
        self.epoch_input += len(data)
        return self._aligned(self.native.process(data)) if self.native else data

    def flush(self):
        if self.native is None:
            return np.empty(0, dtype=np.float32)
        try:
            if self.epoch_input == 0:
                self.skip = 0
                self.closed_epochs.append(self.native.diagnostics())
                return np.empty(0, dtype=np.float32)
            data = self._aligned(self.native.flush())
            if self.skip or self.epoch_output != self.epoch_input:
                raise RuntimeError("Enhanced output does not match original input duration")
            self.closed_epochs.append(self.native.diagnostics())
            return data
        finally:
            self.native.close()
            self.native = None

    def close(self):
        if self.native is not None:
            self.native.close()
            self.native = None

    def diagnostics(self):
        return {**self.profile(), "epochs": self.epochs,
                "initializationMs": self.initialization_ms,
                "closedEpochs": self.closed_epochs}


def create_audio_enhancement(args, rate):
    return AlignedEnhancement(getattr(args, "enhancement", "off"), rate,
                              getattr(args, "enhancement_assets", None))


def create_speaker_verifier(args):
    assets, profile = getattr(args, "speaker_assets", None), getattr(args, "speaker_profile", None)
    if bool(assets) != bool(profile):
        raise ValueError("Speaker assets and an explicit enrolled profile are both required")
    if not assets:
        return None
    if getattr(args, "enhancement", "off") != "off":
        raise ValueError("Speaker admission requires the unenhanced microphone path")
    from speaker_admission import SpeakerVerifier
    verifier = SpeakerVerifier(assets, profile)
    if verifier.status().get("profileValid") is not True:
        raise ValueError("The explicit speaker profile is not valid for this model")
    return verifier


def write_pcm(recording, data, width=2):
    if recording is None or not len(data):
        return
    # float64 prevents +1.0 rounding beyond signed int32 at native precision.
    values = data.astype(np.float64) if width == 4 else data
    pcm = (np.clip(values, -1, 1) * (2 ** (width*8-1)-1)).astype(
        "<i2" if width == 2 else "<i4")
    recording.writeframesraw(pcm.tobytes())


class AudioPipeline:
    """CPU processor; each capture gap starts a separate continuous time epoch."""

    def __init__(self, rate, vad, segmenter, submit, emit, recording=None,
                 enhancement=None, processed_recording=None, native_recording=None):
        self.rate = rate
        self.vad = vad
        self.segmenter = segmenter
        self.submit = submit
        self.emit = emit
        self.recording = recording
        self.enhancement = enhancement or AlignedEnhancement("off", rate)
        self.processed_recording = processed_recording
        self.native_recording = native_recording
        self.raw_resampler = None
        self.expected_native = 0
        self.previous_adc_end = None
        self.resampler = None
        self.pending = np.empty(0, dtype=np.float32)
        self.next_sample = self.base_sample = 0
        self.anchors = deque(maxlen=1000)
        self.last_level_perf = 0.0
        self.gaps = 0
        self.processed_native_samples = 0
        self.timing_sources = set()
        self.max_resampler_delay_ms = 0.0
        self.asr_input_samples = 0
        self.asr_input_peak = 0.0
        self.pcm16_out_of_range_samples = 0

    def signal_diagnostics(self):
        return {"asrInputEncoding": "float32", "asrInputSamples": self.asr_input_samples,
                "asrInputPeak": self.asr_input_peak,
                "pcm16RecordingOutOfRangeSamples": self.pcm16_out_of_range_samples,
                "processedRecordingEncoding": "PCM_S16LE",
                "processedRecordingIsQuantizedCopy": True,
                "asrInputClippedByRecorder": False}

    def _end_perf(self, sample):
        # The most recent capture anchor preceding the VAD endpoint preserves
        # device clock drift instead of treating delayed DSP output as new audio.
        for start, at, source in reversed(self.anchors):
            if start <= sample:
                return at + (sample - start) * 1000 / SAMPLE_RATE, source
        start, at, source = self.anchors[0]
        return at + (sample-start) * 1000 / SAMPLE_RATE, source

    def _submit_all(self, segments):
        for segment in segments:
            segment.audio_end_perf_ms, segment.audio_timing_source = self._end_perf(segment.end_sample)
            segment.enhancement = self.enhancement.profile()
            self.submit(segment)

    def _consume(self, data):
        if len(data):
            self.asr_input_samples += len(data)
            self.asr_input_peak = max(self.asr_input_peak, float(np.max(np.abs(data))))
            self.pcm16_out_of_range_samples += int(np.count_nonzero(np.abs(data) > 1))
        if self.enhancement.mode == "off":
            write_pcm(self.recording, data)
        write_pcm(self.processed_recording, data)
        if len(data):
            self.pending = np.concatenate((self.pending, data))
        while len(self.pending) >= VAD_FRAME:
            frame, self.pending = self.pending[:VAD_FRAME], self.pending[VAD_FRAME:]
            probability = self.vad(frame)
            self._submit_all(self.segmenter.feed(frame, self.next_sample, probability))
            self.next_sample += VAD_FRAME

    def _finish_epoch(self, reason):
        if self.resampler is None:
            return
        self._consume(self.resampler.feed(self.enhancement.flush()))
        self._consume(self.resampler.feed(np.empty(0, dtype=np.float32), final=True))
        if self.raw_resampler is not None:
            write_pcm(self.recording, self.raw_resampler.feed(np.empty(0, dtype=np.float32), final=True))
            self.raw_resampler = None
        if len(self.pending):
            valid = len(self.pending)
            padded = np.pad(self.pending, (0, VAD_FRAME-valid))
            self._submit_all(self.segmenter.feed(
                padded, self.next_sample, self.vad(padded), valid_samples=valid))
            self.next_sample += valid
            self.pending = np.empty(0, dtype=np.float32)
        self._submit_all(self.segmenter.finish(reason))
        self.resampler = None

    def feed(self, block: CaptureBlock):
        native_gap = block.native_start - self.expected_native
        adc_gap_ms = (block.adc_perf_ms - self.previous_adc_end
                      if self.previous_adc_end is not None else 0.0)
        # Known callback-queue drops have exact counts. Driver overflow is an
        # unknown missing count, reported separately without inventing samples.
        clock_discontinuity = self.previous_adc_end is not None and abs(adc_gap_ms) > 100
        if block.status and not block.input_overflow:
            self.emit("capture_status", status=block.status, nativeStart=block.native_start)
        if native_gap or block.input_overflow or clock_discontinuity:
            self._finish_epoch("capture_gap")
            self.segmenter.reset_after_gap()
            self.vad.reset()
            self.gaps += 1
            self.emit("gap", reason="capture_discontinuity", nativeStart=block.native_start,
                      knownMissingNativeSamples=max(0, native_gap),
                      driverOverflow=block.input_overflow, adcGapMs=adc_gap_ms,
                      unknownMissingSamples=bool(block.input_overflow or clock_discontinuity),
                      recordingGapPolicy="missing_samples_omitted" if self.recording else "not_recorded")
        if self.resampler is None:
            if self.processed_native_samples:
                self.enhancement.reset()
            self.resampler = StreamingResampler(self.rate)
            if self.enhancement.mode != "off" and self.recording is not None:
                self.raw_resampler = StreamingResampler(self.rate)
            # The coordinates include exactly known dropped callback samples.
            # Unknown driver losses are separate gaps; ADC mapping remains real.
            self.base_sample = round(block.native_start * SAMPLE_RATE / self.rate)
            self.next_sample = self.base_sample
            self.anchors.clear()
        start_sample = round(block.native_start * SAMPLE_RATE / self.rate)
        self.anchors.append((start_sample, block.adc_perf_ms, block.timing_source))
        self.timing_sources.add(block.timing_source)
        write_pcm(self.native_recording, block.audio, width=4)
        if self.raw_resampler is not None:
            write_pcm(self.recording, self.raw_resampler.feed(block.audio))
        self._consume(self.resampler.feed(self.enhancement.process(block.audio)))
        self.max_resampler_delay_ms = max(self.max_resampler_delay_ms,
                                         self.resampler.delay_ms())
        self.expected_native = block.native_start + len(block.audio)
        self.previous_adc_end = block.adc_perf_ms + len(block.audio) / self.rate * 1000
        self.processed_native_samples += len(block.audio)
        now = perf_ms()
        if now - self.last_level_perf >= 500:
            self.last_level_perf = now
            # Audio-only timing evidence also supports unattended live-mic
            # source-end measurement; no PCM or transcript is in this event.
            self.emit("heartbeat", heartbeatKind="audio_clock_anchor", nativeStart=block.native_start,
                      nativeSamples=len(block.audio), nativeSampleRate=self.rate,
                      adcPerfMs=block.adc_perf_ms, audioTimingSource=block.timing_source)
            self.emit("audio_level", rms=float(np.sqrt(np.mean(block.audio.astype(np.float64)**2))),
                      peak=float(np.max(np.abs(block.audio))),
                      processedAudioMs=self.processed_native_samples / self.rate * 1000,
                      resamplerDelayMs=self.resampler.delay_ms(),
                      audioTimingSource=block.timing_source)

    def finish(self):
        try:
            self._finish_epoch("stop")
        finally:
            self.enhancement.close()


def control_reader(stop, emit, stream=None, stop_on_eof=True):
    for line in (stream if stream is not None else sys.stdin):
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError("control message must be an object")
            if command.get("command") == "stop":
                stop.set()
            elif command.get("command") == "clock":
                emit("clock_sync", id=command.get("id"))
            else:
                emit("control_error", message="Unknown command")
        except (ValueError, TypeError) as error:
            emit("control_error", message=str(error))
    # A closed parent pipe must stop active capture even after an abnormal
    # gateway exit. The standalone file command may opt out for batch replay.
    if stop_on_eof:
        stop.set()


def create_recording(path, rate=SAMPLE_RATE, width=2):
    if not path:
        return None
    output = Path(path)
    # Exclusive creation prevents overwriting a user recording.
    handle = output.open("xb")
    recording = wave.open(handle, "wb")
    recording.setnchannels(1)
    recording.setsampwidth(width)
    recording.setframerate(rate)
    return recording, handle


def close_recordings(pairs):
    for pair in pairs:
        if pair:
            pair[0].close()
            pair[1].close()


def create_recordings(specifications):
    pairs = []
    try:
        for path, rate, width in specifications:
            pairs.append(create_recording(path, rate, width))
        return pairs
    except BaseException:
        close_recordings(pairs)
        raise


def run_microphone(args, emit):
    import sounddevice as sd
    inventory = enumerate_devices(sd)
    selected = next((item for item in inventory if item["index"] == args.device), None)
    if selected is None or not selected["isWasapi"]:
        raise ValueError("Select an explicit WASAPI input device from devices inventory")
    rate = selected["defaultSampleRate"]
    if getattr(args, "enhancement", "off") != "off":
        rate = 48000
    if rate not in selected["supportedRates"]:
        raise ValueError("Selected device does not support native-rate mono float32 capture")
    # Start the control listener before model loading: a Stop during preparation
    # cancels opening the device rather than briefly recording after cancellation.
    stop = threading.Event()
    threading.Thread(target=control_reader, args=(stop, emit), daemon=True).start()
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    enhancement = create_audio_enhancement(args, rate)
    try:
        speaker_verifier = create_speaker_verifier(args)
        model = load_whisper(args.model_dir, args.compute_type)
        vad = create_streaming_vad(args.vad_model, enhance_quiet=getattr(args, "vad_level_mode", "raw") == "bounded_gain")
        warmup_start = perf_ms()
        if not stop.is_set():
            transcribe_audio(model, np.zeros(SAMPLE_RATE, dtype=np.float32), beam_size=1)
        warmup_ms = perf_ms()-warmup_start
    except BaseException:
        enhancement.close()
        raise
    if stop.is_set():
        enhancement.close()
        emit("session_stopped", cancelledBeforeCapture=True, microphoneOpened=False,
             capturedNativeSamples=0, processedNativeSamples=0, asrCompleted=0,
             asrFailed=0, asrQueueDropped=0, captureGapEvents=0, complete=True)
        return
    emit("worker_ready", device=selected, sampleRate=SAMPLE_RATE,
         nativeSampleRate=rate, model="Whisper large-v3", language="ja",
         task="transcribe", computeType=args.compute_type,
         recordingEnabled=bool(args.record), clock="time.perf_counter",
         pauseMs=args.pause_ms, maxSegmentSeconds=args.max_segment_seconds,
         vadInputMode=vad.diagnostics()["mode"],
         vadConfig=runtime_vad_config(args),
         enhancement=enhancement.profile(),
         speakerAdmission={"enabled": speaker_verifier is not None,
                           "profile": speaker_verifier.profile() if speaker_verifier else None},
         syntheticWarmupMs=warmup_ms)
    segmenter = create_runtime_segmenter(emit, args)
    try:
        recorder_pair, processed_pair, native_pair = create_recordings([
            (args.record, SAMPLE_RATE, 2),
            (getattr(args, "processed_record", None), SAMPLE_RATE, 2),
            (getattr(args, "raw_native_record", None), rate, 4)])
    except BaseException:
        enhancement.close()
        raise
    recorder = recorder_pair[0] if recorder_pair else None
    consumer = AsrConsumer(model, emit, speaker_verifier=speaker_verifier)
    consumer.start()
    pipeline = AudioPipeline(rate, vad, segmenter, consumer.submit, emit, recorder,
                             enhancement, processed_pair[0] if processed_pair else None,
                             native_pair[0] if native_pair else None)
    buffer = BoundedCaptureBuffer(rate * 3)
    native_cursor = 0
    callback_error = []
    capture_failed = False

    def callback(indata, frames, time_info, status):
        nonlocal native_cursor
        start = native_cursor
        native_cursor += frames
        try:
            now = perf_ms()
            at, timing_source = adc_perf_time(time_info, now, frames, rate)
            buffer.push(CaptureBlock(start, indata[:, 0].copy(), at, timing_source,
                                     bool(status.input_overflow), str(status)))
        except Exception as error:
            callback_error.append(f"{type(error).__name__}: {error}")
            stop.set()

    try:
        extra = sd.WasapiSettings(exclusive=False)
        with sd.InputStream(device=args.device, samplerate=rate, channels=1,
                            dtype="float32", blocksize=0, latency="high",
                            extra_settings=extra, callback=callback) as stream:
            emit("session_started", device=selected, nativeSampleRate=rate,
                 inputLatencyMs=float(stream.latency) * 1000,
                 recordingEnabled=bool(args.record), sharedMode=True)
            while not stop.is_set():
                block = buffer.pop()
                if block is None:
                    stop.wait(0.005)
                else:
                    pipeline.feed(block)
                if consumer.fatal:
                    stop.set()
                if not stream.active:
                    capture_failed = True
                    emit("worker_error", phase="capture", fatal=True, code="audio_device_unavailable",
                         message="Input stream became inactive unexpectedly")
                    stop.set()
        # InputStream is stopped first, so the callback cannot race the drain.
        while (block := buffer.pop()) is not None:
            pipeline.feed(block)
    finally:
        try:
            pipeline.finish()
        finally:
            consumer.finish()
            close_recordings([recorder_pair, processed_pair, native_pair])
    trailing_missing = native_cursor - pipeline.expected_native
    if trailing_missing > 0:
        emit("gap", reason="capture_tail_dropped", knownMissingNativeSamples=trailing_missing)
        pipeline.gaps += 1
    if callback_error:
        emit("worker_error", phase="callback", fatal=True, code="audio_runtime_failed", message=callback_error[0])
    emit("session_stopped", capturedNativeSamples=native_cursor,
         processedNativeSamples=pipeline.processed_native_samples,
         droppedNativeSamples=buffer.dropped_samples, captureGapEvents=pipeline.gaps,
         asrCompleted=consumer.completed, asrFailed=consumer.failed,
         asrQueueDropped=consumer.dropped,
         speakerAdmission=consumer.speaker_diagnostics(),
         audioTimingSources=sorted(pipeline.timing_sources),
         maxResamplerDelayMs=pipeline.max_resampler_delay_ms,
         vadLevel=vad.diagnostics(),
         enhancement=enhancement.diagnostics(),
         asrInputSignal=pipeline.signal_diagnostics(),
         complete=not (capture_failed or callback_error or consumer.failed or consumer.dropped or
                       buffer.dropped_samples or pipeline.gaps))


def read_pcm_wav(path):
    with wave.open(str(path), "rb") as source:
        if source.getcomptype() != "NONE":
            raise ValueError("Only uncompressed PCM WAV is supported")
        channels, rate, width = source.getnchannels(), source.getframerate(), source.getsampwidth()
        if width not in (2, 4) or not 1 <= channels <= 8:
            raise ValueError("Only 16/32-bit PCM WAV with 1..8 channels is supported")
        raw = source.readframes(source.getnframes())
    data = np.frombuffer(raw, dtype="<i2" if width == 2 else "<i4")
    mono = data.reshape(-1, channels).astype(np.float32).mean(axis=1)
    mono /= float(2 ** (width*8-1))
    return mono, rate


def run_file(args, emit):
    stop = threading.Event()
    # File replay never opens an input device. It remains usable as a normal
    # batch command with stdin redirected, while accepting Stop during loading.
    threading.Thread(target=control_reader, args=(stop, emit),
                     kwargs={"stop_on_eof": False}, daemon=True).start()
    audio, rate = read_pcm_wav(args.audio_file)
    enhancement = create_audio_enhancement(args, rate)
    try:
        speaker_verifier = create_speaker_verifier(args)
        model = load_whisper(args.model_dir, args.compute_type)
        vad = create_streaming_vad(args.vad_model, enhance_quiet=getattr(args, "vad_level_mode", "raw") == "bounded_gain")
        # Match the microphone path's synthetic warmup before replay time zero.
        warmup_start = perf_ms()
        if not stop.is_set():
            transcribe_audio(model, np.zeros(SAMPLE_RATE, dtype=np.float32), beam_size=1)
        warmup_ms = perf_ms()-warmup_start
    except BaseException:
        enhancement.close()
        raise
    if stop.is_set():
        enhancement.close()
        emit("session_stopped", source="file", cancelledBeforeCapture=True,
             microphoneOpened=False, processedNativeSamples=0, asrCompleted=0,
             asrFailed=0, asrQueueDropped=0, captureGapEvents=0, complete=True)
        return
    emit("worker_ready", source="file", sampleRate=SAMPLE_RATE, nativeSampleRate=rate,
         realtime=args.realtime, computeType=args.compute_type,
         syntheticWarmupMs=warmup_ms,
         vadInputMode=vad.diagnostics()["mode"],
         enhancement=enhancement.profile(),
         speakerAdmission={"enabled": speaker_verifier is not None,
                           "profile": speaker_verifier.profile() if speaker_verifier else None},
         vadConfig=runtime_vad_config(args))
    try:
        processed_pair = create_recording(getattr(args, "processed_record", None))
    except BaseException:
        enhancement.close()
        raise
    consumer = AsrConsumer(model, emit, speaker_verifier=speaker_verifier)
    consumer.start()
    segmenter = create_runtime_segmenter(emit, args)
    pipeline = AudioPipeline(rate, vad, segmenter, consumer.submit, emit,
                             enhancement=enhancement,
                             processed_recording=processed_pair[0] if processed_pair else None)
    origin = perf_ms()
    emit("session_started", source="file", realtime=args.realtime,
         replayOriginPerfMs=origin, sourceNativeSamples=len(audio), nativeSampleRate=rate,
         latencyInterpretation="realtime_replay_estimate" if args.realtime else "offline_not_live_latency")
    step = max(1, round(rate * 0.02))
    try:
        for offset in range(0, len(audio), step):
            if stop.is_set():
                break
            chunk = audio[offset:offset+step]
            if args.realtime:
                stop.wait(max(0, (origin + (offset + len(chunk))/rate*1000 - perf_ms()) / 1000))
                if stop.is_set():
                    break
            pipeline.feed(CaptureBlock(offset, chunk, origin + offset/rate*1000,
                                       "file_replay_origin"))
            if consumer.fatal:
                break
    finally:
        try:
            pipeline.finish()
        finally:
            consumer.finish()
            close_recordings([processed_pair])
    emit("session_stopped", source="file", realtime=args.realtime,
         processedNativeSamples=pipeline.processed_native_samples,
         captureGapEvents=pipeline.gaps, asrCompleted=consumer.completed,
         asrFailed=consumer.failed, asrQueueDropped=consumer.dropped,
         speakerAdmission=consumer.speaker_diagnostics(),
         vadLevel=vad.diagnostics(),
         enhancement=enhancement.diagnostics(),
         asrInputSignal=pipeline.signal_diagnostics(),
         complete=not (consumer.failed or consumer.dropped or pipeline.gaps),
         latencyInterpretation="realtime_replay_estimate" if args.realtime else "offline_not_live_latency")


def doctor(args, emit):
    versions = {}
    for name in ("numpy", "soxr", "sounddevice", "onnxruntime", "faster-whisper", "ctranslate2"):
        versions[name] = importlib.metadata.version(name)
    import ctranslate2
    emit("doctor_environment", python=sys.version, versions=versions,
         cudaDeviceCount=ctranslate2.get_cuda_device_count(),
         cudaComputeTypes=sorted(ctranslate2.get_supported_compute_types("cuda")),
         computeType=args.compute_type, microphoneOpened=False)
    vad = SileroOnnx(args.vad_model)
    emit("doctor_vad", silenceProbability=vad(np.zeros(VAD_FRAME, dtype=np.float32)),
         provider="CPUExecutionProvider")
    started = perf_ms()
    model = load_whisper(args.model_dir, args.compute_type)
    loaded = perf_ms()
    ja, _ = transcribe_audio(model, np.zeros(SAMPLE_RATE, dtype=np.float32), beam_size=1)
    emit("doctor_complete", modelLoadMs=loaded-started, inferenceMs=perf_ms()-loaded,
         syntheticSilence=True, returnedText=ja, microphoneOpened=False,
         computeType=args.compute_type, actualCudaInference=True)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="mode", required=True)
    commands.add_parser("devices")
    for mode in ("doctor", "run", "file"):
        command = commands.add_parser(mode)
        command.add_argument("--model-dir", required=True)
        command.add_argument("--vad-model")
        command.add_argument("--compute-type", choices=("int8_float16", "float16"),
                             default="float16")
        if mode != "doctor":
            command.add_argument("--pause-ms", type=int, default=RUNTIME_PAUSE_MS)
            command.add_argument("--vad-level-mode", choices=("raw", "bounded_gain"), default="raw",
                                 help="Raw mic PCM by default; low-level gain is an explicit option")
            command.add_argument("--max-segment-seconds", type=float, default=12)
            command.add_argument("--enhancement", choices=("off", "deepfilternet3", "rnnoise"), default="off")
            command.add_argument("--enhancement-assets")
            command.add_argument("--speaker-assets", help="Local verified speaker model assets; no automatic download")
            command.add_argument("--speaker-profile", help="Explicit locally enrolled profile; never inferred from first audio")
            command.add_argument("--processed-record", help="Explicit opt-in ASR input 16 kHz PCM WAV; must not exist")
        if mode == "run":
            command.add_argument("--device", type=int, required=True)
            command.add_argument("--record", help="Explicit opt-in 16 kHz PCM WAV path, must not exist")
            command.add_argument("--raw-native-record", help="Explicit opt-in raw native-rate PCM32 WAV; must not exist")
        if mode == "file":
            command.add_argument("--audio-file", required=True)
            command.add_argument("--realtime", action="store_true")
    return result


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    args = parser().parse_args(argv)
    emit = JsonEmitter()
    try:
        configure_cuda_dlls()
        if args.mode == "devices":
            emit("devices", devices=enumerate_devices(), microphoneOpened=False,
                 requiresExplicitSelection=True)
        elif args.mode == "doctor":
            doctor(args, emit)
        elif args.mode == "run":
            run_microphone(args, emit)
        else:
            run_file(args, emit)
        return 0
    except KeyboardInterrupt:
        emit("worker_error", phase=args.mode, fatal=True, code="audio_interrupted", message="Interrupted")
        return 130
    except Exception as error:
        emit("worker_error", phase=args.mode, fatal=True, code=audio_error_code(error),
             message=f"{type(error).__name__}: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
