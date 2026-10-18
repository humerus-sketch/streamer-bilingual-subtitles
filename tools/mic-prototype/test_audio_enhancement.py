import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from audio_enhancement import StreamingEnhancer, create_enhancer, get_enhancement_metadata, _verified_file


class DelayedFixture(StreamingEnhancer):
    """A sample-exact delay models native STFT/lookahead without native deps."""
    def __init__(self):
        super().__init__({"mode": "fixture", "frameSize": 480, "algorithmicDelaySamples": 960})
        self._history = np.zeros(960, dtype=np.float32)

    def _process_frame(self, samples, output):
        joined = np.concatenate((self._history, samples))
        output[:] = joined[:480]
        self._history = joined[480:]


class AudioEnhancementTest(unittest.TestCase):
    def test_off_has_no_native_runtime_requirement_and_preserves_samples(self):
        source = np.array([0.0, .01, -.1, 1.2], dtype=np.float32)
        with create_enhancer("off", runtime_dir="missing-runtime") as engine:
            result = engine.process(source)
            np.testing.assert_array_equal(result, source)
            result[1] = 20
            self.assertEqual(source[1], np.float32(.01))
            self.assertEqual(engine.algorithmic_delay_samples, 0)
            self.assertEqual(engine.flush().size, 0)

    def test_invalid_modes_and_sample_rates_are_explicit(self):
        with self.assertRaisesRegex(ValueError, "unsupported_audio_enhancement"):
            create_enhancer("another-model")
        with self.assertRaisesRegex(ValueError, "48000"):
            create_enhancer("off", sample_rate=16000)

    def test_missing_selected_native_engine_is_not_silent_passthrough(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "runtime_missing"):
                create_enhancer("rnnoise", runtime_dir=directory)

    def test_rejects_nonfinite_or_nonmono_pcm(self):
        for source in [np.zeros((3, 1)), np.array([np.nan]), np.array([np.inf])]:
            with self.assertRaises(ValueError):
                create_enhancer().process(source)

    def test_native_frame_delay_and_final_tail_are_preserved(self):
        source = np.linspace(-.4, .4, 1567, dtype=np.float32)
        engine = DelayedFixture()
        a = engine.process(source[:13])
        self.assertEqual(a.size, 0)
        self.assertEqual(engine.pending_input_samples, 13)
        self.assertEqual(engine.processed_input_samples, 0)
        b = engine.process(source[13:1001])
        self.assertEqual(b.size, 960)
        self.assertEqual(engine.pending_input_samples, 41)
        c = engine.process(source[1001:])
        d = engine.flush()
        result = np.concatenate((a, b, c, d))
        self.assertEqual(result.size, source.size + 960)
        np.testing.assert_array_equal(result[:960], np.zeros(960))
        np.testing.assert_array_equal(result[960:], source)
        self.assertEqual(engine.processed_input_samples, source.size)
        self.assertEqual(engine.input_samples_received, source.size)
        self.assertGreaterEqual(engine.padding_input_samples, 960)
        self.assertEqual(engine.pending_input_samples, 0)

    def test_arbitrary_chunk_boundaries_do_not_reset_state(self):
        source = np.random.default_rng(42).normal(0, .05, 7123).astype(np.float32)
        full = DelayedFixture()
        expected = np.concatenate((full.process(source), full.flush()))
        chunks = DelayedFixture()
        parts = [chunks.process(source[p:p + 127]) for p in range(0, source.size, 127)]
        parts.append(chunks.flush())
        np.testing.assert_array_equal(np.concatenate(parts), expected)

    def test_flush_is_idempotent_and_empty_input_does_not_invent_speech(self):
        engine = DelayedFixture()
        self.assertEqual(engine.process(np.empty(0)).size, 0)
        self.assertEqual(engine.flush().size, 0)
        self.assertEqual(engine.flush().size, 0)
        with self.assertRaisesRegex(RuntimeError, "already_flushed"):
            engine.process(np.zeros(480))

    def test_lifecycle_close_is_idempotent(self):
        engine = create_enhancer()
        engine.close()
        engine.close()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            engine.process(np.zeros(480))

    def test_runtime_hash_mismatch_rejected_before_native_load(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "rnnoise.dll").write_bytes(b"not-a-library")
            manifest = {"schemaVersion": 1, "engines": {"rnnoise": {
                "sampleRate": 48000, "frameSize": 480, "dll": "rnnoise.dll", "dllSha256": "0" * 64,
                "algorithmicDelaySamples": 960}}}
            (root / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError, "checksum_mismatch"):
                create_enhancer("rnnoise", runtime_dir=directory)

    def test_runtime_paths_cannot_escape_verified_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "file_missing"):
                _verified_file(Path(directory), "../outside.dll", "0" * 64)


if __name__ == "__main__":
    unittest.main()
