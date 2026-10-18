import { createCodexAppServer } from './codex-app-server.mjs';
import { codexTranslationPrompt } from './codex-translation.mjs';
import { parseBilingual } from '../siwc-probe/inference.mjs';

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const TIERS = new Set(['default', 'fast', 'priority']);
const safeError = code => Object.assign(new Error(code), { safeCode: code });
const codeOf = (error, fallback) => typeof error?.safeCode === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(error.safeCode) ? error.safeCode : fallback;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const round = value => Math.round(value * 1000) / 1000;
const validModel = value => typeof value?.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.slug);
const CONTEXT_USAGE_SOURCE = 'thread/tokenUsage/updated.last.totalTokens/modelContextWindow';
const unknownContextUsage = () => ({ usedTokens: null, modelContextWindow: null, ratio: null, source: 'unknown' });
function contextUsageProjection(value) {
  if (!Number.isSafeInteger(value?.usedTokens) || value.usedTokens < 0
    || !Number.isSafeInteger(value?.modelContextWindow) || value.modelContextWindow <= 0
    || value?.source !== CONTEXT_USAGE_SOURCE) return unknownContextUsage();
  return { usedTokens: value.usedTokens, modelContextWindow: value.modelContextWindow,
    ratio: value.usedTokens / value.modelContextWindow, source: CONTEXT_USAGE_SOURCE };
}

function closeProjection(value) {
  return { closed: value?.closed === true, termination_confirmed: value?.termination_confirmed === true,
    exit_code: Number.isInteger(value?.exit_code) ? value.exit_code : null,
    exit_signal: typeof value?.exit_signal === 'string' && /^[A-Z0-9]{1,16}$/.test(value.exit_signal) ? value.exit_signal : null,
    unusable_code: value?.unusable_code === null ? null : codeOf({ safeCode: value?.unusable_code }, 'resident_client_close_failed') };
}

/** Keep lifecycle/config evidence, never arbitrary errors, thread identifiers or config contents. */
function clientProjection(value) {
  const config = value?.config, alignment = value?.alignment;
  return { transport: 'codex_app_server', startup_ms: number(value?.startup_ms), stdout_bytes: count(value?.stdout_bytes),
    stderr_bytes: count(value?.stderr_bytes), open_threads: count(value?.open_threads),
    selected_reasoning_effort: EFFORTS.has(value?.selected_reasoning_effort) ? value.selected_reasoning_effort : null,
    reasoning_policy: ['explicit_lowest_supported', 'explicit_catalog_default_alignment'].includes(value?.reasoning_policy) ? value.reasoning_policy : null,
    unusable_code: value?.unusable_code === null ? null : codeOf({ safeCode: value?.unusable_code }, 'resident_client_diagnostics_unknown'),
    instructions_sha256: typeof value?.instructions_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.instructions_sha256) ? value.instructions_sha256 : null,
    instructions_bytes: count(value?.instructions_bytes), instructions_mode: value?.instructions_mode === 'full_base_instructions' ? value.instructions_mode : null,
    config_isolation: value?.config_isolation === 'explicit_overrides_only' ? value.config_isolation : null,
    config: { safe_to_start_thread: config?.safe_to_start_thread === true, model_matches: config?.model_matches === true,
      mcp_server_count: count(config?.mcp_server_count), mcp_enabled_server_count: count(config?.mcp_enabled_server_count),
      critical_non_mcp_controls_verified: config?.critical_non_mcp_controls_verified === true,
      config_reasoning_effort: EFFORTS.has(config?.config_reasoning_effort) ? config.config_reasoning_effort : null,
      selected_reasoning_effort: EFFORTS.has(config?.selected_reasoning_effort) ? config.selected_reasoning_effort : null,
      config_effort_matches_selected: typeof config?.config_effort_matches_selected === 'boolean' ? config.config_effort_matches_selected : null,
      requested_service_tier: TIERS.has(config?.requested_service_tier) ? config.requested_service_tier : null },
    alignment: { inherited_config_effort: EFFORTS.has(alignment?.inherited_config_effort) ? alignment.inherited_config_effort : null,
      model_catalog_default_effort: EFFORTS.has(alignment?.model_catalog_default_effort) ? alignment.model_catalog_default_effort : null,
      explicit_process_effort: EFFORTS.has(alignment?.explicit_process_effort) ? alignment.explicit_process_effort : null,
      reasoning_policy: ['lowest_supported', 'catalog_default'].includes(alignment?.reasoning_policy) ? alignment.reasoning_policy : null,
      configured_mcp_count: count(alignment?.configured_mcp_count), per_server_disable_count: count(alignment?.per_server_disable_count) },
    process: { closed: value?.process?.closed === true, exit_code: Number.isInteger(value?.process?.exit_code) ? value.process.exit_code : null,
      exit_signal: typeof value?.process?.exit_signal === 'string' && /^[A-Z0-9]{1,16}$/.test(value.process.exit_signal) ? value.process.exit_signal : null } };
}

function terminationUnconfirmed(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return false;
  if (value.termination_confirmed === false || value.process?.closed === false) return true;
  return ['discovery_close', 'isolation_discovery', 'close', 'diagnostics'].some(key => terminationUnconfirmed(value[key], depth + 1));
}

/** Each model owns bounded serial lanes. Switching models never transfers their history. */
export async function createCodexResidentPool({ executable, cwd, instructionsFile, model = { slug: 'gpt-6.1-sol' }, serviceTier = 'default', promptStyle = 'full',
  concurrency = 1, maxTurnsPerThread = 30, maxTurnsPerProcess = 120, maxCachedModels = 4, maxContextBytes = 128 * 1024,
  maxActualTotalTokens = null, contextUsageThreshold = 0.8, testOnlyContextUsageThreshold = false,
  modelPolicies = {}, reasoningPolicy = 'lowest_supported', createClientImpl = createCodexAppServer,
  now = () => performance.now(), timeoutMs = 30_000, closeTimeoutMs = 2000, maxBytes = 16 * 1024 * 1024, maxTurnBytes = 1024 * 1024 } = {}) {
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const validTokenLimit = value => value === null || integer(value, 1, 1_000_000_000);
  const validContextThreshold = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    && (value === 0.8 || testOnlyContextUsageThreshold === true);
  if (typeof executable !== 'string' || !executable || typeof cwd !== 'string' || !cwd || !validModel(model)
    || !['default', 'fast'].includes(serviceTier) || promptStyle !== 'full' || reasoningPolicy !== 'lowest_supported' || ![1, 2].includes(concurrency)
    || !integer(maxTurnsPerThread, 1, 30) || !integer(maxTurnsPerProcess, 1, 120) || !integer(maxCachedModels, 1, 4)
    || !integer(maxContextBytes, 1024, 16 * 1024 * 1024) || !validTokenLimit(maxActualTotalTokens)
    || typeof testOnlyContextUsageThreshold !== 'boolean' || !validContextThreshold(contextUsageThreshold)
    || !modelPolicies || typeof modelPolicies !== 'object' || Array.isArray(modelPolicies) || Object.keys(modelPolicies).length > 100
    || typeof createClientImpl !== 'function' || typeof now !== 'function'
    || ![timeoutMs, closeTimeoutMs, maxBytes, maxTurnBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw safeError('invalid_resident_pool_options');
  const policies = new Map();
  for (const [slug, value] of Object.entries(modelPolicies)) {
    if (!validModel({ slug }) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['maxTurnsPerThread', 'maxTurnsPerProcess', 'maxContextBytes', 'maxActualTotalTokens', 'contextUsageThreshold', 'reasoningEffort'].includes(key)))
      throw safeError('invalid_resident_model_policy');
    const policy = { maxTurnsPerThread, maxTurnsPerProcess, maxContextBytes, maxActualTotalTokens, contextUsageThreshold, ...value };
    if (!integer(policy.maxTurnsPerThread, 1, 30) || !integer(policy.maxTurnsPerProcess, 1, 120)
      || !integer(policy.maxContextBytes, 1024, 16 * 1024 * 1024) || !validTokenLimit(policy.maxActualTotalTokens) || !validContextThreshold(policy.contextUsageThreshold)
      || policy.reasoningEffort !== undefined && !EFFORTS.has(policy.reasoningEffort)) throw safeError('invalid_resident_model_policy');
    policies.set(slug, Object.freeze(policy));
  }
  const defaults = Object.freeze({ maxTurnsPerThread, maxTurnsPerProcess, maxContextBytes, maxActualTotalTokens, contextUsageThreshold });
  const defaultModel = Object.freeze({ slug: model.slug }), started = now(), cache = new Map(), ownedLanes = new Set(), inFlight = new Set();
  const pendingModels = new Map(), evictionHistory = [], rotations = [], preparations = new Set();
  let startupMs = null, unusableCode = null, closing = false, closed = false, closePromise = null, stickyUnconfirmed = false;
  let laneSequence = 0, accessSequence = 0, cacheGeneration = 0, evictionCount = 0, instructionSha = null, instructionBytes = null;
  let lastRequestedModel = defaultModel.slug, modelSwitches = 0, cacheMutation = Promise.resolve();
  const clientOptions = { executable, cwd, instructionsFile, serviceTier, promptStyle: 'full', reasoningPolicy, timeoutMs, closeTimeoutMs, maxBytes, maxTurnBytes };
  function policyFor(slug) { return policies.get(slug) ?? defaults; }
  function fail(error, fallback) {
    unusableCode ??= codeOf(error, fallback);
    if (terminationUnconfirmed(error?.diagnostics)) stickyUnconfirmed = true;
    return safeError(unusableCode);
  }
  function laneProjection(lane) {
    return { lane: lane.id, model_lane: lane.modelLane, cache_generation: lane.cacheGeneration, busy: lane.busy,
      process_generation: lane.processGeneration, thread_generation: lane.threadGeneration, thread_turns: lane.threadTurns,
      process_turns: lane.processTurns, total_turns: lane.totalTurns, thread_rotations: lane.threadRotations, process_rotations: lane.processRotations,
      requested_model: lane.model, current_model: lane.client ? lane.model : null, model_switches: 0,
      last_setup_ms: lane.lastSetupMs, last_rotation: lane.lastRotation, last_model_switch_ms: lane.lastModelSwitchMs,
      instructions_sha256: lane.instructionsSha, context_estimated_bytes: lane.contextBytes,
      context_estimate_kind: 'retained_utf8_instructions_full_prompts_and_outputs_plus_256_bytes_per_turn_not_tokens',
      actual_thread_total_tokens: lane.actualTotalTokens, actual_usage_source: lane.actualTotalTokens === null ? null : 'thread/tokenUsage/updated.total.totalTokens',
      context_usage: { ...lane.contextUsage }, context_usage_turn_index: lane.contextUsageTurnIndex, context_prewarm: { ...lane.prewarmStatus },
      last_close: lane.lastClose ? { ...lane.lastClose } : null, client: lane.client ? clientProjection(lane.client.diagnostics()) : null };
  }
  function diagnostics() {
    return { schema_version: 2, transport: 'codex_resident', startup_ms: startupMs,
      state: closed ? 'closed' : closing ? 'closing' : unusableCode ? 'failed' : 'ready',
      requested_model: defaultModel.slug, requested_service_tier: serviceTier, prompt_style: 'full', reasoning_policy: reasoningPolicy, concurrency,
      max_turns_per_thread: maxTurnsPerThread, max_turns_per_process: maxTurnsPerProcess, max_context_bytes: maxContextBytes,
      max_actual_total_tokens: maxActualTotalTokens, max_cached_models: maxCachedModels, cached_model_count: cache.size,
      context_usage_threshold: contextUsageThreshold, context_usage_threshold_test_only: testOnlyContextUsageThreshold,
      context_usage_basis: CONTEXT_USAGE_SOURCE, owned_preparations: preparations.size,
      model_policies: Object.fromEntries(policies), model_switches: modelSwitches, cache_evictions: evictionCount,
      instructions_sha256: instructionSha, instructions_bytes: instructionBytes, instructions_mode: 'full_base_instructions',
      in_flight: inFlight.size, unusable_code: unusableCode, termination_unconfirmed: stickyUnconfirmed,
      models: [...cache.values()].map(entry => ({ model: entry.model, cache_generation: entry.generation, last_used_sequence: entry.lastUsed,
        policy: { ...entry.policy }, lane_count: entry.lanes.length, busy: entry.lanes.some(lane => lane.busy) })),
      lanes: [...cache.values()].flatMap(entry => entry.lanes.map(laneProjection)),
      eviction_history: evictionHistory.map(item => ({ ...item })), rotation_history: rotations.map(item => ({ ...item })) };
  }
  async function closeClient(lane) {
    if (!lane.client) { ownedLanes.delete(lane); return lane.lastClose; }
    if (lane.closePromise) return lane.closePromise;
    lane.closing = true;
    lane.closePromise = (async () => {
      // A cached/evicted model still owns its in-progress thread/start until it settles.
      await Promise.allSettled([lane.standby?.promise, lane.promotionPromise].filter(Boolean));
      let result;
      try { result = closeProjection(await lane.client.close()); }
      catch { result = closeProjection({ closed: false, termination_confirmed: false, exit_code: null, exit_signal: null, unusable_code: null }); }
      lane.lastClose = result;
      if (!result.termination_confirmed) { stickyUnconfirmed = true; unusableCode ??= 'resident_process_exit_unconfirmed'; }
      else if (result.exit_code !== 0) unusableCode ??= 'resident_process_close_failed';
      if (result.termination_confirmed) ownedLanes.delete(lane);
      return result;
    })();
    return lane.closePromise;
  }
  async function createLaneThread(lane, startOptions) {
    const info = lane.client.diagnostics(), sha = info?.instructions_sha256;
    if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha) || !integer(info.instructions_bytes, 1, 65_536)
      || info.instructions_mode !== 'full_base_instructions') throw safeError('resident_instructions_unverified');
    if (instructionSha !== null && sha !== instructionSha) throw safeError('resident_instructions_changed');
    instructionSha ??= sha; instructionBytes ??= info.instructions_bytes;
    if (instructionBytes !== info.instructions_bytes) throw safeError('resident_instructions_changed');
    const thread = await lane.client.startThread(startOptions);
    if (typeof thread?.threadId !== 'string' || !thread.threadId || thread.telemetry?.instructions_sha256 !== instructionSha
      || thread.telemetry?.instructions_bytes !== instructionBytes || thread.telemetry?.instructions_mode !== 'full_base_instructions')
      throw safeError('resident_thread_instructions_unverified');
    return thread;
  }
  function activateLaneThread(lane, thread) {
    lane.threadId = thread.threadId; lane.instructionsSha = instructionSha; lane.threadGeneration++;
    lane.threadTurns = 0; lane.contextBytes = instructionBytes; lane.actualTotalTokens = null;
    lane.contextUsage = unknownContextUsage();
    lane.contextUsageTurnIndex = 0;
  }
  async function startLaneThread(lane) {
    activateLaneThread(lane, await createLaneThread(lane));
  }
  function recordRotation(lane, reason) {
    rotations.push({ model: lane.model, lane: lane.id, reason, process_generation: lane.processGeneration,
      thread_generation: lane.threadGeneration, instructions_sha256: instructionSha });
    if (rotations.length > 64) rotations.shift();
  }
  function promoteStandby(lane) {
    if (!lane.standby) return Promise.resolve();
    if (lane.promotionPromise) return lane.promotionPromise;
    const standby = lane.standby;
    lane.promotionPromise = (async () => {
      await standby.promise;
      if (closing || closed || unusableCode || lane.closing || !standby.thread || lane.activeTurn
        || lane.standby !== standby || lane.client !== standby.client || lane.threadId !== standby.sourceThreadId) return;
      await lane.client.releaseThread(standby.sourceThreadId);
      // close/eviction may begin during the management RPC; it will close both owned threads.
      if (closing || closed || unusableCode || lane.closing) return;
      activateLaneThread(lane, standby.thread); lane.threadRotations++;
      lane.pendingRotationReason = 'context_usage_threshold'; lane.lastRotation = 'context_usage_threshold';
      lane.prewarmStatus = { ...lane.prewarmStatus, state: 'activated', activated_ms: round(now() - started) };
      lane.standby = null; recordRotation(lane, 'context_usage_threshold');
    })().catch(error => {
      lane.prewarmStatus = { ...lane.prewarmStatus, state: 'failed', error_code: codeOf(error, 'resident_context_promotion_failed') };
      fail(error, 'resident_context_promotion_failed');
      if (!closing) void close();
    }).finally(() => { lane.promotionPromise = null; });
    return lane.promotionPromise;
  }
  function maybePrepareContextThread(lane, sourceClient, sourceThreadId, sourceGeneration, sourceTurnIndex, value) {
    if (lane.client !== sourceClient || lane.threadId !== sourceThreadId || lane.threadGeneration !== sourceGeneration) return;
    if (sourceTurnIndex < lane.contextUsageTurnIndex) return;
    const usage = contextUsageProjection(value);
    lane.contextUsage = usage; lane.contextUsageTurnIndex = sourceTurnIndex;
    if (usage.ratio === null || usage.ratio < lane.policy.contextUsageThreshold || lane.standby
      || lane.closing || closing || closed || unusableCode) return;
    const standby = { client: sourceClient, sourceThreadId, sourceGeneration, thread: null, promise: null };
    lane.standby = standby;
    lane.prewarmStatus = { state: 'preparing', trigger: 'context_usage_threshold', trigger_ratio: usage.ratio,
      threshold: lane.policy.contextUsageThreshold, started_ms: round(now() - started), ready_ms: null, activated_ms: null,
      attempts: lane.prewarmStatus.attempts + 1, completed: lane.prewarmStatus.completed, error_code: null };
    // Start synchronously in the usage callback, not on completion or next sentence.
    const work = (async () => {
      try {
        standby.thread = await createLaneThread(lane, { allowDuringActiveTurn: true });
        lane.prewarmStatus = { ...lane.prewarmStatus, state: 'ready', ready_ms: round(now() - started),
          completed: lane.prewarmStatus.completed + 1 };
      } catch (error) {
        lane.prewarmStatus = { ...lane.prewarmStatus, state: 'failed', error_code: codeOf(error, 'resident_context_prewarm_failed') };
        fail(error, 'resident_context_prewarm_failed');
        if (!closing) void close();
      }
    })();
    standby.promise = work; preparations.add(work);
    void work.finally(() => { preparations.delete(work); if (!lane.activeTurn && !closing && !lane.closing) void promoteStandby(lane); });
    if (!lane.activeTurn) void promoteStandby(lane);
  }
  async function initializeLane(lane) {
    ownedLanes.add(lane);
    lane.closePromise = null; lane.lastClose = null; lane.closing = false; lane.standby = null; lane.promotionPromise = null;
    lane.client = await createClientImpl({ ...clientOptions, model: { slug: lane.model },
      ...(lane.policy.reasoningEffort === undefined ? {} : { reasoningEffort: lane.policy.reasoningEffort }) });
    lane.processGeneration++; lane.processTurns = 0;
    await startLaneThread(lane);
  }
  function newLane(entry) {
    const lane = { id: ++laneSequence, modelLane: entry.lanes.length + 1, cacheGeneration: entry.generation, model: entry.model, policy: entry.policy,
      client: null, threadId: null, busy: false, processGeneration: 0, threadGeneration: 0, threadTurns: 0, processTurns: 0,
      totalTurns: 0, threadRotations: 0, processRotations: 0, contextBytes: 0, actualTotalTokens: null, instructionsSha: null,
      contextUsage: unknownContextUsage(), contextUsageTurnIndex: 0, activeTurn: null, standby: null, promotionPromise: null, pendingRotationReason: null, closing: false,
      prewarmStatus: { state: 'idle', trigger: null, trigger_ratio: null, threshold: entry.policy.contextUsageThreshold,
        started_ms: null, ready_ms: null, activated_ms: null, attempts: 0, completed: 0, error_code: null },
      lastClose: null, closePromise: null, lastSetupMs: null, lastModelSwitchMs: null, lastRotation: null };
    entry.lanes.push(lane); return lane;
  }
  function newEntry(slug) {
    const entry = { model: slug, policy: policyFor(slug), lanes: [], nextLane: 0, lastUsed: ++accessSequence, generation: ++cacheGeneration };
    cache.set(slug, entry); return entry;
  }
  async function reserveLane(slug) {
    let release;
    const previous = cacheMutation; cacheMutation = new Promise(done => { release = done; });
    await previous;
    try {
      if (unusableCode) throw safeError(unusableCode);
      let entry = cache.get(slug), cacheHit = Boolean(entry), evicted = null;
      if (!entry) {
        if (cache.size >= maxCachedModels) {
          const victim = [...cache.values()].filter(item => !item.lanes.some(lane => lane.busy) && !pendingModels.get(item.model))
            .sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (!victim) throw safeError('resident_model_cache_busy');
          for (const lane of victim.lanes) {
            const result = await closeClient(lane);
            if (!result?.termination_confirmed || result.exit_code !== 0) throw safeError(unusableCode ?? 'resident_process_close_failed');
          }
          cache.delete(victim.model); evicted = victim.model; evictionCount++;
          evictionHistory.push({ model: victim.model, cache_generation: victim.generation, reason: 'idle_model_lru', lane_count: victim.lanes.length,
            all_processes_termination_confirmed: true, sequence: evictionCount });
          if (evictionHistory.length > 32) evictionHistory.shift();
        }
        entry = newEntry(slug);
      }
      let lane;
      for (let offset = 0; offset < entry.lanes.length; offset++) {
        const candidate = entry.lanes[(entry.nextLane + offset) % entry.lanes.length];
        if (!candidate.busy) { lane = candidate; entry.nextLane = (entry.nextLane + offset + 1) % entry.lanes.length; break; }
      }
      if (!lane && entry.lanes.length < concurrency) lane = newLane(entry);
      if (!lane) throw safeError('resident_pool_busy');
      lane.busy = true; entry.lastUsed = ++accessSequence;
      return { lane, cacheHit, evicted };
    } finally { release(); }
  }
  async function prepareLane(lane, nextPromptBytes, cacheHit) {
    const began = now(), policy = lane.policy;
    let rotation = null;
    if (lane.standby || lane.promotionPromise) await promoteStandby(lane);
    if (unusableCode) throw safeError(unusableCode);
    if (lane.pendingRotationReason) { rotation = lane.pendingRotationReason; lane.pendingRotationReason = null; }
    if (!lane.client) { await initializeLane(lane); rotation = cacheHit ? 'model_lane_created' : 'model_cache_miss'; }
    else if (lane.processTurns >= policy.maxTurnsPerProcess) {
      const result = await closeClient(lane);
      if (!result?.termination_confirmed || result.exit_code !== 0) throw safeError(unusableCode ?? 'resident_process_close_failed');
      lane.client = null; lane.threadId = null;
      await initializeLane(lane); lane.processRotations++; rotation = 'process_turn_limit';
    } else {
      let hardRotation = null;
      if (lane.threadTurns >= policy.maxTurnsPerThread) hardRotation = 'thread_turn_limit';
      else if (lane.contextBytes + nextPromptBytes + 256 > policy.maxContextBytes) hardRotation = 'estimated_context_bytes';
      else if (policy.maxActualTotalTokens !== null && lane.threadTurns > 0 && lane.actualTotalTokens === null) hardRotation = 'actual_usage_unavailable';
      else if (policy.maxActualTotalTokens !== null && lane.actualTotalTokens !== null && lane.actualTotalTokens >= policy.maxActualTotalTokens) hardRotation = 'actual_thread_token_limit';
      if (hardRotation) {
        await lane.client.releaseThread(lane.threadId); lane.threadId = null;
        await startLaneThread(lane); lane.threadRotations++;
        rotation = hardRotation;
      }
    }
    if (lane.contextBytes + nextPromptBytes + 256 > policy.maxContextBytes) throw safeError('resident_context_request_too_large');
    if (unusableCode) throw safeError(unusableCode);
    lane.lastSetupMs = round(now() - began); lane.lastRotation = rotation;
    if (!cacheHit) lane.lastModelSwitchMs = lane.lastSetupMs;
    if (rotation && rotation !== 'context_usage_threshold') recordRotation(lane, rotation);
    return { rotation, setup_ms: lane.lastSetupMs, model_switch_ms: cacheHit ? null : lane.lastSetupMs, model_cache_hit: cacheHit,
      requested_model: lane.model, instructions_sha256: instructionSha, instructions_mode: 'full_base_instructions' };
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await Promise.allSettled([...inFlight]);
      await Promise.allSettled([...preparations]);
      const lanes = [...ownedLanes]; await Promise.all(lanes.map(closeClient));
      closed = true;
      const terminated = !stickyUnconfirmed && ownedLanes.size === 0;
      return { closed: terminated, termination_confirmed: terminated, unusable_code: unusableCode,
        cached_models_closed: cache.size, cache_evictions: evictionCount,
        lanes: lanes.map(lane => ({ lane: lane.id, model: lane.model, process_generation: lane.processGeneration, close: lane.lastClose ? { ...lane.lastClose } : null })) };
    })();
    return closePromise;
  }
  function translate({ fixture, glossary = [], model: requestModel = defaultModel } = {}) {
    if (unusableCode || closing || closed) return Promise.reject(safeError(unusableCode ?? 'resident_pool_closed'));
    if (typeof fixture?.ja !== 'string' || !fixture.ja.trim() || !Array.isArray(glossary) || !validModel(requestModel)) return Promise.reject(safeError('invalid_resident_translation_options'));
    if (inFlight.size >= concurrency) return Promise.reject(safeError('resident_pool_busy'));
    let nextPromptBytes;
    try { nextPromptBytes = Buffer.byteLength(codexTranslationPrompt({ fixture, glossary })); }
    catch { return Promise.reject(safeError('invalid_resident_translation_options')); }
    const requestedModel = Object.freeze({ slug: requestModel.slug }), previousModel = lastRequestedModel;
    lastRequestedModel = requestedModel.slug; if (previousModel !== requestedModel.slug) modelSwitches++;
    pendingModels.set(requestedModel.slug, (pendingModels.get(requestedModel.slug) ?? 0) + 1);
    let lane;
    const work = (async () => {
      try {
        const reserved = await reserveLane(requestedModel.slug); lane = reserved.lane;
        const preparation = await prepareLane(lane, nextPromptBytes, reserved.cacheHit);
        const turnIndex = ++lane.threadTurns, contextBefore = lane.contextBytes;
        lane.processTurns++; lane.totalTurns++;
        const sourceClient = lane.client, sourceThreadId = lane.threadId, sourceGeneration = lane.threadGeneration;
        lane.activeTurn = { threadId: sourceThreadId, generation: sourceGeneration };
        const onContextUsage = usage => maybePrepareContextThread(lane, sourceClient, sourceThreadId, sourceGeneration, turnIndex, usage);
        const result = await sourceClient.translate({ threadId: sourceThreadId, fixture, glossary, onContextUsage });
        if (!result || typeof result !== 'object') throw safeError('resident_invalid_result');
        if (result.telemetry?.request?.model !== undefined && result.telemetry.request.model !== requestedModel.slug)
          throw safeError('resident_result_model_mismatch');
        if (result.success === true) {
          if (result.terminal_event !== 'turn/completed' || !parseBilingual(JSON.stringify(result.translation))) throw safeError('resident_nonterminal_bilingual_result');
          if (result.telemetry?.request?.instructions_sha256 !== instructionSha
            || result.telemetry?.request?.instructions_mode !== 'full_base_instructions') throw safeError('resident_result_instructions_unverified');
        }
        lane.contextBytes += nextPromptBytes + 256 + (result.translation ? Buffer.byteLength(JSON.stringify(result.translation)) : 0);
        lane.actualTotalTokens = count(result.telemetry?.thread_usage_total?.totalTokens);
        if (contextUsageProjection(result.telemetry?.context_usage).ratio !== null) onContextUsage(result.telemetry.context_usage);
        const output = { ...result, telemetry: { ...result.telemetry, request: { ...result.telemetry?.request, model: requestedModel.slug }, resident: {
          lane: lane.id, model_lane: lane.modelLane, cache_generation: lane.cacheGeneration,
          process_generation: lane.processGeneration, thread_generation: lane.threadGeneration,
          turn_index: turnIndex, process_turn_index: lane.processTurns, pool_startup_ms: startupMs, ...preparation,
          previous_model: previousModel === requestedModel.slug ? null : previousModel, evicted_idle_model: reserved.evicted,
          context_estimated_bytes_before: contextBefore, context_estimated_bytes_after: lane.contextBytes,
          context_estimate_kind: 'retained_utf8_instructions_full_prompts_and_outputs_plus_256_bytes_per_turn_not_tokens',
          actual_thread_total_tokens: lane.actualTotalTokens, actual_usage_source: lane.actualTotalTokens === null ? null : 'thread/tokenUsage/updated.total.totalTokens',
          context_usage: { ...lane.contextUsage }, context_prewarm_after_turn: { ...lane.prewarmStatus },
          effective_policy: { ...lane.policy },
        } } };
        if (result.success !== true || result.telemetry?.process_reusable === false) fail({ safeCode: result.error?.code }, 'resident_translation_failed');
        lane.activeTurn = null;
        if (lane.standby && !closing && !unusableCode) void promoteStandby(lane);
        return output;
      } catch (error) {
        if (['resident_model_cache_busy', 'resident_pool_busy'].includes(error?.safeCode)) throw error;
        const failure = fail(error, 'resident_translation_failed'); failure.diagnostics = diagnostics(); throw failure;
      }
    })();
    const tracked = work.finally(() => {
      if (lane) { lane.activeTurn = null; lane.busy = false; }
      const pending = (pendingModels.get(requestedModel.slug) ?? 1) - 1;
      if (pending) pendingModels.set(requestedModel.slug, pending); else pendingModels.delete(requestedModel.slug);
      inFlight.delete(tracked);
      if (unusableCode) void close();
    });
    inFlight.add(tracked); return tracked;
  }
  try {
    const entry = newEntry(defaultModel.slug);
    for (let index = 0; index < concurrency; index++) { const lane = newLane(entry); await initializeLane(lane); }
    startupMs = round(now() - started);
  } catch (error) {
    const failure = fail(error, 'resident_pool_start_failed'); await close(); failure.diagnostics = diagnostics(); throw failure;
  }
  return { startupMs, translate, close, diagnostics };
}
