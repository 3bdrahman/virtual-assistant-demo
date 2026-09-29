import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createApp } from '../server/index.js';

function makeLogger() {
  const entries = [];
  return {
    entries,
    log: (...args) => entries.push(['log', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
}

async function withServer(options, run) {
  const app = createApp({ serveStatic: false, logger: { log() {}, warn() {}, error() {} }, ...options });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readJson(res) {
  return JSON.parse(await res.text());
}

function wavBytes() {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

function wavWithMisalignedPcmFrame() {
  const bytes = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  assert.equal(bytes.length, 46);
  return bytes;
}

function postSlowBody(origin, { path, headers, firstChunk }) {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        req.destroy();
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.write(firstChunk);
  });
}

function postExpectAborted(origin, { path, headers, body }) {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      let ended = false;
      let aborted = false;
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        ended = true;
        resolve({ ended, aborted, body: Buffer.concat(chunks) });
      });
      res.on('aborted', () => {
        aborted = true;
        resolve({ ended, aborted, body: Buffer.concat(chunks) });
      });
      res.on('error', (error) => {
        if (aborted || error.code === 'ECONNRESET') {
          resolve({ ended, aborted: true, body: Buffer.concat(chunks) });
        } else {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('stalled NVIDIA STT JSON bodies time out and release the provider slot', async () => {
  let upstreamCalls = 0;
  let cancelled = 0;
  await withServer({
    env: { NVIDIA_API_KEY: 'nv-test' },
    providerTimeoutMs: 30,
    providerLimits: { maxConcurrent: 1, maxRequests: 20 },
    fetchImpl: async () => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"text"'));
          },
          cancel() {
            cancelled += 1;
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ text: 'retry ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    },
  }, async (origin) => {
    const stalled = await fetch(`${origin}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBytes(),
    });
    assert.equal(stalled.status, 504);
    assert.match((await readJson(stalled)).error, /timed out/i);

    const retry = await fetch(`${origin}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBytes(),
    });
    assert.equal(retry.status, 200);
    assert.deepEqual(await readJson(retry), { text: 'retry ok' });
  });
  assert.equal(upstreamCalls, 2);
  assert.equal(cancelled, 1);
});

test('chat timeout after response headers emits a retryable stream error and frees the slot', async () => {
  let calls = 0;
  await withServer({
    env: { NVIDIA_API_KEY: 'test-only' }, providerTimeoutMs: 25,
    providerLimits: { maxConcurrent: 1, maxRequests: 20 },
    fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { if (calls > 1) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); } },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  }, async (origin) => {
    const request = () => fetch(`${origin}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }) });
    const first = await request();
    assert.equal(first.status, 200);
    assert.match(await first.text(), /provider_timeout/);
    const retry = await request();
    assert.equal(retry.status, 200);
    assert.match(await retry.text(), /\[DONE\]/);
  });
});

test('slow STT upload bodies are bounded before provider work', async () => {
  let upstreamCalls = 0;
  await withServer({
    env: { NVIDIA_API_KEY: 'nv-test' },
    sttUploadTimeoutMs: 25,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('unreachable');
    },
  }, async (origin) => {
    const response = await postSlowBody(origin, {
      path: '/api/stt',
      headers: { 'Content-Type': 'audio/wav', 'Transfer-Encoding': 'chunked' },
      firstChunk: Buffer.from([0x52]),
    });
    assert.equal(response.status, 408);
    assert.deepEqual(JSON.parse(response.body), { error: 'Audio upload timed out.' });
  });
  assert.equal(upstreamCalls, 0);
});

test('STT rejects PCM data chunks that are not aligned to the WAV frame size', async () => {
  let upstreamCalls = 0;
  await withServer({
    env: { NVIDIA_API_KEY: 'nv-test' },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('unreachable');
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavWithMisalignedPcmFrame(),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await readJson(response), { error: 'Audio upload must be a valid WAV file.' });
  });
  assert.equal(upstreamCalls, 0);
});

test('unsupported JSON charsets return a client error before provider work', async () => {
  let upstreamCalls = 0;
  await withServer({
    env: { NVIDIA_API_KEY: 'nv-test' },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('unreachable');
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=klingon' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 415);
    assert.deepEqual(await readJson(response), { error: 'Request body charset is not supported.' });
  });
  assert.equal(upstreamCalls, 0);
});

test('partial TTS provider streams abort the client response after audio bytes are sent', async () => {
  let releaseError;
  await withServer({
    env: { NVIDIA_API_KEY: 'nv-test' },
    fetchImpl: async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(wavBytes().subarray(0, 20));
        await new Promise((resolve) => setImmediate(resolve));
        controller.error(new Error('provider audio truncated'));
      },
      cancel(error) {
        releaseError = error;
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    }),
  }, async (origin) => {
    const result = await postExpectAborted(origin, {
      path: '/api/tts',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello voice' }),
    });
    assert.equal(result.ended, false);
    assert.equal(result.aborted, true);
    assert.ok(result.body.length > 0);
  });
  assert.equal(releaseError, undefined);
});

test('visitor-key mode health hides owner keys and requires per-request Authorization', async () => {
  let upstreamCalls = 0;
  await withServer({
    env: { NVIDIA_API_KEY: 'owner-key-never-used', REQUIRE_USER_KEY: 'true' },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  }, async (origin) => {
    const health = await readJson(await fetch(`${origin}/api/health`));
    assert.deepEqual(health, {
      ok: true,
      hasNvidiaKey: false,
      requiresUserKey: true,
      services: { nvidia: { configured: false } },
    });

    const missingKey = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(missingKey.status, 401);
    assert.deepEqual(await readJson(missingKey), { error: 'NVIDIA API key is required for this demo.' });
  });
  assert.equal(upstreamCalls, 0);
});

test('concurrent visitor-key requests keep separate Authorization identities and never use owner fallback', async () => {
  const authorizations = [];
  let releaseProviders;
  await withServer({
    env: { NVIDIA_API_KEY: 'owner-key-never-used', REQUIRE_USER_KEY: 'true' },
    fetchImpl: async (_url, init) => {
      authorizations.push(init.headers.Authorization);
      if (authorizations.length === 2) releaseProviders();
      while (authorizations.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: init.headers.Authorization } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  }, async (origin) => {
    const bothStarted = new Promise((resolve) => {
      releaseProviders = resolve;
    });
    const request = (key) => fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    const first = request('visitor-one');
    const second = request('visitor-two');
    await bothStarted;
    const responses = await Promise.all([first, second]);
    assert.equal(responses[0].status, 200);
    assert.equal(responses[1].status, 200);
  });

  assert.deepEqual(authorizations.sort(), ['Bearer visitor-one', 'Bearer visitor-two']);
  assert.equal(authorizations.includes('Bearer owner-key-never-used'), false);
});

test('visitor Authorization is optional in local owner-key mode and overrides the owner key when present', async () => {
  const authorizations = [];
  await withServer({
    env: { NVIDIA_API_KEY: 'owner-key' },
    fetchImpl: async (_url, init) => {
      authorizations.push(init.headers.Authorization);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  }, async (origin) => {
    for (const headers of [
      { 'Content-Type': 'application/json' },
      { 'Content-Type': 'application/json', Authorization: 'Bearer visitor-key' },
    ]) {
      const response = await fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
      });
      assert.equal(response.status, 200);
    }
  });
  assert.deepEqual(authorizations, ['Bearer owner-key', 'Bearer visitor-key']);
});

test('visitor keys are validated from Authorization only before provider work', async () => {
  let upstreamCalls = 0;
  await withServer({
    env: { NVIDIA_API_KEY: 'owner-key', REQUIRE_USER_KEY: 'true' },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('unreachable');
    },
  }, async (origin) => {
    for (const authorization of [
      'Basic visitor-key',
      'Bearer visitor key',
      `Bearer ${'a'.repeat(4097)}`,
    ]) {
      const response = await fetch(`${origin}/api/tts?api_key=query-key`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello', apiKey: 'body-key' }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await readJson(response), { error: 'Authorization header must be a valid Bearer token.' });
    }

    const bodyKeyOnly = await fetch(`${origin}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', apiKey: 'body-key' }),
    });
    assert.equal(bodyKeyOnly.status, 401);
    assert.deepEqual(await readJson(bodyKeyOnly), { error: 'NVIDIA API key is required for this demo.' });
  });
  assert.equal(upstreamCalls, 0);
});

test('visitor-key provider rejections tell the visitor to check their key', async () => {
  await withServer({
    env: { REQUIRE_USER_KEY: 'true' },
    fetchImpl: async () => new Response('bad key', { status: 403 }),
  }, async (origin) => {
    const response = await fetch(`${origin}/api/tts`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer visitor-bad-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 401);
    const payload = await readJson(response);
    assert.equal(payload.providerStatus, 403);
    assert.match(payload.error, /visitor key/i);
    assert.match(payload.error, /check/i);
  });
});

test('visitor keys are not exposed in health responses, error bodies, or logs', async () => {
  const logger = makeLogger();
  await withServer({
    env: { REQUIRE_USER_KEY: 'true' },
    logger,
    fetchImpl: async () => {
      throw new Error('upstream failed for visitor-secret');
    },
  }, async (origin) => {
    const healthText = await (await fetch(`${origin}/api/health`)).text();
    assert.doesNotMatch(healthText, /visitor-secret/);

    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer visitor-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /visitor-secret/);
  });
  assert.doesNotMatch(JSON.stringify(logger.entries), /visitor-secret/);
  assert.match(JSON.stringify(logger.entries), /\[redacted\]/);
});

test('allowed CORS origins apply to health GETs and Authorization preflights only for exact origins', async () => {
  await withServer({
    env: { ALLOWED_ORIGINS: 'https://demo.example' },
  }, async (origin) => {
    const allowedHealth = await fetch(`${origin}/api/health`, {
      headers: { Origin: 'https://demo.example' },
    });
    assert.equal(allowedHealth.status, 200);
    assert.equal(allowedHealth.headers.get('access-control-allow-origin'), 'https://demo.example');
    assert.equal(allowedHealth.headers.get('vary'), 'Origin');

    const untrustedHealth = await fetch(`${origin}/api/health`, {
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(untrustedHealth.status, 200);
    assert.equal(untrustedHealth.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${origin}/api/chat`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://demo.example',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://demo.example');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');

    const blockedPreflight = await fetch(`${origin}/api/chat`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(blockedPreflight.status, 403);
    assert.equal(blockedPreflight.headers.get('access-control-allow-origin'), null);
  });
});

test('SERVE_STATIC=false keeps the server in API-only mode even when a static build exists', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-static-disabled-'));
  try {
    fs.writeFileSync(path.join(fixtureDir, 'index.html'), '<!doctype html><title>static fixture</title>');
    await withServer({
      env: { SERVE_STATIC: 'false' },
      staticDir: fixtureDir,
    }, async (origin) => {
      const response = await fetch(`${origin}/`);
      assert.equal(response.status, 404);
      assert.match(response.headers.get('content-type'), /text\/html/);
    });
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
