"""Export source-backed, anonymous translation review without latency, arm or usage fields."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixtures', type=Path)
    parser.add_argument('results', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    fixture_bytes, result_bytes = args.fixtures.read_bytes(), args.results.read_bytes()
    fixtures = json.loads(fixture_bytes)['fixtures']
    results = json.loads(result_bytes)['results']
    if args.output.exists():
        raise ValueError('Review export directory already exists; preserve previous evidence.')
    args.output.mkdir()
    rng = random.Random(2026101601)
    mapping, cases = [], []
    for case_index, fixture in enumerate(fixtures, 1):
        outputs = [row for row in results if row['case_id'] == fixture['id']]
        rng.shuffle(outputs)
        case = {key: fixture[key] for key in ('id', 'ja', 'context', 'reference', 'reference_source', 'checkpoints') if key in fixture}
        case['review_case'] = f'R{case_index:02}'
        case['outputs'] = []
        for output_index, row in enumerate(outputs, 1):
            slot = f'R{case_index:02}-M{output_index:02}'
            case['outputs'].append({'slot': slot, 'success': row['success'], 'translation': row.get('translation')})
            mapping.append({'slot': slot, 'result_index': row['index'], 'case_id': row['case_id'], 'block': row['block'], 'arm': row['arm']})
        cases.append(case)
    common = {
        'method': 'Anonymous model-assisted review; not human bilingual acceptance or a population accuracy rate.',
        'instructions': ['Assess each language against current ja/context, using references as fallible assistance.',
            'Report only material mistranslation, omission/addition, names, numbers, negation, roles or context contamination; distinguish minor phrasing and ambiguity.',
            'Do not infer arms, inspect mapping/latency files, or treat blank references as golden transcripts.',
            'For each finding return slot, lang, severity critical/minor/ambiguous, source_quote, output_quote, rationale and suggested meaning.',
            'Include reviewed_slots, reviewed_target_translations, findings, and limitations; absence of findings is not proof of accuracy.'],
    }
    for number, start in enumerate(range(0, len(cases), 15), 1):
        (args.output / f'blind-batch-{number:02}.json').write_text(json.dumps({**common, 'cases': cases[start:start+15]}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    (args.output / 'mapping-root-only.json').write_text(json.dumps({'mapping': mapping}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    (args.output / 'export-check.json').write_text(json.dumps({'fixtures_sha256': hashlib.sha256(fixture_bytes).hexdigest(),
        'results_sha256': hashlib.sha256(result_bytes).hexdigest(), 'cases': len(cases), 'output_slots': len(mapping),
        'fields_excluded_from_blind_batches': ['arm', 'block', 'index', 'latency', 'usage', 'telemetry', 'model', 'threadId']}, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'cases': len(cases), 'output_slots': len(mapping)}))


if __name__ == '__main__':
    main()
