import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechStream } from '../src/services/speechStream.js';

const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(options = {}) {
  const calls = [];
  const audio = [];
  const fallback = [];
  const errors = [];
  const controller = new AbortController();
  let pendingCount = 0;
  const stream = new SpeechStream({
    signal: controller.signal,
    synthesize: async (text) => { calls.push(text); return text; },
    onAudio: (blob, text) => audio.push({ blob, text }),
    onFallback: (text) => fallback.push(text),
    onError: (error) => errors.push(error),
    getPendingCount: () => pendingCount,
    ...options,
  });
  return { stream, calls, audio, fallback, errors, controller, setPendingCount: (count) => { pendingCount = count; } };
}

test('starts synthesizing a complete early sentence while the reply is still open', async () => {
  const { stream, calls, audio } = fixture();
  stream.push('This is the first complete sentence. The rest');
  await tick();
  assert.deepEqual(calls, ['This is the first complete sentence.']);
  assert.equal(audio.length, 1);
  stream.push(' is still arriving without punctuation');
  await stream.finish();
  assert.equal(calls.join(' '), 'This is the first complete sentence. The rest is still arriving without punctuation');
});

test('serializes synthesis and coalesces later buffered sentences without losing text', async () => {
  const first = deferred();
  const calls = [];
  const { stream, audio } = fixture({ synthesize: (text) => {
    calls.push(text);
    return calls.length === 1 ? first.promise : Promise.resolve(text);
  } });
  stream.push('This first sentence should start immediately. ');
  stream.push('The next sentence arrives during synthesis. ');
  stream.push('So does this final sentence.');
  const finished = stream.finish();
  assert.equal(calls.length, 1);
  first.resolve('first audio');
  await finished;
  assert.deepEqual(calls, [
    'This first sentence should start immediately.',
    'The next sentence arrives during synthesis. So does this final sentence.',
  ]);
  assert.deepEqual(audio.map((item) => item.text), calls);
});

test('splits long unpunctuated replies into bounded chunks with no dropped words', async () => {
  const { stream, calls } = fixture();
  const text = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
  stream.push(text);
  await stream.finish();
  assert.ok(calls.length > 2);
  assert.ok(calls[0].length <= 160);
  assert.ok(calls.every((chunk) => chunk.length <= 600));
  assert.equal(calls.join(' '), text);
});

test('does not split decimal numbers, abbreviations, or words across incoming tokens', async () => {
  const { stream, calls } = fixture();
  for (const token of ['Dr.', ' Smith says the value is 3.', '14 and the test is complete.', ' Next']) stream.push(token);
  await tick();
  assert.deepEqual(calls, ['Dr. Smith says the value is 3.14 and the test is complete.']);
  await stream.finish();
  assert.equal(calls[1], 'Next');
});

test('limits synthesis lookahead until playback frees capacity', async () => {
  const { stream, calls, setPendingCount } = fixture();
  setPendingCount(2);
  stream.push('The first sentence is ready for speech. More words.');
  const done = stream.finish();
  await tick();
  assert.equal(calls.length, 0);
  setPendingCount(1);
  stream.resume();
  await done;
  assert.equal(calls.join(' '), 'The first sentence is ready for speech. More words.');
});

test('aborting settles a capacity-blocked stream and ignores late text', async () => {
  const { stream, calls, controller, setPendingCount } = fixture();
  setPendingCount(2);
  stream.push('This sentence is ready but cannot play yet. ');
  const done = stream.finish();
  controller.abort();
  await done;
  setPendingCount(0);
  stream.push('Never play this.');
  stream.resume();
  await tick();
  assert.equal(calls.length, 0);
});

test('aborting discards in-flight audio even if the provider ignores cancellation', async () => {
  const pending = deferred();
  const { stream, audio, fallback, controller } = fixture({ synthesize: () => pending.promise });
  stream.push('A sentence long enough to start speech. ');
  const done = stream.finish();
  controller.abort();
  await done;
  pending.resolve('stale audio');
  await tick();
  assert.deepEqual(audio, []);
  assert.deepEqual(fallback, []);
});

test('a provider failure queues only unspoken text in browser voice and stops retrying it', async () => {
  const { stream, calls, audio, fallback, errors } = fixture({ synthesize: async (text) => {
    calls.push(text);
    if (calls.length > 1) throw new Error('provider unavailable');
    return text;
  } });
  stream.push('This sentence has already been spoken. ');
  await tick();
  stream.push('This second sentence must use the browser voice. ');
  await stream.finish();
  assert.equal(audio.length, 1);
  assert.deepEqual(fallback, ['This second sentence must use the browser voice.']);
  assert.equal(errors.length, 1);
});

test('flushes short replies and final unpunctuated text exactly once', async () => {
  const { stream, calls } = fixture();
  stream.push('Hi');
  await tick();
  assert.deepEqual(calls, []);
  await stream.finish();
  await stream.finish();
  stream.push(' ignored after completion');
  assert.deepEqual(calls, ['Hi']);
});

test('a partially streamed audio failure never repeats the phrase in browser voice', async () => {
  const failure = new Error('audio connection lost');
  failure.partialAudio = true;
  const { stream, fallback, errors } = fixture({ synthesize: async () => { throw failure; } });
  stream.push('Some of this first sentence was already heard. ');
  await tick();
  stream.push('The remaining sentence can use browser speech.');
  await stream.finish();
  assert.equal(errors.length, 1);
  assert.deepEqual(fallback, ['The remaining sentence can use browser speech.']);
});

test('a slow unpunctuated opening starts after a bounded wait at a word boundary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, calls } = fixture();
  stream.push('This opening has enough words to speak before a slow continuation arrives');
  await tick();
  assert.equal(calls.length, 0);
  t.mock.timers.tick(700);
  await tick();
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].endsWith('arrives'));
  await stream.finish();
  assert.equal(calls.join(' '), 'This opening has enough words to speak before a slow continuation arrives');
});
