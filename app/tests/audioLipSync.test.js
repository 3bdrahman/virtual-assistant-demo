import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioLipSync } from '../src/services/audioLipSync.js';

const EXPLICIT_MALE_VOICE = { name: 'English Male', lang: 'en-US' };

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
    const first = lipSync._decodePlaybackAudio(new ArrayBuffer(1));
    const second = lipSync._decodePlaybackAudio(new ArrayBuffer(1));
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
  assert.equal(timeline[0].viseme, 'viseme_aa');
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
