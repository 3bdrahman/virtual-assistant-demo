import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisemeTimeline,
} from '../src/services/visemePronunciation.js';

const visemes = (items) => items.map((item) => item.viseme);
const phonemes = (items) => items.map((item) => item.phoneme);
const byWord = (items, word) => items.filter((item) => item.word === word);

test('pronunciation rules distinguish common English mouth shapes', () => {
  const timeline = buildVisemeTimeline('phone photo this thin shoe cat city face food book know wrong mom paper');

  assert.deepEqual(visemes(byWord(timeline, 'phone')), ['viseme_FF', 'viseme_O', 'viseme_U', 'viseme_nn']);
  assert.deepEqual(visemes(byWord(timeline, 'photo')), ['viseme_FF', 'viseme_O', 'viseme_U', 'viseme_DD', 'viseme_O', 'viseme_U']);
  assert.deepEqual(visemes(byWord(timeline, 'this')), ['viseme_TH', 'viseme_I', 'viseme_SS']);
  assert.deepEqual(visemes(byWord(timeline, 'thin')), ['viseme_TH', 'viseme_I', 'viseme_nn']);
  assert.deepEqual(visemes(byWord(timeline, 'shoe')), ['viseme_CH', 'viseme_U']);
  assert.deepEqual(visemes(byWord(timeline, 'cat')), ['viseme_kk', 'viseme_aa', 'viseme_DD']);
  assert.deepEqual(visemes(byWord(timeline, 'city')), ['viseme_SS', 'viseme_I', 'viseme_DD', 'viseme_I']);
  assert.deepEqual(visemes(byWord(timeline, 'face')), ['viseme_FF', 'viseme_E', 'viseme_I', 'viseme_SS']);
  assert.deepEqual(visemes(byWord(timeline, 'food')), ['viseme_FF', 'viseme_U', 'viseme_DD']);
  assert.deepEqual(visemes(byWord(timeline, 'book')), ['viseme_PP', 'viseme_U', 'viseme_kk']);
  assert.deepEqual(visemes(byWord(timeline, 'know')), ['viseme_nn', 'viseme_O', 'viseme_U']);
  assert.deepEqual(visemes(byWord(timeline, 'wrong')), ['viseme_RR', 'viseme_O', 'viseme_kk']);
  assert.deepEqual(visemes(byWord(timeline, 'mom')), ['viseme_PP', 'viseme_aa', 'viseme_PP']);
  assert.deepEqual(visemes(byWord(timeline, 'paper')), ['viseme_PP', 'viseme_E', 'viseme_I', 'viseme_PP', 'viseme_RR']);
});

test('timelines preserve word offsets and mark guessed pronunciations as estimated', () => {
  const timeline = buildVisemeTimeline('AI demo qzxy!');
  const demo = byWord(timeline, 'demo');
  const unknown = byWord(timeline, 'qzxy');

  assert.deepEqual(phonemes(byWord(timeline, 'AI')), ['EH', 'IY', 'AA', 'IY']);
  assert.ok(demo.every((item) => item.charStart >= 3 && item.charEnd <= 7));
  assert.ok(unknown.length > 0);
  assert.ok(unknown.every((item) => item.estimated), 'unknown-looking words should be explicit estimates');
  assert.equal(timeline[0].startFrac, 0);
  assert.equal(timeline.at(-1).endFrac, 1);
  assert.ok(timeline.every((item, index) => index === 0 || item.startFrac >= timeline[index - 1].endFrac));
});

test('silent letters, digraphs and vowel glides follow sounds rather than spelling', () => {
  assert.deepEqual(phonemes(buildVisemeTimeline('make')), ['M', 'EH', 'IY', 'K']);
  assert.deepEqual(phonemes(buildVisemeTimeline('blue')), ['B', 'L', 'UW']);
  assert.deepEqual(phonemes(buildVisemeTimeline('hello')), ['HH', 'EH', 'L', 'AO', 'UW']);
  assert.deepEqual(phonemes(buildVisemeTimeline('eye')), ['AA', 'IY']);
  const through = buildVisemeTimeline('through');
  assert.deepEqual(phonemes(through), ['TH', 'R', 'UW']);
  assert.equal(buildVisemeTimeline('hello')[0].viseme, 'viseme_E');
  assert.deepEqual(phonemes(buildVisemeTimeline('packed')), ['P', 'AE', 'K', 'T']);
  assert.deepEqual(phonemes(buildVisemeTimeline('added')), ['AE', 'D', 'IH', 'D']);
});

test('ordinary word spaces do not create false mouth closures but punctuation can pause', () => {
  assert.ok(buildVisemeTimeline('we see you').every((unit) => unit.viseme !== 'viseme_sil'));
  assert.equal(buildVisemeTimeline('we see, you go.').filter((unit) => unit.viseme === 'viseme_sil').length, 2);
});

test('numbers use spoken units, decimal point and letter-name acronyms', () => {
  assert.deepEqual(phonemes(buildVisemeTimeline('22')), ['T', 'W', 'EH', 'N', 'T', 'IY', 'T', 'UW']);
  const decimal = phonemes(buildVisemeTimeline('2.5'));
  assert.ok(decimal.includes('P'), 'decimal point is pronounced');
  assert.ok(!decimal.includes(undefined));
  assert.deepEqual(phonemes(buildVisemeTimeline('BBC')), ['B', 'IY', 'B', 'IY', 'S', 'IY']);
  assert.ok(buildVisemeTimeline('2026 café Привет').length > 10);
  const unknownScript = buildVisemeTimeline('Привет');
  assert.ok(unknownScript.length > 0 && unknownScript.every((unit) => unit.estimated));
});
