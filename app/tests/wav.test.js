import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMonoPcm16, toTranscriptionWav } from '../src/services/wav.js';

test('encodes mono PCM samples into a valid 16 kHz WAV upload', async () => {
  const wav = encodeMonoPcm16(Float32Array.from([-1, 0, 1]), 16000);
  const buffer = await wav.arrayBuffer();
  const view = new DataView(buffer);
  const text = (offset, length) => String.fromCharCode(...new Uint8Array(buffer, offset, length));

  assert.equal(wav.type, 'audio/wav');
  assert.equal(buffer.byteLength, 50);
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(text(12, 4), 'fmt ');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual(
    [view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)],
    [-32768, 0, 32767],
  );
});

test('normalizes a WAV recording with the wrong sample rate before transcription', async () => {
  const originalAudioContext = globalThis.AudioContext;
  const originalOfflineAudioContext = globalThis.OfflineAudioContext;
  let decoded = false;
  globalThis.AudioContext = class {
    async decodeAudioData() {
      decoded = true;
      return { duration: 0.01 };
    }
    async close() {}
  };
  globalThis.OfflineAudioContext = class {
    constructor(channels, frames, sampleRate) {
      assert.deepEqual([channels, frames, sampleRate], [1, 160, 16000]);
      this.destination = {};
    }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => new Float32Array(160) }; }
  };

  try {
    const recording = encodeMonoPcm16(new Float32Array(441), 44100);
    const converted = await toTranscriptionWav(recording);
    const view = new DataView(await converted.arrayBuffer());
    assert.equal(decoded, true);
    assert.equal(view.getUint32(24, true), 16000);
    assert.equal(view.getUint16(22, true), 1);
  } finally {
    globalThis.AudioContext = originalAudioContext;
    globalThis.OfflineAudioContext = originalOfflineAudioContext;
  }
});

test('rejects already-normal WAV recordings that exceed the demo transcription limit', async () => {
  const recording = encodeMonoPcm16(new Float32Array(16000 * 91), 16000);

  await assert.rejects(
    () => toTranscriptionWav(recording),
    /too long to transcribe/,
  );
});

test('rejects decoded recordings that exceed the demo transcription limit before rendering', async () => {
  const originalAudioContext = globalThis.AudioContext;
  const originalOfflineAudioContext = globalThis.OfflineAudioContext;
  let rendered = false;
  globalThis.AudioContext = class {
    async decodeAudioData() {
      return { duration: 91 };
    }
    async close() {}
  };
  globalThis.OfflineAudioContext = class {
    async startRendering() {
      rendered = true;
      return { getChannelData: () => new Float32Array(0) };
    }
  };

  try {
    await assert.rejects(
      () => toTranscriptionWav(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })),
      /too long to transcribe/,
    );
    assert.equal(rendered, false);
  } finally {
    globalThis.AudioContext = originalAudioContext;
    globalThis.OfflineAudioContext = originalOfflineAudioContext;
  }
});

test('rejects when browser audio decoding hangs', async () => {
  const originalAudioContext = globalThis.AudioContext;
  const originalOfflineAudioContext = globalThis.OfflineAudioContext;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeoutMs = [];
  let closed = false;
  globalThis.setTimeout = (callback, ms) => {
    timeoutMs.push(ms);
    queueMicrotask(callback);
    return 7;
  };
  globalThis.clearTimeout = () => {};
  globalThis.AudioContext = class {
    decodeAudioData() { return new Promise(() => {}); }
    async close() { closed = true; }
  };
  globalThis.OfflineAudioContext = class {};

  try {
    await assert.rejects(
      () => toTranscriptionWav(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })),
      /Audio decoding timed out/,
    );
    assert.deepEqual(timeoutMs, [15_000, 1000]);
    assert.equal(closed, true);
  } finally {
    globalThis.AudioContext = originalAudioContext;
    globalThis.OfflineAudioContext = originalOfflineAudioContext;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('rejects when offline audio rendering hangs', async () => {
  const originalAudioContext = globalThis.AudioContext;
  const originalOfflineAudioContext = globalThis.OfflineAudioContext;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeoutMs = [];
  let closed = false;
  globalThis.setTimeout = (callback, ms) => {
    timeoutMs.push(ms);
    queueMicrotask(callback);
    return 8;
  };
  globalThis.clearTimeout = () => {};
  globalThis.AudioContext = class {
    async decodeAudioData() { return { duration: 0.01 }; }
    async close() { closed = true; }
  };
  globalThis.OfflineAudioContext = class {
    constructor() { this.destination = {}; }
    createBufferSource() { return { connect() {}, start() {} }; }
    startRendering() { return new Promise(() => {}); }
  };

  try {
    await assert.rejects(
      () => toTranscriptionWav(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })),
      /Audio conversion timed out/,
    );
    assert.deepEqual(timeoutMs, [15_000, 15_000, 1000]);
    assert.equal(closed, true);
  } finally {
    globalThis.AudioContext = originalAudioContext;
    globalThis.OfflineAudioContext = originalOfflineAudioContext;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('rejects conversion immediately when the request signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => toTranscriptionWav(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('does not start audio decoding if the request aborts while reading the blob', async () => {
  const originalAudioContext = globalThis.AudioContext;
  const originalOfflineAudioContext = globalThis.OfflineAudioContext;
  const controller = new AbortController();
  let decodeCalls = 0;
  let closed = false;
  globalThis.AudioContext = class {
    decodeAudioData() {
      decodeCalls++;
      return Promise.resolve({ duration: 0.01 });
    }
    async close() { closed = true; }
  };
  globalThis.OfflineAudioContext = class {};
  const recording = {
    size: 3,
    type: 'audio/webm',
    async arrayBuffer() {
      controller.abort();
      return new ArrayBuffer(3);
    },
  };

  try {
    await assert.rejects(
      () => toTranscriptionWav(recording, { signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.equal(decodeCalls, 0);
    assert.equal(closed, true);
  } finally {
    globalThis.AudioContext = originalAudioContext;
    globalThis.OfflineAudioContext = originalOfflineAudioContext;
  }
});

test('does not wait indefinitely for audio context close after a conversion failure', async () => {
  const originalAudioContext = globalThis.AudioContext;
  const originalOfflineAudioContext = globalThis.OfflineAudioContext;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timeoutMs;
  let clearCalls = 0;
  globalThis.setTimeout = (callback, ms) => {
    timeoutMs = ms;
    queueMicrotask(callback);
    return 11;
  };
  globalThis.clearTimeout = () => { clearCalls++; };
  globalThis.AudioContext = class {
    async decodeAudioData() { throw new Error('decode failed'); }
    close() { return new Promise(() => {}); }
  };
  globalThis.OfflineAudioContext = class {};

  try {
    await assert.rejects(
      () => toTranscriptionWav(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })),
      /decode failed/,
    );
    assert.equal(timeoutMs, 1000);
    assert.equal(clearCalls, 2);
  } finally {
    globalThis.AudioContext = originalAudioContext;
    globalThis.OfflineAudioContext = originalOfflineAudioContext;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
