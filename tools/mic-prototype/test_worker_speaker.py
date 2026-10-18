import unittest
from unittest.mock import patch
import numpy as np
import worker


class Verifier:
    def __init__(self, decision):
        self.decision = decision
        self.inputs = []

    def verify(self, audio, voiced_ranges=None):
        self.inputs.append((audio, voiced_ranges))
        return {"decision": self.decision, "reason": "fixture", "score": 0.8,
                "threshold": 0.65, "voicedMs": 1024, "gateMs": 2,
                "profileSha256": "a" * 64, "modelSha256": "b" * 64}


class WorkerSpeakerTests(unittest.TestCase):
    def run_consumer(self, decision):
        events = []
        verifier = Verifier(decision)
        audio = np.linspace(-0.1, 0.1, 32768, dtype=np.float32)
        segment = worker.AudioSegment(1, 100, 30100, 32868, audio, False, "pause", 10)
        segment.voiced_ranges = ((16000, 32768),)
        consumer = worker.AsrConsumer(None, lambda kind, **fields: events.append({"type": kind, **fields}),
                                      speaker_verifier=verifier)
        with patch.object(worker, "transcribe_audio", return_value=("こんにちは。", {})) as recognize:
            consumer.start()
            consumer.submit(segment)
            consumer.finish()
        return consumer, events, verifier, recognize, audio

    def test_rejected_speaker_never_reaches_whisper_or_fabricates_asr_result(self):
        consumer, events, _, recognize, _ = self.run_consumer("rejected")
        recognize.assert_not_called()
        self.assertEqual([event["type"] for event in events], ["vad_segment", "speaker_decision", "gap"])
        self.assertEqual(events[-1]["reason"], "speaker_rejected")
        self.assertEqual(consumer.speaker_diagnostics()["rejected"], 1)

    def test_accepted_verification_preserves_the_exact_asr_audio_and_original_clock(self):
        consumer, events, verifier, recognize, audio = self.run_consumer("accepted")
        self.assertIs(verifier.inputs[0][0], audio)
        self.assertEqual(verifier.inputs[0][1], ((16000, 32768),))
        self.assertIs(recognize.call_args.args[1], audio)
        result = events[-1]
        self.assertEqual(result["type"], "asr_result")
        self.assertEqual(result["startSample"], 100)
        self.assertEqual(result["vadCommitPerfMs"], 10)
        self.assertEqual(result["speakerAdmission"]["decision"], "accepted")
        self.assertEqual(consumer.completed, 1)

    def test_insufficient_or_uncertain_speaker_does_not_reuse_previous_admission(self):
        consumer, events, _, recognize, _ = self.run_consumer("uncertain")
        recognize.assert_not_called()
        self.assertEqual(events[-1]["reason"], "speaker_uncertain")
        self.assertEqual(consumer.speaker_uncertain, 1)

    def test_invalid_verifier_result_fails_closed(self):
        consumer, events, _, recognize, _ = self.run_consumer("invalid")
        recognize.assert_not_called()
        self.assertIsNotNone(consumer.fatal)
        self.assertEqual(events[-1]["type"], "worker_error")

    def test_gate_execution_time_is_not_counted_again_as_queue_wait(self):
        events = []
        audio = np.zeros(32000, dtype=np.float32)
        segment = worker.AudioSegment(1, 0, 32000, 32000, audio, False, "pause", 10)
        consumer = worker.AsrConsumer(None, lambda kind, **fields: events.append({"type": kind, **fields}),
                                      speaker_verifier=Verifier("accepted"))
        # dequeue=100, gate=101..201, ASR=202..302; VAD commit is 10.
        with patch.object(worker, "perf_ms", side_effect=[100, 101, 201, 202, 302]), \
                patch.object(worker, "transcribe_audio", return_value=("こんにちは。", {})):
            consumer.start(); consumer.submit(segment); consumer.finish()
        result = events[-1]
        self.assertEqual(result["asrQueueMs"], 90)
        self.assertEqual(result["asrMs"], 100)
        self.assertEqual(result["speakerAdmission"]["gateEndPerfMs"] - result["speakerAdmission"]["gateStartPerfMs"], 100)
        self.assertEqual(result["asrDequeuedPerfMs"], 100)

    def test_preroll_and_postroll_cannot_count_as_voiced_duration(self):
        segmenter = worker.VadSegmenter(lambda *_args, **_kwargs: None, pause_ms=128,
                                        pre_roll_ms=512, post_roll_ms=96)
        frame = np.ones(512, dtype=np.float32) * 0.02
        segments = []
        for i in range(24):
            segments.extend(segmenter.feed(frame, i * 512, 0.9 if 16 <= i < 20 else 0))
        self.assertEqual(len(segments), 1)
        segment = segments[0]
        voiced = sum(end - start for start, end in segment.voiced_ranges)
        self.assertEqual(voiced, 4 * 512)
        self.assertGreater(len(segment.audio), voiced)
        self.assertEqual(segment.voiced_ranges, ((16 * 512, 20 * 512),))


if __name__ == '__main__':
    unittest.main()
