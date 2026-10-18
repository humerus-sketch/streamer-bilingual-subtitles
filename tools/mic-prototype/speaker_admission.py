"""Local, fail-closed speaker admission; never alters the PCM sent to ASR.

Profiles contain biometric embeddings and stay local. Only explicitly allowlisted
metadata leaves this module. A similarity gate is neither source separation nor
replay protection. CLI enrollment opens a microphone only for the enroll command.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import signal
import sys
import threading
import time
import uuid
import wave
from datetime import datetime, timezone

import numpy as np

SAMPLE_RATE = 16000
FEATURE_VERSION = "wespeaker-kaldi80-hamming25-hop10-dither0-cmn-v1"
SCHEMA_VERSION = 1
MAX_AUDIO_SECONDS = 120
MIN_ENROLLMENT_VOICED_MS = 10000
MIN_ENROLLMENT_SEGMENTS = 3
MIN_ENROLLMENT_CONSISTENCY = 0.35
_SAFE_PROFILE_FIELDS = (
    "profileId", "createdAt", "sourceKind", "modelId", "modelSha256",
    "featureVersion", "threshold", "minVoicedMs", "enrollmentVoicedMs",
    "embeddingDimension", "enrollmentSegments", "calibrationStatus",
)


class SpeakerAdmissionError(Exception):
    """Public codes deliberately omit paths, audio, vectors and exception text."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def _read_json(path, max_bytes=200000):
    try:
        size = Path(path).stat().st_size
        if not 0 < size <= max_bytes:
            raise SpeakerAdmissionError("speaker_document_invalid")
        raw = Path(path).read_bytes()
        document = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(document, dict):
            raise ValueError()
        return document, raw
    except SpeakerAdmissionError:
        raise
    except Exception:
        raise SpeakerAdmissionError("speaker_document_invalid") from None


def _threshold(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SpeakerAdmissionError("speaker_threshold_invalid")
    number = float(value)
    if not math.isfinite(number) or not -1 < number < 1:
        raise SpeakerAdmissionError("speaker_threshold_invalid")
    return number


def _audio(audio):
    try:
        result = np.asarray(audio, dtype=np.float32)
        if (result.ndim != 1 or not len(result) or
                len(result) > SAMPLE_RATE * MAX_AUDIO_SECONDS or
                not np.isfinite(result).all() or
                # SoXR's bandlimited interpolation can slightly overshoot the
                # original ADC range. Preserve it; reject integer-scale input.
                float(np.max(np.abs(result))) > 2.0):
            raise ValueError()
        return result
    except Exception:
        raise SpeakerAdmissionError("speaker_audio_invalid") from None


def _ranges(ranges, length):
    answer = []
    try:
        for item in ranges:
            if not isinstance(item, (tuple, list)) or len(item) != 2:
                raise ValueError()
            start, end = item
            if (isinstance(start, bool) or isinstance(end, bool) or
                    not isinstance(start, (int, np.integer)) or
                    not isinstance(end, (int, np.integer))):
                raise ValueError()
            start, end = int(start), int(end)
            if start < 0 or end > length or end <= start:
                raise ValueError()
            if answer and start < answer[-1][1]:
                raise ValueError()
            if answer and start == answer[-1][1]:
                answer[-1] = (answer[-1][0], end)
            else:
                answer.append((start, end))
    except Exception:
        raise SpeakerAdmissionError("speaker_voiced_ranges_invalid") from None
    return answer


def _unit(vector, dimension):
    try:
        result = np.asarray(vector, dtype=np.float32)
        if result.shape != (dimension,) or not np.isfinite(result).all():
            raise ValueError()
        norm = float(np.linalg.norm(result.astype(np.float64)))
        if not math.isfinite(norm) or norm < 1e-8:
            raise ValueError()
        return result / np.float32(norm)
    except Exception:
        raise SpeakerAdmissionError("speaker_embedding_invalid") from None


def load_assets(model_assets):
    path = Path(model_assets)
    if path.is_dir():
        path = path / "manifest.json"
    if not path.is_file():
        raise SpeakerAdmissionError("speaker_assets_missing")
    manifest, _ = _read_json(path)
    required = {"schemaVersion": SCHEMA_VERSION, "sampleRate": SAMPLE_RATE,
                "featureVersion": FEATURE_VERSION, "inputName": "feats",
                "outputName": "embs", "provider": "CPUExecutionProvider"}
    if any(manifest.get(key) != value for key, value in required.items()):
        raise SpeakerAdmissionError("speaker_assets_contract_invalid")
    if manifest.get("modelId") not in ("campplus", "resnet293_lm"):
        raise SpeakerAdmissionError("speaker_model_unsupported")
    expected_dim = 512 if manifest["modelId"] == "campplus" else 256
    if manifest.get("embeddingDimension") != expected_dim:
        raise SpeakerAdmissionError("speaker_assets_contract_invalid")
    filename = manifest.get("file")
    if not isinstance(filename, str) or Path(filename).is_absolute():
        raise SpeakerAdmissionError("speaker_assets_contract_invalid")
    resolved = (path.parent / filename).resolve()
    if not resolved.is_relative_to(path.parent.resolve()) or not resolved.is_file():
        raise SpeakerAdmissionError("speaker_model_missing")
    if (resolved.stat().st_size != manifest.get("sizeBytes") or
            _file_sha(resolved) != manifest.get("sha256")):
        raise SpeakerAdmissionError("speaker_model_integrity_failed")
    _threshold(manifest.get("defaultThreshold"))
    return manifest, resolved


def compute_fbank(audio):
    """Match WeSpeaker infer_onnx.py, without torch or torchaudio."""
    import kaldi_native_fbank as knf
    options = knf.FbankOptions()
    options.frame_opts.samp_freq = SAMPLE_RATE
    options.frame_opts.frame_length_ms = 25
    options.frame_opts.frame_shift_ms = 10
    options.frame_opts.dither = 0
    options.frame_opts.window_type = "hamming"
    options.frame_opts.snip_edges = True
    options.mel_opts.num_bins = 80
    options.mel_opts.is_librosa = False
    options.use_energy = False
    computer = knf.OnlineFbank(options)
    computer.accept_waveform(SAMPLE_RATE, np.asarray(audio, dtype=np.float32) * 32768.0)
    computer.input_finished()
    count = computer.num_frames_ready
    if count < 1:
        raise SpeakerAdmissionError("speaker_features_empty")
    features = np.stack([computer.get_frame(i) for i in range(count)]).astype(np.float32)
    features -= features.mean(axis=0, keepdims=True)
    if features.shape != (count, 80) or not np.isfinite(features).all():
        raise SpeakerAdmissionError("speaker_features_invalid")
    return np.ascontiguousarray(features[None])


class _SpeakerEmbedding:
    def __init__(self, model_assets):
        import onnxruntime as ort
        self.manifest, path = load_assets(model_assets)
        self.dimension = self.manifest["embeddingDimension"]
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.log_severity_level = 4
        self.session = ort.InferenceSession(str(path), sess_options=options,
                                           providers=["CPUExecutionProvider"])
        inputs, outputs = self.session.get_inputs(), self.session.get_outputs()
        if (len(inputs) != 1 or len(outputs) != 1 or inputs[0].name != "feats" or
                outputs[0].name != "embs" or inputs[0].type != "tensor(float)" or
                outputs[0].type != "tensor(float)" or len(inputs[0].shape) != 3 or
                inputs[0].shape[2] != 80 or len(outputs[0].shape) != 2 or
                outputs[0].shape[1] != self.dimension):
            raise SpeakerAdmissionError("speaker_onnx_contract_invalid")
        if self.session.get_providers() != ["CPUExecutionProvider"]:
            raise SpeakerAdmissionError("speaker_provider_invalid")

    def embedding(self, audio):
        features = compute_fbank(_audio(audio))
        try:
            output = self.session.run(["embs"], {"feats": features})[0]
        except Exception:
            raise SpeakerAdmissionError("speaker_inference_failed") from None
        if np.asarray(output).shape != (1, self.dimension):
            raise SpeakerAdmissionError("speaker_embedding_invalid")
        return _unit(output[0], self.dimension)


class _Silero:
    def __init__(self):
        import onnxruntime as ort
        from faster_whisper.utils import get_assets_path
        path = Path(get_assets_path()) / "silero_vad_v6.onnx"
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.log_severity_level = 4
        self.session = ort.InferenceSession(str(path), sess_options=options,
                                           providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self):
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros(64, dtype=np.float32)

    def __call__(self, frame):
        data = np.concatenate((self.context, frame)).reshape(1, -1)
        output, self.h, self.c = self.session.run(None, {"input": data,
                                                       "h": self.h, "c": self.c})
        self.context = frame[-64:].copy()
        probability = float(np.asarray(output).reshape(-1)[0])
        if not math.isfinite(probability) or not 0 <= probability <= 1:
            raise SpeakerAdmissionError("speaker_vad_failed")
        return probability


def detect_voiced_ranges(audio, vad=None):
    audio = _audio(audio)
    vad = vad if vad is not None else _Silero()
    vad.reset()
    answer = []
    for start in range(0, len(audio), 512):
        end = min(start + 512, len(audio))
        frame = np.zeros(512, dtype=np.float32)
        frame[:end-start] = audio[start:end]
        if vad(frame) >= 0.35:
            if answer and answer[-1][1] == start:
                answer[-1] = (answer[-1][0], end)
            else:
                answer.append((start, end))
    return answer


class SpeakerVerifier:
    def __init__(self, model_assets, profile_path, threshold=None, min_voiced_ms=1000):
        self.engine = None
        self._meta = None
        self._vector = None
        self._profile_sha = None
        self.error_code = None
        self._vad = None
        self._requested_threshold = threshold
        self.min_voiced_ms = min_voiced_ms
        self.threshold = None
        try:
            if (isinstance(min_voiced_ms, bool) or not isinstance(min_voiced_ms, int) or
                    not 500 <= min_voiced_ms <= 10000):
                raise SpeakerAdmissionError("speaker_min_duration_invalid")
            self.engine = _SpeakerEmbedding(model_assets)
            if profile_path is None or not Path(profile_path).is_file():
                raise SpeakerAdmissionError("speaker_profile_missing")
            document, raw = _read_json(profile_path)
            expected = {"schemaVersion": SCHEMA_VERSION, "sampleRate": SAMPLE_RATE,
                        "modelSha256": self.engine.manifest["sha256"],
                        "modelId": self.engine.manifest["modelId"],
                        "featureVersion": FEATURE_VERSION,
                        "embeddingDimension": self.engine.dimension}
            if any(document.get(key) != value for key, value in expected.items()):
                raise SpeakerAdmissionError("speaker_profile_model_mismatch")
            if (document.get("sourceKind") not in ("user_microphone", "test_fixture") or
                    not isinstance(document.get("profileId"), str) or
                    re.fullmatch(r"speaker-[0-9a-f]{32}", document["profileId"]) is None or
                    not isinstance(document.get("createdAt"), str) or
                    len(document["createdAt"]) > 40 or
                    document.get("enrollmentVoicedMs", 0) < MIN_ENROLLMENT_VOICED_MS or
                    document.get("enrollmentSegments", 0) < MIN_ENROLLMENT_SEGMENTS or
                    document.get("calibrationStatus") not in
                    ("provisional", "fixture_calibrated", "user_calibrated")):
                raise SpeakerAdmissionError("speaker_profile_invalid")
            try:
                datetime.fromisoformat(document["createdAt"])
            except (ValueError, TypeError):
                raise SpeakerAdmissionError("speaker_profile_invalid") from None
            self.threshold = _threshold(threshold if threshold is not None else document.get("threshold"))
            vector = np.asarray(document.get("embedding"), dtype=np.float32)
            norm = float(np.linalg.norm(vector.astype(np.float64)))
            if not math.isfinite(norm) or abs(norm - 1.0) > 1e-3:
                raise SpeakerAdmissionError("speaker_profile_vector_invalid")
            self._vector = _unit(vector, self.engine.dimension)
            self._profile_sha = _sha(raw)
            self._meta = {key: document[key] for key in _SAFE_PROFILE_FIELDS if key in document}
            self._meta.update(profileSha256=self._profile_sha, threshold=self.threshold,
                              minVoicedMs=self.min_voiced_ms)
        except SpeakerAdmissionError as error:
            self.error_code = error.code
        except Exception:
            self.error_code = "speaker_initialization_failed"

    def profile(self):
        return dict(self._meta) if self._meta else None

    def status(self):
        return {"available": self.engine is not None, "profileValid": self._vector is not None,
                "profile": self.profile(),
                **({"errorCode": self.error_code} if self.error_code else {})}

    def verify(self, audio_16k_float32, voiced_ranges=None):
        started = time.perf_counter_ns()
        result = {"decision": "rejected", "reason": self.error_code or "speaker_not_verified",
                  "score": None, "threshold": self.threshold, "voicedMs": 0.0,
                  "gateMs": 0.0, "profileSha256": self._profile_sha,
                  "modelSha256": self.engine.manifest["sha256"] if self.engine else None}
        try:
            if self.error_code or self._vector is None:
                return result
            audio = _audio(audio_16k_float32)
            if voiced_ranges is None:
                if self._vad is None:
                    self._vad = _Silero()
                ranges = detect_voiced_ranges(audio, self._vad)
            else:
                ranges = _ranges(voiced_ranges, len(audio))
            voiced_ms = sum(end - start for start, end in ranges) * 1000 / SAMPLE_RATE
            result["voicedMs"] = voiced_ms
            if voiced_ms < self.min_voiced_ms:
                result.update(decision="uncertain", reason="speaker_insufficient_voiced_audio")
                return result
            # Trim only the verification copy. Pauses inside the real segment are
            # preserved; pre/post-roll cannot count toward the voiced duration.
            vector = self.engine.embedding(audio[ranges[0][0]:ranges[-1][1]])
            score = float(np.dot(self._vector.astype(np.float64), vector.astype(np.float64)))
            score = max(-1.0, min(1.0, score))
            if not math.isfinite(score):
                raise SpeakerAdmissionError("speaker_score_invalid")
            result.update(score=score,
                          decision="accepted" if score >= self.threshold else "rejected",
                          reason="speaker_match" if score >= self.threshold else "speaker_mismatch")
            return result
        except SpeakerAdmissionError as error:
            result.update(decision="rejected", reason=error.code)
            return result
        except Exception:
            result.update(decision="rejected", reason="speaker_verification_failed")
            return result
        finally:
            result["gateMs"] = (time.perf_counter_ns() - started) / 1_000_000


def _voice_count(ranges, start, end):
    return sum(max(0, min(end, right) - max(start, left)) for left, right in ranges)


def _enrollment_chunks(audio, ranges):
    # Independent, non-overlapping <=4 s chunks. No repeated samples, silence
    # padding or pre-roll are used to meet the enrollment speech requirement.
    spans = []
    for start, end in ranges:
        if spans and start - spans[-1][1] <= SAMPLE_RATE * 800 // 1000:
            spans[-1] = (spans[-1][0], end)
        else:
            spans.append((start, end))
    chunks = []
    for left, right in spans:
        for start in range(left, right, 4 * SAMPLE_RATE):
            end = min(start + 4 * SAMPLE_RATE, right)
            voice = _voice_count(ranges, start, end)
            if voice >= SAMPLE_RATE:
                chunks.append((audio[start:end], voice))
    return chunks


def build_profile(engine, audio, source_kind, *, threshold=None, cancel=None):
    if source_kind not in ("user_microphone", "test_fixture"):
        raise SpeakerAdmissionError("speaker_enrollment_source_invalid")
    audio = _audio(audio)
    ranges = detect_voiced_ranges(audio)
    chunks = _enrollment_chunks(audio, ranges)
    voiced_ms = sum(count for _, count in chunks) * 1000 / SAMPLE_RATE
    if len(chunks) < MIN_ENROLLMENT_SEGMENTS or voiced_ms < MIN_ENROLLMENT_VOICED_MS:
        raise SpeakerAdmissionError("speaker_enrollment_insufficient_speech")
    vectors = []
    for chunk, _ in chunks:
        if cancel is not None and cancel.is_set():
            raise SpeakerAdmissionError("speaker_enrollment_cancelled")
        vectors.append(engine.embedding(chunk))
    consistency = [float(np.dot(vectors[a], vectors[b]))
                   for a in range(len(vectors)) for b in range(a + 1, len(vectors))]
    vector = _unit(np.mean(vectors, axis=0), engine.dimension)
    centroid_scores = [float(np.dot(item, vector)) for item in vectors]
    if (min(consistency) < MIN_ENROLLMENT_CONSISTENCY or
            float(np.median(consistency)) < 0.50 or min(centroid_scores) < 0.65):
        raise SpeakerAdmissionError("speaker_enrollment_inconsistent_voice")
    return {"schemaVersion": SCHEMA_VERSION, "profileId": "speaker-" + uuid.uuid4().hex,
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sourceKind": source_kind, "modelId": engine.manifest["modelId"],
            "modelSha256": engine.manifest["sha256"], "featureVersion": FEATURE_VERSION,
            "sampleRate": SAMPLE_RATE, "embeddingDimension": engine.dimension,
            "threshold": _threshold(threshold if threshold is not None else engine.manifest["defaultThreshold"]),
            "minVoicedMs": 1000, "enrollmentVoicedMs": voiced_ms,
            "enrollmentSegments": len(chunks), "calibrationStatus": "provisional",
            "enrollmentMinPairCosine": min(consistency),
            "enrollmentMedianPairCosine": float(np.median(consistency)),
            "enrollmentMinCentroidCosine": min(centroid_scores),
            "embedding": vector.tolist()}


def save_profile_exclusive(profile, path, cancel=None):
    if cancel is not None and cancel.is_set():
        raise SpeakerAdmissionError("speaker_enrollment_cancelled")
    destination = Path(path)
    if not destination.parent.is_dir():
        raise SpeakerAdmissionError("speaker_profile_destination_invalid")
    data = _json_bytes(profile)
    try:
        # O_EXCL forbids replacement, even if a second process wins the race.
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise SpeakerAdmissionError("speaker_profile_already_exists") from None
    except OSError:
        raise SpeakerAdmissionError("speaker_profile_write_failed") from None
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        raise SpeakerAdmissionError("speaker_profile_write_failed") from None
    return _sha(data)


def _emit(kind, **fields):
    print(json.dumps({"type": kind, "protocolVersion": 1, **fields},
                     ensure_ascii=False, allow_nan=False), flush=True)


def _install_cancel(cancel):
    def stopped(*_):
        cancel.set()
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            signal.signal(sig, stopped)
    def read_stdin():
        try:
            for line in sys.stdin:
                try:
                    command = json.loads(line)
                    if isinstance(command, dict) and command.get("command") == "cancel":
                        cancel.set()
                        return
                except (ValueError, TypeError):
                    continue
        except Exception:
            pass
    threading.Thread(target=read_stdin, daemon=True).start()


def _capture_enrollment(device, seconds, cancel):
    import sounddevice as sd
    import soxr
    try:
        info = sd.query_devices(device, "input")
        api = sd.query_hostapis(info["hostapi"])
        if "WASAPI" not in api["name"] or info["max_input_channels"] < 1:
            raise SpeakerAdmissionError("speaker_wasapi_input_required")
        rate = int(info["default_samplerate"])
        resampler = soxr.ResampleStream(rate, SAMPLE_RATE, 1, dtype="float32", quality="HQ")
        blocks = queue.Queue(maxsize=256)
        failed = threading.Event()
        def callback(indata, frames, timing, status):
            if status:
                failed.set()
            try:
                blocks.put_nowait(np.asarray(indata[:, 0], dtype=np.float32).copy())
            except queue.Full:
                failed.set()
        parts = []
        total = 0
        deadline = time.monotonic() + seconds
        last_progress = 0.0
        vad = _Silero()
        vad_pending = np.empty(0, dtype=np.float32)
        voiced_samples = 0
        with sd.InputStream(device=device, channels=1, samplerate=rate,
                            dtype="float32", callback=callback):
            _emit("enrollment_ready", durationMs=seconds * 1000, sampleRate=SAMPLE_RATE)
            while time.monotonic() < deadline:
                if cancel.is_set():
                    raise SpeakerAdmissionError("speaker_enrollment_cancelled")
                if failed.is_set():
                    raise SpeakerAdmissionError("speaker_capture_gap")
                try:
                    block = blocks.get(timeout=0.1)
                except queue.Empty:
                    continue
                output = resampler.resample_chunk(block, last=False)
                parts.append(output)
                total += len(output)
                vad_pending = np.concatenate((vad_pending, output))
                while len(vad_pending) >= 512:
                    if vad(vad_pending[:512]) >= 0.35:
                        voiced_samples += 512
                    vad_pending = vad_pending[512:]
                now = time.monotonic()
                if now - last_progress >= 0.25:
                    _emit("enrollment_progress", elapsedMs=min(total * 1000 / SAMPLE_RATE, seconds * 1000),
                          voicedMs=voiced_samples * 1000 / SAMPLE_RATE)
                    last_progress = now
        if cancel.is_set():
            raise SpeakerAdmissionError("speaker_enrollment_cancelled")
        if failed.is_set():
            raise SpeakerAdmissionError("speaker_capture_gap")
        parts.append(resampler.resample_chunk(np.empty(0, dtype=np.float32), last=True))
        return np.concatenate(parts)[:int(seconds * SAMPLE_RATE)]
    except SpeakerAdmissionError:
        raise
    except Exception:
        raise SpeakerAdmissionError("speaker_microphone_unavailable") from None


def read_audio_file(path):
    try:
        with wave.open(str(path), "rb") as stream:
            rate, channels, width = stream.getframerate(), stream.getnchannels(), stream.getsampwidth()
            frames = stream.getnframes()
            if (channels != 1 or rate != SAMPLE_RATE or width != 2 or
                    frames > SAMPLE_RATE * MAX_AUDIO_SECONDS):
                raise ValueError()
            return np.frombuffer(stream.readframes(frames), dtype="<i2").astype(np.float32) / 32768
    except Exception:
        raise SpeakerAdmissionError("speaker_fixture_audio_invalid") from None


def main(argv=None):
    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest="command", required=True)
    for command in ("status", "enroll", "enroll-file"):
        item = subs.add_parser(command)
        item.add_argument("--assets", required=True)
        if command == "status":
            item.add_argument("--profile")
        else:
            item.add_argument("--profile-output", required=True)
            item.add_argument("--threshold", type=float)
            if command == "enroll":
                item.add_argument("--device", required=True, type=int)
                item.add_argument("--seconds", type=int, default=25, choices=range(15, 26))
            else:
                item.add_argument("--audio-file", required=True)
    args = parser.parse_args(argv)
    if args.command == "status":
        verifier = SpeakerVerifier(args.assets, args.profile)
        _emit("speaker_status", **verifier.status())
        return 0
    cancel = threading.Event()
    _install_cancel(cancel)
    # A cancelled/deadline-expired enrollment cannot create a profile. The parent
    # also owns the process and may terminate after this hard 35-second budget.
    deadline = time.monotonic() + 35
    def deadline_expired():
        cancel.set()
        _emit("enrollment_error", code="speaker_enrollment_deadline_exceeded")
        # Enrollment is a dedicated short-lived process. A native device/model
        # hang must not survive the 35-second microphone process ownership limit.
        os._exit(2)
    timer = threading.Timer(35, deadline_expired)
    timer.daemon = True
    timer.start()
    try:
        if Path(args.profile_output).exists():
            raise SpeakerAdmissionError("speaker_profile_already_exists")
        engine = _SpeakerEmbedding(args.assets)
        if args.command == "enroll":
            audio = _capture_enrollment(args.device, args.seconds, cancel)
            source_kind = "user_microphone"
        else:
            _emit("enrollment_ready", sourceKind="test_fixture", sampleRate=SAMPLE_RATE)
            audio = read_audio_file(args.audio_file)
            source_kind = "test_fixture"
        profile = build_profile(engine, audio, source_kind, threshold=args.threshold, cancel=cancel)
        if time.monotonic() >= deadline or cancel.is_set():
            raise SpeakerAdmissionError("speaker_enrollment_cancelled")
        save_profile_exclusive(profile, args.profile_output, cancel)
        verifier = SpeakerVerifier(args.assets, args.profile_output)
        if not verifier.status()["profileValid"]:
            raise SpeakerAdmissionError("speaker_created_profile_invalid")
        _emit("enrollment_completed", profileCreated=True, profile=verifier.profile())
        return 0
    except SpeakerAdmissionError as error:
        _emit("enrollment_error", code=error.code)
        return 2
    except Exception:
        _emit("enrollment_error", code="speaker_enrollment_failed")
        return 2
    finally:
        timer.cancel()


if __name__ == "__main__":
    raise SystemExit(main())
