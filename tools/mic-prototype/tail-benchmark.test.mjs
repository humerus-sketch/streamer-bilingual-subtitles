import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { runTailBenchmark, createTailSchedule } from './tail-benchmark.mjs';
import { codexTranslationPrompt } from './codex-translation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const error = code => Object.assign(new Error('PRIVATE_PROVIDER_ERROR_OR_ACCOUNT'), { safeCode: code });
async function harness({ count = 30, hooks = {} } = {}) {
  const scratch = await mkdtemp(resolve('.runtime/tail-benchmark-test-'));
  const fixturePath = join(scratch, 'fixtures.json'), baselineInstructionsFile = join(scratch, 'baseline.md'), candidateInstructionsFile = join(scratch, 'candidate.md');
  const fixtures = Array.from({ length: count }, (_, index) => ({ id: 'case-' + index, ja: '違います。' + index, context: 'speaker-' + index,
    reference: { zh: 'PRIVATE_REFERENCE_DO_NOT_SEND' }, checkpoints: ['PRIVATE_CHECKPOINT_DO_NOT_SEND'] }));
  await writeFile(fixturePath, JSON.stringify({ fixtures })); await writeFile(baselineInstructionsFile, 'Translate both languages.\n');
  await writeFile(candidateInstructionsFile, 'Translate both languages.\nPreserve uncertain tokens.\nExplicit context overrides earlier text.\n');
  let clock = 0, threadSequence = 0, active = 0, peakActive = 0, translationCalls = 0;
  const clients = [], seen = [], events = [];
  const outputDirectory = join(scratch, 'results');
  const options = { executable: 'C:/fake/codex.exe', fixturePath, baselineInstructionsFile, candidateInstructionsFile,
    outputDirectory, cwd: join(scratch, 'empty-work'), allowSmallFixtureSet: count !== 30, now: () => clock,
    loginCheck: async () => ({ loggedIn: true, authMode: 'chatgpt' }),
    createServer: async config => {
      await access(join(outputDirectory, 'manifest.json')); await access(join(outputDirectory, 'schedule.json'));
      const arm = basename(config.instructionsFile).startsWith('baseline') ? 'baseline' : 'candidate';
      if (hooks.create) await hooks.create({ arm, config, scratch });
      const instructions = await readFile(config.instructionsFile), instructionHash = hash(instructions);
      clock += 10;
      const client = { arm, config, closes: 0, starts: [], releases: [], turns: [], startupMs: 10,
        diagnostics: () => ({ transport: 'codex_app_server', alignment: { explicit_process_effort: hooks.effort ?? 'low', model_catalog_default_effort: 'low' } }),
        async startThread() {
          clock += 20; const threadId = 'local-thread-' + (++threadSequence); client.starts.push(threadId); events.push(['start', arm]);
          return { threadId, setupMs: 20, telemetry: { observed: { model: 'gpt-6.1-sol', reasoningEffort: hooks.threadEffort ?? 'low' } } };
        },
        async releaseThread(threadId) { clock += 3; client.releases.push(threadId); events.push(['release', arm]); return { released: true }; },
        async translate(args) {
          active++; peakActive = Math.max(active, peakActive); translationCalls++; client.turns.push(args); seen.push({ arm, ...args });
          assert.equal(config.model.slug, 'gpt-6.1-sol'); assert.equal(config.serviceTier, 'fast');
          try {
            clock += 100;
            if (hooks.translate) { const value = await hooks.translate({ arm, args, index: translationCalls }); if (value !== undefined) return value; }
            const prompt = config.promptStyle === 'source_only' ? JSON.stringify({ ja: args.fixture.ja, context: args.fixture.context ?? '', glossary: args.glossary })
              : codexTranslationPrompt({ fixture: args.fixture, glossary: [] });
            const result = { model: 'gpt-6.1-sol', success: true, translation: { zh: '中文 ' + args.fixture.id, en: 'English ' + args.fixture.id },
              terminal_event: 'turn/completed', final_status: 'completed', error: null,
              timings_ms: { appserver_turn_start_ack: 1, appserver_first_event: 2, first_nonempty_delta: 70,
                bilingual_json_ready: 95, appserver_final_text: 98, completed: 100, total: 100 },
              usage: { input_tokens: 6300, output_tokens: 60, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 20 } },
              telemetry: { process_reusable: true, retry_notices: 0, request: { model: 'gpt-6.1-sol', requested_service_tier: 'fast',
                resolved_thread_reasoning_effort: 'low', prompt_style: config.promptStyle ?? 'full', prompt_sha256: hash(prompt),
                ja_sha256: hash(args.fixture.ja), instructions_sha256: instructionHash }, event_counts: { 'turn/completed': 1 } } };
            if (hooks.result) hooks.result(result); return result;
          } finally { active--; }
        },
        async close() {
          assert.equal(active, 0); client.closes++;
          if (hooks.close) return hooks.close({ arm });
          return { closed: true, termination_confirmed: true, exit_code: 0, exit_signal: null, unusable_code: null };
        },
      };
      clients.push(client); return client;
    } };
  return { options, fixtures, clients, seen, events, saved: async () => JSON.parse(await readFile(join(outputDirectory, 'results.json'), 'utf8')),
    calls: () => translationCalls, peak: () => peakActive, scratch };
}

test('counterbalanced two-block schedule reverses complete case/arm order and matches each arm history positions', () => {
  const fixtures = Array.from({ length: 30 }, (_, index) => ({ id: 'c-' + index }));
  const schedule = createTailSchedule(fixtures);
  assert.equal(schedule.length, 120);
  assert.deepEqual(schedule.slice(60).map(({ case_id, arm }) => ({ case_id, arm })), schedule.slice(0, 60).map(({ case_id, arm }) => ({ case_id, arm })).reverse());
  for (const block of [1, 2]) for (const arm of ['baseline', 'candidate']) {
    assert.deepEqual(schedule.filter(row => row.block === block && row.arm === arm).map(row => row.expected_prior_successful_turns_in_thread), Array.from({ length: 30 }, (_, index) => index % 3));
  }
});

test('formal 120-call mock freezes sources first, sends source-only data and retains full milestones without overlap', async () => {
  const h = await harness(), result = await runTailBenchmark(h.options), saved = await h.saved();
  assert.deepEqual({ scheduled: result.scheduled, successful: result.successful, not_run: result.not_run, fatal: result.fatal_code }, { scheduled: 120, successful: 120, not_run: 0, fatal: null });
  assert.equal(h.calls(), 120); assert.equal(h.peak(), 1); assert.equal(h.clients.length, 2);
  assert.deepEqual(h.clients.map(client => client.starts.length), [20, 20]); assert.deepEqual(h.clients.map(client => client.releases.length), [19, 19]);
  assert.deepEqual(h.clients.map(client => client.closes), [1, 1]);
  assert.ok(h.seen.every(value => Object.keys(value.fixture).sort().join(',') === 'context,id,ja' && value.glossary.length === 0));
  assert.doesNotMatch(JSON.stringify(h.seen), /PRIVATE_REFERENCE|PRIVATE_CHECKPOINT/);
  assert.doesNotMatch(await readFile(join(h.options.outputDirectory, 'fixtures.source-only.json'), 'utf8'), /PRIVATE_REFERENCE|PRIVATE_CHECKPOINT/);
  assert.ok(saved.results.every(row => row.strict_transport_completed_ms === 100 && row.dispatch_to_bilingual_ms === 100));
  assert.ok(saved.results.filter(row => row.actual_prior_successful_turns_in_thread === 0).every(row => row.thread_setup_ms === 20));
  assert.ok(saved.results.filter(row => row.actual_prior_successful_turns_in_thread > 0).every(row => row.thread_setup_ms === 0));
  for (const id of h.fixtures.map(value => value.id)) {
    const paired = saved.results.filter(row => row.case_id === id); assert.equal(paired.length, 4);
    assert.equal(new Set(paired.map(row => row.prompt_sha256)).size, 1);
    assert.equal(new Set(paired.map(row => row.instructions_sha256)).size, 2);
  }
  const turns = new Map(); for (const value of h.seen) turns.set(value.threadId, (turns.get(value.threadId) ?? 0) + 1);
  assert.ok([...turns.values()].every(count => count === 3));
  assert.equal(saved.manifest.arms.baseline.startup_ms, 10); assert.equal(saved.manifest.arms.candidate.startup_ms, 10);
  const initial = JSON.parse(await readFile(join(h.options.outputDirectory, 'manifest.json'), 'utf8'));
  assert.equal(initial.scheduled_samples, 120); assert.equal('finished_at' in initial, false);
});

test('a returned failure is counted once and all remaining planned rows stay explicitly not_run', async () => {
  const h = await harness({ hooks: { translate: ({ index }) => index === 2 ? { success: false, error: { code: 'appserver_turn_timeout', message: 'PRIVATE_PROVIDER_MESSAGE' } } : undefined } });
  const result = await runTailBenchmark(h.options), saved = await h.saved();
  assert.equal(result.successful, 1); assert.equal(result.failed, 1); assert.equal(result.not_run, 118); assert.equal(result.translation_calls, 2);
  assert.equal(result.fatal_code, 'tail_sample_failed_no_retry'); assert.deepEqual(h.clients.map(client => client.closes), [1, 1]);
  assert.equal(saved.results.length, 120); assert.equal(saved.results[1].error.code, 'appserver_turn_timeout');
  assert.ok(saved.results.slice(2).every(row => row.outcome === 'not_run' && !row.attempted));
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROVIDER_MESSAGE/);
});

test('thrown attempts retain safe failure codes and close both processes without storing provider error text', async () => {
  const h = await harness({ hooks: { translate: () => { throw error('appserver_turn_timeout'); } } });
  const result = await runTailBenchmark(h.options), saved = await h.saved();
  assert.equal(result.attempted, 1); assert.equal(result.translation_calls, 1); assert.equal(result.failed, 1); assert.equal(result.not_run, 119);
  assert.equal(result.fatal_code, 'appserver_turn_timeout'); assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROVIDER_ERROR/);
  assert.deepEqual(h.clients.map(client => client.closes), [1, 1]);
});

test('second-client startup failure closes an already created first client before any translation', async () => {
  const h = await harness({ hooks: { create: ({ arm }) => { if (arm === 'candidate') {
    const failure = error('appserver_config_not_isolated'); failure.diagnostics = { process: { closed: false }, private: 'PRIVATE_STARTUP_TOKEN' }; throw failure;
  } } } });
  const result = await runTailBenchmark(h.options), saved = await h.saved();
  assert.equal(result.attempted, 0); assert.equal(result.translation_calls, 0); assert.equal(result.not_run, 120);
  assert.equal(result.fatal_code, 'appserver_config_not_isolated'); assert.equal(h.clients[0].closes, 1);
  assert.equal(saved.manifest.startup_failure.failed_client_process_closed, false);
  assert.ok(saved.results.every(row => row.outcome === 'not_run')); assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROVIDER_ERROR|PRIVATE_STARTUP_TOKEN/);
});

test('catalog or resolved-thread effort mismatches fail before inference without silently changing effort', async () => {
  for (const hooks of [{ effort: 'high' }, { threadEffort: 'high' }]) {
    const h = await harness({ hooks }), result = await runTailBenchmark(h.options);
    assert.equal(result.translation_calls, 0); assert.equal(result.successful, 0);
    assert.equal(result.fatal_code, hooks.effort ? 'tail_catalog_effort_mismatch' : 'tail_thread_configuration_mismatch');
    assert.ok(h.clients.every(client => client.closes === 1));
  }
});

test('invalid JSON fields, terminal status or request fingerprint cannot count as successful bilingual completion', async () => {
  for (const resultHook of [value => { value.translation.extra = 'invented'; }, value => { value.terminal_event = 'turn/failed'; },
    value => { value.telemetry.request.prompt_sha256 = 'wrong'; }, value => { value.telemetry.request.instructions_sha256 = 'wrong'; }]) {
    const h = await harness({ count: 2, hooks: { result: resultHook } }), result = await runTailBenchmark(h.options);
    assert.equal(result.failed, 1); assert.equal(result.successful, 0); assert.equal(result.translation_calls, 1); assert.equal(result.not_run, 7);
    assert.equal(h.calls(), 1); assert.ok(h.clients.every(client => client.closes === 1));
  }
});

test('unconfirmed or throwing close is recorded while still attempting the other owned process close', async () => {
  const h = await harness({ count: 2, hooks: { close: ({ arm }) => { if (arm === 'baseline') throw error('private_should_not_persist');
    return { closed: false, termination_confirmed: false, exit_code: null }; } } });
  const result = await runTailBenchmark(h.options), saved = await h.saved();
  assert.equal(result.successful, 8); assert.equal(result.fatal_code, 'tail_server_close_unconfirmed');
  assert.deepEqual(h.clients.map(client => client.closes), [1, 1]); assert.equal(saved.manifest.arms.baseline.close.termination_confirmed, false);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROVIDER_ERROR|private_should_not_persist/);
});

test('a poisoned close status is fatal even after a confirmed zero exit, without erasing completed translations', async () => {
  const h = await harness({ count: 2, hooks: { close: ({ arm }) => ({ closed: true, termination_confirmed: true,
    exit_code: 0, unusable_code: arm === 'baseline' ? 'appserver_unknown_notification' : null }) } });
  const result = await runTailBenchmark(h.options), saved = await h.saved();
  assert.equal(result.fatal_code, 'appserver_unknown_notification'); assert.equal(result.successful, 8);
  assert.ok(saved.results.every(row => row.outcome === 'completed' && row.translation)); assert.deepEqual(h.clients.map(client => client.closes), [1, 1]);
});

test('cancellation retains the finished result and leaves remaining samples unattempted with owned clients closed', async () => {
  const h = await harness(), controller = new AbortController();
  const result = await runTailBenchmark({ ...h.options, signal: controller.signal, onProgress: () => controller.abort() });
  const saved = await h.saved(); assert.equal(result.successful, 1); assert.equal(result.not_run, 119); assert.equal(result.fatal_code, 'tail_benchmark_cancelled');
  assert.equal(saved.results[0].outcome, 'completed'); assert.ok(h.clients.every(client => client.closes === 1));
});

test('formal fixture count and protocol options are validated before invoking any client or login', async () => {
  const h = await harness({ count: 2 }); let logins = 0;
  await assert.rejects(() => runTailBenchmark({ ...h.options, allowSmallFixtureSet: false, loginCheck: async () => { logins++; } }), /tail_fixture_count_mismatch/);
  await assert.rejects(() => runTailBenchmark({ ...h.options, serviceTier: 'default' }), /invalid_tail_benchmark_options/);
  await assert.rejects(() => runTailBenchmark({ ...h.options, maxTurnsPerThread: 4 }), /invalid_tail_benchmark_options/);
  await assert.rejects(() => runTailBenchmark({ ...h.options, candidatePromptStyle: 'unknown' }), /invalid_tail_benchmark_options/);
  assert.equal(h.clients.length, 0); assert.equal(logins, 0);
});

test('source-only arm permits identical frozen instructions and changes only the expected user-prompt serialization', async () => {
  const h = await harness({ count: 2 });
  await writeFile(h.options.fixturePath, JSON.stringify({ fixtures: h.fixtures.map(fixture => ({ ...fixture,
    request_fingerprint: { prompt_sha256: hash(codexTranslationPrompt({ fixture, glossary: [] })) } })) }));
  const result = await runTailBenchmark({ ...h.options, candidateInstructionsFile: h.options.baselineInstructionsFile, candidatePromptStyle: 'source_only' });
  const saved = await h.saved();
  assert.equal(result.successful, 8); assert.equal(result.fatal_code, null);
  assert.deepEqual(h.clients.map(client => client.config.promptStyle), ['full', 'source_only']);
  assert.equal(saved.manifest.arms.baseline.instructions_sha256, saved.manifest.arms.candidate.instructions_sha256);
  for (const fixture of h.fixtures) {
    const projected = { id: fixture.id, ja: fixture.ja, context: fixture.context };
    const sourceOnly = JSON.stringify({ ja: fixture.ja, context: fixture.context, glossary: [] });
    const parsed = JSON.parse(sourceOnly); assert.deepEqual(parsed, { ja: fixture.ja, context: fixture.context, glossary: [] });
    assert.doesNotMatch(sourceOnly, /PRIVATE_REFERENCE|PRIVATE_CHECKPOINT/);
    const rows = saved.results.filter(row => row.case_id === fixture.id);
    assert.equal(new Set(rows.map(row => row.prompt_sha256)).size, 2);
    assert.ok(rows.filter(row => row.arm === 'baseline').every(row => row.prompt_style === 'full' && row.prompt_sha256 === hash(codexTranslationPrompt({ fixture: projected, glossary: [] }))));
    assert.ok(rows.filter(row => row.arm === 'candidate').every(row => row.prompt_style === 'source_only' && row.prompt_sha256 === hash(sourceOnly)));
    assert.equal(new Set(rows.map(row => row.ja_sha256)).size, 1); assert.equal(new Set(rows.map(row => row.context_sha256)).size, 1);
  }
});

test('identical instructions plus full/full is rejected and source-only response style/source mismatches cannot succeed', async () => {
  const equal = await harness({ count: 2 });
  await assert.rejects(() => runTailBenchmark({ ...equal.options, candidateInstructionsFile: equal.options.baselineInstructionsFile }), /invalid_tail_instruction_pair/);
  assert.equal(equal.clients.length, 0);
  for (const resultHook of [value => { value.telemetry.request.prompt_style = 'full'; }, value => { value.telemetry.request.ja_sha256 = 'wrong'; }]) {
    const h = await harness({ count: 2, hooks: { result: value => { if (value.telemetry.request.prompt_style === 'source_only') resultHook(value); } } });
    const result = await runTailBenchmark({ ...h.options, candidateInstructionsFile: h.options.baselineInstructionsFile, candidatePromptStyle: 'source_only' });
    assert.equal(result.successful, 1); assert.equal(result.failed, 1); assert.equal(result.not_run, 6);
    assert.equal(result.fatal_code, 'tail_sample_failed_no_retry'); assert.equal(h.calls(), 2);
    assert.ok(h.clients.every(client => client.closes === 1));
  }
});
