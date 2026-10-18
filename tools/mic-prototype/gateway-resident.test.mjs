import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, validateTestModelSchedule, matchTestModelSchedule } from './gateway.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await wait(5); }
  assert.fail('mock lifecycle condition timed out');
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const completed = value => ({ success: true, terminal_event: 'turn/completed', final_status: 'completed',
  translation: { zh: '中文 ' + value, en: 'English ' + value }, response_model: null,
  timings_ms: { headers: null, completed: 5, total: 5 },
  telemetry: { transport: 'codex_app_server', request: { model: 'gpt-6.1-sol' },
    resident: { lane_index: 0 }, terminal_event: 'turn/completed', final_status: 'completed' } });

test('unsupported prompt styles and source-only on other providers reject before login or process creation', async () => {
  for (const options of [
    { translationProvider: 'codex_cli', codexPromptStyle: 'source_only' },
    { translationProvider: 'siwc', codexPromptStyle: 'source_only' },
    { codexPromptStyle: 'source_only' },
    { translationProvider: 'codex_resident', codexPromptStyle: 'source-only' },
    { translationProvider: 'codex_resident', codexPromptStyle: null },
  ]) {
    let calls = 0;
    const invoked = () => { calls++; assert.fail('invalid prompt style must fail before any auth or process operation'); };
    await assert.rejects(() => createGateway({ ...options, codexExecutable: 'C:/test/codex.exe',
      checkCodexLoginImpl: invoked, createCodexResidentPoolImpl: invoked, spawnImpl: invoked, fetchImpl: invoked, catalogImpl: invoked }),
    error => error.safeCode === (options.codexPromptStyle === 'source_only' ? 'codex_prompt_style_requires_resident' : 'invalid_codex_prompt_style'));
    assert.equal(calls, 0);
  }
});

async function harness(t, configuration = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'mic-prototype-resident-test-'));
  const h = { checks: 0, catalogChecks: 0, poolCalls: [], pools: [], workers: [], jobs: [], closing: false, closePromise: null };
  const makePool = () => {
    const pool = { startupMs: 7, closeCalls: 0, closed: false,
      async translate(options) {
        const job = { ...options, deferred: deferred(), pool };
        h.jobs.push(job);
        return configuration.translate ? configuration.translate(job, h) : job.deferred.promise;
      },
      async close() {
        pool.closeCalls++;
        const result = configuration.closePool ? await configuration.closePool(pool, h) : { termination_confirmed: true };
        pool.closed = result.termination_confirmed === true;
        return result;
      },
      diagnostics: () => ({ transport: 'codex_app_server', startup_ms: 7, closed: pool.closed, lanes: 2 }),
    };
    h.pools.push(pool); return pool;
  };
  h.makePool = makePool;
  const gateway = await createGateway({ translationProvider: 'codex_resident', codexExecutable: 'C:/test/codex.exe',
    codexServiceTier: 'fast', codexPromptStyle: configuration.codexPromptStyle, codexModel: configuration.codexModel, cliWorkDir: join(temporary, 'empty-cli-work'),
    replayFile: join(temporary, 'fixed.wav'), replayFiles: configuration.replayFiles,
    capturedReplayFiles: configuration.capturedReplayFiles, enhancementAssets: configuration.enhancementAssets,
    workerScripts: configuration.workerScripts, outputBase: join(temporary, 'evidence'),
    fetchImpl: () => assert.fail('resident gateway must not make OAuth or SIWC HTTP calls'),
    translateImpl: () => assert.fail('resident gateway must not call exec translation'),
    checkCodexLoginImpl: async () => { h.checks++; return { loggedIn: true, authMode: 'chatgpt' }; },
    listCodexModelsImpl: async options => {
      h.catalogChecks++;
      if (configuration.listModels) return configuration.listModels(options, h);
      return { catalogSource: 'codex_model_list', models: [
        { slug: 'gpt-6.1-sol', display_name: 'Test 6.1', input_modalities: ['text'] },
        { slug: 'gpt-6-sol', display_name: 'Test 6', input_modalities: ['text'] },
        { slug: 'custom-future-model', display_name: 'Future model', input_modalities: ['text'] },
      ] };
    },
    createCodexResidentPoolImpl: async options => {
      h.poolCalls.push(options);
      return configuration.createPool ? configuration.createPool(options, h) : makePool();
    },
    spawnImpl: (executable, args, options) => {
      if (configuration.microphoneAllowed && args[3] === 'run') { assert.ok(args.includes('--device')); assert.ok(!args.includes('--realtime')); }
      else { assert.equal(args[3], 'file'); assert.ok(args.includes('--realtime')); assert.ok(!args.includes('--device')); }
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.args = args;
      child.finished = false; child.clockRequests = 0; child.stopRequests = 0;
      child.emitProtocol = event => { if (!child.finished) child.stdout.write(JSON.stringify(event) + '\n'); };
      child.finish = (code = 0) => {
        if (child.finished) return;
        child.finished = true; child.stdout.end();
        setImmediate(() => child.emit('close', code));
      };
      child.stdin = new Writable({ write(chunk, encoding, done) {
        for (const line of chunk.toString().trim().split('\n')) {
          const command = JSON.parse(line);
          if (command.command === 'clock') {
            child.clockRequests++;
            child.emitProtocol({ type: 'clock_sync', id: command.id, perfCounterMs: performance.now() + 1000 });
          }
          if (command.command === 'stop') { child.stopRequests++; child.finish(); }
        }
        done();
      } });
      child.kill = () => { child.finish(1); return true; };
      child.asr = (segmentId, ja = `片段${segmentId}`) => {
        const point = performance.now() + 1000;
        child.emitProtocol({ type: 'asr_result', segmentId, revision: 1, ja, startSample: (segmentId - 1) * 16000,
          endSample: segmentId * 16000, sampleRate: 16000,
          audioEndPerfMs: point - 1000, vadCommitPerfMs: point - 500, asrStartPerfMs: point - 400, asrEndPerfMs: point });
      };
      h.workers.push(child); setImmediate(() => child.emitProtocol({ type: 'worker_ready' })); return child;
    },
  });
  h.gateway = gateway;
  const html = await (await fetch(gateway.origin)).text();
  const capability = html.match(/const capability='([^']+)'/)[1];
  h.post = async (path, body = {}) => {
    const response = await fetch(gateway.origin + path, { method: 'POST', headers: { origin: gateway.origin,
      'content-type': 'application/json', 'x-prototype-capability': capability }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  h.start = (options = {}) => h.post('/start', { source: 'public_replay', model: 'gpt-6.1-sol',
    concurrency: 2, computeType: 'int8_float16', record: false, ...options });
  h.close = () => {
    if (!h.closePromise) { h.closing = true; h.closePromise = gateway.close(); }
    return h.closePromise;
  };
  t.after(async () => {
    configuration.release?.(h);
    for (const job of h.jobs) job.deferred.resolve(completed('cleanup'));
    for (const child of h.workers) child.finish();
    await h.close(); await rm(temporary, { recursive: true, force: true });
  });
  return h;
}

test('CLI login refresh publishes authBusy through success and rejects model changes while checking', async t => {
  const gate = deferred();
  const h = await harness(t, { release: () => gate.resolve(), listModels: async (_, current) => {
    if (current.catalogChecks > 1) await gate.promise;
    return { catalogSource: 'codex_model_list', models: [{ slug: 'gpt-6.1-sol', input_modalities: ['text'] }] };
  } });
  assert.equal(h.gateway.state.authBusy, false);
  const refresh = h.post('/cli/check');
  await until(() => h.gateway.state.authBusy);
  assert.equal((await (await fetch(h.gateway.origin + '/state')).json()).authBusy, true);
  assert.equal((await h.post('/api/translation-model', { model: 'gpt-6.1-sol' })).body.error, 'translation_model_change_busy');
  gate.resolve(); assert.equal((await refresh).body.loggedIn, true);
  assert.equal(h.gateway.state.authBusy, false);
});

test('worker exception text is excluded from state, rows and persisted evidence while safe code remains', async t => {
  const h = await harness(t);
  assert.equal((await h.start()).status, 200);
  const child = h.workers[0]; await until(() => child.clockRequests === 3);
  child.emitProtocol({ type: 'worker_error', segmentId: 1, revision: 1, code: 'audio_dependency_missing',
    message: 'private exception detail TEST_SECRET_MARKER', reason: 'private TEST_SECRET_MARKER' });
  await until(() => h.gateway.state.phase === 'worker_error');
  assert.equal(h.gateway.state.message, 'audio_dependency_missing');
  assert.equal(h.gateway.state.rows[0].errorCode, 'audio_dependency_missing');
  assert.doesNotMatch(JSON.stringify(h.gateway.state), /TEST_SECRET_MARKER/);
  child.emitProtocol({ type: 'worker_error', code: 'bad code\nTEST_SECRET_MARKER', message: 'private TEST_SECRET_MARKER' });
  await until(() => h.gateway.state.message === 'audio_worker_failed');
  await h.post('/stop'); await until(() => !h.gateway.state.workerActive && !h.gateway.state.residentClosing);
  await h.post('/save', { sessionId: h.gateway.state.session.id });
  const evidence = await readFile(join(h.gateway.state.session.outputDir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(evidence, /TEST_SECRET_MARKER/);
  assert.match(evidence, /audio_dependency_missing/);
});

test('public replay selection uses only the startup allowlist and rejects unknown IDs before process creation', async t => {
  const h = await harness(t, { replayFiles: { reverse: join(tmpdir(), 'trusted-reverse.wav') } });
  for (const replayId of ['../outside', 'unknown', null, { path: 'outside.wav' }]) {
    assert.equal((await h.start({ replayId })).body.error, 'invalid_replay_selection');
  }
  assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0);
  assert.equal((await h.start({ replayId: 'reverse', replayFile: 'untrusted.wav' })).status, 200);
  assert.equal(h.gateway.state.session.replayId, 'reverse');
  assert.equal(h.gateway.state.session.replayFile, join(tmpdir(), 'trusted-reverse.wav'));
  assert.ok(h.workers[0].args.includes(join(tmpdir(), 'trusted-reverse.wav')));
  assert.ok(!h.workers[0].args.includes('untrusted.wav'));
  await h.post('/stop'); await until(() => h.pools[0].closed);
});

test('enhancement defaults off, rejects unsupported modes and never silently starts without configured assets', async t => {
  const h = await harness(t);
  const checks = h.checks;
  for (const enhancement of ['df3', 'unknown', null, {}, 1, 'OFF'])
    assert.equal((await h.start({ enhancement })).body.error, 'invalid_enhancement_mode');
  for (const enhancement of ['deepfilternet3', 'rnnoise'])
    assert.equal((await h.start({ enhancement })).body.error, 'enhancement_assets_not_configured');
  assert.equal(h.checks, checks); assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0);
  assert.equal((await h.start()).status, 200);
  const args = h.workers[0].args;
  assert.equal(args[args.indexOf('--enhancement') + 1], 'off');
  assert.equal(args.includes('--enhancement-assets'), false);
  assert.equal(h.gateway.state.session.enhancement, 'off');
});

test('each enhancement mode is fixed for one session and propagated separately from worker applied diagnostics', async t => {
  const assets = join(tmpdir(), 'isolated-enhancement-assets');
  const h = await harness(t, { enhancementAssets: assets, translate: async () => completed('enhanced') });
  for (const enhancement of ['off', 'deepfilternet3', 'rnnoise']) {
    assert.equal((await h.start({ enhancement })).status, 200);
    const child = h.workers.at(-1); await until(() => child.clockRequests === 3);
    assert.equal(h.gateway.state.session.enhancementDiagnostics, null, 'requested mode alone is not an applied confirmation');
    assert.equal(child.args[child.args.indexOf('--enhancement') + 1], enhancement);
    assert.equal(child.args[child.args.indexOf('--enhancement-assets') + 1], assets);
    assert.equal((await h.start({ enhancement: 'off' })).body.error, 'previous_session_still_active');
    assert.equal((await h.post('/api/translation-model', { model: 'custom-future-model' })).status, 200);
    child.emitProtocol({ type: 'asr_result', segmentId: 1, revision: 1, ja: '比較用の音声です。',
      enhancement: { mode: enhancement, applied: enhancement !== 'off' } });
    await until(() => h.gateway.state.rows[0]?.terminal);
    const row = h.gateway.state.rows[0];
    assert.equal(row.requestedEnhancement, enhancement); assert.equal(row.audioSource, 'public_replay');
    assert.deepEqual(row.enhancement, { mode: enhancement, applied: enhancement !== 'off' });
    await h.post('/stop'); await until(() => h.pools.at(-1).closed);
  }
});

test('reported enhancement diagnostics stay distinct from requested mode and a reported fallback fails explicitly', async t => {
  const h = await harness(t, { enhancementAssets: join(tmpdir(), 'isolated-enhancement-assets') });
  assert.equal((await h.start({ enhancement: 'rnnoise' })).status, 200);
  const child = h.workers[0]; await until(() => child.clockRequests === 3);
  child.emitProtocol({ type: 'worker_ready', enhancement: { requestedMode: 'rnnoise', appliedMode: 'rnnoise',
    algorithmicDelaySamples: 480, nativeRate: 48000, profileSha256: 'a'.repeat(64), privatePath: 'MUST_NOT_PROJECT' } });
  await until(() => h.gateway.state.session.enhancementDiagnostics?.appliedMode === 'rnnoise');
  assert.deepEqual(h.gateway.state.session.enhancementDiagnostics, { requestedMode: 'rnnoise', appliedMode: 'rnnoise',
    algorithmicDelaySamples: 480, nativeRate: 48000, outputTimeline: null, profileSha256: 'a'.repeat(64) });
  child.emitProtocol({ type: 'worker_ready', enhancement: { requestedMode: 'rnnoise', appliedMode: 'off' } });
  await until(() => h.gateway.state.message === 'enhancement_mode_mismatch');
  assert.equal(h.gateway.state.phase, 'worker_error'); assert.equal(h.jobs.length, 0);
});

test('native raw recording is microphone-only while optional processed recording uses server-owned paths for every source', async t => {
  const h = await harness(t, { microphoneAllowed: true, capturedReplayFiles: { mic: join(tmpdir(), 'real-mic.wav') } });
  for (const recordProcessed of [null, 1, 'true', {}])
    assert.equal((await h.start({ recordProcessed })).body.error, 'invalid_capture_options');
  assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0);
  for (const source of ['microphone', 'public_replay', 'captured_replay']) {
    const options = { source, device: 9, record: true, recordProcessed: true, processedRecord: 'UNTRUSTED_OUTPUT.wav', rawNativeRecord: 'UNTRUSTED_NATIVE.wav' };
    if (source === 'captured_replay') options.replayId = 'mic';
    assert.equal((await h.start(options)).status, 200);
    const child = h.workers.at(-1), session = h.gateway.state.session;
    assert.equal(session.audioRecorded, source === 'microphone'); assert.equal(session.rawNativeAudioRecorded, source === 'microphone');
    assert.equal(session.processedAudioRecorded, true);
    assert.equal(child.args[child.args.indexOf('--processed-record') + 1], join(session.outputDir, 'audio-processed.wav'));
    if (source === 'microphone') {
      assert.equal(child.args[child.args.indexOf('--record') + 1], join(session.outputDir, 'audio.wav'));
      assert.equal(child.args[child.args.indexOf('--raw-native-record') + 1], join(session.outputDir, 'audio-native.wav'));
    } else { assert.ok(!child.args.includes('--record')); assert.ok(!child.args.includes('--raw-native-record')); }
    assert.ok(!child.args.includes('UNTRUSTED_OUTPUT.wav')); assert.ok(!child.args.includes('UNTRUSTED_NATIVE.wav'));
    await h.post('/stop'); await until(() => h.pools.at(-1).closed);
  }
});

test('worker clock samples persist only for explicit microphone recording or the existing replay test schedule', async t => {
  const h = await harness(t, { microphoneAllowed: true });
  for (const record of [false, true]) {
    assert.equal((await h.start({ source: 'microphone', device: 9, record })).status, 200);
    const child = h.workers.at(-1), session = h.gateway.state.session;
    await until(() => child.clockRequests === 3);
    await h.post('/stop'); await until(() => h.pools.at(-1).closed);
    await h.post('/save', { sessionId: session.id });
    const events = (await readFile(join(session.outputDir, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const clocks = events.filter(event => event.type === 'worker_clock_sample');
    assert.equal(clocks.length, record ? 3 : 0);
    for (const sample of clocks) {
      assert.equal(sample.accepted, true); assert.ok(Number.isFinite(sample.sentNodeMs));
      assert.ok(Number.isFinite(sample.receivedNodeMs)); assert.ok(Number.isFinite(sample.workerPerfCounterMs));
      assert.ok(Number.isFinite(sample.best.offsetMs));
      assert.deepEqual(Object.keys(sample).sort(), ['accepted', 'best', 'id', 'observedAt', 'receivedNodeMs', 'sentNodeMs', 'type', 'workerPerfCounterMs'].sort());
    }
  }
  assert.equal(h.jobs.length, 0);
});

test('captured microphone replay has a separate startup allowlist and cannot masquerade as live microphone input', async t => {
  const file = join(tmpdir(), 'physical-microphone-capture.wav');
  const h = await harness(t, { capturedReplayFiles: { mic50: file }, replayFiles: { publicOnly: join(tmpdir(), 'public.wav') },
    translate: async () => completed('captured') });
  assert.deepEqual(h.gateway.state.capturedReplayOptions, [{ id: 'mic50', label: 'mic50' }]);
  for (const replayId of [undefined, null, 'publicOnly', '../escape.wav', file, {}])
    assert.equal((await h.start({ source: 'captured_replay', replayId })).body.error, 'invalid_captured_replay_selection');
  assert.equal((await h.start({ replayId: 'mic50' })).body.error, 'invalid_replay_selection');
  assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0);
  assert.equal((await h.start({ source: 'captured_replay', replayId: 'mic50', replayFile: 'untrusted.wav', device: 9 })).status, 200);
  const child = h.workers[0]; await until(() => child.clockRequests === 3);
  assert.equal(child.args[3], 'file'); assert.ok(child.args.includes('--realtime'));
  assert.ok(child.args.includes(file)); assert.ok(!child.args.includes('--device')); assert.ok(!child.args.includes('untrusted.wav'));
  assert.equal(h.gateway.state.session.source, 'captured_replay'); assert.equal(h.gateway.state.session.device, null);
  assert.equal(h.gateway.state.session.audioRecorded, false); assert.match(h.gateway.state.message, /已有麦克风录音.*未启动麦克风/);
  child.asr(1); await until(() => h.gateway.state.rows[0]?.terminal);
  assert.equal(h.gateway.state.rows[0].audioSource, 'captured_replay');
});

const samplePlan = () => ({ sampleRate: 16000, intervals: [
  { fixtureId: 'JA-001', startSample: 0, endSample: 16000, ownershipStartSample: 0, ownershipEndSample: 18000, model: 'gpt-6.1-sol' },
  { fixtureId: 'JA-002', startSample: 20000, endSample: 32000, ownershipStartSample: 18000, ownershipEndSample: 36000, model: 'gpt-6.1-sol' },
  { fixtureId: 'JA-006', startSample: 40000, endSample: 56000, ownershipStartSample: 36000, ownershipEndSample: 60000, model: 'custom-future-model' },
] });

test('sample model schedule is immutable source-coordinate data and rejects text injection or overlapping ranges', () => {
  const input = samplePlan(), plan = validateTestModelSchedule(input);
  assert.match(plan.sha256, /^[a-f0-9]{64}$/); assert.ok(Object.isFrozen(plan.intervals[0]));
  input.intervals[0].model = 'changed'; assert.equal(plan.intervals[0].model, 'gpt-6.1-sol');
  for (const change of [null, { ...samplePlan(), reference_ja: 'DO_NOT_SEND' },
    { ...samplePlan(), sampleRate: 48000 }, { ...samplePlan(), intervals: [{ ...samplePlan().intervals[0], ja: 'DO_NOT_SEND' }] },
    { ...samplePlan(), intervals: [{ ...samplePlan().intervals[0], startSample: -1 }] },
    { ...samplePlan(), intervals: [samplePlan().intervals[0], { ...samplePlan().intervals[1], startSample: 1 }] }])
    assert.throws(() => validateTestModelSchedule(change), /invalid_test_model_schedule/);
  const overlap = matchTestModelSchedule(plan, { sampleRate: 16000, startSample: 15000, endSample: 22000, inputEndSample: 50000 });
  assert.equal(overlap.expectedModel, 'gpt-6.1-sol'); assert.deepEqual(overlap.matches.map(x => x.fixtureId), ['JA-001', 'JA-002']);
  const crossed = matchTestModelSchedule(plan, { sampleRate: 16000, startSample: 30000, endSample: 42000 });
  assert.equal(crossed.speechMatchCode, 'model_schedule_ambiguous'); assert.equal(crossed.expectedModel, 'custom-future-model'); assert.equal(crossed.errorCode, null);
  const background = matchTestModelSchedule(plan, { sampleRate: 16000, startSample: 32000, endSample: 40000 });
  assert.equal(background.speechMatchCode, 'model_schedule_unmatched'); assert.equal(background.expectedModel, 'custom-future-model'); assert.equal(background.errorCode, null);
});

test('captured replay routes by frozen source samples, retains ambiguous and background ASR, and ignores recognition count', async t => {
  const h = await harness(t, { capturedReplayFiles: { mic: join(tmpdir(), 'real-mic.wav') }, translate: async () => completed('sample') });
  const plan = samplePlan();
  assert.equal((await h.start({ testModelSchedule: plan })).body.error, 'test_model_schedule_source_not_allowed');
  assert.equal((await h.start({ source: 'microphone', device: 9, testModelSchedule: plan })).body.error, 'test_model_schedule_source_not_allowed');
  assert.equal((await h.start({ source: 'captured_replay', replayId: 'mic', testModelSchedule: plan })).status, 200);
  const child = h.workers[0]; await until(() => child.clockRequests === 3);
  assert.equal((await h.post('/api/translation-model', { model: 'gpt-6-sol' })).body.error, 'test_model_schedule_controls_translation');
  // First received result belongs to the third fixture: missing earlier ASR must not shift its model.
  child.emitProtocol({ type: 'asr_result', segmentId: 81, revision: 1, ja: '後半です。', sampleRate: 16000, startSample: 41000, endSample: 50000 });
  child.emitProtocol({ type: 'asr_result', segmentId: 83, revision: 1, ja: '跨区間の元日本語。', sampleRate: 16000, startSample: 31000, endSample: 41000 });
  child.emitProtocol({ type: 'asr_result', segmentId: 84, revision: 1, ja: '背景の誤検出。', sampleRate: 16000, startSample: 33000, endSample: 39000 });
  await until(() => h.gateway.state.rows.length === 3 && h.gateway.state.queue.active === 0);
  assert.equal(h.jobs.length, 3); assert.ok(h.jobs.every(job => job.model.slug === 'custom-future-model'));
  const [translated, ambiguous, unmatched] = h.gateway.state.rows;
  assert.equal(translated.testModelScheduleMatch.expectedModel, 'custom-future-model');
  assert.equal(ambiguous.testModelScheduleMatch.speechMatchCode, 'model_schedule_ambiguous'); assert.equal(ambiguous.ja, '跨区間の元日本語。');
  assert.equal(unmatched.testModelScheduleMatch.speechMatchCode, 'model_schedule_unmatched'); assert.equal(unmatched.ja, '背景の誤検出。');
  assert.equal(ambiguous.status, 'completed'); assert.equal(unmatched.status, 'completed');
  assert.ok(ambiguous.translation.en); assert.ok(unmatched.translation.en);
});

test('invalid enhancement paths and captured replay catalogs fail before auth or process creation', async () => {
  for (const change of [{ enhancementAssets: '' }, { enhancementAssets: 'relative' }, { enhancementAssets: {} },
    { capturedReplayFiles: null }, { capturedReplayFiles: [] }, { capturedReplayFiles: { '../id': join(tmpdir(), 'a.wav') } },
    { capturedReplayFiles: { mic: 'relative.wav' } }, { capturedReplayFiles: { mic: join(tmpdir(), 'not-a-wave.mp3') } }]) {
    let calls = 0; const invoked = () => { calls++; assert.fail('invalid configuration must remain passive'); };
    await assert.rejects(() => createGateway({ ...change, translationProvider: 'codex_resident', codexExecutable: 'C:/test/codex.exe',
      checkCodexLoginImpl: invoked, spawnImpl: invoked, createCodexResidentPoolImpl: invoked }),
    error => ['invalid_enhancement_assets', 'invalid_captured_replay_catalog'].includes(error.safeCode));
    assert.equal(calls, 0);
  }
});

test('worker selection accepts only a startup allowlist for public replay and records the actual script', async t => {
  const trusted = join(tmpdir(), 'frozen-baseline-worker.py');
  const h = await harness(t, { workerScripts: { baseline: trusted } });
  for (const workerId of ['../outside.py', 'unknown', null, { file: 'other.py' }]) {
    assert.equal((await h.start({ workerId })).body.error, 'invalid_worker_selection');
  }
  assert.equal((await h.start({ source: 'microphone', device: 1, workerId: 'baseline' })).body.error, 'invalid_worker_selection');
  assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0);
  assert.equal((await h.start({ workerId: 'baseline', workerScript: 'untrusted.py' })).status, 200);
  assert.equal(h.workers[0].args[2], trusted);
  assert.equal(h.gateway.state.session.workerScript, trusted);
  assert.equal(h.gateway.state.session.workerId, 'baseline');
  assert.ok(!h.workers[0].args.includes('untrusted.py'));
  await h.post('/stop'); await until(() => h.pools[0].closed);
});

test('invalid worker catalogs reject before login or process operations', async () => {
  for (const workerScripts of [null, [], 'arbitrary.py', { '../outside': 'worker.py' }, { baseline: '' }, { baseline: 4 }]) {
    let calls = 0;
    const invoked = () => { calls++; assert.fail('invalid catalog must not invoke services'); };
    await assert.rejects(() => createGateway({ workerScripts, translationProvider: 'codex_resident',
      codexExecutable: 'C:/test/codex.exe', checkCodexLoginImpl: invoked, spawnImpl: invoked, createCodexResidentPoolImpl: invoked }),
    error => error.safeCode === 'invalid_worker_catalog');
    assert.equal(calls, 0);
  }
});

test('page readiness retains only visibility geometry and never starts audio or translation', async t => {
  const h = await harness(t);
  assert.equal(h.gateway.state.pageStatus, null);
  assert.equal((await h.post('/page-status', { version: 1, documentHidden: false, focused: true,
    viewport: { width: 1000, height: 800 }, arbitrary: 'private text' })).status, 200);
  assert.equal(h.gateway.state.pageStatus.documentHidden, false);
  assert.equal(h.gateway.state.pageStatus.focused, true);
  assert.equal(h.gateway.state.pageStatus.arbitrary, undefined);
  assert.ok(Number.isFinite(h.gateway.state.pageStatus.receivedAtNodeMs));
  assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0);
  assert.equal((await h.post('/page-status', { version: 1, documentHidden: false, focused: true,
    viewport: { width: 0, height: 800 } })).body.error, 'invalid_page_status');
});

test('viewport proof is validated and retained across later row updates', async t => {
  const h = await harness(t, { translate: async () => completed('proof') });
  await h.start(); h.workers[0].asr(1);
  await until(() => h.gateway.state.rows[0]?.visibleEligible);
  const visibilityProof = { version: 1, documentHidden: false, focused: true, animationFrames: 2,
    viewport: { width: 1000, height: 800 }, bothFullyInViewport: true, targets: {
      zh: { top: 100, left: 20, right: 480, bottom: 180, width: 460, height: 80 },
      en: { top: 100, left: 520, right: 980, bottom: 180, width: 460, height: 80 } } };
  const ack = { sessionId: h.gateway.state.session.id, segmentId: 1, revision: 1,
    visibleNodeMs: performance.now(), clockUncertaintyMs: 1 };
  assert.equal((await h.post('/visible', { ...ack, visibilityProof: { ...visibilityProof, documentHidden: true } })).body.error, 'invalid_visibility_proof');
  assert.equal(h.gateway.state.rows[0].visibleNodeMs, undefined);
  assert.equal((await h.post('/visible', { ...ack, visibilityProof })).status, 200);
  assert.deepEqual(h.gateway.state.rows[0].visibilityProof, visibilityProof);
  await h.post('/evaluate', { sessionId: ack.sessionId, segmentId: 1, revision: 1,
    referenceJa: '参考', zhQuality: 'unreviewed', enQuality: 'unreviewed', note: '' });
  assert.deepEqual(h.gateway.state.rows[0].visibilityProof, visibilityProof);
  await h.post('/stop'); await until(() => h.pools[0].closed);
});

test('source-only replay requires explicit gateway selection and records style in state and saved session', async t => {
  const h = await harness(t, { codexPromptStyle: 'source_only' });
  assert.equal(h.gateway.state.codexPromptStyle, 'source_only'); assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0);
  assert.equal((await h.start()).status, 200);
  assert.equal(h.poolCalls[0].promptStyle, 'source_only'); assert.equal(h.gateway.state.session.codexPromptStyle, 'source_only');
  const savedSession = JSON.parse(await readFile(join(h.gateway.state.session.outputDir, 'session.json'), 'utf8'));
  assert.equal(savedSession.codexPromptStyle, 'source_only'); assert.equal(savedSession.provider, 'codex_resident');
  await h.post('/stop'); await until(() => h.pools[0].closed);
});

test('resident startup is passive and explicit replay waits for pool readiness; cancellation closes before reuse', async t => {
  const ready = deferred(), closed = deferred(); let first = true;
  const h = await harness(t, {
    createPool: async (options, current) => { const pool = current.makePool(); if (first) { first = false; await ready.promise; } return pool; },
    closePool: async (pool, current) => { if (pool === current.pools[0]) await closed.promise; return { termination_confirmed: true }; },
    release: () => { ready.resolve(); closed.resolve(); },
  });
  assert.equal(h.checks, 1); assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0);
  assert.equal(h.gateway.state.provider, 'codex_resident'); assert.equal(h.gateway.state.auth, 'authorized');
  assert.equal(h.gateway.state.codexPromptStyle, 'full');
  assert.equal((await h.post('/auth/start')).body.error, 'siwc_disabled_for_cli');
  const pendingStart = h.start();
  await until(() => h.poolCalls.length === 1);
  assert.equal(h.gateway.state.phase, 'preparing_translation'); assert.equal(h.workers.length, 0);
  assert.equal((await h.start()).body.error, 'previous_session_still_active');
  assert.equal((await h.post('/cli/check')).body.error, 'stop_capture_before_checking_login');
  await h.post('/stop'); ready.resolve();
  assert.equal((await pendingStart).body.error, 'capture_start_cancelled');
  await until(() => h.gateway.state.residentClosing);
  assert.equal(h.workers.length, 0); assert.equal(h.pools[0].closeCalls, 1);
  assert.equal((await h.start()).body.error, 'previous_session_still_active');
  closed.resolve(); await until(() => !h.gateway.state.residentClosing);
  assert.equal((await h.start()).status, 200); assert.equal(h.poolCalls.length, 2);
  await until(() => h.workers[0].clockRequests === 3);
  assert.equal(h.gateway.state.session.schedulerPolicy, 'bounded_resident_lanes');
  assert.equal(h.gateway.state.session.cleanupAllowance, 0);
  assert.equal(h.gateway.state.session.codexPromptStyle, 'full'); assert.equal(h.poolCalls[1].promptStyle, 'full');
  assert.deepEqual(h.gateway.state.session.residentPolicy,
    { maxTurnsPerThread: 30, maxTurnsPerProcess: 120, lanes: 2, independentHistories: true, contextUsageThreshold: 0.8 });
  assert.equal(h.poolCalls[1].contextUsageThreshold, 0.8);
  await h.post('/stop'); await until(() => h.pools[1].closed);
});

test('worker exit drains queued resident turns, preserves ordering and blocks reuse during pool close', async t => {
  const closed = deferred();
  const h = await harness(t, { closePool: async () => { await closed.promise; return { termination_confirmed: true }; }, release: () => closed.resolve() });
  assert.equal((await h.start()).status, 200); const child = h.workers[0];
  await until(() => child.clockRequests === 3);
  for (let i = 1; i <= 3; i++) child.asr(i);
  await until(() => h.jobs.length === 2 && h.gateway.state.queue.pending === 1);
  child.finish(); await until(() => !h.gateway.state.workerActive);
  assert.equal(h.pools[0].closeCalls, 0);
  h.jobs[1].deferred.resolve(completed('second'));
  await until(() => h.jobs.length === 3);
  assert.equal(h.gateway.state.rows[1].status, 'completed'); assert.equal(h.gateway.state.rows[1].visibleEligible, false);
  assert.equal(h.gateway.state.queue.ordered, 0); assert.equal(h.pools[0].closeCalls, 0);
  h.jobs[0].deferred.resolve(completed('first'));
  await until(() => h.gateway.state.queue.ordered === 2);
  h.jobs[2].deferred.resolve(completed('third'));
  await until(() => h.gateway.state.residentClosing);
  assert.equal(h.gateway.state.queue.active, 0); assert.equal(h.gateway.state.queue.pending, 0);
  assert.equal(h.gateway.state.queue.ordered, 3); assert.equal(h.pools[0].closeCalls, 1);
  assert.deepEqual(h.gateway.state.rows.map(row => [row.segmentId, row.translation.en, row.visibleEligible]),
    [[1, 'English first', true], [2, 'English second', true], [3, 'English third', true]]);
  assert.equal((await h.start()).body.error, 'previous_session_still_active');
  assert.equal((await h.post('/cli/check')).body.error, 'stop_capture_before_checking_login');
  closed.resolve(); await until(() => !h.gateway.state.residentClosing);
  const saved = await h.post('/save', { sessionId: h.gateway.state.session.id }); assert.equal(saved.status, 200);
  const events = (await readFile(join(saved.body.outputDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const ordered = events.filter(event => event.type === 'ordered').map(event => event.row.segmentId);
  assert.deepEqual(ordered, [1, 2, 3]);
  assert.equal(events.filter(event => event.type === 'resident_closed').length, 1);
  assert.equal(events.find(event => event.type === 'resident_closed').result.termination_confirmed, true);
});

test('resident initialization with unconfirmed process termination latches across starts and login checks', async t => {
  const h = await harness(t, { createPool: async () => { throw Object.assign(new Error('private detail must not reach page'),
    { safeCode: 'resident_setup_failed', diagnostics: { termination_confirmed: false } }); } });
  assert.deepEqual((await h.start()).body, { error: 'resident_setup_failed' });
  assert.equal(h.workers.length, 0); assert.equal(h.gateway.state.cliProcessExitUnconfirmed, true);
  const checks = h.checks;
  assert.equal((await h.start()).body.error, 'codex_cli_process_exit_unconfirmed');
  assert.equal((await h.post('/cli/check')).body.error, 'codex_cli_process_exit_unconfirmed');
  assert.equal(h.checks, checks); assert.equal(h.poolCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(h.gateway.state), /private detail/);
});

test('resident close failure retains the termination latch and does not silently create a replacement', async t => {
  const h = await harness(t, { closePool: async () => ({ termination_confirmed: false }) });
  assert.equal((await h.start()).status, 200);
  await h.post('/stop'); await until(() => h.gateway.state.cliProcessExitUnconfirmed);
  assert.ok(h.gateway.state.warnings.includes('resident_termination_unconfirmed'));
  assert.equal((await h.start()).body.error, 'codex_cli_process_exit_unconfirmed');
  assert.equal((await h.post('/cli/check')).body.error, 'codex_cli_process_exit_unconfirmed');
  assert.equal(h.poolCalls.length, 1); assert.equal(h.pools[0].closeCalls, 1);
});

test('confirmed nonzero resident exit warns and retains translations without blocking a fresh session', async t => {
  const h = await harness(t, { closePool: async () => ({ closed: true, termination_confirmed: true,
    exit_code: 1, unusable_code: 'resident_process_close_failed' }) });
  assert.equal((await h.start()).status, 200); const child = h.workers[0];
  await until(() => child.clockRequests === 3);
  child.asr(1); await until(() => h.jobs.length === 1);
  h.jobs[0].deferred.resolve(completed('retained'));
  await until(() => h.gateway.state.rows[0]?.status === 'completed' && h.gateway.state.queue.active === 0);
  await h.post('/stop'); await until(() => !h.gateway.state.workerActive && !h.gateway.state.residentClosing && h.pools[0].closed);
  assert.ok(h.gateway.state.warnings.includes('resident_close_error:resident_process_close_failed'));
  assert.notEqual(h.gateway.state.cliProcessExitUnconfirmed, true);
  assert.equal(h.gateway.state.rows[0].translation.en, 'English retained');
  assert.equal(h.gateway.state.rows[0].status, 'completed');
  assert.equal((await h.post('/cli/check')).body.loggedIn, true);
  assert.equal((await h.start()).status, 200);
  assert.equal(h.poolCalls.length, 2); assert.equal(h.workers.length, 2);
  await h.post('/stop'); await until(() => h.pools[1].closed);
});

test('resident translation failure pauses pending cloud work without retries and retains completed translations', async t => {
  const h = await harness(t);
  assert.equal((await h.start({ concurrency: 1 })).status, 200); const child = h.workers[0];
  await until(() => child.clockRequests === 3);
  child.asr(1); child.asr(2); child.asr(3);
  await until(() => h.jobs.length === 1 && h.gateway.state.queue.pending === 2);
  h.jobs[0].deferred.resolve(completed('kept'));
  await until(() => h.jobs.length === 2);
  h.jobs[1].deferred.resolve({ success: false, terminal_event: 'turn/completed', final_status: 'client_error',
    error: { code: 'appserver_turn_failed' }, telemetry: { transport: 'codex_app_server' } });
  await until(() => h.pools[0].closed);
  assert.equal(child.stopRequests, 1); assert.equal(h.jobs.length, 2);
  assert.equal(h.gateway.state.phase, 'translation_paused');
  assert.deepEqual(h.gateway.state.rows.map(row => [row.status, row.errorCode]),
    [['completed', null], ['failed', 'appserver_turn_failed'], ['failed', 'cloud_translation_paused']]);
  assert.equal(h.gateway.state.rows[0].translation.en, 'English kept');
  assert.equal(h.gateway.state.queue.ordered, 3);
});

test('gateway shutdown during resident initialization cancels capture and awaits owned pool closure', async t => {
  const ready = deferred(), closed = deferred();
  const h = await harness(t, { createPool: async (options, current) => { const pool = current.makePool(); await ready.promise; return pool; },
    closePool: async () => { await closed.promise; return { termination_confirmed: true }; },
    release: () => { ready.resolve(); closed.resolve(); } });
  const starting = h.start(); await until(() => h.poolCalls.length === 1);
  let shutdownFinished = false; const shutdown = h.close().then(() => { shutdownFinished = true; });
  ready.resolve(); assert.equal((await starting).body.error, 'capture_start_cancelled');
  await until(() => h.pools[0].closeCalls === 1);
  assert.equal(h.workers.length, 0); assert.equal(shutdownFinished, false);
  closed.resolve(); await shutdown;
  assert.equal(h.pools[0].closed, true); assert.equal(shutdownFinished, true);
});

test('catalog models are selectable before capture without a fixed model allowlist, while hidden and audio-only entries are rejected', async t => {
  const h = await harness(t, { codexModel: 'custom-future-model', listModels: async () => ({ catalogSource: 'codex_model_list', models: [
    { slug: 'custom-future-model', display_name: 'Future text', input_modalities: ['text'], default_reasoning_effort: 'low', supported_reasoning_efforts: ['low', 'high'] },
    { slug: 'hidden-model', display_name: 'Hidden', hidden: true, input_modalities: ['text'] },
    { slug: 'audio-model', display_name: 'Audio', input_modalities: ['audio'] },
    { slug: 'another-model', display_name: 'Another', input_modalities: ['text'] },
  ] }) });
  assert.equal(h.gateway.state.selectedModel, 'custom-future-model');
  assert.equal(h.gateway.state.catalogSource, 'codex_model_list');
  assert.deepEqual(h.gateway.state.models.map(model => model.slug), ['custom-future-model', 'another-model']);
  assert.deepEqual(h.gateway.state.models[0].supported_reasoning_efforts, ['low', 'high']);
  for (const model of ['hidden-model', 'audio-model', 'unlisted-valid-slug']) {
    assert.equal((await h.post('/api/translation-model', { model })).body.error, 'selected_model_not_visible');
  }
  for (const model of [null, {}, 'bad model', '']) assert.equal((await h.post('/api/translation-model', { model })).body.error, 'invalid_codex_model');
  const changed = await h.post('/api/translation-model', { model: 'another-model' });
  assert.deepEqual(changed.body, { selectedModel: 'another-model', modelSelectionRevision: 1 });
  assert.deepEqual((await h.post('/api/translation-model', { model: 'another-model' })).body, changed.body);
  assert.equal(h.poolCalls.length, 0); assert.equal(h.workers.length, 0); assert.equal(h.jobs.length, 0);
  assert.equal((await h.post('/start', { source: 'public_replay', concurrency: 1 })).status, 200);
  assert.equal(h.poolCalls[0].model.slug, 'another-model'); assert.equal(h.gateway.state.session.model, 'another-model');
  await h.post('/stop'); await until(() => h.pools[0].closed);
});

test('running model changes freeze queued jobs, keep previous requests and session identity, and preserve ordered bilingual results', async t => {
  const h = await harness(t);
  assert.equal((await h.start({ concurrency: 1 })).status, 200);
  const child = h.workers[0]; await until(() => child.clockRequests === 3);
  child.asr(1); child.asr(2);
  await until(() => h.jobs.length === 1 && h.gateway.state.queue.pending === 1);
  const initialSessionId = h.gateway.state.session.id;
  const changed = await h.post('/api/translation-model', { model: 'custom-future-model' });
  assert.deepEqual(changed.body, { selectedModel: 'custom-future-model', modelSelectionRevision: 1 });
  child.asr(3); await until(() => h.gateway.state.queue.pending === 2);
  assert.equal(h.jobs.length, 1); assert.equal(child.stopRequests, 0);
  assert.equal(h.gateway.state.session.id, initialSessionId); assert.equal(h.gateway.state.session.model, 'gpt-6.1-sol');
  assert.deepEqual(h.gateway.state.rows.map(row => [row.segmentId, row.translationModel, row.modelSelectionRevision]),
    [[1, 'gpt-6.1-sol', 0], [2, 'gpt-6.1-sol', 0], [3, 'custom-future-model', 1]]);
  // Changes to the live catalog must never mutate the model objects of queued work.
  h.gateway.state.models[0].display_name = 'later catalog name';
  h.jobs[0].deferred.resolve(completed('first'));
  await until(() => h.jobs.length === 2);
  assert.deepEqual(h.jobs[1].model, { slug: 'gpt-6.1-sol', display_name: 'Test 6.1' });
  h.jobs[1].deferred.resolve(completed('second')); await until(() => h.jobs.length === 3);
  assert.deepEqual(h.jobs[2].model, { slug: 'custom-future-model', display_name: 'Future model' });
  h.jobs[2].deferred.resolve(completed('third')); await until(() => h.gateway.state.queue.active === 0);
  assert.deepEqual(h.gateway.state.rows.map(row => [row.segmentId, row.translation.en, row.visibleEligible]),
    [[1, 'English first', true], [2, 'English second', true], [3, 'English third', true]]);
  await h.post('/stop'); await until(() => h.pools[0].closed);
  const saved = await h.post('/save', { sessionId: initialSessionId });
  const report = JSON.parse(await readFile(join(saved.body.outputDir, 'report.json'), 'utf8'));
  assert.deepEqual(report.rows.map(row => row.requestedModel.slug), ['gpt-6.1-sol', 'gpt-6.1-sol', 'custom-future-model']);
  const events = (await readFile(join(saved.body.outputDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'translation_model_selected').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'ordered').map(event => event.row.segmentId), [1, 2, 3]);
});

test('catalog refresh failures are explicit, never fabricate models, and recover without authorization or audio', async t => {
  let unavailable = true;
  const h = await harness(t, { listModels: async () => {
    if (unavailable) throw Object.assign(new Error('private account detail'), { safeCode: 'model_catalog_test_unavailable' });
    return { catalogSource: 'codex_model_list', models: [{ slug: 'custom-future-model', display_name: 'Future', is_default: true, input_modalities: ['text'] }] };
  } });
  assert.equal(h.gateway.state.auth, 'authorized'); assert.equal(h.gateway.state.catalogError, 'model_catalog_test_unavailable');
  assert.equal(h.gateway.state.catalogSource, null); assert.deepEqual(h.gateway.state.models, []);
  assert.equal(h.gateway.state.selectedModel, 'gpt-6.1-sol');
  assert.equal((await h.post('/api/translation-model', { model: 'custom-future-model' })).body.error, 'codex_model_catalog_unavailable');
  assert.equal((await h.start()).body.error, 'model_catalog_test_unavailable');
  assert.equal(h.workers.length, 0); assert.equal(h.poolCalls.length, 0);
  unavailable = false;
  assert.equal((await h.post('/cli/check')).body.loggedIn, true);
  assert.equal(h.gateway.state.catalogError, null); assert.equal(h.gateway.state.selectionError, 'selected_model_not_visible');
  // An account's advertised default cannot silently replace the requested model.
  assert.equal(h.gateway.state.selectedModel, 'gpt-6.1-sol');
  assert.equal((await h.start()).body.error, 'selected_model_not_visible');
  assert.equal((await h.post('/api/translation-model', { model: 'custom-future-model' })).status, 200);
  assert.equal(h.gateway.state.selectionError, null);
  assert.doesNotMatch(JSON.stringify(h.gateway.state), /private account detail/);
  assert.equal(h.workers.length, 0); assert.equal(h.poolCalls.length, 0);
});

test('selection does not race a capture startup and can update the next session while an old pool closes', async t => {
  const catalogReady = deferred(), poolClosed = deferred(); let holdCatalog = true;
  const h = await harness(t, { listModels: async (options, current) => {
    if (current.catalogChecks > 1 && holdCatalog) await catalogReady.promise;
    return { catalogSource: 'codex_model_list', models: [
      { slug: 'gpt-6.1-sol', display_name: 'Old', input_modalities: ['text'] },
      { slug: 'custom-future-model', display_name: 'New', input_modalities: ['text'] },
    ] };
  }, closePool: async () => { await poolClosed.promise; return { termination_confirmed: true }; },
  release: () => { catalogReady.resolve(); poolClosed.resolve(); } });
  const starting = h.start(); await until(() => h.gateway.state.captureStarting && h.catalogChecks === 2);
  assert.equal((await h.post('/api/translation-model', { model: 'custom-future-model' })).body.error, 'translation_model_change_busy');
  assert.equal(h.gateway.state.selectedModel, 'gpt-6.1-sol');
  holdCatalog = false; catalogReady.resolve(); assert.equal((await starting).status, 200);
  await h.post('/stop'); await until(() => h.gateway.state.residentClosing);
  assert.equal((await h.post('/api/translation-model', { model: 'custom-future-model' })).status, 200);
  assert.equal(h.poolCalls.length, 1); assert.equal(h.gateway.state.session.model, 'gpt-6.1-sol');
  poolClosed.resolve(); await until(() => !h.gateway.state.residentClosing);
  assert.equal((await h.post('/start', { source: 'public_replay', concurrency: 1 })).status, 200);
  assert.equal(h.poolCalls[1].model.slug, 'custom-future-model');
  await h.post('/stop'); await until(() => h.pools[1].closed);
});

test('explicit startup selection advances the model revision and unknown requested defaults remain recoverable', async t => {
  const h = await harness(t, { codexModel: 'not-listed-model' });
  assert.equal(h.gateway.state.selectedModel, 'not-listed-model'); assert.equal(h.gateway.state.selectionError, 'selected_model_not_visible');
  assert.equal((await h.post('/start', { source: 'public_replay', concurrency: 1 })).body.error, 'selected_model_not_visible');
  assert.equal(h.workers.length, 0);
  assert.equal((await h.start({ model: 'custom-future-model', concurrency: 1 })).status, 200);
  assert.equal(h.gateway.state.selectedModel, 'custom-future-model'); assert.equal(h.gateway.state.modelSelectionRevision, 1);
  await h.post('/stop'); await until(() => h.pools[0].closed);
});

test('unconfirmed catalog process termination blocks further catalog requests and capture reuse', async t => {
  const h = await harness(t, { listModels: async () => { throw Object.assign(new Error('private detail'), {
    safeCode: 'appserver_catalog_close_failed', diagnostics: { termination_confirmed: false },
  }); } });
  assert.equal(h.gateway.state.catalogError, 'appserver_catalog_close_failed');
  assert.equal(h.gateway.state.cliProcessExitUnconfirmed, true);
  assert.ok(h.gateway.state.warnings.includes('catalog_process_termination_unconfirmed'));
  const checks = h.checks, catalogChecks = h.catalogChecks;
  assert.equal((await h.start()).body.error, 'codex_cli_process_exit_unconfirmed');
  assert.equal((await h.post('/cli/check')).body.error, 'codex_cli_process_exit_unconfirmed');
  assert.equal(h.checks, checks); assert.equal(h.catalogChecks, catalogChecks);
  assert.equal(h.workers.length, 0); assert.equal(h.poolCalls.length, 0);
});
