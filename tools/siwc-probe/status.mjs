import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

if (!process.argv[2]) throw new Error('A probe run directory is required.');
const dir = resolve(process.argv[2]);
const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const state = read('probe-status.json');
let summary = null;
try { summary = read('summary.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (process.argv.includes('--compact')) {
  const q = Object.values(summary?.quality ?? {});
  console.log(`${state.phase}: quality=${q.reduce((n,r) => n + r.attempts, 0)}/${state.plannedQualityRequests}; per_model=${q.map(r => r.attempts).join(',')}; failures=${q.reduce((n,r) => n + r.failures, 0)}`);
} else console.log(JSON.stringify({
  phase: state.phase, completed_requests: summary?.completed_requests ?? state.completedRequests,
  planned_quality_requests: state.plannedQualityRequests,
  current: state.message, updated_at: state.updatedAt,
  quality: summary ? Object.fromEntries(Object.entries(summary.quality).map(([model,r]) => [model, { attempts: r.attempts, successes: r.successes, failures: r.failures }])) : null,
  quota_queried: state.quotaQueried,
}));
