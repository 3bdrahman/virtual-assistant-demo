import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { createApp } from '../server/index.js';

const DEFAULT_TIMEOUT_MS = 12_000;
const FIRST_SPEECH_TIMEOUT_MS = 5_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importPlaywright() {
  const requested = process.env.PLAYWRIGHT_MODULE || 'playwright';
  try {
    const importTarget = path.isAbsolute(requested) ? pathToFileURL(requested).href : requested;
    const module = await import(importTarget);
    return module.chromium ? module : module.default;
  } catch (error) {
    throw new Error(`Unable to import Playwright from ${requested}. Set PLAYWRIGHT_MODULE to a Playwright module path if it is installed outside this package: ${error.message}`);
  }
}

function wavBytes({ durationSeconds = 0.85, sampleRate = 44_100, frequency = 440 } = {}) {
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
    const envelope = Math.min(index / 600, (samples - index) / 600, 1);
    const tone = Math.sin((index / sampleRate) * frequency * Math.PI * 2);
    buffer.writeInt16LE(Math.round(tone * envelope * 0.42 * 32767), 44 + index * 2);
  }
  return buffer;
}

function pcmBytes(options) {
  return wavBytes(options).subarray(44);
}

function createGate(label) {
  let released = false;
  let resolveRelease;
  const promise = new Promise((resolve) => {
    resolveRelease = resolve;
  });
  return {
    label,
    get released() {
      return released;
    },
    release() {
      if (released) return;
      released = true;
      resolveRelease();
    },
    wait(signal) {
      if (released) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const abort = () => {
          cleanup();
          reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        };
        const cleanup = () => signal?.removeEventListener('abort', abort);
        promise.then(() => {
          cleanup();
          resolve();
        }, reject);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
  };
}

function createHeldProvider() {
  const encoder = new TextEncoder();
  const state = {
    chatCalls: [],
    ttsCalls: [],
    ttsAbortCount: 0,
    chatAbortCount: 0,
    staleTailGate: createGate('stale-tail'),
    chatDoneGate: createGate('chat-done'),
    firstTtsTailGate: createGate('first-tts-tail'),
    secondTtsGate: createGate('second-tts'),
  };

  function recordAbort(collection, entry, counterKey, signal) {
    const mark = () => {
      entry.aborted = true;
      state[counterKey] += 1;
    };
    if (signal?.aborted) mark();
    else signal?.addEventListener('abort', mark, { once: true });
  }

  function chatResponse(index, signal) {
    const body = new ReadableStream({
      async start(controller) {
        const writeToken = (content) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        };
        const abort = () => {
          try {
            controller.error(signal.reason || new DOMException('Aborted', 'AbortError'));
          } catch {}
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          if (index === 1) {
            writeToken('First sentence complete. ');
            writeToken('Nex');
            await state.staleTailGate.wait(signal);
            writeToken('t sentence continues after release, and this longer continuation is ready to speak while the model connection remains open. ');
            await state.chatDoneGate.wait(signal);
          } else {
            writeToken('Fresh answer ready.');
          }
          if (signal?.aborted) return;
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          state.chatCalls[index - 1].completed = true;
          controller.close();
        } catch (error) {
          try {
            controller.error(error);
          } catch {}
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  function immediateAudio(entry, durationSeconds = 0.85) {
    entry.completed = true;
    return new Response(wavBytes({ durationSeconds }), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  }

  function streamingPcmAudio(entry, signal, {
    firstChunkDurations = [0.25, 0.25],
    tailDurationSeconds = 0.35,
    tailGate = state.firstTtsTailGate,
    frequency = 440,
  } = {}) {
    const body = new ReadableStream({
      async start(controller) {
        const abort = () => {
          try {
            controller.error(signal.reason || new DOMException('Aborted', 'AbortError'));
          } catch {}
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          for (const durationSeconds of firstChunkDurations) {
            controller.enqueue(pcmBytes({ durationSeconds, frequency }));
            await delay(10);
            if (signal?.aborted) return;
          }
          await tailGate.wait(signal);
          if (signal?.aborted) return;
          controller.enqueue(pcmBytes({ durationSeconds: tailDurationSeconds, frequency }));
          entry.completed = true;
          controller.close();
        } catch (error) {
          try {
            controller.error(error);
          } catch {}
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/pcm;rate=44100;channels=1' } });
  }

  function heldAudio(entry, signal) {
    const body = new ReadableStream({
      async start(controller) {
        const abort = () => {
          try {
            controller.error(signal.reason || new DOMException('Aborted', 'AbortError'));
          } catch {}
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          await state.secondTtsGate.wait(signal);
          if (signal?.aborted) return;
          controller.enqueue(wavBytes({ durationSeconds: 0.3, frequency: 523.25 }));
          entry.completed = true;
          controller.close();
        } catch (error) {
          try {
            controller.error(error);
          } catch {}
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  }

  async function fetchImpl(url, init = {}) {
    const href = String(url);
    if (href.includes('/chat/completions')) {
      const entry = { index: state.chatCalls.length + 1, aborted: false, completed: false, at: Date.now() };
      state.chatCalls.push(entry);
      recordAbort(state.chatCalls, entry, 'chatAbortCount', init.signal);
      return chatResponse(entry.index, init.signal);
    }
    if (href.includes('synthesize_online')) {
      const text = typeof init.body?.get === 'function' ? String(init.body.get('text') || '') : '';
      const entry = { index: state.ttsCalls.length + 1, text, aborted: false, completed: false, streaming: true, at: Date.now() };
      state.ttsCalls.push(entry);
      recordAbort(state.ttsCalls, entry, 'ttsAbortCount', init.signal);
      if (/Fresh answer/.test(text)) {
        entry.completed = true;
        return new Response(pcmBytes({ durationSeconds: 0.35, frequency: 587.33 }), { status: 200, headers: { 'Content-Type': 'audio/pcm;rate=44100;channels=1' } });
      }
      if (entry.index >= 2 || /Next sentence|release/.test(text)) {
        return streamingPcmAudio(entry, init.signal, {
          firstChunkDurations: [0.15],
          tailDurationSeconds: 0.25,
          tailGate: state.secondTtsGate,
          frequency: 523.25,
        });
      }
      return streamingPcmAudio(entry, init.signal);
    }
    if (href.includes('/audio/synthesize')) {
      const text = typeof init.body?.get === 'function' ? String(init.body.get('text') || '') : '';
      const entry = { index: state.ttsCalls.length + 1, text, aborted: false, completed: false, at: Date.now() };
      state.ttsCalls.push(entry);
      recordAbort(state.ttsCalls, entry, 'ttsAbortCount', init.signal);
      if (/Fresh answer/.test(text)) return immediateAudio(entry, 0.35);
      if (entry.index >= 2 || /Next sentence|release/.test(text)) return heldAudio(entry, init.signal);
      return immediateAudio(entry, 0.85);
    }
    if (href.includes('/audio/transcriptions')) {
      return Response.json({ text: 'not used in this test' });
    }
    return Response.json({ error: `Unexpected provider URL ${href}` }, { status: 500 });
  }

  return {
    fetchImpl,
    releaseStaleTail() {
      state.staleTailGate.release();
    },
    releaseFirstTtsTail() {
      state.firstTtsTailGate.release();
    },
    releaseSecondTts() {
      state.secondTtsGate.release();
    },
    snapshot() {
      return {
        chatCalls: state.chatCalls.map((entry) => ({ ...entry })),
        ttsCalls: state.ttsCalls.map((entry) => ({ ...entry })),
        chatAbortCount: state.chatAbortCount,
        ttsAbortCount: state.ttsAbortCount,
        staleTailReleased: state.staleTailGate.released,
        firstTtsTailReleased: state.firstTtsTailGate.released,
        secondTtsReleased: state.secondTtsGate.released,
      };
    },
  };
}

function logger() {
  return { log() {}, warn() {}, error() {} };
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

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function addStaticServing(app) {
  const staticDir = path.resolve(process.env.E2E_STATIC_DIR || path.join(import.meta.dirname, '../dist'));
  const indexPath = path.join(staticDir, 'index.html');
  if (!fsSync.existsSync(indexPath)) {
    throw new Error(`Production dist not found at ${indexPath}. Run npm run build before this e2e test.`);
  }
  app.use(express.static(staticDir));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/__test/')) return next();
    if (path.extname(req.path)) return res.status(404).type('text/plain').send('Not found.');
    return res.sendFile(indexPath);
  });
}

async function assertEventually(fn, label, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 100 } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return await fn();
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

function installStreamingSpeechProbe() {
  const originalFetch = window.fetch.bind(window);
  const ttsTexts = [];
  const probe = {
    ttsFetches: [],
    audioStarts: [],
    audioStops: [],
    marks: {},
    mark(name) {
      this.marks[name] = performance.now();
    },
    snapshot() {
      return {
        ttsFetches: this.ttsFetches.slice(),
        audioStarts: this.audioStarts.slice(),
        audioStops: this.audioStops.slice(),
        marks: { ...this.marks },
      };
    },
  };
  window.__streamingSpeechProbe = probe;

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    let ttsEntry = null;
    if (String(url).endsWith('/api/tts')) {
      let text = '';
      try {
        text = JSON.parse(String(init.body || '{}')).text || '';
      } catch {}
      ttsEntry = { text, startedAt: performance.now(), completedAt: null, failedAt: null };
      probe.ttsFetches.push(ttsEntry);
      ttsTexts.push(text);
    }
    try {
      const response = await originalFetch(input, init);
      if (ttsEntry) ttsEntry.completedAt = performance.now();
      return response;
    } catch (error) {
      if (ttsEntry) ttsEntry.failedAt = performance.now();
      throw error;
    }
  };

  const proto = window.AudioBufferSourceNode?.prototype;
  if (!proto || proto.__streamingSpeechProbePatched) return;
  proto.__streamingSpeechProbePatched = true;
  const originalStart = proto.start;
  const originalStop = proto.stop;
  proto.start = function patchedStart(when = 0, offset, duration) {
    const context = this.context;
    probe.audioStarts.push({
      at: performance.now(),
      when,
      offset,
      duration,
      contextTime: context?.currentTime ?? null,
      bufferDuration: this.buffer?.duration ?? null,
      text: ttsTexts.at(-1) || '',
    });
    return originalStart.call(this, when, offset, duration);
  };
  proto.stop = function patchedStop(when = 0) {
    probe.audioStops.push({
      at: performance.now(),
      when,
      contextTime: this.context?.currentTime ?? null,
    });
    return originalStop.call(this, when);
  };
}

async function newPage(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: origin });
  await context.grantPermissions(['microphone'], { origin });
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  await page.addInitScript(installStreamingSpeechProbe);
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return originalGetContext.call(this, type, ...args);
    };
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const errorText = request.failure()?.errorText || 'failed';
    if ((url.endsWith('/api/chat') || url.endsWith('/api/tts')) && errorText === 'net::ERR_ABORTED') return;
    diagnostics.failedRequests.push(`${request.method()} ${url}: ${errorText}`);
  });
  return { context, page, diagnostics };
}

async function gotoReady(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Conversation, brought to life.' }).waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await assertEventually(async () => {
    assert.match((await page.locator('#status-bar').textContent()) || '', /Live AI configured/);
    assert.equal(await page.getByRole('textbox', { name: 'Message' }).isEnabled(), true);
  }, 'demo should become ready');
}

async function submitText(page, text) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.evaluate(() => window.__streamingSpeechProbe.mark('submit'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

async function providerSnapshot(page) {
  return page.evaluate(() => fetch('/__test/snapshot').then((response) => response.json()));
}

async function releaseStaleTail(page) {
  await page.evaluate(() => fetch('/__test/release-stale-tail', { method: 'POST' }).then((response) => response.json()));
}

async function releaseFirstTtsTail(page) {
  await page.evaluate(() => fetch('/__test/release-first-tts-tail', { method: 'POST' }).then((response) => response.json()));
}

async function waitForFirstAudioBeforeTailRelease(page) {
  try {
    await page.waitForFunction(() => window.__streamingSpeechProbe.snapshot().audioStarts.length > 0, null, {
      timeout: FIRST_SPEECH_TIMEOUT_MS,
      polling: 50,
    });
  } catch (error) {
    const snapshot = await providerSnapshot(page).catch(() => null);
    const browserProbe = await page.evaluate(() => window.__streamingSpeechProbe.snapshot()).catch(() => null);
    throw new Error(`first audio did not start before the held chat/TTS tails were released. This indicates the avatar is still waiting for either full chat completion or full audio-response completion before playback. provider=${JSON.stringify(snapshot)} browser=${JSON.stringify(browserProbe)}`, { cause: error });
  }
  const snapshot = await providerSnapshot(page);
  assert.equal(snapshot.staleTailReleased, false, 'first audio must start while the reply stream is still held open');
  assert.equal(snapshot.firstTtsTailReleased, false, 'first audio must start before the streaming TTS response finishes');
  assert.equal(snapshot.ttsCalls[0]?.completed, false, 'first streaming TTS response should still be open at first playback');
  const probe = await page.evaluate(() => window.__streamingSpeechProbe.snapshot());
  assert.ok(probe.audioStarts[0].bufferDuration > 0, 'first scheduled source should have decoded audio');
  assert.ok(probe.audioStarts[0].when - probe.audioStarts[0].contextTime <= 0.05, `first speech segment should start immediately on the audio clock, got ${JSON.stringify(probe.audioStarts[0])}`);
  assert.match(probe.audioStarts[0].text, /First sentence complete/i, 'first audio should belong to the completed first sentence');
  const submitToFirstStartMs = probe.audioStarts[0].at - probe.marks.submit;
  assert.ok(submitToFirstStartMs > 0 && submitToFirstStartMs < FIRST_SPEECH_TIMEOUT_MS, `submit-to-first-audio timing should be bounded, got ${submitToFirstStartMs}ms`);
  return { submitToFirstStartMs, firstStart: probe.audioStarts[0] };
}

async function waitForGaplessBufferedStarts(page) {
  await page.waitForFunction(() => window.__streamingSpeechProbe.snapshot().audioStarts.length >= 2, null, {
    timeout: FIRST_SPEECH_TIMEOUT_MS,
    polling: 25,
  });
  const probe = await page.evaluate(() => window.__streamingSpeechProbe.snapshot());
  const first = probe.audioStarts[0];
  const second = probe.audioStarts[1];
  assert.match(first.text, /First sentence complete/i, 'first buffered source should belong to the first sentence');
  assert.match(second.text, /First sentence complete/i, 'second buffered source should belong to the first sentence');
  const expectedSecondStart = first.when + first.bufferDuration;
  const scheduleGap = second.when - expectedSecondStart;
  assert.ok(Math.abs(scheduleGap) <= 0.03, `buffered audio chunks should be scheduled contiguously, gap=${scheduleGap}s first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  return { first, second, scheduleGap };
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'va-streaming-speech-e2e-'));
  const fakeAudioPath = path.join(tempDir, 'fake-mic.wav');
  await fs.writeFile(fakeAudioPath, wavBytes({ durationSeconds: 1.2, frequency: 523.25 }));

  const provider = createHeldProvider();
  const app = createApp({
    env: { NVIDIA_API_KEY: 'test-only' },
    fetchImpl: provider.fetchImpl,
    logger: logger(),
    serveStatic: false,
    providerTimeoutMs: 30_000,
    chatTimeoutMs: 30_000,
    providerLimits: { windowMs: 10_000, maxRequests: 200, maxConcurrent: 20, cleanupIntervalMs: 10_000 },
  });
  app.get('/__test/snapshot', (_req, res) => res.json(provider.snapshot()));
  app.post('/__test/release-stale-tail', (_req, res) => {
    provider.releaseStaleTail();
    res.json({ ok: true });
  });
  app.post('/__test/release-first-tts-tail', (_req, res) => {
    provider.releaseFirstTtsTail();
    res.json({ ok: true });
  });
  app.post('/__test/release-second-tts', (_req, res) => {
    provider.releaseSecondTts();
    res.json({ ok: true });
  });
  addStaticServing(app);

  const { server, origin } = await listen(app);
  const playwright = await importPlaywright();
  const browser = await createBrowser(playwright, fakeAudioPath);
  let firstAudioTiming;
  let gaplessTiming;

  try {
    const { context, page, diagnostics } = await newPage(browser, origin);
    try {
      await gotoReady(page, origin);
      await submitText(page, 'stream speech as soon as the first sentence is ready');
      await assertEventually(async () => {
        assert.match((await page.locator('.chat-message.assistant.streaming .message-text').textContent()) || '', /First sentence complete\. Nex/);
        assert.equal(await page.getByRole('textbox', { name: 'Message' }).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: /Cancel request|Stop speaking/ }).waitFor({ timeout: 500 });
      }, 'streaming reply should keep message controls busy before tail release');

      firstAudioTiming = await waitForFirstAudioBeforeTailRelease(page);
      gaplessTiming = await waitForGaplessBufferedStarts(page);
      await releaseFirstTtsTail(page);
      await releaseStaleTail(page);
      await assertEventually(async () => {
        const snapshot = await providerSnapshot(page);
        assert.ok(snapshot.ttsCalls.length >= 2, `expected a second speech segment to be requested while first audio is active: ${JSON.stringify(snapshot.ttsCalls)}`);
      }, 'second speech segment should be synthesized separately');

      await page.getByRole('button', { name: /Cancel request|Stop speaking/ }).click();
      await assertEventually(async () => {
        const snapshot = await providerSnapshot(page);
        assert.equal(snapshot.chatCalls[0]?.completed, false, 'chat must still be incomplete when cancelled');
        assert.equal(snapshot.chatCalls[0]?.aborted, true, 'Stop speaking should abort the held chat request');
        assert.ok(snapshot.ttsCalls.some((call) => call.aborted && !call.completed), 'Stop speaking should abort pending TTS work');
        const probe = await page.evaluate(() => window.__streamingSpeechProbe.snapshot());
        assert.ok(probe.audioStops.length >= 1, 'Stop speaking should stop scheduled playback immediately');
      }, 'Stop speaking should cancel streaming, synthesis, and playback');

      const stoppedProbe = await page.evaluate(() => window.__streamingSpeechProbe.snapshot());
      await page.getByRole('button', { name: 'Start new conversation' }).click();
      await page.evaluate(() => fetch('/__test/release-second-tts', { method: 'POST' }).then((response) => response.json()));
      await submitText(page, 'fresh request after cancellation');
      await page.waitForFunction((previousStarts) => window.__streamingSpeechProbe.snapshot().audioStarts.length > previousStarts, stoppedProbe.audioStarts.length, {
        timeout: DEFAULT_TIMEOUT_MS,
        polling: 50,
      });
      const finalSnapshot = await providerSnapshot(page);
      const finalProbe = await page.evaluate(() => window.__streamingSpeechProbe.snapshot());
      assert.match(finalProbe.audioStarts.at(-1)?.text || '', /Fresh answer ready/i, 'new request should receive fresh audio, not stale cancelled audio');
      assert.equal(finalSnapshot.ttsCalls.some((call) => call.text.includes('continues after release') && call.completed), false, 'cancelled stale tail audio must not complete after a new conversation');
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

  console.log(`ok - streaming speech starts before full chat completion, firstAudioMs=${Math.round(firstAudioTiming.submitToFirstStartMs)}, bufferedGapSeconds=${gaplessTiming.scheduleGap.toFixed(4)}, and cancellation prevents stale audio`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
