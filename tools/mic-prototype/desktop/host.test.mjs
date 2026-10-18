import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runDesktopHost, validateSettings, resolveDesktopSettings, readDesktopSettings, desktopSharedRoot, findCodexExecutable } from './host.mjs';

const settings = { schemaVersion: 1, pythonExecutable: resolve('python.exe'), modelDirectory: resolve('model'),
  dataDirectory: resolve('local-data'), codexModel: 'gpt-6-luna', codexServiceTier: 'fast' };
const tick = () => new Promise(done => setImmediate(done));

test('portable shared tokens expand without changing the package and legacy absolute settings remain valid', () => {
  const env = { BILIBILI_SUBTITLE_HOME: resolve('software-test-home') };
  const portable = { ...settings, pythonExecutable: '{shared}/runtime/python/python.exe',
    modelDirectory: '{shared}/models/large-v3', speakerAssets: '{shared}/models/speaker', dataDirectory: '{shared}/data' };
  const expanded = resolveDesktopSettings(portable, null, env);
  assert.equal(expanded.pythonExecutable, join(env.BILIBILI_SUBTITLE_HOME, 'runtime', 'python', 'python.exe'));
  assert.equal(expanded.speakerAssets, join(env.BILIBILI_SUBTITLE_HOME, 'models', 'speaker'));
  assert.equal(portable.modelDirectory, '{shared}/models/large-v3');
  assert.equal(resolveDesktopSettings(settings, null, env).pythonExecutable, settings.pythonExecutable);
  for (const path of ['{shared}/../outside', '{shared}/nested/../../outside', '{unknown}/model', '{shared}relative', '{shared}//model'])
    assert.throws(() => resolveDesktopSettings({ ...portable, modelDirectory: path }, null, env), /desktop_invalid_settings/);
  assert.throws(() => desktopSharedRoot({ BILIBILI_SUBTITLE_HOME: 'relative-home' }), /desktop_invalid_shared_root/);
});

test('user settings override only documented paths and model choices, preserving production controls', () => {
  const env = { BILIBILI_SUBTITLE_HOME: resolve('software-test-home') }, pythonExecutable = resolve('existing', 'python.exe');
  const result = resolveDesktopSettings(settings, { schemaVersion: 1, pythonExecutable, codexModel: 'gpt-6-astra' }, env);
  assert.equal(result.pythonExecutable, pythonExecutable); assert.equal(result.codexModel, 'gpt-6-astra');
  assert.equal(result.modelDirectory, settings.modelDirectory);
  for (const change of [{ schemaVersion: 2 }, { schemaVersion: 1, replayFile: resolve('recording.wav') },
    { schemaVersion: 1, residentPolicy: { contextUsageThreshold: 0.1 } }, [], false])
    assert.throws(() => resolveDesktopSettings(settings, change, env), /desktop_invalid_user_settings/);
  assert.throws(() => resolveDesktopSettings(settings, { schemaVersion: 1, pythonExecutable: 'relative' }, env), /desktop_invalid_settings/);
});

test('settings loading reads optional user configuration without changing package files or accepting corrupt overrides', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'subtitle-software-settings-'));
  try {
    const env = { BILIBILI_SUBTITLE_HOME: join(temporary, 'shared') }, packagePath = join(temporary, 'launcher.settings.json');
    await writeFile(packagePath, JSON.stringify(settings)); await mkdir(env.BILIBILI_SUBTITLE_HOME);
    assert.equal((await readDesktopSettings(packagePath, env)).codexModel, settings.codexModel);
    const userPath = join(env.BILIBILI_SUBTITLE_HOME, 'desktop.settings.json');
    await writeFile(userPath, JSON.stringify({ schemaVersion: 1, codexModel: 'gpt-6-astra' }));
    assert.equal((await readDesktopSettings(packagePath, env)).codexModel, 'gpt-6-astra');
    await writeFile(userPath, '{broken');
    await assert.rejects(readDesktopSettings(packagePath, env), /desktop_invalid_user_settings/);
    await writeFile(userPath, 'null');
    await assert.rejects(readDesktopSettings(packagePath, env), /desktop_invalid_user_settings/);
    await writeFile(userPath, 'x'.repeat(65537));
    await assert.rejects(readDesktopSettings(packagePath, env), /desktop_invalid_settings/);
    assert.equal(await readFile(packagePath, 'utf8'), JSON.stringify(settings));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('Codex discovery reuses official installations before the bundled official CLI and keeps explicit choices strict', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'subtitle-software-codex-'));
  try {
    const env = { BILIBILI_SUBTITLE_HOME: join(temporary, 'shared'), LOCALAPPDATA: join(temporary, 'local'), PATH: '' };
    const bundled = join(env.BILIBILI_SUBTITLE_HOME, 'runtime', 'codex', 'codex.exe');
    await mkdir(join(env.BILIBILI_SUBTITLE_HOME, 'runtime', 'codex'), { recursive: true });
    await writeFile(bundled, 'official CLI fixture');
    assert.equal(await findCodexExecutable(settings, env), bundled);
    const official = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'existing', 'codex.exe');
    await mkdir(join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'existing'), { recursive: true });
    await writeFile(official, 'existing official CLI fixture');
    assert.equal(await findCodexExecutable(settings, env), official);
    await assert.rejects(findCodexExecutable({ ...settings, codexExecutable: join(temporary, 'missing.exe') }, env), /desktop_codex_executable_missing/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
function setup(overrides = {}) {
  const input = new PassThrough(), events = [], starts = [], closes = [];
  const done = runDesktopHost({ settings, input, emit: value => events.push(value), validatePaths: false,
    resolveCodexImpl: async () => 'existing-codex.exe', createGatewayImpl: async options => {
      starts.push(options);
      return { origin: 'http://127.0.0.1:12345', state: { selectedModel: options.codexModel, models: [{ slug: options.codexModel }], auth: 'authorized' },
        close: async () => { closes.push(1); } };
    }, ...overrides });
  return { input, events, starts, closes, done, send: command => input.write(JSON.stringify({ command }) + '\n') };
}

test('host waits for Job attachment start handshake, then reuses gateway without opening microphone', async () => {
  const host = setup(); await tick(); assert.equal(host.starts.length, 0);
  host.send('start'); await tick();
  assert.equal(host.starts.length, 1); assert.equal(host.starts[0].translationProvider, 'codex_resident');
  assert.equal(host.starts[0].codexModel, 'gpt-6-luna'); assert.equal(host.starts[0].port, 0);
  assert.equal(host.starts[0].replayFile, null);
  assert.equal(host.starts[0].contextUsageThreshold, 0.8);
  assert.equal(host.events[0].microphone, 'off_until_explicit_start');
  host.send('shutdown'); assert.equal(await host.done, 0); assert.equal(host.closes.length, 1);
});

test('stdin EOF before start creates no services and stops exactly once', async () => {
  const host = setup(); host.input.end(); assert.equal(await host.done, 0);
  assert.equal(host.starts.length, 0); assert.equal(host.events.filter(x => x.event === 'stopped').length, 1);
});

test('shutdown during gateway preparation waits for owned gateway and never emits ready', async () => {
  let resolveGateway, closed = 0;
  const preparing = new Promise(done => { resolveGateway = done; });
  const host = setup({ createGatewayImpl: () => preparing });
  host.send('start'); await tick(); host.send('shutdown'); await tick();
  resolveGateway({ state: {}, close: async () => { closed++; } });
  assert.equal(await host.done, 0); assert.equal(closed, 1); assert.equal(host.events.some(x => x.event === 'ready'), false);
});

test('startup errors stop cleanly and expose only a safe code', async () => {
  const host = setup({ createGatewayImpl: async () => { throw new Error('private token must not appear'); } });
  host.send('start'); assert.equal(await host.done, 1);
  assert.deepEqual(host.events.map(x => x.event), ['startup_failed', 'stopped']);
  assert.doesNotMatch(JSON.stringify(host.events), /private token/);
});

test('duplicate starts do not create duplicate services and EOF closes the owned gateway', async () => {
  const host = setup(); host.send('start'); host.send('start'); await tick();
  host.input.end(); assert.equal(await host.done, 0); assert.equal(host.starts.length, 1); assert.equal(host.closes.length, 1);
});

test('oversized control messages stop without evaluating commands or starting services', async () => {
  const host = setup(); host.input.write('x'.repeat(1025) + '\n'); assert.equal(await host.done, 1);
  assert.equal(host.starts.length, 0);
});

test('close failures are reported and release the control stream', async () => {
  const host = setup({ createGatewayImpl: async () => ({ origin: 'http://127.0.0.1:12345', state: { selectedModel: 'gpt-6-luna', models: [] },
    close: async () => { throw new Error('private close details'); } }) });
  host.send('start'); await tick(); host.send('shutdown'); assert.equal(await host.done, 1);
  assert.equal(host.events.some(x => x.event === 'shutdown_failed'), true);
  assert.doesNotMatch(JSON.stringify(host.events), /private close/);
});

test('settings reject relative paths and unsafe model identifiers without changing source settings', () => {
  assert.equal(validateSettings(settings).codexModel, 'gpt-6-luna');
  for (const change of [{ pythonExecutable: 'relative.exe' }, { modelDirectory: 'model' }, { codexModel: '--shell' },
    { codexServiceTier: 'untrusted' }, { schemaVersion: 0 }])
    assert.throws(() => validateSettings({ ...settings, ...change }), /desktop_invalid_settings/);
});

test('desktop fixes the production context threshold at 80% and does not expose a test override', async () => {
  const input = { ...settings, residentPolicy: { contextUsageThreshold: 0.8 } };
  assert.equal(validateSettings(input).residentPolicy.contextUsageThreshold, 0.8);
  for (const value of [null, 0, 0.001, 0.79, 0.81, 1, '0.8', true, NaN, Infinity])
    assert.throws(() => validateSettings({ ...settings, residentPolicy: { contextUsageThreshold: value } }), /desktop_invalid_settings/);
  assert.throws(() => validateSettings({ ...settings, residentPolicy: { testOnlyContextUsageThreshold: true } }), /desktop_invalid_settings/);
  const host = setup({ settings: input });
  host.send('start'); await tick();
  assert.equal(host.starts[0].contextUsageThreshold, 0.8);
  host.send('shutdown'); assert.equal(await host.done, 0);
});

test('optional replay configuration is an absolute startup path with no control characters and never mutates settings', () => {
  assert.equal(validateSettings(settings).replayFile, null);
  assert.equal(validateSettings({ ...settings, replayFile: null }).replayFile, null);
  const replayFile = resolve('public recordings', 'short Japanese.wav');
  const value = { ...settings, replayFile };
  assert.equal(validateSettings(value).replayFile, replayFile); assert.deepEqual(value, { ...settings, replayFile });
  for (const invalid of ['', 'relative.wav', {}, 1, false, ...['\n', '\r', '\0', '\t', '\x1f', '\x7f', '\x85'].map(character => resolve('sample') + character + '.wav')]) {
    assert.throws(() => validateSettings({ ...settings, replayFile: invalid }), /desktop_invalid_settings/);
  }
  if (process.platform === 'win32') for (const replayFile of ['\\current-drive-relative.wav', '/current-drive-relative.wav', 'C:drive-relative.wav']) {
    assert.throws(() => validateSettings({ ...settings, replayFile }), /desktop_invalid_settings/);
  }
});

test('configured replay is passed only after the explicit host start handshake and does not auto-start capture', async () => {
  const replayFile = resolve('controlled-short.wav'), host = setup({ settings: { ...settings, replayFile } });
  await tick(); assert.equal(host.starts.length, 0);
  host.send('start'); await tick();
  assert.equal(host.starts.length, 1); assert.equal(host.starts[0].replayFile, replayFile);
  assert.equal(host.events[0].microphone, 'off_until_explicit_start');
  assert.equal('source' in host.starts[0], false); assert.equal('device' in host.starts[0], false);
  host.send('shutdown'); assert.equal(await host.done, 0);
});

test('isolated enhancement assets and captured replay IDs are optional validated settings and remain passive', async () => {
  const enhancementAssets = resolve('isolated-enhancement-assets'), capturedReplayFiles = { mic50: resolve('saved-microphone.wav') };
  const input = { ...settings, enhancementAssets, capturedReplayFiles };
  const validated = validateSettings(input);
  assert.equal(validateSettings(settings).enhancementAssets, null);
  assert.deepEqual(Object.keys(validateSettings(settings).capturedReplayFiles), []);
  assert.equal(validated.enhancementAssets, enhancementAssets); assert.equal(validated.capturedReplayFiles.mic50, capturedReplayFiles.mic50);
  validated.capturedReplayFiles.mic50 = resolve('different.wav'); assert.notEqual(validated.capturedReplayFiles.mic50, input.capturedReplayFiles.mic50);
  for (const change of [{ enhancementAssets: 'relative' }, { enhancementAssets: {} }, { enhancementAssets: '' },
    { capturedReplayFiles: null }, { capturedReplayFiles: [] }, { capturedReplayFiles: { '../id': resolve('a.wav') } },
    { capturedReplayFiles: { mic: 'relative.wav' } }, { capturedReplayFiles: { mic: resolve('a.mp3') } }])
    assert.throws(() => validateSettings({ ...settings, ...change }), /desktop_invalid_settings/);
  const host = setup({ settings: input }); await tick(); assert.equal(host.starts.length, 0);
  host.send('start'); await tick();
  assert.equal(host.starts[0].enhancementAssets, enhancementAssets); assert.equal(host.starts[0].capturedReplayFiles.mic50, capturedReplayFiles.mic50);
  assert.equal('enhancement' in host.starts[0], false, 'settings do not silently select or activate enhancement');
  host.send('shutdown'); assert.equal(await host.done, 0);
});

test('configured enhancement directories and captured WAVs are checked before CLI resolution or service startup', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'subtitle-desktop-enhancement-'));
  try {
    const pythonExecutable = join(temporary, 'python.exe'), modelDirectory = join(temporary, 'model');
    await writeFile(pythonExecutable, 'test fixture'); await mkdir(modelDirectory);
    for (const name of ['model.bin', 'download-manifest.json']) await writeFile(join(modelDirectory, name), 'test fixture');
    const config = { ...settings, pythonExecutable, modelDirectory, dataDirectory: join(temporary, 'data') };
    for (const [change, code] of [[{ enhancementAssets: join(temporary, 'missing-assets') }, 'desktop_enhancement_assets_missing'],
      [{ enhancementAssets: pythonExecutable }, 'desktop_enhancement_assets_missing'],
      [{ capturedReplayFiles: { mic: join(temporary, 'missing.wav') } }, 'desktop_captured_replay_file_missing']]) {
      const host = setup({ settings: { ...config, ...change }, validatePaths: true,
        resolveCodexImpl: () => assert.fail('bad audio inputs must fail before CLI resolution') });
      host.send('start'); assert.equal(await host.done, 1);
      assert.deepEqual(host.events, [{ event: 'startup_failed', code }, { event: 'stopped', exitCode: 1 }]);
      assert.equal(host.starts.length, 0);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('path validation requires a real configured replay file and fails safely before resolving CLI or starting a gateway', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'subtitle-desktop-replay-'));
  try {
    const pythonExecutable = join(temporary, 'python.exe'), modelDirectory = join(temporary, 'model');
    await writeFile(pythonExecutable, 'test fixture only'); await mkdir(modelDirectory);
    for (const name of ['model.bin', 'download-manifest.json']) await writeFile(join(modelDirectory, name), 'test fixture only');
    const configured = { ...settings, pythonExecutable, modelDirectory, dataDirectory: join(temporary, 'data') };
    for (const replayFile of [join(temporary, 'missing.wav'), modelDirectory]) {
      let cliResolutions = 0;
      const host = setup({ settings: { ...configured, replayFile }, validatePaths: true,
        resolveCodexImpl: async () => { cliResolutions++; assert.fail('invalid replay must fail before CLI resolution'); } });
      host.send('start'); assert.equal(await host.done, 1);
      assert.equal(cliResolutions, 0); assert.equal(host.starts.length, 0);
      assert.deepEqual(host.events, [{ event: 'startup_failed', code: 'desktop_replay_file_missing' }, { event: 'stopped', exitCode: 1 }]);
      assert.doesNotMatch(JSON.stringify(host.events), /missing\.wav|private/);
    }
    const replayFile = join(temporary, 'present.wav'); await writeFile(replayFile, 'test file only; not decoded in this mock');
    const host = setup({ settings: { ...configured, replayFile }, validatePaths: true });
    host.send('start');
    for (let i = 0; i < 100 && host.starts.length === 0; i++) await new Promise(done => setTimeout(done, 5));
    assert.equal(host.starts.length, 1); assert.equal(host.starts[0].replayFile, replayFile);
    host.send('shutdown'); assert.equal(await host.done, 0);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
