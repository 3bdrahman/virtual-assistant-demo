import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, synthesize, transcribe, checkHealth } from '../src/services/nim.js';
import { encodeMonoPcm16 } from '../src/services/wav.js';

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
    const transcript = await transcribe(encodeMonoPcm16(new Float32Array(160), 16000));
    assert.equal(transcript, 'Hello from the demo.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('health check ends a stalled request and reports the service unavailable', async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (_url, options) => new Promise((_, reject) => {
    assert.equal(options.cache, 'no-store');
    options.signal.addEventListener('abort', () => {
      aborted = true;
      reject(options.signal.reason);
    }, { once: true });
  });
  try {
    assert.deepEqual(await checkHealth(30), { ok: false, hasNvidiaKey: false });
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat accepts SSE without a space and stops at DONE on an open connection', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data:{"choices":[{"delta":{"content":"Hello 🌍"}}]}\r\n\r\ndata:[DONE]\r\n\r\n'));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    assert.equal(await streamChat([], { timeoutMs: 30 }), 'Hello 🌍');
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat has a client deadline when the server never responds', async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => {
    signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  try {
    await assert.rejects(streamChat([], { timeoutMs: 25 }), /timed out/i);
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat cancellation propagates to fetch', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const pending = streamChat([], { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('malformed health data never enables live conversation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: 'false', hasNvidiaKey: 'false' });
  try {
    assert.deepEqual(await checkHealth(), { ok: false, hasNvidiaKey: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transcription rejects malformed success payloads', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ text: { unexpected: true } });
  try {
    await assert.rejects(transcribe(encodeMonoPcm16(new Float32Array(160))), /invalid transcript/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat rejects non-text tokens and oversized replies', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const content of [{ invalid: true }, 'x'.repeat(8001)]) {
      globalThis.fetch = async () => sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
      ]);
      await assert.rejects(streamChat([]), /invalid|too long/i);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat reconstructs UTF-8 and multiline SSE split at every byte', async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode('data: {"choices":\r\ndata: [{"delta":{"content":"Hi 🌍 こんにちは"}}]}\r\n\r\ndata:[DONE]');
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    assert.equal(await streamChat([]), 'Hi 🌍 こんにちは');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat deadline cancels a stalled response body after headers arrive', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data:{"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await assert.rejects(streamChat([], { timeoutMs: 30 }), /timed out/i);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat cleans up the reader after malformed provider JSON', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data:{broken}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await assert.rejects(streamChat([]), /invalid/i);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('visitor credentials are sent only in Authorization on provider requests', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return Response.json({ ok: true, hasNvidiaKey: false, requiresUserKey: true });
    if (url.endsWith('/chat')) return sseResponse(['data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n']);
    if (url.endsWith('/stt')) return Response.json({ text: 'Hello' });
    return new Response('wav', { headers: { 'Content-Type': 'audio/wav' } });
  };
  try {
    const apiKey = 'nvapi-test-visitor';
    await streamChat([{ role: 'user', content: 'Hello' }], { apiKey });
    await synthesize('Hello', { apiKey });
    await transcribe(encodeMonoPcm16(new Float32Array(160)), { apiKey });
    assert.deepEqual(await checkHealth(), { ok: true, hasNvidiaKey: false, requiresUserKey: true });
    for (const { url, options } of calls.slice(0, 3)) {
      assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.ok(!url.includes(apiKey));
      if (typeof options.body === 'string') assert.ok(!options.body.includes(apiKey));
    }
    assert.equal(calls.at(-1).options.headers?.Authorization, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('chat reports the retryable timeout from a stream instead of losing the failure reason', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(['data: {"error":{"code":"provider_timeout"}}\n\n']);
  try { await assert.rejects(streamChat([]), /timed out.*retry/i); }
  finally { globalThis.fetch = originalFetch; }
});
