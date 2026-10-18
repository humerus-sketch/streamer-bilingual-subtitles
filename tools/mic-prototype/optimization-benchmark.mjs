import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexMonolingualTranslationPrompt, createCodexAppServer } from './codex-app-server.mjs';
import { checkCodexLogin, codexTranslationPrompt } from './codex-translation.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const PROFILES = Object.freeze({ baseline: { targets: ['bilingual'], cap: 3 }, excluded: { targets: ['bilingual'], cap: 3 },
  reuse6: { targets: ['bilingual'], cap: 6 }, parallel: { targets: ['zh', 'en'], cap: 3 }, parallel_excluded: { targets: ['zh', 'en'], cap: 3 } });
const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1000) / 1000;
const safeError = code => Object.assign(new Error(code), { safeCode: code });
const codeOf = (error, fallback) => typeof error?.safeCode === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(error.safeCode) ? error.safeCode : fallback;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validProfiles = profiles => Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 4
  && new Set(profiles).size === profiles.length && profiles.every(name => typeof name === 'string' && Object.hasOwn(PROFILES, name));

function effectiveProfileCaps(profiles, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || Reflect.ownKeys(overrides).some(name => typeof name !== 'string' || !profiles.includes(name)
      || !Number.isSafeInteger(overrides[name]) || overrides[name] < 1 || overrides[name] > 30)) throw safeError('invalid_optimization_thread_caps');
  return Object.fromEntries(profiles.map(profile => [profile, Object.hasOwn(overrides, profile) ? overrides[profile] : PROFILES[profile].cap]));
}

export function parseOptimizationThreadCaps(text) {
  if (typeof text !== 'string' || !text) throw safeError('invalid_optimization_thread_caps');
  const pairs = text.split(',').map(part => part.split('='));
  if (pairs.some(pair => pair.length !== 2 || !/^[a-z][a-z0-9_]*$/.test(pair[0]) || !/^[0-9]+$/.test(pair[1])
    || !Number.isSafeInteger(Number(pair[1])) || Number(pair[1]) < 1 || Number(pair[1]) > 30)
    || new Set(pairs.map(pair => pair[0])).size !== pairs.length) throw safeError('invalid_optimization_thread_caps');
  return Object.fromEntries(pairs.map(([profile, cap]) => [profile, Number(cap)]));
}

export function createOptimizationSchedule(fixtures, profiles = ['baseline', 'parallel'], threadCapOverrides = {}) {
  if (!Array.isArray(fixtures) || !fixtures.length || !validProfiles(profiles)) throw safeError('invalid_optimization_schedule');
  const profileCaps = effectiveProfileCaps(profiles, threadCapOverrides);
  const forward = fixtures.flatMap((fixture, index) => {
    const offset = index % profiles.length, order = [...profiles.slice(offset), ...profiles.slice(0, offset)];
    return order.map(profile => ({ block: 1, case_id: fixture.id, profile }));
  });
  const counters = new Map();
  return [...forward, ...[...forward].reverse().map(step => ({ ...step, block: 2 }))].map((step, index) => {
    const key = step.block + ':' + step.profile, turns = counters.get(key) ?? 0, cap = profileCaps[step.profile];
    counters.set(key, turns + 1);
    return { index, ...step, max_successful_turns_per_thread: cap, expected_prior_successful_turns_in_thread: turns % cap,
      expected_thread_sequence_in_block: Math.floor(turns / cap) + 1 };
  });
}

/** Exclusion is an explicit experimental per-process request, never a global config mutation. */
export function createOptimizationSpawn(profile, spawnImpl = spawn) {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile) || typeof spawnImpl !== 'function') throw safeError('invalid_optimization_spawn');
  return ['excluded', 'parallel_excluded'].includes(profile) ? (executable, args, options) => spawnImpl(executable,
    ['-c', 'features.code_mode.excluded_tool_namespaces=["functions"]', ...args], options) : spawnImpl;
}

function closureProjection(value) {
  return { closed: value?.closed === true, termination_confirmed: value?.termination_confirmed === true,
    exit_code: Number.isInteger(value?.exit_code) ? value.exit_code : null,
    exit_signal: typeof value?.exit_signal === 'string' && /^[A-Z0-9]{1,16}$/.test(value.exit_signal) ? value.exit_signal : null,
    unusable_code: value?.unusable_code === null ? null : codeOf({ safeCode: value?.unusable_code }, 'optimization_close_status_unknown') };
}

async function boundedClose(client, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => client.close()).then(closureProjection,
      () => closureProjection({ unusable_code: 'optimization_close_failed' })),
    new Promise(done => { timer = setTimeout(() => done(closureProjection({ unusable_code: 'optimization_close_deadline' })), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

function projectResult(result) {
  if (!result || typeof result !== 'object') return null;
  return { model: result.model ?? null, success: result.success === true, terminal_event: result.terminal_event ?? null,
    final_status: result.final_status ?? null, translation: result.translation ?? null, timings_ms: result.timings_ms ?? null,
    usage: result.usage ?? null, telemetry: result.telemetry ?? null,
    error: result.error ? { code: codeOf({ safeCode: result.error.code }, 'optimization_translation_failed') } : null };
}

function validateCompletion(result, expected) {
  const keys = expected.translation_target === 'bilingual' ? ['en', 'zh'] : [expected.translation_target];
  const value = result?.translation, request = result?.telemetry?.request;
  const readyKey = expected.translation_target === 'bilingual' ? 'bilingual_json_ready' : 'translation_json_ready';
  return result?.success === true && result?.terminal_event === 'turn/completed' && result?.final_status === 'completed'
    && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.join(',')
    && keys.every(key => typeof value[key] === 'string' && value[key].trim())
    && result.model === 'gpt-6.1-sol' && request?.model === 'gpt-6.1-sol' && request?.requested_service_tier === 'fast'
    && request?.resolved_thread_model === 'gpt-6.1-sol' && ['fast', 'priority'].includes(request?.resolved_thread_service_tier)
    && request?.resolved_thread_reasoning_effort === 'low' && request?.model_default_reasoning_effort === 'low'
    && request?.translation_target === expected.translation_target && request?.prompt_style === 'full'
    && request?.prompt_sha256 === expected.prompt_sha256 && request?.prompt_bytes === expected.prompt_bytes
    && request?.ja_sha256 === expected.ja_sha256 && request?.instructions_sha256 === expected.instructions_sha256
    && nonnegative(result?.timings_ms?.completed) && nonnegative(result?.timings_ms?.[readyKey])
    && result.timings_ms[readyKey] <= result.timings_ms.completed && result.telemetry.process_reusable === true;
}

/** Controlled text-only probe. All parent samples are serial; parallel has only two distinct language branches. */
export async function runOptimizationBenchmark({ executable, fixturePath, outputDirectory, cwd, profiles = ['baseline', 'parallel'], threadCapOverrides = {},
  serviceTier = 'fast', timeoutMs = 30_000, closeDeadlineMs = 4000, allowSmallFixtureSet = false,
  createServer = createCodexAppServer, loginCheck = checkCodexLogin, spawnImpl = spawn,
  now = () => performance.now(), onProgress = () => {}, signal } = {}) {
  if (![executable, fixturePath, outputDirectory, cwd].every(value => typeof value === 'string' && value)
    || !validProfiles(profiles) || serviceTier !== 'fast' || ![timeoutMs, closeDeadlineMs].every(value => Number.isSafeInteger(value) && value > 0)
    || typeof createServer !== 'function' || typeof loginCheck !== 'function' || typeof spawnImpl !== 'function') throw safeError('invalid_optimization_options');
  const profileCaps = effectiveProfileCaps(profiles, threadCapOverrides);
  const inputBytes = await readFile(fixturePath), document = JSON.parse(inputBytes), original = Array.isArray(document) ? document : document.fixtures;
  if (!Array.isArray(original) || !original.length || !allowSmallFixtureSet && ![30, 60].includes(original.length)) throw safeError('optimization_fixture_count_mismatch');
  const fixtures = original.map(value => ({ id: value?.id, ja: value?.ja, context: value?.context ?? '' }));
  if (new Set(fixtures.map(value => value.id)).size !== fixtures.length || new Set(fixtures.map(value => value.ja)).size !== fixtures.length
    || fixtures.some(value => typeof value.id !== 'string' || !value.id || value.id.length > 100 || typeof value.ja !== 'string' || !value.ja.trim()
      || typeof value.context !== 'string')) throw safeError('invalid_optimization_fixtures');
  const targets = [...new Set(profiles.flatMap(profile => PROFILES[profile].targets))];
  const instructionNames = Object.fromEntries(targets.map(target => [target, target === 'bilingual' ? 'translation-base.md' : `translation-${target}.md`]));
  const sourceNames = ['optimization-benchmark.mjs', 'codex-app-server.mjs', 'codex-translation.mjs', 'bilingual.schema.json', ...Object.values(instructionNames)];
  const sourceBytes = await Promise.all(sourceNames.map(async name => ({ name, bytes: await readFile(join(directory, name)) })));
  sourceBytes.push({ name: 'siwc-probe-inference.mjs', original_path: '../siwc-probe/inference.mjs', bytes: await readFile(new URL('../siwc-probe/inference.mjs', import.meta.url)) });
  const instructions = Object.fromEntries(targets.map(target => [target, sourceBytes.find(entry => entry.name === instructionNames[target])]));
  const expectedByTarget = Object.fromEntries(targets.map(target => [target, new Map(fixtures.map(fixture => {
    const prompt = target === 'bilingual' ? codexTranslationPrompt({ fixture, glossary: [] })
      : codexMonolingualTranslationPrompt({ fixture, glossary: [], translationTarget: target });
    return [fixture.id, { translation_target: target, prompt_style: 'full', prompt_sha256: hash(prompt), prompt_bytes: Buffer.byteLength(prompt),
      ja_sha256: hash(fixture.ja), context_sha256: hash(fixture.context), instructions_sha256: hash(instructions[target].bytes) }];
  }))]));
  for (const fixture of original) if (fixture.request_fingerprint?.prompt_sha256
    && fixture.request_fingerprint.prompt_sha256 !== hash(codexTranslationPrompt({ fixture, glossary: [] }))) throw safeError('optimization_source_fingerprint_mismatch');
  const schedule = createOptimizationSchedule(fixtures, profiles, threadCapOverrides), scheduleBytes = JSON.stringify({ schedule }, null, 2) + '\n';
  const fixtureBytes = JSON.stringify({ fixtures }, null, 2) + '\n';
  const manifest = { schema_version: 1, started_at: new Date().toISOString(), requested_model: 'gpt-6.1-sol', requested_service_tier: 'fast',
    served_response_model: null, observed_service_tier: null, required_catalog_and_resolved_thread_effort: 'low',
    parent_concurrency: 1, maximum_branch_concurrency: profiles.some(profile => PROFILES[profile].targets.length === 2) ? 2 : 1,
    independent_resident_clients: profiles.reduce((sum, profile) => sum + PROFILES[profile].targets.length, 0), blocks: 2,
    fixture_count: fixtures.length, scheduled_samples: schedule.length, small_fixture_set: ![30, 60].includes(fixtures.length),
    allow_small_fixture_set: allowSmallFixtureSet, fixture_source_sha256: hash(inputBytes), source_only_fixture_sha256: hash(fixtureBytes), schedule_sha256: hash(scheduleBytes),
    profile_caps: profileCaps, thread_cap_overrides: threadCapOverrides,
    profiles: Object.fromEntries(profiles.map(profile => [profile, { targets: PROFILES[profile].targets, max_successful_turns_per_thread: profileCaps[profile],
      excluded_functions_namespace_requested: ['excluded', 'parallel_excluded'].includes(profile), excluded_functions_namespace_independently_observed: null, clients: {} }])),
    sources: sourceBytes.map(({ name, bytes, original_path }) => ({ name, ...(original_path ? { original_path } : {}), sha256: hash(bytes) })), policy: { no_outer_retries: true, no_model_fallback: true,
      reset_threads_at_block_boundary: true, source_only_fields: ['id', 'ja', 'context'], glossary: [], parallel_awaits_all_settled: true },
    boundaries: ['Each parent ends only after all its distinct language branches settle and both requested languages validate successful terminal completion.',
      'Parent dispatch-to-bilingual timing excludes separately recorded process startup and thread setup/release; sample-with-setup timing includes setup and evidence writes.',
      'Each profile and language branch has independent actual response history. Source order and configured history positions are controlled; effective history caps are explicitly recorded and may differ by profile.',
      'Repeated blocks are repeated observations, not twice as many independent Japanese sources.',
      'Exclusion is a requested per-process override; this runner does not independently observe its effective value.',
      'No microphone, browser paint, recognition accuracy, native-human translation quality, quotas or account changes are measured here.'] };
  await mkdir(outputDirectory, { recursive: false }); await mkdir(cwd, { recursive: true });
  const snapshot = join(outputDirectory, 'source-snapshot'); await mkdir(snapshot);
  for (const { name, bytes } of sourceBytes) await writeFile(join(snapshot, name), bytes, { flag: 'wx' });
  await writeFile(join(outputDirectory, 'fixtures.source-only.json'), fixtureBytes, { flag: 'wx' });
  await writeFile(join(outputDirectory, 'schedule.json'), scheduleBytes, { flag: 'wx' });
  await writeFile(join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const results = schedule.map(step => ({ ...step, attempted: false, translation_invoked: false, outcome: 'not_run', success: false, error: null, branches: [] }));
  const clients = new Map(), byId = new Map(fixtures.map(fixture => [fixture.id, fixture]));
  let active = null, fatalCode = null, startupClient = null, translationCalls = 0;
  const emit = async value => { try { await appendFile(join(outputDirectory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); }
    catch { throw safeError('optimization_evidence_write_failed'); } };
  const saveProgress = async last => writeFile(join(outputDirectory, 'progress.json'), JSON.stringify({ finished_samples: results.filter(row => ['completed', 'failed'].includes(row.outcome)).length,
    scheduled_samples: schedule.length, completed_samples: results.filter(row => row.success).length, last_index: last?.index ?? null,
    last_profile: last?.profile ?? null, last_case_id: last?.case_id ?? null, success: last?.success ?? null, fatal_code: fatalCode }, null, 2) + '\n');
  try {
    const login = await loginCheck({ executable });
    if (login?.loggedIn !== true || login?.authMode !== 'chatgpt') throw safeError('codex_cli_auth_required');
    for (const profile of profiles) for (const target of PROFILES[profile].targets) {
      startupClient = { profile, target };
      if (signal?.aborted) throw safeError('optimization_cancelled');
      const started = now(), client = await createServer({ executable, cwd, instructionsFile: join(snapshot, instructionNames[target]),
        translationTarget: target, promptStyle: 'full', model: { slug: 'gpt-6.1-sol' }, serviceTier, timeoutMs,
        spawnImpl: createOptimizationSpawn(profile, spawnImpl) });
      const state = { client, target, profile, thread: null, block: null, successfulTurns: 0, threadSequence: 0, threadSequenceInBlock: 0 };
      clients.set(profile + ':' + target, state);
      const record = manifest.profiles[profile].clients[target] = { startup_ms: round(now() - started), reported_startup_ms: client.startupMs ?? null,
        instructions_sha256: hash(instructions[target].bytes), translation_target: target };
      const diagnostics = client.diagnostics();
      if (diagnostics?.alignment?.explicit_process_effort !== 'low' || diagnostics?.alignment?.model_catalog_default_effort !== 'low') throw safeError('optimization_catalog_effort_mismatch');
      await emit({ type: 'server_ready', profile, target, ...record, diagnostics }); startupClient = null;
    }
    for (const step of schedule) {
      if (signal?.aborted) { fatalCode = 'optimization_cancelled'; break; }
      active = results[step.index]; active.attempted = true; active.outcome = 'started';
      const fixture = byId.get(step.case_id), sampleStarted = now(), states = PROFILES[step.profile].targets.map(target => clients.get(step.profile + ':' + target));
      active.ja_sha256 = hash(fixture.ja); active.context_sha256 = hash(fixture.context);
      await emit({ type: 'sample_started', ...step, ja_sha256: active.ja_sha256, context_sha256: active.context_sha256 });
      for (const state of states) {
        const branch = { target: state.target, ...expectedByTarget[state.target].get(fixture.id), invoked: false, success: false,
          outcome: 'setup', error: null, thread_release_ms: 0, thread_setup_ms: 0, reported_thread_setup_ms: 0 };
        active.branches.push(branch);
        if (state.thread && (state.block !== step.block || state.successfulTurns >= profileCaps[step.profile])) {
          const released = now(); await state.client.releaseThread(state.thread);
          branch.thread_release_ms = round(now() - released); state.thread = null; state.successfulTurns = 0;
        }
        if (!state.thread) {
          if (state.block !== step.block) state.threadSequenceInBlock = 0;
          const started = now(), thread = await state.client.startThread();
          branch.thread_setup_ms = round(now() - started); branch.reported_thread_setup_ms = thread.setupMs ?? null;
          if (thread.telemetry?.observed?.model !== 'gpt-6.1-sol' || thread.telemetry?.observed?.reasoningEffort !== 'low'
            || !['fast', 'priority'].includes(thread.telemetry?.observed?.serviceTier)) throw safeError('optimization_thread_configuration_mismatch');
          state.thread = thread.threadId; state.threadSequence++; state.threadSequenceInBlock++; state.block = step.block;
          await emit({ type: 'thread_ready', index: step.index, profile: step.profile, target: state.target, block: step.block,
            thread_sequence: state.threadSequence, thread_sequence_in_block: state.threadSequenceInBlock, setup_ms: branch.thread_setup_ms, release_ms: branch.thread_release_ms });
        }
        branch.actual_prior_successful_turns_in_thread = state.successfulTurns; branch.thread_sequence = state.threadSequence;
        branch.thread_sequence_in_block = state.threadSequenceInBlock;
        if (state.successfulTurns !== step.expected_prior_successful_turns_in_thread
          || state.threadSequenceInBlock !== step.expected_thread_sequence_in_block) throw safeError('optimization_history_position_mismatch');
      }
      if (signal?.aborted) throw safeError('optimization_cancelled');
      active.translation_invoked = true;
      const parentDispatched = now();
      const settled = await Promise.allSettled(states.map(async (state, index) => {
        const branch = active.branches[index]; branch.invoked = true; branch.outcome = 'started'; translationCalls++;
        const dispatched = now(); branch.dispatch_offset_ms = round(dispatched - parentDispatched);
        try {
          const result = await state.client.translate({ threadId: state.thread, fixture, glossary: [] });
          const returned = now(); branch.returned_offset_ms = round(returned - parentDispatched); branch.dispatch_to_completed_ms = round(returned - dispatched);
          branch.result = projectResult(result); branch.success = validateCompletion(result, branch); branch.outcome = branch.success ? 'completed' : 'failed';
          branch.error = branch.success ? null : { code: codeOf({ safeCode: result?.error?.code }, 'invalid_optimization_translation_result') };
          branch.timings_ms = result?.timings_ms ?? null; branch.usage = result?.usage ?? null; branch.telemetry = result?.telemetry ?? null;
          if (branch.success) state.successfulTurns++;
        } catch (error) {
          branch.returned_offset_ms = round(now() - parentDispatched); branch.dispatch_to_completed_ms = round(now() - dispatched);
          branch.outcome = 'failed'; branch.error = { code: codeOf(error, 'optimization_branch_threw') }; branch.result = null;
        }
        return branch;
      }));
      for (const [index, value] of settled.entries()) if (value.status === 'rejected') {
        Object.assign(active.branches[index], { outcome: 'failed', success: false, error: { code: 'optimization_branch_unsettled_failure' } });
      }
      const successful = active.branches.every(branch => branch.success);
      const combined = successful ? Object.assign({}, ...active.branches.map(branch => branch.result.translation)) : null;
      active.success = successful && Object.keys(combined).sort().join(',') === 'en,zh'; active.outcome = active.success ? 'completed' : 'failed';
      active.translation = active.success ? combined : null; active.error = active.success ? null : { code: 'optimization_parent_incomplete' };
      active.terminal_event = active.success ? 'all_branches_turn_completed' : null; active.final_status = active.success ? 'completed' : 'failed';
      const returned = now();
      active.dispatch_to_bilingual_ms = round(returned - parentDispatched); active.sample_with_setup_to_bilingual_ms = round(returned - sampleStarted);
      active.strict_transport_completed_ms = active.success ? Math.max(...active.branches.map(branch => branch.dispatch_offset_ms + branch.timings_ms.completed)) : null;
      const finished = active; active = null; await emit({ type: 'sample_finished', result: finished }); await saveProgress(finished);
      try { onProgress({ index: step.index, completed: results.filter(row => row.success).length, scheduled: schedule.length,
        profile: step.profile, block: step.block, case_id: step.case_id, success: finished.success, dispatch_to_bilingual_ms: finished.dispatch_to_bilingual_ms }); } catch {}
      if (!finished.success) { fatalCode = 'optimization_sample_failed_no_retry'; break; }
    }
  } catch (error) {
    fatalCode = codeOf(error, 'optimization_setup_or_transport_failed');
    if (startupClient) manifest.startup_failure = { ...startupClient, code: fatalCode,
      failed_client_process_closed: typeof error?.diagnostics?.process?.closed === 'boolean' ? error.diagnostics.process.closed : null,
      failed_discovery_termination_confirmed: typeof error?.diagnostics?.discovery_close?.termination_confirmed === 'boolean'
        ? error.diagnostics.discovery_close.termination_confirmed : null };
    if (active) {
      Object.assign(active, { outcome: 'failed', success: false, translation: null, error: { code: fatalCode }, terminal_event: null, final_status: 'client_error' });
      await emit({ type: 'sample_finished', result: active }); active = null;
    }
    try { await emit({ type: 'benchmark_error', code: fatalCode }); } catch { fatalCode ??= 'optimization_evidence_write_failed'; }
  } finally {
    for (const state of clients.values()) {
      const closed = await boundedClose(state.client, closeDeadlineMs), record = manifest.profiles[state.profile].clients[state.target]; record.close = closed;
      try { record.final_diagnostics = state.client.diagnostics(); } catch { record.final_diagnostics = { unavailable_code: 'optimization_final_diagnostics_failed' }; fatalCode ??= 'optimization_final_diagnostics_failed'; }
      if (!closed.closed || !closed.termination_confirmed) fatalCode ??= 'optimization_close_unconfirmed';
      else if (closed.exit_code !== 0) fatalCode ??= 'optimization_close_nonzero';
      else if (closed.unusable_code) fatalCode ??= closed.unusable_code;
      try { await emit({ type: 'server_closed', profile: state.profile, target: state.target, result: closed }); } catch { fatalCode ??= 'optimization_evidence_write_failed'; }
    }
    manifest.finished_at = new Date().toISOString(); manifest.fatal_code = fatalCode;
    manifest.attempted_samples = results.filter(row => row.attempted).length; manifest.translation_calls = translationCalls;
    manifest.successful_samples = results.filter(row => row.success).length; manifest.failed_samples = results.filter(row => row.outcome === 'failed').length;
    manifest.not_run_samples = results.filter(row => row.outcome === 'not_run').length;
    await writeFile(join(outputDirectory, 'results.json'), JSON.stringify({ manifest, results }, null, 2) + '\n', { flag: 'wx' });
    await saveProgress(results.findLast(row => row.attempted));
    await emit({ type: 'benchmark_finished', attempted: manifest.attempted_samples, successful: manifest.successful_samples,
      failed: manifest.failed_samples, not_run: manifest.not_run_samples, scheduled: schedule.length, fatal_code: fatalCode });
  }
  return { outputDirectory, scheduled: schedule.length, attempted: manifest.attempted_samples, successful: manifest.successful_samples,
    failed: manifest.failed_samples, not_run: manifest.not_run_samples, translation_calls: translationCalls, fatal_code: fatalCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tokens = process.argv.slice(2), allowed = new Set(['--codex', '--fixtures', '--output', '--cwd', '--profiles', '--small', '--thread-caps']);
  if (tokens.length % 2 || tokens.some((value, index) => index % 2 === 0 && !allowed.has(value))
    || new Set(tokens.filter((_, index) => index % 2 === 0)).size !== tokens.length / 2) throw safeError('invalid_optimization_cli_arguments');
  const args = Object.fromEntries(tokens.reduce((pairs, value, index) => { if (index % 2 === 0) pairs.push([value, tokens[index + 1]]); return pairs; }, []));
  if (!['--codex', '--fixtures', '--output', '--cwd'].every(key => args[key]) || args['--small'] !== undefined && !['true', 'false'].includes(args['--small'])) throw safeError('missing_optimization_cli_arguments');
  const controller = new AbortController(), cancel = () => controller.abort(); process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const result = await runOptimizationBenchmark({ executable: resolve(args['--codex']), fixturePath: resolve(args['--fixtures']),
      outputDirectory: resolve(args['--output']), cwd: resolve(args['--cwd']), profiles: args['--profiles']?.split(',') ?? ['baseline', 'parallel'],
      threadCapOverrides: args['--thread-caps'] === undefined ? {} : parseOptimizationThreadCaps(args['--thread-caps']),
      allowSmallFixtureSet: args['--small'] === 'true', signal: controller.signal,
      onProgress: value => { if ((value.index + 1) % 6 === 0 || !value.success) process.stdout.write(JSON.stringify(value) + '\n'); } });
    process.stdout.write(JSON.stringify(result) + '\n'); if (result.fatal_code) process.exitCode = 1;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
