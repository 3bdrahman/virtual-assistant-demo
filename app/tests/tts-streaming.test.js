import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { createApp } from '../server/index.js';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function postStreamingTts(origin, { body = { text: 'hello voice', stream: true } } = {}) {
  const url = new URL('/api/tts', origin);
  const payload = JSON.stringify(body);
  const req = http.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  });
  req.end(payload);
  return req;
}

function onceResponse(req) {
  return new Promise((resolve, reject) => {
    req.once('response', resolve);
    req.once('error', reject);
  });
}

function onceData(res) {
  return new Promise((resolve, reject) => {
    res.once('data', resolve);
    res.once('error', reject);
    res.once('aborted', () => reject(new Error('response aborted before data')));
  });
}

test('streaming TTS proxies first PCM bytes before the NVIDIA online response closes', async () => {
  const releaseProvider = deferred();
  const firstPcm = Buffer.from([0x01, 0x00, 0x02, 0x00]);
  const lastPcm = Buffer.from([0x03, 0x00]);
  const upstreamCalls = [];

  await withServer({
    env: { NVIDIA_API_KEY: 'nv-test' },
    fetchImpl: async (url, init) => {
      upstreamCalls.push({ url, init });
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(firstPcm);
          await releaseProvider.promise;
          controller.enqueue(lastPcm);
          controller.close();
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    },
  }, async (origin) => {
    const req = postStreamingTts(origin);
    const res = await onceResponse(req);
    const chunk = await onceData(res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'audio/pcm;rate=44100;channels=1');
    assert.equal(res.headers['cache-control'], 'no-store,no-transform');
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.deepEqual(chunk, firstPcm);
    assert.equal(upstreamCalls.length, 1);
    assert.match(upstreamCalls[0].url, /\/v1\/audio\/synthesize_online$/);
    assert.equal(upstreamCalls[0].init.body.get('text'), 'hello voice');
    assert.equal(upstreamCalls[0].init.body.get('sample_rate_hz'), '44100');

    releaseProvider.resolve();
    const remaining = [];
    for await (const value of res) remaining.push(value);
    assert.deepEqual(Buffer.concat(remaining), lastPcm);
  });
});

test('streaming TTS client disconnect aborts NVIDIA and frees provider capacity', async () => {
  const firstPcm = Buffer.from([0x01, 0x00]);
  let upstreamCalls = 0;
  let providerAborts = 0;
  let providerCancels = 0;

  await withServer({
    env: { NVIDIA_API_KEY: 'nv-test' },
    providerLimits: { maxConcurrent: 1, maxRequests: 20 },
    fetchImpl: async (_url, init) => {
      upstreamCalls += 1;
      init.signal.addEventListener('abort', () => {
        providerAborts += 1;
      }, { once: true });
      if (upstreamCalls === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(firstPcm);
          },
          cancel() {
            providerCancels += 1;
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'audio/pcm' },
        });
      }
      return new Response(Buffer.from([0x02, 0x00]), {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      });
    },
  }, async (origin) => {
    const firstReq = postStreamingTts(origin);
    const firstRes = await onceResponse(firstReq);
    assert.deepEqual(await onceData(firstRes), firstPcm);
    firstRes.destroy();

    await new Promise((resolve) => setImmediate(resolve));

    const retry = await fetch(`${origin}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'retry voice', stream: true }),
    });
    assert.equal(retry.status, 200);
    assert.deepEqual(Buffer.from(await retry.arrayBuffer()), Buffer.from([0x02, 0x00]));
  });

  assert.equal(upstreamCalls, 2);
  assert.ok(providerAborts >= 1);
  assert.ok(providerCancels >= 1);
});

test('streaming TTS validates opt-in flag and rejects non-PCM online responses', async () => {
  const rejectedTypes = ['application/json', 'text/plain', 'audio/wav'];
  let contentType = rejectedTypes[0];
  let providerCancels = 0;

  await withServer({
    env: { NVIDIA_API_KEY: 'nv-test' },
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('bad format'));
      },
      cancel() {
        providerCancels += 1;
      },
    }), {
      status: 200,
      headers: { 'Content-Type': contentType },
    }),
  }, async (origin) => {
    const invalid = await fetch(`${origin}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello voice', stream: 'yes' }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await readJson(invalid), { error: 'stream must be a boolean when provided.' });

    for (const rejectedType of rejectedTypes) {
      contentType = rejectedType;
      const response = await fetch(`${origin}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello voice', stream: true }),
      });
      assert.equal(response.status, 502, rejectedType);
      assert.deepEqual(await readJson(response), { error: 'NVIDIA TTS returned an unexpected response format.' });
    }
  });

  assert.equal(providerCancels, rejectedTypes.length);
});
