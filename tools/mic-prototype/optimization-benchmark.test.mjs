import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createOptimizationSchedule, createOptimizationSpawn, parseOptimizationThreadCaps, runOptimizationBenchmark } from './optimization-benchmark.mjs';
import { codexMonolingualTranslationPrompt } from './codex-app-server.mjs';
import { codexTranslationPrompt } from './codex-translation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(done => setImmediate(done));
const failure = code => Object.assign(new Error('PRIVATE_PROVIDER_ERROR'), { safeCode: code });
async function harness({ count = 6, profiles = ['baseline', 'parallel'], hooks = {} } = {}) {
  const scratch = await mkdtemp(resolve('.runtime/optimization-test-')), fixturePath = join(scratch, 'fixtures.json');
  const fixtures = Array.from({ length: count }, (_, index) => ({ id: 'C-' + index, ja: `三人ではなく二人です。${index}`,
    context: 'Speaker role ' + index, referenceZh: 'PRIVATE_REFERENCE', expected: 'PRIVATE_EXPECTATION' }));
  await writeFile(fixturePath, JSON.stringify({ fixtures }));
  const outputDirectory = join(scratch, 'results'), clients = [], seen = [], operations = [];
  let clock = 0, active = 0, peak = 0, calls = 0, sequence = 0;
  const options = { executable: 'C:/fake/codex.exe', fixturePath, outputDirectory, cwd: join(scratch, 'work'), profiles,
    allowSmallFixtureSet: ![30, 60].includes(count), now: () => clock, closeDeadlineMs: 20,
    loginCheck: async () => { await access(join(outputDirectory, 'manifest.json')); return { loggedIn: true, authMode: 'chatgpt' }; },
    spawnImpl: (...args) => ({ invocation: args }),
    createServer: async config => {
      const target = config.translationTarget, ordinal = clients.length;
      await access(join(outputDirectory, 'schedule.json')); await access(join(outputDirectory, 'fixtures.source-only.json'));
      if (hooks.create) await hooks.create({ config, ordinal });
      const instructionsSha256 = hash(await readFile(config.instructionsFile)); clock += 10;
      const client = { config, target, ordinal, closes: 0, starts: [], releases: [], turns: [], startupMs: 10,
        diagnostics: () => ({ alignment: { explicit_process_effort: hooks.effort ?? 'low', model_catalog_default_effort: 'low' } }),
        async startThread() {
          clock += 20; const threadId = 'thread-' + (++sequence); client.starts.push(threadId); operations.push(['start', ordinal]);
          if (hooks.start) await hooks.start({ config, target, ordinal, threadId });
          return { threadId, setupMs: 20, telemetry: { observed: { model: 'gpt-6.1-sol', reasoningEffort: hooks.threadEffort ?? 'low', serviceTier: 'priority' } } };
        },
        async releaseThread(threadId) { clock += 3; client.releases.push(threadId); operations.push(['release', ordinal]); return { released: true }; },
        async translate(args) {
          calls++; active++; peak = Math.max(peak, active); const index = calls, started = clock;
          client.turns.push(args); seen.push({ target, ordinal, ...args }); operations.push(['invoke', ordinal, index]);
          const duration = target === 'bilingual' ? 200 : target === 'zh' ? 100 : 180;
          try {
            if (hooks.translate) { const override = await hooks.translate({ config, args, target, ordinal, index }); if (override !== undefined) return override; }
            await tick(); clock = Math.max(clock, started + duration);
            const prompt = target === 'bilingual' ? codexTranslationPrompt(args) : codexMonolingualTranslationPrompt({ ...args, translationTarget: target });
            const result = { model: 'gpt-6.1-sol', success: true, terminal_event: 'turn/completed', final_status: 'completed',
              translation: target === 'bilingual' ? { zh: '中文 ' + args.fixture.id, en: 'English ' + args.fixture.id } : { [target]: target + ' ' + args.fixture.id },
              timings_ms: { completed: duration, first_nonempty_delta: duration - 50,
                [target === 'bilingual' ? 'bilingual_json_ready' : 'translation_json_ready']: duration - 10 },
              usage: { input_tokens: 6000, output_tokens: 40, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
              telemetry: { process_reusable: true, request: { model: 'gpt-6.1-sol', requested_service_tier: 'fast',
                resolved_thread_model: 'gpt-6.1-sol', resolved_thread_service_tier: 'priority', resolved_thread_reasoning_effort: 'low', model_default_reasoning_effort: 'low',
                translation_target: target, prompt_style: 'full', prompt_sha256: hash(prompt), prompt_bytes: Buffer.byteLength(prompt),
                ja_sha256: hash(args.fixture.ja), instructions_sha256: instructionsSha256 } } };
            if (hooks.result) hooks.result(result, { target, ordinal, index }); return result;
          } finally { active--; operations.push(['settled', ordinal, index]); }
        },
        async close() {
          assert.equal(active, 0); client.closes++; operations.push(['close', ordinal]);
          if (hooks.close) return hooks.close({ ordinal, target });
          return { closed: true, termination_confirmed: true, exit_code: 0, exit_signal: null, unusable_code: null };
        } };
      clients.push(client); return client;
    } };
  return { options, fixtures, clients, seen, operations, scratch, calls: () => calls, peak: () => peak,
    saved: async () => JSON.parse(await readFile(join(outputDirectory, 'results.json'), 'utf8')) };
}

test('balanced multi-profile schedule rotates case order, reverses complete second block and declares differing history caps', () => {
  const fixtures = Array.from({ length: 7 }, (_, index) => ({ id: 'C-' + index })), profiles = ['baseline', 'excluded', 'reuse6', 'parallel'];
  const schedule = createOptimizationSchedule(fixtures, profiles), first = schedule.slice(0, 28), second = schedule.slice(28);
  assert.deepEqual(first.slice(0, 4).map(row => row.profile), profiles);
  assert.deepEqual(first.slice(4, 8).map(row => row.profile), ['excluded', 'reuse6', 'parallel', 'baseline']);
  assert.deepEqual(second.map(({ case_id, profile }) => ({ case_id, profile })), first.map(({ case_id, profile }) => ({ case_id, profile })).reverse());
  for (const block of [1, 2]) for (const profile of profiles) {
    const cap = profile === 'reuse6' ? 6 : 3;
    assert.deepEqual(schedule.filter(row => row.block === block && row.profile === profile).map(row => row.expected_prior_successful_turns_in_thread),
      fixtures.map((_, index) => index % cap));
  }
});

test('namespace exclusion prepends only its per-process override and leaves original spawn data intact', () => {
  const calls = [], spawnImpl = (...args) => { calls.push(args); return 'child'; }, args = ['--strict-config', '-c', 'model="gpt-6.1-sol"', 'app-server'];
  const options = { shell: false, windowsHide: true, env: { KEEP: 'same' } };
  assert.equal(createOptimizationSpawn('baseline', spawnImpl), spawnImpl); assert.equal(createOptimizationSpawn('parallel', spawnImpl), spawnImpl);
  assert.equal(createOptimizationSpawn('excluded', spawnImpl)('codex.exe', args, options), 'child');
  assert.deepEqual(calls[0], ['codex.exe', ['-c', 'features.code_mode.excluded_tool_namespaces=["functions"]', ...args], options]);
  assert.deepEqual(args, ['--strict-config', '-c', 'model="gpt-6.1-sol"', 'app-server']);
});

test('four-profile mock freezes evidence before login, caps threads, keeps serial parents and sends only source fields', async () => {
  const h = await harness({ profiles: ['baseline', 'excluded', 'reuse6', 'parallel'] });
  const summary = await runOptimizationBenchmark(h.options), saved = await h.saved();
  assert.equal(summary.scheduled, 48); assert.equal(summary.successful, 48); assert.equal(summary.translation_calls, 60); assert.equal(summary.fatal_code, null);
  assert.equal(h.clients.length, 5); assert.equal(h.peak(), 2); assert.deepEqual(h.clients.map(client => client.starts.length), [4, 4, 2, 4, 4]);
  assert.deepEqual(h.clients.map(client => client.releases.length), [3, 3, 1, 3, 3]); assert.ok(h.clients.every(client => client.closes === 1));
  assert.ok(h.seen.every(row => Object.keys(row.fixture).sort().join(',') === 'context,id,ja' && row.glossary.length === 0));
  assert.doesNotMatch(JSON.stringify(h.seen), /PRIVATE_REFERENCE|PRIVATE_EXPECTATION/);
  assert.doesNotMatch(await readFile(join(h.options.outputDirectory, 'fixtures.source-only.json'), 'utf8'), /PRIVATE_REFERENCE|PRIVATE_EXPECTATION/);
  assert.equal(saved.manifest.profiles.excluded.excluded_functions_namespace_requested, true);
  assert.equal(saved.manifest.profiles.excluded.excluded_functions_namespace_independently_observed, null);
  assert.equal(saved.manifest.parent_concurrency, 1); assert.equal(saved.manifest.maximum_branch_concurrency, 2);
  assert.ok(saved.results.every(row => row.branches.every(branch => branch.actual_prior_successful_turns_in_thread === row.expected_prior_successful_turns_in_thread)));
  for (const client of h.clients) {
    assert.equal(client.config.model.slug, 'gpt-6.1-sol'); assert.equal(client.config.serviceTier, 'fast'); assert.equal(client.config.promptStyle, 'full');
    assert.equal(basename(client.config.instructionsFile), client.target === 'bilingual' ? 'translation-base.md' : `translation-${client.target}.md`);
  }
  const initial = JSON.parse(await readFile(join(h.options.outputDirectory, 'manifest.json'), 'utf8'));
  assert.equal('finished_at' in initial, false); assert.equal(initial.scheduled_samples, 48);
  const progress = JSON.parse(await readFile(join(h.options.outputDirectory, 'progress.json'), 'utf8')); assert.equal(progress.finished_samples, 48);
  const events = (await readFile(join(h.options.outputDirectory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'benchmark_finished');
});

test('parallel parent ends at the slower complete language, keeps individual milestones and merges only both strict outputs', async () => {
  const h = await harness({ count: 2 }), summary = await runOptimizationBenchmark(h.options), saved = await h.saved();
  assert.equal(summary.successful, 8); assert.equal(summary.translation_calls, 12);
  for (const row of saved.results.filter(row => row.profile === 'parallel')) {
    assert.equal(row.dispatch_to_bilingual_ms, 180); assert.equal(row.strict_transport_completed_ms, 180);
    assert.deepEqual(row.branches.map(branch => branch.dispatch_offset_ms), [0, 0]);
    assert.deepEqual(row.branches.map(branch => branch.returned_offset_ms), [100, 180]);
    assert.deepEqual(row.translation, { zh: 'zh ' + row.case_id, en: 'en ' + row.case_id });
    assert.ok(row.branches.every(branch => branch.result.terminal_event === 'turn/completed' && branch.target === branch.result.telemetry.request.translation_target));
    assert.ok(row.branches.every(branch => branch.result.timings_ms.translation_json_ready < branch.result.timings_ms.completed));
  }
  assert.ok(saved.results.filter(row => row.profile === 'baseline').every(row => row.dispatch_to_bilingual_ms === 200));
});

test('one failed language awaits the admitted other branch before closing and cannot become successful bilingual output', async () => {
  const h = await harness({ count: 2, profiles: ['parallel', 'baseline'], hooks: { translate: async ({ target }) => {
    if (target === 'zh') return { success: false, error: { code: 'appserver_turn_timeout', message: 'PRIVATE_PROVIDER_ERROR' } };
    if (target === 'en') { await tick(); await tick(); }
  } } });
  const summary = await runOptimizationBenchmark(h.options), saved = await h.saved();
  assert.equal(summary.attempted, 1); assert.equal(summary.failed, 1); assert.equal(summary.successful, 0); assert.equal(summary.not_run, 7);
  assert.equal(summary.translation_calls, 2); assert.equal(h.calls(), 2); assert.ok(h.clients.every(client => client.closes === 1));
  assert.equal(saved.results[0].translation, null); assert.equal(saved.results[0].branches[0].success, false); assert.equal(saved.results[0].branches[1].success, true);
  assert.equal(saved.results[0].branches[0].error.code, 'appserver_turn_timeout');
  assert.ok(saved.results.slice(1).every(row => row.outcome === 'not_run' && !row.attempted));
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROVIDER_ERROR/);
  const firstClose = h.operations.findIndex(row => row[0] === 'close'), lastSettle = h.operations.findLastIndex(row => row[0] === 'settled'); assert.ok(firstClose > lastSettle);
});

test('thrown branch timeout is retained without retry while its other language still settles', async () => {
  const h = await harness({ count: 2, profiles: ['parallel'], hooks: { translate: ({ target }) => { if (target === 'en') throw failure('appserver_turn_timeout'); } } });
  const summary = await runOptimizationBenchmark(h.options), saved = await h.saved();
  assert.equal(summary.failed, 1); assert.equal(summary.not_run, 3); assert.equal(summary.translation_calls, 2);
  assert.equal(saved.results[0].branches[0].success, true); assert.equal(saved.results[0].branches[1].error.code, 'appserver_turn_timeout');
  assert.ok(h.clients.every(client => client.closes === 1)); assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROVIDER_ERROR/);
});

test('invalid target fields, terminals, effort, tier and every request fingerprint fail closed', async () => {
  const mutations = [value => { value.translation.en = 'extra'; }, value => { value.translation = { en: 'wrong target' }; },
    value => { value.translation.zh = ' '; }, value => { value.terminal_event = 'turn/failed'; }, value => { value.final_status = 'failed'; },
    value => { value.model = 'other'; }, value => { value.telemetry.request.resolved_thread_reasoning_effort = 'high'; },
    value => { value.telemetry.request.resolved_thread_service_tier = 'default'; }, value => { value.telemetry.request.prompt_sha256 = 'wrong'; },
    value => { value.telemetry.request.prompt_bytes++; }, value => { value.telemetry.request.ja_sha256 = 'wrong'; },
    value => { value.telemetry.request.instructions_sha256 = 'wrong'; }, value => { value.telemetry.request.translation_target = 'en'; },
    value => { value.timings_ms.translation_json_ready = 999; }, value => { value.telemetry.process_reusable = false; }];
  for (const mutate of mutations) {
    const h = await harness({ count: 2, profiles: ['parallel'], hooks: { result: (value, { target }) => { if (target === 'zh') mutate(value); } } });
    const summary = await runOptimizationBenchmark(h.options);
    assert.equal(summary.failed, 1); assert.equal(summary.successful, 0); assert.equal(summary.not_run, 3); assert.equal(summary.translation_calls, 2);
  }
});

test('catalog and resolved thread mismatch stop before translation and close all created clients', async () => {
  for (const hooks of [{ effort: 'high' }, { threadEffort: 'high' }]) {
    const h = await harness({ count: 2, hooks }), summary = await runOptimizationBenchmark(h.options);
    assert.equal(summary.translation_calls, 0); assert.equal(summary.successful, 0);
    assert.equal(summary.fatal_code, hooks.effort ? 'optimization_catalog_effort_mismatch' : 'optimization_thread_configuration_mismatch');
    assert.ok(h.clients.every(client => client.closes === 1));
  }
});

test('startup failure preserves the entire planned denominator and closes previously owned clients', async () => {
  const h = await harness({ count: 2, hooks: { create: ({ ordinal }) => { if (ordinal === 1) throw failure('appserver_config_not_isolated'); } } });
  const summary = await runOptimizationBenchmark(h.options), saved = await h.saved();
  assert.equal(summary.attempted, 0); assert.equal(summary.not_run, 8); assert.equal(summary.translation_calls, 0); assert.equal(h.clients[0].closes, 1);
  assert.equal(saved.manifest.startup_failure.target, 'zh'); assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROVIDER_ERROR/);
});

test('bounded close records unconfirmed hung or thrown clients and still closes every other process', async () => {
  for (const mode of ['hung', 'throw', 'nonzero', 'poison']) {
    const h = await harness({ count: 1, hooks: { close: ({ ordinal }) => {
      if (ordinal === 0) {
        if (mode === 'hung') return new Promise(() => {});
        if (mode === 'throw') throw failure('PRIVATE_CLOSE');
        return { closed: true, termination_confirmed: true, exit_code: mode === 'nonzero' ? 1 : 0, unusable_code: mode === 'poison' ? 'appserver_unknown_notification' : null };
      }
      return { closed: true, termination_confirmed: true, exit_code: 0, unusable_code: null };
    } } });
    const summary = await runOptimizationBenchmark(h.options), saved = await h.saved();
    assert.equal(summary.successful, 4); assert.ok(h.clients.every(client => client.closes === 1));
    assert.equal(summary.fatal_code, mode === 'nonzero' ? 'optimization_close_nonzero' : mode === 'poison' ? 'appserver_unknown_notification' : 'optimization_close_unconfirmed');
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_CLOSE|PRIVATE_PROVIDER_ERROR/);
  }
});

test('cancellation occurs between serial parents, retaining the completed one and closing all processes', async () => {
  const h = await harness({ count: 2 }), controller = new AbortController();
  const summary = await runOptimizationBenchmark({ ...h.options, signal: controller.signal, onProgress: () => controller.abort() });
  assert.equal(summary.successful, 1); assert.equal(summary.not_run, 7); assert.equal(summary.fatal_code, 'optimization_cancelled');
  assert.ok(h.clients.every(client => client.closes === 1));
});

test('formal count accepts 30 and 60 independent sources without small labeling; other counts require explicit override', async () => {
  for (const count of [30, 60]) {
    const h = await harness({ count, profiles: ['baseline'] }), summary = await runOptimizationBenchmark(h.options), saved = await h.saved();
    assert.equal(summary.successful, count * 2); assert.equal(saved.manifest.small_fixture_set, false); assert.equal(saved.manifest.allow_small_fixture_set, false);
  }
  const h = await harness({ count: 2 }); let logins = 0;
  await assert.rejects(() => runOptimizationBenchmark({ ...h.options, allowSmallFixtureSet: false, loginCheck: async () => { logins++; } }), /optimization_fixture_count_mismatch/);
  for (const profiles of [[], ['baseline', 'baseline'], ['unknown'], null]) await assert.rejects(() => runOptimizationBenchmark({ ...h.options, profiles }), /invalid_optimization_options/);
  assert.equal(logins, 0); assert.equal(h.clients.length, 0);
});

test('fixture fingerprint mismatches fail before login and existing output is never overwritten', async () => {
  const h = await harness({ count: 2 });
  await writeFile(h.options.fixturePath, JSON.stringify({ fixtures: h.fixtures.map(value => ({ ...value, request_fingerprint: { prompt_sha256: 'wrong' } })) }));
  await assert.rejects(() => runOptimizationBenchmark(h.options), /optimization_source_fingerprint_mismatch/); assert.equal(h.clients.length, 0);
  const second = await harness({ count: 1 }); await runOptimizationBenchmark(second.options);
  const before = await readFile(join(second.options.outputDirectory, 'results.json'));
  await assert.rejects(() => runOptimizationBenchmark(second.options), error => error.code === 'EEXIST');
  assert.deepEqual(await readFile(join(second.options.outputDirectory, 'results.json')), before);
});

test('explicit cap 30 controls schedule, rotation and manifest for 60-source formal combined-profile comparison', async () => {
  const profiles = ['baseline', 'parallel_excluded'], threadCapOverrides = { baseline: 30, parallel_excluded: 30 };
  const h = await harness({ count: 60, profiles }), summary = await runOptimizationBenchmark({ ...h.options, threadCapOverrides }), saved = await h.saved();
  assert.equal(summary.successful, 240); assert.equal(summary.translation_calls, 360); assert.equal(summary.fatal_code, null);
  assert.equal(saved.manifest.small_fixture_set, false); assert.equal(saved.manifest.maximum_branch_concurrency, 2);
  assert.deepEqual(saved.manifest.profile_caps, threadCapOverrides); assert.deepEqual(saved.manifest.thread_cap_overrides, threadCapOverrides);
  assert.deepEqual(h.clients.map(client => client.starts.length), [4, 4, 4]); assert.deepEqual(h.clients.map(client => client.releases.length), [3, 3, 3]);
  assert.equal(saved.manifest.profiles.parallel_excluded.excluded_functions_namespace_requested, true);
  assert.equal(saved.manifest.profiles.parallel_excluded.excluded_functions_namespace_independently_observed, null);
  assert.ok(saved.results.every(row => row.max_successful_turns_per_thread === 30 && row.success && row.branches.every(branch => branch.actual_prior_successful_turns_in_thread === row.expected_prior_successful_turns_in_thread)));
  for (const block of [1, 2]) for (const profile of profiles) {
    assert.deepEqual(saved.results.filter(row => row.block === block && row.profile === profile).map(row => row.expected_prior_successful_turns_in_thread),
      Array.from({ length: 60 }, (_, index) => index % 30));
  }
  for (const client of h.clients.filter(value => value.target !== 'bilingual')) {
    const launched = client.config.spawnImpl('codex.exe', ['app-server'], { shell: false });
    assert.deepEqual(launched.invocation[1], ['-c', 'features.code_mode.excluded_tool_namespaces=["functions"]', 'app-server']);
    assert.equal(client.turns.length, 120); assert.ok(client.closes === 1);
  }
  assert.ok(saved.results.filter(row => row.profile === 'parallel_excluded').every(row => row.translation.zh && row.translation.en && row.branches.length === 2));
});

test('omitted cap overrides keep original default caps and explicit partial overrides affect only the selected profile', () => {
  const fixtures = Array.from({ length: 7 }, (_, index) => ({ id: 'C-' + index }));
  const defaults = createOptimizationSchedule(fixtures, ['baseline', 'parallel', 'reuse6', 'parallel_excluded']);
  assert.ok(defaults.every(row => row.max_successful_turns_per_thread === (row.profile === 'reuse6' ? 6 : 3)));
  const partial = createOptimizationSchedule(fixtures, ['baseline', 'parallel_excluded'], { baseline: 30 });
  assert.ok(partial.filter(row => row.profile === 'baseline').every(row => row.max_successful_turns_per_thread === 30));
  assert.ok(partial.filter(row => row.profile === 'parallel_excluded').every(row => row.max_successful_turns_per_thread === 3));
  assert.deepEqual(parseOptimizationThreadCaps('baseline=30,parallel_excluded=30'), { baseline: 30, parallel_excluded: 30 });
});

test('invalid caps, unknown or unselected profiles and malformed CLI overrides reject before login or clients', async () => {
  const h = await harness({ count: 2 }); let logins = 0;
  for (const threadCapOverrides of [null, [], { baseline: 0 }, { baseline: 31 }, { baseline: 1.5 }, { baseline: '30' },
    { baseline: NaN }, { excluded: 30 }, { unknown: 3 }, { [Symbol('private')]: 30 }]) {
    await assert.rejects(() => runOptimizationBenchmark({ ...h.options, threadCapOverrides, loginCheck: async () => { logins++; } }), /invalid_optimization_thread_caps/);
  }
  for (const text of ['', 'baseline=', 'baseline=0', 'baseline=31', 'baseline=1.5', 'baseline=30,baseline=3', 'baseline=30,', '=3', 'baseline=Infinity']) {
    assert.throws(() => parseOptimizationThreadCaps(text), /invalid_optimization_thread_caps/);
  }
  assert.equal(logins, 0); assert.equal(h.clients.length, 0);
});

test('abort during branch setup prevents all subsequent model dispatch while retaining an attempted failed parent', async () => {
  const controller = new AbortController();
  const h = await harness({ count: 2, profiles: ['parallel_excluded', 'baseline'], hooks: { start: ({ target }) => { if (target === 'zh') controller.abort(); } } });
  const summary = await runOptimizationBenchmark({ ...h.options, signal: controller.signal }), saved = await h.saved();
  assert.equal(summary.attempted, 1); assert.equal(summary.failed, 1); assert.equal(summary.successful, 0); assert.equal(summary.not_run, 7);
  assert.equal(summary.translation_calls, 0); assert.equal(h.calls(), 0); assert.equal(summary.fatal_code, 'optimization_cancelled');
  assert.equal(saved.results[0].translation_invoked, false); assert.equal(saved.results[0].error.code, 'optimization_cancelled');
  assert.ok(saved.results[0].branches.every(branch => !branch.invoked)); assert.ok(h.clients.every(client => client.closes === 1));
});
