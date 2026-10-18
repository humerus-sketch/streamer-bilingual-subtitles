import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Official support: https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry
// OTLP receive times are deliberately excluded: Codex batches exports asynchronously.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 4096;
const MAX_ATTRIBUTES = 128;
const MAX_ATTRIBUTE_KEYS = 256;
const HEADER = 'x-probe-capability';
const EVENTS = new Set(['codex.api_request', 'codex.sse_event', 'codex.websocket_request', 'codex.websocket_event']);
const EVENT_NAME_KEYS = new Set(['event.name', 'event_name', 'name']);
const KIND_KEYS = new Set(['event.kind', 'event_kind', 'kind', 'event.type', 'event_type']);
const BOOLEAN_KEYS = new Set(['success', 'request.success', 'response.success', 'event.success']);
const NUMERIC_KEYS = new Set([
  'duration_ms', 'duration', 'elapsed_ms', 'ttft_ms', 'request.duration_ms', 'response.duration_ms', 'event.duration_ms',
  'attempt', 'attempt_number', 'request.attempt', 'status', 'status_code', 'http.status_code', 'http.response.status_code',
  'input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'cached_input_tokens', 'reasoning_tokens', 'reasoning_output_tokens',
  'input_token_count', 'output_token_count', 'total_token_count', 'cached_token_count', 'cached_input_token_count',
  'reasoning_token_count', 'reasoning_output_token_count', 'cache_write_token_count', 'tool_token_count', 'token_count',
  'token.input', 'token.output', 'token.total', 'token.cached_input', 'token.reasoning_output',
  'usage.input_tokens', 'usage.output_tokens', 'usage.total_tokens', 'usage.cached_input_tokens', 'usage.reasoning_output_tokens',
]);
// Known protocol event identifiers only; an arbitrary error/string is never a kind.
const KINDS = new Set(['error', ...[
  'created', 'queued', 'in_progress', 'completed', 'failed', 'incomplete',
  'output_item.added', 'output_item.done', 'content_part.added', 'content_part.done',
  'output_text.delta', 'output_text.done', 'refusal.delta', 'refusal.done',
  'reasoning_summary_part.added', 'reasoning_summary_part.done', 'reasoning_summary_text.delta', 'reasoning_summary_text.done',
  'reasoning_text.delta', 'reasoning_text.done', 'function_call_arguments.delta', 'function_call_arguments.done',
].map(value => 'response.' + value)]);
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeError = code => Object.assign(new Error(code), { safeCode: code });
// OTLP zero means the timestamp is unset. Preserve observed time separately; never invent event time.
const timestamp = value => typeof value === 'string' && /^[0-9]{1,30}$/.test(value) && /[1-9]/.test(value) ? value : null;
// The inventory is names, never values. Exclude dynamically numbered keys, paths, addresses and lengthy names.
const safeAttributeKey = value => typeof value === 'string' && /^[a-z][a-z_.]{0,63}$/.test(value);
const recognizedKey = value => EVENT_NAME_KEYS.has(value) || KIND_KEYS.has(value) || BOOLEAN_KEYS.has(value) || NUMERIC_KEYS.has(value);
function secretMatches(value, expected) {
  if (typeof value !== 'string') return false;
  const left = Buffer.from(value), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function numberValue(value) {
  if (!plain(value)) return null;
  let candidate = value.doubleValue;
  if (typeof value.stringValue === 'string') {
    // Rust tracing can encode a numeric field as an OTLP string. Accept numeric syntax only,
    // never units, whitespace, leading signs, arbitrary errors, or a value outside the finite bound.
    if (!/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,12})?(?:[eE][+-]?[0-9]{1,3})?$/.test(value.stringValue)) return null;
    candidate = Number(value.stringValue);
    if (candidate === 0 && /[1-9]/.test(value.stringValue.split(/[eE]/)[0])) return null;
  } else if (typeof value.intValue === 'string' && /^[0-9]{1,16}$/.test(value.intValue)) candidate = Number(value.intValue);
  else if (typeof value.intValue === 'number' && Number.isSafeInteger(value.intValue)) candidate = value.intValue;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 && candidate <= Number.MAX_SAFE_INTEGER ? candidate : null;
}
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', Connection: 'close' });
  response.end(JSON.stringify(value));
}

/**
 * Optional loopback-only OTLP/HTTP JSON sink. The endpoint/header/exporter properties contain
 * a capability for the calling adapter only: never serialize the returned object into evidence.
 * Only a narrow projection is retained; no resource/scope values or arbitrary error text survive.
 */
export async function createOtelObserver({ outputDirectory } = {}) {
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) throw safeError('invalid_otel_observer_options');
  const output = resolve(outputDirectory);
  try { await mkdir(output, { recursive: true }); } catch { throw safeError('otel_observer_output_unavailable'); }
  const capability = randomBytes(32).toString('base64url');
  const projected = [], attributeKeys = new Set(), unknownAttributeKeys = new Set();
  const eventCounts = Object.fromEntries([...EVENTS].map(name => [name, 0]));
  const counters = { requests: 0, acceptedBatches: 0, rejectedRequests: 0, malformedRequests: 0,
    oversizedRequests: 0, overflowRequests: 0, recordsAccepted: 0, recordsDropped: 0,
    attributesTruncated: 0, attributeKeysOmitted: 0, invalidTimestamps: 0, ambiguousEventNames: 0 };
  let closing = false, closed = false, overflow = false, closePromise = null, expectedHost;
  function inventory(key) {
    if (!safeAttributeKey(key)) return;
    if (attributeKeys.has(key)) return;
    if (attributeKeys.size >= MAX_ATTRIBUTE_KEYS) { counters.attributeKeysOmitted++; return; }
    attributeKeys.add(key);
    if (!recognizedKey(key)) unknownAttributeKeys.add(key);
  }
  function project(record) {
    if (!plain(record)) return null;
    const attributes = Array.isArray(record.attributes) ? record.attributes : [];
    const names = new Set(), fields = {}, kinds = new Set();
    if (EVENTS.has(record.eventName)) names.add(record.eventName);
    if (EVENTS.has(record.body?.stringValue)) names.add(record.body.stringValue);
    if (attributes.length > MAX_ATTRIBUTES) counters.attributesTruncated += attributes.length - MAX_ATTRIBUTES;
    for (const attribute of attributes.slice(0, MAX_ATTRIBUTES)) {
      if (!plain(attribute) || typeof attribute.key !== 'string') continue;
      const key = attribute.key, value = attribute.value;
      inventory(key);
      if (EVENT_NAME_KEYS.has(key)) { if (EVENTS.has(value?.stringValue)) names.add(value.stringValue); continue; }
      if (KIND_KEYS.has(key)) { if (KINDS.has(value?.stringValue)) kinds.add(value.stringValue); continue; }
      if (BOOLEAN_KEYS.has(key)) { if (typeof value?.boolValue === 'boolean') fields[key] = value.boolValue; continue; }
      if (NUMERIC_KEYS.has(key)) { const number = numberValue(value); if (number !== null) fields[key] = number; }
    }
    if (names.size !== 1) { if (names.size > 1) counters.ambiguousEventNames++; return null; }
    const timeUnixNano = timestamp(record.timeUnixNano), observedTimeUnixNano = timestamp(record.observedTimeUnixNano);
    if (timeUnixNano === null) counters.invalidTimestamps++;
    const event = { event: [...names][0], timeUnixNano, observedTimeUnixNano, fields };
    if (kinds.size === 1) event.kind = [...kinds][0];
    eventCounts[event.event]++; return event;
  }
  function recordsFrom(payload, available) {
    if (!plain(payload) || !Array.isArray(payload.resourceLogs)) throw safeError('invalid_otlp_logs');
    const records = [];
    for (const resource of payload.resourceLogs) {
      if (!plain(resource) || !Array.isArray(resource.scopeLogs)) throw safeError('invalid_otlp_logs');
      for (const scope of resource.scopeLogs) {
        if (!plain(scope) || !Array.isArray(scope.logRecords)) throw safeError('invalid_otlp_logs');
        for (const record of scope.logRecords) {
          records.push(record);
          if (records.length > available) return null;
        }
      }
    }
    return records;
  }
  function stats() {
    return { schemaVersion: 1, transport: 'local_otlp_http_json', accepting: !closing && !overflow,
      closed, overflow, limits: { maxBodyBytes: MAX_BODY_BYTES, maxRecords: MAX_RECORDS,
        maxAttributesPerRecord: MAX_ATTRIBUTES, maxAttributeKeys: MAX_ATTRIBUTE_KEYS },
      ...counters, projectedEvents: projected.length, eventCounts: { ...eventCounts },
      attributeKeys: [...attributeKeys].sort(), unknownAttributeKeys: [...unknownAttributeKeys].sort(),
      interpretation: 'Projected source OTLP log timestamps and numeric metadata only. Export receive times and raw payloads are not retained. Duration field semantics require transport-specific validation.' };
  }
  const server = createServer(async (request, response) => {
    counters.requests++;
    // Reject before reading a body. Nothing from headers/URL/remote identity is copied into state.
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== expectedHost || request.headers.origin
      || request.method !== 'POST' || request.url !== '/v1/logs' || !secretMatches(request.headers[HEADER], capability)) {
      counters.rejectedRequests++; json(response, 403, { error: 'otel_observer_unauthorized' }); request.resume(); return;
    }
    if (closing) { counters.rejectedRequests++; json(response, 503, { error: 'otel_observer_closing' }); request.resume(); return; }
    if (overflow) { counters.overflowRequests++; json(response, 429, { error: 'otel_observer_record_limit' }); request.resume(); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')
      || request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
      counters.rejectedRequests++; json(response, 415, { error: 'otel_observer_json_required' }); request.resume(); return;
    }
    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      counters.oversizedRequests++; json(response, 413, { error: 'otel_observer_body_limit' }); request.resume(); return;
    }
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          counters.oversizedRequests++; json(response, 413, { error: 'otel_observer_body_limit' }); return;
        }
        chunks.push(chunk);
      }
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      const records = recordsFrom(payload, MAX_RECORDS - counters.recordsAccepted);
      if (records === null) { overflow = true; counters.overflowRequests++; json(response, 429, { error: 'otel_observer_record_limit' }); return; }
      counters.recordsAccepted += records.length;
      for (const record of records) { const event = project(record); if (event) projected.push(event); else counters.recordsDropped++; }
      counters.acceptedBatches++; json(response, 200, {});
    } catch {
      counters.malformedRequests++;
      if (!response.headersSent && !response.destroyed) json(response, 400, { error: 'otel_observer_invalid_json' });
    }
  });
  server.maxConnections = 8; server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((done, reject) => { server.once('error', () => reject(safeError('otel_observer_listen_failed'))); server.listen(0, '127.0.0.1', done); });
  expectedHost = '127.0.0.1:' + server.address().port;
  const endpoint = 'http://' + expectedHost + '/v1/logs';
  const headers = { [HEADER]: capability };
  const exporter = { 'otlp-http': { endpoint, protocol: 'json', headers: { ...headers } } };
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await new Promise(done => {
        const timer = setTimeout(() => server.closeAllConnections(), 1000); timer.unref();
        server.close(() => { clearTimeout(timer); done(); }); server.closeIdleConnections();
      });
      closed = true;
      try {
        await writeFile(join(output, 'otel-events.json'), JSON.stringify({ schemaVersion: 1, events: projected }, null, 2) + '\n', { flag: 'wx' });
        await writeFile(join(output, 'otel-status.json'), JSON.stringify(stats(), null, 2) + '\n', { flag: 'wx' });
      } catch { throw safeError('otel_observer_save_failed'); }
      return stats();
    })();
    return closePromise;
  }
  return { endpoint, headers, exporter, stats, close };
}
