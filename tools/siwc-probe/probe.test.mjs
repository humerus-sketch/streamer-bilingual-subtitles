import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { newAttempt, consumeCallback, verifyIdentity } from './probe.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
function token(claims = {}, header = {}) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'synthetic-test', exp: 2000, iat: 900, nonce: 'test-nonce', ...claims })).toString('base64url');
  return h + '.' + p + '.' + sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
}
const options = { clientId: 'oaiapp_test', nonce: 'test-nonce', jwks, now: 1000 };

test('PKCE challenge and random transactions', () => {
  const a = newAttempt('http://127.0.0.1:12345/auth/callback');
  const b = newAttempt(a.redirectUri);
  assert.notEqual(a.state, b.state); assert.notEqual(a.nonce, b.nonce);
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'));
});
test('callback requires state, issued client ID, one-time use and exact returning client', () => {
  const a = newAttempt('http://127.0.0.1:12345/auth/callback');
  const url = new URL(a.redirectUri + '?state=' + a.state + '&code=synthetic&client_id=oaiapp_test');
  assert.deepEqual(consumeCallback(url, a), { code: 'synthetic', clientId: 'oaiapp_test' });
  assert.throws(() => consumeCallback(url, a), /consumed/);
  const b = newAttempt(a.redirectUri, 'oaiapp_other'); url.searchParams.set('state', b.state);
  assert.throws(() => consumeCallback(url, b), /client_mismatch/);
});
test('callback rejects expired, mismatched, duplicate and denied callbacks', () => {
  for (const mutation of ['expired', 'state', 'duplicate', 'denied', 'missing_client']) {
    const a = newAttempt('http://127.0.0.1:12345/auth/callback');
    const u = new URL(a.redirectUri + '?state=' + a.state + '&code=synthetic&client_id=oaiapp_test');
    if (mutation === 'expired') a.expiresAt = 0;
    if (mutation === 'state') u.searchParams.set('state', 'wrong');
    if (mutation === 'duplicate') u.searchParams.append('code', 'other');
    if (mutation === 'denied') u.searchParams.set('error', 'access_denied');
    if (mutation === 'missing_client') u.searchParams.delete('client_id');
    assert.throws(() => consumeCallback(u, a), undefined, mutation);
  }
});
test('ID token valid signature and expected claims', () => {
  assert.equal(verifyIdentity(token(), options).subjectDigest, createHash('sha256').update('synthetic-test').digest('hex'));
});
test('ID token rejects tampering, wrong key, algorithm, issuer, audience, time, nonce and identity', () => {
  for (const claims of [{ iss: 'https://example.invalid' }, { aud: 'other' }, { azp: 'other' }, { exp: 990 }, { iat: 1020 }, { nbf: 1020 }, { nonce: 'wrong' }, { sub: '' }, { aud: ['oaiapp_test', 'other'] }]) assert.throws(() => verifyIdentity(token(claims), options));
  assert.throws(() => verifyIdentity(token({}, { alg: 'none' }), options), /algorithm/);
  assert.throws(() => verifyIdentity(token({}, { kid: 'unknown' }), options), /unknown_key/);
  const parts = token().split('.'); parts[1] = Buffer.from(JSON.stringify({ sub: 'tampered' })).toString('base64url');
  assert.throws(() => verifyIdentity(parts.join('.'), options), /signature/);
  assert.throws(() => verifyIdentity(token(), { ...options, subjectDigest: '0'.repeat(64) }), /account_changed/);
});

test('Codex account selection guard checks only signed email and rejects another account', () => {
  const expectedEmailSha256 = createHash('sha256').update('correct@example.invalid').digest('hex');
  const guarded = { ...options, expectedEmailSha256 };
  assert.doesNotThrow(() => verifyIdentity(token({ email: 'CORRECT@example.invalid' }), guarded));
  assert.throws(() => verifyIdentity(token({ email: 'other@example.invalid' }), guarded), /expected_codex_account_mismatch/);
  assert.throws(() => verifyIdentity(token(), guarded), /expected_codex_account_mismatch/);
  const parts = token({ email: 'other@example.invalid' }).split('.');
  parts[1] = Buffer.from(JSON.stringify({ email: 'correct@example.invalid' })).toString('base64url');
  assert.throws(() => verifyIdentity(parts.join('.'), guarded), /signature/);
});
