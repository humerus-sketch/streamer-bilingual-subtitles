import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Script } from 'node:vm';
import { request as httpRequest } from 'node:http';
import { createGateway, TranslationScheduler, WorkerClock, latencyFor } from './gateway.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await wait(5); } assert.fail('condition timed out'); }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const result = value => ({ success: true, translation: { zh: '中文 ' + value, en: 'English ' + value }, timings_ms: { completed: 10 }, request_id: 'test-request' });
function metadataRequest(url, options = {}) {
  return new Promise((done, reject) => {
    const request = httpRequest(url, options, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => done({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject); request.end();
  });
}

test('scheduler bounds active/pending, preserves order, explicitly marks overflow and never retries', async () => {
  const calls = [], ordered = [], jobs = new Map();
  const scheduler = new TranslationScheduler({ concurrency: 2, translate: entry => { calls.push(entry.segmentId); const job = deferred(); jobs.set(entry.segmentId, job); return job.promise; }, onOrdered: entry => ordered.push([entry.segmentId, entry.status]) });
  for (let i = 1; i <= 5; i++) scheduler.enqueue({ segmentId: i, revision: 1, ja: 'テスト' });
  assert.deepEqual(scheduler.stats(), { active: 2, pending: 2, total: 5, ordered: 0 });
  assert.equal(scheduler.entries[4].errorCode, 'translation_queue_overflow');
  assert.equal(scheduler.enqueue({ segmentId: 1, revision: 1, ja: 'duplicate' }), false);
  await until(() => jobs.size === 2);
  jobs.get(2).resolve(result(2)); await until(() => jobs.has(3));
  assert.deepEqual(ordered, []);
  jobs.get(3).reject(Object.assign(new Error('test'), { safeCode: 'test_failure' })); await until(() => jobs.has(4));
  jobs.get(4).resolve(result(4)); await wait(5); assert.deepEqual(ordered, []);
  const completed = { ...result(1), credentialWaitMs: 0.5, telemetry: {
    usage: { input_tokens: 80, output_tokens: 25, output_tokens_details: { reasoning_tokens: 0 } },
    request: { body_sha256: 'test-body-hash', reasoning_policy: 'server_default' },
    event_first_ms: { 'response.created': 1 }, event_last_ms: { 'response.completed': 10 },
    event_counts: { 'response.completed': 1 }, processing_headers_ms: {},
    terminal_event: 'response.completed', final_status: 'completed', events: [{ type: 'response.completed' }],
  } };
  jobs.get(1).resolve(completed); await until(() => scheduler.active === 0);
  assert.deepEqual(ordered, [[1, 'completed'], [2, 'completed'], [3, 'failed'], [4, 'completed'], [5, 'gap']]);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.deepEqual(scheduler.entries[0].translation, completed.translation);
  assert.deepEqual(scheduler.entries[0].translationUsage, completed.telemetry.usage);
  assert.equal(scheduler.entries[0].translationDiagnostics.terminal_event, 'response.completed');
  assert.equal(scheduler.entries[0].translationDiagnostics.credentialWaitMs, 0.5);
  assert.equal(scheduler.entries[0].translationDiagnostics.events, undefined);
});

test('semantic completion publishes once in order while slots stay occupied until cleanup, including late result and throw', async () => {
  const jobs = new Map(), ordered = [], cleanupErrors = [], queueStates = [];
  const semantic = id => ({ ...result(id), terminal_event: 'turn.completed', process_cleanup_pending: true,
    timings_ms: { completed: 7, cli_turn_completed: 7, cli_process_exit: null }, telemetry: { transport: 'codex_cli', process: { cleanup_pending: true, rejected_tool_items: 0 } } });
  const scheduler = new TranslationScheduler({ concurrency: 2,
    translate: (entry, onCompleted) => { const job = deferred(); jobs.set(entry.segmentId, { ...job, onCompleted }); return job.promise; },
    onOrdered: entry => ordered.push(entry.segmentId), onCleanupError: (entry, code) => cleanupErrors.push([entry.segmentId, code]),
    onQueueChange: stats => queueStates.push(stats.active) });
  for (const id of [1, 2, 3]) scheduler.enqueue({ segmentId: id, revision: 1, ja: '日本語' });
  await until(() => jobs.size === 2);
  assert.equal(jobs.get(2).onCompleted(semantic(2)), true); assert.deepEqual(ordered, []);
  assert.equal(jobs.get(1).onCompleted(semantic(1)), true); assert.deepEqual(ordered, [1, 2]);
  const originalEnd = scheduler.entries.map(entry => entry.translationEndNodeMs);
  assert.equal(scheduler.active, 2); assert.equal(jobs.has(3), false);
  assert.equal(jobs.get(1).onCompleted(semantic('different text')), false); assert.deepEqual(ordered, [1, 2]);
  jobs.get(1).resolve({ ...result('late changed text'), process_cleanup_pending: false, timings_ms: { cli_process_exit: 9 } });
  await until(() => jobs.has(3));
  assert.equal(scheduler.entries[0].translation.zh, '中文 1'); assert.equal(scheduler.entries[0].translationEndNodeMs, originalEnd[0]);
  assert.equal(scheduler.entries[0].processCleanupPending, false); assert.equal(scheduler.entries[0].cleanup.timingsMs.cli_process_exit, 9);
  assert.equal(scheduler.active, 2); assert.deepEqual(ordered, [1, 2]);
  assert.equal(jobs.get(3).onCompleted(semantic(3)), true); assert.deepEqual(ordered, [1, 2, 3]);
  jobs.get(2).reject(Object.assign(new Error('private cleanup details'), { safeCode: 'late_exit_error' }));
  jobs.get(3).resolve({ success: false, process_cleanup_pending: false, error: { code: 'late_nonzero_exit' } });
  await until(() => scheduler.active === 0);
  assert.equal(scheduler.entries[1].status, 'completed'); assert.equal(scheduler.entries[1].translationEndNodeMs, originalEnd[1]);
  assert.deepEqual(cleanupErrors, [[2, 'late_exit_error'], [3, 'late_nonzero_exit']]);
  assert.deepEqual(ordered, [1, 2, 3]); assert.equal(queueStates.at(-1), 0);
});

test('invalid semantic callbacks never publish before the final failure result', async () => {
  let complete;
  const job = deferred(), ordered = [];
  const scheduler = new TranslationScheduler({ translate: (entry, onCompleted) => { complete = onCompleted; return job.promise; }, onOrdered: entry => ordered.push(entry.status) });
  scheduler.enqueue({ segmentId: 1, revision: 1, ja: '日本語' }); await until(() => complete);
  const snapshot = { ...result(1), terminal_event: 'turn.completed', process_cleanup_pending: true };
  assert.equal(complete({ ...snapshot, translation: { zh: ' ', en: 'E' } }), false);
  assert.equal(complete({ ...snapshot, error: { code: 'prior_failure' } }), false);
  assert.equal(complete({ ...snapshot, telemetry: { process: { rejected_tool_items: 1 } } }), false);
  assert.deepEqual(ordered, []); assert.equal(scheduler.entries[0].status, 'translating');
  job.resolve({ success: false, error: { code: 'invalid_bilingual_json' } }); await until(() => scheduler.active === 0);
  assert.deepEqual(ordered, ['failed']);
});

test('bounded cleanup separation keeps inference at two and total owned processes at four without reordering or retry', async () => {
  const jobs = new Map(), calls = [], states = [], ordered = [], cleanupErrors = [];
  const semantic = id => ({ ...result(id), terminal_event: 'turn.completed', process_cleanup_pending: true,
    telemetry: { process: { rejected_tool_items: 0 } } });
  const scheduler = new TranslationScheduler({ concurrency: 2, cleanupAllowance: 2,
    translate: (entry, onCompleted) => { calls.push([entry.segmentId, entry.ja]); const job = deferred(); jobs.set(entry.segmentId, { ...job, onCompleted }); return job.promise; },
    onOrdered: entry => ordered.push(entry.segmentId), onQueueChange: state => states.push(state),
    onCleanupError: (entry, code) => cleanupErrors.push([entry.segmentId, code]) });
  for (const id of [1, 2, 3, 4]) scheduler.enqueue({ segmentId: id, revision: 1, ja: 'same-source-' + id });
  await until(() => jobs.size === 2);
  jobs.get(1).onCompleted(semantic(1)); await until(() => jobs.has(3));
  jobs.get(2).onCompleted(semantic(2)); await until(() => jobs.has(4));
  assert.deepEqual(scheduler.stats(), { active: 2, pending: 0, total: 4, ordered: 2, cleanup: 2, processesActive: 4, processLimit: 4 });
  for (const id of [5, 6]) assert.equal(scheduler.enqueue({ segmentId: id, revision: 1, ja: 'same-source-' + id }), true);
  jobs.get(3).onCompleted(semantic(3)); jobs.get(4).onCompleted(semantic(4));
  assert.equal(scheduler.stats().active, 0); assert.equal(scheduler.stats().cleanup, 4); assert.equal(scheduler.stats().pending, 2);
  assert.equal(jobs.size, 4); assert.equal(scheduler.enqueue({ segmentId: 7, revision: 1, ja: 'same-source-7' }), false);
  assert.equal(scheduler.entries[6].errorCode, 'translation_queue_overflow');
  const row2End = scheduler.entries[1].translationEndNodeMs;
  assert.equal(jobs.get(1).onCompleted(semantic('duplicate')), false); assert.equal(scheduler.stats().cleanup, 4);
  jobs.get(1).resolve({ ...result(1), process_cleanup_pending: false }); await until(() => jobs.has(5));
  assert.equal(scheduler.stats().processesActive, 4); assert.equal(scheduler.stats().active, 1);
  jobs.get(5).onCompleted(semantic(5)); assert.equal(scheduler.stats().cleanup, 4); assert.equal(jobs.has(6), false);
  jobs.get(2).reject(Object.assign(new Error('safe test error'), { safeCode: 'late_cleanup_failed' })); await until(() => jobs.has(6));
  assert.equal(scheduler.entries[1].status, 'completed'); assert.equal(scheduler.entries[1].translationEndNodeMs, row2End);
  assert.equal(jobs.get(6).onCompleted({ ...semantic(6), translation: { zh: '', en: 'E' } }), false);
  jobs.get(6).resolve({ success: false, error: { code: 'failed_before_semantic' } });
  for (const id of [3, 4, 5]) jobs.get(id).resolve({ ...result(id), process_cleanup_pending: false });
  await until(() => scheduler.processesActive === 0);
  assert.equal(scheduler.active, 0); assert.equal(scheduler.cleanup, 0); assert.equal(scheduler.pending.length, 0);
  assert.deepEqual(ordered, [1, 2, 3, 4, 5, 6, 7]); assert.deepEqual(cleanupErrors, [[2, 'late_cleanup_failed']]);
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6].map(id => [id, 'same-source-' + id]));
  for (const state of states) {
    assert.ok(state.active >= 0 && state.active <= 2); assert.ok(state.cleanup >= 0); assert.ok(state.processesActive >= 0 && state.processesActive <= 4);
    assert.equal(state.active + state.cleanup, state.processesActive); assert.ok(state.pending <= 2);
  }
  assert.equal(Math.max(...states.map(state => state.processesActive)), 4);
  assert.throws(() => new TranslationScheduler({ concurrency: 2, cleanupAllowance: 3, translate() {} }), /invalid_translation_limits/);
});

test('SSE delivers an initial state larger than the HTTP high water mark without destroying the connection', async () => {
  const gateway = await createGateway({ spawnImpl: () => assert.fail('no audio worker expected'), fetchImpl: () => assert.fail('no official requests expected') });
  gateway.state.rows = Array.from({ length: 6 }, (_, segmentId) => ({ segmentId, ja: '公開テスト。'.repeat(600), translation: { zh: '测试'.repeat(600), en: 'public test '.repeat(200) } }));
  let ownedRequest;
  try {
    const received = await new Promise((done, reject) => {
      const timeout = setTimeout(() => { ownedRequest?.destroy(); reject(new Error('SSE state timeout')); }, 2000);
      ownedRequest = httpRequest(gateway.origin + '/events', response => {
        response.setEncoding('utf8'); let body = '';
        response.on('error', reject);
        response.on('data', chunk => {
          body += chunk;
          const boundary = body.indexOf('\n\n');
          if (boundary >= 0) { clearTimeout(timeout); done(JSON.parse(body.slice(6, boundary))); }
        });
      });
      ownedRequest.on('error', reject); ownedRequest.end();
    });
    assert.equal(received.type, 'state');
    assert.deepEqual(received.state.rows, gateway.state.rows);
    assert.equal(gateway.state.workerActive, false);
  } finally { ownedRequest?.destroy(); await gateway.close(); }
});

test('worker clock uses lowest RTT, unknown timings remain null instead of zero', () => {
  const clock = new WorkerClock(); let first;
  clock.request(message => { first = message.id; }, 100);
  assert.equal(clock.accept({ id: first, perfCounterMs: 1000 }, 110), true);
  assert.equal(clock.toNode(1010), 115); assert.equal(clock.best.uncertaintyMs, 5);
  let second; clock.request(message => { second = message.id; }, 120);
  clock.accept({ id: second, perfCounterMs: 1021 }, 122);
  assert.equal(clock.best.uncertaintyMs, 1); assert.equal(clock.toNode(1030), 130);
  assert.equal(clock.accept({ id: 'unknown', perfCounterMs: 0 }, 130), false);
  const latency = latencyFor({ audioEndNodeMs: null, asrStartNodeMs: 10, asrEndNodeMs: 30 });
  assert.equal(latency.asrMs, 20); assert.equal(latency.segmentationMs, null); assert.equal(latency.audioEndToCompletedMs, null);
  assert.equal(latency.audioEndUncertaintyMs, null); assert.equal(latency.audioEndResolutionMs, 32);
});

test('browser script compiles and uses textContent for recognized and translated text', async () => {
  const ui = await readFile(new URL('./ui.html', import.meta.url), 'utf8');
  const script = ui.match(/<script>([\s\S]+)<\/script>/)[1];
  new Script(script.replace('__CAPABILITY__', 'test-capability'));
  assert.match(script, /\.textContent=row\.translation\.zh/); assert.match(script, /\.textContent=row\.ja/);
  assert.doesNotMatch(script, /innerHTML|localStorage|sessionStorage|getUserMedia/);
});

test('server is passive on startup; mutation guard checks Host, Origin and capability', async () => {
  let spawned = 0, fetched = 0;
  const gateway = await createGateway({ spawnImpl: () => { spawned++; throw new Error(); }, fetchImpl: async () => { fetched++; throw new Error(); }, registrationDir: join(tmpdir(), 'nonexistent-prototype-registration') });
  try {
    const page = await fetch(gateway.origin); assert.equal(page.status, 200);
    const text = await page.text(), capability = text.match(/const capability='([^']+)'/)[1];
    assert.equal(spawned, 0); assert.equal(fetched, 0);
    const unauthorized = await fetch(gateway.origin + '/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await unauthorized.json()).error, 'mutation_authorization_failed');
    const crossOrigin = await fetch(gateway.origin + '/devices', { method: 'POST', headers: { origin: 'https://example.org', 'content-type': 'application/json', 'x-prototype-capability': capability }, body: '{}' });
    assert.equal((await crossOrigin.json()).error, 'cross_origin_rejected');
    const wrongHostStatus = await new Promise((done, reject) => { const req = httpRequest(gateway.origin + '/state', { headers: { Host: 'example.org' } }, response => { response.resume(); done(response.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(wrongHostStatus, 400);
    const noAuth = await fetch(gateway.origin + '/start', { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json', 'x-prototype-capability': capability }, body: JSON.stringify({ device: 0, model: 'gpt-6.1-sol' }) });
    assert.equal((await noAuth.json()).error, 'official_authorization_required');
    assert.equal(spawned, 0); assert.equal(fetched, 0);
  } finally { await gateway.close(); }
});

test('cross-site exception permits only the top-level GET landing document, never API, iframe, subresource or POST requests', async () => {
  let spawned = 0, fetched = 0;
  const gateway = await createGateway({ spawnImpl: () => { spawned++; throw new Error(); }, fetchImpl: async () => { fetched++; throw new Error(); }, registrationDir: join(tmpdir(), 'nonexistent-prototype-registration') });
  const navigationHeaders = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  try {
    const landing = await metadataRequest(gateway.origin + '/', { headers: navigationHeaders });
    assert.equal(landing.status, 200); assert.match(landing.headers['content-type'], /text\/html/);
    assert.equal(landing.headers['cache-control'], 'no-store');
    assert.match(landing.headers['content-security-policy'], /frame-ancestors 'none'/);
    const rejected = [
      { path: '/', headers: { ...navigationHeaders, 'sec-fetch-dest': 'iframe' } },
      { path: '/', headers: { ...navigationHeaders, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } },
      { path: '/', headers: { ...navigationHeaders, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } },
      { path: '/', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } },
      { path: '/', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' } },
      { path: '/', headers: { ...navigationHeaders, origin: 'https://example.org' } },
      ...['/state', '/events', '/clock', '/report'].map(path => ({ path, headers: navigationHeaders })),
      { path: '/', method: 'POST', headers: navigationHeaders },
      { path: '/auth/start', method: 'POST', headers: { ...navigationHeaders, origin: gateway.origin } },
    ];
    for (const sample of rejected) {
      const response = await metadataRequest(gateway.origin + sample.path, { method: sample.method ?? 'GET', headers: sample.headers });
      assert.equal(response.status, 400, JSON.stringify(sample));
      assert.equal(JSON.parse(response.body).error, 'cross_origin_rejected', JSON.stringify(sample));
    }
    const wrongHost = await metadataRequest(gateway.origin + '/', { headers: { ...navigationHeaders, host: 'example.org' } });
    assert.equal(wrongHost.status, 400); assert.equal(JSON.parse(wrongHost.body).error, 'invalid_host');
    assert.equal(spawned, 0); assert.equal(fetched, 0); assert.equal(gateway.state.auth, 'unauthorized');
  } finally { await gateway.close(); }
});

test('mock OAuth + fixed public replay reaches ordered bilingual result, visibility and evaluation with no real microphone/network', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mic-prototype-test-'));
  const registrationDir = join(temporary, 'auth'); await mkdir(registrationDir);
  const email = 'unit-test@example.invalid', clientId = 'test_client_id', subject = 'test-subject';
  const digest = value => createHash('sha256').update(value).digest('hex');
  await writeFile(join(registrationDir, 'registration.json'), JSON.stringify({ appName: 'Bilibili Subtitle SIWC Probe', hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', clientId, subjectDigest: digest(subject) }));
  await writeFile(join(registrationDir, 'expected-identity.json'), JSON.stringify({ emailSha256: digest(email) }));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let nonce, spawnCalls = [], translationCalls = [], fetched = [], mockWorker, heldCatalog = null, translationFailure = false;
  const jwt = () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: clientId, nonce, sub: subject, email, iat: Date.now() / 1000, exp: Date.now() / 1000 + 3600 })).toString('base64url');
    return header + '.' + body + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + body), privateKey).toString('base64url');
  };
  const fetchImpl = async url => {
    fetched.push(String(url));
    if (String(url).endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' });
    if (String(url).endsWith('jwks.json')) return Response.json({ keys: [key] });
    if (String(url).endsWith('oauth/token')) return Response.json({ id_token: jwt(), access_token: 'test-only-access', refresh_token: 'test-only-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' });
    throw new Error('unexpected mock URL');
  };
  const spawnImpl = (executable, args) => {
    spawnCalls.push({ executable, args });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
    let clockCount = 0;
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        const command = JSON.parse(line);
        if (command.command === 'clock') {
          emit({ type: 'clock_sync', id: command.id, perfCounterMs: performance.now() + 5000 });
          if (++clockCount === 3) setTimeout(() => {
            const point = performance.now() + 5000;
            emit({ type: 'asr_result', segmentId: 1, revision: 1, ja: '今日は雨です。', startSample: 0, endSample: 16000, sampleRate: 16000,
              audioEndPerfMs: point - 1000, vadCommitPerfMs: point - 500, asrStartPerfMs: point - 400, asrEndPerfMs: point,
              audioEndSource: 'vad_frame_end', audioEndResolutionMs: 32, audioEndUncertaintyMs: null });
          }, 5);
        }
        if (command.command === 'stop') { child.stdout.end(); setImmediate(() => child.emit('close', 0)); }
      }
      callback();
    } });
    child.kill = () => { child.stdout.end(); child.emit('close', 1); };
    mockWorker = child;
    setImmediate(() => emit({ type: 'worker_ready', perfCounterMs: performance.now() + 5000 }));
    return child;
  };
  const replayFile = join(temporary, 'fixed.wav');
  const gateway = await createGateway({ registrationDir, outputBase: join(temporary, 'evidence'), replayFile, fetchImpl, spawnImpl,
    catalogImpl: async access => { assert.equal(access, 'test-only-access'); if (heldCatalog) await heldCatalog.promise; return { retrieved_at: 'test', models: [{ slug: 'gpt-6.1-sol', display_name: 'Test', supported_reasoning_efforts: ['low'] }] }; },
    translateImpl: async args => { translationCalls.push(args); return translationFailure ? { success: false, http_status: 429, error: { code: 'rate_limit_exceeded' }, final_status: 'http_error' } : result('雨'); } });
  try {
    const html = await (await fetch(gateway.origin)).text(), capability = html.match(/const capability='([^']+)'/)[1];
    const post = (path, body = {}) => fetch(gateway.origin + path, { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json', 'x-prototype-capability': capability }, body: JSON.stringify(body) });
    const auth = await (await post('/auth/start')).json(), authUrl = new URL(auth.url);
    nonce = authUrl.searchParams.get('nonce');
    const navigationHeaders = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    const callback = await metadataRequest(gateway.origin + '/auth/callback?' + new URLSearchParams({ state: authUrl.searchParams.get('state'), code: 'test-code', client_id: clientId }), { headers: navigationHeaders });
    assert.equal(callback.status, 303); assert.equal(gateway.state.auth, 'authorized'); assert.equal(spawnCalls.length, 0);
    assert.equal(callback.headers.location, '/');
    const landing = await metadataRequest(new URL(callback.headers.location, gateway.origin), { headers: navigationHeaders });
    assert.equal(landing.status, 200); assert.match(landing.headers['content-type'], /text\/html/);
    assert.equal(gateway.state.auth, 'authorized'); assert.equal(spawnCalls.length, 0);
    heldCatalog = deferred();
    const firstStart = post('/start', { source: 'public_replay', model: 'gpt-6.1-sol', concurrency: 1 });
    await until(() => gateway.state.captureStarting);
    const doubleStart = await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol', concurrency: 1 });
    assert.equal((await doubleStart.json()).error, 'previous_session_still_active');
    const authDuringStart = await post('/auth/start'); assert.equal((await authDuringStart.json()).error, 'stop_capture_before_authorizing');
    const callbackDuringStart = await fetch(gateway.origin + '/auth/callback?code=invalid', { redirect: 'manual' }); assert.equal((await callbackDuringStart.json()).error, 'authorization_in_progress_or_capture_active');
    await post('/stop'); heldCatalog.resolve(); heldCatalog = null;
    assert.equal((await (await firstStart).json()).error, 'capture_start_cancelled'); assert.equal(spawnCalls.length, 0);
    const started = await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol', concurrency: 1, replayFile: 'untrusted-ignored.wav' });
    assert.equal(started.status, 200);
    await until(() => gateway.state.rows[0]?.visibleEligible);
    assert.equal(spawnCalls.length, 1); assert.ok(spawnCalls[0].args.includes('--audio-file')); assert.ok(spawnCalls[0].args.includes(replayFile));
    assert.equal(spawnCalls[0].args[3], 'file');
    assert.ok(!spawnCalls[0].args.includes('--device')); assert.ok(!spawnCalls[0].args.includes('untrusted-ignored.wav'));
    assert.equal(translationCalls.length, 1); assert.deepEqual(translationCalls[0].model, { slug: 'gpt-6.1-sol', display_name: 'Test' });
    assert.equal(translationCalls[0].fixture.ja, '今日は雨です。');
    const row = gateway.state.rows[0];
    assert.equal(row.status, 'completed'); assert.equal(row.latency.audioEndUncertaintyMs, null);
    await wait(5);
    const oldVisibility = await post('/visible', { sessionId: 'previous-session', segmentId: 1, revision: 1, visibleNodeMs: performance.now(), clockUncertaintyMs: 1 });
    assert.equal((await oldVisibility.json()).error, 'test_session_mismatch');
    const visibility = await post('/visible', { sessionId: gateway.state.session.id, segmentId: 1, revision: 1, visibleNodeMs: performance.now(), clockUncertaintyMs: 1 });
    assert.equal(visibility.status, 200); assert.ok(gateway.state.rows[0].latency.endToEndVisibleMs >= 1000);
    const evaluation = await post('/evaluate', { sessionId: gateway.state.session.id, segmentId: 1, revision: 1, referenceJa: '今日は雨です。', zhQuality: 'usable', enQuality: 'minor', note: 'unit test only' });
    assert.equal(evaluation.status, 200);
    mockWorker.stdout.write(JSON.stringify({ type: 'vad_segment', segmentId: 2, revision: 1 }) + '\n');
    mockWorker.stdout.write(JSON.stringify({ type: 'worker_error', segmentId: 2, revision: 1, code: 'mock_asr_failed' }) + '\n');
    mockWorker.stdout.write(JSON.stringify({ type: 'vad_segment', segmentId: 3, revision: 1 }) + '\n');
    await until(() => gateway.state.rows.length === 3);
    assert.equal(gateway.state.rows[1].status, 'gap'); assert.equal(gateway.state.rows[1].errorCode, 'mock_asr_failed');
    const staleSaved = await (await post('/save', { sessionId: 'previous-session' })).json(); assert.equal(staleSaved.error, 'test_session_mismatch');
    const staleEvaluation = await (await post('/evaluate', { sessionId: 'previous-session', segmentId: 1, revision: 1, referenceJa: '', zhQuality: 'usable', enQuality: 'usable', note: '' })).json(); assert.equal(staleEvaluation.error, 'test_session_mismatch');
    const saved = await (await post('/save', { sessionId: gateway.state.session.id })).json(); assert.equal(saved.saved, true);
    const reportText = await readFile(join(saved.outputDir, 'report.json'), 'utf8');
    assert.doesNotMatch(reportText, /test-only-access|test-only-refresh|id_token|code_verifier/);
    const evidence = await readFile(join(saved.outputDir, 'events.jsonl'), 'utf8'); assert.doesNotMatch(evidence, /test-only-access|test-only-refresh|id_token|code_verifier/);
    assert.ok(fetched.every(url => url.startsWith('https://auth.openai.com/'))); assert.ok(!fetched.some(url => /quota|usage|limits/.test(url)));
    await post('/stop'); await until(() => gateway.state.workerActive === false); assert.equal(gateway.state.session.source, 'public_replay');
    assert.equal(gateway.state.rows[2].status, 'gap'); assert.equal(gateway.state.rows[2].errorCode, 'asr_worker_exited_before_result');
    const firstSessionId = gateway.state.session.id;
    translationFailure = true;
    assert.equal((await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol', concurrency: 1 })).status, 200);
    await until(() => gateway.state.rows[0]?.status === 'failed' && !gateway.state.workerActive);
    assert.equal(gateway.state.phase, 'translation_paused'); assert.match(gateway.state.message, /rate_limit_exceeded/);
    const crossSessionAck = await (await post('/visible', { sessionId: firstSessionId, segmentId: 1, revision: 1, visibleNodeMs: performance.now(), clockUncertaintyMs: 1 })).json();
    assert.equal(crossSessionAck.error, 'test_session_mismatch');
    assert.ok(mockWorker);
  } finally { await gateway.close(); await rm(temporary, { recursive: true, force: true }); }
});

test('CLI provider checks existing login locally, never enters OAuth, and translates only after explicit replay start', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mic-prototype-cli-test-'));
  let checks = 0, spawned = 0, fetched = 0, translated = 0, loggedIn = true, failTranslation = false, lateCleanupFailure = false, unconfirmedExit = false;
  const translations = [], heldTranslation = deferred();
  const gateway = await createGateway({ translationProvider: 'codex_cli', codexExecutable: 'C:/test/codex.exe',
    cliWorkDir: join(temporary, 'empty-cli-work'), cliInstructionsFile: join(temporary, 'translation-base.md'),
    replayFile: join(temporary, 'fixed.wav'), outputBase: join(temporary, 'evidence'), registrationDir: join(temporary, 'no-auth-files'),
    fetchImpl: async () => { fetched++; throw new Error('No OAuth or API request expected.'); },
    checkCodexLoginImpl: async options => { checks++; assert.equal(options.executable, 'C:/test/codex.exe'); return { loggedIn, authMode: loggedIn ? 'chatgpt' : null }; },
    listCodexModelsImpl: async () => ({ catalogSource: 'codex_model_list', models: [{ slug: 'gpt-6.1-sol', display_name: 'Test CLI Model', input_modalities: ['text'] }] }),
    translateImpl: async options => {
      translated++; translations.push(options);
      if (failTranslation) return { success: false, final_status: 'client_error', error: { code: 'codex_cli_auth_required' } };
      const telemetry = { transport: 'codex_cli', request: { model: options.model.slug, reasoning_policy: 'cli_default' },
        usage: { input_tokens: 20, output_tokens: 10 }, process: { exit_code: 0 }, terminal_event: 'turn.completed', final_status: 'completed' };
      options.onTurnCompleted({ ...result('晴れ'), terminal_event: 'turn.completed', process_cleanup_pending: true,
        telemetry: { ...telemetry, process: { exit_code: null, cleanup_pending: true, rejected_tool_items: 0 } },
        timings_ms: { headers: null, first_nonempty_delta: null, completed: 6, cli_turn_completed: 6, cli_process_exit: null } });
      await heldTranslation.promise;
      if (lateCleanupFailure) return { success: false, final_status: 'client_error', process_cleanup_pending: unconfirmedExit, error: { code: unconfirmedExit ? 'codex_cli_termination_unconfirmed' : 'codex_cli_nonzero_exit' }, telemetry };
      options.observer(telemetry);
      return { ...result('晴れ'), transport: 'codex_cli', response_model: null, telemetry,
        timings_ms: { headers: null, first_nonempty_delta: null, cli_first_event: 1, cli_final_text: 5, cli_turn_completed: 6, cli_process_exit: 7, completed: 7, total: 7 } };
    },
    spawnImpl: (executable, args) => {
      spawned++; assert.equal(args[3], 'file'); assert.ok(!args.includes('--device'));
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let clocks = 0;
      const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
      child.stdin = new Writable({ write(chunk, encoding, done) {
        for (const line of chunk.toString().trim().split('\n')) {
          const command = JSON.parse(line);
          if (command.command === 'clock') {
            emit({ type: 'clock_sync', id: command.id, perfCounterMs: performance.now() + 1000 });
            if (++clocks === 3) setImmediate(() => { const point = performance.now() + 1000;
              emit({ type: 'asr_result', segmentId: 1, revision: 1, ja: '今日は晴れです。', startSample: 0, endSample: 16000, sampleRate: 16000,
                audioEndPerfMs: point - 1000, vadCommitPerfMs: point - 500, asrStartPerfMs: point - 400, asrEndPerfMs: point }); });
          }
          if (command.command === 'stop') { child.stdout.end(); setImmediate(() => child.emit('close', 0)); }
        }
        done();
      } });
      child.kill = () => { child.stdout.end(); child.emit('close', 1); };
      setImmediate(() => emit({ type: 'worker_ready' })); return child;
    } });
  try {
    assert.equal(checks, 1); assert.equal(spawned, 0); assert.equal(translated, 0); assert.equal(fetched, 0);
    assert.equal(gateway.state.provider, 'codex_cli'); assert.equal(gateway.state.auth, 'authorized');
    assert.equal(gateway.state.expectedAccountGuard, false); assert.equal(gateway.state.catalogSource, 'codex_model_list');
    assert.deepEqual(gateway.state.models.map(model => model.slug), ['gpt-6.1-sol']);
    const html = await (await fetch(gateway.origin)).text(), capability = html.match(/const capability='([^']+)'/)[1];
    const post = (path, body = {}) => fetch(gateway.origin + path, { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json', 'x-prototype-capability': capability }, body: JSON.stringify(body) });
    const noCapability = await fetch(gateway.origin + '/cli/check', { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await noCapability.json()).error, 'mutation_authorization_failed'); assert.equal(checks, 1);
    const crossOrigin = await fetch(gateway.origin + '/cli/check', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json', 'x-prototype-capability': capability }, body: '{}' });
    assert.equal((await crossOrigin.json()).error, 'cross_origin_rejected'); assert.equal(checks, 1);
    assert.equal((await (await post('/cli/check')).json()).loggedIn, true); assert.equal(checks, 2);
    assert.equal((await (await post('/auth/start')).json()).error, 'siwc_disabled_for_cli');
    assert.equal((await (await fetch(gateway.origin + '/auth/callback?code=not-used')).json()).error, 'siwc_disabled_for_cli');
    assert.equal(fetched, 0); assert.equal(spawned, 0); assert.equal(translated, 0);
    assert.equal((await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol' })).status, 200);
    await until(() => translated === 1);
    assert.equal(checks, 3); assert.equal(spawned, 1);
    await until(() => gateway.state.rows[0]?.visibleEligible);
    assert.equal(gateway.state.queue.active, 0); assert.equal(gateway.state.queue.cleanup, 1); assert.equal(gateway.state.queue.processesActive, 1);
    assert.equal(gateway.state.queue.processLimit, 3); assert.equal(gateway.state.rows[0].completionBoundary, 'cli_turn_completed');
    assert.equal(gateway.state.session.schedulerPolicy, 'bounded_inference_and_cleanup'); assert.equal(gateway.state.session.cleanupAllowance, 2);
    assert.equal(gateway.state.session.cliProcessLimit, 3);
    const semanticEnd = gateway.state.rows[0].translationEndNodeMs;
    const visible = await post('/visible', { sessionId: gateway.state.session.id, segmentId: 1, revision: 1, visibleNodeMs: performance.now(), clockUncertaintyMs: 1 });
    assert.equal(visible.status, 200);
    const originalVisible = gateway.state.rows[0].visibleNodeMs;
    await post('/evaluate', { sessionId: gateway.state.session.id, segmentId: 1, revision: 1, referenceJa: '今日は晴れです。', zhQuality: 'usable', enQuality: 'usable', note: 'before cleanup' });
    await post('/stop'); await until(() => !gateway.state.workerActive);
    assert.equal(gateway.state.queue.active, 0); assert.equal(gateway.state.queue.cleanup, 1);
    const stillSameSession = gateway.state.session.id;
    assert.equal((await (await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol' })).json()).error, 'previous_session_still_active');
    assert.equal(gateway.state.session.id, stillSameSession); assert.equal(spawned, 1); assert.equal(checks, 3);
    assert.equal((await (await post('/cli/check')).json()).error, 'stop_capture_before_checking_login'); assert.equal(checks, 3);
    heldTranslation.resolve(); await until(() => gateway.state.queue.processesActive === 0);
    assert.equal(gateway.state.rows[0].translationEndNodeMs, semanticEnd); assert.equal(gateway.state.rows[0].visibleNodeMs, originalVisible);
    assert.equal(gateway.state.rows[0].evaluation.note, 'before cleanup'); assert.ok(Number.isFinite(gateway.state.rows[0].latency.endToEndVisibleMs));
    const args = translations[0]; assert.equal(args.executable, 'C:/test/codex.exe'); assert.equal(args.timeoutMs, 30_000);
    assert.equal(args.fixture.ja, '今日は晴れです。'); assert.match(args.fixture.context, /livestream host/);
    assert.equal('accessToken' in args, false); assert.equal('fetchImpl' in args, false);
    assert.equal(gateway.state.session.provider, 'codex_cli'); assert.equal(gateway.state.session.source, 'public_replay');
    assert.equal(gateway.state.rows[0].translationUsage.input_tokens, 20);
    assert.equal(gateway.state.rows[0].translationDiagnostics.transport, 'codex_cli');
    assert.equal(gateway.state.rows[0].translationDiagnostics.process.exit_code, null);
    assert.equal(gateway.state.rows[0].cleanup.process.exit_code, 0);
    assert.equal(gateway.state.rows[0].translationTimingsMs.headers, null);
    const saved = await (await post('/save', { sessionId: gateway.state.session.id })).json();
    assert.match(await readFile(join(saved.outputDir, 'events.jsonl'), 'utf8'), /translation_observation/);
    await post('/stop'); await until(() => !gateway.state.workerActive);
    loggedIn = false;
    assert.equal((await (await post('/cli/check')).json()).loggedIn, false);
    assert.equal((await (await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol' })).json()).error, 'codex_cli_auth_required');
    assert.equal(spawned, 1); assert.equal(translated, 1); assert.equal(gateway.state.auth, 'unauthorized');
    loggedIn = true; failTranslation = true;
    assert.equal((await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol' })).status, 200);
    await until(() => gateway.state.rows[0]?.status === 'failed' && !gateway.state.workerActive);
    assert.equal(gateway.state.phase, 'translation_paused'); assert.equal(gateway.state.auth, 'unauthorized');
    assert.doesNotMatch(gateway.state.message, /重新官方授权/); assert.equal(fetched, 0); assert.equal(translated, 2);
    failTranslation = false; lateCleanupFailure = true;
    assert.equal((await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol' })).status, 200);
    await until(() => gateway.state.rows[0]?.status === 'completed' && !gateway.state.workerActive && gateway.state.queue.active === 0);
    assert.ok(gateway.state.warnings.includes('cli_cleanup_error:codex_cli_nonzero_exit'));
    assert.equal(gateway.state.rows[0].status, 'completed'); assert.equal(gateway.state.rows[0].errorCode, null);
    assert.equal(gateway.state.rows[0].cleanup.errorCode, 'codex_cli_nonzero_exit');
    await post('/save', { sessionId: gateway.state.session.id });
    const cleanupEvidence = (await readFile(join(gateway.state.session.outputDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(cleanupEvidence.filter(event => event.type === 'ordered').length, 1);
    assert.equal(cleanupEvidence.filter(event => event.type === 'cleanup_error').length, 1);
    assert.equal(gateway.state.phase, 'translation_paused'); assert.equal(translated, 3); assert.equal(fetched, 0);
    unconfirmedExit = true;
    assert.equal((await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol' })).status, 200);
    await until(() => gateway.state.cliProcessExitUnconfirmed && !gateway.state.workerActive && gateway.state.queue.processesActive === 0);
    const checksBeforeBlockedRestart = checks, spawnsBeforeBlockedRestart = spawned;
    assert.equal((await (await post('/start', { source: 'public_replay', model: 'gpt-6.1-sol' })).json()).error, 'codex_cli_process_exit_unconfirmed');
    assert.equal((await (await post('/cli/check')).json()).error, 'codex_cli_process_exit_unconfirmed');
    assert.equal(checks, checksBeforeBlockedRestart); assert.equal(spawned, spawnsBeforeBlockedRestart);
    assert.equal(translated, 4); assert.equal(gateway.state.rows[0].status, 'completed');
  } finally { await gateway.close(); await rm(temporary, { recursive: true, force: true }); }
});
