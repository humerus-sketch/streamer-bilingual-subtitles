import unittest
from evaluate_run import distribution, edit_distance, normalize_ja, summarize


class EvaluationTests(unittest.TestCase):
    def test_semantics_preserved_by_normalization(self):
        self.assertEqual(normalize_ja("Ａさんは、行かない。 １２"), "aさんは行かない12")

    def test_edit_distance_counts_insertions_deletions_and_substitutions(self):
        self.assertEqual(edit_distance("行かない", "行く"), 3)
        self.assertEqual(edit_distance("", "字幕"), 2)

    def test_failed_and_unreviewed_never_count_as_usable(self):
        report = {"rows": [{"status": "completed", "ja": "はい", "latency": {"endToEndVisibleMs": 2500}},
                           {"status": "failed"}, {"status": "queued"}]}
        result = summarize(report)
        self.assertEqual(result["visibleWithin3SecondsAllSegments"], {"numerator": 1, "denominator": 3})
        self.assertEqual(result["qualityAnd3SecondsAllSegments"]["numerator"], 0)
        self.assertIsNone(result["humanReview"]["rawCER"])

    def test_partial_human_reference_cer_and_paired_judgment(self):
        report = {"rows": [{"status": "completed", "ja": "はい。", "evaluation": {
            "referenceJa": "はい", "zhQuality": "usable", "enQuality": "usable"}}]}
        result = summarize(report)["humanReview"]
        self.assertEqual(result["normalizedCER"], 0)
        self.assertEqual(result["rawCER"], .5)
        self.assertEqual(result["pairedStrictlyUsable"], 1)

    def test_missing_completion_is_not_timeout_percentile(self):
        self.assertEqual(distribution([None, 3, 2, -1, float("nan")]), {"n": 2, "p50": 2.5, "p95": 3, "max": 3})

    def test_failed_asr_with_reference_counts_as_deletions(self):
        result = summarize({"rows": [{"status": "gap", "evaluation": {"referenceJa": "はい"}}]})
        self.assertEqual(result["humanReview"]["referenceSegments"], 1)
        self.assertEqual(result["humanReview"]["rawCER"], 1)


if __name__ == "__main__":
    unittest.main()
