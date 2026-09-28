import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDemoApi } from '../scripts/check-demo-api.mjs';

function relay({ ownerFallback = false, corsOrigin = 'https://demo.github.io', allowAuth = true, missingKeyStatus = 401 } = {}) {
  return async (url, options) => {
    assert.equal(options.headers.Origin, 'https://demo.github.io');
    assert.equal(options.headers.Authorization, undefined);
    const headers = { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Headers': allowAuth ? 'Authorization, Content-Type' : 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (url.endsWith('/health')) return Response.json({ ok: true, hasNvidiaKey: ownerFallback, requiresUserKey: !ownerFallback }, { headers });
    if (options.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    return Response.json({ error: 'Key required' }, { status: missingKeyStatus, headers });
  };
}

test('Pages release check verifies cross-origin visitor-key mode without provider credentials', async () => {
  const result = await checkDemoApi('https://api.example/api', 'https://demo.github.io', { fetchImpl: relay() });
  assert.equal(result.visitorKeysRequired, true);
  assert.equal(result.cors, 'passed');
});

test('Pages release is blocked by shared keys, bad CORS, or unprotected provider routes', async () => {
  for (const options of [{ ownerFallback: true }, { corsOrigin: '*' }, { allowAuth: false }, { missingKeyStatus: 200 }]) {
    await assert.rejects(checkDemoApi('https://api.example/api', 'https://demo.github.io', { fetchImpl: relay(options) }), /relay/i);
  }
});

test('Pages release refuses insecure or credential-bearing deployment URLs', async () => {
  for (const apiBase of ['http://api.example/api', 'https://user:password@api.example/api', 'https://api.example/api?key=secret', 'not-a-url']) {
    await assert.rejects(checkDemoApi(apiBase, 'https://demo.github.io', { fetchImpl: () => assert.fail('must not fetch') }));
  }
});

test('Pages release tolerates bounded cold-start timeouts and transient health errors', async () => {
  const healthy = relay();
  let attempts = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/health')) {
      attempts++;
      if (attempts === 1) throw new DOMException('Instance is waking', 'TimeoutError');
      if (attempts === 2) return new Response('Starting', { status: 503 });
    }
    return healthy(url, options);
  };
  const result = await checkDemoApi('https://api.example/api', 'https://demo.github.io', { fetchImpl, retryDelayMs: 0 });
  assert.equal(result.cors, 'passed');
  assert.equal(attempts, 3);
});

test('Pages release stops retrying an unreachable host and never retries auth rejection', async () => {
  let attempts = 0;
  await assert.rejects(checkDemoApi('https://api.example/api', 'https://demo.github.io', {
    retryDelayMs: 0,
    fetchImpl: async () => { attempts++; throw new DOMException('Timed out', 'TimeoutError'); },
  }), /Timed out/);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(checkDemoApi('https://api.example/api', 'https://demo.github.io', {
    retryDelayMs: 0,
    fetchImpl: async () => { attempts++; return new Response('Unauthorized', { status: 401 }); },
  }), /health check failed/i);
  assert.equal(attempts, 1);
});
