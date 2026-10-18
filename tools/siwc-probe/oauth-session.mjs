const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';

function fail(code) { throw Object.assign(new Error(code), { safeCode: code }); }

/** One process owns and rotates this session. No credentials are persisted or returned in diagnostics. */
export function createMemorySession({ tokenResponse, clientId, fetchImpl = fetch, now = Date.now, onEvent = () => {} }) {
  let current = null;
  let pending = null;
  let closed = false;
  let refreshCount = 0;
  function accept(data, isRefresh = false) {
    if (!data || typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token)
      || String(data.token_type).toLowerCase() !== 'bearer'
      || !Number.isFinite(data.expires_in) || data.expires_in <= 120) fail('session_token_response_invalid');
    if (typeof data.scope === 'string' && !data.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) fail('session_scope_missing');
    if (isRefresh && (typeof data.refresh_token !== 'string' || !data.refresh_token)) fail('session_refresh_replacement_missing');
    current = { access: data.access_token, refresh: typeof data.refresh_token === 'string' ? data.refresh_token : null, expires: now() + data.expires_in * 1000 };
  }
  if (!clientId || clientId === 'dynamic_agent_client') fail('session_issued_client_required');
  accept(tokenResponse);
  async function refresh() {
    if (!current?.refresh) fail('session_reauthorization_required');
    onEvent({ event: 'session_refresh_started', refreshCount: refreshCount + 1 });
    let response;
    try {
      response = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: current.refresh, resource: RESOURCE }),
      });
    } catch { fail('session_refresh_network_error'); }
    if (!response.ok) fail('session_refresh_http_' + response.status);
    let data;
    try { data = await response.json(); } catch { fail('session_refresh_invalid_json'); }
    if (closed) fail('session_closed');
    accept(data, true);
    refreshCount++;
    onEvent({ event: 'session_refreshed', refreshCount });
  }
  return {
    async getAccessToken() {
      if (closed) fail('session_closed');
      if (current.expires - now() <= 120000) {
        // Serialize token rotation even if a future caller requests access concurrently.
        if (!pending) pending = refresh().finally(() => { pending = null; });
        await pending;
      }
      if (closed) fail('session_closed');
      return current.access;
    },
    close() { closed = true; current = null; },
    diagnostics() { return { tokenStorage: 'memory only', closed, refreshCount }; },
  };
}
