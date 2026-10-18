import { createHash } from 'node:crypto';
import { runTranslation } from '../siwc-probe/inference.mjs';

export const MAX_OBSERVATION_EVENTS = 128;
const OBSERVED_TYPES = new Set([
  'http_response', 'response.created', 'response.in_progress',
  'response.output_text.delta', 'response.output_text.done',
  'response.completed', 'response.failed', 'response.incomplete', 'error',
]);
const PROCESSING_HEADERS = ['openai-processing-ms', 'x-envoy-upstream-service-time'];
const TIMING_KEYS = ['headers', 'first_nonempty_delta', 'bilingual_json_ready', 'completed', 'total'];
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
const hash = value => createHash('sha256').update(String(value), 'utf8').digest('hex');
const text = value => typeof value === 'string' ? value : '';

// Delegate the existing reader rather than teeing or re-piping the stream: no extra pull,
// byte decoding, buffering or awaited cleanup is introduced by observation.
function observeBodyReads(response, state, clock, relativeTime) {
  if (!response.body) return response;
  const body = response.body;
  const bodyProxy = new Proxy(body, { get(target, key) {
    if (key === 'getReader') return (...args) => {
      const reader = target.getReader(...args);
      state.reader_acquisitions++;
      return new Proxy(reader, { get(actualReader, readerKey) {
        if (readerKey === 'read') return async (...readArgs) => {
          const start = clock();
          state.read_calls++;
          state.first_read_elapsed_ms ??= relativeTime(start);
          const readEnded = () => {
            const end = clock(), elapsed = relativeTime(end), wait = Math.max(0, end - start);
            if (state.max_read_wait_ms === null || wait > state.max_read_wait_ms) {
              state.max_read_wait_ms = wait; state.max_read_wait_ended_elapsed_ms = elapsed;
            }
            return elapsed;
          };
          try {
            const value = await actualReader.read(...readArgs);
            const elapsed = readEnded();
            if (value.done && state.cancel_calls) state.done_after_cancel_elapsed_ms ??= elapsed;
            else if (value.done) state.eof_elapsed_ms ??= elapsed;
            else if (Number.isFinite(value.value?.byteLength) && value.value.byteLength > 0) {
              state.nonempty_chunks++; state.bytes += value.value.byteLength;
              state.first_chunk_elapsed_ms ??= elapsed; state.last_chunk_elapsed_ms = elapsed;
            }
            return value;
          } catch (error) {
            state.read_errors++; state.first_read_error_elapsed_ms ??= readEnded();
            throw error;
          }
        };
        if (readerKey === 'cancel') return (...cancelArgs) => {
          state.cancel_calls++; state.first_cancel_elapsed_ms ??= relativeTime(clock());
          return actualReader.cancel(...cancelArgs);
        };
        if (readerKey === 'releaseLock') return (...releaseArgs) => {
          state.release_lock_calls++;
          return actualReader.releaseLock(...releaseArgs);
        };
        const value = Reflect.get(actualReader, readerKey, actualReader);
        return typeof value === 'function' ? value.bind(actualReader) : value;
      } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(response, { get(target, key) {
    if (key === 'body') return bodyProxy;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function safeIdentifier(value, accessToken) {
  return typeof value === 'string' && value.length <= 200
    && /^[A-Za-z0-9._:/-]+$/.test(value) && (!accessToken || !value.includes(accessToken)) ? value : null;
}

function usageFields(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (finite(value[key]) !== null) result[key] = value[key];
  }
  const cached = finite(value.input_tokens_details?.cached_tokens);
  const reasoning = finite(value.output_tokens_details?.reasoning_tokens);
  if (cached !== null) result.input_tokens_details = { cached_tokens: cached };
  if (reasoning !== null) result.output_tokens_details = { reasoning_tokens: reasoning };
  return Object.keys(result).length ? result : null;
}

/**
 * Add bounded, credential-free observations without changing the historical request or parser.
 * observer receives the final telemetry once; an observer failure cannot fail a translation.
 * Request text is represented only by hashes and lengths, never copied into telemetry.
 */
export async function runObservedTranslation(options) {
  const { observer, onEvent = () => {}, fetchImpl = fetch, ...translationOptions } = options;
  const events = [], eventCounts = {}, firstEventMs = {}, lastEventMs = {};
  const clock = translationOptions.now ?? (() => performance.now());
  let headerClock = null, headerElapsed = null;
  const bodyRead = {
    clock: 'HTTP response event aligned to the same monotonic clock; client read completion, not wire arrival',
    reader_acquisitions: 0, read_calls: 0, nonempty_chunks: 0, bytes: 0,
    first_read_elapsed_ms: null, first_chunk_elapsed_ms: null, last_chunk_elapsed_ms: null,
    first_observed_response_event_elapsed_ms: null,
    max_read_wait_ms: null, max_read_wait_ended_elapsed_ms: null, eof_elapsed_ms: null,
    done_after_cancel_elapsed_ms: null,
    read_errors: 0, first_read_error_elapsed_ms: null,
    cancel_calls: 0, first_cancel_elapsed_ms: null, release_lock_calls: 0,
  };
  const relativeTime = at => headerClock !== null && headerElapsed !== null
    ? Math.round((headerElapsed + at - headerClock) * 1000) / 1000 : null;
  let observedEvents = 0, processingHeadersMs = {}, bodySha256 = null, bodyBytes = null;
  const observe = event => {
    if (!OBSERVED_TYPES.has(event?.type)) return;
    if (event.type === 'http_response') { headerClock = clock(); headerElapsed = finite(event.elapsed_ms); }
    else bodyRead.first_observed_response_event_elapsed_ms ??= finite(event.elapsed_ms);
    observedEvents++;
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    const elapsed = finite(event.elapsed_ms);
    if (elapsed !== null) {
      firstEventMs[event.type] ??= elapsed;
      lastEventMs[event.type] = elapsed;
    }
    if (events.length < MAX_OBSERVATION_EVENTS) {
      const item = { type: event.type, elapsed_ms: elapsed };
      if (finite(event.delta_chars) !== null) item.delta_chars = event.delta_chars;
      if (finite(event.http_status) !== null) item.http_status = event.http_status;
      events.push(item);
    }
  };
  const observedFetch = async (url, init) => {
    if (typeof init?.body === 'string') {
      bodySha256 = hash(init.body);
      bodyBytes = Buffer.byteLength(init.body, 'utf8');
    }
    const response = await fetchImpl(url, init);
    for (const key of PROCESSING_HEADERS) {
      const value = response.headers?.get(key);
      if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
        const milliseconds = Number(value);
        if (Number.isFinite(milliseconds) && milliseconds <= 1_000_000_000) processingHeadersMs[key] = milliseconds;
      }
    }
    return observeBodyReads(response, bodyRead, clock, relativeTime);
  };
  const result = await runTranslation({ ...translationOptions, fetchImpl: observedFetch,
    onEvent: event => { observe(event); onEvent(event); } });
  const request = result.request;
  const fixture = translationOptions.fixture ?? {};
  const fromFirstChunk = end => finite(end) !== null && bodyRead.first_chunk_elapsed_ms !== null
    ? Math.round((end - bodyRead.first_chunk_elapsed_ms) * 1000) / 1000 : null;
  bodyRead.first_chunk_to_first_observed_response_event_ms = fromFirstChunk(bodyRead.first_observed_response_event_elapsed_ms);
  bodyRead.first_chunk_to_first_nonempty_delta_ms = fromFirstChunk(result.timings_ms?.first_nonempty_delta);
  const telemetry = {
    schema_version: 1,
    request: {
      body_sha256: bodySha256, body_bytes: bodyBytes,
      instructions_sha256: hash(text(request.instructions)),
      input_sha256: hash(JSON.stringify(request.input)),
      ja_sha256: hash(text(fixture.ja)), ja_chars: [...text(fixture.ja)].length,
      ja_utf8_bytes: Buffer.byteLength(text(fixture.ja), 'utf8'),
      context_sha256: hash(text(fixture.context)), context_chars: [...text(fixture.context)].length,
      model: safeIdentifier(request.model, translationOptions.accessToken),
      store: request.store === false ? false : null, stream: request.stream === true ? true : null,
      reasoning_policy: result.reasoning_policy,
    },
    http_status: finite(result.http_status),
    request_id: safeIdentifier(result.request_id, translationOptions.accessToken),
    response_id: safeIdentifier(result.response_id, translationOptions.accessToken),
    response_model: safeIdentifier(result.response_model, translationOptions.accessToken),
    processing_headers_ms: processingHeadersMs,
    timings_ms: Object.fromEntries(TIMING_KEYS.map(key => [key, finite(result.timings_ms?.[key])])),
    event_first_ms: firstEventMs, event_last_ms: lastEventMs, event_counts: eventCounts,
    body_read: structuredClone(bodyRead),
    events, events_observed: observedEvents, events_omitted: observedEvents - events.length,
    terminal_event: OBSERVED_TYPES.has(result.terminal_event) ? result.terminal_event : null,
    final_status: safeIdentifier(result.final_status, translationOptions.accessToken),
    success: result.success === true, usage: usageFields(result.usage),
    // Header timing, first text timing and reasoning tokens do not independently identify a server root cause.
    interpretation: 'Client-observed milestones; processing headers are optional server-reported milliseconds, not a complete network/compute breakdown.',
  };
  if (typeof observer === 'function') {
    try {
      const pending = observer(structuredClone(telemetry));
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch { /* Observation is a side channel. */ }
  }
  return { ...result, telemetry };
}
