import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexResidentPool } from './codex-resident.mjs';

const options = { executable: 'C:/test/codex.exe', cwd: 'C:/empty-cli-work', instructionsFile: 'C:/translation-base.md',
  model: { slug: 'gpt-6.1-sol' }, serviceTier: 'fast' };
const fixture = { id: 'source-1', ja: '三人ではなく二人です。', context: 'Current speaker context.' };
const glossary = [{ ja: '配信', zh: '直播', en: 'stream' }];
const translation = { zh: '不是三个人，是两个人。', en: 'There are two people, not three.' };
const success = (model = 'gpt-6.1-sol') => ({ success: true, terminal_event: 'turn/completed', translation, error: null, timings_ms: { completed: 12, total: 13 },
  telemetry: { process_reusable: true, request: { model, requested_service_tier: 'fast', instructions_sha256: 'a'.repeat(64), instructions_mode: 'full_base_instructions' } } });
const tick = () => new Promise(done => setImmediate(done));
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function failure(code) { return Object.assign(new Error('private-error-text'), { safeCode: code }); }
function fakeFactory(hooks = {}) {
  const clients = [], factoryCalls = [], events = [];
  async function createClientImpl(value) {
    const index = factoryCalls.push(value);
    if (hooks.create) await hooks.create(index);
    const client = { index, starts: [], startOptions: [], releases: [], turns: [], closes: 0, busy: false, startupMs: 2,
      async startThread(startOptions) {
        client.startOptions.push(startOptions);
        events.push(['start', index]);
        if (hooks.start) await hooks.start(index, client);
        const threadId = 'private-native-thread-' + index + '-' + (client.starts.length + 1);
        client.starts.push(threadId); return { threadId, setupMs: 1, telemetry: { instructions_sha256: 'a'.repeat(64), instructions_bytes: 2048, instructions_mode: 'full_base_instructions' } };
      },
      async releaseThread(threadId) { events.push(['release', index]); client.releases.push(threadId); if (hooks.release) await hooks.release(index); return { released: true }; },
      async translate(args) {
        assert.equal(client.busy, false, 'one serial client must never receive overlapping turns');
        client.busy = true; client.turns.push(args); events.push(['translate', index]);
        try { return hooks.translate ? await hooks.translate(index, args, client) : success(value.model.slug); }
        finally { client.busy = false; }
      },
      async close() {
        assert.equal(client.busy, false, 'pool close must drain admitted turns');
        client.closes++; events.push(['close', index]);
        return hooks.close ? await hooks.close(index, client) : { closed: true, termination_confirmed: true, exit_code: 0, exit_signal: null, unusable_code: null };
      },
      diagnostics() { return { transport: 'codex_app_server', startup_ms: 2, stdout_bytes: 40, stderr_bytes: 0, open_threads: 1,
        unusable_code: null, config_isolation: 'explicit_overrides_only', instructions_sha256: 'a'.repeat(64), instructions_bytes: 2048, instructions_mode: 'full_base_instructions',
        config: { safe_to_start_thread: true, model_matches: true, mcp_server_count: 2, mcp_enabled_server_count: 0,
          critical_non_mcp_controls_verified: true, config_reasoning_effort: 'low', requested_service_tier: 'fast', private: 'private-config-secret' },
        alignment: { inherited_config_effort: 'ultra', model_catalog_default_effort: 'low', explicit_process_effort: 'low', configured_mcp_count: 2, per_server_disable_count: 2 },
        process: { closed: client.closes > 0, exit_code: client.closes ? 0 : null, exit_signal: null },
        threadId: 'private-native-thread', arbitrary: 'private-diagnostic-secret' }; },
    };
    clients.push(client); return client;
  }
  return { clients, factoryCalls, events, createClientImpl };
}

test('startup owns one thread per isolated lane and forwards unchanged model, tier, source and glossary', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, concurrency: 2, createClientImpl: fake.createClientImpl });
  try {
    assert.equal(fake.clients.length, 2); assert.deepEqual(fake.events, [['start', 1], ['start', 2]]);
    for (const value of fake.factoryCalls) {
      assert.equal(value.executable, options.executable); assert.equal(value.cwd, options.cwd);
      assert.equal(value.instructionsFile, options.instructionsFile); assert.deepEqual(value.model, options.model);
      assert.equal(value.serviceTier, 'fast'); assert.equal(value.promptStyle, 'full'); assert.equal('effort' in value, false);
    }
    const first = await pool.translate({ fixture, glossary }), second = await pool.translate({ fixture, glossary });
    assert.equal(first.success, true); assert.equal(first.translation, translation); assert.equal(first.timings_ms.completed, 12);
    assert.equal(first.telemetry.resident.lane, 1); assert.equal(second.telemetry.resident.lane, 2);
    assert.equal(first.telemetry.resident.turn_index, 1); assert.equal(first.telemetry.resident.rotation, null);
    assert.equal(fake.clients[0].turns[0].fixture, fixture); assert.equal(fake.clients[0].turns[0].glossary, glossary);
    assert.equal(pool.diagnostics().lanes[0].client.config.mcp_enabled_server_count, 0);
    assert.equal(pool.diagnostics().prompt_style, 'full');
    assert.doesNotMatch(JSON.stringify(pool.diagnostics()), /private-native|private-config|private-diagnostic|三人/);
  } finally { assert.equal((await pool.close()).termination_confirmed, true); }
});

test('two admitted lanes run concurrently, excess calls reject immediately, and close drains both before process exit', async () => {
  const holds = [deferred(), deferred()], fake = fakeFactory({ translate: index => holds[index - 1].promise });
  const pool = await createCodexResidentPool({ ...options, concurrency: 2, createClientImpl: fake.createClientImpl });
  const first = pool.translate({ fixture }), second = pool.translate({ fixture }); await tick();
  assert.equal(pool.diagnostics().in_flight, 2); assert.equal(fake.clients[0].busy, true); assert.equal(fake.clients[1].busy, true);
  await assert.rejects(() => pool.translate({ fixture }), /resident_pool_busy/);
  const closing = pool.close(); assert.equal(pool.close(), closing);
  await assert.rejects(() => pool.translate({ fixture }), /resident_pool_closed/);
  holds[1].resolve(success()); await second; await tick();
  assert.deepEqual(fake.clients.map(client => client.closes), [0, 0]);
  holds[0].resolve(success()); await first;
  assert.equal((await closing).closed, true); assert.deepEqual(fake.clients.map(client => client.closes), [1, 1]);
  assert.equal(pool.diagnostics().in_flight, 0); assert.equal(pool.diagnostics().state, 'closed');
});

test('thread and process turn caps rotate before the next dispatch without retrying or retaining unbounded thread maps', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, maxTurnsPerThread: 2, maxTurnsPerProcess: 5, createClientImpl: fake.createClientImpl });
  try {
    const outputs = [];
    for (let index = 0; index < 6; index++) outputs.push(await pool.translate({ fixture: { ...fixture, id: String(index) } }));
    assert.deepEqual(outputs.map(value => value.telemetry.resident.rotation), [null, null, 'thread_turn_limit', null, 'thread_turn_limit', 'process_turn_limit']);
    assert.deepEqual(outputs.map(value => value.telemetry.resident.turn_index), [1, 2, 1, 2, 1, 1]);
    assert.deepEqual(outputs.map(value => value.telemetry.resident.process_generation), [1, 1, 1, 1, 1, 2]);
    assert.deepEqual(outputs.map(value => value.telemetry.resident.thread_generation), [1, 1, 2, 2, 3, 4]);
    assert.equal(fake.clients[0].releases.length, 2); assert.equal(fake.clients[0].starts.length, 3); assert.equal(fake.clients[0].closes, 1);
    assert.equal(fake.clients[0].turns.length, 5); assert.equal(fake.clients[1].turns.length, 1);
    const lane = pool.diagnostics().lanes[0]; assert.equal(lane.total_turns, 6); assert.equal(lane.thread_rotations, 2); assert.equal(lane.process_rotations, 1);
    assert.ok(fake.events.findIndex(value => value[0] === 'close' && value[1] === 1) < fake.events.findIndex(value => value[0] === 'start' && value[1] === 2));
  } finally { await pool.close(); }
});

test('one failed turn stops future admission and automatically closes only after another admitted turn completes', async () => {
  const holds = [deferred(), deferred()], fake = fakeFactory({ translate: index => holds[index - 1].promise });
  const pool = await createCodexResidentPool({ ...options, concurrency: 2, createClientImpl: fake.createClientImpl });
  const first = pool.translate({ fixture }), second = pool.translate({ fixture }); await tick();
  holds[0].resolve({ ...success(), success: false, translation: null, error: { code: 'appserver_turn_timeout', message: 'appserver_turn_timeout' }, telemetry: { process_reusable: false } });
  const failed = await first; assert.equal(failed.error.code, 'appserver_turn_timeout'); assert.equal(failed.telemetry.resident.lane, 1);
  await assert.rejects(() => pool.translate({ fixture }), /appserver_turn_timeout/); await tick();
  assert.deepEqual(fake.clients.map(client => client.closes), [0, 0]);
  holds[1].resolve(success()); assert.equal((await second).success, true);
  const closed = await pool.close(); assert.equal(closed.unusable_code, 'appserver_turn_timeout'); assert.equal(closed.termination_confirmed, true);
  assert.equal(fake.clients.reduce((sum, client) => sum + client.turns.length, 0), 2);
});

test('failure while creating the second lane closes every already owned client and exposes only safe diagnostics', async () => {
  const fake = fakeFactory({ start: index => { if (index === 2) throw failure('appserver_config_not_isolated'); } });
  await assert.rejects(() => createCodexResidentPool({ ...options, concurrency: 2, createClientImpl: fake.createClientImpl }), error => {
    assert.equal(error.safeCode, 'appserver_config_not_isolated'); assert.equal(error.diagnostics.state, 'closed');
    assert.equal(error.diagnostics.termination_unconfirmed, false); assert.doesNotMatch(JSON.stringify(error.diagnostics), /private-error|private-native|private-config|private-diagnostic/); return true;
  });
  assert.deepEqual(fake.clients.map(client => client.closes), [1, 1]); assert.equal(fake.clients.some(client => client.turns.length), false);
});

test('unconfirmed process termination remains sticky and prevents replacement, future turns or successful-close claims', async () => {
  const fake = fakeFactory({ close: () => ({ closed: false, termination_confirmed: false, exit_code: null, exit_signal: null, unusable_code: null }) });
  const pool = await createCodexResidentPool({ ...options, maxTurnsPerProcess: 1, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture });
  await assert.rejects(() => pool.translate({ fixture }), /resident_process_exit_unconfirmed/);
  await assert.rejects(() => pool.translate({ fixture }), /resident_process_exit_unconfirmed/);
  const closed = await pool.close(); assert.equal(closed.termination_confirmed, false); assert.equal(closed.closed, false);
  assert.equal(pool.diagnostics().termination_unconfirmed, true); assert.equal(fake.factoryCalls.length, 1); assert.equal(fake.clients[0].turns.length, 1);
});

test('factory startup reports an unconfirmed child through nested safe lifecycle evidence without persisting its secrets', async () => {
  const fake = fakeFactory({ create: () => { const error = failure('appserver_setup_failed'); error.diagnostics = {
    process: { closed: true }, discovery_close: { termination_confirmed: false }, raw: 'private-token-value' }; throw error; } });
  await assert.rejects(() => createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl }), error => {
    assert.equal(error.safeCode, 'appserver_setup_failed'); assert.equal(error.diagnostics.termination_unconfirmed, true);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /private-token|private-error/); return true;
  });
  assert.equal(fake.clients.length, 0);
});

test('rotation release failures and thrown translation errors are not retried or allowed to poison later turns silently', async () => {
  for (const mode of ['release', 'translate']) {
    const fake = fakeFactory({ release: () => { if (mode === 'release') throw failure('appserver_invalid_unsubscribe'); },
      translate: () => { if (mode === 'translate') throw new Error('private-account-and-token'); return success(); } });
    const pool = await createCodexResidentPool({ ...options, maxTurnsPerThread: 1, createClientImpl: fake.createClientImpl });
    if (mode === 'release') await pool.translate({ fixture });
    await assert.rejects(() => pool.translate({ fixture }), error => {
      assert.equal(error.safeCode, mode === 'release' ? 'appserver_invalid_unsubscribe' : 'resident_translation_failed');
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /private-account|private-token|private-error/); return true;
    });
    await pool.close(); assert.equal(fake.factoryCalls.length, 1); assert.equal(fake.clients[0].turns.length, 1);
    await assert.rejects(() => pool.translate({ fixture }));
  }
});

test('invalid options fail before creating clients and invalid source does not poison an otherwise ready pool', async () => {
  for (const invalid of [{ concurrency: 3 }, { maxTurnsPerThread: 31 }, { maxTurnsPerProcess: 121 }, { maxTurnsPerThread: 0 },
    { model: null }, { model: { slug: '' } }, { model: { slug: 'bad model' } }, { model: { slug: '-bad' } },
    { serviceTier: 'other' }, { promptStyle: 'source-only' }, { promptStyle: null }, { timeoutMs: 0 }]) {
    const fake = fakeFactory();
    await assert.rejects(() => createCodexResidentPool({ ...options, ...invalid, createClientImpl: fake.createClientImpl }), /invalid_resident_pool_options/);
    assert.equal(fake.factoryCalls.length, 0);
  }
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  try {
    await assert.rejects(() => pool.translate({ fixture: { ja: ' ' } }), /invalid_resident_translation_options/);
    for (const model of [null, {}, { slug: '' }, { slug: 'bad model' }, { slug: 'x'.repeat(129) }])
      await assert.rejects(() => pool.translate({ fixture, model }), /invalid_resident_translation_options/);
    assert.equal(pool.diagnostics().unusable_code, null); assert.equal((await pool.translate({ fixture })).success, true);
  } finally { await pool.close(); }
});

test('source-only cannot silently simplify a resident subtitle session', async () => {
  const fake = fakeFactory();
  await assert.rejects(() => createCodexResidentPool({ ...options, promptStyle: 'source_only', createClientImpl: fake.createClientImpl }), /invalid_resident_pool_options/);
  assert.equal(fake.clients.length, 0);
});

test('A to B to A resumes each model original thread and keeps prompts fully enabled', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  try {
    const a1 = await pool.translate({ fixture }), b1 = await pool.translate({ fixture, model: { slug: 'gpt-6-luna' } });
    const a2 = await pool.translate({ fixture }), b2 = await pool.translate({ fixture, model: { slug: 'gpt-6-luna' } });
    assert.deepEqual(fake.factoryCalls.map(value => value.model.slug), ['gpt-6.1-sol', 'gpt-6-luna']);
    assert.deepEqual(fake.clients.map(client => client.turns.length), [2, 2]);
    assert.equal(fake.clients[0].turns[0].threadId, fake.clients[0].turns[1].threadId);
    assert.equal(fake.clients[1].turns[0].threadId, fake.clients[1].turns[1].threadId);
    assert.deepEqual([a1, b1, a2, b2].map(value => value.telemetry.resident.turn_index), [1, 1, 2, 2]);
    assert.deepEqual([a1, b1, a2, b2].map(value => value.telemetry.resident.model_cache_hit), [true, false, true, true]);
    assert.deepEqual([a1, b1, a2, b2].map(value => value.telemetry.resident.rotation), [null, 'model_cache_miss', null, null]);
    assert.deepEqual(fake.clients.map(client => client.closes), [0, 0]);
    assert.equal(pool.diagnostics().cached_model_count, 2);
    for (const value of fake.factoryCalls) { assert.equal(value.promptStyle, 'full'); assert.equal(value.reasoningPolicy, 'lowest_supported'); }
  } finally { assert.equal((await pool.close()).termination_confirmed, true); }
  assert.deepEqual(fake.clients.map(client => client.closes), [1, 1]);
});

test('model policies apply independently on cache return, with full instructions checked after all rotations', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, maxTurnsPerThread: 3,
    modelPolicies: { 'gpt-6-luna': { maxTurnsPerThread: 1, maxTurnsPerProcess: 2, reasoningEffort: 'low' } }, createClientImpl: fake.createClientImpl });
  try {
    await pool.translate({ fixture });
    const b1 = await pool.translate({ fixture, model: { slug: 'gpt-6-luna' } });
    await pool.translate({ fixture });
    const b2 = await pool.translate({ fixture, model: { slug: 'gpt-6-luna' } });
    const b3 = await pool.translate({ fixture, model: { slug: 'gpt-6-luna' } });
    assert.deepEqual([b1, b2, b3].map(value => value.telemetry.resident.rotation), ['model_cache_miss', 'thread_turn_limit', 'process_turn_limit']);
    assert.deepEqual([b1, b2, b3].map(value => value.telemetry.resident.turn_index), [1, 1, 1]);
    assert.deepEqual([b1, b2, b3].map(value => value.telemetry.resident.thread_generation), [1, 2, 3]);
    assert.equal(fake.clients[0].starts.length, 1); assert.equal(fake.clients[0].turns.length, 2);
    assert.equal(fake.factoryCalls[1].reasoningEffort, 'low'); assert.equal(fake.factoryCalls[2].reasoningEffort, 'low');
    assert.ok([b1, b2, b3].every(value => value.telemetry.resident.instructions_sha256 === 'a'.repeat(64)));
    assert.equal(pool.diagnostics().rotation_history.length, 3);
  } finally { await pool.close(); }
});

test('estimated context bytes rotate before a request, separately from actual thread usage token thresholds', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, maxContextBytes: 3600, createClientImpl: fake.createClientImpl });
  try {
    const first = await pool.translate({ fixture }), second = await pool.translate({ fixture });
    assert.equal(first.telemetry.resident.actual_thread_total_tokens, null);
    assert.equal(second.telemetry.resident.rotation, 'estimated_context_bytes');
    assert.equal(second.telemetry.resident.context_estimated_bytes_before, 2048);
    assert.match(second.telemetry.resident.context_estimate_kind, /not_tokens/);
    assert.equal(fake.clients[0].starts.length, 2);
  } finally { await pool.close(); }
  const used = fakeFactory({ translate: () => ({ ...success(), telemetry: { ...success().telemetry, thread_usage_total: { totalTokens: 200 } } }) });
  const actual = await createCodexResidentPool({ ...options, maxActualTotalTokens: 150, createClientImpl: used.createClientImpl });
  try {
    const first = await actual.translate({ fixture }), second = await actual.translate({ fixture });
    assert.equal(first.telemetry.resident.actual_thread_total_tokens, 200);
    assert.equal(second.telemetry.resident.rotation, 'actual_thread_token_limit');
    assert.equal(second.telemetry.resident.actual_usage_source, 'thread/tokenUsage/updated.total.totalTokens');
  } finally { await actual.close(); }
});

test('configured actual usage limit never treats a missing notification as zero', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, maxActualTotalTokens: 150, createClientImpl: fake.createClientImpl });
  try {
    await pool.translate({ fixture }); const next = await pool.translate({ fixture });
    assert.equal(next.telemetry.resident.rotation, 'actual_usage_unavailable');
    assert.equal(next.telemetry.resident.actual_thread_total_tokens, null);
  } finally { await pool.close(); }
});

test('idle least recently used models are closed before replacement, with bounded cache evidence', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, maxCachedModels: 2, createClientImpl: fake.createClientImpl });
  try {
    await pool.translate({ fixture }); await pool.translate({ fixture, model: { slug: 'gpt-6-luna' } });
    await pool.translate({ fixture });
    const third = await pool.translate({ fixture, model: { slug: 'gpt-6-astra' } });
    assert.equal(third.telemetry.resident.evicted_idle_model, 'gpt-6-luna');
    assert.deepEqual(fake.clients.map(client => client.closes), [0, 1, 0]);
    assert.deepEqual(pool.diagnostics().models.map(value => value.model), ['gpt-6.1-sol', 'gpt-6-astra']);
    assert.equal(pool.diagnostics().cache_evictions, 1);
    assert.equal(pool.diagnostics().eviction_history[0].all_processes_termination_confirmed, true);
    assert.ok(fake.events.findIndex(event => event[0] === 'close' && event[1] === 2) < fake.events.findIndex(event => event[0] === 'start' && event[1] === 3));
  } finally { await pool.close(); }
  assert.deepEqual(fake.clients.map(client => client.closes), [1, 1, 1]);
});

test('busy model never gets evicted and global concurrency also bounds different-model work', async () => {
  const held = deferred(), fake = fakeFactory({ translate: index => index === 1 ? held.promise : success('gpt-6-luna') });
  const pool = await createCodexResidentPool({ ...options, concurrency: 2, maxCachedModels: 1, createClientImpl: fake.createClientImpl });
  const first = pool.translate({ fixture }); await tick();
  await assert.rejects(() => pool.translate({ fixture, model: { slug: 'gpt-6-luna' } }), /resident_model_cache_busy/);
  assert.equal(fake.clients[0].closes, 0); assert.equal(fake.clients.length, 2);
  held.resolve(success()); await first;
  assert.equal(pool.diagnostics().unusable_code, null); await pool.close();
});

test('two-lane cache keeps old-model in-flight work and captures the chosen new model immutably', async () => {
  const held = deferred(), fake = fakeFactory({ translate: index => index === 1 ? held.promise : success(fake.factoryCalls[index - 1].model.slug) });
  const pool = await createCodexResidentPool({ ...options, concurrency: 2, createClientImpl: fake.createClientImpl });
  const first = pool.translate({ fixture }); await tick();
  const alternate = { slug: 'gpt-6-luna' }, second = pool.translate({ fixture, model: alternate }); alternate.slug = 'changed-after-admission';
  const result = await second;
  assert.equal(result.telemetry.request.model, 'gpt-6-luna');
  assert.equal(fake.clients[0].busy, true); assert.equal(fake.clients[0].closes, 0); assert.equal(fake.clients[1].closes, 0);
  assert.equal(fake.clients.length, 3);
  held.resolve(success()); await first;
  assert.equal((await pool.close()).termination_confirmed, true); assert.deepEqual(fake.clients.map(client => client.closes), [1, 1, 1]);
});

test('close during a new-model setup drains its single admitted turn and closes every cached model', async () => {
  const setup = deferred(), held = deferred();
  const fake = fakeFactory({ create: index => index === 2 ? setup.promise : undefined, translate: index => index === 2 ? held.promise : success() });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture });
  const switching = pool.translate({ fixture, model: { slug: 'gpt-6-luna' } }); await tick();
  const closing = pool.close(); await assert.rejects(() => pool.translate({ fixture }), /resident_pool_closed/);
  setup.resolve(); await tick(); assert.equal(fake.clients[1].busy, true); assert.equal(fake.clients[1].closes, 0);
  held.resolve(success('gpt-6-luna')); await switching;
  assert.equal((await closing).termination_confirmed, true); assert.deepEqual(fake.clients.map(client => client.closes), [1, 1]);
});

test('unavailable model and incomplete initialization close cached models without fallback or repeating a translation', async () => {
  for (const phase of ['create', 'start']) {
    const fake = fakeFactory({ [phase]: index => { if (index === 2) throw failure('appserver_setup_failed'); } });
    const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
    await pool.translate({ fixture });
    await assert.rejects(() => pool.translate({ fixture, model: { slug: 'catalog-rejected-model' } }), /appserver_setup_failed/);
    await pool.close(); await assert.rejects(() => pool.translate({ fixture }));
    assert.equal(fake.factoryCalls.length, 2); assert.equal(fake.clients.reduce((sum, client) => sum + client.turns.length, 0), 1);
    assert.ok(fake.clients.every(client => client.closes === 1));
  }
});

test('eviction never starts a replacement after a nonzero or unconfirmed idle process exit', async () => {
  for (const result of [{ closed: true, termination_confirmed: true, exit_code: 1 }, { closed: false, termination_confirmed: false, exit_code: null }]) {
    const fake = fakeFactory({ close: () => result }), pool = await createCodexResidentPool({ ...options, maxCachedModels: 1, createClientImpl: fake.createClientImpl });
    await pool.translate({ fixture });
    await assert.rejects(() => pool.translate({ fixture, model: { slug: 'gpt-6-luna' } }),
      result.termination_confirmed ? /resident_process_close_failed/ : /resident_process_exit_unconfirmed/);
    const closed = await pool.close(); assert.equal(closed.termination_confirmed, result.termination_confirmed);
    assert.equal(fake.factoryCalls.length, 1); assert.equal(fake.clients[0].turns.length, 1);
  }
});

test('mismatched model, missing terminal bilingual output and changed prompt fingerprints fail closed', async () => {
  for (const mode of ['model', 'terminal', 'instructions']) {
    const fake = fakeFactory({ translate: () => {
      const value = success();
      if (mode === 'model') value.telemetry.request.model = 'unrequested-model';
      if (mode === 'terminal') value.terminal_event = null;
      if (mode === 'instructions') value.telemetry.request.instructions_sha256 = 'b'.repeat(64);
      return value;
    } });
    const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
    await assert.rejects(() => pool.translate({ fixture }), /resident_(result_model_mismatch|nonterminal_bilingual_result|result_instructions_unverified)/);
    await pool.close(); assert.equal(fake.clients[0].turns.length, 1); assert.equal(fake.clients[0].closes, 1);
  }
});

test('invalid per-model policies and context limits fail before clients are created', async () => {
  for (const invalid of [{ maxCachedModels: 5 }, { maxContextBytes: 0 }, { modelPolicies: null },
    { modelPolicies: { 'gpt-6-luna': { maxTurnsPerThread: 31 } } }, { modelPolicies: { 'bad model': {} } },
    { modelPolicies: { 'gpt-6-luna': { unknown: 1 } } }, { reasoningPolicy: 'catalog_default' }]) {
    const fake = fakeFactory();
    await assert.rejects(() => createCodexResidentPool({ ...options, ...invalid, createClientImpl: fake.createClientImpl }), /invalid_resident_(pool_options|model_policy)/);
    assert.equal(fake.clients.length, 0);
  }
});

test('changed instructions on a newly cached model are rejected before its thread or translation starts', async () => {
  const fake = fakeFactory();
  const createClientImpl = async options => {
    const client = await fake.createClientImpl(options);
    if (fake.clients.length === 2) {
      const original = client.diagnostics;
      client.diagnostics = () => ({ ...original(), instructions_sha256: 'b'.repeat(64) });
    }
    return client;
  };
  const pool = await createCodexResidentPool({ ...options, createClientImpl });
  await pool.translate({ fixture });
  await assert.rejects(() => pool.translate({ fixture, model: { slug: 'gpt-6-luna' } }), /resident_instructions_changed/);
  await pool.close();
  assert.equal(fake.clients[1].starts.length, 0); assert.equal(fake.clients[1].turns.length, 0);
  assert.deepEqual(fake.clients.map(client => client.closes), [1, 1]);
});

test('a single request larger than the configured context budget never reaches inference', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, maxContextBytes: 4096, createClientImpl: fake.createClientImpl });
  await assert.rejects(() => pool.translate({ fixture: { ...fixture, ja: 'long-source-'.repeat(1000) } }), /resident_context_request_too_large/);
  await pool.close();
  assert.equal(fake.clients[0].turns.length, 0); assert.equal(fake.clients[0].closes, 1);
});

const usage = (usedTokens, modelContextWindow = 10_000) => ({ usedTokens, modelContextWindow,
  ratio: usedTokens / modelContextWindow, source: 'thread/tokenUsage/updated.last.totalTokens/modelContextWindow' });

test('79.99 percent does not prewarm, exact 80 percent starts immediately during the admitted turn and repeated events deduplicate', async () => {
  const held = deferred(); let args;
  const fake = fakeFactory({ translate: (_index, value) => { args = value; return held.promise; } });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  const first = pool.translate({ fixture }); await tick();
  args.onContextUsage(usage(7999)); await tick();
  assert.equal(fake.clients[0].starts.length, 1); assert.equal(pool.diagnostics().lanes[0].context_usage.ratio, 0.7999);
  args.onContextUsage(usage(8000)); args.onContextUsage(usage(9000)); await tick();
  assert.equal(fake.clients[0].busy, true); assert.equal(fake.clients[0].starts.length, 2);
  assert.deepEqual(fake.clients[0].startOptions[1], { allowDuringActiveTurn: true });
  assert.equal(fake.clients[0].releases.length, 0); assert.equal(pool.diagnostics().lanes[0].context_prewarm.attempts, 1);
  held.resolve(success()); const output = await first;
  assert.equal(output.telemetry.resident.thread_generation, 1); assert.equal(output.telemetry.resident.turn_index, 1);
  assert.equal(output.telemetry.resident.context_usage.ratio, 0.9);
  await tick(); assert.equal(fake.clients[0].releases.length, 1);
  const lane = pool.diagnostics().lanes[0];
  assert.equal(lane.thread_generation, 2); assert.equal(lane.thread_turns, 0); assert.equal(lane.context_usage.ratio, null);
  assert.equal(lane.context_prewarm.state, 'activated'); assert.equal(lane.context_prewarm.completed, 1);
  assert.equal(lane.instructions_sha256, 'a'.repeat(64));
  assert.doesNotMatch(JSON.stringify(pool.diagnostics()), /private-native|三人/);
  await pool.close();
});

test('current bilingual completion never waits for standby setup; only next dispatch waits for the already started promise', async () => {
  const setup = deferred(); let firstArgs;
  const fake = fakeFactory({ start: (_index, client) => client.starts.length === 1 ? setup.promise : undefined,
    translate: (_index, value, client) => {
      if (client.turns.length === 1) { firstArgs = value; value.onContextUsage(usage(8000)); }
      return success();
    } });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  const first = await pool.translate({ fixture });
  assert.equal(first.success, true); assert.equal(fake.clients[0].starts.length, 1);
  assert.equal(fake.clients[0].startOptions.length, 2); assert.equal(pool.diagnostics().lanes[0].context_prewarm.state, 'preparing');
  const contextual = { ...fixture, id: 'next', context: { previous_translation: first.translation } };
  let settled = false;
  const second = pool.translate({ fixture: contextual }).then(value => { settled = true; return value; }); await tick();
  assert.equal(settled, false); assert.equal(fake.clients[0].turns.length, 1);
  setup.resolve(); const next = await second;
  assert.equal(next.telemetry.resident.rotation, 'context_usage_threshold'); assert.equal(next.telemetry.resident.thread_generation, 2);
  assert.equal(next.telemetry.resident.turn_index, 1); assert.equal(next.telemetry.resident.actual_thread_total_tokens, null);
  assert.equal(fake.clients[0].turns[1].fixture, contextual); assert.deepEqual(fake.clients[0].turns[1].fixture.context.previous_translation, translation);
  assert.notEqual(fake.clients[0].turns[0].threadId, fake.clients[0].turns[1].threadId);
  firstArgs.onContextUsage(usage(9999)); await tick(); assert.equal(fake.clients[0].starts.length, 2);
  assert.equal(pool.diagnostics().lanes[0].context_usage.ratio, null);
  await pool.close();
});

test('a last-turn snapshot rather than accumulated total or UTF8 bytes controls the percentage', async () => {
  const fake = fakeFactory({ translate: (_index, args) => {
    args.onContextUsage(usage(100));
    return { ...success(), telemetry: { ...success().telemetry,
      context_usage: usage(100), thread_usage_total: { totalTokens: 900_000_000 } } };
  } });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture }); await pool.translate({ fixture });
  assert.equal(fake.clients[0].starts.length, 1); assert.equal(pool.diagnostics().lanes[0].context_usage.ratio, 0.01);
  assert.equal(pool.diagnostics().lanes[0].actual_thread_total_tokens, 900_000_000);
  assert.equal(pool.diagnostics().context_usage_basis, usage(0).source); await pool.close();
});

test('missing windows and unsafe counters remain unknown and caller-supplied ratios are not trusted', async () => {
  const fake = fakeFactory({ translate: (_index, args) => {
    for (const invalid of [null, { ...usage(9999), modelContextWindow: null }, { ...usage(9999), modelContextWindow: 0 },
      { ...usage(9999), usedTokens: -1 }, { ...usage(9999), usedTokens: 1.5 }, { ...usage(9999), source: 'cumulative_total' }])
      args.onContextUsage(invalid);
    args.onContextUsage({ ...usage(100), ratio: 0.99 }); return success();
  } });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture }); assert.equal(fake.clients[0].starts.length, 1);
  assert.equal(pool.diagnostics().lanes[0].context_usage.ratio, 0.01); await pool.close();
});

test('an idle late threshold notification creates and initializes the next thread without waiting for another sentence', async () => {
  const fake = fakeFactory(), pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture }); const callback = fake.clients[0].turns[0].onContextUsage;
  callback(usage(8000)); await tick(); await tick();
  assert.equal(fake.clients[0].turns.length, 1); assert.equal(fake.clients[0].starts.length, 2);
  assert.equal(fake.clients[0].releases.length, 1); assert.equal(pool.diagnostics().lanes[0].thread_generation, 2);
  callback(usage(9999)); await tick(); assert.equal(fake.clients[0].starts.length, 2);
  assert.equal(pool.diagnostics().lanes[0].context_usage.ratio, null); await pool.close();
});

test('newer turn usage on the same thread prevents an older late snapshot from replacing the current context', async () => {
  const secondHold = deferred(); let secondArgs;
  const fake = fakeFactory({ translate: (_index, args, client) => {
    if (client.turns.length === 2) { secondArgs = args; return secondHold.promise; }
    return success();
  } });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture }); const oldCallback = fake.clients[0].turns[0].onContextUsage;
  const second = pool.translate({ fixture }); await tick();
  secondArgs.onContextUsage(usage(1000)); oldCallback(usage(9000)); await tick();
  assert.equal(fake.clients[0].starts.length, 1); assert.equal(pool.diagnostics().lanes[0].context_usage.ratio, 0.1);
  assert.equal(pool.diagnostics().lanes[0].context_usage_turn_index, 2);
  secondHold.resolve(success()); const result = await second;
  assert.equal(result.telemetry.resident.thread_generation, 1); assert.equal(result.telemetry.resident.turn_index, 2);
  await pool.close();
});

test('close owns in-flight standby creation, suppresses new preparations and waits for confirmed process exit', async () => {
  const setup = deferred(); let callback;
  const fake = fakeFactory({ start: (_index, client) => client.starts.length === 1 ? setup.promise : undefined,
    translate: (_index, args) => { callback = args.onContextUsage; callback(usage(8000)); return success(); } });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture }); let done = false;
  const closing = pool.close().then(value => { done = true; return value; });
  callback(usage(9999)); await tick();
  assert.equal(done, false); assert.equal(fake.clients[0].closes, 0); assert.equal(pool.diagnostics().owned_preparations, 1);
  setup.resolve(); const closed = await closing;
  assert.equal(closed.termination_confirmed, true); assert.equal(fake.clients[0].closes, 1);
  assert.equal(fake.clients[0].releases.length, 0); assert.equal(fake.clients[0].startOptions.length, 2);
  assert.equal(pool.diagnostics().owned_preparations, 0); assert.equal(pool.diagnostics().lanes[0].thread_generation, 1);
  callback(usage(9999)); await tick(); assert.equal(fake.clients[0].startOptions.length, 2);
});

test('failed standby initialization does not retry or replace the completed sentence and fails future admission closed', async () => {
  const fake = fakeFactory({ start: (_index, client) => { if (client.starts.length === 1) throw failure('appserver_setup_failed'); },
    translate: (_index, args) => { args.onContextUsage(usage(8000)); return success(); } });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  const output = await pool.translate({ fixture }); assert.equal(output.success, true); assert.equal(output.translation, translation);
  await assert.rejects(() => pool.translate({ fixture }), /appserver_setup_failed/);
  const closed = await pool.close(); assert.equal(closed.termination_confirmed, true);
  assert.equal(fake.clients[0].turns.length, 1); assert.equal(fake.clients[0].startOptions.length, 2);
  assert.equal(pool.diagnostics().lanes[0].context_prewarm.state, 'failed');
  assert.doesNotMatch(JSON.stringify(pool.diagnostics()), /private-error|private-native/);
});

test('changed full role fingerprints on a standby thread fail before it receives source text', async () => {
  const fake = fakeFactory({ translate: (_index, args) => { args.onContextUsage(usage(8000)); return success(); } });
  const createClientImpl = async value => {
    const client = await fake.createClientImpl(value), originalStart = client.startThread;
    client.startThread = async args => { const thread = await originalStart(args);
      if (args?.allowDuringActiveTurn) thread.telemetry.instructions_sha256 = 'b'.repeat(64); return thread; };
    return client;
  };
  const pool = await createCodexResidentPool({ ...options, createClientImpl });
  assert.equal((await pool.translate({ fixture })).success, true);
  await assert.rejects(() => pool.translate({ fixture }), /resident_thread_instructions_unverified/);
  assert.equal((await pool.close()).termination_confirmed, true); assert.equal(fake.clients[0].turns.length, 1);
});

test('per-model standby creation is owned across a switch and previous completed translation passes unchanged on return', async () => {
  const setup = deferred();
  const fake = fakeFactory({ start: (index, client) => index === 1 && client.starts.length === 1 ? setup.promise : undefined,
    translate: (index, args, client) => {
      if (index === 1 && client.turns.length === 1) args.onContextUsage(usage(8000));
      return success(index === 1 ? options.model.slug : 'gpt-6-luna');
    } });
  const pool = await createCodexResidentPool({ ...options, createClientImpl: fake.createClientImpl });
  const first = await pool.translate({ fixture });
  const b = await pool.translate({ fixture, model: { slug: 'gpt-6-luna' } });
  assert.equal(b.telemetry.resident.thread_generation, 1); assert.equal(fake.clients[1].starts.length, 1);
  const contextual = { ...fixture, context: { previous_translation: first.translation } };
  const back = pool.translate({ fixture: contextual }); await tick(); assert.equal(fake.clients[0].turns.length, 1);
  setup.resolve(); const output = await back;
  assert.equal(output.telemetry.resident.thread_generation, 2); assert.equal(output.telemetry.resident.turn_index, 1);
  assert.equal(fake.clients[0].turns[1].fixture, contextual); assert.equal(fake.clients[1].starts.length, 1);
  await pool.close(); assert.deepEqual(fake.clients.map(client => client.closes), [1, 1]);
});

test('idle model eviction waits for its owned standby before closing and never starts its replacement early', async () => {
  const setup = deferred();
  const fake = fakeFactory({ start: (index, client) => index === 1 && client.starts.length === 1 ? setup.promise : undefined,
    translate: (index, args) => { if (index === 1) args.onContextUsage(usage(8000)); return success(index === 1 ? options.model.slug : 'gpt-6-luna'); } });
  const pool = await createCodexResidentPool({ ...options, maxCachedModels: 1, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture }); const switched = pool.translate({ fixture, model: { slug: 'gpt-6-luna' } });
  await tick(); assert.equal(fake.factoryCalls.length, 1); assert.equal(fake.clients[0].closes, 0);
  setup.resolve(); await switched;
  assert.equal(fake.clients[0].closes, 1); assert.equal(fake.clients[0].releases.length, 0);
  assert.ok(fake.events.findIndex(item => item[0] === 'close' && item[1] === 1) < fake.events.findIndex(item => item[0] === 'start' && item[1] === 2));
  await pool.close();
});

test('non-production thresholds require the explicit test-only marker and remain independent per model', async () => {
  for (const invalid of [{ contextUsageThreshold: 0.001 }, { contextUsageThreshold: 0 }, { contextUsageThreshold: 1.1 },
    { contextUsageThreshold: Number.NaN }, { testOnlyContextUsageThreshold: 'true' },
    { modelPolicies: { 'gpt-6-luna': { contextUsageThreshold: 0.5 } } }]) {
    const fake = fakeFactory();
    await assert.rejects(() => createCodexResidentPool({ ...options, ...invalid, createClientImpl: fake.createClientImpl }), /invalid_resident_(pool_options|model_policy)/);
    assert.equal(fake.clients.length, 0);
  }
  const fake = fakeFactory({ translate: (index, args) => { args.onContextUsage(usage(5000)); return success(index === 1 ? options.model.slug : 'gpt-6-luna'); } });
  const pool = await createCodexResidentPool({ ...options, testOnlyContextUsageThreshold: true,
    modelPolicies: { 'gpt-6-luna': { contextUsageThreshold: 0.5 } }, createClientImpl: fake.createClientImpl });
  await pool.translate({ fixture }); await pool.translate({ fixture, model: { slug: 'gpt-6-luna' } }); await tick();
  assert.equal(fake.clients[0].starts.length, 1); assert.equal(fake.clients[1].starts.length, 2);
  assert.equal(pool.diagnostics().context_usage_threshold, 0.8); assert.equal(pool.diagnostics().context_usage_threshold_test_only, true);
  await pool.close();
});
