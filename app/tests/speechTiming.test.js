import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechTiming } from '../src/services/speechTiming.js';

function signal(parts, rate = 10000) {
  let index = 0;
  return Float32Array.from(parts.flatMap(([seconds, kind]) => Array.from({ length: Math.round(seconds * rate) }, () => {
    index++;
    return kind === 'quiet' ? 0 : kind === 'noise'
      ? (index % 2 ? 0.12 : -0.12)
      : Math.sin(index * 2 * Math.PI * 180 / rate) * 0.2;
  })));
}
const unit = (phoneme, viseme, startFrac, endFrac) => ({ phoneme, viseme: `viseme_${viseme}`, startFrac, endFrac });

test('PCM timing features do not depend on network packet sizes', () => {
  const samples = signal([[0.16, 'quiet'], [0.3, 'vowel'], [0.08, 'quiet'], [0.21, 'noise']]);
  const whole = new SpeechTiming(10000);
  whole.append(samples);
  whole.finish();
  const split = new SpeechTiming(10000);
  for (let i = 0; i < samples.length; i += 137) split.append(samples.subarray(i, i + 137));
  split.finish();
  assert.deepEqual(split.frames, whole.frames);
  assert.equal(split.duration, samples.length / 10000);
});

test('acoustic timing leaves leading and trailing silence outside spoken shapes', () => {
  const timing = new SpeechTiming(10000);
  timing.append(signal([[0.3, 'quiet'], [0.4, 'vowel'], [0.2, 'quiet']]));
  timing.finish();
  const aligned = timing.align([unit('AA', 'aa', 0, 1)]);
  assert.ok(aligned[0].start >= 0.27 && aligned[0].start <= 0.31);
  assert.ok(aligned[0].end >= 0.69 && aligned[0].end <= 0.73);
  assert.equal(timing.rmsAt(0.1), 0);
  assert.ok(timing.rmsAt(0.4) > 0.1);
});

test('bilabial closures align with quiet intervals between voiced vowels', () => {
  const timing = new SpeechTiming(10000);
  timing.append(signal([[0.08, 'quiet'], [0.25, 'vowel'], [0.08, 'quiet'], [0.25, 'vowel']]));
  timing.finish();
  const aligned = timing.align([
    unit('P', 'PP', 0, 0.15), unit('AA', 'aa', 0.15, 0.5),
    unit('P', 'PP', 0.5, 0.65), unit('AA', 'aa', 0.65, 1),
  ]);
  assert.deepEqual(aligned.map((item) => item.phoneme), ['P', 'AA', 'P', 'AA']);
  assert.ok(Math.abs(aligned[2].start - 0.33) < 0.05, JSON.stringify(aligned));
  assert.ok(Math.abs(aligned[2].end - 0.41) < 0.05, JSON.stringify(aligned));
  assert.ok(aligned.every((item, i) => item.end > item.start && (!i || item.start >= aligned[i - 1].end)));
});

test('fricative noise is distinguished from voiced vowel energy', () => {
  const timing = new SpeechTiming(10000);
  timing.append(signal([[0.18, 'noise'], [0.32, 'vowel']]));
  timing.finish();
  const aligned = timing.align([unit('F', 'FF', 0, 0.5), unit('AA', 'aa', 0.5, 1)]);
  assert.ok(Math.abs(aligned[0].end - 0.18) < 0.05, JSON.stringify(aligned));
});

test('soft unvoiced consonants are not trimmed away as leading silence', () => {
  const samples = signal([[0.18, 'noise'], [0.32, 'vowel']]);
  for (let index = 0; index < 1800; index++) samples[index] *= 0.04;
  const timing = new SpeechTiming(10000);
  timing.append(samples);
  timing.finish();
  const aligned = timing.align([unit('F', 'FF', 0, 0.36), unit('AA', 'aa', 0.36, 1)]);
  assert.ok(aligned[0].start < 0.03, 'quiet F is speech, not padding');
  assert.ok(Math.abs(aligned[0].end - 0.18) < 0.05);
});

test('alignment is bounded and silent or insufficient audio never invents phoneme timing', () => {
  const silent = new SpeechTiming(10000);
  silent.append(new Float32Array(5000));
  silent.finish();
  assert.deepEqual(silent.align([unit('AA', 'aa', 0, 1)]), []);
  assert.deepEqual(silent.align([]), []);
  assert.deepEqual(silent.align([{ startFrac: NaN }]), []);
  const long = new SpeechTiming(10000);
  long.append(signal([[25, 'vowel']]));
  long.finish();
  const timeline = Array.from({ length: 200 }, (_, i) => unit('AA', 'aa', i / 200, (i + 1) / 200));
  const start = performance.now();
  const aligned = long.align(timeline);
  assert.equal(aligned.length, timeline.length);
  // This runs in a worker in the browser. Allow scheduling contention between
  // parallel test processes while still detecting runaway alignment work.
  assert.ok(performance.now() - start < 2000, 'background alignment must remain bounded');
});
