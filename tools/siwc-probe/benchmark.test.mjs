import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateBenchmark, createSchedule, aggregateBenchmark, percentile, runBenchmark, isBlockingServiceError } from './benchmark.mjs';

const config = { version: 1, case_count: 500, seed: 'synthetic-test-only', model_slugs: ['model-a', 'model-b', 'model-c'] };
const fixtures = { glossary: [], cases: Array.from({ length: 500 }, (_, n) => ({ id: String(n), ja: '日本語テスト' + n, category: n % 2 ? 'odd' : 'even', context: '', reference: { zh: '合成参考', en: 'Synthetic reference' }, checkpoints: ['Test only'] })) };

test('500 distinct cases are required; deterministic schedule covers every model/case exactly once', () => {
  assert.equal(validateBenchmark(config, fixtures).quality_requests, 1500);
  const a = createSchedule(config, fixtures), b = createSchedule(config, fixtures);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map(x => x.model + ':' + x.case_id)).size, 1500);
  assert.notDeepEqual(a, createSchedule({ ...config, seed: 'other' }, fixtures));
  assert.throws(() => validateBenchmark(config, { ...fixtures, cases: fixtures.cases.slice(0, 18) }), /exact configured/);
  assert.throws(() => validateBenchmark(config, { ...fixtures, cases: [fixtures.cases[0], ...fixtures.cases.slice(0, 499)] }), /duplicate/);
});

test('quantiles use nearest rank and deadline denominator includes failures', () => {
  const r = n => ({ case_id: String(n), success: true, timings_ms: Object.fromEntries(['headers','first_nonempty_delta','bilingual_json_ready','completed','total'].map(k => [k, n])) });
  const a = aggregateBenchmark([...Array.from({ length: 500 }, (_, i) => r(i + 1)), { case_id: 'fail', success: false, final_status: 'timeout' }]);
  assert.equal(a.latency_ms_successes_only.completed.median, 250.5);
  assert.equal(a.latency_ms_successes_only.completed.p95_nearest_rank, 475);
  assert.equal(a.latency_ms_successes_only.completed.p99_nearest_rank, 495);
  assert.equal(a.completed_within_ms_all_attempts[1000].denominator, 501);
  assert.equal(a.completed_within_ms_all_attempts[1000].count, 500);
  assert.equal(percentile([], .95), null);
});

test('mock benchmark completes all 500 scheduled cases, omits token logs and refuses overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'siwc-benchmark-test-'));
  const one = { ...config, model_slugs: ['model-a'] };
  let calls = 0;
  const translate = async ({ accessToken, model, fixture }) => {
    assert.equal(accessToken, 'synthetic-token');
    calls++;
    return { model: model.slug, case_id: fixture.id, success: true, request: { input: [{ role: 'user', content: JSON.stringify({ ja: fixture.ja, context: fixture.context }) }] }, timings_ms: { headers: 1, first_nonempty_delta: 2, bilingual_json_ready: 3, completed: 4, total: 5 }, translation: { zh: '中', en: 'E' } };
  };
  const summary = await runBenchmark({ getAccessToken: async () => 'synthetic-token', models: { models: [{ slug: 'model-a' }] }, fixtures, config: one, outputDir: dir, translate });
  assert.equal(calls, 501);
  assert.equal(summary.phase, 'completed');
  assert.equal(summary.quality['model-a'].attempts, 500);
  assert.equal(JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8')).length, 500);
  const log = readFileSync(join(dir, 'requests.jsonl'), 'utf8');
  assert.equal(log.includes('合成参考'), false);
  assert.equal(log.includes('synthetic-token'), false);
  await assert.rejects(runBenchmark({ getAccessToken: async () => 'synthetic-token', models: { models: [{ slug: 'model-a' }] }, fixtures, config: one, outputDir: dir, translate }), /overwrite/);
});

test('HTTP-200 streamed rate/quota/auth errors stop the workload immediately and preserve partial results', async () => {
  for (const code of ['rate_limit_exceeded', 'insufficient_quota', 'permission_denied']) {
    assert.equal(isBlockingServiceError({ http_status: 200, error: { code } }), true);
    const dir = mkdtempSync(join(tmpdir(), 'siwc-benchmark-stop-test-'));
    let calls = 0;
    const translate = async ({ model, fixture }) => {
      calls++;
      return { model: model.slug, case_id: fixture.id, success: calls <= 3, http_status: 200, final_status: calls <= 3 ? 'completed' : 'failed',
        timings_ms: { headers: 1, first_nonempty_delta: 2, bilingual_json_ready: 3, completed: calls <= 3 ? 4 : null, total: 5 },
        translation: calls <= 3 ? { zh: '中', en: 'E' } : null, error: calls <= 3 ? null : { code } };
    };
    await assert.rejects(runBenchmark({ getAccessToken: async () => 'synthetic-token', models: { models: config.model_slugs.map(slug => ({ slug })) }, fixtures, config, outputDir: dir, translate }), /stopped/);
    assert.equal(calls, 4);
    const saved = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    assert.equal(saved.phase, 'stopped');
    assert.equal(saved.completed_requests, 4);
    assert.equal(Object.values(saved.quality).reduce((n, r) => n + r.attempts, 0), 1);
  }
});
