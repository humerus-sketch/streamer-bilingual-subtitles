import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runCodexTranslation, checkCodexLogin, codexTranslationPrompt, safeCliError } from './codex-translation.mjs';

const base = { executable: 'C:/test/codex.exe', cwd: 'C:/empty-work', model: { slug: 'test-model' },
  fixture: { id: 'case-1', ja: '三人ではなく、二人です。', context: 'The current speaker is the livestream host.' }, timeoutMs: 1000 };
const message = text => ({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text } });
const bilingual = JSON.stringify({ zh: '不是三个人，是两个人。', en: 'There are two people, not three.' });
function fakeSpawn(script, { onSpawn = () => {}, needsStdin = true } = {}) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killCalls = [];
    let prompt = '';
    child.stdin = new Writable({ write(chunk, encoding, done) { prompt += chunk.toString(); done(); } });
    child.emitEvent = event => child.stdout.write(JSON.stringify(event) + '\n');
    child.exit = (code = 0, signal = null) => { child.exitCode = code; child.emit('close', code, signal); };
    child.kill = signal => { child.killCalls.push(signal ?? 'SIGTERM'); setImmediate(() => child.exit(null, signal ?? 'SIGTERM')); return true; };
    calls.push({ executable, args, options, child, get prompt() { return prompt; } });
    onSpawn(child);
    if (needsStdin) child.stdin.on('finish', () => script(child));
    else setImmediate(() => script(child));
    return child;
  };
  return { spawnImpl, calls };
}
function succeed(child) {
  child.emitEvent({ type: 'thread.started', thread_id: 'not-a-request-id' });
  child.emitEvent({ type: 'turn.started' });
  child.emitEvent(message(bilingual));
  child.emitEvent({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 } });
  child.exit();
}

test('one official CLI process receives prompt on stdin, no shell or API-key overrides, strict bilingual success', async () => {
  const fake = fakeSpawn(succeed), observed = [];
  const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl, instructionsFile: 'C:/test/translation-base.md',
    env: { CODEX_HOME: 'preserved-codex-home', OPENAI_API_KEY: 'secret-key', CODEX_API_KEY: 'secret-key-2', OPENAI_BASE_URL: 'secret-url', PATH: 'keep' },
    observer: value => observed.push(value) });
  assert.equal(result.success, true); assert.deepEqual(result.translation, JSON.parse(bilingual));
  assert.equal(result.terminal_event, 'turn.completed'); assert.equal(result.final_status, 'completed');
  assert.equal(result.http_status, null); assert.equal(result.request_id, null); assert.equal(result.response_model, null);
  assert.equal(result.reasoning_policy, 'cli_default');
  assert.equal(result.timings_ms.headers, null); assert.equal(result.timings_ms.first_nonempty_delta, null);
  assert.equal(result.usage.total_tokens, 130); assert.equal(result.usage.input_tokens_details.cached_tokens, 20);
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 10);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.CODEX_HOME, 'preserved-codex-home'); assert.equal(call.options.env.PATH, 'keep');
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) assert.equal(key in call.options.env, false);
  assert.ok(call.args.includes('--ephemeral')); assert.ok(call.args.includes('--ignore-user-config')); assert.ok(call.args.includes('--strict-config'));
  assert.ok(call.args.includes('read-only')); assert.equal(call.args.at(-1), '-'); assert.ok(!call.args.includes('--ignore-rules'));
  assert.ok(call.args.some(arg => arg.startsWith('model_instructions_file=')));
  assert.ok(call.prompt.includes(base.fixture.ja)); assert.ok(!call.args.some(arg => arg.includes(base.fixture.ja)));
  assert.equal(observed.length, 1);
  assert.doesNotMatch(JSON.stringify(observed), /secret-key|secret-url|preserved-codex-home|三人|不是三个人|not-a-request-id/);
});

test('Fast changes only the requested service tier, preserving model, prompt, output gate and reasoning default', async () => {
  const normal = fakeSpawn(succeed), fast = fakeSpawn(succeed);
  const standardResult = await runCodexTranslation({ ...base, spawnImpl: normal.spawnImpl });
  const fastResult = await runCodexTranslation({ ...base, spawnImpl: fast.spawnImpl, serviceTier: 'fast' });
  assert.equal(normal.calls[0].prompt, fast.calls[0].prompt);
  const fastArgs = [...fast.calls[0].args];
  const tier = fastArgs.indexOf('service_tier="fast"');
  assert.ok(tier > 0); assert.equal(fastArgs[tier - 1], '-c');
  fastArgs.splice(tier - 1, 4);
  assert.deepEqual(fastArgs, normal.calls[0].args);
  assert.deepEqual(fastResult.translation, standardResult.translation);
  assert.equal(fastResult.reasoning_policy, 'cli_default');
  assert.equal(fastResult.telemetry.request.requested_service_tier, 'fast');
  assert.equal(fastResult.telemetry.request.observed_service_tier, null);
  assert.ok(!fast.calls[0].args.some(value => value.includes('model_reasoning_effort')));
  await assert.rejects(runCodexTranslation({ ...base, spawnImpl: fast.spawnImpl, serviceTier: 'unapproved' }), /Invalid CLI/);
  assert.equal(fast.calls.length, 1);
});

test('CLI milestones measure first event, final completed message, turn completion and process exit independently', async () => {
  let time = 0;
  const fake = fakeSpawn(child => {
    time = 5; child.emitEvent({ type: 'turn.started' });
    time = 11; child.emitEvent(message(bilingual));
    time = 15; child.emitEvent({ type: 'turn.completed' });
    time = 18; child.exit();
  });
  const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl, now: () => time });
  assert.equal(result.timings_ms.cli_first_event, 5); assert.equal(result.timings_ms.cli_final_text, 11);
  assert.equal(result.timings_ms.cli_turn_completed, 15); assert.equal(result.timings_ms.cli_process_exit, 18);
  assert.equal(result.timings_ms.completed, 18); assert.equal(result.timings_ms.bilingual_json_ready, 11);
});

test('partial UTF-8 and JSONL chunks preserve Japanese and bilingual text', async () => {
  const fake = fakeSpawn(child => {
    const bytes = Buffer.from(JSON.stringify(message(bilingual)) + '\n' + JSON.stringify({ type: 'turn.completed' }));
    for (let i = 0; i < bytes.length; i += 2) child.stdout.write(bytes.subarray(i, i + 2));
    child.exit();
  });
  const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl });
  assert.equal(result.success, true); assert.deepEqual(result.translation, JSON.parse(bilingual));
});

test('valid JSON alone, nonzero process exit or duplicate final messages never become a success', async () => {
  for (const mode of ['missing-turn', 'nonzero', 'duplicate-message', 'post-completion']) {
    const fake = fakeSpawn(child => {
      child.emitEvent(message(bilingual));
      if (mode === 'duplicate-message') child.emitEvent(message(bilingual));
      if (mode !== 'missing-turn') child.emitEvent({ type: 'turn.completed' });
      if (mode === 'post-completion') child.emitEvent(message(bilingual));
      child.exit(mode === 'nonzero' ? 1 : 0);
    });
    const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl });
    assert.equal(result.success, false, mode); assert.equal(result.translation, null, mode); assert.equal(fake.calls.length, 1);
  }
});

test('tool item rejects the entire request and terminates only its own child without leaking item text', async () => {
  const events = [];
  const fake = fakeSpawn(child => child.emitEvent({ type: 'item.started', item: { type: 'command_execution', command: 'private-token-command' } }));
  const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl, onEvent: event => events.push(event) });
  assert.equal(result.success, false); assert.equal(result.error.code, 'codex_cli_tool_item_rejected');
  assert.equal(fake.calls[0].child.killCalls.length, 1); assert.equal(result.telemetry.process.rejected_tool_items, 1);
  assert.deepEqual(result.telemetry.process.rejected_item_types, ['command_execution']);
  assert.doesNotMatch(JSON.stringify({ result, events }), /private-token-command/);
});

test('strict bilingual validation rejects blank, extra, missing, Markdown and non-object output', async () => {
  for (const text of ['{"zh":" ","en":"English"}', '{"zh":"中","en":"E","extra":1}', '{"zh":"中"}', '```json\n' + bilingual + '\n```', '[]']) {
    const fake = fakeSpawn(child => child.emitEvent(message(text)));
    const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl });
    assert.equal(result.success, false); assert.equal(result.error.code, 'invalid_bilingual_json');
  }
});

test('timeout and combined output limits terminate without retry or exposing stderr', async () => {
  const timeout = fakeSpawn(() => {});
  const timeoutResult = await runCodexTranslation({ ...base, spawnImpl: timeout.spawnImpl, timeoutMs: 5 });
  assert.equal(timeoutResult.final_status, 'timeout'); assert.equal(timeoutResult.error.code, 'codex_cli_timeout');
  assert.equal(timeout.calls.length, 1); assert.equal(timeout.calls[0].child.killCalls.length, 1);
  const overflow = fakeSpawn(child => child.stderr.write('private stderr '.repeat(100)));
  const overflowResult = await runCodexTranslation({ ...base, spawnImpl: overflow.spawnImpl, maxBytes: 20 });
  assert.equal(overflowResult.error.code, 'codex_cli_output_limit');
  assert.doesNotMatch(JSON.stringify(overflowResult), /private stderr/);
});

test('malformed JSONL, invalid UTF-8, unknown events and turn failures safely reject', async () => {
  const scripts = [child => child.stdout.write('not-json\n'), child => child.stdout.write(Buffer.from([0xff])),
    child => child.emitEvent({ type: 'unexpected', private: 'not-saved' }),
    child => child.emitEvent({ type: 'turn.failed', error: { message: 'not-saved' } })];
  for (const script of scripts) {
    const fake = fakeSpawn(script);
    const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl });
    assert.equal(result.success, false); assert.equal(result.translation, null);
    assert.doesNotMatch(JSON.stringify(result), /not-saved|not-json/);
  }
});

test('prompt keeps source/context/glossary but excludes private references and shell interpolation', () => {
  const prompt = codexTranslationPrompt({ fixture: { ...base.fixture, ja: '$(do-not-execute); & `literal`', reference: 'hidden-reference' }, glossary: [{ ja: '配信', en: 'stream', zh: '直播' }] });
  assert.match(prompt, /Preserve meaning, negation, modality, numbers, names and context/);
  assert.match(prompt, /\$\(do-not-execute\); & `literal`/); assert.match(prompt, /直播/);
  assert.doesNotMatch(prompt, /hidden-reference/);
});

test('login check accepts only exit-zero ChatGPT status from either output stream and returns no raw text', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const fake = fakeSpawn(child => { child[stream].write('Logged in using ChatGPT\nprivate-account\n'); child.exit(); }, { needsStdin: false });
    const result = await checkCodexLogin({ executable: base.executable, spawnImpl: fake.spawnImpl,
      env: { CODEX_HOME: 'preserve', OPENAI_API_KEY: 'secret' } });
    assert.deepEqual(result, { loggedIn: true, authMode: 'chatgpt' });
    assert.deepEqual(fake.calls[0].args, ['login', 'status']); assert.equal(fake.calls[0].options.shell, false);
    assert.equal(fake.calls[0].options.env.CODEX_HOME, 'preserve'); assert.equal('OPENAI_API_KEY' in fake.calls[0].options.env, false);
    assert.doesNotMatch(JSON.stringify(result), /private-account/);
  }
});

test('API-key, missing login, nonzero status, output overflow and timeout all refuse the Pro route', async () => {
  const cases = [child => { child.stderr.write('Logged in using an API key'); child.exit(); }, child => { child.stderr.write('Not logged in'); child.exit(1); },
    child => { child.stderr.write('Logged in using ChatGPT'); child.exit(1); }, child => child.stdout.write('x'.repeat(200)), () => {}];
  for (const script of cases) {
    const fake = fakeSpawn(script, { needsStdin: false });
    const result = await checkCodexLogin({ executable: base.executable, spawnImpl: fake.spawnImpl, maxBytes: 100, timeoutMs: 10 });
    assert.deepEqual(result, { loggedIn: false, authMode: null }); assert.equal(fake.calls.length, 1);
  }
});

test('invalid options fail before spawning and spawn errors are safely reported', async () => {
  let calls = 0;
  await assert.rejects(() => runCodexTranslation({ ...base, model: { slug: '--bad-model' }, spawnImpl: () => { calls++; } }), /Invalid/);
  assert.equal(calls, 0);
  const result = await runCodexTranslation({ ...base, spawnImpl: () => { throw new Error('private spawn details'); } });
  assert.equal(result.error.code, 'codex_cli_spawn_failed'); assert.doesNotMatch(JSON.stringify(result), /private spawn details/);
});

test('nonzero config errors expose only the bounded configuration key identifier', async () => {
  const fake = fakeSpawn(child => { child.stderr.write('private-prefix\nUnknown configuration key: "tools.view_image"\nprivate-token'); child.exit(1); });
  const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl });
  assert.equal(result.error.code, 'codex_cli_unknown_config_key'); assert.equal(result.error.config_key, 'tools.view_image');
  assert.equal(result.telemetry.process.config_error_key, 'tools.view_image');
  assert.doesNotMatch(JSON.stringify(result), /private-prefix|private-token/);
});

test('safe CLI errors distinguish unavailable models and login without returning original messages', () => {
  for (const text of ["The 'test-model' model is not supported when using Codex with a ChatGPT account.", 'Model not found.', 'Unsupported model: test-model', 'The model is unavailable.']) {
    assert.equal(safeCliError(text).code, 'codex_cli_model_unavailable');
  }
  for (const text of ['Please login again.', 'Authentication failed.', 'Unauthorized', 'You are not logged in.']) assert.equal(safeCliError(text).code, 'codex_cli_auth_required');
  assert.deepEqual(safeCliError({ message: 'private error detail' }), { code: 'codex_cli_item_error', message: 'codex_cli_item_error', param: null });
});

test('item.type error is an explicit safe failure, never classified as a tool invocation', async () => {
  const fake = fakeSpawn(child => child.emitEvent({ type: 'item.completed', item: { type: 'error', message: 'Model test-model is not supported. private-token' } }));
  const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl });
  assert.equal(result.error.code, 'codex_cli_model_unavailable'); assert.equal(result.terminal_event, 'item.error');
  assert.equal(result.telemetry.process.rejected_tool_items, 0); assert.deepEqual(result.telemetry.process.rejected_item_types, []);
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

test('validated turn callback publishes an isolated snapshot before process close while final Promise and observer wait', async () => {
  let time = 0, resolved = false;
  const snapshots = [], observed = [];
  const fake = fakeSpawn(child => {
    time = 3; child.emitEvent(message(bilingual));
    time = 7; child.emitEvent({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
  });
  const pending = runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl, now: () => time, observer: value => observed.push(value),
    onTurnCompleted: snapshot => { snapshots.push(structuredClone(snapshot)); snapshot.translation.zh = 'consumer mutation'; snapshot.telemetry.usage.input_tokens = 999; } });
  pending.then(() => { resolved = true; });
  await new Promise(done => setImmediate(done));
  assert.equal(snapshots.length, 1); assert.equal(resolved, false); assert.equal(observed.length, 0);
  const snapshot = snapshots[0]; assert.equal(snapshot.success, true); assert.equal(snapshot.process_cleanup_pending, true);
  assert.equal(snapshot.timings_ms.completed, 7); assert.equal(snapshot.timings_ms.cli_process_exit, null);
  assert.equal(snapshot.telemetry.process.cleanup_pending, true); assert.equal(snapshot.telemetry.process.exit_code, null);
  time = 9; fake.calls[0].child.exit();
  const result = await pending;
  assert.equal(result.success, true); assert.deepEqual(result.translation, JSON.parse(bilingual)); assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.timings_ms.completed, 9); assert.equal(result.timings_ms.cli_turn_completed, 7); assert.equal(result.timings_ms.cli_process_exit, 9);
  assert.equal(result.process_cleanup_pending, false); assert.equal(observed.length, 1); assert.equal(observed[0].process.exit_code, 0);
});

test('failed or invalid turn never invokes the semantic completion callback', async () => {
  const scripts = [child => { child.emitEvent(message('{"zh":" ","en":"E"}')); child.emitEvent({ type: 'turn.completed' }); },
    child => { child.emitEvent(message(bilingual)); child.emitEvent({ type: 'turn.failed' }); },
    child => { child.emitEvent(message(bilingual)); child.emitEvent({ type: 'item.started', item: { type: 'command_execution' } }); child.emitEvent({ type: 'turn.completed' }); },
    child => { child.emitEvent(message(bilingual)); child.stdout.write('bad-protocol\n'); child.emitEvent({ type: 'turn.completed' }); }];
  for (const script of scripts) {
    let callbacks = 0;
    const fake = fakeSpawn(script);
    const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl, onTurnCompleted: () => { callbacks++; } });
    assert.equal(callbacks, 0); assert.equal(result.success, false);
  }
});

test('nonzero exit after a semantic callback remains a failed final result instead of concealing cleanup failure', async () => {
  const snapshots = [];
  const fake = fakeSpawn(child => { child.emitEvent(message(bilingual)); child.emitEvent({ type: 'turn.completed' }); child.exit(1); });
  const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl, onTurnCompleted: value => snapshots.push(value) });
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0].success, true);
  assert.equal(result.success, false); assert.equal(result.error.code, 'codex_cli_nonzero_exit'); assert.equal(result.translation, null);
  assert.equal(result.telemetry.process.exit_code, 1); assert.equal(result.process_cleanup_pending, false);
});

test('semantic completion does not disable the original process deadline or output limits', async () => {
  for (const mode of ['timeout', 'overflow']) {
    let callbacks = 0;
    const fake = fakeSpawn(child => { child.emitEvent(message(bilingual)); child.emitEvent({ type: 'turn.completed' }); if (mode === 'overflow') child.stderr.write('x'.repeat(1000)); });
    const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl, timeoutMs: 10, maxBytes: 500,
      onTurnCompleted: () => { callbacks++; } });
    assert.equal(callbacks, 1); assert.equal(result.success, false);
    assert.equal(result.error.code, mode === 'timeout' ? 'codex_cli_timeout' : 'codex_cli_output_limit');
    assert.equal(fake.calls[0].child.killCalls.length, 1);
  }
});

test('a terminal JSONL fragment parsed only at close uses final completion without claiming pending cleanup', async () => {
  let callbacks = 0;
  const fake = fakeSpawn(child => { child.emitEvent(message(bilingual)); child.stdout.write(JSON.stringify({ type: 'turn.completed' })); child.exit(); });
  const result = await runCodexTranslation({ ...base, spawnImpl: fake.spawnImpl, onTurnCompleted: () => { callbacks++; } });
  assert.equal(callbacks, 0); assert.equal(result.success, true); assert.equal(result.process_cleanup_pending, false);
});
