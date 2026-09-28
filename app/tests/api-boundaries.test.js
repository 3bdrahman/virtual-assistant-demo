import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createApp } from '../server/index.js';
import { encodeMonoPcm16 } from '../src/services/wav.js';

async function withServer(options, run) {
  const app = createApp({ serveStatic: false, logger: { log() {}, warn() {}, error() {} }, ...options });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await run(origin); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('invalid JSON, oversized requests, and invalid turn shapes never consume provider calls', async () => {
  let providerCalls = 0;
  const samples = [
    ['/chat', '{}', 400],
    ['/chat', '{', 400],
    ['/chat', JSON.stringify({ messages: [] }), 400],
    ['/chat', JSON.stringify({ messages: [null] }), 400],
    ['/chat', JSON.stringify({ messages: [{ role: 'user', content: {} }] }), 400],
    ['/chat', JSON.stringify({ messages: [{ role: 'user', content: '   ' }] }), 400],
    ['/chat', JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(8001) }] }), 400],
    ['/chat', JSON.stringify({ messages: [{ role: 'assistant', content: 'First' }] }), 400],
    ['/chat', JSON.stringify({ messages: [{ role: 'system', content: 'Only system' }] }), 400],
    ['/chat', JSON.stringify({ messages: Array.from({ length: 27 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Hi' })) }), 400],
    ['/tts', '{}', 400],
    ['/tts', JSON.stringify({ text: '   ' }), 400],
    ['/tts', JSON.stringify({ text: 'Hello', voice: 'untrusted' }), 400],
    ['/tts', JSON.stringify({ text: 'x'.repeat(1024 * 1024) }), 413],
  ];
  await withServer({ env: { NVIDIA_API_KEY: 'test-only' }, fetchImpl: async () => { providerCalls++; throw new Error('Unexpected provider call'); } }, async (origin) => {
    for (const [route, body, status] of samples) {
      const response = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, status, `${route}: ${body.slice(0, 90)}`);
      assert.equal(typeof (await response.json()).error, 'string');
    }
    for (const route of ['/chat', '/tts']) {
      const response = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
      assert.equal(response.status, 415);
    }
  });
  assert.equal(providerCalls, 0);
});

test('missing configuration keeps health truthful and blocks every paid API', async () => {
  await withServer({ env: {}, fetchImpl: () => { throw new Error('Must not run'); } }, async (origin) => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: true, hasNvidiaKey: false, services: { nvidia: { configured: false } } });
    for (const route of ['chat', 'stt', 'tts']) {
      const result = await fetch(`${origin}/api/${route}`, { method: 'POST' });
      assert.equal(result.status, 503);
      assert.match((await result.json()).error, /not configured/i);
    }
  });
});

test('provider errors are mapped without exposing provider body or credential', async () => {
  let status;
  await withServer({
    env: { NVIDIA_API_KEY: 'test-secret-never-public' },
    fetchImpl: async () => new Response('private provider details test-secret-never-public', { status }),
  }, async (origin) => {
    for (const [upstream, downstream] of [[401, 503], [403, 503], [429, 429], [400, 502], [500, 503]]) {
      status = upstream;
      const response = await fetch(`${origin}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
      });
      assert.equal(response.status, downstream);
      const text = await response.text();
      assert.doesNotMatch(text, /private provider|test-secret-never-public/);
    }
  });
});

test('speech API timeouts free their concurrency slots for retries', async () => {
  const wav = await encodeMonoPcm16(new Float32Array(160)).arrayBuffer();
  for (const route of ['stt', 'tts']) {
    let aborted = 0;
    await withServer({
      env: { NVIDIA_API_KEY: 'test-only' }, providerTimeoutMs: 30,
      providerLimits: { maxConcurrent: 1, maxRequests: 20 },
      fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
      }),
    }, async (origin) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${origin}/api/${route}`, {
          method: 'POST', headers: { 'Content-Type': route === 'stt' ? 'audio/wav' : 'application/json' },
          body: route === 'stt' ? wav : JSON.stringify({ text: 'Hello' }),
        });
        assert.equal(response.status, 504, `${route} retry ${attempt}`);
        assert.match((await response.json()).error, /timed out/i);
      }
    });
    assert.equal(aborted, 2);
  }
});

test('origin guard handles preflight and rejects untrusted writes before provider work', async () => {
  await withServer({ env: { NVIDIA_API_KEY: 'test-only', ALLOWED_ORIGINS: 'https://demo.example' } }, async (origin) => {
    const allowed = await fetch(`${origin}/api/chat`, { method: 'OPTIONS', headers: { Origin: 'https://demo.example' } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://demo.example');
    const blocked = await fetch(`${origin}/api/chat`, { method: 'POST', headers: { Origin: 'https://untrusted.example' } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  });
});

test('the production entry point starts and drains on SIGTERM', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', NVIDIA_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const finished = once(child, 'close');
  let output = '';
  const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Server exited before listening')));
      child.stdout.on('data', (data) => {
        output += data.toString();
        if (output.includes('Proxy server running')) resolve();
      });
    });
    child.kill('SIGTERM');
    const [code, signal] = await finished;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.match(output, /Received SIGTERM; shutting down/);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
