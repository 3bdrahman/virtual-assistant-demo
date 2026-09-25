import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, synthesize, transcribe } from '../src/services/nim.js';

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('streamChat reconstructs split SSE and returns the complete reply', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"Hello. Last"}}]}\n',
    '\ndata: {"choices":[{"delta":{"content":" thought"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const tokens = [];
    const result = await streamChat([{ role: 'user', content: 'Hi' }], {
      onToken: (token) => tokens.push(token),
    });
    assert.equal(result, 'Hello. Last thought');
    assert.deepEqual(tokens, ['Hello. Last', ' thought']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat rejects an incomplete provider stream', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"Partial reply"}}]}\n\n',
  ]);
  try {
    await assert.rejects(streamChat([], {}), /interrupt|incomplete/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TTS reports provider rejection instead of silently returning no audio', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'NVIDIA TTS provider is unavailable.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    await assert.rejects(synthesize('Hello'), /NVIDIA TTS provider is unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TTS accepts WAV audio from the server', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('sample audio', {
    headers: { 'Content-Type': 'audio/wav' },
  });
  try {
    const audio = await synthesize('Hi');
    assert.equal(audio.type, 'audio/wav');
    assert.equal(await audio.text(), 'sample audio');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transcription sends WAV and reads the live provider transcript', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers['Content-Type'], 'audio/wav');
    assert.equal(options.body.type, 'audio/wav');
    return new Response(JSON.stringify({ text: 'Hello from the demo.' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const transcript = await transcribe(new Blob(['wav'], { type: 'audio/wav' }));
    assert.equal(transcript, 'Hello from the demo.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
