import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createCodexAppServer } from './codex-app-server.mjs';
import { createOtelObserver } from './otel-observer.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function toml(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + '=' + toml(item)).join(',') + '}';
  throw new Error('invalid_local_otel_config');
}
const [executable, outputDirectory, sourceReport, fixtureOverride, instructionsOverride] = process.argv.slice(2).map(value => resolve(value));
if (!executable || !outputDirectory || !sourceReport) throw new Error('transport_probe_arguments_required');
await mkdir(outputDirectory, { recursive: false });
const sourcePath = fixtureOverride ?? sourceReport;
const source = await readFile(sourcePath), report = JSON.parse(source), selected = fixtureOverride ? report.fixtures : [2, 4, 6].map(segmentId => report.rows.find(row => row.segmentId === segmentId));
if (selected.some(row => !row?.ja)) throw new Error('transport_probe_sources_missing');
const observer = await createOtelObserver({ outputDirectory: join(outputDirectory, 'local-otel') });
// Local-only opt-in logs. No prompt logging, traces, metrics, global config or analytics opt-in.
const overrides = ['-c', 'otel.exporter=' + toml(observer.exporter), '-c', 'otel.log_user_prompt=false',
  '-c', 'otel.trace_exporter="none"', '-c', 'otel.metrics_exporter="none"', '-c', 'analytics.enabled=false'];
let client, closed = null, code = null;
const results = [];
try {
  client = await createCodexAppServer({ executable, cwd: resolve('.runtime/mic-prototype/cli-work'), serviceTier: 'fast', closeTimeoutMs: 5000,
    instructionsFile: instructionsOverride,
    spawnImpl: (exe, args, options) => spawn(exe, [...overrides, ...args], options) });
  if (!Object.values(client.diagnostics().config.local_telemetry).every(value => value === true)) throw new Error('local_otel_isolation_not_verified');
  const thread = await client.startThread();
  for (const row of selected) {
    const fixture = { id: 'transport-' + (row.segmentId ?? row.id), ja: row.ja, context: row.context ?? 'The current speaker is the livestream host. Preserve Japanese names without guessing their kanji or gender.' };
    const dispatchEpochMs = Date.now();
    const result = await client.translate({ threadId: thread.threadId, fixture, glossary: [] });
    results.push({ segmentId: row.segmentId ?? row.id, dispatchEpochMs, completedEpochMs: Date.now(), result });
    if (!result.success) { code = result.error?.code ?? 'transport_probe_translation_failed'; break; }
  }
} catch (error) { code = /^[a-zA-Z0-9_.:-]+$/.test(error.safeCode ?? error.message) ? error.safeCode ?? error.message : 'transport_probe_failed'; }
finally {
  if (client) closed = await client.close();
  const status = await observer.close();
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify({ sourceReport: sourcePath, sourceSha256: hash(source), model: 'gpt-6.1-sol',
    instructionsSha256: hash(await readFile(instructionsOverride ?? resolve('tools/mic-prototype/translation-base.md'))),
    serviceTierRequested: 'fast', promptLogging: false, analyticsEnabled: false, inputSegmentIds: selected.map(row => row.segmentId ?? row.id),
    closed, diagnostics: client?.diagnostics() ?? null, errorCode: code, collector: status, results,
    interpretation: 'OTLP event timestamps are retained; batch receipt is not transport timing. Event durations are not assumed to be server inference or header wait.' }, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ completed: results.filter(value => value.result.success).length, attempted: results.length,
  errorCode: code, closeConfirmed: closed?.termination_confirmed ?? false, collector: observer.stats() }));
if (code || closed?.termination_confirmed !== true || closed?.exit_code !== 0) process.exitCode = 1;
