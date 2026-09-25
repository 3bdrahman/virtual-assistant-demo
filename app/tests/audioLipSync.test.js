import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioLipSync } from '../src/services/audioLipSync.js';

test('NVIDIA speech animates the avatar from the text timeline and audio volume', () => {
  const lipSync = new AudioLipSync();
  lipSync.audioContext = { currentTime: 1.5 };
  lipSync._audioStartCtxTime = 0;
  lipSync._playbackDuration = 3;
  lipSync.analyser = { getByteFrequencyData: (data) => data.fill(255) };
  lipSync._frequencyData = new Uint8Array(16);
  lipSync._textTimeline = [{ viseme: 'viseme_aa', startFrac: 0, endFrac: 1 }];

  lipSync._analyzeFrame();
  assert.equal(lipSync.currentViseme, 'viseme_aa');
});

test('a cancelled browser utterance cannot stop a newer reply', () => {
  const originalWindow = globalThis.window;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancelRAF = globalThis.cancelAnimationFrame;
  const utterances = [];
  globalThis.window = {
    speechSynthesis: {
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
    lipSync.stop();
    assert.equal(lipSync.speakTextFallback('second'), true);
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
    getByteFrequencyData: (data) => data.fill(0),
  };
  lipSync._frequencyData = new Uint8Array(8);

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
