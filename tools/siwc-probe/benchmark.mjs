import { appendFileSync, existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runTranslation, statistics } from './inference.mjs';

const stamp = () => new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
const hash = text => createHash('sha256').update(text).digest('hex');
const atomicJson = (path, value) => {
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, path);
};
export function lengthBucket(text) { const n = [...text].length; return n <= 40 ? 'short_1_40' : n < 100 ? 'medium_41_99' : 'long_100_plus'; }

export function validateBenchmark(config, fixtures) {
  if (!config || config.version !== 1 || !Array.isArray(config.model_slugs) || !config.model_slugs.length || config.model_slugs.length > 7
    || new Set(config.model_slugs).size !== config.model_slugs.length || config.model_slugs.some(s => typeof s !== 'string' || !/^[A-Za-z0-9._:-]{1,180}$/.test(s))) throw new Error('Invalid benchmark model selection.');
  if (!Number.isInteger(config.case_count) || config.case_count < 500 || config.case_count > 2000
    || !fixtures || !Array.isArray(fixtures.cases) || fixtures.cases.length !== config.case_count
    || typeof config.seed !== 'string' || !config.seed) throw new Error('Benchmark requires the exact configured 500..2000 cases.');
  const ids = new Set(), texts = new Set();
  for (const item of fixtures.cases) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.ja !== 'string' || !item.ja.trim()
      || texts.has(item.ja.normalize('NFKC').replace(/\s/g, '')) || !item.reference?.zh?.trim() || !item.reference?.en?.trim()
      || !Array.isArray(item.checkpoints) || !item.checkpoints.length || typeof item.category !== 'string') throw new Error('Invalid, duplicate or incomplete benchmark case.');
    ids.add(item.id); texts.add(item.ja.normalize('NFKC').replace(/\s/g, ''));
  }
  return { cases: fixtures.cases.length, models: config.model_slugs.length, quality_requests: fixtures.cases.length * config.model_slugs.length, smoke_requests: config.model_slugs.length };
}

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.max(0, Math.ceil(v.length * p) - 1)] : null;
}

export function isBlockingServiceError(result) {
  return [401, 403, 429].includes(result.http_status)
    || /subscription_sharing|usage_limit|usage_unavailable|(?:^|_)(?:rate_limit|insufficient_quota|quota_exceeded|permission_denied|access_denied|authentication|invalid_api_key|invalid_token|token_expired|unauthorized|forbidden|model_not_found)(?:_|$)/i.test(result.error?.code ?? '');
}

export function aggregateBenchmark(records) {
  const good = records.filter(r => r.success);
  const complete = good.map(r => r.timings_ms.completed);
  const bucket = v => ({ count: v, denominator: records.length, rate: records.length ? v / records.length : null });
  return {
    attempts: records.length, successes: good.length, failures: records.length - good.length,
    failure_details: records.filter(r => !r.success).map(r => ({ case_id: r.case_id, status: r.final_status, code: r.error?.code ?? null })),
    latency_ms_successes_only: Object.fromEntries(['headers', 'first_nonempty_delta', 'bilingual_json_ready', 'completed', 'total'].map(k => {
      const values = good.map(r => r.timings_ms[k]);
      return [k, { ...statistics(values), p90_nearest_rank: values.length >= 100 ? percentile(values, .90) : null, p95_nearest_rank: values.length >= 100 ? percentile(values, .95) : null, p99_nearest_rank: values.length >= 500 ? percentile(values, .99) : null }];
    })),
    completed_within_ms_all_attempts: Object.fromEntries([1000, 2000, 3000, 5000].map(t => [t, bucket(complete.filter(v => v <= t).length)])),
    percentile_note: 'Empirical nearest-rank quantiles of successful requests; failures remain in all-attempt threshold denominators. Not a multi-day stability guarantee. P90/P95 require n>=100; P99 requires n>=500.',
  };
}

/** Freeze a deterministic sequential schedule: every model receives all cases, with rotated order. */
export function createSchedule(config, fixtures) {
  validateBenchmark(config, fixtures);
  const cases = [...fixtures.cases].sort((a, b) => hash(config.seed + ':' + a.id).localeCompare(hash(config.seed + ':' + b.id)));
  const schedule = [];
  for (let i = 0; i < cases.length; i++) {
    for (let j = 0; j < config.model_slugs.length; j++) schedule.push({ case_id: cases[i].id, model: config.model_slugs[(i + j) % config.model_slugs.length] });
  }
  return schedule;
}

export async function runBenchmark({ getAccessToken, models, fixtures, config, outputDir, onProgress = () => {}, translate = runTranslation }) {
  const expected = validateBenchmark(config, fixtures);
  const catalog = Array.isArray(models) ? { models } : models;
  const selected = config.model_slugs.map(slug => catalog.models.find(m => m.slug === slug));
  if (selected.some(m => !m)) throw Object.assign(new Error('A configured model is absent from the fresh account catalog.'), { safeCode: 'benchmark_model_not_available' });
  mkdirSync(outputDir, { recursive: true });
  for (const name of ['catalog.json', 'requests.jsonl', 'summary.json', 'schedule.json', 'run-spec.json']) if (existsSync(join(outputDir, name))) throw new Error('Refusing to overwrite benchmark evidence: ' + name);
  const schedule = createSchedule(config, fixtures);
  atomicJson(join(outputDir, 'catalog.json'), catalog);
  atomicJson(join(outputDir, 'schedule.json'), schedule);
  const sourceDir = join(outputDir, 'source-snapshot');
  mkdirSync(sourceDir);
  const sourceHashes = {};
  for (const name of ['benchmark.mjs', 'inference.mjs', 'probe.mjs', 'oauth-session.mjs']) {
    const bytes = readFileSync(new URL('./' + name, import.meta.url));
    writeFileSync(join(sourceDir, name), bytes, { flag: 'wx' }); sourceHashes[name] = hash(bytes);
  }
  atomicJson(join(outputDir, 'fixtures.snapshot.json'), fixtures);
  atomicJson(join(outputDir, 'run-spec.json'), { created_at: stamp(), config, expected, fixture_sha256: hash(JSON.stringify(fixtures)), schedule_sha256: hash(JSON.stringify(schedule)), source_sha256: sourceHashes, prompt_policy: 'Same bilingual instruction/glossary as initial probe; private references/checkpoints excluded from request. No parameter tuning or retries.', concurrency: 1, quality_review: 'Synthetic model-authored references; model-assisted review, not human accuracy.' });
  writeFileSync(join(outputDir, 'requests.jsonl'), '', { flag: 'wx' });
  const log = r => appendFileSync(join(outputDir, 'requests.jsonl'), JSON.stringify(r) + '\n');
  const records = [];
  const byId = new Map(fixtures.cases.map(c => [c.id, c]));
  const byModel = new Map(selected.map(m => [m.slug, m]));
  const summary = { started_at: stamp(), finished_at: null, phase: 'running', expected, config, completed_requests: 0, smoke: {}, quality: {}, by_length: {}, by_category: {}, stopped_reason: null, quota_queried: false };
  const save = () => {
    for (const phase of ['smoke', 'quality']) for (const model of selected) {
      const items = records.filter(r => r.phase === phase && r.model === model.slug);
      summary[phase][model.slug] = aggregateBenchmark(items);
      if (phase === 'quality') {
        summary.by_length[model.slug] = Object.fromEntries(['short_1_40', 'medium_41_99', 'long_100_plus'].map(b => [b, aggregateBenchmark(items.filter(r => r.length_bucket === b))]));
        summary.by_category[model.slug] = Object.fromEntries([...new Set(fixtures.cases.map(f => f.category))].map(c => [c, aggregateBenchmark(items.filter(r => r.category === c))]));
      }
    }
    atomicJson(join(outputDir, 'summary.json'), summary);
  };
  save();
  async function run(phase, model, fixture, index, total) {
    // Renewal is measured separately from inference and never written to request bodies.
    const accessToken = await getAccessToken();
    const requestId = randomUUID();
    await onProgress({ phase, model: model.slug, caseId: fixture.id, index, total, status: 'started' });
    log({ kind: 'request.started', request_id: requestId, phase, model: model.slug, case_id: fixture.id, at: stamp(), category: fixture.category, length_bucket: lengthBucket(fixture.ja) });
    const result = await translate({ accessToken, model, fixture, glossary: fixtures.glossary, onEvent: event => log({ kind: 'response.event', request_id: requestId, phase, model: model.slug, case_id: fixture.id, event }) });
    records.push({ phase, category: fixture.category, length_bucket: lengthBucket(fixture.ja), ...result });
    log({ kind: 'request.finished', request_id: requestId, phase, result });
    summary.completed_requests = records.length;
    save();
    await onProgress({ phase, model: model.slug, caseId: fixture.id, index, total, status: result.success ? 'succeeded' : 'failed', completedMs: result.timings_ms.completed, errorCode: result.error?.code ?? null });
    if (isBlockingServiceError(result)) throw Object.assign(new Error('Benchmark stopped after an authorization or service-limit error; no retries.'), { safeCode: 'benchmark_stopped_permission_or_service_limit' });
    return result;
  }
  try {
    for (let i = 0; i < selected.length; i++) {
      const result = await run('smoke', selected[i], fixtures.cases.find(c => c.id === '03') ?? fixtures.cases[0], i + 1, selected.length);
      if (!result.success) throw Object.assign(new Error('Configured model smoke failed; preserving incomplete evidence.'), { safeCode: 'benchmark_smoke_failed' });
    }
    for (let i = 0; i < schedule.length; i++) await run('quality', byModel.get(schedule[i].model), byId.get(schedule[i].case_id), i + 1, schedule.length);
    summary.phase = 'completed';
  } catch (error) {
    summary.phase = 'stopped'; summary.stopped_reason = error.safeCode ?? 'benchmark_interrupted'; throw error;
  } finally {
    summary.finished_at = stamp(); save();
  }
  return summary;
}
