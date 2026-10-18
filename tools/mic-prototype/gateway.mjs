import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newAttempt, consumeCallback, verifyIdentity } from '../siwc-probe/probe.mjs';
import { createMemorySession } from '../siwc-probe/oauth-session.mjs';
import { listModels, parseBilingual } from '../siwc-probe/inference.mjs';
import { runObservedTranslation } from './translation-telemetry.mjs';
import { createSseChannel } from './sse-channel.mjs';
import { runCodexTranslation, checkCodexLogin } from './codex-translation.mjs';
import { createCodexResidentPool } from './codex-resident.mjs';
import { listCodexModels } from './codex-app-server.mjs';
import { createSpeakerController, publicSpeakerProfile } from './speaker-controller.mjs';
import { createPreviousTranslationContext } from './translation-context.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../..');
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const APP_NAME = 'Bilibili Subtitle SIWC Probe';
const ALLOWED_MODELS = ['gpt-6.1-sol', 'gpt-6-sol'];
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const now = () => performance.now();
function fail(code) { throw Object.assign(new Error(code), { safeCode: code }); }
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function safeCode(error) { return /^[A-Za-z0-9_.:-]{1,160}$/.test(error?.safeCode ?? error?.code ?? '') ? (error.safeCode ?? error.code) : 'prototype_request_failed'; }
function date8() { return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); }
const round = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
const difference = (end, start) => Number.isFinite(end) && Number.isFinite(start) ? round(end - start) : null;

/** A captured-replay-only test plan contains source coordinates and model IDs, never reference text. */
export function validateTestModelSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'intervals,sampleRate'
    || value.sampleRate !== 16000 || !Array.isArray(value.intervals) || !value.intervals.length || value.intervals.length > 200) fail('invalid_test_model_schedule');
  const ids = new Set(); let previousEnd = 0, previousOwnershipEnd = 0;
  const intervals = value.intervals.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'endSample,fixtureId,model,ownershipEndSample,ownershipStartSample,startSample'
      || typeof item.fixtureId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(item.fixtureId) || ids.has(item.fixtureId)
      || typeof item.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.model)
      || !Number.isSafeInteger(item.startSample) || !Number.isSafeInteger(item.endSample)
      || !Number.isSafeInteger(item.ownershipStartSample) || !Number.isSafeInteger(item.ownershipEndSample)
      || item.startSample < previousEnd || item.endSample <= item.startSample
      || item.ownershipStartSample !== previousOwnershipEnd || item.ownershipEndSample <= item.ownershipStartSample
      || item.startSample < item.ownershipStartSample || item.endSample > item.ownershipEndSample) fail('invalid_test_model_schedule');
    ids.add(item.fixtureId); previousEnd = item.endSample; previousOwnershipEnd = item.ownershipEndSample;
    return Object.freeze({ fixtureId: item.fixtureId, startSample: item.startSample, endSample: item.endSample,
      ownershipStartSample: item.ownershipStartSample, ownershipEndSample: item.ownershipEndSample, model: item.model });
  });
  const canonical = { sampleRate: value.sampleRate, intervals };
  return Object.freeze({ ...canonical, intervals: Object.freeze(intervals), sha256: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') });
}

export function matchTestModelSchedule(schedule, segment) {
  const output = { scheduleSha256: schedule.sha256, sampleRate: schedule.sampleRate, matches: [], routeSample: null, routeFixtureId: null,
    expectedModel: null, speechMatchCode: null, sourceModelAmbiguous: false, errorCode: null };
  if (segment.sampleRate !== schedule.sampleRate || !Number.isSafeInteger(segment.startSample) || !Number.isSafeInteger(segment.endSample)
    || segment.startSample < 0 || segment.endSample <= segment.startSample) return { ...output, errorCode: 'model_schedule_timing_invalid' };
  output.matches = schedule.intervals.map(item => ({ fixtureId: item.fixtureId, model: item.model,
    overlapSamples: Math.max(0, Math.min(segment.endSample, item.endSample) - Math.max(segment.startSample, item.startSample)) }))
    .filter(item => item.overlapSamples > 0);
  const models = new Set(output.matches.map(item => item.model));
  if (!models.size) output.speechMatchCode = 'model_schedule_unmatched';
  else if (models.size > 1) { output.speechMatchCode = 'model_schedule_ambiguous'; output.sourceModelAmbiguous = true; }
  output.routeSample = segment.endSample - 1;
  const owner = schedule.intervals.find(item => item.ownershipStartSample <= output.routeSample && output.routeSample < item.ownershipEndSample);
  // Never suppress background ASR using oracle speech labels: all owned input routes to translation.
  if (!owner) output.errorCode = 'model_schedule_ownership_unassigned';
  else { output.routeFixtureId = owner.fixtureId; output.expectedModel = owner.model; }
  return output;
}

/** A single ordered stream, bounded queued work, no retries and no silent drops. */
export class TranslationScheduler {
  constructor({ concurrency = 1, pendingLimit = 2, cleanupAllowance = 0, translate, onUpdate = () => {}, onOrdered = () => {}, onQueueChange = () => {}, onCleanupError = () => {} }) {
    if (![1, 2].includes(concurrency) || pendingLimit !== 2 || !Number.isInteger(cleanupAllowance) || cleanupAllowance < 0 || concurrency + cleanupAllowance > 4) fail('invalid_translation_limits');
    this.concurrency = concurrency; this.pendingLimit = pendingLimit; this.cleanupAllowance = cleanupAllowance; this.processLimit = concurrency + cleanupAllowance;
    this.translate = translate; this.onUpdate = onUpdate; this.onOrdered = onOrdered;
    this.onQueueChange = onQueueChange; this.onCleanupError = onCleanupError;
    this.active = 0; this.cleanup = 0; this.processesActive = 0; this.pending = []; this.entries = []; this.next = 0; this.ids = new Set(); this.closed = false;
  }
  enqueue(segment) {
    if (this.closed) fail('scheduler_closed');
    const key = `${segment.segmentId}:${segment.revision}`;
    if (this.ids.has(key)) return false;
    this.ids.add(key);
    const entry = { ...segment, order: this.entries.length, status: 'queued', queuedNodeMs: now() };
    this.entries.push(entry);
    if (this.pending.length >= this.pendingLimit) {
      Object.assign(entry, { status: 'gap', errorCode: 'translation_queue_overflow', terminal: true });
      this.onUpdate(entry); this.flush(); return false;
    }
    this.pending.push(entry); this.onUpdate(entry); this.pump(); return true;
  }
  addGap(segment, code) {
    const key = `${segment.segmentId}:${segment.revision ?? 1}`;
    if (this.ids.has(key)) return;
    this.ids.add(key);
    const entry = { ...segment, revision: segment.revision ?? 1, order: this.entries.length, status: 'gap', errorCode: code, terminal: true };
    this.entries.push(entry); this.onUpdate(entry); this.flush();
  }
  pump() {
    while (this.active < this.concurrency && this.processesActive < this.processLimit && this.pending.length) {
      const entry = this.pending.shift(); this.active++; this.processesActive++;
      let inferenceReleased = false, cleanupCounted = false;
      Object.assign(entry, { status: 'translating', requestStartNodeMs: now() }); this.onUpdate(entry);
      const commitOnce = (result, semantic = false) => {
        if (entry.terminal) return false;
        Object.assign(entry, { status: result.success ? 'completed' : 'failed', terminal: true,
          translation: result.translation ? structuredClone(result.translation) : null, translationTimingsMs: result.timings_ms ? { ...result.timings_ms } : null,
          translationUsage: result.telemetry?.usage ? structuredClone(result.telemetry.usage) : null,
          completionBoundary: semantic ? 'cli_turn_completed' : result.transport === 'codex_app_server' ? 'appserver_turn_completed' : 'transport_completed', processCleanupPending: result.process_cleanup_pending ?? false,
          translationDiagnostics: result.telemetry ? structuredClone({
            transport: result.telemetry.transport ?? 'siwc', process: result.telemetry.process ?? null,
            request: result.telemetry.request, event_first_ms: result.telemetry.event_first_ms,
            event_last_ms: result.telemetry.event_last_ms, event_counts: result.telemetry.event_counts,
            phase_first_ms: result.telemetry.phase_first_ms ?? null, phase_last_ms: result.telemetry.phase_last_ms ?? null,
            processing_headers_ms: result.telemetry.processing_headers_ms,
            body_read: result.telemetry.body_read,
            interpretation: result.telemetry.interpretation,
            terminal_event: result.telemetry.terminal_event, final_status: result.telemetry.final_status,
            resident: result.telemetry.resident ?? null,
            credentialWaitMs: result.credentialWaitMs ?? null,
          }) : null,
          translationEndNodeMs: now(), requestId: result.request_id ?? null, responseModel: result.response_model ?? null,
          errorCode: result.success ? null : result.error?.code ?? result.final_status ?? 'translation_failed' });
        this.onUpdate(entry); this.flush(); return true;
      };
      const semanticComplete = result => {
        if (entry.terminal || result?.success !== true || result.error || result.terminal_event !== 'turn.completed' || result.process_cleanup_pending !== true
          || (result.telemetry?.process?.rejected_tool_items ?? 0) > 0) return false;
        let translation;
        try { translation = parseBilingual(JSON.stringify(result.translation)); } catch { return false; }
        if (!translation || !commitOnce({ ...result, translation }, true)) return false;
        if (this.cleanupAllowance > 0) {
          // Release only the inference slot. The bounded process slot is owned until the final Promise closes.
          inferenceReleased = true; cleanupCounted = true; this.active--; this.cleanup++;
          this.pump();
        }
        return true;
      };
      const cleanup = (result, error = null) => {
        const code = error ? safeCode(error) : result.success ? null : result.error?.code ?? result.final_status ?? 'translation_cleanup_failed';
        entry.processCleanupPending = result?.process_cleanup_pending ?? (error ? null : false);
        entry.cleanup = { success: !error && result.success === true, errorCode: code, timingsMs: result?.timings_ms ? { ...result.timings_ms } : null,
          process: result?.telemetry?.process ? structuredClone(result.telemetry.process) : null };
        this.onUpdate(entry);
        if (code) this.onCleanupError(entry, code);
      };
      Promise.resolve().then(() => this.translate(entry, semanticComplete)).then(result => {
        if (!commitOnce(result)) cleanup(result);
      }, error => {
        if (entry.terminal) cleanup(null, error);
        else commitOnce({ success: false, error: { code: safeCode(error) } });
      }).finally(() => {
        if (!inferenceReleased) this.active--;
        if (cleanupCounted) this.cleanup--;
        this.processesActive--;
        this.pump();
      });
    }
    this.onQueueChange(this.stats());
  }
  flush() {
    while (this.entries[this.next]?.terminal) {
      const entry = this.entries[this.next++];
      entry.orderedAtNodeMs = now();
      this.onOrdered(entry);
    }
  }
  stats() {
    const stats = { active: this.active, pending: this.pending.length, total: this.entries.length, ordered: this.next };
    return this.cleanupAllowance > 0 ? { ...stats, cleanup: this.cleanup, processesActive: this.processesActive, processLimit: this.processLimit } : stats;
  }
}

/** Worker perf_counter and Node performance.now are separate clocks. Lowest RTT supplies an estimate and bound. */
export class WorkerClock {
  constructor() { this.pending = new Map(); this.best = null; }
  request(send, at = now()) { const id = randomUUID(); this.pending.set(id, at); send({ command: 'clock', id }); return id; }
  accept(event, received = now()) {
    const sent = this.pending.get(event.id); this.pending.delete(event.id);
    if (!Number.isFinite(sent) || !Number.isFinite(event.perfCounterMs) || received < sent) return false;
    const rttMs = received - sent;
    const sample = { offsetMs: (sent + received) / 2 - event.perfCounterMs, rttMs, uncertaintyMs: rttMs / 2 };
    if (!this.best || rttMs < this.best.rttMs) this.best = sample;
    return true;
  }
  toNode(value) { return this.best && Number.isFinite(value) ? value + this.best.offsetMs : null; }
}

export function latencyFor(entry) {
  const end = entry.audioEndNodeMs;
  return {
    audioEndSource: entry.audioEndSource ?? 'vad_frame_end', audioEndResolutionMs: entry.audioEndResolutionMs ?? 32,
    audioEndUncertaintyMs: Number.isFinite(entry.audioEndUncertaintyMs) ? entry.audioEndUncertaintyMs : null,
    audioTimingSource: entry.audioTimingSource ?? null, audioClockUncertaintyMs: round(entry.audioClockUncertaintyMs),
    clockUncertaintyMs: round(entry.clockUncertaintyMs),
    segmentationMs: difference(entry.vadCommitNodeMs, end),
    asrMs: difference(entry.asrEndNodeMs, entry.asrStartNodeMs),
    audioEndToAsrMs: difference(entry.asrEndNodeMs, end),
    queueMs: difference(entry.requestStartNodeMs, entry.queuedNodeMs),
    translationMs: difference(entry.translationEndNodeMs, entry.requestStartNodeMs),
    audioEndToCompletedMs: difference(entry.translationEndNodeMs, end),
    orderingWaitMs: difference(entry.orderedAtNodeMs, entry.translationEndNodeMs),
    endToEndVisibleMs: Number.isFinite(end) && Number.isFinite(entry.visibleNodeMs) ? round(entry.visibleNodeMs - end) : null,
    visibilityClockUncertaintyMs: round(entry.visibilityClockUncertaintyMs),
  };
}

async function jsonBody(request, max = 32768) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) fail('json_content_type_required');
  let body = '';
  for await (const chunk of request) { body += chunk.toString('utf8'); if (Buffer.byteLength(body) > max) fail('request_body_too_large'); }
  try { const value = JSON.parse(body); if (!value || Array.isArray(value) || typeof value !== 'object') fail('json_object_required'); return value; }
  catch (error) { if (error.safeCode) throw error; fail('invalid_json_body'); }
}
function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }

export function validatePageVisibilityProof(value) {
  if (!value || value.version !== 1 || value.documentHidden !== false || value.bothFullyInViewport !== true
    || value.animationFrames !== 2 || typeof value.focused !== 'boolean') fail('invalid_visibility_proof');
  const { width, height } = value.viewport ?? {};
  if (![width, height].every(number => Number.isFinite(number) && number > 0 && number <= 65536)) fail('invalid_visibility_proof');
  const targets = {};
  for (const language of ['zh', 'en']) {
    const box = value.targets?.[language];
    if (!box || !['top', 'left', 'right', 'bottom', 'width', 'height'].every(key => Number.isFinite(box[key]))
      || box.width <= 0 || box.height <= 0 || box.left < 0 || box.top < 0 || box.right > width || box.bottom > height
      || Math.abs(box.right - box.left - box.width) > 0.01 || Math.abs(box.bottom - box.top - box.height) > 0.01) fail('invalid_visibility_proof');
    targets[language] = Object.fromEntries(['top', 'left', 'right', 'bottom', 'width', 'height'].map(key => [key, box[key]]));
  }
  return { version: 1, documentHidden: false, focused: value.focused, animationFrames: 2,
    viewport: { width, height }, targets, bothFullyInViewport: true };
}

export async function createGateway(options = {}) {
  const provider = options.translationProvider ?? 'siwc';
  if (!['siwc', 'codex_cli', 'codex_resident'].includes(provider)) fail('invalid_translation_provider');
  const residentMode = provider === 'codex_resident';
  const execMode = provider === 'codex_cli';
  const cliMode = execMode || residentMode;
  const codexServiceTier = options.codexServiceTier ?? 'default';
  if (!['default', 'fast'].includes(codexServiceTier)) fail('invalid_codex_service_tier');
  const codexPromptStyle = options.codexPromptStyle === undefined ? 'full' : options.codexPromptStyle;
  if (!['full', 'source_only'].includes(codexPromptStyle)) fail('invalid_codex_prompt_style');
  if (codexPromptStyle !== 'full' && !residentMode) fail('codex_prompt_style_requires_resident');
  const codexExecutable = options.codexExecutable;
  if (cliMode && (typeof codexExecutable !== 'string' || !codexExecutable.trim())) fail('codex_executable_required');
  const cliWorkDir = resolve(options.cliWorkDir ?? join(workspace, '.runtime/mic-prototype/cli-work'));
  const cliInstructionsFile = options.cliInstructionsFile ?? join(here, 'translation-base.md');
  const checkCliLoginImpl = options.checkCodexLoginImpl ?? checkCodexLogin;
  const listCliModelsImpl = options.listCodexModelsImpl ?? listCodexModels;
  if (options.codexModel !== undefined && (typeof options.codexModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.codexModel))) fail('invalid_codex_model');
  const preferredCliModel = options.codexModel ?? 'gpt-6.1-sol';
  const createResidentImpl = options.createCodexResidentPoolImpl ?? createCodexResidentPool;
  const python = options.python ?? resolve(workspace, '.runtime/mic-prototype/.venv/Scripts/python.exe');
  const contextMode = options.translationContextMode ?? 'none';
  if (!['none', 'previous_translation'].includes(contextMode)) fail('invalid_translation_context_mode');
  const defaultComputeType = options.defaultComputeType ?? 'float16';
  if (!['float16', 'int8_float16'].includes(defaultComputeType)) fail('invalid_compute_type');
  const enhancementAllowed = options.allowEnhancement !== false;
  const speakerDefault = options.speakerAdmissionDefault === true;
  const speakerAssets = options.speakerAssets ?? null;
  let testSpeakerProfile = null;
  if (options.testSpeakerProfile !== undefined) {
    if (!speakerAssets || typeof options.testSpeakerProfile !== 'string' || !isAbsolute(options.testSpeakerProfile)) fail('invalid_test_speaker_profile');
    const bytes = await readFile(options.testSpeakerProfile);
    if (bytes.length > 65_536) fail('invalid_test_speaker_profile');
    const record = JSON.parse(bytes.toString('utf8'));
    if (record.sourceKind !== 'test_fixture') fail('test_speaker_profile_must_be_fixture');
    testSpeakerProfile = { path: options.testSpeakerProfile,
      profile: publicSpeakerProfile({ ...record, profileSha256: createHash('sha256').update(bytes).digest('hex') }) };
  }
  const modelDir = options.modelDir ?? resolve(workspace, '.runtime/mic-prototype/models/large-v3');
  const vadModel = options.vadModel ?? null;
  const workerScripts = new Map();
  if (options.workerScripts !== undefined) {
    if (!options.workerScripts || typeof options.workerScripts !== 'object' || Array.isArray(options.workerScripts)) fail('invalid_worker_catalog');
    for (const [id, file] of Object.entries(options.workerScripts)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || typeof file !== 'string' || !file.trim()) fail('invalid_worker_catalog');
      workerScripts.set(id, resolve(file));
    }
  }
  const replayFile = options.replayFile ? resolve(options.replayFile) : null;
  const enhancementAssets = options.enhancementAssets ?? null;
  if (enhancementAssets !== null && (typeof enhancementAssets !== 'string' || !isAbsolute(enhancementAssets)
    || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(enhancementAssets)
    || /[\u0000-\u001f\u007f-\u009f]/.test(enhancementAssets))) fail('invalid_enhancement_assets');
  const capturedReplayFiles = new Map();
  if (options.capturedReplayFiles !== undefined) {
    if (!options.capturedReplayFiles || typeof options.capturedReplayFiles !== 'object' || Array.isArray(options.capturedReplayFiles)) fail('invalid_captured_replay_catalog');
    for (const [id, file] of Object.entries(options.capturedReplayFiles)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || typeof file !== 'string' || !isAbsolute(file) || !/\.wav$/i.test(file)
        || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(file)
        || /[\u0000-\u001f\u007f-\u009f]/.test(file)) fail('invalid_captured_replay_catalog');
      capturedReplayFiles.set(id, file);
    }
  }
  const replayFiles = new Map();
  if (options.replayFiles !== undefined) {
    if (!options.replayFiles || typeof options.replayFiles !== 'object' || Array.isArray(options.replayFiles)) fail('invalid_replay_catalog');
    for (const [id, file] of Object.entries(options.replayFiles)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || typeof file !== 'string' || !file.trim()) fail('invalid_replay_catalog');
      replayFiles.set(id, resolve(file));
    }
  }
  const registrationDir = options.registrationDir ?? join(process.env.LOCALAPPDATA || process.env.APPDATA || '', 'Bilibili-SIWC-Probe');
  const spawnImpl = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;
  const catalogImpl = options.catalogImpl ?? listModels;
  const translateImpl = options.translateImpl ?? (cliMode ? runCodexTranslation : runObservedTranslation);
  const capability = randomBytes(32).toString('base64url');
  let origin, worker = null, tokens = null, pendingAuth = null, authBusy = false, discovery = null, jwks = null;
  let captureStarting = false, cancelCaptureStart = false;
  let captureStartDone = Promise.resolve(), finishCaptureStart = () => {};
  let residentPool = null, residentClosePromise = null;
  const residentClosedWaiters = new Set();
  let shuttingDown = false, cloudBlockedCode = null, cliProcessExitUnconfirmed = false;
  let registration = null, expectedIdentity = null, session = null, scheduler = null, workerClock = new WorkerClock();
  let saveTail = Promise.resolve();
  const translationBusy = () => Boolean(scheduler?.active || scheduler?.processesActive || scheduler?.pending.length);
  const schedulerBusy = () => translationBusy() || Boolean(residentClosePromise);
  const subscribers = new Set();
  const state = { phase: 'ready', provider, codexServiceTier: cliMode ? codexServiceTier : null, codexPromptStyle: cliMode ? codexPromptStyle : null, auth: 'unauthorized', message: cliMode ? '复用官方 Codex CLI 登录；仅点击开始后采音。' : '先刷新麦克风列表；需要翻译时点击官方授权。仅点击开始后采音。',
    expectedAccountGuard: false, authBusy: false, models: [], selectedModel: cliMode ? preferredCliModel : null, modelSelectionRevision: 0, selectionError: null, catalogSource: null, catalogError: null, replayAvailable: Boolean(replayFile || replayFiles.size), capturedReplayOptions: [...capturedReplayFiles.keys()].map(id => ({ id, label: id })), enhancementAssetsConfigured: enhancementAssets !== null, pageStatus: null, workerActive: false, captureStarting: false, residentClosing: false, resident: null, queue: { active: 0, pending: 0 }, session: null, rows: [], warnings: [], quotaQueried: false };
  let translationContext = createPreviousTranslationContext(), speakerMutationBusy = false;
  const speakerController = createSpeakerController({ python, script: join(here, 'speaker_admission.py'), assets: speakerAssets,
    profileDirectory: resolve(options.speakerProfileDirectory ?? join(options.outputBase ?? join(workspace, '.runtime/mic-prototype'), 'speaker-profiles')),
    spawnImpl, onChange: value => { state.speakerAdmission = value; publishState(); } });
  state.speakerAdmission = speakerController.snapshot();
  state.translationContextMode = contextMode; state.enhancementAllowed = enhancementAllowed;
  function persist(record) {
    if (!session) return;
    const path = join(session.outputDir, 'events.jsonl');
    // Freeze evidence when observed; queued disk writes must not serialize later row mutations.
    const line = JSON.stringify({ ...record, observedAt: new Date().toISOString() }) + '\n';
    saveTail = saveTail.then(() => appendFile(path, line)).catch(() => {
      if (!state.warnings.includes('evidence_write_failed')) state.warnings.push('evidence_write_failed');
    });
  }
  function broadcast(type, data, record = false) {
    const event = { type, ...data };
    for (const subscriber of subscribers) subscriber.send(event);
    if (record) persist(event);
  }
  function publishState() { state.authBusy = authBusy; state.queue = scheduler?.stats() ?? (execMode ? { active: 0, pending: 0, cleanup: 0, processesActive: 0, processLimit: null } : { active: 0, pending: 0 }); broadcast('state', { state }); }
  function closeResidentWhenDrained() {
    if (!residentPool || residentClosePromise || captureStarting || worker || translationBusy()) return residentClosePromise;
    const owned = residentPool;
    state.residentClosing = true;
    residentClosePromise = (async () => {
      try {
        const closed = await owned.close();
        state.resident = owned.diagnostics();
        persist({ type: 'resident_closed', result: closed, diagnostics: state.resident });
        if (closed.termination_confirmed !== true) {
          cliProcessExitUnconfirmed = true; state.cliProcessExitUnconfirmed = true;
          if (!state.warnings.includes('resident_termination_unconfirmed')) state.warnings.push('resident_termination_unconfirmed');
        } else if (closed.unusable_code) {
          const warning = 'resident_close_error:' + safeCode({ safeCode: closed.unusable_code });
          if (!state.warnings.includes(warning)) state.warnings.push(warning);
        }
      } catch (error) {
        cliProcessExitUnconfirmed = true; state.cliProcessExitUnconfirmed = true;
        if (!state.warnings.includes('resident_close_failed')) state.warnings.push('resident_close_failed');
        persist({ type: 'resident_close_error', code: safeCode(error) });
      } finally {
        residentPool = null; residentClosePromise = null; state.residentClosing = false;
        publishState(); for (const done of residentClosedWaiters) done(); residentClosedWaiters.clear();
      }
    })();
    publishState(); return residentClosePromise;
  }
  function updateRow(entry, ordered = false) {
    if (contextMode === 'previous_translation') {
      translationContext.complete(entry);
      if (entry.terminal && ['failed', 'gap'].includes(entry.status)) translationContext.reset();
    }
    const index = state.rows.findIndex(row => row.segmentId === entry.segmentId && row.revision === entry.revision);
    const previous = index >= 0 ? state.rows[index] : null, pageFields = {};
    // Browser acknowledgements and human reviews arrive before CLI cleanup can finish.
    for (const key of ['visibleNodeMs', 'visibilityClockUncertaintyMs', 'visibilityProof', 'evaluation']) if (previous && key in previous) pageFields[key] = previous[key];
    const row = { ...entry, requestedEnhancement: entry.requestedEnhancement ?? session?.enhancement ?? 'off',
      audioSource: entry.audioSource ?? session?.source ?? null, ...pageFields, visibleEligible: ordered || Boolean(previous?.visibleEligible) };
    row.latency = latencyFor(row);
    if (index < 0) state.rows.push(row); else state.rows[index] = row;
    broadcast(ordered ? 'ordered' : 'segment', { row }, true); publishState();
  }
  async function refreshCliLogin() {
    if (cliProcessExitUnconfirmed) fail('codex_cli_process_exit_unconfirmed');
    const login = await checkCliLoginImpl({ executable: codexExecutable, spawnImpl: options.codexSpawnImpl });
    const loggedIn = login?.loggedIn === true && login?.authMode === 'chatgpt';
    state.auth = loggedIn ? 'authorized' : 'unauthorized';
    state.cliLogin = { loggedIn, authMode: loggedIn ? 'chatgpt' : null };
    state.expectedAccountGuard = false;
    state.models = []; state.catalogSource = null; state.catalogError = null;
    if (!loggedIn) { state.selectionError = 'codex_cli_auth_required'; return false; }
    try {
      const catalog = await listCliModelsImpl({ executable: codexExecutable, cwd: cliWorkDir, spawnImpl: options.codexSpawnImpl });
      if (!Array.isArray(catalog?.models) || catalog.catalogSource !== 'codex_model_list') fail('invalid_codex_model_catalog');
      const seen = new Set();
      const models = catalog.models.map(model => {
        if (!model || typeof model.slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model.slug) || seen.has(model.slug)) fail('invalid_codex_model_catalog');
        seen.add(model.slug);
        return structuredClone(model);
      }).filter(model => model.hidden !== true && (!Array.isArray(model.input_modalities) || model.input_modalities.includes('text')));
      if (!models.length) fail('codex_no_text_models_available');
      state.models = models; state.catalogSource = catalog.catalogSource; state.catalogRetrievedAt = new Date().toISOString();
      state.selectionError = models.some(model => model.slug === state.selectedModel) ? null : 'selected_model_not_visible';
    } catch (error) {
      state.catalogError = safeCode(error);
      if (error?.diagnostics?.termination_confirmed === false || error?.diagnostics?.termination_unconfirmed === true
        || error?.diagnostics?.process?.closed === false) {
        cliProcessExitUnconfirmed = true; state.cliProcessExitUnconfirmed = true;
        if (!state.warnings.includes('catalog_process_termination_unconfirmed')) state.warnings.push('catalog_process_termination_unconfirmed');
      }
      // Failed discovery must never be presented as a fabricated CLI allowlist.
      if (state.catalogSource !== 'codex_model_list') state.models = [];
      publishState(); throw error;
    }
    return loggedIn;
  }
  async function officialJson(url, init = {}) {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) fail('official_endpoint_http_' + response.status);
    try { return await response.json(); } catch { fail('official_endpoint_invalid_json'); }
  }
  async function prepareAuth() {
    // Read only prior app-registration and a one-way account guard. Never inspect Codex credentials.
    try { registration = JSON.parse(await readFile(join(registrationDir, 'registration.json'), 'utf8')); }
    catch { fail('existing_siwc_registration_required'); }
    try { expectedIdentity = JSON.parse(await readFile(join(registrationDir, 'expected-identity.json'), 'utf8')); }
    catch { fail('existing_expected_account_guard_required'); }
    if (registration.appName !== APP_NAME || !/^urn:uuid:[0-9a-f-]{36}$/.test(registration.hostId)
      || !/^[A-Za-z0-9_-]{1,200}$/.test(registration.clientId ?? '') || registration.clientId === 'dynamic_agent_client'
      || !/^[a-f0-9]{64}$/.test(expectedIdentity.emailSha256 ?? '')) fail('existing_auth_metadata_invalid');
    discovery = await officialJson(ISSUER + '/.well-known/openid-configuration');
    if (discovery.issuer !== ISSUER || discovery.authorization_endpoint !== ISSUER + '/api/accounts/authorize'
      || discovery.token_endpoint !== ISSUER + '/api/accounts/oauth/token' || discovery.jwks_uri !== ISSUER + '/.well-known/jwks.json') fail('discovery_endpoint_mismatch');
    jwks = await officialJson(discovery.jwks_uri); state.expectedAccountGuard = true;
  }
  async function refreshCatalog() {
    if (!tokens) fail('official_authorization_required');
    const catalog = await catalogImpl(await tokens.getAccessToken(), { fetchImpl });
    state.models = catalog.models.filter(model => ALLOWED_MODELS.includes(model.slug)).map(model => ({ slug: model.slug, display_name: model.display_name }));
    state.catalogRetrievedAt = catalog.retrieved_at;
    state.catalogSource = 'siwc_model_list'; state.catalogError = null;
    if (!state.models.some(model => model.slug === state.selectedModel)) state.selectedModel = state.models[0]?.slug ?? null;
    if (!state.models.length) fail('planned_models_not_visible');
    state.auth = 'authorized'; return catalog;
  }
  async function handleCallback(url, response) {
    if (captureStarting || worker || schedulerBusy() || authBusy) fail('authorization_in_progress_or_capture_active');
    authBusy = true; publishState();
    try {
      const attempt = pendingAuth;
      const { code, clientId } = consumeCallback(url, attempt); pendingAuth = null;
      const data = await officialJson(discovery.token_endpoint, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }) });
      const identityOptions = { clientId, nonce: attempt.nonce, subjectDigest: registration.subjectDigest ?? null, expectedEmailSha256: expectedIdentity.emailSha256 };
      try { verifyIdentity(data.id_token, { ...identityOptions, jwks }); }
      catch (error) { if (error.safeCode !== 'id_token_unknown_key') throw error; jwks = await officialJson(discovery.jwks_uri); verifyIdentity(data.id_token, { ...identityOptions, jwks }); }
      const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/) : [];
      if (!scopes.includes('chatgpt.tokens.use.direct')) fail('plan_permission_not_granted');
      if (shuttingDown) fail('gateway_closed');
      tokens?.close(); tokens = createMemorySession({ tokenResponse: data, clientId, fetchImpl,
        onEvent: event => broadcast('session_event', { event }, true) });
      await refreshCatalog(); state.phase = 'ready'; state.message = '官方授权与账号核对通过；已读取当前模型目录。尚未采音。';
      publishState(); response.writeHead(303, { Location: '/' }); response.end();
    } catch (error) {
      tokens?.close(); tokens = null; state.auth = 'unauthorized'; state.models = []; state.message = safeCode(error); publishState(); throw error;
    } finally { authBusy = false; publishState(); }
  }
  async function inventory() {
    return new Promise((done, reject) => {
      const child = spawnImpl(python, ['-X', 'utf8', join(here, 'worker.py'), 'devices'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errored = false;
      const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error(), { safeCode: 'device_inventory_timeout' })); }, 20_000);
      child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 1024 * 1024) { errored = true; child.kill(); } });
      child.stderr.on('data', () => {});
      child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error(), { safeCode: 'python_worker_unavailable' })); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0 || errored) return reject(Object.assign(new Error(), { safeCode: 'device_inventory_failed' }));
        try { const parsed = output.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(item => item.type === 'devices'); if (!parsed || !Array.isArray(parsed.devices)) fail('invalid_device_inventory'); done(parsed); }
        catch { reject(Object.assign(new Error(), { safeCode: 'invalid_device_inventory' })); }
      });
    });
  }
  function workerSend(value) { if (worker?.stdin.writable) worker.stdin.write(JSON.stringify(value) + '\n'); }
  function acceptWorker(event) {
    if (event.type === 'worker_ready') {
      if (session.speakerAdmission && (event.speakerAdmission?.enabled !== true
        || event.speakerAdmission.profile?.profileSha256 !== session.speakerProfile?.profileSha256
        || event.speakerAdmission.profile?.modelSha256 !== session.speakerProfile?.modelSha256)) fail('speaker_profile_worker_mismatch');
      const enhancement = event.enhancement;
      if (enhancement && typeof enhancement === 'object') {
        const mode = value => ['off', 'deepfilternet3', 'rnnoise'].includes(value) ? value : null;
        session.enhancementDiagnostics = { requestedMode: mode(enhancement.requestedMode), appliedMode: mode(enhancement.appliedMode),
          algorithmicDelaySamples: Number.isSafeInteger(enhancement.algorithmicDelaySamples) && enhancement.algorithmicDelaySamples >= 0 ? enhancement.algorithmicDelaySamples : null,
          nativeRate: Number.isSafeInteger(enhancement.nativeRate) && enhancement.nativeRate > 0 ? enhancement.nativeRate : null,
          outputTimeline: enhancement.outputTimeline === 'delay_compensated_original_samples' ? enhancement.outputTimeline : null,
          profileSha256: typeof enhancement.profileSha256 === 'string' && /^[a-f0-9]{64}$/.test(enhancement.profileSha256) ? enhancement.profileSha256 : null };
        if (session.enhancementDiagnostics.appliedMode && session.enhancementDiagnostics.appliedMode !== session.enhancement) fail('enhancement_mode_mismatch');
        if (session.enhancementDiagnostics.requestedMode && session.enhancementDiagnostics.requestedMode !== session.enhancement) fail('enhancement_request_mismatch');
      }
      state.phase = 'recording'; state.message = session.source === 'microphone' ? '麦克风采集中；说完后留出短暂停顿。'
        : session.source === 'captured_replay' ? '已有麦克风录音实时回放中；本次未启动麦克风。' : '公开日语录音实时回放中；未启动麦克风。';
      for (let i = 0; i < 3; i++) workerClock.request(workerSend);
      publishState();
    } else if (event.type === 'clock_sync') {
      const receivedNodeMs = now(), sentNodeMs = workerClock.pending.get(event.id) ?? null;
      const accepted = workerClock.accept(event, receivedNodeMs); state.workerClock = workerClock.best;
      if (session.testModelSchedule || (session.source === 'microphone' && session.audioRecorded)) persist({ type: 'worker_clock_sample', id: event.id, sentNodeMs, receivedNodeMs,
        workerPerfCounterMs: event.perfCounterMs, accepted, best: workerClock.best });
      publishState(); return;
    } else if (event.type === 'vad_segment') {
      if (event.segmentId !== undefined) updateRow({ ...event, revision: event.revision ?? 1, workerSessionId: session.id, status: 'recognizing' });
    } else if (event.type === 'speaker_decision') {
      const value = event.speakerAdmission;
      if (!value || !['accepted', 'rejected', 'uncertain'].includes(value.decision)) fail('invalid_speaker_decision');
      if (session.speakerAdmission && (value.profileSha256 !== session.speakerProfile?.profileSha256
        || value.modelSha256 !== session.speakerProfile?.modelSha256)) fail('speaker_profile_worker_mismatch');
      state.speakerAdmission.latestDecision = { decision: value.decision, reason: value.reason,
        score: value.score, threshold: value.threshold, voicedMs: value.voicedMs, gateMs: value.gateMs };
      publishState();
    } else if (event.type === 'asr_result') {
      if (!Number.isInteger(event.segmentId) && typeof event.segmentId !== 'string') return fail('invalid_segment_id');
      if (typeof event.ja !== 'string' || event.ja.length > 16000 || !event.ja.trim()) return fail('invalid_asr_result');
      if (session.speakerAdmission && (event.speakerAdmission?.decision !== 'accepted'
        || event.speakerAdmission.profileSha256 !== session.speakerProfile?.profileSha256
        || event.speakerAdmission.modelSha256 !== session.speakerProfile?.modelSha256)) fail('speaker_admission_required');
      const scheduleMatch = session.testModelSchedule ? matchTestModelSchedule(session.testModelSchedule, event) : null;
      const selected = scheduleMatch ? state.models.find(model => model.slug === scheduleMatch.expectedModel)
        : cliMode ? state.models.find(model => model.slug === state.selectedModel) : session.requestedModel;
      const requestedModel = selected ? Object.freeze({ slug: selected.slug, display_name: selected.display_name }) : null;
      const segment = { ...event, workerSessionId: session.id, clockUncertaintyMs: workerClock.best?.uncertaintyMs ?? null,
        requestedEnhancement: session.enhancement, audioSource: session.source, ...(scheduleMatch ? { testModelScheduleMatch: scheduleMatch } : {}),
        requestedModel, translationModel: requestedModel?.slug ?? null, modelSelectionRevision: state.modelSelectionRevision };
      for (const key of ['audioEnd', 'vadCommit', 'asrStart', 'asrEnd']) segment[key + 'NodeMs'] = workerClock.toNode(event[key + 'PerfMs']);
      if (scheduleMatch?.errorCode) scheduler.addGap(segment, scheduleMatch.errorCode);
      else if (!requestedModel) scheduler.addGap(segment, 'selected_model_not_visible');
      else if (!workerClock.best) {
        state.warnings.push('worker_clock_sync_missing');
        scheduler.addGap(segment, 'worker_clock_sync_missing');
      } else {
        if (contextMode === 'previous_translation') segment.translationContext = translationContext.admit(segment);
        scheduler.enqueue(segment);
      }
    } else if (event.type === 'gap') {
      if (contextMode === 'previous_translation') translationContext.reset();
      const id = event.segmentId ?? `worker-gap-${randomUUID()}`;
      scheduler?.addGap({ ...event, segmentId: id, revision: event.revision ?? 1, workerSessionId: session.id }, event.code ?? event.reason ?? 'audio_gap');
    } else if (event.type === 'worker_error') {
      const code = /^[a-zA-Z0-9_.:-]{1,160}$/.test(event.code ?? '') ? event.code : 'audio_worker_failed';
      // Exceptions can contain device paths or arbitrary library output. Only the stable code reaches UI/evidence.
      event = { ...event, code }; delete event.message; delete event.reason;
      if (event.segmentId !== undefined) scheduler?.addGap({ ...event, revision: event.revision ?? 1, workerSessionId: session.id }, code);
      state.phase = 'worker_error'; state.message = code; publishState();
    }
    // No stdout/stderr credentials are persisted. Worker emits a narrowly defined audio-only protocol.
    const allowed = ['worker_ready', 'session_started', 'vad_segment', 'speaker_decision', 'asr_result', 'gap', 'worker_error', 'session_stopped', 'heartbeat'];
    if (allowed.includes(event.type)) broadcast('worker', { event }, true);
  }
  async function startCapture(body) {
    if (!speakerController.healthy()) fail('speaker_process_exit_unconfirmed');
    if (cliMode && cliProcessExitUnconfirmed) fail('codex_cli_process_exit_unconfirmed');
    if (shuttingDown || captureStarting || authBusy || worker || schedulerBusy() || speakerMutationBusy || speakerController.busy()) fail('previous_session_still_active');
    if (contextMode === 'previous_translation' && (body.concurrency ?? 1) !== 1) fail('previous_translation_requires_serial');
    if (body.speakerAdmission !== undefined && typeof body.speakerAdmission !== 'boolean') fail('invalid_speaker_admission');
    const speakerAdmission = body.speakerAdmission ?? speakerDefault;
    const source = body.source ?? 'microphone';
    if (body.useTestSpeakerProfile !== undefined && typeof body.useTestSpeakerProfile !== 'boolean') fail('invalid_test_speaker_profile');
    const useTestSpeakerProfile = body.useTestSpeakerProfile === true;
    if (useTestSpeakerProfile && (source !== 'captured_replay' || !testSpeakerProfile || !speakerAdmission)) fail('test_speaker_profile_source_not_allowed');
    const admittedProfilePath = useTestSpeakerProfile ? testSpeakerProfile.path : speakerController.admittedProfile();
    const admittedProfileMetadata = useTestSpeakerProfile ? testSpeakerProfile.profile : state.speakerAdmission.profile;
    if (speakerAdmission && !admittedProfilePath) fail('speaker_profile_required');
    if (!['microphone', 'public_replay', 'captured_replay'].includes(source)) fail('invalid_audio_source');
    if (body.testModelSchedule !== undefined && source !== 'captured_replay') fail('test_model_schedule_source_not_allowed');
    const testModelSchedule = body.testModelSchedule === undefined ? null : validateTestModelSchedule(body.testModelSchedule);
    const enhancement = body.enhancement === undefined ? 'off' : body.enhancement;
    if (!['off', 'deepfilternet3', 'rnnoise'].includes(enhancement)) fail('invalid_enhancement_mode');
    if (!enhancementAllowed && enhancement !== 'off') fail('audio_enhancement_disabled');
    if (speakerAdmission && enhancement !== 'off') fail('speaker_requires_original_audio');
    if (enhancement !== 'off' && enhancementAssets === null) fail('enhancement_assets_not_configured');
    if (source === 'captured_replay') {
      if (typeof body.replayId !== 'string' || !capturedReplayFiles.has(body.replayId)) fail('invalid_captured_replay_selection');
    } else if (body.replayId !== undefined && (source !== 'public_replay' || typeof body.replayId !== 'string'
      || !replayFiles.has(body.replayId))) fail('invalid_replay_selection');
    // Validation runs may select only scripts explicitly supplied at startup.
    // No request-supplied filesystem path is executed.
    if (body.workerId !== undefined && (source !== 'public_replay' || typeof body.workerId !== 'string'
      || !workerScripts.has(body.workerId))) fail('invalid_worker_selection');
    const selectedWorkerScript = body.workerId === undefined ? join(here, 'worker.py') : workerScripts.get(body.workerId);
    const selectedReplayFile = source === 'captured_replay' ? capturedReplayFiles.get(body.replayId)
      : source === 'public_replay' ? body.replayId === undefined ? replayFile : replayFiles.get(body.replayId) : null;
    if (source !== 'microphone' && !selectedReplayFile) fail('invalid_audio_source');
    if ((source === 'microphone' && (!Number.isInteger(body.device) || body.device < 0)) || ![1, 2].includes(body.concurrency ?? 1)
      || !['int8_float16', 'float16'].includes(body.computeType ?? defaultComputeType) || typeof (body.record ?? false) !== 'boolean'
      || body.recordProcessed !== undefined && typeof body.recordProcessed !== 'boolean') fail('invalid_capture_options');
    if (cliMode ? body.model !== undefined && (typeof body.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.model)) : !ALLOWED_MODELS.includes(body.model)) fail('planned_model_required');
    captureStarting = true; cancelCaptureStart = false; state.captureStarting = true;
    captureStartDone = new Promise(done => { finishCaptureStart = done; });
    state.phase = 'preparing_capture'; state.message = cliMode ? '检查本机 CLI 的 ChatGPT 登录状态；尚未采音。' : '核对当前模型目录后启动；尚未采音。'; publishState();
    try {
    if (cliMode) { if (!await refreshCliLogin()) fail('codex_cli_auth_required'); }
    else await refreshCatalog();
    if (testModelSchedule && (!cliMode || testModelSchedule.intervals.some(item => !state.models.some(model => model.slug === item.model)))) fail('test_schedule_model_not_visible');
    if (cancelCaptureStart) fail('capture_start_cancelled');
    const selected = state.models.find(model => model.slug === (body.model ?? state.selectedModel));
    if (!selected) fail('selected_model_not_visible');
    if (state.selectedModel !== selected.slug) state.modelSelectionRevision++;
    state.selectedModel = selected.slug;
    state.selectionError = null;
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const outputDir = resolve(options.outputBase ?? join(workspace, 'docs/validation', date8(), 'mic-prototype'), 'run-' + id);
    await mkdir(outputDir, { recursive: true });
    session = { id, outputDir, startedAt: new Date().toISOString(), provider, codexServiceTier: cliMode ? codexServiceTier : null, codexPromptStyle: cliMode ? codexPromptStyle : null, source, device: source === 'microphone' ? body.device : null, model: selected.slug,
      requestedModel: Object.freeze({ slug: selected.slug, display_name: selected.display_name }),
      schedulerPolicy: residentMode ? 'bounded_resident_lanes' : execMode ? 'bounded_inference_and_cleanup' : 'legacy_until_transport_close', cleanupAllowance: execMode ? 2 : 0,
      cliProcessLimit: execMode ? (body.concurrency ?? 1) + 2 : null,
      residentPolicy: residentMode ? { maxTurnsPerThread: 30, maxTurnsPerProcess: 120, lanes: body.concurrency ?? 1, independentHistories: true,
        contextUsageThreshold: options.contextUsageThreshold ?? 0.8 } : null,
      concurrency: body.concurrency ?? 1, pendingLimit: 2, computeType: body.computeType ?? defaultComputeType, enhancement, enhancementDiagnostics: null, enhancementAssets,
      speakerAdmission, speakerProfile: speakerAdmission ? structuredClone(admittedProfileMetadata) : null,
      speakerProfileSource: speakerAdmission ? admittedProfileMetadata.sourceKind : null,
      translationContextMode: contextMode,
      audioRecorded: source === 'microphone' && (body.record ?? false), rawNativeAudioRecorded: source === 'microphone' && (body.record ?? false), processedAudioRecorded: body.recordProcessed ?? false,
      replayFile: selectedReplayFile, replayId: source !== 'microphone' ? body.replayId ?? null : null, testModelSchedule,
      workerScript: selectedWorkerScript, workerId: body.workerId ?? null,
      clockDefinition: 'Worker perf_counter → lowest-RTT Node midpoint; browser performance.now → lowest-RTT Node midpoint. New page acknowledgements require both complete language elements inside viewport after DOM update + 2 animation frames; screen recording is still required to validate physical display.',
      audioEndDefinition: 'VAD frame endpoint estimate, not human-annotated final phoneme. Preserve worker uncertainty.' };
    await writeFile(join(outputDir, 'session.json'), JSON.stringify(session, null, 2) + '\n', { flag: 'wx' });
    if (residentMode) {
      state.rows = []; state.warnings = []; state.session = session;
      state.phase = 'preparing_translation'; state.message = '准备持续翻译会话；尚未启动音频。'; state.resident = null; publishState();
      const poolStarted = now();
      try {
        residentPool = await createResidentImpl({ executable: codexExecutable, cwd: cliWorkDir, instructionsFile: cliInstructionsFile,
          model: { slug: selected.slug }, serviceTier: codexServiceTier, promptStyle: codexPromptStyle, concurrency: session.concurrency,
          maxTurnsPerThread: session.residentPolicy.maxTurnsPerThread, maxTurnsPerProcess: session.residentPolicy.maxTurnsPerProcess,
          maxCachedModels: options.maxCachedModels ?? 4, maxContextBytes: options.maxContextBytes ?? 131072,
          contextUsageThreshold: session.residentPolicy.contextUsageThreshold,
          modelPolicies: options.modelPolicies ?? {}, reasoningPolicy: 'lowest_supported',
          timeoutMs: options.translationTimeoutMs ?? 30_000 });
      } catch (error) {
        if (error?.diagnostics?.termination_confirmed === false || error?.diagnostics?.termination_unconfirmed === true) { cliProcessExitUnconfirmed = true; state.cliProcessExitUnconfirmed = true; }
        persist({ type: 'resident_setup_failed', code: safeCode(error), diagnostics: error?.diagnostics ?? null }); throw error;
      }
      session.residentStartupMs = round(now() - poolStarted); state.resident = residentPool.diagnostics();
      persist({ type: 'resident_ready', startupMs: session.residentStartupMs, policy: session.residentPolicy, diagnostics: state.resident });
      await writeFile(join(outputDir, 'session.json'), JSON.stringify(session, null, 2) + '\n');
      if (cancelCaptureStart || shuttingDown) fail('capture_start_cancelled');
    }
    state.rows = []; state.warnings = []; state.session = session; state.phase = 'loading_asr'; state.message = source === 'microphone' ? '正在加载本地 Whisper；麦克风只在本次明确开始后启用。'
      : source === 'captured_replay' ? '正在加载本地 Whisper 并实时回放已有麦克风录音；本次未启动麦克风。' : '正在加载本地 Whisper 并实时回放公开录音；未启动麦克风。'; workerClock = new WorkerClock();
    cloudBlockedCode = null;
    translationContext = createPreviousTranslationContext();
    function pauseCloud(code, authorizationRequired = false) {
      cloudBlockedCode = code;
      // Never recycle an unconfirmed OS process by merely starting another test session.
      if (cliMode && code === 'codex_cli_termination_unconfirmed') { cliProcessExitUnconfirmed = true; state.cliProcessExitUnconfirmed = true; }
      state.phase = 'translation_paused';
      if (authorizationRequired) state.auth = cliMode ? 'unauthorized' : 'reauthorization_required';
      state.message = '云翻译已暂停并请求停止音频：' + code + (authorizationRequired ? (cliMode ? '；请检查本机 CLI 登录状态。' : '；需要重新官方授权。') : '；请检查错误后手动重试。');
      workerSend({ command: 'stop' }); publishState();
    }
    scheduler = new TranslationScheduler({ concurrency: session.concurrency, cleanupAllowance: session.cleanupAllowance,
      translate: async (entry, onCompleted) => {
        if (cloudBlockedCode) fail('cloud_translation_paused');
        const fixture = { id: `${entry.workerSessionId}:${entry.segmentId}:${entry.revision}`, ja: entry.ja,
          context: contextMode === 'previous_translation' ? translationContext.contextFor(entry)
            : 'The current speaker is the livestream host. Preserve Japanese names without guessing their kanji or gender.' };
        const observer = telemetry => persist({ type: 'translation_observation', segmentId: entry.segmentId, revision: entry.revision,
          requestedModel: entry.requestedModel, telemetry });
        if (residentMode) {
          try {
            const result = await residentPool.translate({ model: entry.requestedModel, fixture, glossary: [] });
            observer(result.telemetry); state.resident = residentPool.diagnostics();
            if (!result.success) pauseCloud(result.error?.code ?? 'resident_translation_failed', result.error?.code === 'codex_cli_auth_required');
            return result;
          } catch (error) { pauseCloud(safeCode(error)); throw error; }
        }
        if (cliMode) {
          const result = await translateImpl({ executable: codexExecutable, cwd: cliWorkDir, instructionsFile: cliInstructionsFile, serviceTier: codexServiceTier,
            model: entry.requestedModel, fixture, glossary: [],
            spawnImpl: options.codexSpawnImpl, timeoutMs: options.translationTimeoutMs ?? 30_000, observer, onTurnCompleted: onCompleted });
          if (!result.success && !entry.terminal) pauseCloud(result.error?.code ?? 'codex_cli_translation_failed', result.error?.code === 'codex_cli_auth_required');
          return result;
        }
        if (!tokens) fail('official_authorization_required');
        let accessToken;
        const credentialStarted = now();
        try { accessToken = await tokens.getAccessToken(); }
        catch (error) { pauseCloud(safeCode(error), true); throw error; }
        const credentialWaitMs = round(now() - credentialStarted);
        // Pass only slug/name so historical catalog reasoning metadata does not change the frozen server_default baseline.
        const result = await translateImpl({ accessToken, model: entry.requestedModel,
          fixture,
          glossary: [], fetchImpl, timeoutMs: options.translationTimeoutMs ?? 30_000,
          observer });
        result.credentialWaitMs = credentialWaitMs;
        if (result.http_status === 401 || result.http_status === 403) pauseCloud(result.error?.code ?? 'authorization_expired', true);
        else if (result.http_status === 429 || result.http_status >= 500
          || /usage|quota|subscription|sharing|rate_limit/.test(result.error?.code ?? '')
          || ['timeout', 'client_error', 'interrupted'].includes(result.final_status)) pauseCloud(result.error?.code ?? 'translation_transport_failed');
        return result;
      }, onUpdate: entry => updateRow(entry), onOrdered: entry => updateRow(entry, true), onQueueChange: () => { publishState(); closeResidentWhenDrained(); },
      onCleanupError: (entry, code) => {
        const cleanupCode = safeCode({ safeCode: code }), warning = 'cli_cleanup_error:' + cleanupCode;
        if (!state.warnings.includes(warning)) state.warnings.push(warning);
        persist({ type: 'cleanup_error', segmentId: entry.segmentId, revision: entry.revision, code: cleanupCode, cleanup: entry.cleanup });
        pauseCloud(cleanupCode, cleanupCode === 'codex_cli_auth_required');
      } });
    const args = ['-X', 'utf8', selectedWorkerScript, source === 'microphone' ? 'run' : 'file', '--model-dir', modelDir, '--compute-type', session.computeType,
      '--enhancement', enhancement];
    if (enhancementAssets !== null) args.push('--enhancement-assets', enhancementAssets);
    if (speakerAdmission) args.push('--speaker-assets', speakerAssets, '--speaker-profile', admittedProfilePath);
    if (source !== 'microphone') args.push('--audio-file', selectedReplayFile, '--realtime'); else args.push('--device', String(body.device));
    if (vadModel) args.push('--vad-model', vadModel);
    if (session.audioRecorded) args.push('--record', join(outputDir, 'audio.wav'), '--raw-native-record', join(outputDir, 'audio-native.wav'));
    if (session.processedAudioRecorded) args.push('--processed-record', join(outputDir, 'audio-processed.wav'));
    if (cancelCaptureStart || shuttingDown) { state.phase = 'ready'; state.message = '启动已取消；未采音。'; fail('capture_start_cancelled'); }
    worker = spawnImpl(python, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    state.workerActive = true;
    const lines = createInterface({ input: worker.stdout });
    lines.on('line', line => {
      try { if (line.length > 512_000) fail('worker_line_too_large'); const event = JSON.parse(line); acceptWorker(event); }
      catch (error) { state.phase = 'worker_error'; state.message = safeCode(error); persist({ type: 'protocol_error', code: state.message }); workerSend({ command: 'stop' }); publishState(); }
    });
    worker.stderr.on('data', () => { /* Do not copy arbitrary process output into evidence or the browser. */ });
    worker.on('error', () => { state.phase = 'worker_error'; state.message = 'python_worker_unavailable'; publishState(); });
    worker.on('close', code => {
      worker = null; state.workerActive = false;
      for (const row of [...state.rows]) if (row.status === 'recognizing') scheduler?.addGap(row, 'asr_worker_exited_before_result');
      if (cloudBlockedCode) state.phase = 'translation_paused';
      else if (state.phase !== 'worker_error') {
        state.phase = code === 0 ? 'capture_stopped' : 'worker_error';
        state.message = code === 0 ? '音频已停止；等待已提交的翻译结束。' : '音频进程异常退出；请查看本地环境诊断。';
      }
      persist({ type: 'worker_exit', code }); publishState(); closeResidentWhenDrained();
    });
    publishState(); return { sessionId: id, outputDir };
    } catch (error) {
      if (!worker) { state.phase = 'ready'; state.message = cancelCaptureStart ? '启动已取消；未采音。' : '未启动音频：' + safeCode(error); }
      throw error;
    } finally {
      captureStarting = false; state.captureStarting = false;
      if (!worker && state.phase === 'preparing_capture') { state.phase = 'ready'; state.message = cancelCaptureStart ? '启动已取消；未采音。' : '未启动采音，请检查授权与本地环境。'; }
      publishState(); closeResidentWhenDrained(); finishCaptureStart();
    }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'");
    if (request.headers.host !== new URL(origin).host) { json(response, { error: 'invalid_host' }, 400); return; }
    let url;
    try { url = new URL(request.url, origin); } catch { json(response, { error: 'invalid_url' }, 400); return; }
    try {
      if (request.method === 'GET' && url.pathname === '/auth/callback') { if (cliMode) fail('siwc_disabled_for_cli'); await handleCallback(url, response); return; }
      // OAuth redirect chains can retain cross-site metadata on the top-level landing page.
      const landingNavigation = request.method === 'GET' && url.pathname === '/'
        && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      if ((request.headers['sec-fetch-site'] === 'cross-site' && !landingNavigation)
        || (request.headers.origin && request.headers.origin !== origin)) fail('cross_origin_rejected');
      if (request.method === 'GET' && url.pathname === '/') {
        const html = (await readFile(join(here, 'ui.html'), 'utf8')).replace('__CAPABILITY__', capability);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return;
      }
      if (request.method === 'GET' && url.pathname === '/state') { json(response, state); return; }
      if (request.method === 'GET' && url.pathname === '/clock') { json(response, { nodeMs: now() }); return; }
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const connectionId = randomUUID();
        const subscriber = createSseChannel(response, { onDiagnostic: diagnostic =>
          persist({ type: 'sse_transport', connectionId, nodeMs: now(), ...diagnostic }) });
        subscribers.add(subscriber); subscriber.send({ type: 'state', state });
        response.once('close', () => subscribers.delete(subscriber)); return;
      }
      if (request.method === 'GET' && url.pathname === '/report') { json(response, { session, state, exportedAt: new Date().toISOString() }); return; }
      if (request.method !== 'POST') { json(response, { error: 'not_found' }, 404); return; }
      if (request.headers.origin !== origin || !same(request.headers['x-prototype-capability'], capability)) fail('mutation_authorization_failed');
      const body = await jsonBody(request);
      if (url.pathname === '/devices') { json(response, await inventory()); return; }
      if (url.pathname === '/speaker/refresh') {
        if (shuttingDown || speakerMutationBusy || captureStarting || worker || schedulerBusy()) fail('speaker_change_busy');
        speakerMutationBusy = true;
        try { json(response, await speakerController.refresh()); } finally { speakerMutationBusy = false; }
        return;
      }
      if (url.pathname === '/speaker/enroll') {
        if (shuttingDown || speakerMutationBusy || authBusy || captureStarting || worker || schedulerBusy() || speakerController.busy()) fail('speaker_change_busy');
        speakerMutationBusy = true;
        try {
          const result = await speakerController.enroll(body);
          json(response, { started: result.started });
        } finally { speakerMutationBusy = false; }
        return;
      }
      if (url.pathname === '/speaker/enroll/cancel') { json(response, await speakerController.cancel()); return; }
      if (url.pathname === '/api/translation-model') {
        if (!cliMode) fail('cli_provider_not_enabled');
        if (shuttingDown) fail('gateway_closed');
        if (captureStarting || authBusy || speakerMutationBusy || speakerController.busy()) fail('translation_model_change_busy');
        if (session?.testModelSchedule && (worker || schedulerBusy())) fail('test_model_schedule_controls_translation');
        if (typeof body.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.model)) fail('invalid_codex_model');
        if (state.auth !== 'authorized') fail('codex_cli_auth_required');
        if (state.catalogError || state.catalogSource !== 'codex_model_list') fail('codex_model_catalog_unavailable');
        if (!state.models.some(model => model.slug === body.model)) fail('selected_model_not_visible');
        const previousModel = state.selectedModel;
        if (previousModel !== body.model) state.modelSelectionRevision++;
        state.selectedModel = body.model; state.selectionError = null;
        persist({ type: 'translation_model_selected', previousModel, selectedModel: body.model,
          modelSelectionRevision: state.modelSelectionRevision, appliesTo: 'subsequent_asr_results', activeSessionId: session?.id ?? null });
        publishState(); json(response, { selectedModel: state.selectedModel, modelSelectionRevision: state.modelSelectionRevision }); return;
      }
      if (url.pathname === '/cli/check') {
        if (!cliMode) fail('cli_provider_not_enabled');
        if (captureStarting || worker || schedulerBusy() || authBusy) fail('stop_capture_before_checking_login');
        authBusy = true; publishState();
        try { const loggedIn = await refreshCliLogin(); state.phase = 'ready'; state.message = loggedIn ? state.selectionError ? 'CLI 已登录；已刷新模型目录，当前选择不可用，请选择目录中的模型。尚未采音。' : 'CLI 已登录 ChatGPT；已刷新可用模型目录，尚未采音。' : '未确认 CLI 的 ChatGPT 登录；请检查本机 CLI 登录状态。尚未采音。'; publishState(); json(response, state.cliLogin); return; }
        catch (error) { state.message = 'CLI 模型目录读取失败：' + safeCode(error); publishState(); throw error; }
        finally { authBusy = false; publishState(); }
      }
      if (url.pathname === '/auth/start') {
        if (cliMode) fail('siwc_disabled_for_cli');
        if (captureStarting || worker || schedulerBusy() || authBusy) fail('stop_capture_before_authorizing');
        authBusy = true; publishState();
        try {
        tokens?.close(); tokens = null; state.auth = 'unauthorized'; state.models = [];
        await prepareAuth(); pendingAuth = newAttempt(origin + '/auth/callback', registration.clientId);
        const authorize = new URL(discovery.authorization_endpoint);
        authorize.search = new URLSearchParams({ client_id: registration.clientId, ext_agent_host_id: registration.hostId, response_type: 'code', redirect_uri: pendingAuth.redirectUri,
          scope: SCOPES, resource: RESOURCE, state: pendingAuth.state, nonce: pendingAuth.nonce, code_challenge_method: 'S256', code_challenge: pendingAuth.challenge }).toString();
        state.phase = 'awaiting_authorization'; state.message = '请使用当前 Codex 对应账号完成官方授权；错误账号会在推理前被拒绝。'; publishState(); json(response, { url: authorize.href }); return;
        } finally { authBusy = false; publishState(); }
      }
      if (url.pathname === '/start') { json(response, await startCapture(body)); return; }
      if (url.pathname === '/page-status') {
        if (body.version !== 1 || typeof body.documentHidden !== 'boolean' || typeof body.focused !== 'boolean'
          || ![body.viewport?.width, body.viewport?.height].every(value => Number.isFinite(value) && value > 0 && value <= 65536)) fail('invalid_page_status');
        state.pageStatus = { version: 1, documentHidden: body.documentHidden, focused: body.focused,
          viewport: { width: body.viewport.width, height: body.viewport.height }, receivedAtNodeMs: now(), receivedAt: new Date().toISOString() };
        persist({ type: 'page_status', ...state.pageStatus });
        json(response, { accepted: true }); return;
      }
      if (url.pathname === '/stop') { cancelCaptureStart = true; workerSend({ command: 'stop' }); state.phase = captureStarting ? 'preparing_capture' : 'stopping'; state.message = captureStarting ? '已请求取消启动；尚未采音。' : '正在停止音频并处理尾部片段；已提交翻译继续完成。'; publishState(); json(response, { stopped: true }); return; }
      if (url.pathname === '/visible') {
        if (!session || body.sessionId !== session.id) fail('test_session_mismatch');
        const row = state.rows.find(entry => entry.segmentId === body.segmentId && entry.revision === body.revision);
        if (!row || !row.visibleEligible || row.status !== 'completed' || !Number.isFinite(body.visibleNodeMs)
          || !Number.isFinite(body.clockUncertaintyMs) || body.clockUncertaintyMs < 0 || body.clockUncertaintyMs > 500
          || body.visibleNodeMs < row.orderedAtNodeMs - body.clockUncertaintyMs || body.visibleNodeMs > now() + body.clockUncertaintyMs) fail('invalid_visibility_ack');
        const visibilityProof = body.visibilityProof === undefined ? null : validatePageVisibilityProof(body.visibilityProof);
        if (!Number.isFinite(row.visibleNodeMs)) {
          if (visibilityProof) row.visibilityProof = visibilityProof;
          row.visibleNodeMs = body.visibleNodeMs; row.visibilityClockUncertaintyMs = body.clockUncertaintyMs; row.latency = latencyFor(row);
          broadcast('visibility', { row }, true);
        }
        json(response, { accepted: true, latency: row.latency }); return;
      }
      if (url.pathname === '/evaluate') {
        if (!session || body.sessionId !== session.id) fail('test_session_mismatch');
        const row = state.rows.find(entry => entry.segmentId === body.segmentId && entry.revision === body.revision);
        if (!row || typeof body.referenceJa !== 'string' || body.referenceJa.length > 16000
          || !['unreviewed', 'usable', 'minor', 'critical', 'ambiguous'].includes(body.zhQuality)
          || !['unreviewed', 'usable', 'minor', 'critical', 'ambiguous'].includes(body.enQuality)
          || typeof body.note !== 'string' || body.note.length > 4000) fail('invalid_evaluation');
        row.evaluation = { referenceJa: body.referenceJa, zhQuality: body.zhQuality, enQuality: body.enQuality, note: body.note, reviewedAt: new Date().toISOString() };
        broadcast('evaluation', { row }, true); json(response, { saved: true }); return;
      }
      if (url.pathname === '/save') {
        if (!session) fail('no_test_session');
        if (body.sessionId !== session.id) fail('test_session_mismatch');
        const savedSession = { ...session }, savedRows = structuredClone(state.rows), savedWarnings = [...state.warnings];
        await saveTail;
        await writeFile(join(savedSession.outputDir, 'report.json'), JSON.stringify({ session: savedSession, rows: savedRows, warnings: savedWarnings, savedAt: new Date().toISOString() }, null, 2) + '\n');
        json(response, { saved: true, outputDir: savedSession.outputDir }); return;
      }
      json(response, { error: 'not_found' }, 404);
    } catch (error) { if (!response.headersSent) json(response, { error: safeCode(error) }, 400); else response.end(); }
  });
  if (speakerAssets !== null) {
    try { await speakerController.refresh(); }
    catch (error) { state.warnings.push('speaker_setup:' + safeCode(error)); }
  }
  if (cliMode) {
    await mkdir(cliWorkDir, { recursive: true });
    try {
      const loggedIn = await refreshCliLogin();
      state.message = loggedIn ? state.selectionError ? 'CLI 已登录；当前选择不在可用模型目录，请先选择其他模型。尚未采音。' : 'CLI 已登录 ChatGPT；已读取可用模型目录，点击开始后才会处理音频并提交翻译。' : '未确认 CLI 的 ChatGPT 登录；请先检查登录。尚未采音。';
    } catch (error) { state.message = 'CLI 模型目录读取失败：' + safeCode(error) + '；请重试登录及模型刷新。尚未采音。'; }
  }
  await new Promise((ok, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', ok); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const keepalive = setInterval(() => { for (const subscriber of subscribers) subscriber.heartbeat(); }, 15_000); keepalive.unref();
  return { origin, state, server, async close() {
    shuttingDown = true; cancelCaptureStart = true;
    let speakerCloseFailed = false;
    try { speakerCloseFailed = (await speakerController.close()).terminationConfirmed !== true; }
    catch { speakerCloseFailed = true; }
    if (speakerCloseFailed) { state.speakerProcessExitUnconfirmed = true; state.warnings.push('speaker_process_exit_unconfirmed'); }
    tokens?.close(); tokens = null; pendingAuth = null;
    if (worker) { workerSend({ command: 'stop' }); const owned = worker; setTimeout(() => owned.kill(), 5000).unref(); }
    if (residentMode) {
      await captureStartDone;
      if (residentPool || residentClosePromise) {
        const drained = new Promise(done => residentClosedWaiters.add(done));
        closeResidentWhenDrained(); await drained;
      }
    }
    clearInterval(keepalive); for (const subscriber of subscribers) subscriber.close(); subscribers.clear();
    await new Promise(done => server.close(done)); await saveTail;
    if (speakerCloseFailed) fail('speaker_process_exit_unconfirmed');
  } };
}

export async function main() {
  const args = process.argv.slice(2); const values = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--port', '--python', '--model-dir', '--vad-model', '--output-base', '--replay-file', '--translation-provider', '--codex-executable', '--codex-model', '--codex-service-tier', '--codex-prompt-style'].includes(args[i]) || !args[i + 1]) fail('invalid_gateway_argument'); values[args[i]] = args[i + 1]; }
  const port = values['--port'] === undefined ? 0 : Number(values['--port']);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('invalid_loopback_port');
  const translationProvider = values['--translation-provider'] ?? 'codex_cli';
  const gateway = await createGateway({ port, translationProvider, codexExecutable: values['--codex-executable'], codexModel: values['--codex-model'], codexServiceTier: values['--codex-service-tier'], codexPromptStyle: values['--codex-prompt-style'], python: values['--python'], modelDir: values['--model-dir'], vadModel: values['--vad-model'], outputBase: values['--output-base'], replayFile: values['--replay-file'], allowEnhancement: false, translationContextMode: 'previous_translation' });
  console.log(JSON.stringify({ event: 'ready', localUrl: gateway.origin + '/', translationProvider, microphone: 'off_until_explicit_start', credentials: translationProvider.startsWith('codex_') ? 'official_cli_managed' : 'memory_only', quotaQueried: false }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => gateway.close().then(() => { process.exitCode = 0; }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(JSON.stringify({ event: 'startup_failed', code: safeCode(error) })); process.exitCode = 1; });
