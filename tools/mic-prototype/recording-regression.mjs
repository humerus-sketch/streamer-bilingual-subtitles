/** Unattended, file-only regression. Owns a loopback gateway; never opens a browser or microphone. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGateway } from './gateway.mjs';
import { validateReplay } from './replay-validation.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const safeCode = error => /^[a-zA-Z0-9_.:-]+$/.test(error?.message ?? '') ? error.message : 'automatic_regression_failed';

const bilingualReady = (row, sessionId) => row.workerSessionId === sessionId && row.status === 'completed'
  && row.terminal === true && Number.isFinite(row.orderedAtNodeMs)
  && row.translation && Object.keys(row.translation).sort().join(',') === 'en,zh'
  && ['zh', 'en'].every(language => typeof row.translation[language] === 'string' && row.translation[language].trim())
  && row.translationDiagnostics?.terminal_event === 'turn/completed' && row.translationDiagnostics?.final_status === 'completed';

export function mayContinueAfterRound(control, report, state) {
  return control?.sessionId === report?.session?.id && state.phase === 'capture_stopped'
    && !state.workerActive && !state.captureStarting && !state.residentClosing
    && !state.queue?.active && !state.queue?.pending && !state.cliProcessExitUnconfirmed
    && Array.isArray(report.rows) && report.rows.length > 0 && report.warnings?.length === 0
    && report.rows.every(row => bilingualReady(row, control.sessionId) || row.status === 'gap' && row.errorCode === 'empty_asr');
}

export async function freezeRound({ folder, control, definition, failure },
  { mkdirImpl = mkdir, readFileImpl = readFile, writeFileImpl = writeFile } = {}) {
  await mkdirImpl(folder);
  const files = [];
  for (const name of ['report.json', 'events.jsonl', 'session.json']) {
    const bytes = await readFileImpl(join(control.outputDir, name));
    await writeFileImpl(join(folder, name), bytes, { flag: 'wx' });
    files.push({ file: name, bytes: bytes.length, sha256: sha(bytes) });
  }
  const result = { round: definition, session_id: control.sessionId, frozen_at_utc: new Date().toISOString(),
    driver_passed: control.passed, failure, page_required: false, microphone_opened: false, files };
  await writeFileImpl(join(folder, 'freeze-record.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

export async function runRecordingRegression({ planFile },
  { createGatewayImpl = createGateway, validateReplayImpl = validateReplay, progress = value => process.stdout.write(JSON.stringify(value) + '\n') } = {}) {
  const planPath = resolve(planFile), base = dirname(planPath), plan = await readJson(planPath);
  const specPath = resolve(workspace, plan.base_spec_path);
  if (sha(await readFile(specPath)) !== plan.base_spec_sha256) throw new Error('base_spec_hash_mismatch');
  if (sha(await readFile(fileURLToPath(import.meta.url))) !== plan.runner_sha256) throw new Error('automatic_runner_hash_mismatch');
  const spec = await readJson(specPath), manifestPath = resolve(workspace, spec.manifest_path);
  if (sha(await readFile(manifestPath)) !== spec.manifest_sha256) throw new Error('manifest_hash_mismatch');
  const manifest = await readJson(manifestPath);
  for (const item of spec.runtime_sources) {
    if (sha(await readFile(resolve(workspace, item.path))) !== item.sha256) throw new Error('runtime_changed_after_freeze');
  }
  const releasePath = resolve(base, plan.release_gate_file);
  if (sha(await readFile(releasePath)) !== plan.release_gate_sha256) throw new Error('release_gate_hash_mismatch');
  const release = await readJson(releasePath);
  if (release.allow_limited_automatic_measurement !== true || plan.microphone_opened !== false || plan.page_required !== false) throw new Error('automatic_measurement_not_released');
  for (const playlist of Object.values(manifest.rounds)) {
    if (sha(await readFile(playlist.file)) !== playlist.sha256) throw new Error('replay_hash_mismatch');
  }
  const outputDir = join(base, 'replay-controls');
  await mkdir(outputDir, { recursive: true });
  // Exclusive creation reserves the run before any local service or cloud request starts.
  await writeFile(join(base, 'automatic-run-start.json'), JSON.stringify({ started_at_utc: new Date().toISOString(),
    page_required: false, microphone_opened: false, plan_sha256: sha(await readFile(planPath)) }, null, 2) + '\n', { flag: 'wx' });
  let gateway, fatal = null;
  const results = [];
  try {
    gateway = await createGatewayImpl({ port: 0, translationProvider: 'codex_resident', codexServiceTier: 'fast', codexPromptStyle: 'full',
      codexExecutable: spec.cli.file, python: resolve(workspace, '.runtime/mic-prototype/.venv/Scripts/python.exe'),
      modelDir: resolve(workspace, '.runtime/mic-prototype/models/large-v3'),
      workerScripts: Object.fromEntries(spec.rounds.map(round => [round.worker_id, resolve(workspace, round.worker_script)])),
      replayFile: manifest.rounds.forward.file,
      replayFiles: Object.fromEntries(Object.entries(manifest.rounds).map(([key, value]) => [key, value.file])),
      outputBase: join(base, 'live-runs') });
    if (gateway.state.auth !== 'authorized') throw new Error('codex_cli_auth_required');
    for (const definition of spec.rounds) {
      progress({ type: 'round_started', label: definition.id, arm: definition.arm, order: definition.round,
        pageRequired: false, microphoneOpened: false });
      let control, failure = null;
      try {
        control = await validateReplayImpl({ origin: gateway.origin + '/', label: definition.id, replayId: definition.round,
          workerId: definition.worker_id, outputDir, concurrency: 2, computeType: 'int8_float16', timeoutMs: 600_000,
          requireVisibleAcknowledgements: false });
      } catch (error) {
        failure = safeCode(error);
        try { control = await readJson(join(outputDir, definition.id + '.json')); }
        catch { throw error; }
      }
      if (control.actualWorkerId !== definition.worker_id
        || resolve(control.actualWorkerScript) !== resolve(workspace, definition.worker_script)
        || control.actualReplayId !== definition.round) throw new Error('actual_source_selection_mismatch');
      const report = await readJson(join(control.outputDir, 'report.json'));
      const frozen = await freezeRound({ folder: join(base, 'frozen-' + definition.id), control, definition, failure });
      results.push({ label: definition.id, driverPassed: control.passed, failure, completed: control.completed,
        segments: control.segments, sessionId: control.sessionId, frozen_at_utc: frozen.frozen_at_utc });
      progress({ type: 'round_finished', ...results.at(-1) });
      if (!mayContinueAfterRound(control, report, gateway.state)) throw new Error('round_failed_beyond_known_asr_gaps');
    }
  } catch (error) {
    fatal = safeCode(error);
  } finally {
    if (gateway) await gateway.close();
  }
  const summary = { finished_at_utc: new Date().toISOString(), completed_all_planned_rounds: results.length === spec.rounds.length,
    all_chain_checks_passed: results.length === spec.rounds.length && results.every(round => round.driverPassed),
    rounds: results, not_run: spec.rounds.slice(results.length).map(round => round.id), fatal,
    microphone_opened: false, browser_opened: false, page_required: false,
    primary_endpoint: 'All required segments have successful complete bilingual output and orderedAtNodeMs; page display requires separate real ACK evidence.' };
  await writeFile(join(base, 'automatic-run-summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  progress({ type: 'automatic_regression_finished', ...summary });
  if (fatal) throw new Error(fatal);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--plan') throw new Error('usage_recording_regression_plan_required');
  runRecordingRegression({ planFile: args[1] }).catch(error => {
    process.stderr.write(JSON.stringify({ type: 'automatic_regression_failed', code: safeCode(error) }) + '\n');
    process.exitCode = 1;
  });
}
