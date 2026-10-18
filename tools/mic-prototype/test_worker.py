"""Deterministic DSP/protocol tests; no input stream, network, GPU or OAuth."""

import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

import numpy as np
import soxr

import worker


class FakeOnnx:
    def __init__(self, contract="h_c", probability=0.75):
        self.contract = contract
        self.probability = probability
        self.calls = []

    def get_inputs(self):
        names = ("input", "h", "c") if self.contract == "h_c" else ("input", "state", "sr")
        return [SimpleNamespace(name=name) for name in names]

    def run(self, _, inputs):
        self.calls.append({key: value.copy() for key, value in inputs.items()})
        output = np.array([[self.probability]], dtype=np.float32)
        if self.contract == "h_c":
            return output, inputs["h"] + 1, inputs["c"] + 2
        return output, inputs["state"] + 1


class FakeVad:
    def __init__(self, probabilities=None):
        self.probabilities = iter(probabilities or [])
        self.frames = []
        self.resets = 0

    def __call__(self, frame):
        self.frames.append(frame.copy())
        return next(self.probabilities, 0.0)

    def reset(self):
        self.resets += 1


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.emit = lambda kind, **fields: self.events.append({"type": kind, **fields})

    def test_error_codes_classify_types_without_using_exception_text(self):
        class PortAudioError(Exception):
            pass
        with patch.dict(worker.sys.modules, {"sounddevice": SimpleNamespace(PortAudioError=PortAudioError)}):
            for error, code in [
                (ModuleNotFoundError("private module path"), "audio_dependency_missing"),
                (PortAudioError("private device name"), "audio_device_unavailable"),
                (RuntimeError("PortAudioError-looking text"), "audio_runtime_failed"),
                (FileNotFoundError("private model path"), "audio_runtime_failed"),
                (KeyboardInterrupt(), "audio_interrupted"),
            ]:
                self.assertEqual(worker.audio_error_code(error), code)

    def test_main_emits_safe_error_code_and_does_not_open_capture_for_device_inventory_failure(self):
        captured = []
        with patch.object(worker, "configure_cuda_dlls"), \
                patch.object(worker, "enumerate_devices", side_effect=ImportError("private dependency path")), \
                patch.object(worker, "JsonEmitter", return_value=lambda kind, **fields: captured.append({"type": kind, **fields})), \
                patch.object(worker, "run_microphone") as capture:
            self.assertEqual(worker.main(["devices"]), 1)
        capture.assert_not_called()
        self.assertEqual(captured[-1]["code"], "audio_dependency_missing")
        self.assertEqual(captured[-1]["phase"], "devices")

    def test_streaming_resampling_matches_one_shot_and_exact_length(self):
        rng = np.random.default_rng(42)
        for rate in (16000, 44100, 48000):
            with self.subTest(rate=rate):
                source = rng.normal(0, 0.1, rate+237).astype(np.float32)
                resampler = worker.StreamingResampler(rate)
                output = []
                offset = 0
                for size in (1, 37, 511, 4096, 192, 441, 137):
                    output.append(resampler.feed(source[offset:offset+size]))
                    offset += size
                output.append(resampler.feed(source[offset:]))
                output.append(resampler.feed(np.empty(0, dtype=np.float32), final=True))
                result = np.concatenate(output)
                expected = soxr.resample(source, rate, 16000, quality="HQ")
                self.assertEqual(len(result), len(expected))
                self.assertLessEqual(abs(len(result)-len(source)*16000/rate), 0.5)
                np.testing.assert_allclose(result, expected, atol=2e-7, rtol=1e-5)
                self.assertEqual(resampler.output_samples, len(result))
                with self.assertRaises(RuntimeError):
                    resampler.feed(source[:1])

    def test_resampler_rejects_alias_instead_of_decimating(self):
        rate = 48000
        t = np.arange(rate*2, dtype=np.float32) / rate
        high = (0.5*np.sin(2*np.pi*12000*t)).astype(np.float32)
        low = (0.5*np.sin(2*np.pi*1000*t)).astype(np.float32)
        def convert(audio):
            converter = worker.StreamingResampler(rate)
            parts = [converter.feed(audio[i:i+173]) for i in range(0, len(audio), 173)]
            parts.append(converter.feed(np.empty(0, dtype=np.float32), final=True))
            return np.concatenate(parts)[1000:-1000]
        self.assertLess(float(np.sqrt(np.mean(convert(high)**2))), 0.002)
        self.assertGreater(float(np.sqrt(np.mean(convert(low)**2))), 0.34)

    def test_resampler_rejects_invalid_audio(self):
        converter = worker.StreamingResampler(48000)
        with self.assertRaises(ValueError):
            converter.feed(np.zeros((10, 2), dtype=np.float32))
        with self.assertRaises(ValueError):
            converter.feed(np.array([np.nan], dtype=np.float32))

    def test_onnx_v6_keeps_context_and_recurrent_state_between_frames(self):
        fake = FakeOnnx("h_c")
        vad = worker.SileroOnnx(session=fake)
        a = np.linspace(-1, 1, 512, dtype=np.float32)
        b = np.zeros(512, dtype=np.float32)
        self.assertAlmostEqual(vad(a), 0.75)
        vad(b)
        np.testing.assert_array_equal(fake.calls[0]["input"][0, :64], np.zeros(64))
        np.testing.assert_array_equal(fake.calls[1]["input"][0, :64], a[-64:])
        np.testing.assert_array_equal(fake.calls[1]["h"], np.ones((1, 1, 128)))
        np.testing.assert_array_equal(fake.calls[1]["c"], np.full((1, 1, 128), 2))
        vad.reset()
        vad(b)
        self.assertEqual(float(fake.calls[2]["h"].sum()), 0)

    def test_standalone_silero_contract_and_invalid_probability(self):
        fake = FakeOnnx("state_sr")
        vad = worker.SileroOnnx(session=fake)
        frame = np.zeros(512, dtype=np.float32)
        vad(frame)
        vad(frame)
        self.assertEqual(int(fake.calls[1]["sr"]), 16000)
        self.assertEqual(fake.calls[1]["state"].shape, (2, 1, 128))
        self.assertEqual(float(fake.calls[1]["state"].sum()), 256)
        with self.assertRaises(ValueError):
            vad(frame[:511])
        fake.probability = float("nan")
        with self.assertRaises(ValueError):
            vad(frame)

    def _feed_probs(self, segmenter, probabilities, start=0):
        result = []
        for index, p in enumerate(probabilities):
            frame = np.full(512, index/100, dtype=np.float32)
            result += segmenter.feed(frame, start+index*512, p)
        return result

    def test_pause_wait_not_included_in_last_speech_timestamp(self):
        segmenter = worker.VadSegmenter(self.emit)
        segments = self._feed_probs(segmenter, [0]*8 + [0.9]*10 + [0]*16)
        self.assertEqual(len(segments), 1)
        segment = segments[0]
        self.assertEqual(segment.start_sample, 2*512)  # 192 ms pre-roll
        self.assertEqual(segment.end_sample, 18*512)
        self.assertEqual(segment.input_end_sample, 21*512)  # 96 ms post-roll
        self.assertEqual(len(segment.audio), 19*512)
        self.assertFalse(segment.forced_boundary)
        self.assertEqual(segment.reason, "pause")
        self.assertEqual(segment.metadata()["audioEndSource"], "vad_frame_end")
        self.assertIsNone(segment.metadata()["audioEndUncertaintyMs"])

    def test_short_pause_and_hysteresis_do_not_split_sentence(self):
        segmenter = worker.VadSegmenter(self.emit)
        result = self._feed_probs(segmenter, [0.9]*5+[0]*10+[0.4]*5+[0.9]*5+[0]*16)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].end_sample, 25*512)

    def test_long_silence_is_bounded_and_not_transcribed(self):
        segmenter = worker.VadSegmenter(self.emit)
        self.assertEqual(self._feed_probs(segmenter, [0]*10000), [])
        self.assertEqual(len(segmenter.preroll), 6)
        self.assertEqual(segmenter.parts, [])
        self.assertEqual(segmenter.finish(), [])

    def test_raw_runtime_does_not_promote_boosted_room_noise_to_speech(self):
        enhanced, raw = FakeVad([0.62]), FakeVad([0.005])
        vad = worker.CausalVadGain(enhanced, raw, enhance_quiet=False)
        frame = np.full(512, 0.0078, dtype=np.float32)
        before = frame.copy()
        self.assertAlmostEqual(vad(frame), 0.005)
        self.assertEqual(vad.diagnostics()["maxGainObserved"], 1)
        self.assertFalse(vad.diagnostics()["gainEnabled"])
        np.testing.assert_array_equal(frame, before)

    def test_runtime_preroll_preserves_1280ms_delayed_speech_onset(self):
        args = worker.parser().parse_args(["run", "--model-dir", "unused", "--device", "9"])
        segmenter = worker.create_runtime_segmenter(self.emit, args)
        segments = self._feed_probs(segmenter, [0]*20 + [0.1]*40 + [0.8]*10 + [0]*25)
        self.assertEqual(len(segments), 1)
        self.assertLessEqual(segments[0].start_sample, 20*512)
        # Compare retained prefix PCM, not just an estimated boundary timestamp.
        prefix_offset = 20*512 - segments[0].start_sample
        np.testing.assert_array_equal(segments[0].audio[prefix_offset:prefix_offset+512],
                                      np.full(512, 0.20, dtype=np.float32))

    def test_runtime_keeps_lower_confidence_second_clause_and_bounded_silence(self):
        args = worker.parser().parse_args(["file", "--model-dir", "unused", "--audio-file", "unused"])
        segmenter = worker.create_runtime_segmenter(self.emit, args)
        segments = self._feed_probs(segmenter, [0.42]*5 + [0]*20 + [0.42]*10 + [0]*25)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].end_sample, 35*512)
        silence = worker.create_runtime_segmenter(self.emit, args)
        self.assertEqual(self._feed_probs(silence, [0]*10000), [])
        self.assertEqual(len(silence.preroll), 47)
        self.assertEqual(silence.finish(), [])
        config = worker.runtime_vad_config(args)
        self.assertEqual(config["effectivePreRollMs"], 1504)
        self.assertEqual(config["pauseMs"], 800)
        self.assertEqual(config["levelMode"], "raw")

    def test_next_utterance_never_resubmits_partial_postroll_frame(self):
        segmenter = worker.VadSegmenter(self.emit, pause_ms=800, pre_roll_ms=1500, post_roll_ms=300)
        first = self._feed_probs(segmenter, [0.9]*10 + [0]*25)
        self.assertEqual(len(first), 1)
        second = self._feed_probs(segmenter, [0.9]*8 + [0]*25, start=35*512)
        self.assertEqual(len(second), 1)
        self.assertEqual(first[0].input_end_sample, 10*512 + 4800)
        self.assertEqual(second[0].start_sample, first[0].input_end_sample)

    def test_low_level_vad_gain_is_causal_bounded_and_does_not_mutate_pcm(self):
        vad = FakeVad()
        sidechain = worker.CausalVadGain(vad, FakeVad())
        quiet = np.full(512, 0.001, dtype=np.float32)
        original = quiet.copy()
        sidechain(quiet)
        np.testing.assert_array_equal(quiet, original)
        self.assertAlmostEqual(float(np.sqrt(np.mean(vad.frames[0] ** 2))), 10 ** (-26 / 20), places=6)
        self.assertLessEqual(sidechain.max_gain_observed, 64)
        sidechain(np.zeros(512, dtype=np.float32))
        self.assertEqual(np.count_nonzero(vad.frames[-1]), 0)
        sidechain.reset()
        tiny = np.full(512, 1e-7, dtype=np.float32)
        sidechain(tiny)
        np.testing.assert_allclose(vad.frames[-1], tiny * 64, rtol=1e-6)
        pulse = np.zeros(512, dtype=np.float32)
        pulse[0] = 0.2
        sidechain.reset()
        sidechain(pulse)
        self.assertLessEqual(float(np.max(np.abs(vad.frames[-1]))), 1)
        self.assertAlmostEqual(float(vad.frames[-1][0]), 1, places=6)

    def test_vad_gain_keeps_normal_frames_and_exact_one_second_history(self):
        vad = FakeVad()
        sidechain = worker.CausalVadGain(vad, FakeVad())
        loud = np.full(512, 0.1, dtype=np.float32)
        quiet = np.full(512, 0.001, dtype=np.float32)
        sidechain(loud)
        sidechain(quiet)
        np.testing.assert_array_equal(vad.frames[0], loud)
        np.testing.assert_array_equal(vad.frames[1], quiet)
        for _ in range(40):
            sidechain(quiet)
        self.assertEqual(sidechain.samples, 16000)
        self.assertEqual(sum(len(part) for part in sidechain.parts), 16000)
        self.assertGreater(float(vad.frames[-1][0]), float(quiet[0]))
        sidechain.reset()
        self.assertEqual(sidechain.samples, 0)
        self.assertEqual(sidechain.energy, 0)
        sidechain(loud)
        np.testing.assert_array_equal(vad.frames[-1], loud)
        with self.assertRaises(ValueError):
            sidechain(np.zeros(511, dtype=np.float32))

    def test_pipeline_vad_sidechain_does_not_change_asr_segment_samples(self):
        segments = []
        vad = worker.CausalVadGain(FakeVad([0.9] * 10 + [0] * 100), FakeVad([0.9] * 10 + [0] * 100))
        pipeline = worker.AudioPipeline(16000, vad, worker.VadSegmenter(self.emit), segments.append, self.emit)
        audio = np.full(16000, 0.0001, dtype=np.float32)
        for offset in range(0, len(audio), 320):
            pipeline.feed(worker.CaptureBlock(offset, audio[offset:offset + 320], offset / 16, "test"))
        pipeline.finish()
        self.assertEqual(len(segments), 1)
        segment = segments[0]
        np.testing.assert_array_equal(segment.audio, audio[segment.start_sample:segment.input_end_sample])
        self.assertGreater(vad.max_gain_observed, 1)

    def test_vad_gain_keeps_raw_state_for_normal_frames_after_amplified_history(self):
        enhanced, raw = FakeVad([0.9, 0.8, 0.7]), FakeVad([0.1, 0.2, 0.3])
        sidechain = worker.CausalVadGain(enhanced, raw)
        self.assertEqual(sidechain(np.full(512, 0.001, dtype=np.float32)), 0.9)
        loud = np.full(512, 0.1, dtype=np.float32)
        self.assertEqual(sidechain(loud), 0.2)
        self.assertEqual(sidechain(np.zeros(512, dtype=np.float32)), 0.3)
        self.assertEqual(len(enhanced.frames), len(raw.frames))
        np.testing.assert_array_equal(raw.frames[0], np.full(512, 0.001, dtype=np.float32))
        np.testing.assert_array_equal(raw.frames[1], loud)

    def test_forced_max_boundary_is_explicit_and_does_not_duplicate_audio(self):
        segmenter = worker.VadSegmenter(self.emit, max_seconds=2)
        result = self._feed_probs(segmenter, [0.9]*130)
        result += segmenter.finish()
        self.assertEqual([item.segment_id for item in result], [1, 2, 3])
        self.assertTrue(all(item.forced_boundary for item in result))
        self.assertEqual(result[0].reason, "max_duration")
        self.assertEqual(result[1].start_sample, result[0].end_sample)
        self.assertEqual(result[2].start_sample, result[1].end_sample)
        self.assertEqual(sum(len(item.audio) for item in result), 130*512)

    def test_forced_boundary_retains_active_hysteresis_without_dropping_continuation(self):
        segmenter = worker.VadSegmenter(self.emit, max_seconds=2)
        result = self._feed_probs(segmenter, [0.9] * 63 + [0.4] * 10 + [0.9] * 3 + [0] * 16)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].reason, "max_duration")
        self.assertEqual(result[1].reason, "pause")
        self.assertEqual(result[0].input_end_sample, result[1].start_sample)
        self.assertEqual(result[1].end_sample, 76 * 512)
        np.testing.assert_array_equal(np.concatenate([row.audio for row in result]),
            np.concatenate([np.full(512, index / 100, dtype=np.float32) for index in range(79)]))

    def test_forced_hysteresis_expires_after_pause_and_resets_across_capture_gap(self):
        segmenter = worker.VadSegmenter(self.emit, max_seconds=2)
        result = self._feed_probs(segmenter, [0.9] * 63 + [0] * 16 + [0.4] * 10)
        self.assertEqual(len(result), 1)
        self.assertIsNone(segmenter.continuation_speech_end)
        self.assertEqual(segmenter.finish(), [])
        segmenter.reset_after_gap()
        self.assertEqual(self._feed_probs(segmenter, [0.4] * 20, start=100000), [])

    def test_forced_continuation_recovers_on_pause_boundary_frame(self):
        segmenter = worker.VadSegmenter(self.emit, max_seconds=2)
        result = self._feed_probs(segmenter, [0.9] * 63 + [0] * 15 + [0.4] + [0] * 16)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].input_end_sample, result[1].start_sample)
        self.assertEqual(result[1].end_sample, 79 * 512)

    def test_forced_cut_carries_only_unsubmitted_tail_without_overlap(self):
        segmenter = worker.VadSegmenter(self.emit, max_seconds=2)
        result = self._feed_probs(segmenter, [0.9] * 57 + [0] * 6 + [0.4] * 4 + [0] * 16)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].input_end_sample, 60 * 512)
        self.assertEqual(result[1].start_sample, result[0].input_end_sample)
        combined = np.concatenate([row.audio for row in result])
        expected = np.concatenate([np.full(512, index / 100, dtype=np.float32) for index in range(70)])
        np.testing.assert_array_equal(combined, expected)

    def test_final_partial_frame_keeps_real_sample_end(self):
        segmenter = worker.VadSegmenter(self.emit)
        segmenter.feed(np.ones(512, dtype=np.float32), 0, 0.9)
        segmenter.feed(np.ones(512, dtype=np.float32), 512, 0.9, valid_samples=37)
        segment = segmenter.finish()[0]
        self.assertEqual(segment.end_sample, 549)
        self.assertEqual(len(segment.audio), 549)
        self.assertEqual(segment.reason, "stop")
        self.assertTrue(segment.forced_boundary)

    def test_discontinuity_cannot_be_silently_concatenated(self):
        segmenter = worker.VadSegmenter(self.emit)
        segmenter.feed(np.ones(512, dtype=np.float32), 0, 0.9)
        with self.assertRaises(ValueError):
            segmenter.feed(np.ones(512, dtype=np.float32), 1024, 0.9)
        segmenter.finish("capture_gap")
        segmenter.reset_after_gap()
        segmenter.feed(np.ones(512, dtype=np.float32), 2048, 0.9)
        self.assertEqual(segmenter.finish()[0].segment_id, 2)

    def test_capture_queue_is_sample_bounded_and_nonblocking(self):
        buffer = worker.BoundedCaptureBuffer(100)
        def block(start, size):
            return worker.CaptureBlock(start, np.zeros(size, dtype=np.float32), 1, "test")
        self.assertTrue(buffer.push(block(0, 70)))
        self.assertFalse(buffer.push(block(70, 50)))
        self.assertEqual(buffer.dropped_samples, 50)
        self.assertEqual(buffer.pop().native_start, 0)
        self.assertEqual(buffer.samples, 0)
        buffer.lock.acquire()
        try:
            self.assertFalse(buffer.push(block(120, 10)))
        finally:
            buffer.lock.release()
        self.assertEqual(buffer.dropped_samples, 60)

    def test_adc_mapping_and_labeled_arrival_fallback(self):
        info = SimpleNamespace(inputBufferAdcTime=10.0, currentTime=10.08)
        at, source = worker.adc_perf_time(info, 2000, 480, 48000)
        self.assertAlmostEqual(at, 1920)
        self.assertEqual(source, "portaudio_adc")
        at, source = worker.adc_perf_time(SimpleNamespace(inputBufferAdcTime=0, currentTime=0),
                                         2000, 480, 48000)
        self.assertEqual(at, 1990)
        self.assertEqual(source, "callback_arrival_estimate")

    def test_pipeline_preserves_sample_time_through_filter_delay(self):
        segments = []
        vad = FakeVad([0.9]*10 + [0]*100)
        pipeline = worker.AudioPipeline(48000, vad, worker.VadSegmenter(self.emit),
                                        segments.append, self.emit)
        for offset in range(0, 48000, 960):
            pipeline.feed(worker.CaptureBlock(offset, np.zeros(960, dtype=np.float32),
                                              10000 + offset/48, "portaudio_adc"))
        pipeline.finish()
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].end_sample, 5120)
        self.assertAlmostEqual(segments[0].audio_end_perf_ms, 10320, places=3)
        self.assertGreater(pipeline.max_resampler_delay_ms, 0)

    def test_pipeline_gap_flushes_and_reports_known_missing_samples(self):
        segments = []
        vad = FakeVad([0.9]*100)
        pipeline = worker.AudioPipeline(16000, vad, worker.VadSegmenter(self.emit),
                                        segments.append, self.emit)
        pipeline.feed(worker.CaptureBlock(0, np.ones(1024, dtype=np.float32),
                                          1000, "portaudio_adc"))
        pipeline.feed(worker.CaptureBlock(1536, np.ones(1024, dtype=np.float32),
                                          1096, "portaudio_adc"))
        pipeline.finish()
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0].reason, "capture_gap")
        self.assertEqual(segments[1].start_sample, 1536)
        self.assertEqual(segments[0].audio_timing_source, "portaudio_adc")
        gaps = [event for event in self.events if event["type"] == "gap"]
        self.assertEqual(gaps[0]["knownMissingNativeSamples"], 512)
        self.assertEqual(vad.resets, 1)

    def test_control_clock_and_stop_protocol_has_atomic_json(self):
        output = io.StringIO()
        emit = worker.JsonEmitter(output)
        stop = threading.Event()
        stream = io.StringIO('{"command":"clock","id":"a"}\n[]\n{"command":"stop"}\n')
        worker.control_reader(stop, emit, stream)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(stop.is_set())
        self.assertEqual(events[0]["type"], "clock_sync")
        self.assertEqual(events[0]["id"], "a")
        self.assertGreater(events[0]["perfCounterMs"], 0)
        self.assertEqual(events[1]["type"], "control_error")

    def test_parent_pipe_eof_stops_capture_without_explicit_stop(self):
        stop = threading.Event()
        worker.control_reader(stop, self.emit, io.StringIO(""))
        self.assertTrue(stop.is_set())

    def test_offline_file_batch_may_explicitly_allow_stdin_eof(self):
        stop = threading.Event()
        worker.control_reader(stop, self.emit, io.StringIO(""), stop_on_eof=False)
        self.assertFalse(stop.is_set())

    def test_asr_queue_overflow_is_counted_as_gap(self):
        consumer = worker.AsrConsumer(None, self.emit, max_pending=1)
        segment = worker.AudioSegment(1, 0, 512, 512, np.zeros(512), False, "pause", 10)
        self.assertTrue(consumer.submit(segment))
        self.assertFalse(consumer.submit(segment))
        self.assertEqual(consumer.dropped, 1)
        self.assertEqual(self.events[-1]["reason"], "asr_queue_overflow")

    def test_asr_generator_is_consumed_and_fixed_to_japanese_transcription(self):
        calls = []
        yielded = []
        class FakeModel:
            def transcribe(self, audio, **kwargs):
                calls.append(kwargs)
                def results():
                    yielded.append(True)
                    yield SimpleNamespace(text=" こんにちは。", start=0, end=1,
                                          avg_logprob=-0.1, no_speech_prob=0.01)
                return results(), SimpleNamespace(language="ja", duration=1)
        ja, detail = worker.transcribe_audio(FakeModel(), np.zeros(16000, dtype=np.float32))
        self.assertEqual(ja, "こんにちは。")
        self.assertEqual(yielded, [True])
        self.assertEqual(calls[0]["language"], "ja")
        self.assertEqual(calls[0]["task"], "transcribe")
        self.assertFalse(calls[0]["vad_filter"])
        self.assertFalse(calls[0]["condition_on_previous_text"])
        self.assertEqual(len(detail["segments"]), 1)

    def test_recording_requires_new_file_and_preserves_existing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "speech.wav"
            pair = worker.create_recording(path)
            pair[0].writeframes(np.zeros(100, dtype="<i2").tobytes())
            pair[0].close()
            pair[1].close()
            original = path.read_bytes()
            with self.assertRaises(FileExistsError):
                worker.create_recording(path)
            self.assertEqual(path.read_bytes(), original)
            audio, rate = worker.read_pcm_wav(path)
            self.assertEqual(rate, 16000)
            self.assertEqual(len(audio), 100)

    def test_device_inventory_never_opens_input_and_keeps_host_names(self):
        fake = SimpleNamespace(
            query_hostapis=lambda: [{"name": "Windows WASAPI"}, {"name": "MME"}],
            query_devices=lambda: [
                {"name": "A", "max_input_channels": 2, "hostapi": 0, "default_samplerate": 48000},
                {"name": "Output", "max_input_channels": 0, "hostapi": 0, "default_samplerate": 48000},
                {"name": "B", "max_input_channels": 1, "hostapi": 1, "default_samplerate": 44100}],
            WasapiSettings=lambda **kw: kw,
            check_input_settings=lambda **kw: None)
        inventory = worker.enumerate_devices(fake)
        self.assertEqual([item["index"] for item in inventory], [0, 2])
        self.assertTrue(inventory[0]["isWasapi"])
        self.assertFalse(inventory[1]["isWasapi"])
        self.assertIn(48000, inventory[0]["supportedRates"])

    def test_stop_during_preparation_never_opens_microphone(self):
        inventory = [{"index": 9, "isWasapi": True, "defaultSampleRate": 48000,
                      "supportedRates": [48000], "name": "Test only"}]
        class ImmediateThread:
            def __init__(self, target, args, **kwargs):
                self.target, self.args = target, args
            def start(self):
                self.target(*self.args)
        args = SimpleNamespace(device=9, model_dir="unused", compute_type="int8_float16",
                               vad_model=None, record=None, pause_ms=500,
                               max_segment_seconds=12)
        with patch.object(worker, "enumerate_devices", return_value=inventory), \
                patch.object(worker, "load_whisper"), \
                patch.object(worker, "SileroOnnx"), \
                patch.object(worker, "transcribe_audio") as transcribe, \
                patch.object(worker, "control_reader", side_effect=lambda stop, emit: stop.set()), \
                patch.object(worker.threading, "Thread", ImmediateThread), \
                patch.object(worker.signal, "signal"), \
                patch("sounddevice.InputStream") as stream:
            worker.run_microphone(args, self.emit)
        stream.assert_not_called()
        transcribe.assert_not_called()
        self.assertEqual(self.events[-1]["type"], "session_stopped")
        self.assertTrue(self.events[-1]["cancelledBeforeCapture"])
        self.assertFalse(self.events[-1]["microphoneOpened"])


if __name__ == "__main__":
    unittest.main()
