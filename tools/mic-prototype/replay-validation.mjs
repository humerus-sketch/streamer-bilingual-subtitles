import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TERMINALS = { codex_resident: 'turn/completed', codex_cli: 'turn.completed', siwc: 'response.completed' };
const idle = state => !state.workerActive && !state.captureStarting && !state.residentClosing
  && !state.queue?.active && !state.queue?.pending && !state.queue?.cleanup;
const rowMatchesSession = (row, sessionId) => row?.workerSessionId === sessionId
  && Number.isSafeInteger(row.segmentId) && row.segmentId >= 0 && Number.isSafeInteger(row.revision) && row.revision > 0;
function strictBilingualCompleted(row, sessionId, provider) {
  const translation = row?.translation, diagnostics = row?.translationDiagnostics;
  return rowMatchesSession(row, sessionId) && row.status === 'completed' && row.terminal === true
    && translation && typeof translation === 'object' && !Array.isArray(translation)
    && Object.keys(translation).sort().join(',') === 'en,zh'
    && ['zh', 'en'].every(language => typeof translation[language] === 'string' && translation[language].trim())
    && Boolean(TERMINALS[provider]) && diagnostics?.terminal_event === TERMINALS[provider] && diagnostics?.final_status === 'completed';
}
function visibleAcknowledged(row, sessionId, requireViewportProof = false) {
  return rowMatchesSession(row, sessionId) && row.visibleEligible === true && Number.isFinite(row.visibleNodeMs)
    && Number.isFinite(row.orderedAtNodeMs) && Number.isFinite(row.visibilityClockUncertaintyMs)
    && row.visibilityClockUncertaintyMs >= 0 && row.visibilityClockUncertaintyMs <= 500
    && row.visibleNodeMs >= row.orderedAtNodeMs - row.visibilityClockUncertaintyMs
    && (!requireViewportProof || row.visibilityProof?.version === 1
      && row.visibilityProof.documentHidden === false && row.visibilityProof.bothFullyInViewport === true);
}
const allRows = (rows, check) => Array.isArray(rows) && rows.length > 0 && rows.every(check)
  && new Set(rows.map(row => `${row.segmentId}:${row.revision}`)).size === rows.length;
const modelSlug = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function modelEvidenceFor(row, requestedModel, provider) {
  const request = row.translationDiagnostics?.request;
  const selected = row.requestedModel?.slug ?? null, translationModel = row.translationModel ?? null;
  const requestModel = request?.model ?? null, resolvedThreadModel = request?.resolved_thread_model ?? null;
  const responseModel = row.responseModel ?? null;
  return { segmentId: row.segmentId, revision: row.revision, selectedModel: selected, translationModel, requestModel,
    resolvedThreadModel, responseModel,
    requestVerified: selected === requestedModel && translationModel === requestedModel && requestModel === requestedModel,
    resolvedThreadVerified: provider === 'codex_resident' ? resolvedThreadModel === requestedModel : null,
    servedResponseVerified: responseModel === null ? null : responseModel === requestedModel };
}

/** Explicit public-file replay only. Never selects a microphone or manufactures a browser acknowledgement. */
export async function validateReplay({ origin, label, outputDir, replayId, workerId, model, concurrency = 2, computeType = 'int8_float16', timeoutMs = 150_000,
  requireVisibleAcknowledgements = false, visibilityTimeoutMs = 15_000 } = {},
{ fetchImpl = fetch, readFileImpl = readFile, writeFileImpl = writeFile, mkdirImpl = mkdir,
  now = () => performance.now(), waitImpl = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash
    || url.username || url.password || !/^[A-Za-z0-9_-]{1,40}$/.test(label) || ![1, 2].includes(concurrency)
    || replayId !== undefined && (typeof replayId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(replayId))
    || workerId !== undefined && (typeof workerId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(workerId))
    || model !== undefined && !modelSlug(model)
    || !['int8_float16', 'float16'].includes(computeType) || typeof requireVisibleAcknowledgements !== 'boolean'
    || ![timeoutMs, visibilityTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 3_600_000)
    || typeof outputDir !== 'string' || !outputDir
    || ![fetchImpl, readFileImpl, writeFileImpl, mkdirImpl, now, waitImpl].every(value => typeof value === 'function')) throw new Error('invalid_replay_validation_options');
  const base = url.origin;
  const get = async (path, limitMs = 10_000) => {
    const response = await fetchImpl(base + path, { signal: AbortSignal.timeout(Math.max(1, Math.ceil(limitMs))) });
    if (!response.ok) throw new Error('local_read_failed_' + response.status);
    return response.json();
  };
  const state = await get('/state');
  if (state.workerActive || state.captureStarting || state.residentClosing || state.queue?.active || state.queue?.pending || state.queue?.cleanup
    || state.auth !== 'authorized' || !state.replayAvailable) throw new Error('replay_not_ready');
  const requestedModel = model ?? state.selectedModel;
  if (!modelSlug(requestedModel)) throw new Error('replay_selected_model_required');
  const htmlResponse = await fetchImpl(base + '/', { signal: AbortSignal.timeout(10_000) });
  const capability = (await htmlResponse.text()).match(/const capability='([^']+)'/)?.[1];
  if (!capability) throw new Error('local_capability_unavailable');
  const post = async (path, body) => {
    const response = await fetchImpl(base + path, { method: 'POST', headers: { origin: base,
      'content-type': 'application/json', 'x-prototype-capability': capability }, body: JSON.stringify(body), signal: AbortSignal.timeout(75_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(/^[a-zA-Z0-9_.:-]+$/.test(value.error ?? '') ? value.error : 'local_request_failed');
    return value;
  };
  await mkdirImpl(outputDir, { recursive: true });
  const startedAt = new Date().toISOString(), begin = now();
  let started;
  try {
  started = await post('/start', { source: 'public_replay', model: requestedModel, computeType, concurrency, record: false,
    ...(replayId === undefined ? {} : { replayId }), ...(workerId === undefined ? {} : { workerId }) });
  let final;
  while (now() - begin < timeoutMs) {
    final = await get('/state', Math.min(10_000, timeoutMs - (now() - begin)));
    if (final.session?.id !== started.sessionId) throw new Error('replay_session_changed');
    if (idle(final)) break;
    await waitImpl(Math.min(500, Math.max(0, timeoutMs - (now() - begin))));
  }
  if (!final || !idle(final)) throw new Error('replay_validation_timeout');
  const visibilityBegin = now();
  let visibilityWaitTimedOut = false;
  if (requireVisibleAcknowledgements) {
    // Only server-accepted ACKs with the page's measured viewport proof can pass. Never POST /visible here.
    while (allRows(final.rows, row => strictBilingualCompleted(row, started.sessionId, final.provider))
      && !allRows(final.rows, row => visibleAcknowledged(row, started.sessionId, true))) {
      const remaining = visibilityTimeoutMs - (now() - visibilityBegin);
      if (remaining <= 0) { visibilityWaitTimedOut = true; break; }
      await waitImpl(Math.min(250, remaining));
      if (now() - visibilityBegin >= visibilityTimeoutMs) { visibilityWaitTimedOut = true; break; }
      try { final = await get('/state', Math.min(10_000, visibilityTimeoutMs - (now() - visibilityBegin))); }
      catch (error) { if (now() - visibilityBegin >= visibilityTimeoutMs) { visibilityWaitTimedOut = true; break; } throw error; }
      if (final.session?.id !== started.sessionId) throw new Error('replay_session_changed');
      if (!idle(final)) throw new Error('replay_became_active');
    }
  } else {
    // Historical chain-only runs keep their brief settling period; it never establishes page acceptance.
    await waitImpl(1000);
  }
  const visibilityWaitMs = Math.round((now() - visibilityBegin) * 1000) / 1000;
  await post('/save', { sessionId: started.sessionId });
  const report = JSON.parse(await readFileImpl(join(started.outputDir, 'report.json'), 'utf8'));
  if (report.session?.id !== started.sessionId || !Array.isArray(report.rows) || !Array.isArray(report.warnings)) throw new Error('invalid_replay_report');
  const strictCompleted = allRows(report.rows, row => strictBilingualCompleted(row, started.sessionId, final.provider));
  const visibilityComplete = allRows(report.rows, row => visibleAcknowledged(row, started.sessionId, true));
  const modelEvidence = report.rows.map(row => modelEvidenceFor(row, requestedModel, final.provider));
  const modelVerificationPassed = report.session.model === requestedModel && modelEvidence.length > 0
    && modelEvidence.every(item => item.requestVerified && item.resolvedThreadVerified !== false && item.servedResponseVerified !== false);
  const chainPassed = final.phase === 'capture_stopped' && report.rows.length > 0 && report.rows.every(row => row.status === 'completed')
    && report.warnings.length === 0 && !final.cliProcessExitUnconfirmed;
  const record = { schemaVersion: 1, label, provider: final.provider, startedAt, finishedAt: new Date().toISOString(),
    sessionId: started.sessionId, outputDir: started.outputDir, source: 'public_replay', microphoneOpened: false,
    computeType, concurrency, timeoutMs,
    requestedModel, sessionModel: report.session.model ?? null, modelVerificationPassed, modelEvidence,
    modelObservation: 'Requests and resident resolved thread configuration are checked separately. A null responseModel means the served response model was not reported; it is not inferred from the requested model.',
    requestedReplayId: replayId ?? null, actualReplayFile: typeof report.session.replayFile === 'string' ? report.session.replayFile : null,
    actualReplayId: typeof report.session.replayId === 'string' ? report.session.replayId : null,
    requestedWorkerId: workerId ?? null, actualWorkerId: report.session.workerId ?? null,
    actualWorkerScript: report.session.workerScript ?? null,
    segments: report.rows.length, completed: report.rows.filter(row => row.status === 'completed').length,
    visibleAcknowledged: report.rows.filter(row => Number.isFinite(row.visibleNodeMs)).length,
    strictBilingualCompleted: report.rows.filter(row => strictBilingualCompleted(row, started.sessionId, final.provider)).length,
    visibleAcknowledgedWithProof: report.rows.filter(row => visibleAcknowledged(row, started.sessionId, true)).length,
    requireVisibleAcknowledgements, visibilityTimeoutMs, visibilityWaitMs,
    visibilityWaitTimedOut, chainPassed, pageAcceptancePassed: chainPassed && modelVerificationPassed && strictCompleted && visibilityComplete && !visibilityWaitTimedOut,
    passed: chainPassed && modelVerificationPassed && (!requireVisibleAcknowledgements || strictCompleted && visibilityComplete && !visibilityWaitTimedOut),
    visibilityEvidence: report.rows.map(row => ({ segmentId: row.segmentId, revision: row.revision,
      visibleNodeMs: Number.isFinite(row.visibleNodeMs) ? row.visibleNodeMs : null,
      viewportProofAccepted: visibleAcknowledged(row, started.sessionId, true) })),
    warnings: report.warnings, resident: final.resident ?? null,
    endpoint: 'VAD-estimated audio end to strict bilingual completion; page acceptance additionally requires every actual page ACK with visible viewport proof.' };
  await writeFileImpl(join(outputDir, label + '.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  if (!record.passed) throw new Error(!chainPassed ? 'public_replay_chain_failed' : !modelVerificationPassed ? 'public_replay_model_mismatch' : !strictCompleted
    ? 'public_replay_bilingual_incomplete' : visibilityWaitTimedOut ? 'public_replay_visibility_timeout' : 'public_replay_visibility_incomplete');
  return record;
  } catch (error) {
    // Only stop this known session; a failed or timed-out start must never stop another caller's run.
    let stopRequested = false;
    if (started?.sessionId) {
      try {
        const current = await get('/state');
        if (current.session?.id === started.sessionId && (current.workerActive || current.captureStarting)) {
          await post('/stop', {}); stopRequested = true;
        }
      } catch {}
    }
    await writeFileImpl(join(outputDir, label + '-failure.json'), JSON.stringify({ label, startedAt,
      sessionId: started?.sessionId ?? null, stopRequested, startOutcomeUnknown: !started,
      errorCode: /^[a-zA-Z0-9_.:-]+$/.test(error.message) ? error.message : 'replay_check_failed',
      note: 'A start timeout without a returned session ID requires checking the local page before retrying; no unknown session is stopped.' }, null, 2) + '\n', { flag: 'wx' });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [origin, label, outputDir] = process.argv.slice(2);
  validateReplay({ origin, label, outputDir }).then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error(JSON.stringify({ error: /^[a-zA-Z0-9_.:-]+$/.test(error.message) ? error.message : 'replay_check_failed' })); process.exitCode = 1;
  });
}
