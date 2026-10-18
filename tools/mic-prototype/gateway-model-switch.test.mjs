import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './gateway.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await wait(5); } assert.fail('model switch condition timed out'); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('catalog stage process.closed false latches both CLI providers before any subsequent catalog or audio startup', async () => {
  for (const translationProvider of ['codex_cli', 'codex_resident']) {
    const temporary = await mkdtemp(join(tmpdir(), 'mic-prototype-catalog-stage-'));
    let loginChecks = 0, catalogCalls = 0;
    const gateway = await createGateway({ translationProvider, codexExecutable: 'C:/test/codex.exe',
      cliWorkDir: join(temporary, 'cli'), outputBase: join(temporary, 'evidence'), replayFile: join(temporary, 'fixture.wav'),
      checkCodexLoginImpl: async () => { loginChecks++; return { loggedIn: true, authMode: 'chatgpt' }; },
      listCodexModelsImpl: async () => {
        catalogCalls++;
        throw Object.assign(new Error('private stage details'), { safeCode: 'appserver_catalog_setup_failed',
          diagnostics: { process: { closed: false, stage: 'initialize' } } });
      },
      spawnImpl: () => assert.fail('unconfirmed catalog process must block audio startup'),
      createCodexResidentPoolImpl: () => assert.fail('unconfirmed catalog process must block resident startup'),
      fetchImpl: () => assert.fail('no OAuth or API calls expected'),
    });
    try {
      assert.equal(gateway.state.catalogError, 'appserver_catalog_setup_failed');
      assert.equal(gateway.state.cliProcessExitUnconfirmed, true);
      assert.ok(gateway.state.warnings.includes('catalog_process_termination_unconfirmed'));
      assert.equal(loginChecks, 1); assert.equal(catalogCalls, 1);
      const html = await (await fetch(gateway.origin)).text(), capability = html.match(/const capability='([^']+)'/)[1];
      const post = async (path, body = {}) => {
        const response = await fetch(gateway.origin + path, { method: 'POST', headers: { origin: gateway.origin,
          'content-type': 'application/json', 'x-prototype-capability': capability }, body: JSON.stringify(body) });
        return response.json();
      };
      assert.equal((await post('/cli/check')).error, 'codex_cli_process_exit_unconfirmed');
      assert.equal((await post('/start', { source: 'public_replay', concurrency: 1 })).error, 'codex_cli_process_exit_unconfirmed');
      assert.equal(loginChecks, 1); assert.equal(catalogCalls, 1);
      assert.equal(gateway.state.workerActive, false);
      assert.doesNotMatch(JSON.stringify(gateway.state), /private stage details/);
    } finally { await gateway.close(); await rm(temporary, { recursive: true, force: true }); }
  }
});

test('exec translates queued segments with their frozen model despite later selections, without restart or retranslation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mic-prototype-model-switch-'));
  const calls = []; let child;
  const gateway = await createGateway({ translationProvider: 'codex_cli', codexExecutable: 'C:/test/codex.exe',
    cliWorkDir: join(temporary, 'cli'), outputBase: join(temporary, 'evidence'), replayFile: join(temporary, 'fixture.wav'),
    checkCodexLoginImpl: async () => ({ loggedIn: true, authMode: 'chatgpt' }),
    listCodexModelsImpl: async () => ({ catalogSource: 'codex_model_list', models: [
      { slug: 'gpt-6.1-sol', display_name: 'Original', input_modalities: ['text'] },
      { slug: 'another-codex-model', display_name: 'Another', input_modalities: ['text'] },
    ] }),
    fetchImpl: () => assert.fail('no OAuth or API calls expected'),
    translateImpl: options => { const job = { ...options, ...deferred() }; calls.push(job); return job.promise; },
    spawnImpl: () => {
      assert.equal(child, undefined, 'changing models must not restart the audio worker');
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.clockRequests = 0;
      child.send = event => child.stdout.write(JSON.stringify(event) + '\n');
      child.stdin = new Writable({ write(chunk, encoding, done) {
        for (const line of chunk.toString().trim().split('\n')) {
          const command = JSON.parse(line);
          if (command.command === 'clock') { child.clockRequests++; child.send({ type: 'clock_sync', id: command.id, perfCounterMs: performance.now() + 1000 }); }
          if (command.command === 'stop') { child.stdout.end(); setImmediate(() => child.emit('close', 0)); }
        }
        done();
      } });
      child.kill = () => { child.stdout.end(); child.emit('close', 1); };
      setImmediate(() => child.send({ type: 'worker_ready' })); return child;
    },
  });
  try {
    const html = await (await fetch(gateway.origin)).text(), capability = html.match(/const capability='([^']+)'/)[1];
    const post = async (path, body) => {
      const response = await fetch(gateway.origin + path, { method: 'POST', headers: { origin: gateway.origin,
        'content-type': 'application/json', 'x-prototype-capability': capability }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await post('/start', { source: 'public_replay', concurrency: 1 })).status, 200);
    await until(() => child?.clockRequests === 3);
    const asr = segmentId => child.send({ type: 'asr_result', segmentId, revision: 1, ja: `日本語${segmentId}` });
    asr(1); asr(2); await until(() => calls.length === 1 && gateway.state.queue.pending === 1);
    assert.equal((await post('/api/translation-model', { model: 'another-codex-model' })).status, 200);
    asr(3); await until(() => gateway.state.queue.pending === 2);
    for (let index = 0; index < 3; index++) {
      await until(() => calls.length === index + 1);
      calls[index].resolve({ success: true, translation: { zh: `中文${index}`, en: `English${index}` },
        telemetry: { transport: 'codex_cli', request: { model: calls[index].model.slug } }, response_model: null });
    }
    await until(() => gateway.state.queue.ordered === 3 && gateway.state.queue.processesActive === 0);
    assert.deepEqual(calls.map(call => call.model.slug), ['gpt-6.1-sol', 'gpt-6.1-sol', 'another-codex-model']);
    assert.deepEqual(calls.map(call => call.fixture.ja), ['日本語1', '日本語2', '日本語3']);
    assert.deepEqual(gateway.state.rows.map(row => row.translationDiagnostics.request.model), calls.map(call => call.model.slug));
    assert.deepEqual(gateway.state.rows.map(row => row.segmentId), [1, 2, 3]);
    assert.equal(gateway.state.session.model, 'gpt-6.1-sol'); assert.equal(gateway.state.selectedModel, 'another-codex-model');
    await post('/stop', {}); await until(() => !gateway.state.workerActive);
  } finally {
    for (const call of calls) call.resolve({ success: false, error: { code: 'test_cleanup' } });
    await gateway.close(); await rm(temporary, { recursive: true, force: true });
  }
});
