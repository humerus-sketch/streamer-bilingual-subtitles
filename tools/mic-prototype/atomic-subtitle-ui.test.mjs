import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';

const ui = await readFile(new URL('./ui.html', import.meta.url), 'utf8');
const script = ui.match(/<script>([\s\S]+)<\/script>/)[1];
const displaySource = script.match(/\/\/ SUBTITLE_DISPLAY_STATE_START[^\r\n]*\r?\n([\s\S]+?)\/\/ SUBTITLE_DISPLAY_STATE_END/)[1];
const displayApi = new Script(`${displaySource}\n({isCompleteBilingualRow,createSubtitleDisplayState})`).runInNewContext();
const speakerSource = script.match(/\/\/ SPEAKER_ADMISSION_UI_START[^\r\n]*\r?\n([\s\S]+?)\/\/ SPEAKER_ADMISSION_UI_END/)[1];
const speakerState = new Script(`${speakerSource}\nspeakerAdmissionUiState`).runInNewContext();
const tick = () => new Promise(done => setImmediate(done));
const row = (extra = {}) => ({ workerSessionId: 'test-session', segmentId: 1, revision: 1, terminal: true,
  status: 'completed', visibleEligible: true, orderedAtNodeMs: 50, ja: 'こんにちは。',
  translation: { zh: '你好。', en: 'Hello.' }, ...extra });
const state = () => ({ provider: 'codex_resident', auth: 'authorized', phase: 'running', session: { id: 'test-session' },
  speakerAdmission: { available: true, status: 'ready', enrolled: true, enrollment: { active: false } },
  selectedModel: 'model-a', modelSelectionRevision: 0, models: [{ slug: 'model-a' }, { slug: 'model-b' }], queue: {}, rows: [] });

function makeBrowser() {
  const nodes = new Map(), frames = [], mutations = [], appended = [], listeners = new Map();
  let now = 0;
  class Node {
    constructor(name) { this.name = name; this.dataset = {}; this.value = ''; this.options = []; this.checked = false;
      this.text = ''; this.writes = []; this.children = new Map(); this.disabled = false; this.open = false; }
    set textContent(value) { this.text = value; this.writes.push(value); }
    get textContent() { return this.text; }
    add(option) { this.options.push(option); }
    replaceChildren(...children) { this.options = children; }
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Node(selector)); return this.children.get(selector); }
    cloneNode() { return new Node('subtitle-card'); }
    append(element) { appended.push({ element, zh: element.querySelector('.zh').textContent, en: element.querySelector('.en').textContent }); }
    remove() { this.removed = true; }
    scrollIntoView() { this.scrolled = true; }
    getBoundingClientRect() { return { top: 100, left: 20, right: 480, bottom: 180, width: 460, height: 80 }; }
  }
  const document = { hidden: false, visibilityState: 'visible', hasFocus: () => true,
    querySelector(selector) { if (selector === '#rows .empty') return null;
      if (!nodes.has(selector)) { const node = new Node(selector); if (selector === '#speakerAdmissionEnabled') node.checked = true; if (selector === '#row-template') node.content = { firstElementChild: new Node('template') }; nodes.set(selector, node); }
      return nodes.get(selector); },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); }
  };
  const context = createContext({ document, window: { addEventListener() {}, innerWidth: 1000, innerHeight: 800,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
    performance: { now: () => now, timeOrigin: 0 },
    fetch: async (path, options) => {
      if (path === '/clock') return { ok: true, json: async () => ({ nodeMs: now + 100 }) };
      if (path === '/page-status') return { ok: true, json: async () => ({ accepted: true }) };
      if (path === '/devices') return { ok: true, json: async () => ({ devices: [] }) };
      mutations.push({ path, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ accepted: true, outputDir: 'test-output' }) };
    },
    EventSource: class {}, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    requestAnimationFrame: callback => frames.push(callback), setInterval() {}, setTimeout() {}, queueMicrotask, console
  });
  new Script(`${script}\nglobalThis.testing={updateRow,updateState,rows,elements,pageTiming};`).runInContext(context);
  document.querySelector('#compute').value = 'float16';
  document.querySelector('#concurrency').value = '1';
  return { testing: context.testing, nodes, document, appended, frames, mutations,
    frame() { assert.ok(frames.length); now += 16; frames.shift()(now); },
    show() { document.hidden = false; document.visibilityState = 'visible'; for (const callback of [...listeners.get('visibilitychange') ?? []]) callback(); }
  };
}

test('only strict ordered terminal rows with both nonempty languages qualify', () => {
  assert.equal(displayApi.isCompleteBilingualRow(row()), true);
  for (const extra of [{ terminal: false }, { status: 'queued' }, { status: 'failed' }, { status: 'rejected' },
    { visibleEligible: false }, { orderedAtNodeMs: null }, { orderedAtNodeMs: NaN },
    { translation: { zh: '你好。' } }, { translation: { zh: ' ', en: 'Hello.' } }, { translation: { zh: '你好。', en: '' } }]) {
    assert.equal(displayApi.isCompleteBilingualRow(row(extra)), false, JSON.stringify(extra));
  }
});

test('partial, rejected and failed rows remain counted diagnostics without subtitle DOM or ACK', async () => {
  const browser = makeBrowser(); await tick(); browser.testing.updateState(state());
  const cases = [row({ terminal: false, status: 'recognizing', visibleEligible: false, translation: null }),
    row({ terminal: false, status: 'queued', visibleEligible: false, translation: null }),
    row({ terminal: false, status: 'translating', visibleEligible: false, translation: { zh: '你好。' } }),
    row({ visibleEligible: false, orderedAtNodeMs: null }), row({ status: 'failed', errorCode: 'translation_failed' }),
    row({ status: 'rejected', errorCode: 'speaker_not_admitted', translation: null }), row({ status: 'gap', translation: null })];
  cases.forEach((entry, index) => browser.testing.updateRow({ ...entry, segmentId: index + 1 })); await tick();
  assert.equal(browser.appended.length, 0); assert.equal(browser.frames.length, 0); assert.equal(browser.testing.rows.size, 7);
  assert.match(browser.nodes.get('#stats').textContent, /完整双语 0；失败 1；缺口 1；未准入 1/);
  assert.match(browser.nodes.get('#stats').textContent, /0\/7/);
  assert.match(browser.nodes.get('#segmentDiagnostics').textContent, /speaker_not_admitted/);
  assert.match(browser.nodes.get('#segmentDiagnostics').textContent, /こんにちは/);
  assert.equal(browser.mutations.filter(value => value.path === '/visible').length, 0);
});

test('ordered completion attaches one fully populated pair and duplicate SSE never rewrites subtitles', async () => {
  const browser = makeBrowser(); await tick(); browser.testing.updateState(state());
  browser.testing.updateRow(row({ visibleEligible: false, orderedAtNodeMs: null })); assert.equal(browser.appended.length, 0);
  browser.testing.updateRow(row()); await tick(); assert.equal(browser.appended.length, 1);
  assert.deepEqual([browser.appended[0].zh, browser.appended[0].en], ['你好。', 'Hello.']);
  browser.testing.updateRow(row({ visibleNodeMs: 140 })); browser.testing.updateRow(row({ terminal: false, status: 'queued', visibleEligible: false }));
  assert.equal(browser.appended.length, 1); assert.equal(browser.appended[0].element.querySelector('.zh').writes.length, 1);
  assert.equal(browser.testing.rows.get('1:1').status, 'completed');
  const mutations = browser.testing.pageTiming.snapshot().entries.filter(value => value.stage === 'dom_bilingual_mutated');
  assert.equal(mutations.length, 1);
  const template = ui.match(/<template id="row-template">([\s\S]+?)<\/template>/)[1];
  assert.ok(template.indexOf('class="ja metrics"') > template.indexOf('<details'));
});

test('new revision replaces the prior complete card and ignores older revisions and foreign sessions', async () => {
  const browser = makeBrowser(); await tick(); browser.testing.updateState(state());
  browser.testing.updateRow(row({ visibleNodeMs: 140 }));
  browser.testing.updateRow(row({ revision: 2, visibleNodeMs: 150, translation: { zh: '修订译文。', en: 'Revised translation.' } }));
  browser.testing.updateRow(row({ visibleNodeMs: 145 })); browser.testing.updateRow(row({ workerSessionId: 'old-session', segmentId: 2 }));
  assert.equal(browser.appended.length, 2); assert.equal(browser.appended[0].element.removed, true);
  assert.equal(browser.testing.elements.size, 1); assert.equal(browser.testing.elements.has('1:2'), true);
  assert.equal(browser.testing.rows.size, 2); assert.equal(browser.appended[1].zh, '修订译文。');
});

test('completed pair stays immutable when later metadata contains inconsistent text', () => {
  const display = displayApi.createSubtitleDisplayState(); display.reset('test-session'); display.accept(row());
  const result = display.accept(row({ visibleNodeMs: 160, translation: { zh: '不一致', en: 'changed' } }));
  assert.equal(result.render, false); assert.equal(result.row.visibleNodeMs, 160);
  assert.deepEqual(JSON.parse(JSON.stringify(result.row.translation)), { zh: '你好。', en: 'Hello.' });
  display.reset('new-session'); assert.equal(display.accept(row()).accepted, false);
});

test('real display ACK still requires visible document, two frames and a complete pair', async () => {
  const browser = makeBrowser(); await tick(); browser.testing.updateState(state());
  browser.document.hidden = true; browser.document.visibilityState = 'hidden';
  browser.testing.updateRow(row()); await tick(); assert.equal(browser.frames.length, 0);
  assert.equal(browser.mutations.filter(value => value.path === '/visible').length, 0);
  browser.show(); await tick(); browser.frame(); assert.equal(browser.mutations.filter(value => value.path === '/visible').length, 0);
  browser.frame(); await tick();
  const ack = browser.mutations.filter(value => value.path === '/visible'); assert.equal(ack.length, 1);
  assert.equal(ack[0].body.visibilityProof.documentHidden, false); assert.equal(ack[0].body.visibilityProof.animationFrames, 2);
  assert.equal(ack[0].body.visibilityProof.bothFullyInViewport, true); assert.ok(ack[0].body.visibleNodeMs >= 132);
});

test('all capture entry points explicitly disable enhancement and default to float16 without locking the model', async () => {
  assert.doesNotMatch(ui, /id="enhancement"/);
  assert.match(ui, /id="compute"><option value="float16">/);
  const concurrency = ui.match(/<select id="concurrency">([\s\S]+?)<\/select>/)[1];
  assert.match(concurrency, /<option value="1">/); assert.doesNotMatch(concurrency, /value="2"/);
  assert.match(ui, /参考前句译文，完整双语一次显示/);
  const browser = makeBrowser(); await tick(); browser.testing.updateState(state());
  browser.document.querySelector('#device').value = '9'; browser.document.querySelector('#capturedReplay').value = 'saved-mic';
  // A stale or injected enhancement value cannot affect any request.
  browser.document.querySelector('#enhancement').value = 'rnnoise';
  for (const selector of ['#start', '#replay', '#capturedReplayStart']) await browser.nodes.get(selector).onclick();
  const starts = browser.mutations.filter(value => value.path === '/start'); assert.equal(starts.length, 3);
  for (const start of starts) { assert.equal(start.body.enhancement, 'off'); assert.equal(start.body.speakerAdmission, true); assert.equal(start.body.computeType, 'float16'); assert.equal(start.body.concurrency, 1); assert.equal(start.body.model, 'model-a'); }
  assert.equal(starts[2].body.source, 'captured_replay'); assert.equal(starts[2].body.replayId, 'saved-mic');
  browser.testing.updateState({ ...state(), workerActive: true }); assert.equal(browser.nodes.get('#model').disabled, false);
});

test('speaker admission is enabled by default and missing or unavailable profiles fail closed', () => {
  assert.match(ui, /id="speakerAdmissionEnabled" type="checkbox" checked/);
  for (const speakerAdmission of [undefined, { available: false, status: 'ready', enrolled: true },
    { available: true, status: 'missing', enrolled: false }, { available: true, status: 'failed', enrolled: true },
    { available: true, status: 'ready', enrolled: false }]) {
    assert.equal(speakerState({ speakerAdmission }, true).blocked, true);
    assert.equal(speakerState({ speakerAdmission }, false).blocked, false, 'only an explicit disabled checkbox bypasses the gate');
  }
  assert.equal(speakerState(state(), true).blocked, false);
});

test('enrollment requires a selected microphone and an explicit click but no cloud login', async () => {
  const browser = makeBrowser(); await tick();
  const missing = { ...state(), auth: 'unauthorized', speakerAdmission: { available: true, status: 'missing', enrolled: false } };
  browser.testing.updateState(missing); assert.equal(browser.nodes.get('#speakerEnroll').disabled, true);
  browser.document.querySelector('#device').value = '9'; browser.testing.updateState(missing);
  assert.equal(browser.nodes.get('#speakerEnroll').disabled, false); assert.equal(browser.nodes.get('#start').disabled, true);
  assert.equal(browser.mutations.length, 0, 'neither page startup nor state updates may start enrollment');
  await browser.nodes.get('#speakerEnroll').onclick();
  assert.deepEqual(browser.mutations, [{ path: '/speaker/enroll', body: { device: 9, seconds: 25 } }]);
  assert.match(browser.nodes.get('#message').textContent, /登记已启动/);
});

test('missing profile blocks capture until explicit opt-out and shows the unprotected-input warning', async () => {
  const browser = makeBrowser(); await tick(); browser.document.querySelector('#device').value = '9';
  const missing = { ...state(), replayAvailable: true, capturedReplayOptions: [{ id: 'micA' }],
    speakerAdmission: { available: true, status: 'missing', enrolled: false } };
  browser.testing.updateState(missing); browser.document.querySelector('#capturedReplay').value = 'micA'; browser.testing.updateState(missing);
  for (const selector of ['#start', '#replay', '#capturedReplayStart']) assert.equal(browser.nodes.get(selector).disabled, true);
  assert.match(browser.nodes.get('#speakerWarning').textContent, /先选择麦克风，登记本人声音/);
  browser.nodes.get('#speakerAdmissionEnabled').checked = false; browser.nodes.get('#speakerAdmissionEnabled').onchange();
  for (const selector of ['#start', '#replay', '#capturedReplayStart']) assert.equal(browser.nodes.get(selector).disabled, false);
  assert.match(browser.nodes.get('#speakerWarning').textContent, /声纹门槛未开启/);
  await browser.nodes.get('#start').onclick(); assert.equal(browser.mutations[0].body.speakerAdmission, false);
});

test('enrollment is mutually exclusive with normal capture and exposes cancel plus read-only progress', async () => {
  const browser = makeBrowser(); await tick(); browser.document.querySelector('#device').value = '9';
  browser.testing.updateState({ ...state(), speakerAdmission: { available: true, status: 'enrolling', enrolled: false,
    enrollment: { active: true, voicedMs: 3600, elapsedMs: 5000, reason: null } } });
  for (const selector of ['#start', '#replay', '#capturedReplayStart', '#device', '#compute', '#speakerEnroll', '#speakerRefresh', '#speakerAdmissionEnabled']) assert.equal(browser.nodes.get(selector).disabled, true, selector);
  assert.equal(browser.nodes.get('#speakerEnrollCancel').disabled, false);
  assert.match(browser.nodes.get('#speakerStatus').textContent, /3\.600 秒.*5\.000 秒/);
  await browser.nodes.get('#speakerEnrollCancel').onclick(); assert.deepEqual(browser.mutations, [{ path: '/speaker/enroll/cancel', body: {} }]);
});

test('local refresh never opens audio and exposes score and threshold without editable controls', async () => {
  const browser = makeBrowser(); await tick(); browser.testing.updateState({ ...state(),
    speakerAdmission: { ...state().speakerAdmission, latestDecision: { decision: 'reject', reason: 'speaker_mismatch', score: 0.42, threshold: 0.65, voicedMs: 2100, gateMs: 12 } } });
  await browser.nodes.get('#speakerRefresh').onclick(); assert.deepEqual(browser.mutations, [{ path: '/speaker/refresh', body: {} }]);
  assert.match(browser.nodes.get('#speakerDiagnostics').textContent, /speaker_mismatch/);
  assert.match(browser.nodes.get('#speakerDiagnostics').textContent, /0\.420；阈值：0\.650/);
  assert.doesNotMatch(ui, /<(?:input|select)[^>]+id="(?:speakerThreshold|speakerScore)"/);
});
