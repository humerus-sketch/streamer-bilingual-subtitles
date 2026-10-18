import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOtelObserver } from './otel-observer.mjs';

const attribute = (key, value) => ({ key, value });
const record = (event = 'codex.sse_event', attributes = []) => ({ timeUnixNano: '1720000000000000123',
  observedTimeUnixNano: '1720000000000000456', body: { stringValue: event }, attributes });
const batch = records => ({ resourceLogs: [{ resource: { attributes: [attribute('user.email', { stringValue: 'private@example.invalid' })] },
  scopeLogs: [{ scope: { name: 'private-scope-name', version: 'private-scope-version' }, logRecords: records }] }] });
function nativePost(endpoint, headers, chunks) {
  return new Promise((done, reject) => {
    const request = httpRequest(endpoint, { method: 'POST', headers }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => done({ status: response.statusCode, body: JSON.parse(body) })); response.on('error', reject);
    });
    request.on('error', reject); for (const chunk of chunks) request.write(chunk); request.end();
  });
}
async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'otel-observer-test-'));
  const observer = await createOtelObserver({ outputDirectory: directory });
  t.after(async () => { await observer.close(); await rm(directory, { recursive: true, force: true }); });
  const send = async (payload, options = {}) => {
    const response = await fetch(observer.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...observer.headers, ...options.headers },
      body: typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, observer, send };
}

test('OTLP JSON projection retains source timestamps and numeric transport metadata without payload or identities', async t => {
  const { directory, observer, send } = await harness(t);
  const capability = observer.headers['x-probe-capability'];
  const privateValues = ['private@example.invalid', 'Bearer private-credential', 'private-account-id',
    'private Japanese prompt', 'private translated sentence', 'private error detail', 'https://private.example/route', 'C:/private/file'];
  const event = record('codex.sse_event', [
    attribute('event.kind', { stringValue: 'response.completed' }), attribute('duration_ms', { doubleValue: 13.25 }),
    attribute('success', { boolValue: true }), attribute('input_tokens', { intValue: '6000' }),
    attribute('output_tokens', { intValue: '42' }), attribute('reasoning_tokens', { intValue: '91' }),
    ...['email', 'authorization', 'account.id', 'prompt', 'output', 'error', 'url', 'path'].map((key, index) => attribute(key, { stringValue: privateValues[index] })),
    attribute('unknown.numeric', { intValue: '1987654321' }), attribute('private@example.invalid', { stringValue: 'anything' }),
  ]);
  const result = await send(batch([event, record('codex.user_prompt', [attribute('prompt', { stringValue: 'private Japanese prompt' })])]));
  assert.equal(result.status, 200); assert.equal(observer.stats().projectedEvents, 1); assert.equal(observer.stats().recordsDropped, 1);
  assert.equal(observer.exporter['otlp-http'].protocol, 'json');
  const finished = await observer.close(); assert.equal(finished.closed, true); assert.equal(finished.accepting, false);
  const output = JSON.parse(await readFile(join(directory, 'otel-events.json'), 'utf8'));
  assert.deepEqual(output.events, [{ event: 'codex.sse_event', timeUnixNano: '1720000000000000123', observedTimeUnixNano: '1720000000000000456',
    fields: { duration_ms: 13.25, success: true, input_tokens: 6000, output_tokens: 42, reasoning_tokens: 91 }, kind: 'response.completed' }]);
  const saved = JSON.stringify([output, JSON.parse(await readFile(join(directory, 'otel-status.json'), 'utf8')), observer.stats()]);
  for (const value of [...privateValues, capability, observer.endpoint, '1987654321', 'private-scope-name', 'private-scope-version']) assert.equal(saved.includes(value), false);
  assert.ok(finished.unknownAttributeKeys.includes('unknown.numeric')); assert.equal(finished.attributeKeys.includes('private@example.invalid'), false);
  assert.equal(Object.hasOwn(output.events[0], 'receivedAt'), false);
  assert.equal(Object.hasOwn(output.events[0], 'collectorReceiveTime'), false);
});

test('collector rejects missing capability, wrong Origin, Host, method and path before accepting any records', async t => {
  const { observer, send } = await harness(t);
  assert.equal((await send(batch([record()]), { headers: { 'x-probe-capability': 'wrong' } })).status, 403);
  assert.equal((await send(batch([record()]), { headers: { origin: 'http://other.invalid' } })).status, 403);
  assert.equal((await nativePost(observer.endpoint, { ...observer.headers, host: 'other.invalid', 'content-type': 'application/json' }, [JSON.stringify(batch([record()]))])).status, 403);
  assert.equal((await fetch(observer.endpoint)).status, 403);
  assert.equal((await fetch(observer.endpoint + '/other', { method: 'POST', headers: observer.headers, body: '{}' })).status, 403);
  assert.equal(observer.stats().recordsAccepted, 0); assert.equal(observer.stats().rejectedRequests, 5);
});

test('malformed JSON, invalid UTF8, invalid OTLP shape and non-JSON bodies do not retain arbitrary content', async t => {
  const { directory, observer, send } = await harness(t);
  assert.equal((await send('{"private":"broken-secret"')).status, 400);
  assert.equal((await send(Buffer.from([0xc3, 0x28]))).status, 400);
  assert.equal((await send({ resourceLogs: [{ scopeLogs: [{ logRecords: 'private-wrong-shape' }] }] })).status, 400);
  assert.equal((await send('{}', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send('{}', { headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal(observer.stats().recordsAccepted, 0); assert.equal(observer.stats().malformedRequests, 3);
  await observer.close();
  assert.doesNotMatch(await readFile(join(directory, 'otel-status.json'), 'utf8'), /broken-secret|wrong-shape|c328/);
});

test('body over 2 MiB is explicitly rejected without a projected or retained payload', async t => {
  const { observer, send } = await harness(t);
  const result = await send('x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(result.status, 413); assert.equal(result.body.error, 'otel_observer_body_limit');
  assert.equal(observer.stats().oversizedRequests, 1); assert.equal(observer.stats().recordsAccepted, 0);
});

test('chunked bodies cannot bypass the body byte limit', async t => {
  const { observer } = await harness(t);
  const result = await nativePost(observer.endpoint, { ...observer.headers, 'content-type': 'application/json' },
    Array.from({ length: 33 }, () => 'x'.repeat(64 * 1024)));
  assert.equal(result.status, 413); assert.equal(result.body.error, 'otel_observer_body_limit');
  assert.equal(observer.stats().oversizedRequests, 1); assert.equal(observer.stats().recordsAccepted, 0);
});

test('record budget is lifetime bounded, rejects an overflowing batch atomically and marks overflow', async t => {
  const { directory, observer, send } = await harness(t);
  assert.equal((await send(batch(Array.from({ length: 4095 }, () => record('codex.api_request'))))).status, 200);
  const over = await send(batch([record(), record()]));
  assert.equal(over.status, 429); assert.equal(over.body.error, 'otel_observer_record_limit');
  assert.equal(observer.stats().recordsAccepted, 4095); assert.equal(observer.stats().projectedEvents, 4095);
  assert.equal(observer.stats().overflow, true); assert.equal(observer.stats().accepting, false);
  assert.equal((await send(batch([record()]))).status, 429);
  await observer.close();
  assert.equal(JSON.parse(await readFile(join(directory, 'otel-events.json'), 'utf8')).events.length, 4095);
});

test('event-name and kind projection is narrow and unknown string/numeric values cannot leak through known fields', async t => {
  const { directory, observer, send } = await harness(t);
  const events = [
    record('codex.sse_event', [attribute('kind', { stringValue: 'response.private_secret' }), attribute('duration_ms', { stringValue: 'private-duration' }),
      attribute('status_code', { intValue: '9007199254740992' }), attribute('attempt', { doubleValue: -1 }), attribute('success', { stringValue: 'private-success' })]),
    { ...record('not-allowed'), body: { stringValue: 'private body' }, attributes: [attribute('event.name', { stringValue: 'codex.websocket_event' }), attribute('event.kind', { stringValue: 'error' })] },
    record('codex.api_request', [attribute('event.name', { stringValue: 'codex.sse_event' })]),
    { ...record('codex.websocket_request'), timeUnixNano: 'private-id-as-time', observedTimeUnixNano: '2026-10-17T00:00:00Z' },
  ];
  assert.equal((await send(batch(events))).status, 200);
  await observer.close(); const output = JSON.parse(await readFile(join(directory, 'otel-events.json'), 'utf8'));
  assert.equal(output.events.length, 3); assert.deepEqual(output.events[0].fields, {}); assert.equal(output.events[0].kind, undefined);
  assert.equal(output.events[1].kind, 'error'); assert.equal(output.events[2].timeUnixNano, null); assert.equal(output.events[2].observedTimeUnixNano, null);
  assert.equal(observer.stats().ambiguousEventNames, 1); assert.equal(observer.stats().invalidTimestamps, 1);
  assert.doesNotMatch(JSON.stringify(output), /private|9007199254740992/);
});

test('allowlisted numeric tracing strings accept finite decimals and exponents without admitting text or invalid numbers', async t => {
  const { directory, observer, send } = await harness(t);
  const good = record('codex.api_request', [attribute('duration_ms', { stringValue: '1234.125' }),
    attribute('ttft_ms', { stringValue: '1.25e+3' }), attribute('input_token_count', { stringValue: '6500' }),
    attribute('output_token_count', { stringValue: '46' }), attribute('cache_write_token_count', { stringValue: '0' }),
    attribute('tool_token_count', { stringValue: '1e2' }), attribute('attempt', { stringValue: '1' }),
    attribute('unknown.count', { stringValue: '987654321' })]);
  const badValues = ['private-string-value', '123ms', '1 seconds', '-1', '+1', 'NaN', 'Infinity', '1e309',
    '9007199254740992', '1e-999', ' 42', '42 ', '.5', '1.', '0x10', '1e', '1_000'];
  const bad = badValues.map(value => record('codex.sse_event', [attribute('duration_ms', { stringValue: value })]));
  assert.equal((await send(batch([good, ...bad]))).status, 200);
  await observer.close(); const output = JSON.parse(await readFile(join(directory, 'otel-events.json'), 'utf8'));
  assert.deepEqual(output.events[0].fields, { duration_ms: 1234.125, ttft_ms: 1250, input_token_count: 6500,
    output_token_count: 46, cache_write_token_count: 0, tool_token_count: 100, attempt: 1 });
  assert.ok(output.events.slice(1).every(event => Object.keys(event.fields).length === 0));
  assert.doesNotMatch(JSON.stringify(output), /private-string-value|123ms|1 seconds|987654321|9007199254740992/);
});

test('zero OTLP timestamps are unset and never replace a valid separately reported observed timestamp', async t => {
  const { directory, observer, send } = await harness(t);
  const valid = '1720000000000000456';
  assert.equal((await send(batch([
    { ...record(), timeUnixNano: '0', observedTimeUnixNano: valid },
    { ...record(), timeUnixNano: '0000000000', observedTimeUnixNano: valid },
    { ...record(), timeUnixNano: valid, observedTimeUnixNano: '0' },
    { ...record(), timeUnixNano: valid, observedTimeUnixNano: '00000' },
  ]))).status, 200);
  await observer.close(); const output = JSON.parse(await readFile(join(directory, 'otel-events.json'), 'utf8'));
  assert.deepEqual(output.events.map(event => [event.timeUnixNano, event.observedTimeUnixNano]),
    [[null, valid], [null, valid], [valid, null], [valid, null]]);
  assert.equal(observer.stats().invalidTimestamps, 2);
});

test('attribute inventory and per-record attributes stay bounded, and repeated close saves once', async t => {
  const { directory, observer, send } = await harness(t);
  const key = index => 'unknown.' + String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + index % 26);
  const entries = Array.from({ length: 4 }, (_, index) => record('codex.sse_event', Array.from({ length: 128 }, (x, offset) => attribute(key(index * 128 + offset), { stringValue: 'private-value' }))));
  entries.push(record('codex.sse_event', Array.from({ length: 160 }, () => attribute('duplicate', { stringValue: 'never-save' }))));
  assert.equal((await send(batch(entries))).status, 200);
  assert.equal(observer.stats().attributeKeys.length, 256); assert.ok(observer.stats().attributeKeysOmitted > 0);
  assert.equal(observer.stats().attributesTruncated, 32);
  const first = observer.close(), second = observer.close(); assert.equal(first, second); await first;
  assert.doesNotMatch(await readFile(join(directory, 'otel-events.json'), 'utf8'), /private-value|never-save/);
});

test('close terminates a partial authorized body instead of waiting indefinitely for exporter EOF', async t => {
  const { observer } = await harness(t);
  const request = httpRequest(observer.endpoint, { method: 'POST', headers: { ...observer.headers, 'content-type': 'application/json', 'content-length': '10000' } });
  request.on('error', () => {}); request.write('{');
  await new Promise(done => request.once('socket', socket => socket.once('connect', done)));
  for (let i = 0; i < 100 && observer.stats().requests === 0; i++) await new Promise(done => setTimeout(done, 5));
  assert.equal(observer.stats().requests, 1);
  const began = performance.now(); await observer.close();
  assert.ok(performance.now() - began < 2000); assert.equal(observer.stats().closed, true); request.destroy();
});
