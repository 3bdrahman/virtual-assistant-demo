// Explicit live release check. Uses the server credential and makes three provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { streamChat, synthesize, transcribe } from '../src/services/nim.js';
import { encodeMonoPcm16 } from '../src/services/wav.js';

// Normalize the provider's PCM WAV to the same mono 16 kHz format used by the UI.
function transcriptionAudio(bytes) {
  const view = new DataView(bytes);
  const tag = (offset) => String.fromCharCode(...new Uint8Array(bytes, offset, 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  let format;
  let audio;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    assert.ok(offset + 8 + size <= view.byteLength, 'Truncated speech WAV');
    if (tag(offset) === 'fmt ') {
      assert.ok(size >= 16);
      format = { encoding: view.getUint16(offset + 8, true), channels: view.getUint16(offset + 10, true),
        rate: view.getUint32(offset + 12, true), bits: view.getUint16(offset + 22, true) };
    }
    if (tag(offset) === 'data') audio = { offset: offset + 8, size };
    offset += 8 + size + size % 2;
  }
  assert.ok(format && audio, 'Speech WAV must have format and audio chunks');
  assert.equal(format.encoding, 1, 'Live probe expects PCM speech');
  assert.equal(format.bits, 16, 'Live probe expects 16-bit speech');
  assert.ok(format.channels > 0 && format.rate > 0);
  const frames = audio.size / (2 * format.channels);
  const samples = new Float32Array(Math.floor(frames * 16000 / format.rate));
  for (let index = 0; index < samples.length; index++) {
    const frame = Math.min(frames - 1, Math.floor(index * format.rate / 16000));
    let total = 0;
    for (let channel = 0; channel < format.channels; channel++) {
      total += view.getInt16(audio.offset + (frame * format.channels + channel) * 2, true) / 32768;
    }
    samples[index] = total / format.channels;
  }
  return encodeMonoPcm16(samples);
}

const originalFetch = globalThis.fetch;
const app = createApp({ serveStatic: false, logger: { log() {}, warn() {}, error() {} } });
const server = await new Promise((resolve, reject) => {
  const listener = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(listener));
  listener.once('error', reject);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const evidence = { startedAt: new Date().toISOString(), health: false, chat: false, speech: false, transcription: false };
let stage = 'health';
try {
  globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/api/') ? `${origin}${url}` : url, options);
  const health = await originalFetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5000) }).then((res) => res.json());
  assert.equal(health.hasNvidiaKey, true, 'NVIDIA_API_KEY is not configured on the server');
  evidence.health = true;
  stage = 'chat';
  const reply = await streamChat([{ role: 'user', content: 'Say only this short greeting: Hello from the virtual assistant demo.' }]);
  assert.ok(reply.trim(), 'Chat returned an empty answer');
  evidence.chat = true;
  evidence.replyCharacters = reply.length;
  stage = 'speech';
  const speech = await synthesize(reply.slice(0, 2000));
  evidence.speech = true;
  evidence.audioBytes = speech.size;
  if (process.env.LIVE_ARTIFACT_DIR) {
    await fs.mkdir(process.env.LIVE_ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.LIVE_ARTIFACT_DIR, 'voice-sample.wav'), Buffer.from(await speech.arrayBuffer()));
  }
  stage = 'transcription';
  const transcript = await transcribe(transcriptionAudio(await speech.arrayBuffer()));
  assert.ok(transcript.trim(), 'Transcription returned no speech');
  assert.match(transcript, /hello|virtual|assistant|demo/i, 'Transcript did not recognize the test greeting');
  evidence.transcription = true;
  evidence.transcriptCharacters = transcript.length;
} catch (error) {
  evidence.failedStage = stage;
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (process.env.LIVE_ARTIFACT_DIR) {
    await fs.mkdir(process.env.LIVE_ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.LIVE_ARTIFACT_DIR, 'live-result.json'), JSON.stringify(evidence, null, 2));
  }
  console.log(JSON.stringify(evidence, null, 2));
}
