import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const dir = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('A benchmark run directory is required.');
const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const spec = read('run-spec.json');
const fixtures = read('fixtures.snapshot.json');
if (createHash('sha256').update(JSON.stringify(fixtures)).digest('hex') !== spec.fixture_sha256) throw new Error('Frozen fixture snapshot hash mismatch.');
const rows = readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const complete = rows.filter(r => r.kind === 'request.finished' && r.phase === 'quality').map(r => r.result);
const models = spec.config.model_slugs;
const orderedIds = [...new Set(read('schedule.json').map(item => item.case_id))];
const labels = ['A','B','C','D','E','F','G'].slice(0, models.length);
const reviewDir = join(dir, 'blind-review');
mkdirSync(reviewDir, { recursive: true });
const mapping = Object.fromEntries(labels.map((label,i) => [label, models[i]]));
if (!existsSync(join(reviewDir, 'mapping.private-to-reviewers.json'))) writeFileSync(join(reviewDir, 'mapping.private-to-reviewers.json'), JSON.stringify(mapping, null, 2) + '\n', { flag: 'wx' });
let exported = 0, readyCases = 0;
const ready = [];
for (const fixture of fixtures.cases) {
  const outputs = models.map(model => complete.filter(r => r.model === model && r.case_id === fixture.id));
  if (outputs.some(list => list.length === 0)) continue;
  if (outputs.some(list => list.length !== 1)) throw new Error('Duplicate completed quality case/model pair.');
  ready.push({ id: fixture.id, category: fixture.category, source_group: fixture.source_group, ja: fixture.ja, context: fixture.context ?? '', synthetic_reference: fixture.reference, checkpoints: fixture.checkpoints,
    translations: Object.fromEntries(labels.map((label,i) => [label, { available: outputs[i][0].success, text: outputs[i][0].translation }])) });
}
readyCases = ready.length;
// Only stable groups based on the original frozen order may be exported before the run ends.
for (let i = 0; i < orderedIds.length; i += 100) {
  const groupIds = orderedIds.slice(i, i + 100);
  const group = groupIds.map(id => ready.find(r => r.id === id));
  if (group.some(x => !x)) continue;
  const path = join(reviewDir, 'batch-' + String(i / 100 + 1).padStart(2,'0') + '.json');
  if (existsSync(path)) continue;
  writeFileSync(path, JSON.stringify({ method: 'Blind model-assisted semantic review only. References are synthetic and may be imperfect; Japanese and context prevail. Do not read the mapping, other model metadata or latency. Mark unsupported additions, missing content or real meaning changes; distinguish ambiguity and acceptable rewording. Unavailable output is a technical failure, not acceptable.', cases: group }, null, 2) + '\n', { flag: 'wx' });
  exported++;
}
console.log(JSON.stringify({ complete_quality_requests: complete.length, cases_ready_for_all_models: readyCases, new_blind_batches: exported }));
