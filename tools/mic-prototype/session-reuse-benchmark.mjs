import { mkdir, readFile, writeFile, appendFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runCodexTranslation, checkCodexLogin, codexTranslationPrompt } from './codex-translation.mjs';
import { createCodexAppServer } from './codex-app-server.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1000) / 1000;
const ownDirectory = fileURLToPath(new URL('.', import.meta.url));
const arms = new Set(['fresh_exec', 'resident_fresh_thread', 'resident_same_thread']);

/** Sequential paired probe: excludes microphone/ASR/page and never changes the running prototype. */
export async function runSessionReuseBenchmark({ executable, fixturePath, schedulePath, outputDirectory, cwd, serviceTier = 'fast',
  timeoutMs = 30_000, allowUnpairedSmoke = false, execTranslate = runCodexTranslation, createServer = createCodexAppServer,
  loginCheck = checkCodexLogin, now = () => performance.now(), onProgress = () => {}, signal }) {
  const fixtureBytes = await readFile(fixturePath), scheduleBytes = await readFile(schedulePath);
  const fixtureDocument = JSON.parse(fixtureBytes), scheduleDocument = JSON.parse(scheduleBytes);
  const fixtures = Array.isArray(fixtureDocument) ? fixtureDocument : fixtureDocument.fixtures;
  const schedule = Array.isArray(scheduleDocument) ? scheduleDocument : scheduleDocument.schedule;
  if (!Array.isArray(fixtures) || !Array.isArray(schedule) || !schedule.length) throw new Error('invalid_benchmark_documents');
  const byId = new Map(fixtures.map(fixture => [fixture.id, fixture]));
  if (byId.size !== fixtures.length || schedule.some(row => !byId.has(row.case_id) || !arms.has(row.arm) || !Number.isInteger(row.block))) {
    throw new Error('invalid_benchmark_schedule');
  }
  if (!allowUnpairedSmoke) {
    const blocks = new Map(), closedBlocks = new Set(); let precedingBlock = null;
    for (const row of schedule) {
      if (row.block !== precedingBlock) {
        if (closedBlocks.has(row.block)) throw new Error('noncontiguous_benchmark_block');
        if (precedingBlock !== null) closedBlocks.add(precedingBlock);
        precedingBlock = row.block;
      }
      if (!blocks.has(row.block)) blocks.set(row.block, new Set());
      const key = `${row.case_id}\0${row.arm}`;
      if (blocks.get(row.block).has(key)) throw new Error('repeated_case_arm_in_block');
      blocks.get(row.block).add(key);
    }
    if ([...blocks.values()].some(rows => rows.size !== fixtures.length * arms.size)) throw new Error('unpaired_benchmark_block');
  }
  // Source-only projection prevents reference translations and evaluation labels entering model inputs.
  const sourceFixture = fixture => ({ id: fixture.id, ja: fixture.ja, context: fixture.context ?? '' });
  for (const fixture of fixtures) if (typeof fixture.ja !== 'string' || !fixture.ja.trim() || typeof (fixture.context ?? '') !== 'string') {
    throw new Error('invalid_benchmark_fixture');
  }
  for (const fixture of fixtures) if (fixture.request_fingerprint?.prompt_sha256
    && hash(codexTranslationPrompt({ fixture: sourceFixture(fixture), glossary: [] })) !== fixture.request_fingerprint.prompt_sha256) {
    throw new Error('fixture_prompt_fingerprint_mismatch');
  }
  const expectedHistory = new Map();
  for (const step of schedule) {
    const currentPrompt = hash(codexTranslationPrompt({ fixture: sourceFixture(byId.get(step.case_id)), glossary: [] }));
    if (step.expected_current_prompt_sha256 && step.expected_current_prompt_sha256 !== currentPrompt) throw new Error('schedule_prompt_fingerprint_mismatch');
    const prior = step.arm === 'resident_same_thread' ? expectedHistory.get(step.block) ?? 0 : 0;
    if (step.expected_prior_translation_turns_in_thread !== undefined && step.expected_prior_translation_turns_in_thread !== prior) throw new Error('schedule_thread_history_mismatch');
    if (step.arm === 'resident_same_thread') expectedHistory.set(step.block, prior + 1);
  }
  await mkdir(outputDirectory, { recursive: false });
  await mkdir(cwd, { recursive: true });
  const instructionsFile = join(ownDirectory, 'translation-base.md');
  const model = { slug: 'gpt-6.1-sol' };
  const manifest = {
    started_at: new Date().toISOString(), model: model.slug, service_tier_requested: serviceTier, observed_service_tier: null,
    reasoning_policy: 'per_arm_model_default_alignment',
    arm_reasoning_policies: { fresh_exec: 'cli_default', resident_fresh_thread: 'explicit_catalog_default_alignment', resident_same_thread: 'explicit_catalog_default_alignment' },
    fixture_count: fixtures.length, scheduled_turns: schedule.length,
    fixture_sha256: hash(fixtureBytes), schedule_sha256: hash(scheduleBytes), instructions_sha256: hash(await readFile(instructionsFile)),
    sequential_global_concurrency: 1, ephemeral_threads: true, no_outer_retries: true, unpaired_smoke: allowUnpairedSmoke,
    boundaries: ['Text-to-complete-bilingual translation only; not audio-to-screen latency.',
      'Repeated blocks are paired repeated observations, not independent source utterances.',
      'A persistent process and a persistent conversation are separate conditions.',
      'App-server configuration isolation may differ from exec; inspect adapter telemetry.',
      'Current-turn prompt is identical across arms. A reused conversation also includes actual earlier turns.'],
  };
  const snapshot = join(outputDirectory, 'source-snapshot'); await mkdir(snapshot);
  for (const name of ['session-reuse-benchmark.mjs', 'codex-app-server.mjs', 'codex-translation.mjs', 'translation-base.md', 'bilingual.schema.json']) {
    const source = join(ownDirectory, name); await copyFile(source, join(snapshot, name));
    (manifest.sources ??= []).push({ name, sha256: hash(await readFile(source)) });
  }
  await writeFile(join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const eventsPath = join(outputDirectory, 'events.jsonl'), results = [];
  const emit = value => appendFile(eventsPath, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  let client, fatalCode = null, closeResult = null, currentBlock = null, continuedThread = null, activeSample = null, continuedTurns = 0;
  try {
    const login = await loginCheck({ executable });
    if (!login?.loggedIn) throw new Error('codex_cli_auth_required');
    const setupStarted = now();
    client = await createServer({ executable, cwd, instructionsFile, serviceTier, model, timeoutMs });
    manifest.app_server_startup_ms = round(now() - setupStarted);
    manifest.app_server_reported_startup_ms = client.startupMs ?? null;
    await emit({ type: 'server_ready', startup_ms: manifest.app_server_startup_ms, diagnostics: client.diagnostics() });
    for (let index = 0; index < schedule.length; index++) {
      if (signal?.aborted) { fatalCode = 'benchmark_cancelled'; break; }
      const step = schedule[index], fixture = sourceFixture(byId.get(step.case_id));
      if (step.block !== currentBlock) {
        if (continuedThread && typeof client.releaseThread === 'function') await client.releaseThread(continuedThread);
        currentBlock = step.block; continuedThread = null; continuedTurns = 0;
      }
      const prompt = codexTranslationPrompt({ fixture, glossary: [] });
      const source = { prompt_sha256: hash(prompt), prompt_bytes: Buffer.byteLength(prompt), ja_sha256: hash(fixture.ja), context_sha256: hash(fixture.context) };
      let threadSetupMs = 0, firstThreadInBlock = false, semantic = null, completed, semanticObservedAt = null;
      activeSample = { index, ...step, ...source, actual_prior_translation_turns_in_thread: step.arm === 'resident_same_thread' ? continuedTurns : 0 };
      await emit({ type: 'sample_started', ...activeSample });
      const started = now(); let selectedThread = null;
      if (step.arm === 'fresh_exec') {
        completed = await execTranslate({ executable, cwd, instructionsFile, serviceTier, model, fixture, glossary: [], timeoutMs,
          onTurnCompleted: result => { semantic = result; semanticObservedAt = now(); } });
      } else {
        if (step.arm === 'resident_same_thread' && continuedThread) selectedThread = continuedThread;
        else {
          const setup = await client.startThread(); selectedThread = setup.threadId; threadSetupMs = setup.setupMs;
          if (step.arm === 'resident_same_thread') { continuedThread = selectedThread; firstThreadInBlock = true; }
        }
        completed = await client.translate({ threadId: selectedThread, fixture, glossary: [] });
        if (completed.success) { semantic = completed; semanticObservedAt = now(); }
      }
      const finished = now();
      const successful = Boolean(completed.success && semantic?.success && semantic.translation?.zh && semantic.translation?.en);
      const result = { ...activeSample, success: successful, first_thread_turn_in_block: firstThreadInBlock,
        translation: completed.translation ?? semantic?.translation ?? null, error: completed.error ?? null,
        terminal_event: completed.terminal_event ?? null, final_status: completed.final_status ?? null,
        // Current exec's returned completed time includes close: use the validated semantic callback for the comparable endpoint.
        translation_semantic_ms: successful ? semantic.timings_ms.completed : null,
        thread_setup_ms: threadSetupMs,
        segment_to_bilingual_ms: successful ? round(semanticObservedAt - started) : null,
        thread_setup_plus_turn_ms: successful ? round(threadSetupMs + semantic.timings_ms.completed) : null,
        wall_until_adapter_return_ms: round(finished - started),
        usage: completed.usage ?? semantic?.usage ?? null, timings_ms: completed.timings_ms,
        semantic_timings_ms: semantic?.timings_ms ?? null, telemetry: completed.telemetry,
      };
      results.push(result); activeSample = null;
      if (successful && step.arm === 'resident_same_thread') continuedTurns++;
      await emit({ type: 'sample_finished', result });
      await writeFile(join(outputDirectory, 'progress.json'), JSON.stringify({ completed: results.length, scheduled: schedule.length,
        failures: results.filter(row => !row.success).length, last_arm: step.arm, last_block: step.block, last_case_id: step.case_id }, null, 2) + '\n');
      try { onProgress({ completed: results.length, scheduled: schedule.length, success: successful, arm: step.arm,
        block: step.block, case_id: step.case_id, semantic_ms: result.translation_semantic_ms }); } catch { /* Observer cannot alter the sample. */ }
      if (step.arm === 'resident_fresh_thread' && selectedThread && typeof client.releaseThread === 'function') await client.releaseThread(selectedThread);
      if (!successful) { fatalCode = 'sample_failed_no_automatic_retry'; break; }
    }
  } catch (error) {
    // Only our fixed identifiers are durable; arbitrary provider/OS messages can contain personal data.
    fatalCode = typeof error?.safeCode === 'string' && /^[a-z0-9_]{1,100}$/.test(error.safeCode) ? error.safeCode
      : ['codex_cli_auth_required'].includes(error?.message) ? error.message : 'benchmark_setup_or_transport_failed';
    if (error?.diagnostics?.transport === 'codex_app_server') manifest.startup_failure_diagnostics = structuredClone(error.diagnostics);
    if (activeSample) {
      const result = { ...activeSample, success: false, translation: null, error: { code: fatalCode }, terminal_event: null,
        final_status: 'client_error', translation_semantic_ms: null, segment_to_bilingual_ms: null,
        usage: null, timings_ms: null, telemetry: null };
      results.push(result); activeSample = null; await emit({ type: 'sample_finished', result });
    }
    await emit({ type: 'benchmark_error', code: fatalCode });
  } finally {
    if (client) {
      try { closeResult = await client.close(); }
      catch { closeResult = { closed: false, error: 'app_server_close_failed' }; fatalCode ??= 'app_server_close_failed'; }
      if (closeResult?.closed !== true || closeResult?.termination_confirmed === false) fatalCode ??= 'app_server_close_unconfirmed';
      manifest.final_server_diagnostics = client.diagnostics();
    }
    manifest.finished_at = new Date().toISOString(); manifest.fatal_code = fatalCode;
    manifest.completed_samples = results.length; manifest.successful_samples = results.filter(row => row.success).length;
    manifest.attempted_samples = results.length; manifest.failed_samples = results.filter(row => !row.success).length;
    manifest.not_run_samples = schedule.length - results.length;
    manifest.server_close = closeResult;
    await writeFile(join(outputDirectory, 'results.json'), JSON.stringify({ manifest, results }, null, 2) + '\n', { flag: 'wx' });
    await emit({ type: 'benchmark_finished', completed: results.length, scheduled: schedule.length, fatal_code: fatalCode, server_close: closeResult });
  }
  return { outputDirectory, completed: results.length, scheduled: schedule.length, successful: results.filter(row => row.success).length, fatal_code: fatalCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, array) => {
    if (index % 2 === 0) pairs.push([value, array[index + 1]]); return pairs;
  }, []));
  if (!['--codex', '--fixtures', '--schedule', '--output', '--cwd'].every(key => args[key])) throw new Error('missing_benchmark_arguments');
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const result = await runSessionReuseBenchmark({ executable: resolve(args['--codex']), fixturePath: resolve(args['--fixtures']),
      schedulePath: resolve(args['--schedule']), outputDirectory: resolve(args['--output']), cwd: resolve(args['--cwd']), serviceTier: args['--tier'] ?? 'fast',
      allowUnpairedSmoke: args['--smoke'] === 'true', signal: controller.signal,
      onProgress: value => { if (value.completed % 6 === 0 || !value.success) process.stdout.write(JSON.stringify(value) + '\n'); } });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.fatal_code) process.exitCode = 1;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
