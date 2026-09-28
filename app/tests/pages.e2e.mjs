import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp } from '../server/index.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 90_000;
const FRONTEND_BASE = '/demo/';
const GOOD_KEY = 'nv-good-key';
const SECOND_KEY = 'nv-second-key';
const BAD_KEY = 'nv-bad-key';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importPlaywright() {
  const requested = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const importTarget = path.isAbsolute(requested) ? pathToFileURL(requested).href : requested;
  return import(importTarget);
}

function wavBytes({ durationSeconds = 0.25, sampleRate = 44_100, frequency = 440 } = {}) {
  const samples = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const envelope = Math.min(index / 300, (samples - index) / 300, 1);
    const sample = Math.sin((index / sampleRate) * frequency * Math.PI * 2) * envelope * 0.35;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return buffer;
}

function sseResponse(tokens, { delayMs = 12, signal, stall = false } = {}) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream({
    async start(controller) {
      const abort = () => {
        try {
          controller.error(signal.reason || new DOMException('Aborted', 'AbortError'));
        } catch {}
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      cleanup = () => signal?.removeEventListener('abort', abort);
      try {
        for (const token of tokens) {
          if (signal?.aborted) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`));
          await delay(delayMs);
        }
        if (!stall) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      } finally {
        if (!stall) cleanup();
      }
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function createFakeProvider() {
  const audio = wavBytes();
  const state = {
    mode: 'success',
    calls: [],
    aborted: 0,
  };

  async function fetchImpl(url, init = {}) {
    const href = String(url);
    const authorization = init.headers?.Authorization || init.headers?.authorization || '';
    const call = { url: href, method: init.method || 'GET', authorization, mode: state.mode };
    state.calls.push(call);
    init.signal?.addEventListener('abort', () => { state.aborted += 1; }, { once: true });

    if (authorization === `Bearer ${BAD_KEY}`) {
      return Response.json({ error: 'bad visitor key' }, { status: 401 });
    }

    if (href.includes('/chat/completions')) {
      const body = JSON.parse(String(init.body || '{}'));
      call.body = body;
      const lastUser = body.messages?.filter((message) => message.role === 'user').at(-1)?.content || '';
      if (state.mode === 'chat-stall') return sseResponse(['stale completion should not return'], { signal: init.signal, stall: true });
      if (state.mode === 'chat-slow') return sseResponse([`Slow reply for: ${lastUser}.`], { signal: init.signal, delayMs: 250 });
      return sseResponse([`Demo reply for: ${lastUser}.`], { signal: init.signal });
    }

    if (href.includes('/audio/synthesize')) {
      const fields = {};
      for (const [key, value] of init.body?.entries?.() || []) fields[key] = String(value);
      call.form = fields;
      return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }

    if (href.includes('/audio/transcriptions')) {
      return Response.json({ text: 'voice transcript from browser context' });
    }

    return Response.json({ error: `Unexpected provider URL ${href}` }, { status: 500 });
  }

  return {
    fetchImpl,
    setMode(mode) {
      state.mode = mode;
    },
    reset(mode = 'success') {
      state.mode = mode;
      state.calls.length = 0;
      state.aborted = 0;
    },
    snapshot() {
      return {
        mode: state.mode,
        calls: structuredClone(state.calls),
        aborted: state.aborted,
      };
    },
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function logger() {
  const entries = [];
  return {
    entries,
    log: (...args) => entries.push(['log', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.glb')) return 'model/gltf-binary';
  if (filePath.endsWith('.fbx')) return 'application/octet-stream';
  if (filePath.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

function createStaticHandler(rootDir) {
  return async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname === '/demo') {
        res.writeHead(308, { Location: FRONTEND_BASE });
        return res.end();
      }
      if (!pathname.startsWith(FRONTEND_BASE)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      pathname = pathname.slice(FRONTEND_BASE.length);
      const relativePath = pathname && !pathname.endsWith('/') ? pathname : 'index.html';
      const resolved = path.resolve(rootDir, relativePath);
      if (!resolved.startsWith(path.resolve(rootDir))) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      let file = await fs.readFile(resolved).catch(() => null);
      let servedPath = resolved;
      if (!file) {
        servedPath = path.join(rootDir, 'index.html');
        file = await fs.readFile(servedPath);
      }
      res.writeHead(200, { 'Content-Type': contentType(servedPath), 'Cache-Control': 'no-store' });
      return res.end(file);
    } catch (error) {
      res.writeHead(500);
      return res.end(error.message);
    }
  };
}

async function buildFrontend({ outDir, apiOrigin }) {
  const env = {
    ...process.env,
    VITE_API_BASE_URL: `${apiOrigin}/api`,
    VITE_REQUIRE_USER_KEY: 'true',
  };
  const child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build', '--', '--base=/demo/', `--outDir=${outDir}`],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), BUILD_TIMEOUT_MS);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(timeout));
  if (code !== 0) throw new Error(`Vite build failed with exit ${code}\n${output}`);
  return output;
}

async function assertEventually(fn, label, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 100 } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }
  throw new Error(`${label}: ${lastError?.message || 'timed out'}`);
}

async function expectText(locator, text) {
  await assertEventually(async () => {
    const content = await locator.textContent({ timeout: 1000 });
    assert.match(content || '', typeof text === 'string' ? new RegExp(escapeRegExp(text)) : text);
  }, `expected text ${text}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createBrowser(playwright) {
  return playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-crash-reporter',
      '--disable-crashpad',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
}

async function newPage(browser, frontendOrigin, { noWebGL = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: frontendOrigin });
  await context.grantPermissions(['microphone'], { origin: frontendOrigin });
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [], completedAssets: [] };
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  if (noWebGL) {
    await page.addInitScript(() => {
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
        return originalGetContext.call(this, type, ...args);
      };
    });
  }
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/chat') && request.failure()?.errorText === 'net::ERR_ABORTED') return;
    diagnostics.failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('requestfinished', (request) => {
    if (/\.(glb|fbx)$/i.test(request.url())) diagnostics.completedAssets.push(request.url());
  });
  return { context, page, diagnostics };
}

async function gotoSetup(page, frontendOrigin) {
  await page.goto(`${frontendOrigin}${FRONTEND_BASE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Add your NVIDIA API key' }).waitFor({ timeout: DEFAULT_TIMEOUT_MS });
}

async function saveKey(page, key) {
  await page.getByLabel('NVIDIA API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Use key' }).click();
  await page.getByRole('button', { name: 'Change API key' }).waitFor({ timeout: DEFAULT_TIMEOUT_MS });
}

async function submitText(page, text) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

async function waitForAssistant(page, textPattern = /Demo reply/) {
  const assistant = page.locator('.chat-message.assistant:not(.streaming) .message-text').last();
  await assertEventually(async () => {
    assert.match((await assistant.textContent()) || '', textPattern);
  }, 'assistant reply should appear', { timeoutMs: DEFAULT_TIMEOUT_MS });
  return assistant;
}

async function assertNoDiagnostics(diagnostics, label, secrets = [], expectedErrors = []) {
  assert.deepEqual(diagnostics.pageErrors, [], `${label} page errors`);
  const failures = diagnostics.failedRequests.filter((failure) => !(failure.endsWith('net::ERR_ABORTED') && diagnostics.completedAssets.some((url) => failure.includes(url))));
  assert.deepEqual(failures, [], `${label} failed requests`);
  const leaked = diagnostics.consoleErrors.filter((entry) => secrets.some((secret) => secret && entry.includes(secret)));
  assert.deepEqual(leaked, [], `${label} console leaked secret`);
  assert.deepEqual(diagnostics.consoleErrors.filter((entry) => !expectedErrors.some((pattern) => pattern.test(entry))), [], `${label} console errors`);
}

async function assertApiCors(apiOrigin, frontendOrigin) {
  const response = await fetch(`${apiOrigin}/api/chat`, {
    method: 'OPTIONS',
    headers: {
      Origin: frontendOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization, Content-Type',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), frontendOrigin);
  assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');

  const missingAuth = await fetch(`${apiOrigin}/api/chat`, {
    method: 'POST',
    headers: { Origin: frontendOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'missing key' }] }),
  });
  assert.equal(missingAuth.status, 401);
  assert.equal(missingAuth.headers.get('access-control-allow-origin'), frontendOrigin);
  assert.match((await missingAuth.json()).error, /key is required/i);
}

async function runScenario(results, name, fn, artifacts) {
  if (process.env.E2E_SCENARIO && !name.includes(process.env.E2E_SCENARIO)) return;
  const start = Date.now();
  try {
    await fn();
    results.push({ name, status: 'passed', durationMs: Date.now() - start });
    console.log(`ok - ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Date.now() - start, error: error.stack || error.message });
    if (artifacts) await fs.writeFile(path.join(artifacts, `${slug(name)}.error.txt`), error.stack || error.message);
    console.error(`not ok - ${name}`);
  } finally {
    if (artifacts) await fs.writeFile(path.join(artifacts, 'pages-e2e-results.json'), JSON.stringify(results, null, 2));
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
  const results = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'va-pages-e2e-'));
  const outDir = path.join(tempDir, 'frontend');
  const artifactDir = process.env.E2E_ARTIFACT_DIR || '';
  const artifacts = artifactDir ? path.resolve(artifactDir) : '';
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });

  const provider = createFakeProvider();
  const appLogger = logger();
  let staticServer;
  let apiServer;
  let browser;

  try {
    const staticHarness = await listen(createStaticHandler(outDir));
    staticServer = staticHarness.server;
    const frontendOrigin = staticHarness.origin;

    const api = createApp({
      env: {
        REQUIRE_USER_KEY: 'true',
        ALLOWED_ORIGINS: frontendOrigin,
      },
      fetchImpl: provider.fetchImpl,
      logger: appLogger,
      providerTimeoutMs: 30_000,
      providerLimits: { windowMs: 10_000, maxRequests: 200, maxConcurrent: 20, cleanupIntervalMs: 10_000 },
    });
    const apiHarness = await listen(api);
    apiServer = apiHarness.server;
    const apiOrigin = apiHarness.origin;

    await buildFrontend({ outDir, apiOrigin });
    await assertApiCors(apiOrigin, frontendOrigin);

    const playwright = await importPlaywright();
    browser = await createBrowser(playwright);

    await runScenario(results, 'byok setup gates demo and sends visitor key to chat and tts', async () => {
      provider.reset('success');
      const { context, page, diagnostics } = await newPage(browser, frontendOrigin);
      try {
        await gotoSetup(page, frontendOrigin);
        assert.equal(await page.getByLabel('NVIDIA API key', { exact: true }).getAttribute('type'), 'password');
        assert.equal(await page.getByRole('textbox', { name: 'Message' }).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: /Start recording|Start microphone/i }).isDisabled(), true);
        assert.equal(provider.snapshot().calls.length, 0);

        await saveKey(page, GOOD_KEY);
        await submitText(page, 'credential binding');
        await waitForAssistant(page, /credential binding/);

        await assertEventually(() => assert.ok(provider.snapshot().calls.some((call) => call.url.includes('/audio/synthesize'))), 'speech request should reach the relay');

        const snapshot = provider.snapshot();
        const chat = snapshot.calls.find((call) => call.url.includes('/chat/completions'));
        const tts = snapshot.calls.find((call) => call.url.includes('/audio/synthesize'));
        assert.equal(chat?.authorization, `Bearer ${GOOD_KEY}`);
        assert.equal(tts?.authorization, `Bearer ${GOOD_KEY}`);
        assert.equal(tts?.form?.voice, 'Magpie-Multilingual.EN-US.Jason');
        assert.equal(chat?.body?.messages.at(-1).content, 'credential binding');
        await page.getByRole('button', { name: 'Change API key' }).click();
        await page.getByRole('button', { name: 'Remove key' }).waitFor({ timeout: DEFAULT_TIMEOUT_MS });
        const stored = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
        assert.equal(stored.some((value) => value.includes(GOOD_KEY)), false, 'visitor keys must not be persisted');
        await assertNoDiagnostics(diagnostics, 'byok setup', [GOOD_KEY, BAD_KEY, SECOND_KEY]);
      } finally {
        await context.close();
      }
    }, artifacts);

    await runScenario(results, 'invalid visitor key recovers and browser contexts do not share keys', async () => {
      provider.reset('success');
      const first = await newPage(browser, frontendOrigin);
      const second = await newPage(browser, frontendOrigin);
      try {
        await gotoSetup(first.page, frontendOrigin);
        await saveKey(first.page, BAD_KEY);
        await submitText(first.page, 'bad key request');
        await expectText(first.page.locator('#status-bar'), /visitor key|check your key|rejected/i);
        assert.equal(provider.snapshot().calls.at(-1)?.authorization, `Bearer ${BAD_KEY}`);

        if (!await first.page.getByLabel('NVIDIA API key', { exact: true }).isVisible()) await first.page.getByRole('button', { name: 'Change API key' }).click();
        await saveKey(first.page, GOOD_KEY);
        await submitText(first.page, 'recovered request');
        await waitForAssistant(first.page, /recovered request/);
        assert.equal(provider.snapshot().calls.filter((call) => call.authorization === `Bearer ${GOOD_KEY}`).length >= 2, true);

        await gotoSetup(second.page, frontendOrigin);
        assert.equal(await second.page.getByRole('textbox', { name: 'Message' }).isDisabled(), true);
        await saveKey(second.page, SECOND_KEY);
        await submitText(second.page, 'second context request');
        await waitForAssistant(second.page, /second context request/);
        assert.equal(provider.snapshot().calls.some((call) => call.authorization === `Bearer ${SECOND_KEY}`), true);

        await first.page.reload({ waitUntil: 'domcontentloaded' });
        await first.page.getByRole('heading', { name: 'Add your NVIDIA API key' }).waitFor({ timeout: DEFAULT_TIMEOUT_MS });
        assert.equal(await first.page.getByRole('textbox', { name: 'Message' }).isDisabled(), true);
        await assertNoDiagnostics(first.diagnostics, 'invalid recovery first', [GOOD_KEY, BAD_KEY, SECOND_KEY], [/Failed to load resource: the server responded with a status of 401/]);
        await assertNoDiagnostics(second.diagnostics, 'invalid recovery second', [GOOD_KEY, BAD_KEY, SECOND_KEY]);
      } finally {
        await first.context.close();
        await second.context.close();
      }
    }, artifacts);

    await runScenario(results, 'remove key and new conversation abort pending work without stale resurrection', async () => {
      provider.reset('chat-stall');
      const { context, page, diagnostics } = await newPage(browser, frontendOrigin);
      try {
        await gotoSetup(page, frontendOrigin);
        await saveKey(page, GOOD_KEY);
        await submitText(page, 'cancel this pending chat');
        await expectText(page.locator('.chat-message.assistant.streaming .message-text'), /stale completion/);
        await page.getByRole('button', { name: 'Start new conversation' }).click();
        await assertEventually(async () => {
          assert.equal(await page.locator('.chat-message').count(), 0);
        }, 'new conversation should clear pending chat');
        await assertEventually(() => assert.ok(provider.snapshot().aborted >= 1), 'provider should see pending chat abort');
        await delay(400);
        assert.equal(await page.locator('.chat-message.assistant').count(), 0);

        await page.addInitScript(() => {
          navigator.mediaDevices.getUserMedia = () => new Promise((_, reject) => {
            window.__rejectPendingMic = () => reject(new DOMException('Late microphone rejection', 'NotAllowedError'));
          });
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await gotoSetup(page, frontendOrigin);
        await saveKey(page, GOOD_KEY);
        await page.getByRole('button', { name: /Start recording|Start microphone/i }).click();
        await expectText(page.locator('#status-bar'), /Opening microphone|Listening/i);
        await page.getByRole('button', { name: 'Start new conversation' }).click();
        await page.evaluate(() => window.__rejectPendingMic?.());
        await delay(300);
        assert.equal(await page.locator('.chat-message').count(), 0);

        await page.getByRole('button', { name: 'Change API key' }).click();
        await page.getByLabel('NVIDIA API key', { exact: true }).fill(SECOND_KEY);
        await page.getByRole('button', { name: 'Remove key' }).click();
        await page.getByRole('heading', { name: 'Add your NVIDIA API key' }).waitFor({ timeout: DEFAULT_TIMEOUT_MS });
        assert.equal(await page.locator('.chat-message').count(), 0);
        assert.equal(await page.getByRole('textbox', { name: 'Message' }).isDisabled(), true);
        assert.equal(await page.getByLabel('NVIDIA API key', { exact: true }).inputValue(), '', 'removing a key also clears an unsaved replacement');
        await assertNoDiagnostics(diagnostics, 'remove and new conversation', [GOOD_KEY]);
      } finally {
        await context.close();
      }
    }, artifacts);

    await runScenario(results, 'demo base path loads avatar assets under demo with webgl', async () => {
      provider.reset('success');
      const { context, page, diagnostics } = await newPage(browser, frontendOrigin, { noWebGL: false });
      try {
        await gotoSetup(page, frontendOrigin);
        await saveKey(page, GOOD_KEY);
        await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.scene-unavailable'), null, { timeout: DEFAULT_TIMEOUT_MS });
        await assertEventually(async () => {
          const assetPaths = await page.evaluate(() => performance.getEntriesByType('resource')
            .map((entry) => new URL(entry.name).pathname)
            .filter((pathname) => /\.(glb|fbx)$/i.test(pathname)));
          assert.equal(new Set(diagnostics.completedAssets).size, 3, `all avatar assets must finish successfully: ${JSON.stringify(diagnostics)}`);
          assert.ok(assetPaths.length >= 3, `expected avatar model and animation requests, got ${JSON.stringify(assetPaths)}`);
          assert.equal(assetPaths.every((pathname) => pathname.startsWith('/demo/')), true, JSON.stringify(assetPaths));
        }, 'avatar assets should load from /demo/');
        await submitText(page, 'webgl asset path');
        await waitForAssistant(page, /webgl asset path/);
        await assertNoDiagnostics(diagnostics, 'webgl asset path', [GOOD_KEY]);
        if (artifacts) {
          await page.screenshot({ path: path.join(artifacts, 'pages-avatar.png') });
          await fs.writeFile(path.join(artifacts, 'asset-requests.json'), JSON.stringify({ completed: diagnostics.completedAssets, failed: diagnostics.failedRequests }, null, 2));
        }
      } finally {
        await context.close();
      }
    }, artifacts);
  } finally {
    await browser?.close().catch(() => {});
    await Promise.allSettled([closeServer(apiServer), closeServer(staticServer)]);
    await fs.rm(tempDir, { recursive: true, force: true });
    if (artifacts) await fs.writeFile(path.join(artifacts, 'pages-e2e-results.json'), JSON.stringify(results, null, 2));
  }

  const failed = results.filter((result) => result.status === 'failed');
  if (failed.length) {
    throw new Error(`${failed.length} page E2E scenario(s) failed. See ${artifacts || 'console output'} for details.`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
