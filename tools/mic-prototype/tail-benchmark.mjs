import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAppServer } from './codex-app-server.mjs';
import { checkCodexLogin, codexTranslationPrompt } from './codex-translation.mjs';

const ownDirectory = fileURLToPath(new URL('.', import.meta.url));
const ARMS = ['baseline', 'candidate'];
const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1000) / 1000;
const safeError = code => Object.assign(new Error(code), { safeCode: code });
const codeOf = (error, fallback) => typeof error?.safeCode === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(error.safeCode) ? error.safeCode : fallback;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function createTailSchedule(fixtures, maxTurnsPerThread = 3) {
  if (!Array.isArray(fixtures) || !fixtures.length || !Number.isSafeInteger(maxTurnsPerThread) || maxTurnsPerThread < 1 || maxTurnsPerThread > 3) throw safeError('invalid_tail_schedule');
  const forward = fixtures.flatMap((fixture, index) => (index % 2 ? [...ARMS].reverse() : ARMS).map(arm => ({ block: 1, case_id: fixture.id, arm })));
  const schedule = [...forward, ...[...forward].reverse().map(step => ({ ...step, block: 2 }))];
  const turns = new Map();
  return schedule.map((step, index) => {
    const key = step.block + ':' + step.arm, completed = turns.get(key) ?? 0;
    turns.set(key, completed + 1);
    return { index, ...step, expected_prior_successful_turns_in_thread: completed % maxTurnsPerThread,
      expected_thread_sequence_in_block: Math.floor(completed / maxTurnsPerThread) + 1 };
  });
}

function closureProjection(value) {
  return { closed: value?.closed === true, termination_confirmed: value?.termination_confirmed === true,
    exit_code: Number.isInteger(value?.exit_code) ? value.exit_code : null,
    exit_signal: typeof value?.exit_signal === 'string' && /^[A-Z0-9]{1,16}$/.test(value.exit_signal) ? value.exit_signal : null,
    unusable_code: value?.unusable_code === null ? null : codeOf({ safeCode: value?.unusable_code }, 'tail_close_status_unknown') };
}

function validateCompletion(result, source, instructionsSha256) {
  const translation = result?.translation, request = result?.telemetry?.request;
  return result?.success === true && result?.terminal_event === 'turn/completed' && result?.final_status === 'completed'
    && translation && !Array.isArray(translation) && Object.keys(translation).sort().join(',') === 'en,zh'
    && ['zh', 'en'].every(key => typeof translation[key] === 'string' && translation[key].trim())
    && result.model === 'gpt-6.1-sol' && request?.model === 'gpt-6.1-sol' && request?.requested_service_tier === 'fast'
    && request?.resolved_thread_reasoning_effort === 'low' && request?.prompt_sha256 === source.prompt_sha256
    && (request?.prompt_style ?? 'full') === source.prompt_style && request?.ja_sha256 === source.ja_sha256
    && request?.instructions_sha256 === instructionsSha256 && nonnegative(result?.timings_ms?.completed);
}

/** Text-only controlled probe. No microphone, quota query, fallback, outer retry or default-application change. */
export async function runTailBenchmark({ executable, fixturePath, candidateInstructionsFile,
  baselineInstructionsFile = join(ownDirectory, 'translation-base.md'), outputDirectory, cwd,
  maxTurnsPerThread = 3, candidatePromptStyle = 'full', serviceTier = 'fast', timeoutMs = 30_000, allowSmallFixtureSet = false,
  createServer = createCodexAppServer, loginCheck = checkCodexLogin, now = () => performance.now(), onProgress = () => {}, signal } = {}) {
  if (![executable, fixturePath, candidateInstructionsFile, baselineInstructionsFile, outputDirectory, cwd].every(value => typeof value === 'string' && value)
    || serviceTier !== 'fast' || !['full', 'source_only'].includes(candidatePromptStyle) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxTurnsPerThread) || maxTurnsPerThread < 1 || maxTurnsPerThread > 3) throw safeError('invalid_tail_benchmark_options');
  const fixtureBytes = await readFile(fixturePath), document = JSON.parse(fixtureBytes);
  const original = Array.isArray(document) ? document : document.fixtures;
  if (!Array.isArray(original) || !original.length || !allowSmallFixtureSet && original.length !== 30) throw safeError('tail_fixture_count_mismatch');
  const fixtures = original.map(value => ({ id: value.id, ja: value.ja, context: value.context ?? '' }));
  if (new Set(fixtures.map(value => value.id)).size !== fixtures.length || new Set(fixtures.map(value => value.ja)).size !== fixtures.length
    || fixtures.some(value => typeof value.id !== 'string' || !value.id || value.id.length > 100 || typeof value.ja !== 'string' || !value.ja.trim()
      || typeof value.context !== 'string')) throw safeError('invalid_tail_fixtures');
  const promptStyles = { baseline: 'full', candidate: candidatePromptStyle };
  const prompts = Object.fromEntries(ARMS.map(arm => [arm, new Map(fixtures.map(fixture => [fixture.id,
    promptStyles[arm] === 'source_only' ? JSON.stringify({ ja: fixture.ja, context: fixture.context, glossary: [] })
      : codexTranslationPrompt({ fixture, glossary: [] })]))]));
  for (const fixture of original) if (fixture.request_fingerprint?.prompt_sha256
    && fixture.request_fingerprint.prompt_sha256 !== hash(prompts.baseline.get(fixture.id))) throw safeError('tail_fixture_prompt_fingerprint_mismatch');
  const instructionBytes = { baseline: await readFile(baselineInstructionsFile), candidate: await readFile(candidateInstructionsFile) };
  if (Object.values(instructionBytes).some(value => !value.length || value.length > 65_536)
    || instructionBytes.baseline.equals(instructionBytes.candidate) && promptStyles.baseline === promptStyles.candidate) throw safeError('invalid_tail_instruction_pair');
  const schedule = createTailSchedule(fixtures, maxTurnsPerThread), scheduleBytes = JSON.stringify({ schedule }, null, 2) + '\n';
  const fixtureProjection = JSON.stringify({ fixtures }, null, 2) + '\n';
  const sourceNames = ['tail-benchmark.mjs', 'codex-app-server.mjs', 'codex-translation.mjs', 'bilingual.schema.json'];
  const sourceBytes = await Promise.all(sourceNames.map(async name => ({ name, bytes: await readFile(join(ownDirectory, name)) })));
  const manifest = { schema_version: 1, started_at: new Date().toISOString(), requested_model: 'gpt-6.1-sol', requested_service_tier: 'fast',
    served_response_model: null, observed_service_tier: null, required_catalog_and_resolved_thread_effort: 'low',
    sequential_global_concurrency: 1, independent_resident_clients: 2, max_successful_turns_per_thread: maxTurnsPerThread,
    blocks: 2, fixture_count: fixtures.length, scheduled_samples: schedule.length, small_fixture_set: allowSmallFixtureSet,
    fixture_source_sha256: hash(fixtureBytes), source_only_fixture_sha256: hash(fixtureProjection), schedule_sha256: hash(scheduleBytes),
    arms: Object.fromEntries(ARMS.map(arm => [arm, { prompt_style: promptStyles[arm], instructions_sha256: hash(instructionBytes[arm]), instruction_snapshot: arm + '-instructions.md' }])),
    sources: sourceBytes.map(({ name, bytes }) => ({ name, sha256: hash(bytes) })),
    policy: { no_outer_retries: true, no_model_fallback: true, reset_threads_at_block_boundary: true, source_only_fields: ['id', 'ja', 'context'], glossary: [] },
    boundaries: ['Text dispatch to strict completed bilingual output; process startup and thread release/setup are separate.',
      'Instruction and prompt styles are recorded by arm. Japanese, explicit context, empty glossary, requested model/tier and required effort are fixed.',
      'Each arm has independent actual response history; source order and three-turn reset positions match across arms.',
      'Repeated blocks are paired repeated observations, not 60 independent Japanese sources.',
      'No audio, browser display, transcription accuracy or native-human translation quality is measured here.'] };
  await mkdir(outputDirectory, { recursive: false });
  await mkdir(cwd, { recursive: true });
  const snapshot = join(outputDirectory, 'source-snapshot'); await mkdir(snapshot);
  for (const { name, bytes } of sourceBytes) await writeFile(join(snapshot, name), bytes, { flag: 'wx' });
  for (const arm of ARMS) await writeFile(join(snapshot, manifest.arms[arm].instruction_snapshot), instructionBytes[arm], { flag: 'wx' });
  await writeFile(join(outputDirectory, 'fixtures.source-only.json'), fixtureProjection, { flag: 'wx' });
  await writeFile(join(outputDirectory, 'schedule.json'), scheduleBytes, { flag: 'wx' });
  await writeFile(join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const results = schedule.map(step => ({ ...step, attempted: false, translation_invoked: false, outcome: 'not_run', success: false, error: null }));
  const byId = new Map(fixtures.map(fixture => [fixture.id, fixture])), clients = new Map();
  let fatalCode = null, active = null, startupArm = null;
  const emit = async value => {
    try { await appendFile(join(outputDirectory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); }
    catch { throw safeError('tail_evidence_write_failed'); }
  };
  try {
    const login = await loginCheck({ executable });
    if (login?.loggedIn !== true || login?.authMode !== 'chatgpt') throw safeError('codex_cli_auth_required');
    for (const arm of ARMS) {
      startupArm = arm;
      if (signal?.aborted) throw safeError('tail_benchmark_cancelled');
      const begin = now(), instructionsFile = join(snapshot, manifest.arms[arm].instruction_snapshot);
      const client = await createServer({ executable, cwd, instructionsFile, promptStyle: promptStyles[arm], model: { slug: 'gpt-6.1-sol' }, serviceTier, timeoutMs });
      const state = { client, thread: null, block: null, successfulTurns: 0, threadSequence: 0 };
      clients.set(arm, state);
      const diagnostics = client.diagnostics();
      if (diagnostics?.alignment?.explicit_process_effort !== 'low' || diagnostics?.alignment?.model_catalog_default_effort !== 'low') throw safeError('tail_catalog_effort_mismatch');
      manifest.arms[arm].startup_ms = round(now() - begin);
      manifest.arms[arm].reported_startup_ms = client.startupMs ?? null;
      await emit({ type: 'server_ready', arm, startup_ms: manifest.arms[arm].startup_ms, diagnostics });
      startupArm = null;
    }
    for (const step of schedule) {
      if (signal?.aborted) { fatalCode = 'tail_benchmark_cancelled'; break; }
      active = results[step.index]; active.attempted = true; active.outcome = 'started';
      const state = clients.get(step.arm), fixture = byId.get(step.case_id), sampleStarted = now();
      const prompt = prompts[step.arm].get(fixture.id);
      const source = { prompt_style: promptStyles[step.arm], prompt_sha256: hash(prompt), ja_sha256: hash(fixture.ja), context_sha256: hash(fixture.context),
        prompt_bytes: Buffer.byteLength(prompt), instructions_sha256: manifest.arms[step.arm].instructions_sha256 };
      Object.assign(active, source, { thread_release_ms: 0, thread_setup_ms: 0, reported_thread_setup_ms: 0 });
      await emit({ type: 'sample_started', ...step, ...source });
      if (state.thread && (state.block !== step.block || state.successfulTurns >= maxTurnsPerThread)) {
        const releaseStarted = now(); await state.client.releaseThread(state.thread);
        active.thread_release_ms = round(now() - releaseStarted); state.thread = null; state.successfulTurns = 0;
      }
      if (!state.thread) {
        const setupStarted = now(), thread = await state.client.startThread();
        active.thread_setup_ms = round(now() - setupStarted); active.reported_thread_setup_ms = thread.setupMs ?? null;
        if (thread.telemetry?.observed?.model !== 'gpt-6.1-sol' || thread.telemetry?.observed?.reasoningEffort !== 'low') throw safeError('tail_thread_configuration_mismatch');
        state.thread = thread.threadId; state.threadSequence++; state.block = step.block;
        await emit({ type: 'thread_ready', index: step.index, arm: step.arm, block: step.block,
          thread_sequence: state.threadSequence, setup_ms: active.thread_setup_ms, release_ms: active.thread_release_ms });
      }
      active.actual_prior_successful_turns_in_thread = state.successfulTurns;
      active.thread_sequence = state.threadSequence;
      if (state.successfulTurns !== step.expected_prior_successful_turns_in_thread) throw safeError('tail_history_position_mismatch');
      active.translation_invoked = true;
      const dispatched = now();
      const result = await state.client.translate({ threadId: state.thread, fixture, glossary: [] });
      const returned = now(), success = validateCompletion(result, source, source.instructions_sha256);
      Object.assign(active, { success, outcome: success ? 'completed' : 'failed', translation: success ? result.translation : null,
        error: success ? null : { code: codeOf({ safeCode: result?.error?.code }, 'invalid_tail_translation_result') },
        terminal_event: result?.terminal_event ?? null, final_status: result?.final_status ?? null,
        dispatch_to_bilingual_ms: round(returned - dispatched), sample_with_setup_to_bilingual_ms: round(returned - sampleStarted),
        strict_transport_completed_ms: success ? result.timings_ms.completed : null,
        timings_ms: result?.timings_ms ?? null, usage: result?.usage ?? null, telemetry: result?.telemetry ?? null });
      if (success) state.successfulTurns++;
      const finishedResult = active; active = null;
      await emit({ type: 'sample_finished', result: finishedResult });
      await writeFile(join(outputDirectory, 'progress.json'), JSON.stringify({ finished_samples: results.filter(value => ['completed', 'failed'].includes(value.outcome)).length,
        scheduled_samples: schedule.length, last_index: step.index, last_arm: step.arm, last_case_id: step.case_id, success }, null, 2) + '\n');
      try { onProgress({ index: step.index, completed: results.filter(value => value.outcome === 'completed').length, scheduled: schedule.length,
        arm: step.arm, block: step.block, case_id: step.case_id, success, strict_transport_completed_ms: finishedResult.strict_transport_completed_ms }); } catch {}
      if (!success) { fatalCode = 'tail_sample_failed_no_retry'; break; }
      if (result.telemetry?.process_reusable !== true) { fatalCode = 'tail_process_not_reusable'; break; }
    }
  } catch (error) {
    fatalCode = codeOf(error, 'tail_setup_or_transport_failed');
    if (startupArm) manifest.startup_failure = { arm: startupArm, code: fatalCode,
      failed_client_process_closed: typeof error?.diagnostics?.process?.closed === 'boolean' ? error.diagnostics.process.closed : null,
      failed_discovery_termination_confirmed: typeof error?.diagnostics?.discovery_close?.termination_confirmed === 'boolean'
        ? error.diagnostics.discovery_close.termination_confirmed : null };
    if (active) {
      Object.assign(active, { outcome: 'failed', success: false, translation: null, error: { code: fatalCode }, terminal_event: null, final_status: 'client_error' });
      await emit({ type: 'sample_finished', result: active }); active = null;
    }
    try { await emit({ type: 'benchmark_error', code: fatalCode }); } catch { fatalCode ??= 'tail_evidence_write_failed'; }
  } finally {
    for (const [arm, state] of clients) {
      let closed;
      try { closed = closureProjection(await state.client.close()); }
      catch { closed = closureProjection({ closed: false, termination_confirmed: false, unusable_code: 'tail_server_close_failed' }); }
      manifest.arms[arm].close = closed;
      try { manifest.arms[arm].final_diagnostics = state.client.diagnostics(); }
      catch { manifest.arms[arm].final_diagnostics = { unavailable_code: 'tail_final_diagnostics_failed' }; fatalCode ??= 'tail_final_diagnostics_failed'; }
      if (!closed.termination_confirmed || !closed.closed) fatalCode ??= 'tail_server_close_unconfirmed';
      else if (closed.exit_code !== 0) fatalCode ??= 'tail_server_close_nonzero';
      else if (closed.unusable_code) fatalCode ??= closed.unusable_code;
      try { await emit({ type: 'server_closed', arm, result: closed }); } catch { fatalCode ??= 'tail_evidence_write_failed'; }
    }
    manifest.finished_at = new Date().toISOString(); manifest.fatal_code = fatalCode;
    manifest.attempted_samples = results.filter(value => value.attempted).length;
    manifest.translation_calls = results.filter(value => value.translation_invoked).length;
    manifest.successful_samples = results.filter(value => value.outcome === 'completed').length;
    manifest.failed_samples = results.filter(value => value.outcome === 'failed').length;
    manifest.not_run_samples = results.filter(value => value.outcome === 'not_run').length;
    await writeFile(join(outputDirectory, 'results.json'), JSON.stringify({ manifest, results }, null, 2) + '\n', { flag: 'wx' });
    await emit({ type: 'benchmark_finished', attempted: manifest.attempted_samples, successful: manifest.successful_samples,
      failed: manifest.failed_samples, not_run: manifest.not_run_samples, scheduled: schedule.length, fatal_code: fatalCode });
  }
  return { outputDirectory, scheduled: schedule.length, attempted: manifest.attempted_samples, successful: manifest.successful_samples,
    failed: manifest.failed_samples, not_run: manifest.not_run_samples, translation_calls: manifest.translation_calls, fatal_code: fatalCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tokens = process.argv.slice(2), allowed = new Set(['--codex', '--fixtures', '--candidate-instructions', '--baseline-instructions', '--candidate-prompt-style', '--output', '--cwd', '--max-turns', '--small-fixture-set']);
  if (tokens.length % 2 || tokens.some((value, index) => index % 2 === 0 && !allowed.has(value))) throw safeError('invalid_tail_cli_arguments');
  const args = Object.fromEntries(tokens.reduce((pairs, value, index) => { if (index % 2 === 0) pairs.push([value, tokens[index + 1]]); return pairs; }, []));
  if (!['--codex', '--fixtures', '--candidate-instructions', '--output', '--cwd'].every(key => args[key])) throw safeError('missing_tail_cli_arguments');
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const result = await runTailBenchmark({ executable: resolve(args['--codex']), fixturePath: resolve(args['--fixtures']),
      candidateInstructionsFile: resolve(args['--candidate-instructions']), baselineInstructionsFile: args['--baseline-instructions'] ? resolve(args['--baseline-instructions']) : undefined,
      outputDirectory: resolve(args['--output']), cwd: resolve(args['--cwd']), maxTurnsPerThread: args['--max-turns'] === undefined ? 3 : Number(args['--max-turns']),
      candidatePromptStyle: args['--candidate-prompt-style'] ?? 'full',
      allowSmallFixtureSet: args['--small-fixture-set'] === 'true', signal: controller.signal,
      onProgress: value => { if ((value.index + 1) % 6 === 0 || !value.success) process.stdout.write(JSON.stringify(value) + '\n'); } });
    process.stdout.write(JSON.stringify(result) + '\n'); if (result.fatal_code) process.exitCode = 1;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
