import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual, createPublicKey, verify, constants } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemorySession } from './oauth-session.mjs';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const APP_NAME = 'Bilibili Subtitle SIWC Probe';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const ATTEMPT_MS = 10 * 60 * 1000;
const here = dirname(fileURLToPath(import.meta.url));

function fail(code) { throw Object.assign(new Error(code), { safeCode: code }); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function digest(subject) { return createHash('sha256').update(subject).digest('hex'); }

export function newAttempt(redirectUri, clientId = null) {
  const verifier = randomBytes(64).toString('base64url');
  return {
    state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
    verifier, challenge: createHash('sha256').update(verifier).digest('base64url'),
    redirectUri, clientId, expiresAt: Date.now() + ATTEMPT_MS, used: false,
  };
}

export function consumeCallback(url, attempt) {
  if (!attempt || attempt.used || Date.now() >= attempt.expiresAt) fail('callback_expired_or_consumed');
  for (const key of ['state', 'code', 'client_id', 'error']) {
    if (url.searchParams.getAll(key).length > 1) fail('callback_duplicate_parameter');
  }
  if (!equal(url.searchParams.get('state'), attempt.state)) fail('callback_state_mismatch');
  attempt.used = true;
  if (url.searchParams.has('error')) fail('authorization_declined_or_failed');
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id') || attempt.clientId;
  if (!code || !clientId || clientId === 'dynamic_agent_client' || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId)) fail('registration_incomplete');
  if (attempt.clientId && clientId !== attempt.clientId) fail('callback_client_mismatch');
  return { code, clientId };
}

export function verifyIdentity(idToken, { clientId, nonce, jwks, subjectDigest = null, expectedEmailSha256 = null, now = Date.now() / 1000 }) {
  if (typeof idToken !== 'string' || idToken.length > 32768) fail('id_token_missing_or_oversized');
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) fail('id_token_format');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { fail('id_token_format'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) fail('id_token_algorithm');
  const keys = jwks?.keys?.filter(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256')) ?? [];
  if (keys.length !== 1) fail('id_token_unknown_key');
  let valid = false;
  try {
    const key = createPublicKey({ key: keys[0], format: 'jwk' });
    valid = verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), { key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(parts[2], 'base64url'));
  } catch { fail('id_token_signature'); }
  if (!valid) fail('id_token_signature');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audiences.includes(clientId) || (claims.azp !== undefined && claims.azp !== clientId) || (audiences.length > 1 && !claims.azp)) fail('id_token_issuer_or_audience');
  if (!Number.isFinite(claims.exp) || claims.exp <= now - 5 || !Number.isFinite(claims.iat) || claims.iat > now + 5 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 5))) fail('id_token_time');
  if (!equal(claims.nonce, nonce) || typeof claims.sub !== 'string' || !claims.sub) fail('id_token_nonce_or_subject');
  // The email is only an account-selection guard; client ID and verified sub remain the stable binding.
  if (expectedEmailSha256 && (typeof claims.email !== 'string' || !equal(digest(claims.email.trim().toLowerCase()), expectedEmailSha256))) fail('expected_codex_account_mismatch');
  const actualDigest = digest(claims.sub);
  if (subjectDigest && !equal(actualDigest, subjectDigest)) fail('id_token_account_changed');
  return { subjectDigest: actualDigest };
}

async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}

async function officialJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) fail('official_endpoint_http_' + response.status);
  try { return await response.json(); } catch { fail('official_endpoint_invalid_json'); }
}

export async function main() {
  const outputDir = resolve(process.argv[2] || 'docs/validation/2026-10-15/siwc-direct');
  let benchmarkConfig = null;
  let fixtures = JSON.parse(await readFile(join(here, 'fixtures.json'), 'utf8'));
  if (process.argv[4]) {
    const configPath = resolve(process.argv[4]);
    benchmarkConfig = JSON.parse(await readFile(configPath, 'utf8'));
    fixtures = JSON.parse(await readFile(resolve(dirname(configPath), benchmarkConfig.fixture_file), 'utf8'));
    const { validateBenchmark } = await import('./benchmark.mjs');
    validateBenchmark(benchmarkConfig, fixtures);
  }
  await mkdir(outputDir, { recursive: false });
  const registrationDir = join(process.env.LOCALAPPDATA || process.env.APPDATA || fail('local_appdata_unavailable'), 'Bilibili-SIWC-Probe');
  const registrationPath = join(registrationDir, 'registration.json');
  let registration;
  try { registration = JSON.parse(await readFile(registrationPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') fail('registration_read_failed');
    registration = { version: 1, appName: APP_NAME, hostId: 'urn:uuid:' + randomUUID(), clientId: null, subjectDigest: null };
    await atomicJson(registrationPath, registration);
  }
  if (registration.appName !== APP_NAME || !/^urn:uuid:[0-9a-f-]{36}$/.test(registration.hostId)) fail('registration_invalid');
  let expectedIdentity = null;
  try { expectedIdentity = JSON.parse(await readFile(join(registrationDir, 'expected-identity.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') fail('expected_identity_read_failed'); }
  if (expectedIdentity && !/^[a-f0-9]{64}$/.test(expectedIdentity.emailSha256)) fail('expected_identity_invalid');
  if (benchmarkConfig && !expectedIdentity) fail('benchmark_expected_account_guard_required');
  const discovery = await officialJson(ISSUER + '/.well-known/openid-configuration');
  if (discovery.issuer !== ISSUER || discovery.authorization_endpoint !== ISSUER + '/api/accounts/authorize' || discovery.token_endpoint !== ISSUER + '/api/accounts/oauth/token' || discovery.jwks_uri !== ISSUER + '/.well-known/jwks.json') fail('discovery_endpoint_mismatch');
  let jwks = await officialJson(discovery.jwks_uri);
  let pending = null;
  let tokens = null;
  const csrf = randomBytes(32).toString('base64url');
  let origin;
  let authRunning = false;
  const state = { phase: 'ready', message: expectedIdentity ? '请使用与当前 Codex 环境一致的账号；若不是页面列出的账号，选择“使用其他账号”。' : '请点击 Continue with ChatGPT，选择持有 Pro 的账号并授权。', completedRequests: 0, modelCount: null, expectedAccountGuard: Boolean(expectedIdentity), plannedCasesPerModel: benchmarkConfig?.case_count ?? 18, plannedQualityRequests: benchmarkConfig ? benchmarkConfig.case_count * benchmarkConfig.model_slugs.length : null };
  async function record() {
    await atomicJson(join(outputDir, 'probe-status.json'), { ...state, updatedAt: new Date().toISOString(), appName: APP_NAME, tokenStorage: 'memory only', quotaQueried: false });
  }
  async function runTranslations() {
    state.phase = 'listing_models'; state.message = '正在请求该授权账号的实时模型目录。'; await record();
    const { listModels, runSuite } = await import('./inference.mjs');
    const models = await listModels(await tokens.getAccessToken());
    state.modelCount = Array.isArray(models) ? models.length : models.models?.length ?? null;
    await atomicJson(join(outputDir, 'catalog-observation.json'), models);
    state.phase = 'testing'; state.message = '正在顺序测试文本模型和双语完整返回延迟。'; await record();
    const onProgress = async info => {
      if (typeof info !== 'object' || info.status !== 'started') state.completedRequests++;
      state.message = typeof info === 'string' ? info : [info.model, info.caseId, info.status, '已完成请求 ' + state.completedRequests].join(' · ');
      if (!benchmarkConfig || info.status === 'failed' || (info.status !== 'started' && state.completedRequests % 10 === 0)) console.log(JSON.stringify({ event: 'progress', count: state.completedRequests, detail: info }));
      await record();
    };
    let summary;
    if (benchmarkConfig) {
      const { runBenchmark } = await import('./benchmark.mjs');
      summary = await runBenchmark({ getAccessToken: () => tokens.getAccessToken(), models, fixtures, config: benchmarkConfig, outputDir, onProgress });
    } else summary = await runSuite({ accessToken: await tokens.getAccessToken(), models, fixtures, outputDir, onProgress });
    tokens.close();
    await atomicJson(join(outputDir, 'session-observation.json'), tokens.diagnostics());
    tokens = null;
    state.phase = 'completed'; state.message = '测试完成；Token 已从探针活动状态清除，结果已保存。';
    state.summaryAvailable = Boolean(summary);
    await record();
    console.log(JSON.stringify({ event: 'completed', outputDir, requestCount: state.completedRequests }));
    setTimeout(() => { server.close(); }, 30000).unref();
  }
  async function handleAuthorization(url, response) {
    const attempt = pending;
    const { code, clientId } = consumeCallback(url, attempt);
    pending = null;
    // Retain an issued ID for diagnostics without activating an unverified account registration.
    await atomicJson(join(registrationDir, 'last-issued-registration.json'), { clientId, observedAt: new Date().toISOString() });
    state.phase = 'exchanging_code'; state.message = '回调已核对，正在换码和验证签名。'; await record();
    const data = await officialJson(discovery.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }),
    });
    let identity;
    const identityOptions = { clientId, nonce: attempt.nonce, subjectDigest: registration.subjectDigest, expectedEmailSha256: expectedIdentity?.emailSha256 ?? null };
    try { identity = verifyIdentity(data.id_token, { ...identityOptions, jwks }); }
    catch (error) {
      if (error.safeCode !== 'id_token_unknown_key') throw error;
      jwks = await officialJson(discovery.jwks_uri);
      identity = verifyIdentity(data.id_token, { ...identityOptions, jwks });
    }
    const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/) : [];
    if (!scopes.includes('chatgpt.tokens.use.direct') || typeof data.access_token !== 'string' || !data.access_token || String(data.token_type).toLowerCase() !== 'bearer') fail('plan_permission_not_granted');
    registration.clientId = clientId;
    registration.subjectDigest = identity.subjectDigest;
    await atomicJson(registrationPath, registration);
    tokens = createMemorySession({ tokenResponse: data, clientId, onEvent: info => {
      console.log(JSON.stringify(info));
      if (benchmarkConfig) appendFileSync(join(outputDir, 'session-events.jsonl'), JSON.stringify({ ...info, at: new Date().toISOString() }) + '\n');
    } });
    state.phase = 'authorized'; state.message = '授权、ID-token 签名和推理权限已验证，正在开始模型测试。'; await record();
    response.writeHead(303, { Location: '/' }); response.end();
    const authObservation = { event: 'authorized', idTokenVerified: true, planPermissionGranted: true, expectedCodexEmailMatched: expectedIdentity ? true : null, tokenStorage: 'memory only', at: new Date().toISOString() };
    await atomicJson(join(outputDir, 'auth-observation.json'), authObservation);
    console.log(JSON.stringify(authObservation));
    runTranslations().catch(async error => {
      if (tokens) { tokens.close(); await atomicJson(join(outputDir, 'session-observation.json'), tokens.diagnostics()); tokens = null; }
      state.phase = 'failed'; state.message = error.safeCode || 'inference_probe_failed';
      if (error.safeArtifact) await atomicJson(join(outputDir, 'catalog-error.json'), error.safeArtifact);
      await record(); console.log(JSON.stringify({ event: 'failed', stage: 'inference', code: state.message }));
      setTimeout(() => { server.close(); }, 30000).unref();
    });
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== new URL(origin).host) { response.writeHead(400); response.end('Invalid host'); return; }
    let url;
    try { url = new URL(request.url, origin); } catch { response.writeHead(400); response.end(); return; }
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        // A no-referrer document can make form POST Origin null; retain origin for local CSRF validation.
        response.setHeader('Referrer-Policy', 'same-origin');
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>SIWC 翻译验证</title><style>body{max-width:780px;margin:48px auto;font:18px/1.7 system-ui;padding:0 20px}button{padding:12px 22px;background:#111;color:white;border:0;border-radius:6px;font-size:18px}pre{white-space:pre-wrap;background:#f4f4f4;padding:18px}</style><h1>SIWC 授权与翻译验证</h1><p>仅测试当前账号模型目录与日语 → 简体中文、英文翻译。不查询额度，不采集麦克风。</p><p>本轮每模型 ${state.plannedCasesPerModel} 条；${state.plannedQualityRequests ? '正式请求共 ' + state.plannedQualityRequests + ' 次，另有可用性探测。' : '模型通过探测后开始逐句测试。'}每次同时返回中英文。</p><p>请使用与当前 Codex 环境一致的账号；如果官方页面列出其他账号，点击“使用其他账号”。新授权身份会在推理前核对。</p><p>授权名称为 <b>${APP_NAME}</b>。Token 仅在本次进程内存中使用，不显示或保存到项目。</p><form method="post" action="/auth/start"><input type="hidden" name="csrf" value="${csrf}"><button>Continue with ChatGPT</button></form><pre id="status">正在读取状态…</pre><script>async function update(){try{const r=await fetch('/status');const s=await r.json();document.querySelector('#status').textContent=[s.message,'阶段：'+s.phase,'已完成请求：'+s.completedRequests].join(String.fromCharCode(10));}catch{}}update();setInterval(update,1500);</script></html>`);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(state)); return;
      }
      if (request.method === 'POST' && url.pathname === '/auth/start') {
        if (request.headers.origin !== origin || authRunning || ['listing_models', 'testing', 'completed'].includes(state.phase)) {
          console.log(JSON.stringify({ event: 'authorization_start_rejected', originPresent: request.headers.origin !== undefined, originMatches: request.headers.origin === origin, originIsNull: request.headers.origin === 'null', fetchSite: request.headers['sec-fetch-site'] ?? null, authRunning, phase: state.phase }));
          fail('authorization_start_rejected');
        }
        let body = '';
        for await (const chunk of request) { body += chunk.toString(); if (body.length > 2048) fail('authorization_body_too_large'); }
        if (!equal(new URLSearchParams(body).get('csrf'), csrf)) fail('authorization_csrf');
        pending = newAttempt(origin + '/auth/callback', registration.clientId);
        const authorize = new URL(discovery.authorization_endpoint);
        const params = { client_id: registration.clientId || 'dynamic_agent_client', ext_agent_host_id: registration.hostId, response_type: 'code', redirect_uri: pending.redirectUri, scope: SCOPES, resource: RESOURCE, state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256', code_challenge: pending.challenge };
        if (!registration.clientId) params.agent_name_hint = APP_NAME;
        authorize.search = new URLSearchParams(params).toString();
        state.phase = 'awaiting_authorization'; state.message = '请在 OpenAI 官方页面完成登录及授权。'; await record();
        response.writeHead(303, { Location: authorize.href }); response.end(); return;
      }
      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        if (authRunning) fail('authorization_in_progress');
        authRunning = true;
        try { await handleAuthorization(url, response); } finally { authRunning = false; }
        return;
      }
      response.writeHead(404); response.end('Not found');
    } catch (error) {
      const code = error.safeCode || 'probe_request_failed';
      if (url.pathname === '/auth/callback' && pending?.used) pending = null;
      if (!['testing', 'listing_models', 'completed'].includes(state.phase)) {
        state.phase = 'authorization_failed'; state.message = code; await record();
      }
      console.log(JSON.stringify({ event: 'request_failed', code }));
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('验证未完成：' + code + '。可回到本机首页重试。');
    }
  });
  const listenPort = process.argv[3] === undefined ? 0 : Number(process.argv[3]);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) fail('invalid_loopback_port');
  await new Promise((ok, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', ok); });
  origin = 'http://127.0.0.1:' + server.address().port;
  await record();
  console.log(JSON.stringify({ event: 'ready', localUrl: origin + '/', outputDir }));
  process.once('SIGINT', () => { tokens?.close(); tokens = null; pending = null; server.close(); process.exit(130); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ event: 'startup_failed', code: error.safeCode || error.code || 'startup_failed' })); process.exitCode = 1; });
}
