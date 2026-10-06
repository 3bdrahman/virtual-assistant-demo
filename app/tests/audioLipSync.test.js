import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioLipSync } from '../src/services/audioLipSync.js';

const EXPLICIT_MALE_VOICE = { name: 'English Male', lang: 'en-US' };

function createAudioBlob(label = '') {
  return { label, arrayBuffer: async () => new ArrayBuffer(8) };
}

function installAnimationFrameStub() {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
  };
}

function createQueuedAudioHarness() {
  const pendingDecodes = [];
  const sources = [];
  const context = {
    state: 'running',
    currentTime: 10,
    baseLatency: 0,
    outputLatency: 0,
    destination: {},
    decodeAudioData: () => new Promise((resolve, reject) => pendingDecodes.push({ resolve, reject })),
    createBuffer: (channels, frameCount, sampleRate) => {
      const data = new Float32Array(frameCount);
      return {
        channels,
        sampleRate,
        duration: frameCount / sampleRate,
        getChannelData: () => data,
      };
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        connected: false,
        disconnected: false,
        stopped: false,
        startWhen: null,
        connect() { this.connected = true; },
        disconnect() { this.disconnected = true; },
        stop() { this.stopped = true; },
        start(when = 0) { this.startWhen = when; },
      };
      sources.push(source);
      return source;
    },
  };
  return { context, pendingDecodes, sources };
}

test('speech analysis chooses the text timeline viseme', () => {
  const lipSync = new AudioLipSync();
  lipSync.audioContext = { currentTime: 1.5 };
  lipSync._audioStartCtxTime = 0;
  lipSync._playbackDuration = 3;
  lipSync.analyser = { getFloatTimeDomainData: (data) => data.fill(255) };
  lipSync._waveformData = new Float32Array(16);
  lipSync._textTimeline = [{ viseme: 'viseme_aa', startFrac: 0, endFrac: 1 }];

  lipSync._analyzeFrame();
  assert.equal(lipSync.currentViseme, 'viseme_aa');
});

test('mouth timing follows the device output timestamp instead of the render-ahead clock', () => {
  const lipSync = new AudioLipSync();
  lipSync.audioContext = { currentTime: 10, getOutputTimestamp: () => ({ contextTime: 9.15, performanceTime: performance.now() }) };
  lipSync._audioStartCtxTime = 9;
  lipSync._playbackDuration = 1;
  lipSync._textTimeline = [
    { viseme: 'viseme_aa', startFrac: 0, endFrac: 0.5 },
    { viseme: 'viseme_FF', startFrac: 0.5, endFrac: 1 },
  ];
  lipSync._waveformData = new Float32Array(64);
  lipSync.analyser = { getFloatTimeDomainData: (data) => data.fill(0.12) };
  lipSync._analyzeFrame();
  assert.equal(lipSync.currentViseme, 'viseme_aa');
});

test('quiet bilabial closure releases the previous open vowel quickly', () => {
  const lipSync = new AudioLipSync();
  lipSync.audioContext = { currentTime: 0.15 };
  lipSync._audioStartCtxTime = 0;
  lipSync._playbackDuration = 1;
  lipSync._textTimeline = [{ viseme: 'viseme_PP', startFrac: 0, endFrac: 1 }];
  lipSync._waveformData = new Float32Array(64);
  lipSync.analyser = { getFloatTimeDomainData: (data) => data.fill(0.0001) };
  lipSync.visemeWeights.viseme_aa = 0.75;
  lipSync.visemeDampers.get('viseme_aa').reset(0.75, 0);
  for (let frame = 0; frame < 4; frame++) {
    lipSync._lastFrameClock = performance.now() / 1000 - 1 / 60;
    lipSync._analyzeFrame();
  }
  assert.ok(lipSync.visemeWeights.viseme_PP > 0.9);
  assert.ok(lipSync.visemeWeights.viseme_aa < 0.04);
});

test('audible narrow-band audio produces substantial mouth movement and silence releases it', () => {
  const lipSync = new AudioLipSync();
  let audible = true;
  lipSync.audioContext = { currentTime: 1 };
  lipSync._playbackDuration = 3;
  lipSync._textTimeline = [{ viseme: 'viseme_aa', startFrac: 0, endFrac: 1 }];
  lipSync._frequencyData = new Uint8Array(1024);
  lipSync._waveformData = new Float32Array(2048);
  lipSync.analyser = {
    getByteFrequencyData(data) { data.fill(0); if (audible) data.fill(240, 8, 12); },
    getFloatTimeDomainData(data) {
      for (let i = 0; i < data.length; i++) data[i] = audible ? 0.2 * Math.sin(i * Math.PI / 32) : 0;
    },
  };
  const frames = () => {
    for (let i = 0; i < 60; i++) {
      lipSync._lastFrameClock = performance.now() / 1000 - 1 / 60;
      lipSync._analyzeFrame();
    }
  };
  frames();
  assert.ok(lipSync.visemeWeights.viseme_aa > 0.5, 'audible audio must visibly open the mouth');
  audible = false;
  frames();
  assert.ok(lipSync.visemeWeights.viseme_aa < 0.01, 'silence must close the mouth');
});

test('a cancelled browser utterance cannot stop a newer reply', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  const utterances = [];
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [
        { name: 'English Female', lang: 'en-US' },
        EXPLICIT_MALE_VOICE,
        { name: 'Default Voice', lang: 'en-US' },
      ],
      speak: (utterance) => utterances.push(utterance),
      cancel: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; }
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  try {
    const lipSync = new AudioLipSync();
    let idleEvents = 0;
    lipSync.onIdle = () => { idleEvents++; };
    assert.equal(lipSync.speakTextFallback('first'), true);
    assert.equal(utterances[0].voice, EXPLICIT_MALE_VOICE);
    lipSync.stop();
    assert.equal(lipSync.speakTextFallback('second'), true);
    assert.equal(utterances[1].voice, EXPLICIT_MALE_VOICE);
    utterances[0].onend();
    assert.equal(lipSync.isPlaying, true);
    assert.equal(idleEvents, 0);
    utterances[1].onend();
    assert.equal(lipSync.isPlaying, false);
    assert.equal(idleEvents, 1);
  } finally {
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
  }
});

test('browser speech fallback refuses voices without explicit English male metadata', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  let constructed = 0;
  let speakCalls = 0;
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [
        { name: 'English Female', lang: 'en-US' },
        { name: 'Default Voice', lang: 'en-US', default: true },
        { name: 'English Person', lang: 'en-US' },
        { name: 'Italian Male', lang: 'it-IT' },
      ],
      speak: () => { speakCalls++; },
      cancel: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      constructed++;
      this.text = text;
    }
  };

  try {
    const lipSync = new AudioLipSync();
    assert.equal(lipSync.speakTextFallback('private reply text'), false);
    assert.equal(constructed, 0);
    assert.equal(speakCalls, 0);
    assert.equal(lipSync.isPlaying, false);
    assert.equal(lipSync._activeUtterance, null);
  } finally {
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  }
});

test('browser speech fallback returns false when voices are unavailable', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  let constructed = 0;
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => { throw new Error('voices unavailable'); },
      speak: () => assert.fail('speech synthesis should not speak without a known male voice'),
      cancel: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      constructed++;
      this.text = text;
    }
  };

  try {
    const lipSync = new AudioLipSync();
    assert.equal(lipSync.speakTextFallback('private reply text'), false);
    assert.equal(constructed, 0);
    assert.equal(lipSync.isPlaying, false);

    globalThis.window.speechSynthesis.getVoices = () => [];
    const emptyVoicesLipSync = new AudioLipSync();
    assert.equal(emptyVoicesLipSync.speakTextFallback('private reply text'), false);
    assert.equal(constructed, 0);
    assert.equal(emptyVoicesLipSync.isPlaying, false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  }
});

test('browser speech fallback settles if speech synthesis never emits an end event', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timeoutCallback;
  let timeoutMs;
  let cancelCalls = 0;
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [EXPLICIT_MALE_VOICE],
      speak: () => {},
      cancel: () => { cancelCalls++; },
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; }
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = (callback, ms) => {
    timeoutCallback = callback;
    timeoutMs = ms;
    return 99;
  };
  globalThis.clearTimeout = () => {};

  try {
    const lipSync = new AudioLipSync();
    let idleEvents = 0;
    let speechErrors = 0;
    lipSync.onIdle = () => { idleEvents++; };
    lipSync.onSpeechError = () => { speechErrors++; };
    assert.equal(lipSync.speakTextFallback('hello'), true);
    assert.equal(lipSync.isPlaying, true);
    assert.ok(timeoutMs >= 6000);

    timeoutCallback();
    assert.equal(lipSync.isPlaying, false);
    assert.equal(idleEvents, 1);
    assert.equal(speechErrors, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(lipSync._activeUtterance, null);
  } finally {
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('provider audio playback reports a decode timeout instead of hanging', async () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalError = console.error;
  let timeoutCallback;
  let timeoutMs;
  let clearedTimeout;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = (callback, ms) => {
    timeoutCallback = callback;
    timeoutMs = ms;
    return 61;
  };
  globalThis.clearTimeout = (id) => { clearedTimeout = id; };
  console.error = () => {};

  const lipSync = new AudioLipSync();
  const playbackErrors = [];
  let idleEvents = 0;
  lipSync.onPlaybackError = (error, text) => playbackErrors.push({ error, text });
  lipSync.onIdle = () => { idleEvents++; };
  lipSync.audioContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    decodeAudioData: () => new Promise(() => {}),
    createBufferSource: () => ({ connect() {}, start() {}, stop() {}, disconnect() {} }),
  };
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const audio = { arrayBuffer: async () => new ArrayBuffer(8) };
    lipSync.enqueue(audio, 'decode please');
    await new Promise(setImmediate);
    assert.equal(timeoutMs, 15_000);

    timeoutCallback();
    await new Promise(setImmediate);
    assert.equal(playbackErrors.length, 1);
    assert.match(playbackErrors[0].error.message, /decoding timed out/);
    assert.equal(playbackErrors[0].text, 'decode please');
    assert.equal(idleEvents, 1);
    assert.equal(lipSync.isPlaying, false);
    assert.equal(lipSync._playbackDecodeTimeout, null);
    assert.equal(lipSync._rejectPlaybackDecode, null);
    assert.equal(clearedTimeout, 61);
  } finally {
    lipSync.stop();
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    console.error = originalError;
  }
});

test('queued provider audio predecodes while the current chunk is playing', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, pendingDecodes, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    lipSync.enqueue(createAudioBlob('first'), 'first chunk');
    await new Promise(setImmediate);
    assert.equal(pendingDecodes.length, 1);
    pendingDecodes[0].resolve({ duration: 0.5 });
    await new Promise(setImmediate);
    assert.equal(sources.length, 1);

    lipSync.enqueue(createAudioBlob('second'), 'second chunk');
    await new Promise(setImmediate);
    assert.equal(pendingDecodes.length, 2, 'next chunk decode starts before the current source ends');
    assert.equal(sources.length, 1, 'decoded-ahead chunk is not started until a schedule slot is known');
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('decoded provider chunks are scheduled in order without waiting for source end', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, pendingDecodes, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    lipSync.enqueue(createAudioBlob('first'), 'alpha');
    lipSync.enqueue(createAudioBlob('second'), 'bravo');
    await new Promise(setImmediate);
    assert.equal(pendingDecodes.length, 2);

    pendingDecodes[0].resolve({ duration: 0.5 });
    await new Promise(setImmediate);
    pendingDecodes[1].resolve({ duration: 0.25 });
    await new Promise(setImmediate);

    assert.equal(sources.length, 2);
    assert.equal(sources[0].startWhen, context.currentTime);
    assert.equal(sources[1].startWhen, context.currentTime + 0.5);
    assert.equal(lipSync.currentSource, sources[0]);

    sources[0].onended();
    assert.equal(lipSync.currentSource, sources[1]);
    assert.deepEqual(lipSync._textTimeline, lipSync._buildTextTimeline('bravo'));
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('stopping provider playback cancels queued decodes and scheduled future sources', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, pendingDecodes, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    lipSync.enqueue(createAudioBlob('first'), 'alpha');
    lipSync.enqueue(createAudioBlob('second'), 'bravo');
    await new Promise(setImmediate);
    pendingDecodes[0].resolve({ duration: 0.5 });
    pendingDecodes[1].resolve({ duration: 0.5 });
    await new Promise(setImmediate);
    assert.equal(sources.length, 2);

    lipSync.stop();
    assert.equal(sources[0].stopped, true);
    assert.equal(sources[1].stopped, true);
    assert.equal(lipSync.currentSource, null);
    assert.equal(lipSync.queue.length, 0);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('a queued decode resolving after stop cannot schedule stale audio', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, pendingDecodes, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    lipSync.enqueue(createAudioBlob('first'), 'alpha');
    lipSync.enqueue(createAudioBlob('second'), 'bravo');
    await new Promise(setImmediate);
    assert.equal(pendingDecodes.length, 2);

    pendingDecodes[0].resolve({ duration: 0.5 });
    await new Promise(setImmediate);
    lipSync.stop();
    pendingDecodes[1].resolve({ duration: 0.5 });
    await new Promise(setImmediate);

    assert.equal(sources.length, 1);
    assert.equal(lipSync.currentSource, null);
    assert.equal(lipSync.isPlaying, false);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('chunk boundaries keep the next text timeline without resetting smooth visemes', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, pendingDecodes, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0.2),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    lipSync.enqueue(createAudioBlob('first'), 'aaa');
    lipSync.enqueue(createAudioBlob('second'), 'ooo');
    await new Promise(setImmediate);
    pendingDecodes[0].resolve({ duration: 0.5 });
    pendingDecodes[1].resolve({ duration: 0.5 });
    await new Promise(setImmediate);

    lipSync.visemeWeights.viseme_aa = 0.6;
    lipSync.visemeDampers.get('viseme_aa').reset(0.6, 0);
    sources[0].onended();

    assert.deepEqual(lipSync._textTimeline, lipSync._buildTextTimeline('ooo'));
    assert.ok(lipSync.visemeWeights.viseme_aa > 0, 'boundary transition should smooth from the previous mouth pose');
    assert.equal(lipSync.visemeWeights.viseme_sil, 0);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('enqueueText queues browser fallback behind current audio and preserves order', async () => {
  const restoreRAF = installAnimationFrameStub();
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const { context, pendingDecodes, sources } = createQueuedAudioHarness();
  const spoken = [];
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [EXPLICIT_MALE_VOICE],
      speak: (utterance) => spoken.push(utterance),
      cancel: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; }
  };

  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    lipSync.enqueue(createAudioBlob('first'), 'audio first');
    await new Promise(setImmediate);
    pendingDecodes[0].resolve({ duration: 0.5 });
    await new Promise(setImmediate);
    assert.equal(sources.length, 1);

    assert.equal(lipSync.enqueueText('fallback second'), true);
    assert.equal(spoken.length, 0);
    sources[0].onended();
    await new Promise(setImmediate);
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].text, 'fallback second');
    spoken[0].onend();
    assert.equal(lipSync.isPlaying, false);
  } finally {
    lipSync.stop();
    restoreRAF();
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  }
});

test('audio failure fallback inserts text before the remaining queued chunks', async () => {
  const restoreRAF = installAnimationFrameStub();
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const { context, pendingDecodes, sources } = createQueuedAudioHarness();
  const spoken = [];
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [EXPLICIT_MALE_VOICE],
      speak: (utterance) => spoken.push(utterance),
      cancel: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; }
  };

  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);
  lipSync.onPlaybackError = (_error, text) => {
    assert.equal(lipSync.speakTextFallback(text), true);
  };

  try {
    lipSync.enqueue(createAudioBlob('bad'), 'bad audio');
    lipSync.enqueue(createAudioBlob('good'), 'good audio');
    await new Promise(setImmediate);
    pendingDecodes[0].reject(new Error('decode failed'));
    await new Promise(setImmediate);

    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].text, 'bad audio');
    assert.equal(sources.length, 0);

    spoken[0].onend();
    await new Promise(setImmediate);
    assert.equal(pendingDecodes.length, 2);
    pendingDecodes[1].resolve({ duration: 0.5 });
    await new Promise(setImmediate);
    assert.equal(sources.length, 1);
    assert.equal(lipSync.currentSource, sources[0]);
  } finally {
    lipSync.stop();
    restoreRAF();
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  }
});

test('queue change callback reports pending provider phrase capacity', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, pendingDecodes, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  const counts = [];
  lipSync.onQueueChange = (count) => counts.push(count);
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    lipSync.enqueue(createAudioBlob('first'), 'alpha');
    lipSync.enqueue(createAudioBlob('second'), 'bravo');
    assert.equal(lipSync.pendingCount, 2);
    assert.deepEqual(counts.slice(-2), [1, 2]);

    await new Promise(setImmediate);
    pendingDecodes[0].resolve({ duration: 0.5 });
    pendingDecodes[1].resolve({ duration: 0.5 });
    await new Promise(setImmediate);
    sources[0].onended();
    assert.equal(lipSync.pendingCount, 1);
    assert.equal(counts.at(-1), 1);

    lipSync.stop();
    assert.equal(lipSync.pendingCount, 0);
    assert.equal(counts.at(-1), 0);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('streamed PCM chunks share one phrase timeline and count as one pending item', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  const starts = [];
  lipSync.onPlaybackStart = (text) => starts.push(text);
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0.2),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const speechId = lipSync.beginPcm('one phrase', { sampleRate: 10 });
    assert.equal(lipSync.pendingCount, 1);
    lipSync.enqueuePcm(new Float32Array([0.1, 0.1]), '', { speechId, sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.2, 0.2]), '', { speechId, sampleRate: 10, final: true });
    await new Promise(setImmediate);

    assert.equal(lipSync.pendingCount, 1);
    assert.equal(sources.length, 2);
    assert.equal(sources[0].startWhen, context.currentTime);
    assert.equal(sources[1].startWhen, context.currentTime + 0.2);
    assert.deepEqual(starts, ['one phrase']);
    assert.deepEqual(lipSync._textTimeline, lipSync._buildTextTimeline('one phrase'));

    lipSync.visemeWeights.viseme_aa = 0.5;
    sources[0].onended();
    assert.equal(lipSync.pendingCount, 1);
    assert.ok(lipSync.visemeWeights.viseme_aa > 0, 'PCM chunk boundary should not reset viseme smoothing');

    sources[1].onended();
    assert.equal(lipSync.pendingCount, 0);
    assert.equal(lipSync.isPlaying, false);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('completed PCM phrases schedule across group boundaries without waiting for onended', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  const starts = [];
  lipSync.onPlaybackStart = (text) => starts.push(text);
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0.2),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const first = lipSync.beginPcm('first phrase', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.1, 0.1]), '', { speechId: first, sampleRate: 10, final: true });
    const second = lipSync.beginPcm('second phrase', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.2, 0.2]), '', { speechId: second, sampleRate: 10, final: true });
    await new Promise(setImmediate);

    assert.equal(sources.length, 2);
    assert.equal(sources[0].startWhen, context.currentTime);
    assert.equal(sources[1].startWhen, context.currentTime + 0.2);
    assert.deepEqual(starts, ['first phrase']);

    sources[0].onended();
    assert.equal(lipSync.currentSource, sources[1]);
    assert.deepEqual(lipSync._textTimeline, lipSync._buildTextTimeline('second phrase'));
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('open PCM phrases block later phrase scheduling until they are finished', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0.2),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const first = lipSync.beginPcm('open phrase', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.1, 0.1]), '', { speechId: first, sampleRate: 10 });
    const second = lipSync.beginPcm('later phrase', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.2, 0.2]), '', { speechId: second, sampleRate: 10, final: true });
    await new Promise(setImmediate);

    assert.equal(sources.length, 1);
    lipSync.finishPcm(first);
    await new Promise(setImmediate);
    assert.equal(sources.length, 2);
    assert.equal(sources[1].startWhen, context.currentTime + 0.2);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('PCM phrase timeline uses an estimated full phrase duration until final audio is known', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0.2),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const speechId = lipSync.beginPcm('this phrase should not finish in one short chunk', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.1]), '', { speechId, sampleRate: 10, duration: 99 });
    await new Promise(setImmediate);

    assert.ok(lipSync._playbackDuration > 0.1);
    assert.ok(lipSync._playbackDuration < 99, 'duration option should not override actual PCM buffer seconds');
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('PCM starts at a zero audio clock and stopped phrase ids cannot recreate audio', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, sources } = createQueuedAudioHarness();
  context.currentTime = 0;
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = { connect() {}, getFloatTimeDomainData(data) { data.fill(0.2); } };
  lipSync._waveformData = new Float32Array(8);
  try {
    const speechId = lipSync.beginPcm('same phrase across buffers', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array(2), '', { speechId });
    lipSync.enqueuePcm(new Float32Array(2), '', { speechId });
    await new Promise(setImmediate);
    assert.equal(lipSync.queue[0].startTime, 0);
    assert.equal(sources[1].startWhen, 0.2);
    lipSync.stop();
    assert.ok(sources.every((source) => source.stopped));
    assert.equal(lipSync.enqueuePcm(new Float32Array(2), '', { speechId }), false);
    assert.equal(lipSync.pendingCount, 0);
    assert.equal(lipSync.finishPcm(speechId), false);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('acoustic retiming is asynchronous and late worker results cannot affect a new reply', async () => {
  const originalWorker = globalThis.Worker;
  const restoreRAF = installAnimationFrameStub();
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
  };
  const { context, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = { connect() {}, getFloatTimeDomainData(data) { data.fill(0.2); } };
  lipSync._waveformData = new Float32Array(8);
  try {
    const first = lipSync.beginPcm('paper', { sampleRate: 10000 });
    lipSync.enqueuePcm(new Float32Array(2000).fill(0.1), '', { speechId: first });
    lipSync.finishPcm(first);
    await new Promise(setImmediate);
    assert.equal(sources.length, 1, 'playback starts without waiting for a worker reply');
    assert.equal(workers.length, 1);
    const request = workers[0].message;
    assert.equal(lipSync.queue[0].alignedTimeline, undefined);
    workers[0].onmessage({ data: { ...request, timeline: [{ viseme: 'viseme_PP', start: 0, end: 0.1 }] } });
    assert.equal(lipSync.queue[0].alignedTimeline[0].viseme, 'viseme_PP');
    lipSync.stop();
    lipSync.beginPcm('a new reply');
    workers[0].onmessage({ data: { ...request, timeline: [{ viseme: 'viseme_PP', start: 0, end: 0.1 }] } });
    assert.equal(lipSync.queue[0].alignedTimeline, undefined);
    await lipSync.dispose();
    assert.equal(workers[0].terminated, true);
  } finally {
    lipSync.stop();
    globalThis.Worker = originalWorker;
    restoreRAF();
  }
});

test('browser speech word boundaries re-anchor pronunciation and ignore cancelled utterances', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const restoreRAF = installAnimationFrameStub();
  const spoken = [];
  globalThis.window = { speechSynthesis: { getVoices: () => [EXPLICIT_MALE_VOICE], speak: (item) => spoken.push(item), cancel() {} } };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const lipSync = new AudioLipSync();
  try {
    lipSync.speakTextFallback('my blue bag');
    spoken[0].onstart();
    const expected = lipSync._textTimeline.find((unit) => unit.word === 'blue').startFrac;
    spoken[0].onboundary({ name: 'word', charIndex: 3 });
    assert.equal(lipSync._fallbackProgress, expected);
    lipSync.stop();
    lipSync.speakTextFallback('new reply');
    spoken[0].onboundary({ name: 'word', charIndex: 8 });
    assert.equal(lipSync._fallbackProgress, 0);
  } finally {
    lipSync.stop();
    restoreRAF();
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  }
});

test('PCM progress continues across stream stalls without rewinding the phrase timeline', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0.2),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const speechId = lipSync.beginPcm('aaaa oooo', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.1, 0.1]), '', { speechId, sampleRate: 10 });
    await new Promise(setImmediate);
    const firstStart = lipSync._audioStartCtxTime;
    sources[0].onended();

    context.currentTime = 15;
    lipSync.enqueuePcm(new Float32Array([0.2, 0.2]), '', { speechId, sampleRate: 10, final: true });
    await new Promise(setImmediate);

    assert.equal(lipSync._audioStartCtxTime, firstStart);
    context.currentTime = sources[1].startWhen;
    lipSync._analyzeFrame();
    assert.equal(lipSync.queue[0].progress, 0.5, 'network stall must not count as spoken audio');
    context.currentTime += 0.1;
    lipSync._analyzeFrame();
    assert.ok(lipSync.queue[0].progress > 0.7 && lipSync.queue[0].progress < 0.8);
    assert.ok(lipSync.currentViseme !== 'viseme_sil');
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('PCM scheduling reports a bounded audio resume failure instead of leaving a pending queue', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  const errors = [];
  let idleEvents = 0;
  context.state = 'suspended';
  context.resume = async () => { throw new Error('resume denied'); };
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);
  lipSync.onPlaybackError = (error, text) => errors.push({ error, text });
  lipSync.onIdle = () => { idleEvents++; };

  try {
    const speechId = lipSync.beginPcm('resume me', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.1]), '', { speechId, sampleRate: 10, final: true });
    await new Promise(setImmediate);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].text, 'resume me');
    assert.match(errors[0].error.message, /resume denied|Audio output did not start/);
    assert.equal(lipSync.pendingCount, 0);
    assert.equal(idleEvents, 1);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('open PCM phrases stay pending but go idle during stream stalls and restart on later chunks', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  const starts = [];
  let idleEvents = 0;
  lipSync.onPlaybackStart = (text) => starts.push(text);
  lipSync.onIdle = () => { idleEvents++; };
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0.2),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const speechId = lipSync.beginPcm('stalling phrase', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.1, 0.1]), '', { speechId, sampleRate: 10 });
    await new Promise(setImmediate);
    assert.equal(lipSync.pendingCount, 1);
    assert.deepEqual(starts, ['stalling phrase']);

    sources[0].onended();
    assert.equal(lipSync.pendingCount, 1);
    assert.equal(lipSync.isPlaying, false);
    assert.equal(idleEvents, 1);

    context.currentTime = 11;
    lipSync.enqueuePcm(new Float32Array([0.2, 0.2]), '', { speechId, sampleRate: 10, final: true });
    await new Promise(setImmediate);
    assert.equal(sources.length, 2);
    assert.equal(sources[1].startWhen, 11);
    assert.deepEqual(starts, ['stalling phrase', 'stalling phrase']);

    sources[1].onended();
    assert.equal(lipSync.pendingCount, 0);
    assert.equal(idleEvents, 2);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('final queued browser fallback fires idle after speech finishes', async () => {
  const restoreRAF = installAnimationFrameStub();
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const spoken = [];
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [EXPLICIT_MALE_VOICE],
      speak: (utterance) => spoken.push(utterance),
      cancel: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; }
  };

  const lipSync = new AudioLipSync();
  let idleEvents = 0;
  lipSync.onIdle = () => { idleEvents++; };

  try {
    assert.equal(lipSync.enqueueText('queued fallback'), true);
    await new Promise(setImmediate);
    assert.equal(spoken.length, 1);
    spoken[0].onend();
    assert.equal(idleEvents, 1);
    assert.equal(lipSync.isPlaying, false);
  } finally {
    lipSync.stop();
    restoreRAF();
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  }
});

test('browser fallback waits for audible speech start before animating the mouth', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  let utterance;
  let frames = 0;
  globalThis.window = { speechSynthesis: {
    getVoices: () => [EXPLICIT_MALE_VOICE],
    speak: (value) => { utterance = value; },
    cancel() {},
  } };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.requestAnimationFrame = () => ++frames;
  globalThis.cancelAnimationFrame = () => {};
  const lipSync = new AudioLipSync();
  try {
    assert.equal(lipSync.speakTextFallback('aaaa oooo'), true);
    assert.equal(frames, 0);
    assert.equal(lipSync.currentIntensity, 0);
    utterance.onstart();
    assert.equal(frames, 1);
    assert.ok(lipSync.currentIntensity > 0);
    lipSync.stop();
    utterance.onstart();
    assert.equal(frames, 1, 'a cancelled utterance cannot restart animation');
  } finally {
    lipSync.stop();
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
  }
});

test('finishPcm closes a drained open phrase and frees pending capacity', async () => {
  const restoreRAF = installAnimationFrameStub();
  const { context, sources } = createQueuedAudioHarness();
  const lipSync = new AudioLipSync();
  const counts = [];
  lipSync.onQueueChange = (count) => counts.push(count);
  lipSync.audioContext = context;
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0.2),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const speechId = lipSync.beginPcm('short phrase', { sampleRate: 10 });
    lipSync.enqueuePcm(new Float32Array([0.1, 0.1]), '', { speechId, sampleRate: 10 });
    await new Promise(setImmediate);
    sources[0].onended();
    assert.equal(lipSync.pendingCount, 1);

    assert.equal(lipSync.finishPcm(speechId), true);
    assert.equal(lipSync.pendingCount, 0);
    assert.equal(counts.at(-1), 0);
  } finally {
    lipSync.stop();
    restoreRAF();
  }
});

test('stopping playback clears a pending provider audio decode without a stale error', async () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let clearedTimeout;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = () => 62;
  globalThis.clearTimeout = (id) => { clearedTimeout = id; };

  const lipSync = new AudioLipSync();
  let playbackErrors = 0;
  lipSync.onPlaybackError = () => { playbackErrors++; };
  lipSync.audioContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    decodeAudioData: () => new Promise(() => {}),
    createBufferSource: () => ({ connect() {}, start() {}, stop() {}, disconnect() {} }),
  };
  lipSync.analyser = {
    connect() {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const audio = { arrayBuffer: async () => new ArrayBuffer(8) };
    lipSync.enqueue(audio, 'stale decode');
    await new Promise(setImmediate);
    assert.equal(typeof lipSync._rejectPlaybackDecode, 'function');

    lipSync.stop();
    await new Promise(setImmediate);
    assert.equal(clearedTimeout, 62);
    assert.equal(lipSync._playbackDecodeTimeout, null);
    assert.equal(lipSync._rejectPlaybackDecode, null);
    assert.equal(playbackErrors, 0);
    assert.equal(lipSync.isPlaying, false);
  } finally {
    lipSync.stop();
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('an older decode settling cannot clear the active decode deadline', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeouts = [];
  const cleared = [];
  globalThis.setTimeout = (callback) => {
    const id = timeouts.length + 1;
    timeouts.push({ id, callback });
    return id;
  };
  globalThis.clearTimeout = (id) => { cleared.push(id); };

  const resolvers = [];
  const lipSync = new AudioLipSync();
  lipSync.audioContext = {
    decodeAudioData: () => new Promise((resolve) => resolvers.push(resolve)),
  };

  try {
    const first = lipSync._decodeAudioBufferForItem(new ArrayBuffer(1), {});
    const second = lipSync._decodeAudioBufferForItem(new ArrayBuffer(1), {});
    assert.equal(lipSync._playbackDecodeTimeout, 2);

    resolvers[0]({ duration: 1 });
    await first;
    assert.equal(lipSync._playbackDecodeTimeout, 2);
    assert.equal(typeof lipSync._rejectPlaybackDecode, 'function');
    assert.deepEqual(cleared, [1]);

    resolvers[1]({ duration: 1 });
    await second;
    assert.equal(lipSync._playbackDecodeTimeout, null);
    assert.equal(lipSync._rejectPlaybackDecode, null);
    assert.deepEqual(cleared, [1, 2]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('stopping browser speech clears the fallback timeout and ignores it later', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timeoutCallback;
  let clearedTimeout;
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [EXPLICIT_MALE_VOICE],
      speak: () => {},
      cancel: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; }
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = (callback) => {
    timeoutCallback = callback;
    return 41;
  };
  globalThis.clearTimeout = (id) => { clearedTimeout = id; };

  try {
    const lipSync = new AudioLipSync();
    let idleEvents = 0;
    lipSync.onIdle = () => { idleEvents++; };
    assert.equal(lipSync.speakTextFallback('hello'), true);
    lipSync.stop();
    timeoutCallback();
    assert.equal(clearedTimeout, 41);
    assert.equal(lipSync.isPlaying, false);
    assert.equal(idleEvents, 0);
  } finally {
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('resetting visemes clears spring state so old speech cannot reappear', () => {
  const lipSync = new AudioLipSync();
  const damper = lipSync.visemeDampers.get('viseme_aa');
  damper.reset(0.8, 4);
  lipSync.visemeWeights.viseme_aa = 0.8;

  lipSync._resetVisemes();
  lipSync._textTimeline = [{ viseme: 'viseme_sil', startFrac: 0, endFrac: 1 }];
  lipSync.audioContext = { currentTime: 0 };
  lipSync._audioStartCtxTime = 0;
  lipSync._playbackDuration = 1;
  lipSync.analyser = { getFloatTimeDomainData: (data) => data.fill(0) };
  lipSync._waveformData = new Float32Array(16);
  lipSync._analyzeFrame();

  assert.equal(lipSync.visemeWeights.viseme_aa, 0);
  assert.equal(lipSync.visemeDampers.get('viseme_aa').getState().position, 0);
});

test('text timelines keep approximate mouth movement for digits and unicode replies', () => {
  const lipSync = new AudioLipSync();
  const timeline = lipSync._buildTextTimeline('2026 café Привет');

  assert.ok(timeline.some((item) => item.viseme !== 'viseme_sil'));
  assert.equal(timeline[0].viseme, 'viseme_DD', 'a spoken number starting with two uses the T sound');
  assert.ok(timeline.filter((item) => item.viseme !== 'viseme_sil').length >= 4);
});

test('synchronous speech end before speak returns does not resurrect timeout or RAF work', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const originalRAF = globalThis.requestAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  let timeoutCalls = 0;
  let rafCalls = 0;
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [EXPLICIT_MALE_VOICE],
      speak: (utterance) => utterance.onend(),
      cancel: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; }
  };
  globalThis.requestAnimationFrame = () => {
    rafCalls++;
    return 1;
  };
  globalThis.setTimeout = () => {
    timeoutCalls++;
    return 1;
  };

  try {
    const lipSync = new AudioLipSync();
    let idleEvents = 0;
    lipSync.onIdle = () => { idleEvents++; };
    assert.equal(lipSync.speakTextFallback('instant finish'), true);
    assert.equal(idleEvents, 1);
    assert.equal(lipSync.isPlaying, false);
    assert.equal(lipSync._speechTimeout, null);
    assert.equal(lipSync._fallbackRAF, null);
    assert.equal(timeoutCalls, 0);
    assert.equal(rafCalls, 0);
  } finally {
    globalThis.window = originalWindow;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('audio output is unlocked during the user interaction', async () => {
  const originalWindow = globalThis.window;
  let resumeCalls = 0;
  globalThis.window = {
    AudioContext: class {
      state = 'suspended';
      createAnalyser() { return { frequencyBinCount: 8 }; }
      resume() {
        resumeCalls++;
        this.state = 'running';
        return Promise.resolve();
      }
    },
  };
  try {
    const lipSync = new AudioLipSync();
    await lipSync.prepare();
    assert.equal(resumeCalls, 1);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('dispose closes the owned audio context and prepare can recreate it after StrictMode cleanup', async () => {
  const originalWindow = globalThis.window;
  const contexts = [];
  globalThis.window = {
    AudioContext: class {
      state = 'running';
      disconnected = false;
      closed = false;
      constructor() { contexts.push(this); }
      createAnalyser() {
        return {
          frequencyBinCount: 8,
          disconnect: () => { this.disconnected = true; },
        };
      }
      async close() {
        this.closed = true;
        this.state = 'closed';
      }
    },
    speechSynthesis: { cancel: () => {} },
  };

  try {
    const lipSync = new AudioLipSync();
    await lipSync.prepare();
    assert.equal(contexts.length, 1);
    const disposeResult = lipSync.dispose();
    lipSync.stop();
    await disposeResult;
    assert.equal(contexts[0].closed, true);
    assert.equal(contexts[0].disconnected, true);
    assert.equal(lipSync.audioContext, null);
    assert.equal(lipSync.analyser, null);

    await lipSync.prepare();
    assert.equal(contexts.length, 2);
    assert.equal(lipSync.audioContext, contexts[1]);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('dispose handles audio context close rejection without leaving a stale graph', async () => {
  const originalWindow = globalThis.window;
  const originalWarn = console.warn;
  let warned = false;
  globalThis.window = {
    AudioContext: class {
      state = 'running';
      createAnalyser() { return { frequencyBinCount: 8, disconnect() {} }; }
      async close() { throw new Error('close failed'); }
    },
    speechSynthesis: { cancel: () => {} },
  };
  console.warn = () => { warned = true; };

  try {
    const lipSync = new AudioLipSync();
    await lipSync.prepare();
    await lipSync.dispose();
    assert.equal(warned, true);
    assert.equal(lipSync.audioContext, null);
    assert.equal(lipSync.analyser, null);
  } finally {
    console.warn = originalWarn;
    globalThis.window = originalWindow;
  }
});

test('stopping a reply prevents an unfinished decode from starting stale audio', async () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const pendingDecodes = [];
  const started = [];
  const lipSync = new AudioLipSync();
  lipSync.audioContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    decodeAudioData: () => new Promise((resolve) => pendingDecodes.push(resolve)),
    createBufferSource: () => ({
      connect: () => {},
      start: () => started.push(true),
      stop: () => {},
    }),
  };
  lipSync.analyser = {
    connect: () => {},
    getFloatTimeDomainData: (data) => data.fill(0),
  };
  lipSync._waveformData = new Float32Array(8);

  try {
    const audio = { arrayBuffer: async () => new ArrayBuffer(8) };
    lipSync.enqueue(audio, 'old reply');
    await new Promise(setImmediate);
    lipSync.stop();
    lipSync.enqueue(audio, 'new reply');
    await new Promise(setImmediate);
    assert.equal(pendingDecodes.length, 2);

    pendingDecodes[1]({ duration: 1 });
    await new Promise(setImmediate);
    assert.equal(started.length, 1);

    pendingDecodes[0]({ duration: 1 });
    await new Promise(setImmediate);
    assert.equal(started.length, 1);
  } finally {
    lipSync.stop();
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
  }
});
