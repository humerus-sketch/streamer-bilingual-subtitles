import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviousTranslationContext } from './translation-context.mjs';

const entry = number => ({ workerSessionId: 'one', segmentId: number, revision: 1, ja: `原文${number}` });
test('explicit context contains only the prior final translation and never prior Japanese', () => {
  const context = createPreviousTranslationContext(), first = entry(1), second = entry(2);
  first.translationContext = context.admit(first);
  assert.equal(JSON.parse(context.contextFor(first)).previousTranslation, null);
  context.complete({ ...first, status: 'completed', terminal: true, translation: { zh: '先打开窗口。', en: 'Open the window first.' } });
  second.translationContext = context.admit(second);
  const sent = context.contextFor(second), decoded = JSON.parse(sent);
  assert.deepEqual(decoded.previousTranslation, { zh: '先打开窗口。', en: 'Open the window first.' });
  assert.equal(sent.includes(first.ja), false);
});
test('queued or partial predecessor cannot be passed as completed context', () => {
  const context = createPreviousTranslationContext(), first = entry(1), second = entry(2);
  first.translationContext = context.admit(first); second.translationContext = context.admit(second);
  assert.equal(context.complete({ ...first, status: 'translating', terminal: false, translation: { zh: '半句', en: 'partial' } }), false);
  assert.throws(() => context.contextFor(second), error => error.safeCode === 'previous_translation_not_complete');
});
test('gap/reset starts a new context chain without corrupting already admitted work', () => {
  const context = createPreviousTranslationContext(), first = entry(1), second = entry(2), third = entry(3);
  first.translationContext = context.admit(first); second.translationContext = context.admit(second);
  context.reset(); third.translationContext = context.admit(third);
  context.complete({ ...first, status: 'completed', terminal: true, translation: { zh: '完成', en: 'Done' } });
  assert.equal(JSON.parse(context.contextFor(second)).previousTranslation.en, 'Done');
  assert.equal(JSON.parse(context.contextFor(third)).previousTranslation, null);
});
test('a rotation or model switch does not erase the explicit previous final translation', () => {
  const context = createPreviousTranslationContext(), first = entry(1), second = { ...entry(2), requestedModel: { slug: 'different' } };
  first.translationContext = context.admit(first);
  context.complete({ ...first, status: 'completed', terminal: true, translation: { zh: '还没开始。', en: 'It has not started yet.' } });
  second.translationContext = context.admit(second);
  assert.equal(JSON.parse(context.contextFor(second)).previousTranslation.zh, '还没开始。');
});
