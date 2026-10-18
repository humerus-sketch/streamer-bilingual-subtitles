import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels, parseSSE, parseBilingual, runTranslation, statistics, supportedEfforts } from './inference.mjs';

const encoder = new TextEncoder();
function stream(chunks) {
  return new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)); controller.close(); } });
}
function sse(event) { return `data: ${JSON.stringify(event)}\r\n\r\n`; }
const model = { slug: 'gpt-test', display_name: 'Test' };
const fixture = { id: '03', ja: 'できなくはない。', context: '' };
function response(chunks, status = 200) {
  return new Response(stream(chunks), { status, headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_synthetic' } });
}

test('SSE handles byte-split UTF-8, CRLF, multiline data, comments and trailing event', async () => {
  const input = encoder.encode(': keepalive\r\ndata: {"type":"test",\r\ndata: "text":"日本語"}\r\n\r\ndata: [DONE]');
  const chunks = [...input].map(byte => Uint8Array.of(byte));
  const events = [];
  for await (const value of parseSSE(stream(chunks))) events.push(value);
  assert.equal(events.length, 2);
  assert.deepEqual(JSON.parse(events[0]), { type: 'test', text: '日本語' });
  assert.equal(events[1], '[DONE]');
});

test('SSE enforces byte limit and cancels reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: oversized\n\n')); }, cancel() { cancelled = true; } });
  await assert.rejects(async () => { for await (const _ of parseSSE(body, { maxBytes: 4 })) {} }, /limit/);
  assert.equal(cancelled, true);
});

test('strict bilingual JSON rejects markdown, extra keys, blanks and malformed output', () => {
  assert.deepEqual(parseBilingual(' {"zh":"中文","en":"English"} '), { zh: '中文', en: 'English' });
  for (const input of ['```json\n{}\n```', '{"zh":"中","en":" "}', '{"zh":"中","en":"E","note":1}', '{}', 'null', '[]', '{']) assert.equal(parseBilingual(input), null);
});

test('catalog preserves list visibility order and supported reasoning fields without account fields', async () => {
  const catalog = await listModels('synthetic-token', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ account: 'do-not-save', models: [
      { slug: 'z', display_name: 'Z', visibility: 'list', supported_reasoning_efforts: ['low', 'high'], account_id: 'do-not-save' },
      { slug: 'hidden', visibility: 'hide' },
      { slug: 'a', display_name: 'A', visibility: 'list', reasoning: { supported_efforts: ['minimal', 'medium'], account_id: 'do-not-save' } },
    ] }), { status: 200 });
  } });
  assert.deepEqual(catalog.models.map(item => item.slug), ['z', 'a']);
  assert.equal(catalog.excluded_not_list_count, 1);
  assert.equal(JSON.stringify(catalog).includes('do-not-save'), false);
  assert.deepEqual(supportedEfforts(catalog.models[0]), ['low', 'high']);
  assert.deepEqual(supportedEfforts(catalog.models[1]), ['minimal', 'medium']);
});

test('generic API-key model shape is not treated as a SIWC account catalog', async () => {
  await assert.rejects(listModels('synthetic-token', { fetchImpl: async () => new Response('{"data": [{"id":"gpt-test"}]}') }), error => error.code === 'unexpected_catalog_shape');
});

test('catalog error exposes a safeCode and sanitized artifact for the caller to save', async () => {
  await assert.rejects(listModels('synthetic-token', { fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'permission_denied', message: 'Bearer synthetic-token denied', param: null } }), { status: 403, headers: { 'x-request-id': 'req_denied' } }) }), error => {
    assert.equal(error.safeCode, 'permission_denied');
    assert.equal(error.safeArtifact.http_status, 403);
    assert.equal(error.safeArtifact.request_id, 'req_denied');
    assert.equal(JSON.stringify(error.safeArtifact).includes('synthetic-token'), false);
    return true;
  });
});

test('a default reasoning effort alone never establishes supported request values', () => {
  assert.deepEqual(supportedEfforts({ reasoning: { effort: 'high', default_effort: 'high' } }), []);
  assert.deepEqual(supportedEfforts({ reasoningEffortOptions: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }), ['low', 'medium']);
});

test('direct request records distinct stream times and succeeds only at response.completed', async () => {
  let clock = 0;
  const events = [];
  const result = await runTranslation({ accessToken: 'synthetic-token', model: { ...model, supported_reasoning_efforts: ['low', 'high'] }, fixture,
    now: () => clock++, onEvent: event => events.push(event),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.deepEqual(body.reasoning, { effort: 'low' });
      assert.equal(body.tools, undefined);
      return response([
        sse({ type: 'response.created', response: { id: 'resp_synthetic', model: 'gpt-test-revision' } }),
        sse({ type: 'response.output_text.delta', delta: '   ' }),
        sse({ type: 'response.output_text.delta', delta: '{"zh":"并非做不到",' }),
        sse({ type: 'response.output_text.delta', delta: '"en":"It is not impossible."}' }),
        sse({ type: 'response.completed', response: { id: 'resp_synthetic', model: 'gpt-test-revision', status: 'completed', usage: { input_tokens: 4, output_tokens: 8, account_id: 'do-not-save' } } }),
        'data: [DONE]\n\n',
      ]);
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.terminal_event, 'response.completed');
  assert.deepEqual(result.translation, { zh: '并非做不到', en: 'It is not impossible.' });
  assert.ok(result.timings_ms.headers < result.timings_ms.first_nonempty_delta);
  assert.ok(result.timings_ms.first_nonempty_delta < result.timings_ms.bilingual_json_ready);
  assert.ok(result.timings_ms.bilingual_json_ready < result.timings_ms.completed);
  assert.ok(result.timings_ms.completed < result.timings_ms.total);
  assert.equal(result.response_model, 'gpt-test-revision');
  assert.equal(JSON.stringify(result).includes('synthetic-token'), false);
  assert.equal(JSON.stringify(result).includes('do-not-save'), false);
  assert.equal(events.find(item => item.type === 'response.completed').usage.output_tokens, 8);
});

test('no reasoning parameter is guessed when the catalog has no supported values', async () => {
  const result = await runTranslation({ accessToken: 'synthetic-token', model, fixture, fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).reasoning, undefined);
    return response([sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"zh":"中","en":"E"}' }] }] } })]);
  } });
  assert.equal(result.success, true);
  assert.equal(result.reasoning_policy, 'server_default');
});

test('valid text without response.completed is never a successful inference', async () => {
  for (const ending of ['', 'data: [DONE]\n\n']) {
    const result = await runTranslation({ accessToken: 'synthetic-token', model, fixture, fetchImpl: async () => response([sse({ type: 'response.output_text.delta', delta: '{"zh":"中","en":"E"}' }), ending]) });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'missing_response_completed');
    assert.equal(result.timings_ms.completed, null);
  }
});

test('completed event with malformed bilingual JSON remains a failed sample', async () => {
  const result = await runTranslation({ accessToken: 'synthetic-token', model, fixture, fetchImpl: async () => response([sse({ type: 'response.output_text.delta', delta: '{"zh":"中"}' }), sse({ type: 'response.completed', response: { status: 'completed' } })]) });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'invalid_bilingual_json');
  assert.notEqual(result.timings_ms.completed, null);
});

test('HTTP and streamed failure errors are sanitized; there is no retry', async () => {
  let calls = 0;
  const result = await runTranslation({ accessToken: 'synthetic-token', model, fixture, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'denied', message: 'Bearer synthetic-token is invalid', param: 'model' } }), { status: 403, headers: { 'x-request-id': 'req_denied' } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.http_status, 403);
  assert.equal(result.error.code, 'denied');
  assert.equal(result.request_id, 'req_denied');
  assert.equal(JSON.stringify(result).includes('synthetic-token'), false);
  const failure = await runTranslation({ accessToken: 'synthetic-token', model, fixture, fetchImpl: async () => response([sse({ type: 'response.failed', response: { status: 'failed', error: { code: 'invalid_request', message: 'no' } } })]) });
  assert.equal(failure.success, false);
  assert.equal(failure.error.code, 'invalid_request');
  const incomplete = await runTranslation({ accessToken: 'synthetic-token', model, fixture, fetchImpl: async () => response([sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })]) });
  assert.equal(incomplete.error.code, 'response_incomplete');
});

test('stream exceeding byte budget cannot succeed and is cancelled', async () => {
  const result = await runTranslation({ accessToken: 'synthetic-token', model, fixture, maxBytes: 8, fetchImpl: async () => response([sse({ type: 'response.completed' })]) });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'output_limit_exceeded');
});

test('detail-only HTTP errors retain diagnostics and event logs omit text fragments', async () => {
  const denied = await runTranslation({ accessToken: 'synthetic-token', model, fixture, fetchImpl: async () => new Response('{"detail":"Access denied for synthetic-token"}', { status: 403 }) });
  assert.equal(denied.error.message, 'Access denied for [REDACTED]');
  const events = [];
  const result = await runTranslation({ accessToken: 'synthetic-token', model, fixture, onEvent: e => events.push(e), fetchImpl: async () => response([
    sse({ type: 'response.output_text.delta', delta: '{"zh":"synthetic-' }),
    sse({ type: 'response.output_text.delta', delta: 'token","en":"E"}' }),
    sse({ type: 'response.completed', response: { status: 'completed' } }),
  ]) });
  assert.equal(result.success, true);
  assert.equal(JSON.stringify(result).includes('synthetic-token'), false);
  assert.ok(events.filter(e => e.type.endsWith('.delta')).every(e => e.delta === undefined && e.delta_chars > 0));
});

test('abort timeout is recorded as failure without retry', async () => {
  let calls = 0;
  const result = await runTranslation({ accessToken: 'synthetic-token', model, fixture, timeoutMs: 5,
    fetchImpl: async (_, options) => {
      calls++;
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.final_status, 'timeout');
  assert.equal(result.error.code, 'request_timeout');
});

test('timeout also cancels an idle response stream after HTTP headers', async () => {
  let cancelled = false;
  const result = await runTranslation({ accessToken: 'synthetic-token', model, fixture, timeoutMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 }),
  });
  assert.equal(result.final_status, 'timeout');
  assert.equal(result.error.code, 'request_timeout');
  assert.equal(cancelled, true);
});

test('small sample statistics report only n/min/median/max', () => {
  assert.deepEqual(statistics([9, 1, 3, null]), { n: 3, min: 1, median: 3, max: 9 });
  assert.deepEqual(statistics([8, 2]), { n: 2, min: 2, median: 5, max: 8 });
  assert.deepEqual(statistics([]), { n: 0, min: null, median: null, max: null });
});

test('benchmark reference translations and private checkpoints never enter actual request input', async () => {
  await runTranslation({ accessToken: 'synthetic-token', model, fixture: { ...fixture, reference: { zh: 'PRIVATE_REFERENCE_ZH', en: 'PRIVATE_REFERENCE_EN' }, checkpoints: ['PRIVATE_CHECKPOINT'] }, fetchImpl: async (_, options) => {
    assert.equal(options.body.includes('PRIVATE_'), false);
    assert.deepEqual(JSON.parse(JSON.parse(options.body).input[0].content), { ja: fixture.ja, context: '' });
    return response([sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"zh":"中","en":"E"}' }] }] } })]);
  } });
});
