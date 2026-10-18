"""Summarize completed/failed clips and optional human references without inventing accuracy."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import unicodedata


def normalize_ja(text: str) -> str:
    # Preserves names, numbers and negation; no kana/kanji equivalence guessing.
    return "".join(c for c in unicodedata.normalize("NFKC", text).lower()
                   if not c.isspace() and not unicodedata.category(c).startswith("P"))


def edit_distance(reference: str, hypothesis: str) -> int:
    previous = list(range(len(hypothesis) + 1))
    for i, a in enumerate(reference, 1):
        current = [i]
        for j, b in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j-1] + (a != b)))
        previous = current
    return previous[-1]


def distribution(values) -> dict:
    valid = sorted(x for x in values if isinstance(x, (int, float)) and math.isfinite(x) and x >= 0)
    n = len(valid)
    return {"n": n, "p50": (valid[(n-1)//2] + valid[n//2]) / 2 if n else None,
            "p95": valid[math.ceil(n * .95)-1] if n else None, "max": valid[-1] if n else None}


def summarize(report: dict) -> dict:
    rows = report.get("rows", report.get("state", {}).get("rows", []))
    completed = [r for r in rows if r.get("status") == "completed"]
    paired = [r for r in completed if all(r.get("evaluation", {}).get(k) != "unreviewed"
                 and r.get("evaluation", {}).get(k) in {"usable", "minor", "critical", "ambiguous"}
                 for k in ("zhQuality", "enQuality"))]
    usable = [r for r in paired if all(r["evaluation"][k] == "usable" for k in ("zhQuality", "enQuality"))]
    references = [r for r in rows if r.get("evaluation", {}).get("referenceJa", "").strip()]
    errors = total = normalized_errors = normalized_total = 0
    for row in references:
        ref, hyp = row["evaluation"]["referenceJa"], row.get("ja") or ""
        errors += edit_distance(ref, hyp); total += len(ref)
        ref, hyp = normalize_ja(ref), normalize_ja(hyp)
        normalized_errors += edit_distance(ref, hyp); normalized_total += len(ref)
    latency_keys = ("segmentationMs", "asrMs", "queueMs", "translationMs", "orderingWaitMs",
                    "audioEndToCompletedMs", "endToEndVisibleMs")
    visible_within3 = [r for r in completed if isinstance(r.get("latency", {}).get("endToEndVisibleMs"), (int, float))
                       and 0 <= r["latency"]["endToEndVisibleMs"] <= 3000]
    return {"session": report.get("session"), "segments": len(rows), "completed": len(completed),
            "failedGapOrPending": len(rows)-len(completed),
            "latencyMsCompletedOnly": {k: distribution(r.get("latency", {}).get(k) for r in completed) for k in latency_keys},
            "visibleWithin3SecondsAllSegments": {"numerator": len(visible_within3), "denominator": len(rows)},
            "humanReview": {"pairedReviewed": len(paired), "pairedStrictlyUsable": len(usable),
                            "referenceSegments": len(references), "rawCER": errors/total if total else None,
                            "normalizedCER": normalized_errors/normalized_total if normalized_total else None,
                            "normalization": "Unicode NFKC + lowercase + remove punctuation/whitespace; preserve names, numbers, negation",
                            "note": "Only independently human-transcribed references support accuracy claims; unreviewed is never usable."},
            "qualityAnd3SecondsAllSegments": {"numerator": sum(r in usable for r in visible_within3), "denominator": len(rows)},
            "limitations": ["Page acknowledgement estimates presentation; it is not independently filmed visibility.",
                            "Audio endpoint is VAD-estimated unless manually aligned.",
                            "Segment rows do not account for unsegmented lost audio; inspect all gap/warning events separately.",
                            "Small public-recording smoke tests do not establish the user's live accuracy or P95."]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = summarize(json.loads(args.report.read_text(encoding="utf-8")))
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
