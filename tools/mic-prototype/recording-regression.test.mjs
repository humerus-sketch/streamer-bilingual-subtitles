import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { freezeRound, mayContinueAfterRound } from './recording-regression.mjs';

const control = { sessionId: 'owned', passed: false, outputDir: '/recorded-run' };
const state = { phase: 'capture_stopped', workerActive: false, captureStarting: false, residentClosing: false,
  queue: { active: 0, pending: 0 } };

test('known empty-ASR baseline failures may be measured without relabelling them success', () => {
  const completed = { workerSessionId: 'owned', status: 'completed', terminal: true, orderedAtNodeMs: 100,
    translation: { zh: '完整中文', en: 'Complete English' },
    translationDiagnostics: { terminal_event: 'turn/completed', final_status: 'completed' } };
  const report = { session: { id: 'owned' }, rows: [completed, { status: 'gap', errorCode: 'empty_asr' }], warnings: [] };
  assert.equal(mayContinueAfterRound(control, report, state), true);
  assert.equal(control.passed, false);
  for (const row of [{ status: 'failed' }, { status: 'gap', errorCode: 'timeout' }, { status: 'recognizing' }]) {
    assert.equal(mayContinueAfterRound(control, { ...report, rows: [row] }, state), false);
  }
  assert.equal(mayContinueAfterRound(control, { ...report, session: { id: 'foreign' } }, state), false);
  assert.equal(mayContinueAfterRound(control, { ...report, warnings: ['evidence_write_failed'] }, state), false);
  assert.equal(mayContinueAfterRound(control, report, { ...state, workerActive: true }), false);
  assert.equal(mayContinueAfterRound(control, report, { ...state, phase: 'translation_paused' }), false);
  for (const altered of [{ ...completed, translation: { zh: 'only one' } }, { ...completed, terminal: false },
    { ...completed, orderedAtNodeMs: null }, { ...completed, workerSessionId: 'foreign' }]) {
    assert.equal(mayContinueAfterRound(control, { ...report, rows: [altered] }, state), false);
  }
});

test('automatic freezing preserves failed evidence bytes and never generates page acknowledgement fields', async () => {
  const stored = new Map();
  const result = await freezeRound({ folder: '/frozen', control, definition: { id: 'A1' }, failure: 'public_replay_chain_failed' }, {
    mkdirImpl: async () => {}, readFileImpl: async path => Buffer.from('original:' + path),
    writeFileImpl: async (path, value, options) => { assert.equal(options.flag, 'wx'); stored.set(path, value); },
  });
  assert.equal(result.driver_passed, false); assert.equal(result.failure, 'public_replay_chain_failed');
  assert.equal(result.page_required, false); assert.equal(result.microphone_opened, false);
  assert.equal(result.files.length, 3);
  for (const name of ['report.json', 'events.jsonl', 'session.json']) {
    assert.equal(stored.get(join('/frozen', name)).toString(), 'original:' + join('/recorded-run', name));
  }
  assert.ok(!('visibleNodeMs' in result));
});

test('existing frozen output is never replaced or silently retried', async () => {
  let reads = 0;
  await assert.rejects(() => freezeRound({ folder: '/exists', control, definition: { id: 'A1' } }, {
    mkdirImpl: async () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
    readFileImpl: async () => { reads++; }, writeFileImpl: async () => assert.fail('must not overwrite'),
  }), /EEXIST/);
  assert.equal(reads, 0);
});
