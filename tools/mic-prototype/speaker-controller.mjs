import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value) ? value : 'speaker_operation_failed';
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Biometric embeddings stay in local profile files, never in browser state or evidence. */
export function publicSpeakerProfile(value) {
  if (!value || typeof value !== 'object') return null;
  const output = {};
  for (const name of ['profileId', 'createdAt', 'sourceKind', 'featureVersion', 'modelId', 'calibrationStatus'])
    if (typeof value[name] === 'string' && value[name].length <= 160) output[name] = value[name];
  for (const name of ['modelSha256', 'profileSha256']) if (validHash(value[name])) output[name] = value[name];
  for (const name of ['threshold', 'minVoicedMs', 'enrollmentVoicedMs', 'embeddingDimension'])
    if (finite(value[name]) !== null) output[name] = value[name];
  return output;
}

export function createSpeakerController({ python, script, assets = null, profileDirectory,
  spawnImpl = spawn, onChange = () => {}, now = () => performance.now(), maxEnrollmentMs = 40_000 } = {}) {
  for (const path of [python, script, profileDirectory]) if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) fail('invalid_speaker_paths');
  if (assets !== null && (typeof assets !== 'string' || !isAbsolute(assets) || /[\r\n\0]/.test(assets))) fail('invalid_speaker_assets');
  const state = { available: assets !== null, status: assets ? 'missing' : 'unconfigured', enrolled: false, profile: null,
    enrollment: { active: false, elapsedMs: 0, voicedMs: 0, reason: null } };
  let owned = null, activeProfile = null, operation = null, closed = false, fatalUnconfirmed = false, enrollmentCancelled = false, enrollmentTask = null;
  const snapshot = () => structuredClone(state);
  const publish = () => onChange(snapshot());
  function run(args, handle, timeoutMs, kind) {
    if (closed || fatalUnconfirmed) return Promise.reject(Object.assign(new Error(), { safeCode: 'speaker_controller_unavailable' }));
    if (operation) return Promise.reject(Object.assign(new Error(), { safeCode: 'speaker_operation_busy' }));
    const work = new Promise((done, reject) => {
      let child, timeout = false, ended = false, firstError = null;
      const finish = (error, code = null) => {
        if (ended) return; ended = true; clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(exitTimer);
        owned = null;
        if (error) reject(Object.assign(new Error(), { safeCode: safeCode(error) })); else done({ exitCode: code });
      };
      let timer, forceTimer, exitTimer;
      try { child = spawnImpl(python, ['-X', 'utf8', script, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); owned = child; }
      catch { finish('speaker_worker_unavailable'); return; }
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (line.length > 16_384) { firstError = 'speaker_protocol_invalid'; cancel(); return; }
        try { handle(JSON.parse(line)); } catch { firstError = 'speaker_protocol_invalid'; cancel(); }
      });
      child.stderr.on('data', () => {});
      child.stdin?.on('error', () => { firstError = 'speaker_control_pipe_failed'; cancel(false); });
      child.once('error', () => { firstError = 'speaker_worker_unavailable'; cancel(); });
      child.once('close', code => finish(firstError ?? (timeout ? 'speaker_operation_timeout' : code === 0 ? null : 'speaker_operation_failed'), code));
      function cancel(send = true) {
        if (ended) return;
        if (send && child.stdin?.writable && !child.stdin.destroyed) {
          try { child.stdin.write(JSON.stringify({ command: 'cancel' }) + '\n'); }
          catch { firstError ??= 'speaker_control_pipe_failed'; }
        }
        forceTimer ??= setTimeout(() => { child.kill(); }, 2000);
        exitTimer ??= setTimeout(() => { fatalUnconfirmed = true; state.processExitUnconfirmed = true; publish(); finish('speaker_process_exit_unconfirmed'); }, 6000);
      }
      child.cancelSpeakerOperation = cancel;
      timer = setTimeout(() => { timeout = true; cancel(); }, timeoutMs);
    });
    operation = { kind, promise: work };
    return work.finally(() => { operation = null; });
  }
  async function refresh() {
    if (!assets) return snapshot();
    if (operation || enrollmentTask || closed) fail('speaker_operation_busy');
    let pointer = null;
    try { pointer = JSON.parse(await readFile(join(profileDirectory, 'active.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') { state.status = 'failed'; state.enrolled = false; state.profile = null; activeProfile = null; publish(); fail('speaker_profile_pointer_invalid'); } }
    const file = pointer?.file;
    if (file !== undefined && (typeof file !== 'string' || !/^profile-[a-f0-9-]{36}\.json$/.test(file))) {
      state.status = 'failed'; state.enrolled = false; state.profile = null; activeProfile = null; publish(); fail('speaker_profile_pointer_invalid');
    }
    const candidate = join(profileDirectory, file ?? 'not-enrolled.json');
    let result = null;
    try {
      await run(['status', '--assets', assets, '--profile', candidate], event => {
        if (event.type === 'speaker_status') result = event;
      }, 20_000, 'status');
      if (!result || result.available !== true || typeof result.profileValid !== 'boolean') fail('speaker_status_invalid');
      state.available = true; state.enrolled = result.profileValid && Boolean(file);
      state.profile = state.enrolled ? publicSpeakerProfile(result.profile) : null;
      if (state.enrolled && (!state.profile || !validHash(state.profile.profileSha256)
        || state.profile.sourceKind !== 'user_microphone')) fail('speaker_profile_invalid');
      activeProfile = state.enrolled ? candidate : null;
      state.status = state.enrolled ? 'ready' : 'missing';
    } catch (error) { state.status = 'failed'; state.enrolled = false; state.profile = null; activeProfile = null; publish(); throw error; }
    publish(); return snapshot();
  }
  async function enroll({ device, seconds = 25 } = {}) {
    if (!assets) fail('speaker_assets_not_configured');
    if (!Number.isInteger(device) || device < 0 || seconds !== 25) fail('invalid_speaker_enrollment');
    if (operation || enrollmentTask || closed) fail('speaker_operation_busy');
    enrollmentCancelled = false;
    const file = `profile-${randomUUID()}.json`, output = join(profileDirectory, file), began = now();
    let completed = null, cancelled = false;
    state.status = 'enrolling'; state.enrollment = { active: true, elapsedMs: 0, voicedMs: 0, reason: null }; publish();
    const work = (async () => {
      try {
        await mkdir(profileDirectory, { recursive: true });
        if (enrollmentCancelled || closed) fail('enrollment_cancelled');
        await run(['enroll', '--assets', assets, '--profile-output', output, '--device', String(device), '--seconds', String(seconds)], event => {
          if (event.type === 'enrollment_progress' || event.type === 'enrollment_ready') {
            state.enrollment.elapsedMs = Math.max(0, finite(event.elapsedMs) ?? now() - began);
            state.enrollment.voicedMs = Math.max(0, finite(event.voicedMs) ?? 0); publish();
          } else if (event.type === 'enrollment_completed' && event.profileCreated === true) completed = publicSpeakerProfile(event.profile);
          else if (event.type === 'enrollment_error') state.enrollment.reason = safeCode(event.code);
        }, maxEnrollmentMs, 'enroll');
        if (enrollmentCancelled || closed) cancelled = true;
        if (cancelled || !completed || !validHash(completed.profileSha256)) fail(cancelled ? 'enrollment_cancelled' : 'speaker_enrollment_incomplete');
        const info = await stat(output);
        if (!info.isFile() || info.size > 65_536) fail('speaker_profile_invalid');
        const actual = createHash('sha256').update(await readFile(output)).digest('hex');
        if (actual !== completed.profileSha256 || completed.sourceKind !== 'user_microphone') fail('speaker_profile_invalid');
        const temporary = join(profileDirectory, `pointer-${randomUUID()}.json`);
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, file }) + '\n', { flag: 'wx' });
        // One tiny synchronous atomic commit prevents cancel/close interleaving
        // between the final generation check and changing the active pointer.
        if (enrollmentCancelled || closed) fail('enrollment_cancelled');
        renameSync(temporary, join(profileDirectory, 'active.json'));
        activeProfile = output; state.enrolled = true; state.profile = completed; state.status = 'ready';
      } catch (error) {
        state.enrollment.reason = enrollmentCancelled || closed ? 'enrollment_cancelled' : safeCode(error.safeCode); state.status = state.enrolled ? 'ready' : 'missing';
      } finally { state.enrollment.active = false; state.enrollment.elapsedMs = Math.max(state.enrollment.elapsedMs, now() - began); publish(); }
    })();
    enrollmentTask = work.finally(() => { enrollmentTask = null; });
    return { started: true, completion: enrollmentTask };
  }
  async function cancel() {
    if (!enrollmentTask) return { cancelled: false };
    enrollmentCancelled = true; state.enrollment.reason = 'enrollment_cancelled'; owned?.cancelSpeakerOperation?.();
    await enrollmentTask.catch(() => {});
    return { cancelled: true };
  }
  async function close() { closed = true; enrollmentCancelled = true; owned?.cancelSpeakerOperation?.(); await enrollmentTask?.catch(() => {}); await operation?.promise.catch(() => {}); return { terminationConfirmed: !fatalUnconfirmed }; }
  return { snapshot, refresh, enroll, cancel, close, busy: () => Boolean(operation || enrollmentTask || state.enrollment.active),
    healthy: () => !fatalUnconfirmed && !closed,
    admittedProfile: () => state.enrolled && state.status === 'ready' && !fatalUnconfirmed && !closed ? activeProfile : null };
}
