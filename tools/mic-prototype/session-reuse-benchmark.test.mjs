import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runSessionReuseBenchmark } from './session-reuse-benchmark.mjs';

test('paired benchmark uses source-only prompts, counts semantic completion, and resets continuation per block', async () => {
  const scratch = await mkdtemp(resolve('.runtime/session-benchmark-test-'));
  const fixtures = [{ id: 'a', ja: 'いいえ、二人です。', context: 'speaker A', reference: { zh: 'DO_NOT_SEND_REFERENCE' } },
    { id: 'b', ja: '今度は三人です。', context: 'speaker B', checkpoints: ['DO_NOT_SEND_CHECKPOINT'] }];
  const schedule = [1, 2].flatMap(block => fixtures.flatMap(fixture => ['fresh_exec', 'resident_fresh_thread', 'resident_same_thread']
    .map(arm => ({ block, case_id: fixture.id, arm }))));
  const fixturePath = join(scratch, 'fixtures.json'), schedulePath = join(scratch, 'schedule.json');
  await writeFile(fixturePath, JSON.stringify({ fixtures })); await writeFile(schedulePath, JSON.stringify({ schedule }));
  let clock = 0, createdThreads = 0, closed = 0;
  const seen = [], released = [], continued = [];
  const successful = { success: true, translation: { zh: '两个人。', en: 'Two people.' }, usage: null,
    terminal_event: 'turn.completed', final_status: 'completed', timings_ms: { completed: 100, total: 100 }, telemetry: {} };
  const result = await runSessionReuseBenchmark({ executable: 'C:/fake/codex.exe', cwd: join(scratch, 'work'), fixturePath, schedulePath,
    outputDirectory: join(scratch, 'results'), now: () => clock, loginCheck: async () => ({ loggedIn: true }),
    execTranslate: async options => { seen.push(options.fixture); clock += 100; options.onTurnCompleted(structuredClone(successful));
      clock += 200; return { ...structuredClone(successful), timings_ms: { completed: 300, total: 300 } }; },
    createServer: async () => { clock += 10; return { startupMs: 10, diagnostics: () => ({}),
      startThread: async () => { clock += 20; return { threadId: `local-${++createdThreads}`, setupMs: 20 }; },
      translate: async options => { seen.push(options.fixture); continued.push(options.threadId); clock += 100; return structuredClone(successful); },
      releaseThread: async handle => { released.push(handle); }, close: async () => { closed++; return { closed: true, exit_code: 0 }; },
    }; } });
  assert.equal(result.completed, 12); assert.equal(result.successful, 12); assert.equal(result.fatal_code, null);
  assert.equal(closed, 1); assert.equal(createdThreads, 6); assert.equal(released.length, 5);
  assert.ok(seen.every(fixture => Object.keys(fixture).sort().join(',') === 'context,id,ja'));
  assert.doesNotMatch(JSON.stringify(seen), /DO_NOT_SEND/);
  const saved = JSON.parse(await readFile(join(scratch, 'results/results.json'), 'utf8'));
  assert.ok(saved.results.every(row => row.translation_semantic_ms === 100));
  assert.ok(saved.results.filter(row => row.arm === 'fresh_exec').every(row => row.segment_to_bilingual_ms === 100 && row.wall_until_adapter_return_ms === 300));
  assert.ok(saved.results.filter(row => row.arm === 'resident_fresh_thread').every(row => row.segment_to_bilingual_ms === 120));
  for (const block of [1, 2]) {
    const current = saved.results.filter(row => row.block === block && row.arm === 'resident_same_thread');
    assert.deepEqual(current.map(row => row.segment_to_bilingual_ms), [120, 100]);
  }
  for (const id of ['a', 'b']) assert.equal(new Set(saved.results.filter(row => row.case_id === id).map(row => row.prompt_sha256)).size, 1);
});

test('failure is retained, stops the schedule without retry and still closes the resident process', async () => {
  const scratch = await mkdtemp(resolve('.runtime/session-benchmark-failure-'));
  const fixturePath = join(scratch, 'fixtures.json'), schedulePath = join(scratch, 'schedule.json');
  await writeFile(fixturePath, JSON.stringify({ fixtures: [{ id: 'a', ja: '違います。' }] }));
  await writeFile(schedulePath, JSON.stringify({ schedule: [1, 2].map(block => ({ block, case_id: 'a', arm: 'resident_same_thread' })) }));
  let closed = 0, translated = 0;
  const result = await runSessionReuseBenchmark({ executable: 'C:/fake/codex.exe', cwd: join(scratch, 'work'), fixturePath, schedulePath,
    outputDirectory: join(scratch, 'results'), allowUnpairedSmoke: true, loginCheck: async () => ({ loggedIn: true }),
    createServer: async () => ({ diagnostics: () => ({}), startThread: async () => ({ threadId: 'local', setupMs: 1 }),
      translate: async () => { translated++; return { success: false, translation: null, error: { code: 'invalid_bilingual_json' }, timings_ms: {} }; },
      close: async () => { closed++; return { closed: true, exit_code: 0 }; } }) });
  assert.equal(result.completed, 1); assert.equal(result.successful, 0); assert.equal(result.fatal_code, 'sample_failed_no_automatic_retry');
  assert.equal(translated, 1); assert.equal(closed, 1);
});

test('a thrown adapter attempt remains a failed row and an unconfirmed close cannot be successful', async () => {
  const scratch = await mkdtemp(resolve('.runtime/session-benchmark-thrown-'));
  const fixturePath = join(scratch, 'fixtures.json'), schedulePath = join(scratch, 'schedule.json');
  await writeFile(fixturePath, JSON.stringify({ fixtures: [{ id: 'a', ja: '違います。' }] }));
  await writeFile(schedulePath, JSON.stringify({ schedule: [1, 2].map(block => ({ block, case_id: 'a', arm: 'resident_same_thread' })) }));
  const result = await runSessionReuseBenchmark({ executable: 'C:/fake/codex.exe', cwd: join(scratch, 'work'), fixturePath, schedulePath,
    outputDirectory: join(scratch, 'results'), allowUnpairedSmoke: true, loginCheck: async () => ({ loggedIn: true }),
    createServer: async () => ({ diagnostics: () => ({}), startThread: async () => ({ threadId: 'local', setupMs: 1 }),
      translate: async () => { throw Object.assign(new Error('must not persist arbitrary provider message'), { safeCode: 'app_server_timeout' }); },
      close: async () => ({ closed: false, termination_confirmed: false }) }) });
  assert.equal(result.completed, 1); assert.equal(result.successful, 0); assert.equal(result.fatal_code, 'app_server_timeout');
  const saved = JSON.parse(await readFile(join(scratch, 'results/results.json'), 'utf8'));
  assert.equal(saved.manifest.attempted_samples, 1); assert.equal(saved.manifest.failed_samples, 1); assert.equal(saved.manifest.not_run_samples, 1);
  assert.equal(saved.results[0].error.code, 'app_server_timeout');
  assert.doesNotMatch(JSON.stringify(saved), /must not persist arbitrary provider message/);
});
