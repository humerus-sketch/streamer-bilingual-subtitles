"""Enhancement integration contracts; no devices, GPU, cloud or native DLLs."""
import io
from pathlib import Path
import tempfile
import unittest
import wave

import numpy as np

import worker
from audio_enhancement import StreamingEnhancer


class DelayedIdentity(StreamingEnhancer):
    def __init__(self, delay=1440):
        super().__init__({"mode": "deepfilternet3", "frameSize": 480,
                          "algorithmicDelaySamples": delay})
        self.history = np.zeros(delay, dtype=np.float32)
        self.closed_test = False

    def _process_frame(self, data, output):
        combined = np.concatenate((self.history, data))
        output[:] = combined[:480]
        self.history = combined[480:]

    def close(self):
        self.closed_test = True
        super().close()


class AlwaysSpeech:
    def __call__(self, _):
        return .9

    def reset(self):
        pass


class EnhancementIntegrationTests(unittest.TestCase):
    def test_native_delay_is_trimmed_without_losing_partial_chunk(self):
        native = DelayedIdentity()
        aligned = worker.AlignedEnhancement("deepfilternet3", 48000, factory=lambda: native)
        audio = np.linspace(-.2, .2, 10007, dtype=np.float32)
        result = []
        for start in range(0, len(audio), 997):
            result.append(aligned.process(audio[start:start+997]))
        self.assertLess(sum(map(len, result)), len(audio))
        result.append(aligned.flush())
        np.testing.assert_array_equal(np.concatenate(result), audio)
        self.assertTrue(native.closed_test)
        self.assertEqual(aligned.profile()["outputTimeline"], "delay_compensated_original_samples")

    def test_dsp_wait_preserves_original_adc_coordinates_and_raw_recording(self):
        audio = np.sin(np.arange(18007, dtype=np.float32) / 19) * .1
        outputs, events = {}, {}
        for mode in ("off", "deepfilternet3"):
            segments, messages = [], []
            raw, processed, native_raw = io.BytesIO(), io.BytesIO(), io.BytesIO()
            recorders = []
            for stream, rate, width in ((raw,16000,2), (processed,16000,2), (native_raw,48000,4)):
                wav = wave.open(stream, "wb")
                wav.setnchannels(1); wav.setframerate(rate); wav.setsampwidth(width)
                recorders.append(wav)
            enhancer = worker.AlignedEnhancement(mode, 48000, factory=DelayedIdentity)
            pipeline = worker.AudioPipeline(48000, AlwaysSpeech(), worker.VadSegmenter(lambda *a, **k: None),
                segments.append, lambda event, **data: messages.append((event, data)), recorders[0],
                enhancer, recorders[1], recorders[2])
            for start in range(0, len(audio), 960):
                pipeline.feed(worker.CaptureBlock(start, audio[start:start+960],
                                                  1000+start/48, "test_adc"))
            pipeline.finish()
            for recorder in recorders:
                recorder.close()
            self.assertEqual(len(segments), 1)
            self.assertEqual(segments[0].audio_timing_source, "test_adc")
            self.assertAlmostEqual(segments[0].audio_end_perf_ms,
                                   1000+segments[0].end_sample/16)
            self.assertEqual(segments[0].metadata()["enhancement"]["appliedMode"], mode)
            outputs[mode] = [stream.getvalue() for stream in (raw, processed, native_raw)]
            events[mode] = segments[0]
        self.assertEqual(outputs["off"], outputs["deepfilternet3"])
        np.testing.assert_array_equal(events["off"].audio, events["deepfilternet3"].audio)
        self.assertEqual(events["off"].end_sample, events["deepfilternet3"].end_sample)

    def test_gap_drains_and_recreates_native_state(self):
        instances, segments, messages = [], [], []
        def factory():
            instance = DelayedIdentity()
            instances.append(instance)
            return instance
        enhancement = worker.AlignedEnhancement("deepfilternet3", 48000, factory=factory)
        pipeline = worker.AudioPipeline(48000, AlwaysSpeech(), worker.VadSegmenter(lambda *a, **k: None),
            segments.append, lambda event, **data: messages.append((event, data)), enhancement=enhancement)
        pipeline.feed(worker.CaptureBlock(0, np.ones(5003,dtype=np.float32)*.1, 1000, "test_adc"))
        pipeline.feed(worker.CaptureBlock(6000, np.ones(4997,dtype=np.float32)*.2, 1125, "test_adc"))
        pipeline.finish()
        self.assertEqual(pipeline.gaps, 1)
        self.assertEqual(len(instances), 2)
        self.assertTrue(all(instance.closed_test for instance in instances))
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[1].start_sample, 2000)
        self.assertEqual(len(enhancement.diagnostics()["closedEpochs"]), 2)

    def test_native_pcm32_positive_full_scale_does_not_wrap(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"raw.wav"
            pair = worker.create_recording(path, 48000, 4)
            worker.write_pcm(pair[0], np.array([-1,0,1],dtype=np.float32), 4)
            worker.close_recordings([pair])
            audio, rate = worker.read_pcm_wav(path)
            self.assertEqual(rate, 48000)
            np.testing.assert_array_equal(audio, [-1,0,1])

    def test_off_requires_no_native_assets_at_any_rate(self):
        enhancement = worker.AlignedEnhancement("off", 44100, assets="missing")
        source = np.array([.1,.3],dtype=np.float32)
        np.testing.assert_array_equal(enhancement.process(source), source)
        self.assertEqual(len(enhancement.flush()), 0)
        self.assertEqual(enhancement.profile()["algorithmicDelaySamples"], 0)

    def test_empty_and_subframe_epochs_close_without_padding_source_duration(self):
        for count in (0, 1, 479):
            native = DelayedIdentity()
            enhancement = worker.AlignedEnhancement("deepfilternet3", 48000, factory=lambda: native)
            source = np.full(count, .1, dtype=np.float32)
            result = np.concatenate((enhancement.process(source), enhancement.flush()))
            np.testing.assert_array_equal(result, source)
            self.assertTrue(native.closed_test)


if __name__ == "__main__":
    unittest.main()
