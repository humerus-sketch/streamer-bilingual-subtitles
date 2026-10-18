import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runTranslation } from '../siwc-probe/inference.mjs';
import { MAX_OBSERVATION_EVENTS, runObservedTranslation } from './translation-telemetry.mjs';

const model = { slug: 'gpt-6.1-sol', display_name: 'Test' };
const fixture = { id: 'telemetry-test', ja: 'まだ配信していません。', context: 'The current speaker is the livestream host.' };
const accessToken = 'synthetic-credential-must-not-be-saved';
const encoder = new TextEncoder();
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const sse = event => 'data: ' + JSON.stringify(event) + '\n\n';
const completed = (output = '{"zh":"还没直播。","en":"The stream has not started."}', usage) => ({
  type: 'response.completed', response: { id: 'resp_test', model: 'gpt-6.1-sol', status: 'completed', usage,
    output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] },
});
function response(events, headers = {}) {
  return new Response(new ReadableStream({ start(controller) {
    events.forEach(event => controller.enqueue(encoder.encode(sse(event)))); controller.close();
  } }), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_test', ...headers } });
}

test('wrapper sends the exact original request body and preserves server-default reasoning and completion', async () => {
  const sent = [], observedEvents = [], summaries = [];
  const usage = { input_tokens: 12, output_tokens: 15, total_tokens: 27,
    input_tokens_details: { cached_tokens: 4, private: accessToken },
    output_tokens_details: { reasoning_tokens: 0, private: accessToken }, private: accessToken };
  const events = [{ type: 'response.created' }, { type: 'response.in_progress' },
    { type: 'response.output_text.delta', delta: '{"zh":"还没直播。","en":"The stream has not started."}' }, completed(undefined, usage)];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: init.body, method: init.method, redirect: init.redirect });
    assert.equal(init.headers.Authorization, 'Bearer ' + accessToken);
    return response(events, { 'openai-processing-ms': ' 123.45 ', 'x-envoy-upstream-service-time': '234',
      'set-cookie': accessToken, authorization: 'Bearer ' + accessToken, 'x-secret': accessToken });
  };
  const original = await runTranslation({ accessToken, model, fixture, fetchImpl });
  const wrapped = await runObservedTranslation({ accessToken, model, fixture, fetchImpl,
    onEvent: event => observedEvents.push(event), observer: summary => summaries.push(summary) });
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(wrapped.request, original.request);
  assert.deepEqual(wrapped.translation, original.translation);
  assert.equal(wrapped.success, true); assert.equal(wrapped.terminal_event, 'response.completed');
  assert.equal(wrapped.reasoning_policy, 'server_default'); assert.equal(wrapped.request.reasoning, undefined);
  const t = wrapped.telemetry;
  assert.equal(t.request.body_sha256, digest(sent[1].body));
  assert.equal(t.request.body_bytes, Buffer.byteLength(sent[1].body));
  assert.equal(t.request.input_sha256, digest(JSON.stringify(wrapped.request.input)));
  assert.equal(t.request.instructions_sha256, digest(wrapped.request.instructions));
  assert.equal(t.request.ja_sha256, digest(fixture.ja));
  assert.equal(t.request.ja_chars, [...fixture.ja].length);
  assert.deepEqual(t.usage, { input_tokens: 12, output_tokens: 15, total_tokens: 27,
    input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 } });
  assert.deepEqual(t.processing_headers_ms, { 'openai-processing-ms': 123.45, 'x-envoy-upstream-service-time': 234 });
  assert.equal(t.http_status, 200); assert.equal(t.request_id, 'req_test');
  assert.equal(t.event_counts['response.created'], 1); assert.equal(t.event_counts['response.completed'], 1);
  assert.equal(t.event_first_ms['response.completed'], wrapped.timings_ms.completed);
  assert.equal(observedEvents.length, events.length + 1); assert.equal(summaries.length, 1);
  assert.equal(JSON.stringify(t).includes(accessToken), false);
  assert.equal(JSON.stringify(t).includes(fixture.ja), false);
  assert.equal(JSON.stringify(t).includes(fixture.context), false);
  assert.equal(JSON.stringify(t).includes('set-cookie'), false);
});

test('valid streamed JSON without completed remains interrupted and invalid completed JSON never succeeds', async () => {
  const partial = await runObservedTranslation({ accessToken, model, fixture, fetchImpl: async () => response([
    { type: 'response.output_text.delta', delta: '{"zh":"中","en":"E"}' },
  ]) });
  assert.equal(partial.success, false); assert.equal(partial.final_status, 'interrupted');
  assert.equal(partial.telemetry.terminal_event, null); assert.notEqual(partial.timings_ms.bilingual_json_ready, null);
  for (const invalid of ['{"zh":"中","en":" "}', '{"zh":"中","en":"E","note":1}', '{}']) {
    const result = await runObservedTranslation({ accessToken, model, fixture, fetchImpl: async () => response([completed(invalid)]) });
    assert.equal(result.success, false); assert.equal(result.telemetry.success, false);
    assert.equal(result.error.code, 'invalid_bilingual_json');
  }
});

test('missing usage and missing or invalid processing headers remain unknown', async () => {
  const result = await runObservedTranslation({ accessToken, model, fixture, fetchImpl: async () => response([completed()], {
    'openai-processing-ms': accessToken, 'x-envoy-upstream-service-time': '-1',
  }) });
  assert.equal(result.success, true); assert.equal(result.telemetry.usage, null);
  assert.deepEqual(result.telemetry.processing_headers_ms, {});
});

test('event samples are bounded while counts and final event milestones remain exact', async () => {
  const deltas = Array.from({ length: MAX_OBSERVATION_EVENTS + 50 }, () => ({ type: 'response.output_text.delta', delta: ' ' }));
  const result = await runObservedTranslation({ accessToken, model, fixture,
    fetchImpl: async () => response([...deltas, completed()]) });
  const t = result.telemetry;
  assert.equal(result.success, true); assert.equal(t.events.length, MAX_OBSERVATION_EVENTS);
  assert.equal(t.event_counts['response.output_text.delta'], deltas.length);
  assert.equal(t.event_counts['response.completed'], 1);
  assert.equal(t.events_observed, deltas.length + 2);
  assert.equal(t.events_omitted, deltas.length + 2 - MAX_OBSERVATION_EVENTS);
  assert.equal(t.event_last_ms['response.completed'], result.timings_ms.completed);
  assert.equal(t.terminal_event, 'response.completed');
});

test('observer exceptions and mutations cannot alter translation or returned telemetry', async () => {
  const result = await runObservedTranslation({ accessToken, model, fixture, fetchImpl: async () => response([completed()]),
    observer: summary => { summary.success = false; summary.request.model = 'changed'; throw new Error(accessToken); } });
  assert.equal(result.success, true); assert.equal(result.telemetry.success, true);
  assert.equal(result.telemetry.request.model, model.slug);
  assert.equal(JSON.stringify(result).includes(accessToken), false);
});

test('HTTP failures retain the original failure outcome without collecting arbitrary headers or errors', async () => {
  const result = await runObservedTranslation({ accessToken, model, fixture, fetchImpl: async () =>
    new Response(JSON.stringify({ error: { code: 'permission_denied', message: 'Bearer ' + accessToken } }),
      { status: 403, headers: { 'x-request-id': accessToken, 'set-cookie': accessToken } }) });
  assert.equal(result.success, false); assert.equal(result.final_status, 'http_error');
  assert.equal(result.telemetry.http_status, 403); assert.equal(result.telemetry.request_id, null);
  assert.equal(result.telemetry.usage, null); assert.equal(result.telemetry.terminal_event, null);
  assert.equal(JSON.stringify(result.telemetry).includes(accessToken), false);
});

test('async observer rejection is handled without waiting or affecting completion', async () => {
  let finishObservation;
  const pending = new Promise((_, reject) => { finishObservation = reject; });
  const result = await runObservedTranslation({ accessToken, model, fixture,
    fetchImpl: async () => response([completed()]), observer: () => pending });
  assert.equal(result.success, true);
  finishObservation(new Error(accessToken));
  await new Promise(resolve => setImmediate(resolve));
});

test('byte-split UTF-8 and pull/cancel behavior match the historical parser without added reads', async () => {
  const bytes = encoder.encode(sse(completed()) + 'data: [DONE]\n\n');
  const traces = [], results = [];
  for (const run of [runTranslation, runObservedTranslation]) {
    const trace = { pulls: 0, cancels: [] };
    const body = new ReadableStream({
      pull(controller) {
        const index = trace.pulls++;
        if (index < bytes.length) controller.enqueue(bytes.slice(index, index + 1));
        else controller.close();
      }, cancel(reason) { trace.cancels.push(reason); },
    }, { highWaterMark: 0 });
    assert.equal(trace.pulls, 0); assert.equal(body.locked, false);
    const rawResponse = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    results.push(await run({ accessToken, model, fixture, fetchImpl: async () => {
      assert.equal(trace.pulls, 0); assert.equal(body.locked, false);
      return rawResponse;
    } }));
    assert.equal(rawResponse.bodyUsed, true); traces.push(trace);
  }
  assert.deepEqual(results[1].translation, results[0].translation);
  assert.deepEqual(traces[1], traces[0]); assert.deepEqual(traces[1].cancels, [undefined]);
  const reads = results[1].telemetry.body_read;
  assert.equal(reads.read_calls, traces[1].pulls); assert.equal(reads.nonempty_chunks, reads.read_calls);
  assert.equal(reads.bytes, reads.read_calls); assert.equal(reads.cancel_calls, 1);
  assert.equal(reads.reader_acquisitions, 1); assert.equal(reads.eof_elapsed_ms, null);
  assert.notEqual(reads.first_chunk_elapsed_ms, null);
});

test('first body chunk is measured separately from first parsed event and read wait', async () => {
  let clock = 0, index = 0;
  const chunks = [': keepalive\n\n', sse({ type: 'response.created' }), sse(completed())];
  const body = new ReadableStream({ pull(controller) {
    clock += 25;
    if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++])); else controller.close();
  } }, { highWaterMark: 0 });
  const result = await runObservedTranslation({ accessToken, model, fixture, now: () => clock,
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  const reads = result.telemetry.body_read;
  assert.equal(reads.first_chunk_elapsed_ms, 25);
  assert.equal(result.telemetry.event_first_ms['response.created'], 50);
  assert.equal(reads.first_chunk_to_first_observed_response_event_ms, 25);
  assert.equal(result.timings_ms.completed, 75); assert.equal(reads.max_read_wait_ms, 25);
  assert.equal(reads.nonempty_chunks, 3); assert.equal(reads.bytes, Buffer.byteLength(chunks.join('')));
});

test('body stream errors preserve failure code without recording error text or changing cancellation', async () => {
  const results = [], traces = [];
  for (const run of [runTranslation, runObservedTranslation]) {
    let pulls = 0, cancels = 0;
    const body = new ReadableStream({ pull(controller) {
      if (!pulls++) controller.enqueue(encoder.encode(sse({ type: 'response.created' })));
      else controller.error(Object.assign(new Error(accessToken), { code: 'synthetic_stream_error' }));
    }, cancel() { cancels++; } }, { highWaterMark: 0 });
    results.push(await run({ accessToken, model, fixture, fetchImpl: async () => new Response(body) }));
    traces.push({ pulls, cancels });
  }
  assert.deepEqual(traces[1], traces[0]);
  assert.equal(results[1].success, false); assert.equal(results[1].final_status, results[0].final_status);
  assert.equal(results[1].error.code, results[0].error.code);
  assert.equal(results[1].telemetry.body_read.read_errors, 1);
  assert.notEqual(results[1].telemetry.body_read.first_read_error_elapsed_ms, null);
  assert.equal(JSON.stringify(results[1].telemetry).includes(accessToken), false);
});

test('abort of an idle body preserves timeout and original underlying cancellation behavior', async () => {
  const results = [], cancels = [];
  for (const run of [runTranslation, runObservedTranslation]) {
    const reasons = [];
    const body = new ReadableStream({ cancel(reason) { reasons.push(reason); } }, { highWaterMark: 0 });
    results.push(await run({ accessToken, model, fixture, timeoutMs: 10,
      fetchImpl: async () => new Response(body) }));
    cancels.push(reasons);
  }
  assert.deepEqual(cancels[1], cancels[0]); assert.deepEqual(cancels[1], [undefined]);
  assert.equal(results[1].success, false); assert.equal(results[1].final_status, 'timeout');
  assert.equal(results[1].error.code, results[0].error.code);
  const reads = results[1].telemetry.body_read;
  assert.equal(reads.nonempty_chunks, 0); assert.equal(reads.first_chunk_elapsed_ms, null);
  assert.equal(reads.cancel_calls, 1); assert.equal(reads.eof_elapsed_ms, null);
});
