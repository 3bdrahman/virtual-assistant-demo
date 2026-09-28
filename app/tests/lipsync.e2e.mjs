import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp } from '../server/index.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const REPLY_TEXT = 'a a o o e e i i u u a o e i u p p f f s s a a o o e e';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importPlaywright() {
  const requested = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const importTarget = path.isAbsolute(requested) ? pathToFileURL(requested).href : requested;
  return import(importTarget);
}

function wavBytes({ durationSeconds = 12, sampleRate = 44_100, frequency = 440 } = {}) {
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
    const envelope = Math.min(index / 1000, (samples - index) / 1000, 1);
    const tone = Math.sin((index / sampleRate) * frequency * Math.PI * 2);
    const mod = 0.55 + 0.35 * Math.sin((index / sampleRate) * Math.PI * 2 * 2.3);
    buffer.writeInt16LE(Math.round(tone * mod * envelope * 0.55 * 32767), 44 + index * 2);
  }
  return buffer;
}

function sseResponse(text, { delayMs = 35, signal } = {}) {
  const encoder = new TextEncoder();
  const tokens = text.match(/.{1,4}/g) || [text];
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
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        cleanup();
      }
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function createFakeProvider() {
  const state = { calls: [] };
  const audio = wavBytes();
  return {
    async fetchImpl(url, init = {}) {
      const href = String(url);
      state.calls.push({ url: href, method: init.method || 'GET' });
      if (href.includes('/chat/completions')) {
        return sseResponse(REPLY_TEXT, { signal: init.signal });
      }
      if (href.includes('/audio/synthesize')) {
        return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      }
      if (href.includes('/audio/transcriptions')) {
        return Response.json({ text: 'not used in this test' });
      }
      return Response.json({ error: `Unexpected provider URL ${href}` }, { status: 500 });
    },
    snapshot() {
      return { calls: [...state.calls] };
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
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function logger() {
  return { log() {}, warn() {}, error() {} };
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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

async function newPage(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: origin });
  await context.grantPermissions(['microphone'], { origin });
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  await page.addInitScript(installRenderProbes);
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('/api/chat') && request.failure()?.errorText === 'net::ERR_ABORTED') return;
    diagnostics.failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`);
  });
  return { context, page, diagnostics };
}

async function gotoReady(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Conversation, brought to life.' }).waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await assertEventually(async () => {
    const content = await page.locator('#status-bar').textContent({ timeout: 1000 });
    assert.match(content || '', /Live AI configured/);
    assert.equal(await page.getByRole('textbox', { name: 'Message' }).isEnabled(), true);
  }, 'demo should become ready');
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.scene-loading-inline') && !document.querySelector('.scene-unavailable'), null, { timeout: DEFAULT_TIMEOUT_MS });
}

async function submitText(page, text) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

async function waitForAssistant(page) {
  const assistant = page.locator('.chat-message.assistant:not(.streaming) .message-text').last();
  await assertEventually(async () => {
    assert.match((await assistant.textContent()) || '', /a a o o e e/);
  }, 'assistant reply should appear');
  return assistant;
}

function installRenderProbes() {
  const locationNames = new WeakMap();
  const morphSamples = [];
  const mixerSamples = [];
  const roots = new Map();
  let rendererId = 0;

  window.__lipsyncProbe = {
    morphSamples,
    mixerSamples,
    snapshot() {
      return {
        morphSamples: morphSamples.slice(-600),
        mixerSamples: mixerSamples.slice(-600),
        rendererRoots: roots.size,
      };
    },
    clearMorphSamples() {
      morphSamples.length = 0;
    },
    clearMixerSamples() {
      mixerSamples.length = 0;
    },
  };

  function patchGlPrototype(proto) {
    if (!proto || proto.__vaLipsyncPatched) return;
    proto.__vaLipsyncPatched = true;
    const getUniformLocation = proto.getUniformLocation;
    const uniform1fv = proto.uniform1fv;
    proto.getUniformLocation = function patchedGetUniformLocation(program, name) {
      const location = getUniformLocation.call(this, program, name);
      if (location && String(name).includes('morphTargetInfluences')) {
        locationNames.set(location, String(name));
      }
      return location;
    };
    proto.uniform1fv = function patchedUniform1fv(location, value) {
      const name = locationNames.get(location);
      if (name && value && value.length >= 8) {
        const values = Array.from(value, Number);
        morphSamples.push({
          t: performance.now(),
          name,
          values,
          max: Math.max(...values),
          sum: values.reduce((total, item) => total + Math.abs(item), 0),
        });
        if (morphSamples.length > 3000) morphSamples.splice(0, 1000);
      }
      return uniform1fv.call(this, location, value);
    };
  }

  patchGlPrototype(window.WebGLRenderingContext?.prototype);
  patchGlPrototype(window.WebGL2RenderingContext?.prototype);

  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      rendererId += 1;
      this.renderers.set(rendererId, renderer);
      return rendererId;
    },
    onCommitFiberRoot(id, root) {
      roots.set(id, root);
    },
    onCommitFiberUnmount() {},
  };

  function findMixerInValue(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.clipAction === 'function' && Array.isArray(value._actions)) return value;
    const api = Array.isArray(value) ? value[0] : value;
    return typeof api?.mixer?.clipAction === 'function' ? api.mixer : null;
  }

  function findMixerInHooks(hook) {
    let current = hook;
    let guard = 0;
    while (current && guard < 80) {
      const found = findMixerInValue(current.memoizedState);
      if (found) return found;
      current = current.next;
      guard += 1;
    }
    return null;
  }

  function findMixerInFiber(fiber) {
    const stack = [fiber];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      const mixer = findMixerInHooks(node.memoizedState);
      if (mixer) return mixer;
      if (node.child) stack.push(node.child);
      if (node.sibling) stack.push(node.sibling);
    }
    return null;
  }

  let cachedMixer = null;
  function sampleMixer() {
    for (const root of roots.values()) {
      const mixer = cachedMixer || findMixerInFiber(root.current);
      if (mixer) cachedMixer = mixer;
      if (!mixer) continue;
      const actions = mixer._actions || [];
      const idle = actions.find((action) => action?._clip?.name === 'Idle');
      if (!idle) continue;
      mixerSamples.push({
        t: performance.now(),
        mixerId: mixer.uuid || null,
        actionCount: actions.length,
        idleTime: idle.time,
        idleWeight: typeof idle.getEffectiveWeight === 'function' ? idle.getEffectiveWeight() : idle.weight,
        idleRunning: typeof idle.isRunning === 'function' ? idle.isRunning() : idle.enabled,
        idleDuration: idle._clip?.duration || 0,
      });
      if (mixerSamples.length > 3000) mixerSamples.splice(0, 1000);
      break;
    }
    requestAnimationFrame(sampleMixer);
  }
  requestAnimationFrame(sampleMixer);
}

function distance(a, b) {
  const length = Math.max(a?.length || 0, b?.length || 0);
  let max = 0;
  let sum = 0;
  for (let index = 0; index < length; index++) {
    const delta = Math.abs((a?.[index] || 0) - (b?.[index] || 0));
    max = Math.max(max, delta);
    sum += delta;
  }
  return { max, sum };
}

function analyzeMorphMotion(samples, baseline) {
  let maxFromBaseline = 0;
  let maxBetweenSamples = 0;
  let maxSum = 0;
  let movingSamples = 0;
  let previous = null;
  for (const sample of samples) {
    const fromBaseline = distance(sample.values, baseline);
    maxFromBaseline = Math.max(maxFromBaseline, fromBaseline.max);
    maxSum = Math.max(maxSum, sample.sum);
    if (fromBaseline.max > 0.08) movingSamples += 1;
    if (previous) maxBetweenSamples = Math.max(maxBetweenSamples, distance(sample.values, previous.values).max);
    previous = sample;
  }
  return { maxFromBaseline, maxBetweenSamples, maxSum, movingSamples, count: samples.length };
}

function analyzeIdle(samples) {
  const usable = samples.filter((sample) => sample.idleRunning && sample.idleWeight > 0.7 && sample.idleDuration > 1);
  let resets = 0;
  let progress = 0;
  for (let index = 1; index < usable.length; index++) {
    const previous = usable[index - 1];
    const current = usable[index];
    const loopWrap = previous.idleTime > previous.idleDuration - 0.35 && current.idleTime < 0.35;
    if (current.idleTime + 0.08 < previous.idleTime && !loopWrap) resets += 1;
    progress += Math.max(0, current.idleTime - previous.idleTime + (loopWrap ? previous.idleDuration : 0));
  }
  return {
    count: usable.length,
    resets,
    elapsed: usable.length ? usable.at(-1).t - usable[0].t : 0,
    progress,
    actionCounts: [...new Set(usable.map((sample) => sample.actionCount))],
  };
}

async function latestMorphSample(page) {
  return page.evaluate(() => window.__lipsyncProbe.snapshot().morphSamples.at(-1) || null);
}

async function waitForMorphMotion(page, baseline, label) {
  await assertEventually(async () => {
    const samples = await page.evaluate(() => window.__lipsyncProbe.snapshot().morphSamples);
    const analysis = analyzeMorphMotion(samples, baseline);
    assert.ok(analysis.count >= 6, `${label} should upload repeated morph uniforms`);
    assert.ok(analysis.maxFromBaseline > 0.12, `${label} max morph delta ${analysis.maxFromBaseline}`);
    assert.ok(analysis.maxBetweenSamples > 0.025, `${label} between-frame morph delta ${analysis.maxBetweenSamples}`);
    assert.ok(analysis.movingSamples >= 3, `${label} moving samples ${analysis.movingSamples}`);
  }, `${label} should move mouth morphs on the GPU`, { timeoutMs: 8000, intervalMs: 150 });
}

async function sampleIdleResetDiagnostics(page, label, sampleMs) {
  await page.evaluate(() => window.__lipsyncProbe.clearMixerSamples());
  await delay(sampleMs);
  const analysis = analyzeIdle(await page.evaluate(() => window.__lipsyncProbe.snapshot().mixerSamples));
  // Software WebGL can render only a few frames per second in CI. Require
  // elapsed-time coverage and actual clock progress, independent of frame rate.
  assert.ok(analysis.count >= 3 && analysis.elapsed > sampleMs * 0.65,
    `${label}: insufficient observed idle frames: ${JSON.stringify(analysis)}`);
  assert.ok(analysis.progress > 0.8, `${label} Idle action should progress`);
  assert.equal(analysis.resets, 0, `${label} Idle action time should not reset`);
  assert.ok(analysis.actionCounts.every((count) => count <= 2), `${label} should not accumulate duplicate actions: ${analysis.actionCounts.join(',')}`);
  return analysis;
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'va-lipsync-e2e-'));
  const artifactDir = process.env.E2E_ARTIFACT_DIR ? path.resolve(process.env.E2E_ARTIFACT_DIR) : '';
  if (artifactDir) await fs.mkdir(artifactDir, { recursive: true });
  const fakeAudioPath = path.join(tempDir, 'fake-mic.wav');
  await fs.writeFile(fakeAudioPath, wavBytes({ durationSeconds: 1.2, frequency: 523.25 }));

  const provider = createFakeProvider();
  const app = createApp({
    env: { NVIDIA_API_KEY: 'test-only' },
    fetchImpl: provider.fetchImpl,
    logger: logger(),
    staticDir: process.env.E2E_STATIC_DIR || undefined,
    providerTimeoutMs: 30_000,
    providerLimits: { windowMs: 10_000, maxRequests: 200, maxConcurrent: 20, cleanupIntervalMs: 10_000 },
  });
  const { server, origin } = await listen(app);
  const playwright = await importPlaywright();
  const browser = await createBrowser(playwright, fakeAudioPath);

  try {
    const { context, page, diagnostics } = await newPage(browser, origin);
    try {
      await gotoReady(page, origin);
      await page.waitForFunction(() => performance.getEntriesByType('resource').filter((entry) => /\.(glb|fbx)$/.test(decodeURI(entry.name))).length === 3);
      await page.waitForFunction(() => { const sample = window.__lipsyncProbe.snapshot().mixerSamples.at(-1); return sample?.idleRunning && sample.idleWeight > 0.99; }, null, { timeout: 15000 });
      const idleBefore = await sampleIdleResetDiagnostics(page, 'idle before speech', 4200);

      const baselineSample = await latestMorphSample(page);
      assert.ok(baselineSample, 'avatar should upload morph target uniforms while idle');
      const baseline = baselineSample.values;

      await page.evaluate(() => window.__lipsyncProbe.clearMorphSamples());
      await submitText(page, 'first lipsync pass');
      await waitForAssistant(page);
      const idleDuring = await sampleIdleResetDiagnostics(page, 'idle during streamed chat', 1600);
      await waitForMorphMotion(page, baseline, 'first reply');
      if (artifactDir) await page.screenshot({ path: path.join(artifactDir, 'lipsync-speaking.png') });

      await page.getByRole('button', { name: 'Stop speaking' }).click();
      await assertEventually(async () => {
        const latest = await latestMorphSample(page);
        assert.ok(latest, 'latest morph sample should exist after stop');
        assert.ok(distance(latest.values, baseline).max < 0.08, 'mouth morphs should settle back to idle after Stop speaking');
      }, 'Stop speaking should reset mouth morphs', { timeoutMs: 4000, intervalMs: 100 });
      if (artifactDir) await page.screenshot({ path: path.join(artifactDir, 'lipsync-silence.png') });

      await page.evaluate(() => window.__lipsyncProbe.clearMorphSamples());
      await submitText(page, 'second lipsync pass');
      await waitForAssistant(page);
      await waitForMorphMotion(page, baseline, 'second reply');

      if (artifactDir) await fs.writeFile(path.join(artifactDir, 'avatar-results.json'), JSON.stringify({ idleBefore, idleDuring, mouthMotion: analyzeMorphMotion(await page.evaluate(() => window.__lipsyncProbe.snapshot().morphSamples), baseline), stopResetsMouth: true, secondReplyMovesMouth: true }, null, 2));
      const calls = provider.snapshot().calls;
      assert.equal(calls.filter((call) => call.url.includes('/chat/completions')).length, 2);
      assert.equal(calls.filter((call) => call.url.includes('/audio/synthesize')).length, 2);
      assert.deepEqual(diagnostics.pageErrors, [], 'page errors');
      assert.deepEqual(diagnostics.consoleErrors, [], 'console errors');
      assert.deepEqual(diagnostics.failedRequests, [], 'failed requests');
    } finally {
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    await closeServer(server).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log('ok - lipsync GPU morphs move, reset on stop, and repeat across replies');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
