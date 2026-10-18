"""Safety/contract tests; fake embeddings never count as acoustic validation."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import numpy as np
import speaker_admission as sa


class FakeEngine:
    dimension = 512
    manifest = {"sha256": "a" * 64, "modelId": "campplus", "defaultThreshold": .65}

    def __init__(self, _):
        self.calls = []

    def embedding(self, audio):
        self.calls.append(np.asarray(audio).copy())
        vector = np.zeros(self.dimension, dtype=np.float32)
        vector[0] = 1
        return vector


def profile_document():
    vector = np.zeros(512, dtype=np.float32)
    vector[0] = 1
    return dict(schemaVersion=1, sampleRate=16000, modelId="campplus",
                modelSha256="a"*64, featureVersion=sa.FEATURE_VERSION,
                embeddingDimension=512, sourceKind="test_fixture",
                profileId="speaker-" + "b"*32, createdAt="2026-10-18T00:00:00+00:00",
                enrollmentVoicedMs=11000, enrollmentSegments=3,
                threshold=.65, minVoicedMs=1000, calibrationStatus="provisional",
                embedding=vector.tolist())


class SpeakerAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.path = self.directory / "private-profile.json"
        self.patch = patch.object(sa, "_SpeakerEmbedding", FakeEngine)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.temp.cleanup)

    def verifier(self, changes=None, **kwargs):
        document = profile_document()
        document.update(changes or {})
        self.path.write_text(json.dumps(document), "utf-8")
        return sa.SpeakerVerifier("unused", self.path, **kwargs)

    def test_missing_profile_is_fail_closed_and_nonfatal_status(self):
        verifier = sa.SpeakerVerifier("unused", self.path)
        self.assertTrue(verifier.status()["available"])
        self.assertFalse(verifier.status()["profileValid"])
        self.assertEqual(verifier.verify(np.ones(16000), [(0,16000)])["reason"], "speaker_profile_missing")

    def test_same_speaker_accepted(self):
        answer = self.verifier().verify(np.ones(16000,dtype=np.float32)*.1, [(0,16000)])
        self.assertEqual(answer["decision"], "accepted")
        self.assertAlmostEqual(answer["score"], 1)
        self.assertEqual(answer["voicedMs"], 1000)
        self.assertGreaterEqual(answer["gateMs"],0)
        self.assertEqual(set(answer), {"decision","reason","score","threshold","voicedMs","gateMs","profileSha256","modelSha256"})

    def test_other_speaker_rejected(self):
        verifier = self.verifier()
        verifier._vector = np.roll(verifier._vector,1)
        self.assertEqual(verifier.verify(np.ones(16000)*.1,[(0,16000)])["decision"],"rejected")

    def test_roll_does_not_inflate_voiced_duration(self):
        verifier = self.verifier()
        answer = verifier.verify(np.ones(64000)*.1,[(24000,32000)])
        self.assertEqual(answer["decision"],"uncertain")
        self.assertEqual(answer["voicedMs"],500)
        self.assertEqual(len(verifier.engine.calls),0)

    def test_no_voiced_samples_uncertain(self):
        self.assertEqual(self.verifier().verify(np.zeros(32000),[])["decision"],"uncertain")

    def test_verification_trim_does_not_change_original_audio(self):
        audio = np.linspace(-.2,.2,48000,dtype=np.float32)
        before = audio.copy()
        verifier = self.verifier()
        answer = verifier.verify(audio,[(8000,24000),(32000,40000)])
        self.assertEqual(answer["decision"],"accepted")
        np.testing.assert_array_equal(audio,before)
        np.testing.assert_array_equal(verifier.engine.calls[0],before[8000:40000])

    def test_invalid_ranges_fail_closed(self):
        for ranges in ([(0,20000),(10000,30000)], [(-1,16000)],[(0,32001)],[(0.0,16000)],[(True,16000)],[(1,1)],None):
            if ranges is None:
                continue
            with self.subTest(ranges=ranges):
                self.assertEqual(self.verifier().verify(np.ones(32000)*.1,ranges)["reason"],"speaker_voiced_ranges_invalid")

    def test_invalid_audio_fail_closed(self):
        for audio in ([], [float("nan")]*16000, [float("inf")]*16000,
                      np.ones((16000,2)), np.ones(16000)*32768):
            with self.subTest(shape=np.asarray(audio).shape):
                self.assertEqual(self.verifier().verify(audio,[(0,16000)])["decision"],"rejected")

    def test_small_resampler_overshoot_preserved(self):
        verifier=self.verifier()
        answer=verifier.verify(np.ones(16000,dtype=np.float32)*1.0025,[(0,16000)])
        self.assertEqual(answer["decision"],"accepted")
        self.assertGreater(float(verifier.engine.calls[0].max()),1)

    def test_wrong_model_profile_fails_closed(self):
        verifier = self.verifier({"modelSha256":"c"*64})
        self.assertEqual(verifier.error_code,"speaker_profile_model_mismatch")
        self.assertIsNone(verifier.profile())

    def test_invalid_profile_vectors_fail_closed(self):
        for vector in ([0]*512, [1]*511, [float("nan")]*512, [1]*512):
            self.assertFalse(self.verifier({"embedding":vector}).status()["profileValid"])

    def test_safe_metadata_never_exports_vectors_or_extra_fields(self):
        verifier = self.verifier({"untrustedField":"secret-private-absolute-path"})
        serialized=json.dumps(verifier.profile())
        self.assertNotIn("secret-private",serialized)
        self.assertNotIn('"embedding":',serialized)
        self.assertIn("profileSha256",serialized)

    def test_untrusted_profile_identity_is_not_exported(self):
        for changes in ({"profileId":"speaker-C:/secret"},{"createdAt":"C:/secret"}):
            verifier=self.verifier(changes)
            self.assertFalse(verifier.status()["profileValid"])
            self.assertIsNone(verifier.profile())

    def test_profile_hash_is_exact_file_hash(self):
        verifier=self.verifier()
        self.assertEqual(verifier.profile()["profileSha256"],sa._file_sha(self.path))

    def test_threshold_override_and_validation(self):
        self.assertEqual(self.verifier(threshold=.8).profile()["threshold"],.8)
        for threshold in (float("nan"),0,1,-1,True,".65"):
            if threshold==0 and not isinstance(threshold,bool):
                continue
            self.assertFalse(self.verifier(threshold=threshold).status()["profileValid"])

    def test_min_duration_parameter_validation(self):
        for duration in (0,499,10001,True,1000.5):
            self.assertFalse(self.verifier(min_voiced_ms=duration).status()["profileValid"])

    def test_exclusive_profile_write_never_overwrites(self):
        self.path.write_bytes(b"existing")
        with self.assertRaises(sa.SpeakerAdmissionError) as error:
            sa.save_profile_exclusive(profile_document(),self.path)
        self.assertEqual(error.exception.code,"speaker_profile_already_exists")
        self.assertEqual(self.path.read_bytes(),b"existing")

    def test_cancelled_enrollment_does_not_create_file(self):
        cancel=threading.Event();cancel.set()
        with self.assertRaises(sa.SpeakerAdmissionError):
            sa.save_profile_exclusive(profile_document(),self.path,cancel)
        self.assertFalse(self.path.exists())

    def test_build_profile_requires_ten_seconds_and_three_chunks(self):
        with patch.object(sa,"detect_voiced_ranges",return_value=[(0,32000)]):
            with self.assertRaises(sa.SpeakerAdmissionError) as error:
                sa.build_profile(FakeEngine(None),np.ones(32000)*.1,"test_fixture")
            self.assertEqual(error.exception.code,"speaker_enrollment_insufficient_speech")

    def test_build_profile_consistent_independent_chunks(self):
        with patch.object(sa,"detect_voiced_ranges",return_value=[(0,192000)]):
            document=sa.build_profile(FakeEngine(None),np.ones(192000)*.1,"test_fixture")
        self.assertEqual(document["enrollmentSegments"],3)
        self.assertEqual(document["enrollmentVoicedMs"],12000)
        self.assertEqual(document["sourceKind"],"test_fixture")

    def test_build_profile_rejects_mixed_voices(self):
        engine=FakeEngine(None)
        counter=iter([0,0,1])
        def mixed(_):
            result=np.zeros(512,dtype=np.float32);result[next(counter)]=1;return result
        engine.embedding=mixed
        with patch.object(sa,"detect_voiced_ranges",return_value=[(0,192000)]):
            with self.assertRaises(sa.SpeakerAdmissionError) as error:
                sa.build_profile(engine,np.ones(192000)*.1,"test_fixture")
            self.assertEqual(error.exception.code,"speaker_enrollment_inconsistent_voice")

    def test_status_cli_missing_profile_exit_zero_sanitized(self):
        out=io.StringIO()
        with contextlib.redirect_stdout(out):
            result=sa.main(["status","--assets","unused","--profile",str(self.path)])
        self.assertEqual(result,0)
        event=json.loads(out.getvalue())
        self.assertEqual(event["type"],"speaker_status")
        self.assertFalse(event["profileValid"])
        self.assertNotIn(str(self.path),out.getvalue())

    def test_errors_are_codes_only(self):
        verifier=self.verifier()
        verifier.engine.embedding=lambda _: (_ for _ in ()).throw(RuntimeError("private-secret-path"))
        serialized=json.dumps(verifier.verify(np.ones(16000)*.1,[(0,16000)]))
        self.assertNotIn("private-secret",serialized)
        self.assertIn("speaker_verification_failed",serialized)


class FeatureTests(unittest.TestCase):
    def test_real_feature_shape_determinism_cmn(self):
        signal=np.sin(np.arange(32000,dtype=np.float32)*.123)*.1
        first=sa.compute_fbank(signal)
        second=sa.compute_fbank(signal)
        self.assertEqual(first.shape,(1,198,80))
        np.testing.assert_array_equal(first,second)
        self.assertLess(float(np.abs(first.mean(axis=1)).max()),1e-4)


class AssetTests(unittest.TestCase):
    def test_asset_hash_contract_and_path_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            model=folder/'model.onnx'
            model.write_bytes(b'model-fixture-not-for-inference')
            manifest=dict(schemaVersion=1,modelId='campplus',file='model.onnx',
                          sha256=sa._file_sha(model),sizeBytes=model.stat().st_size,
                          embeddingDimension=512,inputName='feats',outputName='embs',
                          sampleRate=16000,featureVersion=sa.FEATURE_VERSION,
                          provider='CPUExecutionProvider',defaultThreshold=.65)
            path=folder/'manifest.json'
            path.write_text(json.dumps(manifest),'utf-8')
            self.assertEqual(sa.load_assets(folder)[1],model.resolve())
            for changes in ({'sha256':'0'*64},{'embeddingDimension':192},
                            {'provider':'CUDAExecutionProvider'},{'file':'../outside.onnx'},
                            {'sampleRate':48000},{'featureVersion':'unknown'},
                            {'defaultThreshold':float('nan')}):
                with self.subTest(changes=changes):
                    altered=dict(manifest,**changes)
                    path.write_text(json.dumps(altered),'utf-8')
                    with self.assertRaises(sa.SpeakerAdmissionError):
                        sa.load_assets(folder)


if __name__=="__main__":
    unittest.main()
