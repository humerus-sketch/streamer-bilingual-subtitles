import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateway } from './gateway.mjs';
import { publicSpeakerProfile } from './speaker-controller.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
const tick = () => new Promise(done => setImmediate(done));
async function until(check) { for (let i = 0; i < 250; i++) { if (check()) return; await wait(5); } assert.fail('gateway speaker mock condition timed out'); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const pointerFile = 'profile-22222222-2222-4222-8222-222222222222.json';
function result(job, value = 'final') {
  return { success: true, terminal_event: 'turn/completed', final_status: 'completed',
    translation: { zh: '完整中文 ' + value, en: 'Completed English ' + value }, timings_ms: { completed: 5, total: 5 },
    telemetry: { transport: 'codex_app_server', request: { model: job.model.slug }, terminal_event: 'turn/completed', final_status: 'completed' } };
}
async function harness(t, config = {}) {
  const fixtures = resolve('.runtime/speaker-admission-unit-fixtures'); await mkdir(fixtures, { recursive: true });
  const folder = await mkdtemp(join(fixtures, 'gateway-')), profileDirectory = join(folder, 'profiles'); await mkdir(profileDirectory);
  const document = { schemaVersion: 1, profileId: 'speaker-mock-gateway-only', sourceKind: config.profileKind ?? 'user_microphone',
    modelId: 'mock-speaker', modelSha256: 'a'.repeat(64), featureVersion: 'mock-1', threshold: 0.7, minVoicedMs: 1000,
    enrollmentVoicedMs: 20_000, embeddingDimension: 2, embedding: [0.12, 0.34], privateMarker: 'PRIVATE_EMBEDDING_FIXTURE' };
  const profileRaw = JSON.stringify(document), metadata = publicSpeakerProfile({ ...document, profileSha256: createHash('sha256').update(profileRaw).digest('hex') });
  if (!config.noProfile) {
    await writeFile(join(profileDirectory, pointerFile), profileRaw, { flag: 'wx' });
    await writeFile(join(profileDirectory, 'active.json'), JSON.stringify({ schemaVersion: 1, file: pointerFile }));
  }
  const h = { folder, metadata, workers: [], speakerWorkers: [], jobs: [], poolCalls: [], pools: [] };
  const gateway = await createGateway({ translationProvider: 'codex_resident', codexExecutable: resolve('test-only-codex.exe'),
    python: resolve('test-only-python.exe'), cliWorkDir: join(folder, 'cli'), outputBase: join(folder, 'runs'),
    replayFile: join(folder, 'test-only-no-audio.wav'), speakerAssets: join(folder, 'test-only-assets'), speakerProfileDirectory: profileDirectory,
    speakerAdmissionDefault: true, allowEnhancement: false, defaultComputeType: 'float16', translationContextMode: 'previous_translation',
    fetchImpl: () => assert.fail('no external network or authentication requests are allowed in CPU mock tests'),
    translateImpl: () => assert.fail('the exec/cloud transport must not be called'),
    checkCodexLoginImpl: async () => ({ loggedIn: true, authMode: 'chatgpt' }),
    listCodexModelsImpl: async () => ({ catalogSource: 'codex_model_list', models: [
      { slug: 'gpt-6.1-sol', input_modalities: ['text'] }, { slug: 'gpt-6-luna', input_modalities: ['text'] } ] }),
    createCodexResidentPoolImpl: async options => {
      h.poolCalls.push(options);
      const pool = { startupMs: 1, closeCalls: 0, closed: false,
        async translate(options) { const job = { ...options, deferred: deferred() }; h.jobs.push(job); return job.deferred.promise; },
        async close() { pool.closeCalls++; pool.closed = true; return { closed: true, termination_confirmed: true }; },
        diagnostics: () => ({ schema_version: 2, transport: 'codex_resident', state: pool.closed ? 'closed' : 'ready', lanes: [] }) };
      h.pools.push(pool); return pool;
    },
    spawnImpl: (_executable, args, options) => {
      assert.equal(options.windowsHide, true);
      const mode = args[3], child = new EventEmitter(); child.pid = 800 + h.workers.length + h.speakerWorkers.length;
      child.args = args; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.finished = false; child.clockRequests = 0; child.commands = [];
      child.line = event => { if (!child.finished) child.stdout.write(JSON.stringify(event) + '\n'); };
      child.finish = (code = 0) => { if (child.finished) return; child.finished = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code)); };
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        for (const line of chunk.toString().trim().split('\n')) if (line) {
          const value = JSON.parse(line); child.commands.push(value);
          if (value.command === 'clock') { child.clockRequests++; child.line({ type: 'clock_sync', id: value.id, perfCounterMs: performance.now() + 1000 }); }
          if (value.command === 'stop' || value.command === 'cancel') child.finish();
        }
        done();
      } });
      child.kill = () => { child.finish(1); return true; };
      if (mode === 'status') {
        h.speakerWorkers.push(child);
        setImmediate(() => { child.line({ type: 'speaker_status', available: true, profileValid: !config.noProfile, profile: config.noProfile ? null : metadata }); child.finish(); });
      } else {
        assert.ok(['file', 'run'].includes(mode)); h.workers.push(child);
        child.asr = (segmentId, ja, admission = { decision: 'accepted', profileSha256: metadata.profileSha256, modelSha256: metadata.modelSha256 }) => {
          const point = performance.now() + 1000;
          child.line({ type: 'asr_result', segmentId, revision: 1, ja, speakerAdmission: admission,
            startSample: (segmentId - 1) * 16000, endSample: segmentId * 16000, sampleRate: 16000,
            audioEndPerfMs: point - 1000, vadCommitPerfMs: point - 500, asrStartPerfMs: point - 400, asrEndPerfMs: point });
        };
        setImmediate(() => child.line({ type: 'worker_ready', computeType: args[args.indexOf('--compute-type') + 1],
          enhancement: { requestedMode: 'off', appliedMode: 'off' },
          speakerAdmission: { enabled: args.includes('--speaker-profile'), profile: metadata } }));
      }
      return child;
    },
  });
  h.gateway = gateway;
  const html = await (await fetch(gateway.origin)).text(), capability = html.match(/const capability='([^']+)'/)[1];
  h.post = async (path, body = {}) => {
    const response = await fetch(gateway.origin + path, { method: 'POST', headers: { origin: gateway.origin,
      'content-type': 'application/json', 'x-prototype-capability': capability }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  h.start = options => h.post('/start', { source: 'public_replay', model: 'gpt-6.1-sol', concurrency: 1, ...options });
  t.after(async () => {
    for (const job of h.jobs) job.deferred.resolve(result(job, 'cleanup'));
    for (const child of [...h.workers, ...h.speakerWorkers]) child.finish();
    await gateway.close();
  });
  return h;
}

test('missing own voice profile blocks microphone and replay before ASR worker or resident inference starts', async t => {
  const h = await harness(t, { noProfile: true });
  for (const body of [{ source: 'microphone', device: 9 }, { source: 'public_replay' }]) {
    const reply = await h.start(body); assert.equal(reply.body.error, 'speaker_profile_required');
  }
  assert.equal(h.workers.length, 0); assert.equal(h.poolCalls.length, 0); assert.equal(h.jobs.length, 0);
});

test('a saved test_fixture cannot become the microphone user merely through an active pointer', async t => {
  const h = await harness(t, { profileKind: 'test_fixture' });
  assert.equal(h.gateway.state.speakerAdmission.enrolled, false);
  const reply = await h.start({ source: 'microphone', device: 9 });
  assert.equal(reply.body.error, 'speaker_profile_required'); assert.equal(h.workers.length, 0); assert.equal(h.poolCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(h.gateway.state), /PRIVATE_EMBEDDING_FIXTURE|"embedding":/);
});

test('serial previous-final context and disabled enhancement reject incompatible requests before any inference', async t => {
  const h = await harness(t);
  assert.equal((await h.start({ concurrency: 2 })).body.error, 'previous_translation_requires_serial');
  assert.equal((await h.start({ enhancement: 'rnnoise' })).body.error, 'audio_enhancement_disabled');
  assert.equal((await h.start({ enhancement: 'deepfilternet3' })).body.error, 'audio_enhancement_disabled');
  assert.equal(h.workers.length, 0); assert.equal(h.poolCalls.length, 0);
});

test('omitting precision and enhancement really dispatches float16 and original PCM with the enrolled profile', async t => {
  const h = await harness(t); assert.equal((await h.start()).status, 200);
  await until(() => h.workers[0]?.clockRequests === 3);
  const args = h.workers[0].args;
  assert.equal(args[args.indexOf('--compute-type') + 1], 'float16');
  assert.equal(args[args.indexOf('--enhancement') + 1], 'off');
  assert.equal(args[args.indexOf('--speaker-profile') + 1], join(h.folder, 'profiles', pointerFile));
  assert.equal(h.gateway.state.session.computeType, 'float16'); assert.equal(h.gateway.state.session.enhancement, 'off');
  assert.equal(h.gateway.state.session.speakerAdmission, true); assert.equal(h.gateway.state.session.concurrency, 1);
  assert.equal(h.poolCalls[0].promptStyle, 'full'); assert.equal(h.poolCalls[0].maxCachedModels, 4);
});

test('rejected and uncertain speaker decisions produce gaps without any translation request', async t => {
  const h = await harness(t); await h.start(); await until(() => h.workers[0]?.clockRequests === 3);
  for (const [index, decision] of ['rejected', 'uncertain'].entries()) {
    const segmentId = index + 1, speakerAdmission = { decision, reason: 'mock_non_target', score: 0.2, threshold: 0.7,
      voicedMs: 1000, gateMs: 2, profileSha256: h.metadata.profileSha256, modelSha256: h.metadata.modelSha256 };
    h.workers[0].line({ type: 'speaker_decision', segmentId, revision: 1, speakerAdmission });
    h.workers[0].line({ type: 'gap', segmentId, revision: 1, reason: 'speaker_' + decision, speakerAdmission });
  }
  await until(() => h.gateway.state.rows.length === 2);
  assert.equal(h.jobs.length, 0); assert.ok(h.gateway.state.rows.every(row => row.status === 'gap'));
  assert.equal(h.gateway.state.speakerAdmission.latestDecision.decision, 'uncertain');
});

test('ASR without current accepted speaker proof cannot reach CLI even if it contains plausible Japanese', async t => {
  for (const proof of [null, { decision: 'rejected', profileSha256: 'x'.repeat(64) }, { decision: 'accepted', profileSha256: 'b'.repeat(64) }]) {
    const h = await harness(t); await h.start(); await until(() => h.workers[0]?.clockRequests === 3);
    h.workers[0].asr(1, 'これは背景の声です。', proof);
    await until(() => h.workers[0].finished);
    assert.equal(h.jobs.length, 0); assert.equal(h.gateway.state.message, 'speaker_admission_required');
  }
});

test('the next model receives only the previous complete bilingual translation after serial completion', async t => {
  const h = await harness(t); await h.start(); await until(() => h.workers[0]?.clockRequests === 3);
  const firstJa = '最初の文だけの識別用語です。', secondJa = 'それを二つください。';
  h.workers[0].asr(1, firstJa); await until(() => h.jobs.length === 1);
  assert.equal(JSON.parse(h.jobs[0].fixture.context).previousTranslation, null);
  assert.equal((await h.post('/api/translation-model', { model: 'gpt-6-luna' })).status, 200);
  h.workers[0].asr(2, secondJa); await tick(); assert.equal(h.jobs.length, 1);
  const completed = result(h.jobs[0], 'previous-completed-only'); h.jobs[0].deferred.resolve(completed);
  await until(() => h.jobs.length === 2);
  const second = h.jobs[1], context = JSON.parse(second.fixture.context);
  assert.equal(second.model.slug, 'gpt-6-luna'); assert.equal(second.fixture.ja, secondJa);
  assert.deepEqual(context.previousTranslation, completed.translation);
  assert.equal(context.referenceKind, 'previous_completed_translation_only');
  assert.equal(second.fixture.context.includes(firstJa), false);
  assert.equal(Object.keys(context.previousTranslation).sort().join(','), 'en,zh');
  second.deferred.resolve(result(second, 'current-completed-only'));
  await until(() => h.gateway.state.rows.filter(row => row.status === 'completed').length === 2);
});

test('a rejected background gap resets explicit previous translation and cannot enter future context', async t => {
  const h = await harness(t); await h.start(); await until(() => h.workers[0]?.clockRequests === 3);
  h.workers[0].asr(1, '正しい話者です。'); await until(() => h.jobs.length === 1);
  h.jobs[0].deferred.resolve(result(h.jobs[0], 'before-gap')); await until(() => h.gateway.state.rows[0]?.status === 'completed');
  h.workers[0].line({ type: 'gap', segmentId: 2, revision: 1, reason: 'speaker_rejected' });
  h.workers[0].asr(3, '次の話題です。'); await until(() => h.jobs.length === 2);
  assert.equal(JSON.parse(h.jobs[1].fixture.context).previousTranslation, null);
  assert.equal(h.jobs[1].fixture.context.includes('before-gap'), false);
});

test('enrollment and profile refresh remain blocked during active capture, and stop drains owned work', async t => {
  const h = await harness(t); await h.start(); await until(() => h.workers[0]?.clockRequests === 3);
  assert.equal((await h.post('/speaker/enroll', { device: 9, seconds: 25 })).body.error, 'speaker_change_busy');
  assert.equal((await h.post('/speaker/refresh')).body.error, 'speaker_change_busy');
  assert.equal((await h.post('/stop')).status, 200);
  await until(() => !h.gateway.state.workerActive && !h.gateway.state.residentClosing);
  assert.equal(h.pools[0].closed, true); assert.equal(h.workers[0].finished, true);
  assert.equal(h.jobs.length, 0);
});
