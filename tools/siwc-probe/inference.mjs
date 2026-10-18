import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const API_ORIGIN = 'https://api.openai.com';
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 120_000;
const CAPABILITY_KEYS = [
  'supported_reasoning_efforts', 'reasoning_efforts', 'supportedReasoningEfforts',
  'reasoning_effort_options', 'reasoningEffortOptions', 'reasoning',
];
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const EVENT_TYPES = new Set([
  'response.created', 'response.in_progress', 'response.output_text.delta',
  'response.output_text.done', 'response.completed', 'response.failed',
  'response.incomplete', 'error',
]);

function timestamp() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

function clean(value, token = '', limit = 2048) {
  if (value === undefined || value === null) return null;
  let result = String(value);
  if (token) result = result.split(token).join('[REDACTED]');
  return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '[REDACTED]')
    .slice(0, limit);
}

function assertToken(token) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
    throw new Error('A non-empty OAuth access token is required.');
  }
}

function safeError(error, token) {
  const detail = error?.message ?? error?.detail ?? 'No error message supplied.';
  return {
    code: clean(error?.code ?? error?.type ?? 'unknown_error', token, 160),
    message: clean(typeof detail === 'object' ? JSON.stringify(detail) : detail, token),
    param: clean(error?.param, token, 160),
  };
}

function capability(value) {
  if (typeof value === 'string') return EFFORTS.has(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(capability).filter(v => v !== undefined);
  if (value && typeof value === 'object') {
    const permitted = new Set([
      'supported', 'efforts', 'supported_efforts', 'default_effort', 'effort',
      'reasoning_effort', 'reasoningEffort', 'supported_reasoning_efforts',
    ]);
    return Object.fromEntries(Object.entries(value).filter(([key]) => permitted.has(key))
      .map(([key, item]) => [key, capability(item)]).filter(([, item]) => item !== undefined));
  }
  return undefined;
}

export function supportedEfforts(model) {
  const result = new Set();
  const visitOptions = values => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value === 'string' && EFFORTS.has(value)) result.add(value);
      else if (value && typeof value === 'object') {
        const effort = value.reasoning_effort ?? value.reasoningEffort ?? value.effort;
        if (EFFORTS.has(effort)) result.add(effort);
      }
    }
  };
  for (const key of CAPABILITY_KEYS.filter(key => key !== 'reasoning')) visitOptions(model[key]);
  if (Array.isArray(model.reasoning)) visitOptions(model.reasoning);
  else for (const key of ['efforts', 'supported_efforts', 'supported_reasoning_efforts']) visitOptions(model.reasoning?.[key]);
  return [...result];
}

function selectedEffort(model) {
  const supported = supportedEfforts(model);
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    .find(effort => supported.includes(effort));
}

async function readChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) throw signal.reason ?? new Error('Request aborted.');
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Request aborted.'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([reader.read(), aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function limitedBody(response, { maxBytes, signal }) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('Request aborted.');
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw Object.assign(new Error('Response exceeded the 1 MiB limit.'), { code: 'output_limit_exceeded' });
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Fetch the account-specific SIWC catalog without copying credentials to disk. */
export async function listModels(accessToken, options = {}) {
  assertToken(accessToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Catalog request timed out.')), options.timeoutMs ?? TIMEOUT_MS);
  let status = null;
  let requestId = null;
  try {
    const response = await fetchImpl(`${API_ORIGIN}/v1/models`, {
      method: 'GET', headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error', signal: controller.signal,
    });
    status = response.status;
    requestId = clean(response.headers.get('x-request-id'), accessToken, 200);
    const body = await limitedBody(response, { maxBytes: options.maxBytes ?? MAX_BYTES, signal: controller.signal });
    let payload;
    try { payload = JSON.parse(body); }
    catch {
      if (!response.ok) payload = { error: { code: 'http_error', message: `HTTP ${response.status} returned a non-JSON error body.` } };
      else throw Object.assign(new Error('The model catalog was not valid JSON.'), { code: 'invalid_catalog_json' });
    }
    if (!response.ok) {
      const detail = safeError(payload.error ?? payload, accessToken);
      throw Object.assign(new Error(detail.message), { ...detail, status: response.status, requestId });
    }
    // This SIWC endpoint has a models array; a generic API-key catalog is not interchangeable.
    if (!Array.isArray(payload.models)) {
      throw Object.assign(new Error('Expected the SIWC model catalog to contain a models array.'), { code: 'unexpected_catalog_shape' });
    }
    const models = payload.models.filter(item => item?.visibility === 'list').map(item => {
      if (typeof item.slug !== 'string' || !/^[A-Za-z0-9._:-]{1,180}$/.test(item.slug)) {
        throw Object.assign(new Error('A visible catalog model had an invalid slug.'), { code: 'invalid_model_slug' });
      }
      const model = { slug: item.slug, display_name: clean(item.display_name ?? item.slug, accessToken, 200), visibility: 'list' };
      for (const key of CAPABILITY_KEYS) {
        if (item[key] !== undefined) model[key] = capability(item[key]);
      }
      return model;
    });
    return {
      source: `${API_ORIGIN}/v1/models`, retrieved_at: timestamp(),
      http_status: response.status, request_id: requestId, models,
      visible_count: models.length, excluded_not_list_count: payload.models.length - models.length,
      reasoning_policy: 'Set reasoning.effort only when the catalog explicitly declares a supported value; otherwise omit it and record server_default.',
    };
  } catch (error) {
    const detail = safeError(controller.signal.aborted ? { code: 'catalog_request_timeout', message: 'The model catalog request exceeded its time limit.' } : error, accessToken);
    const safeArtifact = {
      source: `${API_ORIGIN}/v1/models`, failed_at: timestamp(),
      http_status: error.status ?? status, request_id: error.requestId ?? requestId, error: detail,
    };
    throw Object.assign(new Error(detail.message), {
      ...detail, safeCode: detail.code, safeArtifact,
      status: safeArtifact.http_status, requestId: safeArtifact.request_id,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Incremental SSE parser. Handles split UTF-8, CRLF, multiline data and trailing events. */
export async function* parseSSE(body, { maxBytes = MAX_BYTES, signal } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let bytes = 0;
  const parseLine = line => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) {
      if (!data.length) return undefined;
      const event = data.join('\n');
      data = [];
      return event;
    }
    if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      data.push(value);
    }
    return undefined;
  };
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('Request aborted.');
      const { done, value } = await readChunk(reader, signal);
      if (done) {
        buffer += decoder.decode();
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw Object.assign(new Error('Response exceeded the 1 MiB limit.'), { code: 'output_limit_exceeded' });
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const event = parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event !== undefined) yield event;
      }
    }
    if (buffer) {
      const event = parseLine(buffer);
      if (event !== undefined) yield event;
    }
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function parseBilingual(text) {
  try {
    const parsed = JSON.parse(text.trim());
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
    if (Object.keys(parsed).sort().join(',') !== 'en,zh') return null;
    if (typeof parsed.zh !== 'string' || !parsed.zh.trim() || typeof parsed.en !== 'string' || !parsed.en.trim()) return null;
    return { zh: parsed.zh, en: parsed.en };
  } catch { return null; }
}

function responseText(response) {
  return (response?.output ?? []).flatMap(item => item?.content ?? [])
    .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text).join('');
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isFinite(usage[key])) result[key] = usage[key];
  }
  if (Number.isFinite(usage.input_tokens_details?.cached_tokens)) result.input_tokens_details = { cached_tokens: usage.input_tokens_details.cached_tokens };
  if (Number.isFinite(usage.output_tokens_details?.reasoning_tokens)) result.output_tokens_details = { reasoning_tokens: usage.output_tokens_details.reasoning_tokens };
  return result;
}

function requestBody(model, fixture, glossary) {
  const instructions = [
    'Translate the Japanese utterance into Simplified Chinese and English.',
    'Preserve meaning, negation, modality, numbers, names and context. Do not explain or add facts.',
    'Return exactly one JSON object with exactly two non-empty string fields: "zh" and "en". No Markdown or extra fields.',
    'Use the locale-specific glossary naturally; alternative spellings separated by / or ／ are alternatives, not text to copy together.',
    `Glossary: ${JSON.stringify(glossary ?? [])}`,
  ].join('\n');
  const body = {
    model: model.slug, store: false, stream: true, instructions,
    input: [{ role: 'user', content: JSON.stringify({ ja: fixture.ja, context: fixture.context ?? '' }) }],
  };
  const effort = selectedEffort(model);
  if (effort) body.reasoning = { effort };
  return body;
}

/** One direct Responses request; never retries and succeeds only after completed + valid bilingual JSON. */
export async function runTranslation({ accessToken, model, fixture, glossary = [], fetchImpl = fetch, now = () => performance.now(), timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, onEvent = () => {} }) {
  assertToken(accessToken);
  const body = requestBody(model, fixture, glossary);
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Translation request timed out.')), timeoutMs);
  const elapsed = () => Math.round((now() - started) * 1000) / 1000;
  const result = {
    model: model.slug, case_id: fixture.id, requested_at: timestamp(),
    request: body, reasoning_policy: body.reasoning ? 'catalog_supported' : 'server_default',
    http_status: null, request_id: null, response_id: null, response_model: null,
    success: false, terminal_event: null, final_status: null,
    timings_ms: { headers: null, first_nonempty_delta: null, bilingual_json_ready: null, completed: null, total: null },
    translation: null, raw_output: '', usage: null, error: null,
  };
  const emit = event => onEvent(event);
  try {
    const response = await fetchImpl(`${API_ORIGIN}/v1/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: controller.signal,
    });
    result.timings_ms.headers = elapsed();
    result.http_status = response.status;
    result.request_id = clean(response.headers.get('x-request-id'), accessToken, 200);
    emit({ type: 'http_response', elapsed_ms: result.timings_ms.headers, http_status: response.status, request_id: result.request_id });
    if (!response.ok) {
      const text = await limitedBody(response, { maxBytes, signal: controller.signal });
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { message: `HTTP ${response.status} returned a non-JSON error body.` }; }
      result.error = safeError(payload.error ?? payload, accessToken);
      result.final_status = 'http_error';
      return result;
    }
    if (!response.body) throw Object.assign(new Error('No response body was returned.'), { code: 'missing_stream' });
    for await (const data of parseSSE(response.body, { maxBytes, signal: controller.signal })) {
      if (data === '[DONE]') break;
      let event;
      try { event = JSON.parse(data); }
      catch { throw Object.assign(new Error('An SSE data event was not valid JSON.'), { code: 'invalid_sse_json' }); }
      if (!EVENT_TYPES.has(event.type)) continue;
      const entry = { type: event.type, elapsed_ms: elapsed() };
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        const delta = clean(event.delta, accessToken, maxBytes);
        entry.delta_chars = delta.length;
        result.raw_output += delta;
        if (result.timings_ms.first_nonempty_delta === null && delta.trim()) result.timings_ms.first_nonempty_delta = entry.elapsed_ms;
        if (result.timings_ms.bilingual_json_ready === null && parseBilingual(result.raw_output)) result.timings_ms.bilingual_json_ready = entry.elapsed_ms;
      }
      if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
        // No duplicate append: done carries the full text already streamed in deltas.
        result.raw_output = clean(event.text, accessToken, maxBytes);
        if (result.timings_ms.bilingual_json_ready === null && parseBilingual(result.raw_output)) result.timings_ms.bilingual_json_ready = entry.elapsed_ms;
      }
      const responseData = event.response;
      if (responseData) {
        if (typeof responseData.id === 'string') result.response_id = clean(responseData.id, accessToken, 200);
        if (typeof responseData.model === 'string') result.response_model = clean(responseData.model, accessToken, 200);
      }
      if (event.type === 'response.completed') {
        result.terminal_event = event.type;
        result.final_status = responseData?.status ?? 'completed';
        result.timings_ms.completed = entry.elapsed_ms;
        const finalText = responseText(responseData);
        if (finalText) result.raw_output = clean(finalText, accessToken, maxBytes);
        result.raw_output = clean(result.raw_output, accessToken, maxBytes);
        result.translation = parseBilingual(result.raw_output);
        if (result.translation && result.timings_ms.bilingual_json_ready === null) result.timings_ms.bilingual_json_ready = entry.elapsed_ms;
        result.usage = safeUsage(responseData?.usage);
        result.success = result.final_status === 'completed' && result.translation !== null;
        if (!result.success) result.error = {
          code: result.translation ? 'unexpected_response_status' : 'invalid_bilingual_json',
          message: result.translation ? 'A completed event had a non-completed status.' : 'The final output was not an exact JSON object with non-empty zh and en strings.', param: null,
        };
        entry.translation = result.translation;
        entry.usage = result.usage;
        emit(entry);
        break;
      }
      if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
        result.terminal_event = event.type;
        result.final_status = responseData?.status ?? event.type.replace('response.', '');
        result.error = safeError(responseData?.error ?? event.error ?? event, accessToken);
        if (event.type === 'response.incomplete' && !responseData?.error) {
          result.error = { code: 'response_incomplete', message: clean(responseData?.incomplete_details?.reason ?? 'The server marked the response incomplete.', accessToken), param: null };
        }
        entry.error = result.error;
        emit(entry);
        break;
      }
      emit(entry);
    }
    if (!result.terminal_event) {
      result.final_status = 'interrupted';
      result.error = { code: 'missing_response_completed', message: 'The stream ended without a terminal completed, failed, incomplete or error event.', param: null };
    }
  } catch (error) {
    result.final_status = controller.signal.aborted ? 'timeout' : 'client_error';
    result.error = safeError(controller.signal.aborted ? { code: 'request_timeout', message: 'Translation request exceeded its time limit.' } : error, accessToken);
  } finally {
    clearTimeout(timer);
    result.raw_output = clean(result.raw_output, accessToken, maxBytes);
    result.timings_ms.total = elapsed();
  }
  return result;
}

export function statistics(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = valid.length;
  return { n, min: n ? valid[0] : null, median: n ? (valid[Math.floor((n - 1) / 2)] + valid[Math.floor(n / 2)]) / 2 : null, max: n ? valid[n - 1] : null };
}

function isTextModel(model) {
  return !/(?:^|[-_.])(audio|transcrib\w*|whisper|tts|image|dall|embedding|moderation|sora|realtime|video)(?:$|[-_.])/i.test(model.slug);
}

function pickCandidates(available) {
  const preferred = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol'];
  const rank = model => {
    const index = preferred.findIndex(prefix => model.slug === prefix || model.slug.startsWith(`${prefix}-`));
    return index === -1 ? preferred.length : index;
  };
  return available.filter(model => !/(?:^|[-_])(pro|astra)(?:$|[-_])/i.test(model.slug))
    .map((model, order) => ({ model, order }))
    .sort((a, b) => rank(a.model) - rank(b.model) || a.order - b.order)
    .slice(0, 3).map(item => item.model);
}

function aggregate(records) {
  return {
    samples: records.length, successes: records.filter(record => record.success).length,
    failures: records.filter(record => !record.success).length,
    excluded_from_latency: records.filter(record => !record.success).map(record => ({ case_id: record.case_id, status: record.final_status, code: record.error?.code ?? null })),
    latency_ms_successes_only: Object.fromEntries(['headers', 'first_nonempty_delta', 'bilingual_json_ready', 'completed', 'total']
      .map(key => [key, statistics(records.filter(record => record.success).map(record => record.timings_ms[key]))])),
    p95: 'Not reported: this is a small exploratory sample, not a latency distribution benchmark.',
  };
}

/** Sequential smoke then <= 3 x 18 single-utterance quality requests. No quota endpoints. */
export async function runSuite({ accessToken, models, fixtures, outputDir, onProgress = () => {} }) {
  assertToken(accessToken);
  const catalog = Array.isArray(models) ? { models } : models;
  if (!Array.isArray(catalog?.models) || !Array.isArray(fixtures?.cases) || !fixtures.cases.length) throw new Error('A model catalog and non-empty fixtures.cases are required.');
  mkdirSync(outputDir, { recursive: true });
  for (const name of ['catalog.json', 'requests.jsonl', 'summary.json']) {
    if (existsSync(join(outputDir, name))) throw new Error(`Refusing to overwrite an existing probe artifact: ${name}`);
  }
  writeFileSync(join(outputDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(outputDir, 'requests.jsonl'), '', { flag: 'wx' });
  const log = record => appendFileSync(join(outputDir, 'requests.jsonl'), JSON.stringify(record) + '\n');
  const textModels = catalog.models.filter(isTextModel);
  const smokeModels = textModels.slice(0, 12);
  const cases = fixtures.cases.slice(0, 18);
  const smokeCase = cases.find(item => item.id === '03') ?? cases[0];
  const results = [];
  const summary = {
    started_at: timestamp(), finished_at: null,
    transport: 'Direct OAuth bearer to https://api.openai.com/v1/responses; stream:true; store:false; no redirects; no automatic retries.',
    measurement: 'Request start to HTTP headers / first non-empty text delta / complete bilingual JSON / response.completed. Text translation only; excludes local ASR, audio segmentation, rendering and human accuracy evaluation.',
    smoke_case_id: smokeCase.id, smoke_model_limit: 12, quality_model_limit: 3,
    quality_case_count: cases.length, excluded_fixture_count: fixtures.cases.length - cases.length,
    excluded_non_text_models: catalog.models.filter(model => !isTextModel(model)).map(model => model.slug),
    untested_due_to_smoke_limit: textModels.slice(12).map(model => model.slug),
    candidates: [], smoke: {}, quality: {}, completed_requests: 0,
  };
  const saveSummary = () => writeFileSync(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  saveSummary();
  const run = async (phase, model, fixture, index, total) => {
    const requestId = randomUUID();
    await onProgress({ phase, model: model.slug, caseId: fixture.id, index, total, status: 'started' });
    log({ kind: 'request.started', request_id: requestId, phase, model: model.slug, case_id: fixture.id, at: timestamp(), request: requestBody(model, fixture, fixtures.glossary) });
    const result = await runTranslation({ accessToken, model, fixture, glossary: fixtures.glossary,
      onEvent: event => log({ kind: 'response.event', request_id: requestId, phase, model: model.slug, case_id: fixture.id, event }),
    });
    results.push({ phase, ...result });
    log({ kind: 'request.finished', request_id: requestId, phase, result });
    summary.completed_requests = results.length;
    const phaseRecords = results.filter(record => record.phase === phase && record.model === model.slug);
    summary[phase][model.slug] = aggregate(phaseRecords);
    saveSummary();
    await onProgress({ phase, model: model.slug, caseId: fixture.id, index, total, status: result.success ? 'succeeded' : 'failed', completedMs: result.timings_ms.completed, errorCode: result.error?.code ?? null });
    return result;
  };
  const available = [];
  for (let index = 0; index < smokeModels.length; index++) {
    const result = await run('smoke', smokeModels[index], smokeCase, index + 1, smokeModels.length);
    if (result.success) available.push(smokeModels[index]);
  }
  const candidates = pickCandidates(available);
  summary.candidates = candidates.map(model => model.slug);
  summary.available_but_not_quality_tested = available.filter(model => !candidates.includes(model)).map(model => model.slug);
  saveSummary();
  let index = 0;
  for (const fixture of cases) {
    for (const model of candidates) await run('quality', model, fixture, ++index, candidates.length * cases.length);
  }
  summary.finished_at = timestamp();
  saveSummary();
  return summary;
}
