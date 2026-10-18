import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePageVisibilityProof } from './gateway.mjs';

const proof = () => ({ version: 1, documentHidden: false, focused: true, animationFrames: 2,
  bothFullyInViewport: true, viewport: { width: 1000, height: 800 }, targets: {
    zh: { top: 100, left: 20, right: 480, bottom: 180, width: 460, height: 80 },
    en: { top: 100, left: 520, right: 980, bottom: 180, width: 460, height: 80 } } });

test('viewport proof is projected to numeric geometry and never copies arbitrary client fields', () => {
  const input = { ...proof(), unexpected: 'private source' };
  input.targets.en.translation = 'private translation';
  const output = validatePageVisibilityProof(input);
  assert.deepEqual(output, proof());
  input.targets.en.top = 1000;
  assert.equal(output.targets.en.top, 100);
});

test('hidden pages, missing languages, invalid geometry and incomplete animation frames are rejected', () => {
  for (const mutate of [
    value => { value.documentHidden = true; },
    value => { value.animationFrames = 1; },
    value => { value.bothFullyInViewport = false; },
    value => { delete value.targets.en; },
    value => { value.targets.en.top = -1; },
    value => { value.targets.en.bottom = 900; },
    value => { value.targets.en.width = 0; },
    value => { value.targets.en.right = NaN; },
    value => { value.targets.en.width = 12; },
    value => { value.viewport.height = Infinity; }
  ]) {
    const input = proof(); mutate(input);
    assert.throws(() => validatePageVisibilityProof(input), error => error.safeCode === 'invalid_visibility_proof');
  }
});
