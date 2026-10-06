import test from 'node:test';
import assert from 'node:assert/strict';
import { articulationTargets } from '../src/services/visemeArticulation.js';

const syllables = [
  { viseme: 'viseme_aa', start: 0, end: 0.2 },
  { viseme: 'viseme_PP', start: 0.2, end: 0.28 },
  { viseme: 'viseme_O', start: 0.28, end: 0.55 },
];
test('quiet P/B/M closures remain closed rather than disappearing with volume', () => {
  const frame = articulationTargets(syllables, 0.23, 0.0001);
  assert.equal(frame.viseme, 'viseme_PP');
  assert.ok(frame.weights.viseme_PP >= 0.95);
  assert.equal(frame.weights.viseme_aa || 0, 0);
  assert.equal(frame.weights.viseme_O || 0, 0);
});

test('lips anticipate a bilabial closure while vowels blend only with actual neighbors', () => {
  const before = articulationTargets(syllables, 0.185, 0.12);
  assert.ok(before.weights.viseme_PP > 0.2);
  assert.equal(before.weights.viseme_FF || 0, 0);
  const rounded = articulationTargets(syllables, 0.4, 0.12);
  assert.equal(rounded.weights.viseme_O, 0.68);
  assert.equal(rounded.weights.viseme_aa || 0, 0);
});

test('vowels remain visible with audio while real pauses relax the mouth', () => {
  const speaking = articulationTargets(syllables, 0.1, 0.14);
  assert.ok(speaking.weights.viseme_aa > 0.5 && speaking.weights.viseme_aa < 0.9);
  assert.equal(articulationTargets(syllables, 0.1, 0).weights.viseme_sil, 1);
  assert.equal(articulationTargets(syllables, 0.8, 0.14).weights.viseme_sil, 1);
});

test('blends stay finite, normalized, and restricted to neighboring sound shapes', () => {
  for (let time = 0; time < 0.6; time += 1 / 120) {
    const { weights } = articulationTargets(syllables, time, 0.08);
    const active = Object.entries(weights).filter(([key]) => key !== 'viseme_sil').map(([, value]) => value);
    assert.ok(active.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(active.reduce((sum, value) => sum + value, 0) <= 1.00001);
  }
});
