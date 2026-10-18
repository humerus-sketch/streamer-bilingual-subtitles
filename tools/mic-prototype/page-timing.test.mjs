import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';

const ui = await readFile(new URL('./ui.html', import.meta.url), 'utf8');
const script = ui.match(/<script>([\s\S]+)<\/script>/)[1];
const recorderSource = script.match(/\/\/ PAGE_TIMING_RECORDER_START[^\r\n]*\r?\n([\s\S]+?)\/\/ PAGE_TIMING_RECORDER_END/)[1];
const createRecorder = new Script(`${recorderSource}\ncreatePageTimingRecorder`).runInNewContext();
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(done => setImmediate(done));

test('recorder bounds retained entries and distinguishes missing clock from zero delay', () => {
  let now = 0;
  const recorder = createRecorder({ now: () => ++now, clock: () => null,
    visibility: () => ({ hidden: false, visibilityState: 'visible', focused: true }), timeOrigin: 123, limit: 3 });
  for (let i = 0; i < 5; i++) recorder.record('receipt', {}, { orderedAtNodeMs: 0 });
  const snapshot = plain(recorder.snapshot());
  assert.deepEqual(snapshot.entries.map(entry => entry.sequence), [3, 4, 5]);
  assert.equal(snapshot.droppedEvents, 2);
  assert.equal(snapshot.entries[0].nodeMs, null);
  assert.equal(snapshot.entries[0].sinceOrderedMs, null);
});

test('each stage captures its own clock mapping and real performance.now separately from rAF timestamp', () => {
  let now = 10, clock = { offsetMs: 100, uncertaintyMs: 0.5, rttMs: 1, syncedPerfMs: 5 };
  const recorder = createRecorder({ now: () => now, clock: () => clock,
    visibility: () => ({ hidden: false }), timeOrigin: 0 });
  const row = { workerSessionId: 'session', segmentId: 1, revision: 1, orderedAtNodeMs: 109 };
  recorder.record('sse_received', {}, row);
  now = 25;
  clock = { ...clock, offsetMs: 3100, syncedPerfMs: 20 };
  recorder.record('raf_2', { rafCallbackTimestamp: 21 }, row);
  const entries = plain(recorder.snapshot()).entries;
  assert.equal(entries[0].clockOffsetMs, 100);
  assert.equal(entries[0].sinceOrderedMs, 1);
  assert.equal(entries[1].perfMs - entries[0].perfMs, 15);
  assert.equal(entries[1].sinceOrderedMs, 3016);
  assert.equal(entries[1].clockAgeMs, 5);
  assert.equal(entries[1].rafCallbackTimestamp, 21);
});

async function browserHarness() {
  let now = 0;
  const elements = new Map(), listeners = new Map(), frames = [], mutations = [], scrolls = [];
  const boxes = { zh: { top: 100, left: 20, right: 480, bottom: 180, width: 460, height: 80 },
    en: { top: 100, left: 520, right: 980, bottom: 180, width: 460, height: 80 } };
  const targets = Object.fromEntries(['zh', 'en'].map(language => [language,
    { textContent: 'complete ' + language, getBoundingClientRect: () => boxes[language] }]));
  const subtitle = { querySelector: selector => selector === '.pair' ? { scrollIntoView: () => scrolls.push(now) } : targets[selector.slice(1)] };
  const document = {
    hidden: false, visibilityState: 'visible', hasFocus: () => true,
    querySelector: selector => {
      if (!elements.has(selector)) elements.set(selector, { textContent: '', className: '', dataset: {}, value: '', disabled: false, checked: selector === '#speakerAdmissionEnabled',
        replaceChildren() {}, add() {} });
      return elements.get(selector);
    },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); }
  };
  const context = createContext({ document, window: { addEventListener() {}, innerWidth: 1000, innerHeight: 800,
      getComputedStyle: node => node.style ?? { display: 'block', visibility: 'visible', opacity: '1' } },
    performance: { now: () => now, timeOrigin: 0 },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    fetch: async (path, options) => {
      if (path === '/clock') return { ok: true, json: async () => ({ nodeMs: now + 100 }) };
      if (path === '/page-status') return { ok: true, json: async () => ({ accepted: true }) };
      if (path === '/devices') return { ok: true, json: async () => ({ devices: [] }) };
      mutations.push({ path, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ accepted: true }) };
    },
    EventSource: class {}, Option: class { constructor(text,value) { this.text=text;this.value=value; } }, setInterval() {}, setTimeout() {}, queueMicrotask, console
  });
  new Script(`${script}\nglobalThis.testing={acknowledge,pageTiming,ackPending,updateState,setElement:(key,value)=>elements.set(key,value),setSession:value=>{if(currentSession!==value){currentSession=value;ackPending.clear();ackTail=Promise.resolve();}},setClock:value=>{browserClock=value;}};`).runInContext(context);
  await tick();
  context.testing.setSession('session');
  context.testing.setClock({ offsetMs: 100, uncertaintyMs: 0.5, rttMs: 1, syncedPerfMs: 0 });
  context.testing.setElement('1:1', subtitle);
  return {
    testing: context.testing, document, frames, mutations, boxes, targets, scrolls, subtitle,
    row: { workerSessionId: 'session', segmentId: 1, revision: 1, orderedAtNodeMs: 100 },
    frame(timestamp, actualNow) { now = actualNow; assert.ok(frames.length, 'a frame must have been requested'); frames.shift()(timestamp); },
    show(actualNow) { now = actualNow; document.hidden = false; document.visibilityState = 'visible'; for (const listener of [...listeners.get('visibilitychange') ?? []]) listener(); }
  };
}

test('ack is sent only after both rAF callbacks with unchanged mapped visible timestamp', async () => {
  const browser = await browserHarness();
  const completion = browser.testing.acknowledge(browser.row, '1:1');
  await tick();
  assert.equal(browser.mutations.length, 0);
  browser.frame(5, 7);
  assert.equal(browser.mutations.length, 0);
  browser.frame(21, 24);
  await completion;
  assert.deepEqual(browser.mutations, [{ path: '/visible', body: {
    sessionId: 'session', segmentId: 1, revision: 1, visibleNodeMs: 124, clockUncertaintyMs: 0.5,
    visibilityProof: { version: 1, documentHidden: false, focused: true, animationFrames: 2,
      viewport: { width: 1000, height: 800 }, targets: browser.boxes, bothFullyInViewport: true }
  } }]);
  const stages = plain(browser.testing.pageTiming.snapshot()).entries;
  assert.deepEqual(stages.filter(entry => ['ack_start', 'raf_requested', 'raf_1', 'raf_2', 'visible_post_send', 'visible_post_return'].includes(entry.stage)).map(entry => entry.stage),
    ['ack_start', 'raf_requested', 'raf_1', 'raf_2', 'visible_post_send', 'visible_post_return']);
  assert.equal(stages.find(entry => entry.stage === 'raf_2').perfMs, 24);
  assert.equal(stages.find(entry => entry.stage === 'raf_2').rafCallbackTimestamp, 21);
});

test('background waiting is separately traced and never acknowledges hidden content', async () => {
  const browser = await browserHarness();
  browser.document.hidden = true; browser.document.visibilityState = 'hidden';
  const completion = browser.testing.acknowledge(browser.row, '1:1');
  await tick();
  assert.equal(browser.frames.length, 0);
  assert.equal(browser.mutations.length, 0);
  browser.show(3000); await tick();
  browser.frame(3004, 3005); browser.frame(3020, 3021); await completion;
  const entries = plain(browser.testing.pageTiming.snapshot()).entries;
  assert.equal(entries.find(entry => entry.stage === 'hidden_wait_start').perfMs, 0);
  assert.equal(entries.find(entry => entry.stage === 'hidden_wait_end').perfMs, 3000);
  assert.equal(browser.mutations[0].body.visibleNodeMs, 3121);
});

test('session changes during paint waiting do not send stale acknowledgements', async () => {
  const browser = await browserHarness();
  const completion = browser.testing.acknowledge(browser.row, '1:1');
  await tick();
  browser.testing.setSession('new-session');
  browser.frame(5, 6); browser.frame(21, 22); await completion;
  assert.equal(browser.mutations.length, 0);
  assert.equal(browser.testing.ackPending.has('1:1'), false);
  assert.ok(plain(browser.testing.pageTiming.snapshot()).entries.some(entry => entry.stage === 'ack_stale_session'));
});

test('a complete language outside the viewport or hidden by CSS cannot acknowledge visibility', async () => {
  for (const kind of ['outside', 'hidden']) {
    const browser = await browserHarness();
    if (kind === 'outside') Object.assign(browser.boxes.en, { top: 900, bottom: 980 });
    else browser.targets.en.style = { display: 'block', visibility: 'hidden', opacity: '1' };
    const completion = browser.testing.acknowledge(browser.row, '1:1');
    await tick(); browser.frame(5, 6); browser.frame(21, 22); await completion;
    assert.equal(browser.mutations.length, 0);
    assert.equal(browser.testing.ackPending.has('1:1'), false);
    assert.ok(plain(browser.testing.pageTiming.snapshot()).entries.some(entry => entry.stage === 'ack_error'));
  }
});

test('two completed rows serialize viewport scrolling and painting before each real acknowledgement', async () => {
  const browser = await browserHarness();
  browser.testing.setElement('2:1', browser.subtitle);
  const first = browser.testing.acknowledge(browser.row, '1:1');
  const second = browser.testing.acknowledge({ ...browser.row, segmentId: 2 }, '2:1');
  await tick(); assert.equal(browser.scrolls.length, 1); assert.equal(browser.frames.length, 1);
  browser.frame(5, 6); browser.frame(21, 22); await first; await tick();
  assert.equal(browser.mutations.length, 1); assert.equal(browser.scrolls.length, 2);
  browser.frame(35, 36); browser.frame(51, 52); await second;
  assert.deepEqual(browser.mutations.map(value => value.body.segmentId), [1, 2]);
});

test('an old pending paint does not release a new session acknowledgement with the same row key', async () => {
  const browser = await browserHarness();
  const completion = browser.testing.acknowledge(browser.row, '1:1');
  await tick(); browser.testing.setSession('new-session');
  browser.testing.ackPending.add('1:1');
  browser.frame(5, 6); browser.frame(21, 22); await completion;
  assert.equal(browser.mutations.length, 0);
  assert.equal(browser.testing.ackPending.has('1:1'), true);
});

test('page diagnostic events do not copy recognized text, translation or capability', () => {
  assert.doesNotMatch(script.match(/function tracePage[\s\S]+?function publishPageTiming/)[0], /capability|translation|\.ja/);
  const recorder = createRecorder({ now: () => 10, clock: () => null, visibility: () => ({}), timeOrigin: 0 });
  recorder.record('dom_bilingual_mutated', {}, { workerSessionId: 'session', segmentId: 1, revision: 1,
    orderedAtNodeMs: 5, ja: 'private source', translation: { zh: 'private translation' }, capability: 'secret' });
  const serialized = JSON.stringify(recorder.snapshot());
  assert.doesNotMatch(serialized, /private|secret|translation|capability/);
});

test('both official CLI providers check saved login without entering SIWC authorization', async () => {
  for (const provider of ['codex_cli', 'codex_resident']) {
    const browser = await browserHarness();
    browser.testing.updateState({ provider, auth: 'authorized', models: [], queue: {}, rows: [] });
    await browser.document.querySelector('#authorize').onclick();
    assert.deepEqual(browser.mutations, [{ path: '/cli/check', body: {} }]);
    assert.equal(browser.document.querySelector('#authorize').textContent, '检查 CLI 登录');
    assert.match(browser.document.querySelector('#auth').textContent, /CLI 已登录 ChatGPT/);
    assert.equal(browser.document.querySelector('#auth').textContent.includes('持续会话'), provider === 'codex_resident');
  }
});

test('closing a resident process blocks new capture, replay and login checks until lifecycle finishes', async () => {
  const browser = await browserHarness();
  browser.document.querySelector('#device').value = '0';
  const state = { provider: 'codex_resident', auth: 'authorized', residentClosing: true, replayAvailable: true,
    speakerAdmission: { available: true, status: 'ready', enrolled: true, enrollment: { active: false } },
    selectedModel: 'gpt-6.1-sol', modelSelectionRevision: 0,
    models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT' }], queue: { active: 0, pending: 0, cleanup: 0 }, rows: [] };
  browser.testing.updateState(state);
  for (const selector of ['#start', '#replay', '#authorize', '#model', '#concurrency']) {
    assert.equal(browser.document.querySelector(selector).disabled, true, `${selector} must stay disabled during process closure`);
  }
  assert.match(browser.document.querySelector('#diagnosticStatus').textContent, /持续会话：正在关闭/);
  assert.doesNotMatch(browser.document.querySelector('#status').textContent, /CLI 收尾/);
  browser.testing.updateState({ ...state, residentClosing: false });
  for (const selector of ['#start', '#replay', '#authorize', '#model', '#concurrency']) {
    assert.equal(browser.document.querySelector(selector).disabled, false, `${selector} must unlock once closure is confirmed`);
  }
  assert.equal(browser.mutations.length, 0, 'state changes must never start capture or translation');
});
