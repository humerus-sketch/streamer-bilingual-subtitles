import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';

const ui = await readFile(new URL('./ui.html', import.meta.url), 'utf8');
const script = ui.match(/<script>([\s\S]+)<\/script>/)[1];
const selectionSource = script.match(/\/\/ MODEL_SELECTION_STATE_START[^\r\n]*\r?\n([\s\S]+?)\/\/ MODEL_SELECTION_STATE_END/)[1];
const createSelection = new Script(`${selectionSource}\ncreateModelSelectionState`).runInNewContext();
const catalog = [
  { slug: 'model-a', display_name: 'Model A' },
  { slug: 'model-b', display_name: 'Model B' },
  { slug: 'model-c', display_name: 'Model C' }
];
const serviceState = (selectedModel = 'model-a', modelSelectionRevision = 0, extra = {}) => ({
  provider: 'codex_resident', selectedModel, modelSelectionRevision, models: catalog,
  speakerAdmission: { available: true, status: 'ready', enrolled: true, enrollment: { active: false } }, ...extra
});
const tick = () => new Promise(done => setImmediate(done));

test('pending choice survives old SSE and acknowledged revisions reject stale selections', () => {
  const selection = createSelection();
  selection.sync(serviceState());
  assert.equal(selection.begin('model-b'), true);
  assert.equal(selection.sync(serviceState()).selected, 'model-b');
  selection.complete({ selectedModel: 'model-b', modelSelectionRevision: 1 });
  assert.equal(selection.sync(serviceState()).selected, 'model-b');
  assert.equal(selection.sync(serviceState('model-b', 1)).selected, 'model-b');
  assert.equal(selection.sync(serviceState('model-c', 2)).selected, 'model-c');
  assert.equal(selection.sync(serviceState('model-b', 1)).selected, 'model-c');
  assert.equal(selection.begin('model-c'), false);
});

test('failed switch restores latest server-confirmed model and records failure', () => {
  const selection = createSelection();
  selection.sync(serviceState());
  selection.begin('model-b');
  selection.sync(serviceState('model-c', 1));
  selection.reject('translation_model_not_available');
  assert.equal(selection.snapshot().selected, 'model-c');
  assert.equal(selection.snapshot().error, 'translation_model_not_available');
  assert.equal(selection.snapshot().pending, null);
});

test('missing requested model is shown as unavailable without selecting another model', () => {
  const selection = createSelection();
  const unavailable = selection.sync(serviceState('private-or-removed-model'));
  assert.equal(unavailable.selected, 'private-or-removed-model');
  assert.equal(unavailable.available, false);
  assert.throws(() => selection.begin('unknown-model'), /translation_model_not_available/);
  selection.begin('model-b');
  assert.throws(() => selection.begin('model-c'), /translation_model_change_pending/);
  selection.complete({ selectedModel: 'model-b', modelSelectionRevision: 1 });
  assert.equal(selection.snapshot().available, true);
});

test('legacy SIWC selection is local and does not assume a GPT model slug', () => {
  const selection = createSelection();
  selection.sync({ provider: 'siwc', models: [{ slug: 'legacy-a' }, { slug: 'legacy-b', is_default: true }] });
  assert.equal(selection.snapshot().selected, 'legacy-b');
  selection.chooseLocal('legacy-a');
  assert.equal(selection.sync({ provider: 'siwc', models: [{ slug: 'legacy-a' }, { slug: 'legacy-b' }] }).selected, 'legacy-a');
});

function browserHarness({ inventory = [], deviceReply = null } = {}) {
  const nodes = new Map(), mutations = [];
  let finishPost;
  const document = {
    hidden: false, visibilityState: 'visible', hasFocus: () => true,
    addEventListener() {}, removeEventListener() {},
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {
        textContent: '', className: '', dataset: {}, value: '', disabled: false, options: [], checked: selector === '#speakerAdmissionEnabled',
        replaceChildren(...values) { this.options = values; }, add(value) { this.options.push(value); }
      });
      return nodes.get(selector);
    }
  };
  const context = createContext({
    document, window: { addEventListener() {}, innerWidth: 1000, innerHeight: 800 },
    performance: { now: () => 0, timeOrigin: 0 },
    fetch: async (path, options) => {
      if (path === '/clock') return { ok: true, json: async () => ({ nodeMs: 0 }) };
      if (path === '/page-status') return { ok: true, json: async () => ({ accepted: true }) };
      if (path === '/devices') return deviceReply ? deviceReply() : { ok: true, json: async () => ({ devices: inventory }) };
      mutations.push({ path, headers: options.headers, body: JSON.parse(options.body) });
      return new Promise(done => { finishPost = done; });
    },
    EventSource: class {}, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    setInterval() {}, setTimeout() {}, queueMicrotask, console
  });
  new Script(`${script}\nglobalThis.testing={updateState,modelSelection,refreshDevices,stream,message};`).runInContext(context);
  return {
    nodes, mutations, testing: context.testing,
    finish(result, ok = true) { finishPost({ ok, json: async () => result }); }
  };
}

test('running UI permits explicit model change with capability header, without SSE reposts', async () => {
  const browser = browserHarness();
  await tick();
  const running = serviceState('model-a', 0, { auth: 'authorized', workerActive: true, phase: 'running', queue: { active: 1, pending: 1 } });
  browser.testing.updateState(running);
  assert.equal(browser.nodes.get('#model').disabled, false);
  assert.equal(browser.nodes.get('#compute').disabled, true);
  browser.nodes.get('#model').value = 'model-b';
  const switching = browser.nodes.get('#model').onchange();
  await tick();
  assert.equal(browser.nodes.get('#model').disabled, true);
  browser.testing.updateState(running);
  assert.equal(browser.nodes.get('#model').value, 'model-b');
  assert.deepEqual(JSON.parse(JSON.stringify(browser.mutations)), [{
    path: '/api/translation-model',
    headers: { 'content-type': 'application/json', 'x-prototype-capability': '__CAPABILITY__' },
    body: { model: 'model-b' }
  }]);
  browser.finish({ selectedModel: 'model-b', modelSelectionRevision: 1 });
  await switching;
  browser.testing.updateState(running);
  assert.equal(browser.nodes.get('#model').value, 'model-b');
  assert.equal(browser.nodes.get('#model').disabled, false);
  assert.equal(browser.mutations.length, 1);
  assert.match(browser.nodes.get('#message').textContent, /已排队任务保留原模型/);
});

test('enhancement controls are absent while translation model hot switching remains available', async () => {
  const browser = browserHarness(); await tick();
  const idle = serviceState('model-a', 0, { auth: 'authorized', enhancementAssetsConfigured: true });
  browser.testing.updateState(idle);
  assert.doesNotMatch(ui, /id="enhancement"/); assert.equal(browser.nodes.has('#enhancement'), false);
  assert.equal(browser.mutations.length, 0, 'state changes never open audio');
  const running = { ...idle, workerActive: true, session: { enhancement: 'rnnoise' } };
  browser.testing.updateState(running);
  assert.equal(browser.nodes.get('#model').disabled, false);
  assert.equal(browser.nodes.has('#enhancement'), false); assert.equal(browser.mutations.length, 0);
});

test('captured replay UI requires an explicit configured ID and disables enhancement with speaker admission explicit', async () => {
  const browser = browserHarness(); await tick();
  browser.testing.updateState(serviceState('model-a', 0, { auth: 'authorized', enhancementAssetsConfigured: true,
    capturedReplayOptions: [{ id: 'micA', label: '麦克风录音A' }] }));
  assert.equal(browser.nodes.get('#capturedReplay').value, ''); assert.equal(browser.nodes.get('#capturedReplayStart').disabled, true);
  browser.nodes.get('#capturedReplay').value = 'micA'; browser.nodes.get('#capturedReplay').onchange();
  browser.nodes.get('#recordProcessed').checked = true;
  assert.equal(browser.nodes.get('#capturedReplayStart').disabled, false);
  const started = browser.nodes.get('#capturedReplayStart').onclick(); await tick();
  assert.equal(browser.mutations.length, 1);
  assert.equal(browser.mutations[0].path, '/start');
  assert.equal(browser.mutations[0].body.source, 'captured_replay'); assert.equal(browser.mutations[0].body.replayId, 'micA');
  assert.equal(browser.mutations[0].body.enhancement, 'off'); assert.equal(browser.mutations[0].body.speakerAdmission, true); assert.equal(browser.mutations[0].body.record, false);
  assert.equal(browser.mutations[0].body.recordProcessed, true);
  assert.equal('device' in browser.mutations[0].body, false); assert.equal('replayFile' in browser.mutations[0].body, false);
  browser.finish({ outputDir: 'mock-only' }); await started;
  assert.match(browser.nodes.get('#message').textContent, /已有麦克风录音.*未启动麦克风/);
});

test('failed UI change displays the error and restores actual selected model', async () => {
  const browser = browserHarness();
  await tick();
  browser.testing.updateState(serviceState());
  browser.nodes.get('#model').value = 'model-b';
  const switching = browser.nodes.get('#model').onchange();
  await tick();
  browser.finish({ error: 'translation_model_not_available' }, false);
  await switching;
  assert.equal(browser.nodes.get('#model').value, 'model-a');
  assert.equal(browser.nodes.get('#model').disabled, false);
  assert.match(browser.nodes.get('#modelStatus').textContent, /translation_model_not_available/);
  assert.equal(browser.nodes.get('#modelStatus').className, 'error');
});

test('catalog refresh retains missing configured slug and blocks capture until available', async () => {
  const browser = browserHarness();
  await tick();
  browser.testing.updateState(serviceState('removed-model', 0, { auth: 'authorized', selectionError: 'selected_model_not_visible' }));
  assert.equal(browser.nodes.get('#model').value, 'removed-model');
  assert.ok(browser.nodes.get('#model').options.some(option => option.value === 'removed-model'));
  assert.equal(browser.nodes.get('#start').disabled, true);
  assert.equal(browser.nodes.get('#model').disabled, false);
  assert.match(browser.nodes.get('#modelStatus').textContent, /selected_model_not_visible/);
});

test('login refresh state disables capture, authorization and model changes', async () => {
  const browser = browserHarness(); await tick();
  browser.nodes.get('#device').value = '0';
  browser.testing.updateState(serviceState('model-a', 0, { auth: 'authorized', authBusy: true }));
  for (const selector of ['#start', '#authorize', '#model', '#device']) assert.equal(browser.nodes.get(selector).disabled, true);
  browser.testing.updateState(serviceState('model-a', 0, { auth: 'authorized', authBusy: false }));
  for (const selector of ['#start', '#authorize', '#model', '#device']) assert.equal(browser.nodes.get(selector).disabled, false);
});

test('SSE reconnect clears only the connection error and preserves unrelated errors', async () => {
  const browser = browserHarness(); await tick();
  browser.testing.stream.onerror(); assert.match(browser.nodes.get('#message').textContent, /连接断开/);
  browser.testing.stream.onopen(); assert.match(browser.nodes.get('#message').textContent, /连接已恢复/);
  browser.testing.stream.onerror(); browser.testing.message('audio_device_unavailable', true);
  browser.testing.stream.onopen();
  assert.equal(browser.nodes.get('#message').textContent, 'audio_device_unavailable');
  assert.equal(browser.nodes.get('#message').className, 'error');
});

test('startup inventories once without selecting a microphone and refresh preserves only the same unique device', async () => {
  const inventory = [{ index: 3, name: 'My microphone', hostApi: 'Windows WASAPI', isWasapi: true, maxInputChannels: 1, defaultSampleRate: 48000 }];
  let requests = 0, release;
  const browser = browserHarness({ deviceReply: () => { requests++; return new Promise(done => { release = () => done({ ok: true, json: async () => ({ devices: inventory.map(device => ({ ...device })) }) }); }); } });
  assert.equal(requests, 1); assert.equal(browser.nodes.get('#devices').disabled, true);
  const duplicate = browser.testing.refreshDevices(); assert.equal(requests, 1);
  release(); await duplicate; await tick();
  assert.equal(browser.nodes.get('#devices').disabled, false);
  assert.equal(browser.nodes.get('#device').value, '');
  browser.nodes.get('#device').value = '3'; inventory[0].index = 8;
  const refresh = browser.testing.refreshDevices(); release(); await refresh;
  assert.equal(browser.nodes.get('#device').value, '8');
  inventory[0].name = 'A different microphone';
  const changed = browser.testing.refreshDevices(); release(); await changed;
  assert.equal(browser.nodes.get('#device').value, '');
  assert.equal(requests, 3);
  assert.equal(browser.mutations.length, 0, 'inventory must not start capture or request translation');
});

test('failed device inventory re-enables manual refresh without automatic retry', async () => {
  let requests = 0;
  const browser = browserHarness({ deviceReply: async () => { requests++; return { ok: false, json: async () => ({ error: 'device_inventory_failed' }) }; } });
  await tick(); assert.equal(requests, 1);
  assert.equal(browser.nodes.get('#devices').disabled, false);
  assert.equal(browser.nodes.get('#message').textContent, 'device_inventory_failed');
});

test('desktop controls and errors remain outside collapsed settings while advanced and measurement controls stay available', () => {
  const markup = ui.split('<script>')[0], stack = [], nodes = new Map();
  const voidTags = new Set(['meta', 'input', 'br', 'hr', 'img', 'link']);
  for (const match of markup.matchAll(/<(\/?)([a-z][\w:-]*)([^>]*)>/gi)) {
    const [, closing, rawTag, attributes] = match, tag = rawTag.toLowerCase();
    if (closing) { assert.equal(stack.pop()?.tag, tag, 'HTML structure must remain balanced'); continue; }
    const id = attributes.match(/\bid="([^"]+)"/)?.[1];
    const entry = { tag, id, collapsed: tag === 'details' && !/\bopen(?:\s|=|$)/.test(attributes) };
    if (id) { assert.equal(nodes.has(id), false, 'duplicate ID: ' + id); nodes.set(id, { ...entry, ancestors: [...stack] }); }
    if (!voidTags.has(tag)) stack.push(entry);
  }
  assert.deepEqual(stack.map(node => node.tag), ['html', 'body'], 'only the document wrapper may remain before the script');
  for (const id of ['device', 'model', 'start', 'stop', 'devices', 'authorize', 'auth', 'message', 'modelStatus', 'status']) {
    assert.ok(nodes.has(id), 'missing basic control: ' + id);
    assert.equal(nodes.get(id).ancestors.some(node => node.collapsed), false, 'basic control is collapsed: ' + id);
  }
  for (const id of ['compute', 'concurrency', 'record', 'replay', 'save', 'download', 'authHelp', 'modelHelp', 'outputPath', 'diagnosticStatus']) {
    assert.ok(nodes.get(id)?.ancestors.some(node => node.id === 'advanced-settings' && node.collapsed), 'advanced control missing from collapsed settings: ' + id);
  }
  for (const id of ['stats', 'downloadTiming', 'pageTimingJson']) {
    assert.ok(nodes.get(id)?.ancestors.some(node => node.id === 'test-methods' && node.collapsed), 'measurement control missing from collapsed diagnostics: ' + id);
  }
  assert.ok(markup.indexOf('id="start"') < markup.indexOf('id="advanced-settings"'));
  assert.ok(markup.indexOf('id="rows"') < markup.indexOf('id="test-methods"'));
  assert.match(markup, /<title>主播双语字幕<\/title>/);
  assert.match(markup, /<details class="evaluation"><summary>[^<]+<\/summary><p class="timing metrics">/);
});

test('compact desktop status keeps actual worker errors and warnings visible without requiring diagnostics expansion', async () => {
  const browser = browserHarness(); await tick();
  browser.testing.updateState(serviceState('model-a', 0, { auth: 'authorized', phase: 'worker_error',
    message: 'audio_device_unavailable', warnings: ['evidence_write_failed'] }));
  assert.equal(browser.nodes.get('#status').textContent, 'audio_device_unavailable\nevidence_write_failed');
  assert.match(browser.nodes.get('#diagnosticStatus').textContent, /阶段：worker_error/);
  assert.match(browser.nodes.get('#diagnosticStatus').textContent, /Worker 时钟误差界/);
});
