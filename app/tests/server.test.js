import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';

import viteConfig from '../vite.config.js';
import { DEFAULT_PORT, createApp, start } from '../server/index.js';

const servers = [];

function makeLogger() {
  const entries = [];
  const logger = {
    entries,
    log: (...args) => entries.push(['log', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
  return logger;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
  };
}

async function readJson(res) {
  return JSON.parse(await res.text());
}

function wavBytes() {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    ),
  );
});

describe('server contract', () => {
  it('uses one dev proxy port and exports a start function for production scripts', () => {
    assert.equal(DEFAULT_PORT, 3011);
    assert.equal(viteConfig.server.proxy['/api'].target, 'http://localhost:3011');
    assert.equal(typeof start, 'function');
  });

  it('fails startup visibly when the listen callback receives an error', () => {
    const logger = makeLogger();
    const listenError = new Error('listen EPERM');
    const app = { listen: (_port, _host, callback) => callback(listenError) };

    assert.throws(() => start({ app, env: { PORT: '3012' }, logger }), listenError);
    assert.equal(logger.entries.some(([level, message]) => level === 'log' && message.includes('running')), false);
  });

  it('uses the hosting platform PORT before a local proxy port override', () => {
    let selectedPort;
    const app = {
      listen: (port, _host, callback) => {
        selectedPort = port;
        callback();
        return {};
      },
    };
    start({ app, env: { PORT: '4123', PROXY_PORT: '3011' }, logger: makeLogger() });
    assert.equal(selectedPort, 4123);
  });

  it('reports health without exposing or mutating server-side keys', async () => {
    const logger = makeLogger();
    const app = createApp({
      env: {},
      logger,
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      },
    });
    const { origin } = await listen(app);

    const initial = await readJson(await fetch(`${origin}/api/health`));
    assert.deepEqual(initial, {
      ok: true,
      hasNvidiaKey: false,
      services: {
        nvidia: { configured: false },
      },
    });
    assert.equal('hasElevenLabsKey' in initial, false);
    assert.equal('elevenlabs' in initial.services, false);

    const configRes = await fetch(`${origin}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'nvapi-secret' }),
    });
    assert.equal(configRes.status, 404);

    const afterConfig = await readJson(await fetch(`${origin}/api/health`));
    assert.equal(afterConfig.services.nvidia.configured, false);
    assert.equal(JSON.stringify(logger.entries).includes('nvapi-secret'), false);
  });

  it('blocks cross-origin API writes before calling providers', async () => {
    let upstreamCalls = 0;
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      fetchImpl: async () => {
        upstreamCalls += 1;
        return new Response('unreachable');
      },
    });
    const { origin } = await listen(app);

    const res = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://untrusted.example',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    assert.equal(res.status, 403);
    assert.equal(upstreamCalls, 0);
  });

  it('validates chat input and streams NVIDIA SSE without real provider calls', async () => {
    const upstreamBodies = [];
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      fetchImpl: async (_url, init) => {
        upstreamBodies.push(JSON.parse(init.body));
        return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    });
    const { origin } = await listen(app);

    const badRes = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(badRes.status, 400);

    const streamRes = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type'), /text\/event-stream/);
    assert.match(await streamRes.text(), /data: \[DONE\]/);
    assert.equal(upstreamBodies.length, 1);
    assert.deepEqual(upstreamBodies[0].messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(upstreamBodies[0].model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
    assert.deepEqual(upstreamBodies[0].chat_template_kwargs, { enable_thinking: false });
    assert.equal(upstreamBodies[0].max_tokens, 256);
  });

  it('rejects client-selected chat models before calling NVIDIA', async () => {
    let upstreamCalls = 0;
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      fetchImpl: async () => {
        upstreamCalls += 1;
        return new Response('unreachable');
      },
    });
    const { origin } = await listen(app);

    const res = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'attacker/expensive-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(res.status, 400);
    assert.equal(upstreamCalls, 0);
    assert.deepEqual(await readJson(res), { error: 'model is selected by the server.' });
  });

  it('rejects chat histories that break the user and assistant turn order', async () => {
    let upstreamCalls = 0;
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      fetchImpl: async () => {
        upstreamCalls++;
        return new Response('unreachable');
      },
    });
    const { origin } = await listen(app);
    const invalidHistories = [
      [{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }],
      [{ role: 'assistant', content: 'orphaned reply' }],
      [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
      [{ role: 'user', content: 'hello' }, { role: 'system', content: 'late rules' }, { role: 'user', content: 'again' }],
    ];

    for (const messages of invalidHistories) {
      const res = await fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      assert.equal(res.status, 400);
    }
    assert.equal(upstreamCalls, 0);
  });

  it('times out a stalled chat provider and releases its request slot', async () => {
    let upstreamCalls = 0;
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      providerTimeoutMs: 60,
      providerLimits: { maxConcurrent: 1 },
      fetchImpl: async (_url, init) => {
        upstreamCalls++;
        if (upstreamCalls === 1) {
          return new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        }
        return new Response('data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    });
    const { origin } = await listen(app);
    const request = () => fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    const stalled = await request();
    assert.equal(stalled.status, 504);
    assert.match((await readJson(stalled)).error, /timed out/i);
    const next = await request();
    assert.equal(next.status, 200);
    assert.equal(upstreamCalls, 2);
  });

  it('enforces per-IP provider request rate limits without trusting forwarded IP headers by default', async () => {
    let upstreamCalls = 0;
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      providerLimits: { windowMs: 60_000, maxRequests: 1, maxConcurrent: 1 },
      fetchImpl: async () => {
        upstreamCalls += 1;
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    });
    const { origin } = await listen(app);
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });

    const first = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.1' },
      body,
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.2' },
      body,
    });
    assert.equal(second.status, 429);
    assert.equal(upstreamCalls, 1);
    assert.equal(second.headers.get('retry-after'), '60');
    assert.deepEqual(await readJson(second), { error: 'Too many provider requests. Please try again shortly.' });
  });

  it('enforces per-IP provider concurrency limits', async () => {
    let releaseProvider;
    let upstreamCalls = 0;
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      providerLimits: { windowMs: 60_000, maxRequests: 10, maxConcurrent: 1 },
      fetchImpl: async () => {
        upstreamCalls += 1;
        await new Promise((resolve) => {
          releaseProvider = resolve;
        });
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    });
    const { origin } = await listen(app);
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });

    const first = fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    while (!releaseProvider) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const second = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(second.status, 429);
    assert.deepEqual(await readJson(second), { error: 'Too many provider requests already running. Please retry in a moment.' });
    assert.equal(upstreamCalls, 1);

    releaseProvider();
    assert.equal((await first).status, 200);
  });

  it('accepts only WAV audio for NVIDIA STT and sends the confirmed form fields', async () => {
    const upstreamCalls = [];
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      fetchImpl: async (url, init) => {
        upstreamCalls.push({ url, init });
        assert.match(url, /1598d209-5e27-4d3c-8079-4751568b1081\.invocation\.api\.nvcf\.nvidia\.com/);
        assert.equal(init.headers.Authorization, 'Bearer nv-test');
        assert.equal(init.body.get('language'), 'en-US');
        assert.equal(init.body.get('file').type, 'audio/wav');
        return new Response(JSON.stringify({ text: 'hello from wav' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const { origin } = await listen(app);

    const webmRes = await fetch(`${origin}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('webm-opus'),
    });
    assert.equal(webmRes.status, 415);

    const invalidWavRes = await fetch(`${origin}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: Buffer.from('not a wav file'),
    });
    assert.equal(invalidWavRes.status, 400);

    const res = await fetch(`${origin}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBytes(),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await readJson(res), { text: 'hello from wav' });
    assert.equal(upstreamCalls.length, 1);
  });

  it('synthesizes NVIDIA Magpie speech as binary audio/wav with the server key', async () => {
    const audio = wavBytes();
    const upstreamCalls = [];
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      fetchImpl: async (url, init) => {
        upstreamCalls.push({ url, init });
        assert.match(url, /877104f7-e885-42b9-8de8-f6e4c6303969\.invocation\.api\.nvcf\.nvidia\.com/);
        assert.equal(init.headers.Authorization, 'Bearer nv-test');
        assert.equal(init.body.get('text'), 'hello voice');
        assert.equal(init.body.get('language'), 'en-US');
        assert.equal(init.body.get('voice'), 'Magpie-Multilingual.EN-US.Aria');
        assert.equal(init.body.get('encoding'), 'LINEAR_PCM');
        assert.equal(init.body.get('sample_rate_hz'), '44100');
        return new Response(audio, {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        });
      },
    });
    const { origin } = await listen(app);

    const res = await fetch(`${origin}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello voice' }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /audio\/wav/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), audio);
    assert.equal(upstreamCalls.length, 1);
  });

  it('uses NVIDIA_API_KEY for TTS and does not accept an ElevenLabs-only configuration', async () => {
    const app = createApp({
      env: { ELEVENLABS_API_KEY: 'el-test' },
      logger: makeLogger(),
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      },
    });
    const { origin } = await listen(app);

    const res = await fetch(`${origin}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });

    assert.equal(res.status, 503);
    assert.deepEqual(await readJson(res), { error: 'NVIDIA API key is not configured on the server.' });
  });

  it('returns explicit provider errors instead of empty success responses', async () => {
    const app = createApp({
      env: { NVIDIA_API_KEY: 'nv-test' },
      logger: makeLogger(),
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
    });
    const { origin } = await listen(app);

    const res = await fetch(`${origin}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });

    assert.equal(res.status, 429);
    assert.deepEqual(await readJson(res), {
      error: 'NVIDIA TTS provider error.',
      providerStatus: 429,
    });
  });

  it('reports a rejected server key clearly', async () => {
    const app = createApp({
      env: { NVIDIA_API_KEY: 'expired-key' },
      logger: makeLogger(),
      fetchImpl: async () => new Response('authorization failed', { status: 403 }),
    });
    const { origin } = await listen(app);
    const res = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });
    assert.equal(res.status, 503);
    assert.match((await readJson(res)).error, /server key.*update/i);
  });

});
