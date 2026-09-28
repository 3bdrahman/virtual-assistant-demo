import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function checkDemoApi(apiBase, pagesOrigin, { fetchImpl = fetch, timeoutMs = 30_000, allowLocal = false } = {}) {
  let api;
  let origin;
  try { api = new URL(apiBase); origin = new URL(pagesOrigin); }
  catch { throw new Error('Set DEMO_API_URL and DEMO_ORIGIN to valid HTTPS URLs.'); }
  const local = (url) => allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  for (const url of [api, origin]) {
    if ((url.protocol !== 'https:' && !local(url)) || url.username || url.password || url.search || url.hash) {
      throw new Error('Demo URLs must use HTTPS and must not include credentials, query parameters, or fragments.');
    }
  }
  if (origin.pathname !== '/') throw new Error('DEMO_ORIGIN must be the Pages origin without the repository path.');
  const base = api.href.replace(/\/+$/, '');
  const originHeader = origin.origin;
  const request = (route, options = {}) => fetchImpl(`${base}${route}`, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { Origin: originHeader, ...options.headers },
  });
  const cors = (response) => {
    if (response.headers.get('access-control-allow-origin') !== originHeader) {
      throw new Error('The relay must allow the exact GitHub Pages origin in ALLOWED_ORIGINS.');
    }
  };
  const health = await request('/health');
  if (!health.ok) throw new Error('The demo API health check failed.');
  cors(health);
  const config = await health.json();
  if (config.ok !== true || config.requiresUserKey !== true || config.hasNvidiaKey !== false) {
    throw new Error('The deployed relay must require visitor keys and disable the owner key fallback (REQUIRE_USER_KEY=true).');
  }
  for (const route of ['/chat', '/stt', '/tts']) {
    const preflight = await request(route, { method: 'OPTIONS', headers: {
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    cors(preflight);
    const allowedHeaders = preflight.headers.get('access-control-allow-headers')?.toLowerCase() || '';
    if (!preflight.ok || !allowedHeaders.includes('authorization') || !allowedHeaders.includes('content-type') || !preflight.headers.get('access-control-allow-methods')?.includes('POST')) {
      throw new Error('The relay must allow POST with Authorization and Content-Type headers.');
    }
    // Deliberately invalid, unauthenticated input: no provider request or quota
    // is needed to prove that this relay has no shared-key fallback.
    const missingKey = await request(route, { method: 'POST', headers: { 'Content-Type': route === '/stt' ? 'audio/wav' : 'application/json' }, body: route === '/stt' ? '' : '{}' });
    cors(missingKey);
    if (missingKey.status !== 401) throw new Error('The relay must reject every provider route without a visitor key.');
  }
  return { apiBase: base, pagesOrigin: originHeader, visitorKeysRequired: true, cors: 'passed' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { console.log(JSON.stringify(await checkDemoApi(process.env.DEMO_API_URL, process.env.DEMO_ORIGIN), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
