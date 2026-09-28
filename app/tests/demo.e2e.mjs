import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp } from '../server/index.js';

const VIEWPORTS = [
  { name: 'mobile-small', width: 320, height: 568 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
  { name: 'desktop', width: 1280, height: 800 },
];

const DEFAULT_TIMEOUT_MS = 15_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importPlaywright() {
  const requested = process.env.PLAYWRIGHT_MODULE || 'playwright';
  try {
    const importTarget = path.isAbsolute(requested) ? pathToFileURL(requested).href : requested;
    return await import(importTarget);
  } catch (error) {
    throw new Error(`Unable to import Playwright from ${requested}: ${error.message}`);
  }
}

function wavBytes({ durationSeconds = 0.35, sampleRate = 44_100, frequency = 440 } = {}) {
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

function sseResponse(tokens, { delayMs = 20, omitDone = false, stall = false, signal } = {}) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream({
    async start(controller) {
      const abort = () => {
        try {
          controller.error(signal.reason || new DOMException('Aborted', 'AbortError'));
        } catch {
          // Stream may already be closed.
        }
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      cleanup = () => signal?.removeEventListener('abort', abort);
      try {
        for (const token of tokens) {
          if (signal?.aborted) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`));
          await delay(delayMs);
        }
        if (!omitDone && !stall) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        if (!stall) controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        if (!stall) cleanup();
      }
    },
    cancel() { cleanup(); },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function createFakeProvider() {
  const state = {
    mode: 'success',
    calls: [],
    aborted: 0,
    lastChatBody: null,
  };
  const audio = wavBytes();

  async function fetchImpl(url, init = {}) {
    const href = String(url);
    state.calls.push({ url: href, method: init.method || 'GET', mode: state.mode });
    init.signal?.addEventListener('abort', () => { state.aborted += 1; }, { once: true });

    if (href.includes('/audio/transcriptions')) {
      if (state.mode === 'stt-empty') return Response.json({ text: '' });
      if (state.mode === 'stt-error') return Response.json({ error: 'stt unavailable' }, { status: 503 });
      return Response.json({ text: 'voice transcript from chromium microphone' });
    }

    if (href.includes('/chat/completions')) {
      const body = JSON.parse(String(init.body || '{}'));
      state.lastChatBody = body;
      const lastUser = body.messages?.filter((message) => message.role === 'user').at(-1)?.content || '';
      if (state.mode === 'chat-error') return Response.json({ error: 'provider failed' }, { status: 503 });
      if (state.mode === 'chat-incomplete') return sseResponse(['partial reply'], { omitDone: true, signal: init.signal });
      if (state.mode === 'chat-stall') return sseResponse(['waiting for cancel'], { stall: true, signal: init.signal });
      const longTail = state.mode === 'long-reply'
        ? ` ${'wrap-check-word '.repeat(40)} ${'W'.repeat(500)}`
        : '';
      const safeTail = lastUser.includes('<script') ? ' Your literal markup stayed as text.' : '';
      const text = `Demo reply for: ${lastUser}.${safeTail}${longTail}`;
      return sseResponse(text.match(/.{1,18}/g) || [text], { delayMs: 8, signal: init.signal });
    }

    if (href.includes('/audio/synthesize')) {
      if (state.mode === 'tts-error' || state.mode === 'tts-fallback') {
        return Response.json({ error: 'tts unavailable' }, { status: 503 });
      }
      return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
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
      state.lastChatBody = null;
    },
    snapshot() {
      return {
        mode: state.mode,
        calls: [...state.calls],
        aborted: state.aborted,
        lastChatBody: state.lastChatBody,
      };
    },
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
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

async function makeHarness() {
  const provider = createFakeProvider();
  const app = createApp({
    env: { NVIDIA_API_KEY: 'test-only' },
    fetchImpl: provider.fetchImpl,
    logger: logger(),
    providerTimeoutMs: 30_000,
    providerLimits: { windowMs: 10_000, maxRequests: 200, maxConcurrent: 20, cleanupIntervalMs: 10_000 },
  });
  const { server, origin } = await listen(app);
  return { provider, server, origin };
}

async function makeOfflineHarness() {
  const app = createApp({
    env: {},
    fetchImpl: async () => {
      throw new Error('provider should not be called without a key');
    },
    logger: logger(),
  });
  const { server, origin } = await listen(app);
  return { server, origin };
}

async function createBrowser(playwright, fakeAudioPath) {
  return playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-crash-reporter',
      '--disable-crashpad',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fakeAudioPath}`,
    ],
  });
}

async function newPage(browser, origin, {
  viewport = VIEWPORTS.at(-1),
  allowConsoleErrors = [],
  allowRequestFailures = [],
  offlineHealth = false,
  denyMic = false,
  noWebGL = true,
  failAssets = false,
} = {}) {
  const context = await browser.newContext({ viewport, baseURL: origin });
  if (!denyMic) await context.grantPermissions(['microphone'], { origin });
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [], completedOrCancelledStreams: [] };
  if (offlineHealth) {
    await context.route('**/api/health', (route) => route.abort('failed'));
  }
  if (failAssets) {
    await context.route(/.*\.(glb|fbx)$/i, (route) => route.abort('failed'));
  }
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  if (denyMic) await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Microphone permission denied.', 'NotAllowedError'));
  });
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
    const text = message.text();
    if (message.type() === 'error' && !allowConsoleErrors.some((pattern) => pattern.test(text))) {
      diagnostics.consoleErrors.push(text);
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = `${request.method()} ${url}: ${request.failure()?.errorText || 'failed'}`;
    // The client releases SSE immediately on DONE as well as explicit Cancel.
    // Each scenario separately asserts a committed reply or a cancellation label.
    if (url.endsWith('/api/chat') && request.failure()?.errorText === 'net::ERR_ABORTED') {
      diagnostics.completedOrCancelledStreams.push(failure);
      return;
    }
    if (url.includes('/api/health') && offlineHealth) return;
    if (/\.(glb|fbx)$/i.test(url) && failAssets) return;
    if (allowRequestFailures.some((pattern) => pattern.test(failure))) return;
    diagnostics.failedRequests.push(failure);
  });
  return { context, page, diagnostics };
}

async function gotoReady(page, origin, { expectReady = true } = {}) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Conversation, brought to life.' }).waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  if (expectReady) {
    await assertEventually(async () => {
      await expectText(page.locator('#status-bar'), 'Live AI configured');
      await assert.equal(await page.getByRole('textbox', { name: 'Message' }).isEnabled(), true);
    }, 'demo should become ready');
  }
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

async function submitText(page, text) {
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

async function waitForAssistant(page, textPattern = /Demo reply/) {
  const assistant = page.locator('.chat-message.assistant:not(.streaming) .message-text').last();
  await assertEventually(async () => {
    assert.match((await assistant.textContent()) || '', textPattern);
  }, 'assistant reply should appear', { timeoutMs: 12_000 });
  return assistant;
}

async function assertNoDiagnostics(diagnostics, label) {
  assert.deepEqual(diagnostics.pageErrors, [], `${label} page errors`);
  assert.deepEqual(diagnostics.consoleErrors, [], `${label} console errors`);
  assert.deepEqual(diagnostics.failedRequests, [], `${label} failed requests`);
}

async function assertNoticeDoesNotOverlap(page) {
  if (!await page.locator('.scene-unavailable').isVisible()) return;
  const notice = await page.locator('.scene-unavailable').boundingBox();
  const heading = await page.locator('.demo-intro h1').boundingBox();
  const chat = await page.locator('#chat-panel').boundingBox();
  assert.ok(notice.y >= heading.y + heading.height - 1, 'avatar notice must follow the heading');
  assert.ok(notice.y + notice.height <= chat.y + 1, 'avatar notice must not overlap the transcript');
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
    if (artifacts) await fs.writeFile(path.join(artifacts, 'demo-e2e-results.json'), JSON.stringify(results, null, 2));
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
  const results = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'va-demo-e2e-'));
  const artifactDir = process.env.E2E_ARTIFACT_DIR || '';
  const artifacts = artifactDir ? path.resolve(artifactDir) : '';
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
  const fakeAudioPath = path.join(tempDir, 'fake-mic.wav');
  await fs.writeFile(fakeAudioPath, wavBytes({ durationSeconds: 1.2, frequency: 523.25 }));

  const playwright = await importPlaywright();
  const browser = await createBrowser(playwright, fakeAudioPath);
  const ownedServers = [];

  try {
    const harness = await makeHarness();
    ownedServers.push(harness.server);
    const { origin, provider } = harness;

    await runScenario(results, 'desktop typed demo flow protects history and text', async () => {
      provider.reset('success');
      const { context, page, diagnostics } = await newPage(browser, origin, {
        allowConsoleErrors: [/Failed to load resource: the server responded with a status of 503/],
      });
      try {
        await gotoReady(page, origin);
        await page.getByRole('button', { name: 'Explain black holes simply' }).click();
        await waitForAssistant(page, /Explain black holes simply/);
        assert.equal(provider.snapshot().lastChatBody.messages.at(-1).content, 'Explain black holes simply');

        provider.reset('chat-error');
        await submitText(page, 'keep this for retry');
        await expectText(page.locator('#status-bar'), /provider error|unavailable|failed/i);
        await expectText(page.locator('.chat-message.failed .message-text').last(), 'keep this for retry');
        assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), 'keep this for retry');

        provider.reset('success');
        await page.getByRole('button', { name: 'Send message' }).click();
        await waitForAssistant(page, /keep this for retry/);
        const sentToProvider = provider.snapshot().lastChatBody.messages.map((message) => `${message.role}:${message.content}`);
        assert.ok(sentToProvider.includes('user:Explain black holes simply'), 'successful history should be retained');
        assert.equal(sentToProvider.some((entry) => entry === 'user:keep this for retry'), true);
        assert.equal((await page.locator('.chat-message.failed').count()) >= 1, true, 'failed turn remains visible');
        await assertEventually(async () => {
          assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), '');
          assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
        }, 'successful retry should clear input after speech setup');

        const xss = '<script>window.__xssRan=1</script> Привет こんにちは';
        await submitText(page, xss);
        await waitForAssistant(page, /literal markup stayed as text/);
        assert.equal(await page.evaluate(() => window.__xssRan || 0), 0);
        await expectText(page.locator('.chat-message.user .message-text').last(), xss);
        assert.equal(await page.locator('script', { hasText: 'window.__xssRan' }).count(), 0);
        await assertNoDiagnostics(diagnostics, 'typed flow');
      } finally {
        await context.close();
      }
    }, artifacts);

    await runScenario(results, 'double submit and incomplete stream are contained', async () => {
      provider.reset('chat-stall');
      const { context, page, diagnostics } = await newPage(browser, origin, {
        allowRequestFailures: [/\/api\/chat: net::ERR_ABORTED/],
      });
      try {
        await gotoReady(page, origin);
        await submitText(page, 'cancel me');
        await expectText(page.locator('.chat-message.assistant.streaming .message-text'), /waiting for cancel/);
        assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
        await page.getByRole('button', { name: 'Cancel request' }).click();
        await expectText(page.locator('.chat-message.failed .message-label').last(), 'You · request cancelled');
        await assertEventually(() => assert.ok(provider.snapshot().aborted >= 1), 'chat provider should see abort');

        provider.reset('chat-incomplete');
        await submitText(page, 'break stream');
        await expectText(page.locator('#status-bar'), /incomplete/i);
        await expectText(page.locator('.chat-message.failed .message-text').last(), 'break stream');
        await assertNoDiagnostics(diagnostics, 'cancel and incomplete flow');
      } finally {
        await context.close();
      }
    }, artifacts);

    await runScenario(results, 'tts fallback and stop speaking leave chat usable', async () => {
      provider.reset('tts-fallback');
      const { context, page, diagnostics } = await newPage(browser, origin, {
        allowConsoleErrors: [/Speech service unavailable/, /Failed to load resource: the server responded with a status of 503/],
      });
      try {
        await gotoReady(page, origin);
        await submitText(page, 'use fallback voice');
        await waitForAssistant(page, /use fallback voice/);
        await expectText(page.locator('#status-bar'), /Browser voice|Text only|Speaking/);
        const stop = page.getByRole('button', { name: 'Stop speaking' });
        if (await stop.isVisible().catch(() => false)) await stop.click();
        provider.reset('success');
        await submitText(page, 'after stop');
        await waitForAssistant(page, /after stop/);
        await assertNoDiagnostics(diagnostics, 'tts fallback');
      } finally {
        await context.close();
      }
    }, artifacts);

    await runScenario(results, 'microphone grant deny cancel and empty transcript states', async () => {
      provider.reset('success');
      const granted = await newPage(browser, origin);
      try {
        await gotoReady(granted.page, origin);
        await granted.page.getByRole('button', { name: 'Start recording' }).click();
        await expectText(granted.page.locator('#status-bar'), /Listening|Opening microphone/);
        await delay(600);
        await granted.page.getByRole('button', { name: 'Stop recording' }).click();
        await waitForAssistant(granted.page, /voice transcript from chromium microphone/);
        const sttCall = provider.snapshot().calls.find((call) => call.url.includes('/audio/transcriptions'));
        assert.ok(sttCall, 'real recorded audio should be posted through local STT API');
        await assertNoDiagnostics(granted.diagnostics, 'mic grant');
      } finally {
        await granted.context.close();
      }

      provider.reset('success');
      const denied = await newPage(browser, origin, { denyMic: true });
      try {
        await denied.context.clearPermissions();
        await gotoReady(denied.page, origin);
        await denied.page.getByRole('button', { name: 'Start recording' }).click();
        await expectText(denied.page.locator('#status-bar'), /denied|Permission|microphone/i);
      } finally {
        await denied.context.close();
      }

      provider.reset('success');
      const pending = await newPage(browser, origin);
      try {
        await pending.page.addInitScript(() => {
          window.__releaseMic = null;
          navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { window.__releaseMic = resolve; });
        });
        await gotoReady(pending.page, origin);
        await pending.page.getByRole('button', { name: 'Start recording' }).click();
        await expectText(pending.page.locator('#status-bar'), /Opening microphone/);
        await pending.page.getByRole('button', { name: 'Cancel microphone request' }).click();
        await assertEventually(async () => {
          assert.equal(await pending.page.getByRole('button', { name: 'Start recording' }).isVisible(), true);
        }, 'cancelled microphone request should return to idle');
      } finally {
        await pending.context.close();
      }

      provider.reset('stt-empty');
      const empty = await newPage(browser, origin);
      try {
        await gotoReady(empty.page, origin);
        await empty.page.getByRole('button', { name: 'Start recording' }).click();
        await delay(600);
        await empty.page.getByRole('button', { name: 'Stop recording' }).click();
        await expectText(empty.page.locator('#status-bar'), /No speech was detected/);
      } finally {
        await empty.context.close();
      }
    }, artifacts);

    await runScenario(results, 'health missing offline and recovery states are visible', async () => {
      const missing = await makeOfflineHarness();
      ownedServers.push(missing.server);
      const missingPage = await newPage(browser, missing.origin);
      try {
        await gotoReady(missingPage.page, missing.origin, { expectReady: false });
        await expectText(missingPage.page.locator('#setup-notice'), 'Live conversation is unavailable');
        assert.equal(await missingPage.page.getByRole('textbox', { name: 'Message' }).isDisabled(), true);
      } finally {
        await missingPage.context.close();
      }

      const offline = await newPage(browser, origin, { offlineHealth: true });
      try {
        await gotoReady(offline.page, origin, { expectReady: false });
        await expectText(offline.page.locator('#setup-notice'), 'Demo is offline');
        await assertNoticeDoesNotOverlap(offline.page);
        const emptyText = await offline.page.locator('.chat-empty p').boundingBox();
        const emptyPanel = await offline.page.locator('#chat-panel').boundingBox();
        assert.ok(emptyText.y >= emptyPanel.y && emptyText.y + emptyText.height <= emptyPanel.y + emptyPanel.height, 'empty transcript text must remain visible');
        await offline.context.unroute('**/api/health');
        await assertEventually(async () => {
          await expectText(offline.page.locator('#status-bar'), 'Live AI configured');
        }, 'health should recover after route is restored', { timeoutMs: 7_000 });
      } finally {
        await offline.context.close();
      }
    }, artifacts);

    await runScenario(results, 'scene fallbacks preserve usable text controls', async () => {
      const noWebGL = await newPage(browser, origin, { noWebGL: true });
      try {
        await gotoReady(noWebGL.page, origin);
        await expectText(noWebGL.page.locator('.scene-unavailable'), '3D preview unavailable');
        assert.equal(await noWebGL.page.getByRole('textbox', { name: 'Message' }).isEnabled(), true);
        await assertNoDiagnostics(noWebGL.diagnostics, 'no webgl');
      } finally {
        await noWebGL.context.close();
      }

      const assetFailure = await newPage(browser, origin, {
        noWebGL: false,
        failAssets: true,
        allowConsoleErrors: [/failed/i, /error/i],
      });
      try {
        await gotoReady(assetFailure.page, origin);
        await expectText(assetFailure.page.locator('.scene-unavailable'), '3D preview unavailable');
        await expectText(assetFailure.page.getByRole('heading', { name: 'Conversation, brought to life.' }), 'Conversation, brought to life.');
        assert.equal(await assetFailure.page.getByRole('textbox', { name: 'Message' }).isEnabled(), true);
        assert.deepEqual(assetFailure.diagnostics.pageErrors, [], 'asset failure should not throw page errors');
      } finally {
        await assetFailure.context.close();
      }
    }, artifacts);

    await runScenario(results, 'loaded avatar assets render alongside a spoken reply', async () => {
      provider.reset('success');
      const { context, page, diagnostics } = await newPage(browser, origin, { noWebGL: false });
      try {
        await gotoReady(page, origin);
        await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.scene-loading-inline') && !document.querySelector('.scene-unavailable'), null, { timeout: 20000 });
        await submitText(page, 'avatar integration');
        await waitForAssistant(page, /avatar integration/);
        await expectText(page.locator('#status-bar'), /NVIDIA voice/);
        await page.waitForFunction(() => performance.getEntriesByType('resource').filter((entry) => /\.(glb|fbx)$/.test(decodeURI(entry.name))).length === 3);
        if (artifacts) await page.screenshot({ path: path.join(artifacts, 'avatar-desktop.png') });
        await assertNoDiagnostics(diagnostics, 'loaded avatar');
      } finally { await context.close(); }
    }, artifacts);

    await runScenario(results, 'keyboard submissions retain valid bounded conversation history', async () => {
      provider.reset('success');
      const { context, page, diagnostics } = await newPage(browser, origin);
      try {
        await gotoReady(page, origin);
        const input = page.getByRole('textbox', { name: 'Message' });
        await input.fill('   ');
        assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
        assert.equal(await input.getAttribute('maxlength'), '8000');
        for (let turn = 0; turn < 7; turn++) {
          await input.fill(`keyboard turn ${turn}`);
          await input.press('Enter');
          await waitForAssistant(page, new RegExp(`keyboard turn ${turn}`));
          await assertEventually(async () => assert.equal(await input.inputValue(), ''), 'keyboard turn should finish');
          const messages = provider.snapshot().lastChatBody.messages;
          assert.ok(messages.length <= 12);
          assert.equal(messages[0].role, 'system');
          for (let index = 1; index < messages.length; index++) assert.equal(messages[index].role, index % 2 ? 'user' : 'assistant');
        }
        assert.equal(provider.snapshot().calls.filter((call) => call.url.endsWith('/chat/completions')).length, 7);
        assert.equal(provider.snapshot().lastChatBody.messages[1].content, 'keyboard turn 1');
        await assertNoDiagnostics(diagnostics, 'keyboard and history');
      } finally { await context.close(); }
    }, artifacts);

    await runScenario(results, 'offline notice and errors keep small-screen controls visible', async () => {
      const offline = await newPage(browser, origin, { viewport: VIEWPORTS[0], offlineHealth: true });
      try {
        await gotoReady(offline.page, origin, { expectReady: false });
        await expectText(offline.page.locator('#setup-notice'), 'Demo is offline');
        const bounds = await offline.page.locator('.controls').boundingBox();
        if (artifacts) await offline.page.screenshot({ path: path.join(artifacts, 'offline-mobile.png') });
        assert.ok(bounds.y + bounds.height <= VIEWPORTS[0].height + 1, `offline controls clipped: ${JSON.stringify(bounds)}`);
        await offline.context.unroute('**/api/health');
        await assertEventually(async () => assert.equal(await offline.page.getByRole('textbox', { name: 'Message' }).isEnabled(), true), 'offline mobile should recover');
        provider.reset('chat-error');
        await submitText(offline.page, 'show an error');
        await expectText(offline.page.locator('.pipeline-error'), /provider error/i);
        const recoveredBounds = await offline.page.locator('.controls').boundingBox();
        assert.ok(recoveredBounds.y + recoveredBounds.height <= VIEWPORTS[0].height + 1, `error controls clipped: ${JSON.stringify(recoveredBounds)}`);
      } finally { await offline.context.close(); }
    }, artifacts);

    await runScenario(results, 'responsive layouts and long text wrap without overlap', async () => {
      provider.reset('long-reply');
      for (const viewport of VIEWPORTS) {
        const { context, page, diagnostics } = await newPage(browser, origin, { viewport });
        try {
          await gotoReady(page, origin);
          await submitText(page, `layout check ${viewport.name}`);
          const assistant = await waitForAssistant(page, /wrap-check-word/);
          await assertNoticeDoesNotOverlap(page);
          if (artifacts) await page.screenshot({ path: path.join(artifacts, `layout-${viewport.name}.png`), fullPage: true });
          const badBoxes = await page.evaluate(() => {
            const selectors = ['#status-bar', '.demo-intro', '#chat-panel', '.controls', '#text-input', '.send-button', '#mic-button'];
            return selectors.flatMap((selector) => {
              const element = document.querySelector(selector);
              if (!element) return [`missing ${selector}`];
              const box = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const visible = style.visibility !== 'hidden' && style.display !== 'none';
              if (!visible) return [];
              const within = box.width > 0 && box.height > 0 && box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
              return within ? [] : [`${selector} out of viewport ${JSON.stringify({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, innerWidth, innerHeight })}`];
            });
          });
          assert.deepEqual(badBoxes, [], `${viewport.name} controls should remain reachable`);
          const wrap = await assistant.evaluate((element) => ({
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }));
          assert.ok(wrap.scrollWidth <= wrap.clientWidth + 2, `${viewport.name} long text should wrap`);
          assert.ok(wrap.scrollHeight >= wrap.clientHeight, `${viewport.name} long text should occupy wrapped height`);
          if (artifacts) await page.screenshot({ path: path.join(artifacts, `layout-${viewport.name}.png`), fullPage: true });
          await assertNoDiagnostics(diagnostics, `layout ${viewport.name}`);
        } finally {
          await context.close();
        }
      }
    }, artifacts);
  } finally {
    await browser.close().catch(() => {});
    await Promise.allSettled(ownedServers.map(closeServer));
    await fs.rm(tempDir, { recursive: true, force: true });
    if (artifacts) {
      await fs.writeFile(path.join(artifacts, 'demo-e2e-results.json'), JSON.stringify(results, null, 2));
    }
  }
  const failed = results.filter((result) => result.status === 'failed');
  if (failed.length) {
    throw new Error(`${failed.length} demo E2E scenario(s) failed. See ${artifacts || 'console output'} for details.`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
