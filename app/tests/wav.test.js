import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMonoPcm16 } from '../src/services/wav.js';

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
