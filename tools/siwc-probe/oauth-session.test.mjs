import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySession } from './oauth-session.mjs';

const initial = { access_token: 'synthetic-access-a', refresh_token: 'synthetic-refresh-a', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' };

test('session does not refresh early and close removes access', async () => {
  let calls = 0;
  const session = createMemorySession({ tokenResponse: initial, clientId: 'oaiapp_test', now: () => 0, fetchImpl: async () => { calls++; throw new Error('must not call'); } });
  assert.equal(await session.getAccessToken(), initial.access_token);
  assert.equal(calls, 0);
  session.close();
  assert.equal(session.diagnostics().closed, true);
  assert.equal(JSON.stringify(session.diagnostics()).includes('synthetic'), false);
  await assert.rejects(session.getAccessToken(), /session_closed/);
});

test('refresh serializes rotating tokens, uses issued client and omits scope', async () => {
  let clock = 0, calls = 0;
  const events = [];
  const session = createMemorySession({ tokenResponse: initial, clientId: 'oaiapp_test', now: () => clock, onEvent: e => events.push(e), fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('client_id'), 'oaiapp_test');
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    assert.equal(options.body.get('resource'), 'https://api.openai.com/v1');
    assert.equal(options.body.has('scope'), false);
    assert.equal(options.body.get('refresh_token'), calls === 1 ? 'synthetic-refresh-a' : 'synthetic-refresh-b');
    await new Promise(ok => setTimeout(ok, 5));
    return new Response(JSON.stringify({ ...initial, access_token: 'synthetic-access-b', refresh_token: 'synthetic-refresh-b' }));
  } });
  clock = 3500000;
  assert.deepEqual(await Promise.all([session.getAccessToken(), session.getAccessToken(), session.getAccessToken()]), Array(3).fill('synthetic-access-b'));
  assert.equal(calls, 1);
  clock += 3500000;
  await session.getAccessToken();
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(events).includes('synthetic'), false);
  session.close();
});

test('refresh failures expose only safe codes, never response credential text', async () => {
  let clock = 0;
  const session = createMemorySession({ tokenResponse: initial, clientId: 'oaiapp_test', now: () => clock, fetchImpl: async () => new Response('private synthetic-refresh-a error', { status: 401 }) });
  clock = 3500000;
  await assert.rejects(session.getAccessToken(), e => e.safeCode === 'session_refresh_http_401' && !e.message.includes('synthetic'));
  session.close();
  assert.throws(() => createMemorySession({ tokenResponse: initial, clientId: 'dynamic_agent_client' }), /issued_client/);
});
