import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { validateReplay } from './replay-validation.mjs';

const sessionId = 'public-replay-owned';
const capability = 'PRIVATE_LOCAL_CAPABILITY';
const proof = () => ({ version: 1, documentHidden: false, bothFullyInViewport: true,
  viewport: { width: 1200, height: 900 }, targets: {
    zh: { top: 100, left: 20, right: 600, bottom: 140, width: 580, height: 40 },
    en: { top: 150, left: 20, right: 600, bottom: 190, width: 580, height: 40 } } });
const row = (segmentId = 1, acknowledged = false) => ({ workerSessionId: sessionId, segmentId, revision: 1,
  status: 'completed', terminal: true, translation: { zh: '测试字幕', en: 'Test subtitle' },
  requestedModel: { slug: 'gpt-6.1-sol' }, translationModel: 'gpt-6.1-sol', responseModel: null,
  translationDiagnostics: { request: { model: 'gpt-6.1-sol', resolved_thread_model: 'gpt-6.1-sol' }, terminal_event: 'turn/completed', final_status: 'completed' }, visibleEligible: true,
  orderedAtNodeMs: 100, ...(acknowledged ? { visibleNodeMs: 120, visibilityClockUncertaintyMs: 1, visibilityProof: proof() } : {}) });

function harness({ rowsAt = () => [row()], stateAt, reportAt, startError, provider = 'codex_resident', selectedModel = 'gpt-6.1-sol' } = {}) {
  let clock = 0, started = false, stopped = false, stateReads = 0, startedModel;
  const calls = [], writes = new Map(), waits = [], options = { origin: 'http://127.0.0.1:51718/', label: 'visible-test', outputDir: '/mock/driver',
    requireVisibleAcknowledgements: true, visibilityTimeoutMs: 2000, timeoutMs: 5000 };
  const currentState = () => ({ provider, phase: 'capture_stopped', workerActive: false, captureStarting: false,
    residentClosing: false, queue: { active: 0, pending: 0, cleanup: 0 }, session: { id: sessionId }, rows: rowsAt(clock),
    ...(stateAt?.({ clock, stateReads, stopped }) ?? {}) });
  const dependencies = {
    now: () => clock,
    waitImpl: async ms => { assert.ok(ms >= 0 && ms <= 1000); waits.push(ms); clock += ms; },
    mkdirImpl: async (path, flags) => { assert.equal(path, options.outputDir); assert.equal(flags.recursive, true); },
    fetchImpl: async (url, request = {}) => {
      const path = new URL(url).pathname, body = request.body ? JSON.parse(request.body) : null;
      calls.push({ path, method: request.method ?? 'GET', body });
      assert.ok(request.signal instanceof AbortSignal);
      if (path === '/state') {
        if (!started) return { ok: true, json: async () => ({ auth: 'authorized', replayAvailable: true, queue: {}, selectedModel }) };
        stateReads++; return { ok: true, json: async () => structuredClone(currentState()) };
      }
      if (path === '/') return { ok: true, text: async () => `const capability='${capability}'` };
      assert.equal(request.headers.origin, 'http://127.0.0.1:51718');
      assert.equal(request.headers['x-prototype-capability'], capability);
      if (path === '/start') {
        if (startError) throw new Error(startError);
        started = true; startedModel = body.model; return { ok: true, json: async () => ({ sessionId, outputDir: '/mock/worker' }) };
      }
      if (path === '/stop') { stopped = true; return { ok: true, json: async () => ({ stopped: true }) }; }
      if (path === '/save') {
        assert.equal(body.sessionId, sessionId);
        const override = reportAt?.(clock) ?? {};
        const value = { rows: rowsAt(clock), warnings: [], ...override, session: { id: sessionId, model: startedModel, ...override.session } };
        writes.set(join('/mock/worker', 'report.json'), JSON.stringify(value));
        return { ok: true, json: async () => ({ saved: true }) };
      }
      assert.fail(`Unexpected local operation: ${path}`);
    },
    readFileImpl: async (path, encoding) => { assert.equal(encoding, 'utf8'); assert.ok(writes.has(path)); return writes.get(path); },
    writeFileImpl: async (path, text, flags) => {
      assert.deepEqual(flags, { flag: 'wx' });
      if (writes.has(path)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      writes.set(path, text);
    },
  };
  return { options, dependencies, calls, writes, waits, clock: () => clock,
    record: () => JSON.parse(writes.get(join(options.outputDir, options.label + '.json'))),
    failure: () => JSON.parse(writes.get(join(options.outputDir, options.label + '-failure.json'))) };
}

test('default keeps historical chain-only acceptance but does not call missing ACKs page acceptance', async () => {
  const h = harness();
  const { requireVisibleAcknowledgements, ...legacyOptions } = h.options;
  assert.equal(requireVisibleAcknowledgements, true);
  const result = await validateReplay(legacyOptions, h.dependencies);
  assert.equal(result.passed, true); assert.equal(result.chainPassed, true); assert.equal(result.pageAcceptancePassed, false);
  assert.equal(result.requireVisibleAcknowledgements, false); assert.equal(result.visibleAcknowledged, 0);
  assert.deepEqual(h.waits, [1000]);
  assert.deepEqual(h.calls.find(call => call.path === '/start').body,
    { source: 'public_replay', model: 'gpt-6.1-sol', computeType: 'int8_float16', concurrency: 2, record: false });
  assert.ok(h.calls.every(call => !['/visible', '/authorize', '/cli/check'].includes(call.path)));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LOCAL_CAPABILITY/);
});

test('all strict complete bilingual rows with accepted viewport ACKs pass without invented waits or acknowledgements', async () => {
  const h = harness({ rowsAt: () => [row(1, true), row(2, true)] });
  const result = await validateReplay({ ...h.options, computeType: 'float16', concurrency: 1 }, h.dependencies);
  assert.equal(result.passed, true); assert.equal(result.pageAcceptancePassed, true); assert.equal(result.strictBilingualCompleted, 2);
  assert.equal(result.visibleAcknowledgedWithProof, 2); assert.equal(result.visibilityWaitMs, 0); assert.deepEqual(h.waits, []);
  assert.equal(h.calls.find(call => call.path === '/start').body.computeType, 'float16');
  assert.ok(h.calls.every(call => call.path !== '/visible'));
});

test('default start preserves the currently selected model and explicit model can select a different round without a hardcoded override', async () => {
  const model = 'another-codex-model';
  const modelRow = () => {
    const value = row(1, true);
    value.requestedModel.slug = model; value.translationModel = model;
    value.translationDiagnostics.request = { model, resolved_thread_model: model };
    return value;
  };
  for (const explicit of [false, true]) {
    const h = harness({ selectedModel: explicit ? 'gpt-6.1-sol' : model, rowsAt: () => [modelRow()] });
    const result = await validateReplay({ ...h.options, ...(explicit ? { model } : {}) }, h.dependencies);
    assert.equal(h.calls.find(call => call.path === '/start').body.model, model);
    assert.equal(result.requestedModel, model); assert.equal(result.sessionModel, model);
    assert.equal(result.modelVerificationPassed, true); assert.equal(result.pageAcceptancePassed, true);
    assert.equal(result.modelEvidence[0].requestVerified, true); assert.equal(result.modelEvidence[0].resolvedThreadVerified, true);
    assert.equal(result.modelEvidence[0].responseModel, null); assert.equal(result.modelEvidence[0].servedResponseVerified, null);
    assert.ok(h.calls.every(call => call.path !== '/api/translation-model' && call.path !== '/visible'));
  }
});

test('model mismatch or missing resident resolved configuration fails despite complete bilingual page ACKs', async () => {
  const variants = [
    value => { value.requestedModel.slug = 'other-model'; },
    value => { delete value.requestedModel; },
    value => { value.translationModel = 'other-model'; },
    value => { value.translationDiagnostics.request.model = 'other-model'; },
    value => { value.translationDiagnostics.request.resolved_thread_model = 'other-model'; },
    value => { delete value.translationDiagnostics.request.resolved_thread_model; },
    value => { value.responseModel = 'different-reported-response-model'; },
  ];
  for (const mutate of variants) {
    const h = harness({ rowsAt: () => { const value = row(1, true); mutate(value); return [value]; } });
    await assert.rejects(() => validateReplay(h.options, h.dependencies), /public_replay_model_mismatch/);
    assert.equal(h.record().chainPassed, true); assert.equal(h.record().visibleAcknowledgedWithProof, 1);
    assert.equal(h.record().modelVerificationPassed, false); assert.equal(h.record().pageAcceptancePassed, false);
    assert.equal(h.failure().errorCode, 'public_replay_model_mismatch');
  }
  const h = harness({ rowsAt: () => [row(1, true)], reportAt: () => ({ session: { model: 'other-session-model' } }) });
  await assert.rejects(() => validateReplay(h.options, h.dependencies), /public_replay_model_mismatch/);
  assert.equal(h.record().sessionModel, 'other-session-model'); assert.equal(h.record().passed, false);
});

test('exec request verification does not fabricate a resolved thread or served response model', async () => {
  const h = harness({ provider: 'codex_cli', rowsAt: () => {
    const value = row(1, true); value.translationDiagnostics.terminal_event = 'turn.completed';
    delete value.translationDiagnostics.request.resolved_thread_model;
    return [value];
  } });
  const result = await validateReplay(h.options, h.dependencies);
  assert.equal(result.modelVerificationPassed, true); assert.equal(result.pageAcceptancePassed, true);
  assert.equal(result.modelEvidence[0].resolvedThreadModel, null);
  assert.equal(result.modelEvidence[0].resolvedThreadVerified, null); assert.equal(result.modelEvidence[0].servedResponseVerified, null);
});

test('a missing selected model never silently falls back and never starts audio', async () => {
  const h = harness({ selectedModel: null });
  await assert.rejects(() => validateReplay(h.options, h.dependencies), /replay_selected_model_required/);
  assert.deepEqual(h.calls.map(call => call.path), ['/state']);
});

test('optional replay ID is the only added start selector and records the actual saved session file and ID', async () => {
  const replayFile = 'D:/public-samples/registered-reverse.wav';
  const h = harness({ rowsAt: () => [row(1, true)], reportAt: () => ({ session: { id: sessionId, replayId: 'reverse', replayFile } }) });
  const result = await validateReplay({ ...h.options, replayId: 'reverse' }, h.dependencies);
  const start = h.calls.find(call => call.path === '/start').body;
  assert.equal(start.replayId, 'reverse'); assert.equal('replayFile' in start, false); assert.equal('file' in start, false);
  assert.equal(result.requestedReplayId, 'reverse'); assert.equal(result.actualReplayId, 'reverse'); assert.equal(result.actualReplayFile, replayFile);
  const legacy = harness({ rowsAt: () => [row(1, true)] });
  const previous = await validateReplay(legacy.options, legacy.dependencies);
  assert.equal('replayId' in legacy.calls.find(call => call.path === '/start').body, false);
  assert.equal(previous.requestedReplayId, null); assert.equal(previous.actualReplayId, null); assert.equal(previous.actualReplayFile, null);
});

test('worker comparison selector never sends a path and records the saved script selection', async () => {
  const workerScript = 'D:/frozen/worker.py';
  const h = harness({ rowsAt: () => [row(1, true)], reportAt: () => ({ session: { id: sessionId, workerId: 'baseline', workerScript } }) });
  const result = await validateReplay({ ...h.options, workerId: 'baseline' }, h.dependencies);
  const body = h.calls.find(call => call.path === '/start').body;
  assert.equal(body.workerId, 'baseline'); assert.equal('workerScript' in body, false);
  assert.equal(result.requestedWorkerId, 'baseline'); assert.equal(result.actualWorkerId, 'baseline');
  assert.equal(result.actualWorkerScript, workerScript);
});

test('real ACKs delayed beyond one second are polled until all distinct segments have proof', async () => {
  const h = harness({ rowsAt: clock => [row(1, clock >= 250), row(2, clock >= 1250)] });
  const result = await validateReplay(h.options, h.dependencies);
  assert.equal(result.passed, true); assert.equal(result.visibilityWaitMs, 1250); assert.equal(result.visibleAcknowledgedWithProof, 2);
  assert.equal(result.visibilityWaitTimedOut, false); assert.equal(h.waits.length, 5);
  assert.equal(h.calls.filter(call => call.path === '/save').length, 1);
});

test('missing ACK times out within its bound, saves an explicit failed acceptance report and never manufactures visibility', async () => {
  const h = harness();
  await assert.rejects(() => validateReplay({ ...h.options, visibilityTimeoutMs: 1000 }, h.dependencies), /public_replay_visibility_timeout/);
  const result = h.record();
  assert.equal(h.clock(), 1000); assert.equal(result.passed, false); assert.equal(result.chainPassed, true);
  assert.equal(result.pageAcceptancePassed, false); assert.equal(result.visibleAcknowledged, 0); assert.equal(result.visibilityWaitTimedOut, true);
  assert.equal(result.visibilityEvidence[0].visibleNodeMs, null); assert.equal(result.visibilityEvidence[0].viewportProofAccepted, false);
  assert.equal(h.failure().errorCode, 'public_replay_visibility_timeout'); assert.equal(h.failure().stopRequested, false);
  assert.ok(h.calls.every(call => call.path !== '/visible' && call.path !== '/stop'));
});

test('legacy ACK without proof is retained but cannot pass required page acceptance', async () => {
  const h = harness({ rowsAt: () => { const value = row(1, true); delete value.visibilityProof; return [value]; } });
  await assert.rejects(() => validateReplay({ ...h.options, visibilityTimeoutMs: 500 }, h.dependencies), /public_replay_visibility_timeout/);
  assert.equal(h.record().visibleAcknowledged, 1); assert.equal(h.record().visibleAcknowledgedWithProof, 0);
  assert.equal(h.record().visibilityEvidence[0].visibleNodeMs, 120); assert.equal(h.record().passed, false);
});

test('an ACK first captured in the save snapshot after the wait deadline is retained without passing the expired acceptance', async () => {
  const h = harness({ rowsAt: clock => [row(1, clock >= 1000)] });
  await assert.rejects(() => validateReplay({ ...h.options, visibilityTimeoutMs: 1000 }, h.dependencies), /public_replay_visibility_timeout/);
  assert.equal(h.record().visibleAcknowledgedWithProof, 1); assert.equal(h.record().visibilityWaitTimedOut, true);
  assert.equal(h.record().pageAcceptancePassed, false); assert.equal(h.record().passed, false);
});

test('hidden, incomplete, wrong-version, invalid-clock or foreign-session ACK evidence never passes', async () => {
  const variants = [value => { value.visibilityProof.documentHidden = true; }, value => { value.visibilityProof.bothFullyInViewport = false; },
    value => { value.visibilityProof.version = 2; }, value => { value.visibilityClockUncertaintyMs = 501; },
    value => { value.visibleNodeMs = 0; }, value => { value.workerSessionId = 'foreign-session'; }];
  for (const mutate of variants) {
    const h = harness({ rowsAt: () => { const value = row(1, true); mutate(value); return [value]; } });
    await assert.rejects(() => validateReplay({ ...h.options, visibilityTimeoutMs: 500 }, h.dependencies), /public_replay_(visibility_timeout|bilingual_incomplete)/);
    assert.equal(h.record().passed, false); assert.equal(h.record().pageAcceptancePassed, false);
  }
});

test('one incomplete language, missing successful terminal, or duplicated segment cannot pass even with ACKs', async () => {
  const variants = [value => { delete value.translation.en; }, value => { value.translation.en = ' '; },
    value => { value.translation.extra = 'not allowed'; }, value => { value.terminal = false; },
    value => { value.translationDiagnostics.final_status = 'failed'; }, value => { value.translationDiagnostics.terminal_event = 'response.completed'; }];
  for (const mutate of variants) {
    const h = harness({ rowsAt: () => { const value = row(1, true); mutate(value); return [value]; } });
    await assert.rejects(() => validateReplay(h.options, h.dependencies), /public_replay_bilingual_incomplete/);
    assert.equal(h.record().passed, false); assert.equal(h.record().strictBilingualCompleted, 0); assert.equal(h.clock(), 0);
  }
  const h = harness({ rowsAt: () => [row(1, true), row(1, true)] });
  await assert.rejects(() => validateReplay(h.options, h.dependencies), /public_replay_bilingual_incomplete/);
  assert.equal(h.record().passed, false);
});

test('strict page acceptance recognizes only the matching successful provider terminal', async () => {
  for (const [provider, terminal] of [['codex_resident', 'turn/completed'], ['codex_cli', 'turn.completed'], ['siwc', 'response.completed']]) {
    const h = harness({ provider, rowsAt: () => { const value = row(1, true); value.translationDiagnostics.terminal_event = terminal; return [value]; } });
    assert.equal((await validateReplay(h.options, h.dependencies)).pageAcceptancePassed, true);
  }
});

test('all process and queue cleanup must drain before the bounded ACK waiting starts', async () => {
  const h = harness({ rowsAt: clock => [row(1, clock >= 1750)], stateAt: ({ clock }) => clock < 1500
    ? { residentClosing: true, queue: { active: 0, pending: 0, cleanup: 1 } } : {} });
  const result = await validateReplay(h.options, h.dependencies);
  assert.equal(result.passed, true); assert.equal(h.clock(), 1750); assert.equal(result.visibilityWaitMs, 250);
});

test('active replay timeout stops only its known owned capture and records the failure', async () => {
  const h = harness({ stateAt: ({ stopped }) => ({ workerActive: !stopped, phase: stopped ? 'capture_stopped' : 'capturing' }) });
  await assert.rejects(() => validateReplay({ ...h.options, timeoutMs: 1000 }, h.dependencies), /replay_validation_timeout/);
  assert.equal(h.calls.filter(call => call.path === '/stop').length, 1); assert.equal(h.failure().stopRequested, true);
  assert.equal(h.failure().sessionId, sessionId); assert.equal(h.failure().startOutcomeUnknown, false);
});

test('unknown start outcome and changed sessions never stop another caller and never fabricate a saved acceptance', async () => {
  for (const settings of [{ startError: 'local_start_timeout' }, { stateAt: () => ({ session: { id: 'another-session' }, workerActive: true }) }]) {
    const h = harness(settings);
    await assert.rejects(() => validateReplay(h.options, h.dependencies), /local_start_timeout|replay_session_changed/);
    assert.ok(h.calls.every(call => call.path !== '/stop' && call.path !== '/save'));
    assert.equal(h.failure().stopRequested, false); assert.equal(h.failure().startOutcomeUnknown, Boolean(settings.startError));
  }
});

test('snapshot without complete ACKs cannot pass after an optimistic state poll; warnings and session mismatch also fail', async () => {
  const h = harness({ rowsAt: () => [row(1, true)], reportAt: () => ({ rows: [row()] }) });
  await assert.rejects(() => validateReplay(h.options, h.dependencies), /public_replay_visibility_incomplete/);
  assert.equal(h.record().passed, false); assert.equal(h.record().visibleAcknowledgedWithProof, 0);
  const warning = harness({ rowsAt: () => [row(1, true)], reportAt: () => ({ warnings: ['audio_gap'] }) });
  await assert.rejects(() => validateReplay(warning.options, warning.dependencies), /public_replay_chain_failed/);
  assert.equal(warning.record().passed, false);
  const foreign = harness({ rowsAt: () => [row(1, true)], reportAt: () => ({ session: { id: 'other' } }) });
  await assert.rejects(() => validateReplay(foreign.options, foreign.dependencies), /invalid_replay_report/);
});

test('invalid optional parameters fail before any local operation and new evidence writes never overwrite an existing label', async () => {
  for (const value of [{ computeType: 'int8' }, { requireVisibleAcknowledgements: 'true' }, { timeoutMs: 0 },
    { timeoutMs: Infinity }, { visibilityTimeoutMs: -1 }, { visibilityTimeoutMs: 3_600_001 }, { outputDir: '' },
    ...[null, '', 'a'.repeat(41), '../reverse', 'D:/private.wav', 'forward?file=other', {}, 1].map(replayId => ({ replayId })),
    ...[null, '', '../worker.py', 'D:/private.py', {}, 1].map(workerId => ({ workerId })),
    ...[null, '', 'bad model', '../model', {}, 1, 'x'.repeat(129)].map(model => ({ model })),
    { origin: 'http://user:password@127.0.0.1:51718/' }]) {
    const h = harness(); await assert.rejects(() => validateReplay({ ...h.options, ...value }, h.dependencies), /invalid_replay_validation_options/);
    assert.equal(h.calls.length, 0);
  }
  const h = harness({ rowsAt: () => [row(1, true)] }), target = join(h.options.outputDir, h.options.label + '.json');
  h.writes.set(target, 'PRESERVE_EXISTING_EVIDENCE');
  await assert.rejects(() => validateReplay(h.options, h.dependencies), /EEXIST/);
  assert.equal(h.writes.get(target), 'PRESERVE_EXISTING_EVIDENCE');
});
