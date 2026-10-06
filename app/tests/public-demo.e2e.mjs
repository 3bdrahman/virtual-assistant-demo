// Explicit live deployment check. Consumes the caller's NVIDIA quota.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';

const pageUrl = process.env.DEMO_PAGE_URL;
const apiBase = process.env.DEMO_API_URL?.replace(/\/+$/, '');
const key = process.env.NVIDIA_API_KEY?.trim();
assert.ok(pageUrl && apiBase && key, 'Set DEMO_PAGE_URL, DEMO_API_URL, and NVIDIA_API_KEY for this live check.');
for (const value of [pageUrl, apiBase]) assert.equal(new URL(value).protocol, 'https:', 'Public deployment checks require HTTPS.');
const specifier = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const artifactDir = process.env.E2E_ARTIFACT_DIR || path.join(repoRoot, 'docs/public-demo-evidence');
await fs.mkdir(artifactDir, { recursive: true });
const evidence = { pageUrl, apiBase, startedAt: new Date().toISOString() };
const sanitize = (text) => String(text).replaceAll(key, '[redacted]');
const save = () => fs.writeFile(path.join(artifactDir, 'public-result.json'), JSON.stringify(evidence, null, 2));
const stage = async (name) => { evidence.stage = name; console.log(`Checking ${name}`); await save(); };

async function waitForReply(page, previousReplies) {
  let previousFailures = await page.locator('.chat-message.failed').count();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.waitForFunction(({ replies, failures }) =>
      document.querySelectorAll('.chat-message.assistant:not(.streaming)').length > replies ||
      document.querySelectorAll('.chat-message.failed').length > failures,
    { replies: previousReplies, failures: previousFailures });
    if (await page.locator('.chat-message.assistant:not(.streaming)').count() > previousReplies) return;
    const failure = page.locator('.chat-message.failed').last();
    const reason = await failure.locator('.message-retry').textContent();
    evidence.providerFailures = [...(evidence.providerFailures || []), sanitize(reason)];
    await save();
    assert.equal(attempt, 0, `Provider failed again after retry: ${reason}`);
    previousFailures = await page.locator('.chat-message.failed').count();
    await failure.getByRole('button', { name: 'Retry message', exact: true }).click();
    evidence.retries = (evidence.retries || 0) + 1;
  }
}

function probes() {
  const contexts = [];
  const stats = { sourcesStarted: 0, sourcesEnded: 0, decodedDuration: 0, analyserFrames: 0, rmsPeak: 0,
    morphUploads: 0, mouthPeak: 0, lastMouthPeak: 0, acousticTimelines: 0 };
  window.__demoProbe = { snapshot: () => ({ ...stats, audioContexts: contexts.map((ctx) => ({ state: ctx.state, time: ctx.currentTime })) }) };
  const SpeechWorker = window.Worker;
  if (SpeechWorker) window.Worker = class extends SpeechWorker {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes('speechTiming')) this.addEventListener('message', ({ data }) => {
        if (Array.isArray(data?.timeline) && data.timeline.length) stats.acousticTimelines++;
      });
    }
  };
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass) {
    const analyser = AudioContextClass.prototype.createAnalyser;
    const bufferSource = AudioContextClass.prototype.createBufferSource;
    AudioContextClass.prototype.createAnalyser = function (...args) {
      if (!contexts.includes(this)) contexts.push(this);
      const node = analyser.apply(this, args);
      const read = node.getFloatTimeDomainData;
      node.getFloatTimeDomainData = function (data) {
        read.call(this, data);
        stats.analyserFrames++;
        let energy = 0;
        for (const value of data) energy += value * value;
        stats.rmsPeak = Math.max(stats.rmsPeak, Math.sqrt(energy / data.length));
      };
      return node;
    };
    AudioContextClass.prototype.createBufferSource = function (...args) {
      const source = bufferSource.apply(this, args);
      const start = source.start;
      source.start = function (...startArgs) {
        stats.sourcesStarted++; stats.decodedDuration = source.buffer?.duration || 0;
        return start.apply(this, startArgs);
      };
      source.addEventListener('ended', () => { stats.sourcesEnded++; });
      return source;
    };
  }
  const names = new WeakMap();
  for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Type) continue;
    const prototype = Type.prototype;
    const getLocation = prototype.getUniformLocation;
    const send = prototype.uniform1fv;
    prototype.getUniformLocation = function (program, name) {
      const location = getLocation.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    prototype.uniform1fv = function (location, values, ...args) {
      if ((names.get(location) || '').includes('morphTargetInfluences')) {
        stats.morphUploads++;
        stats.lastMouthPeak = Math.max(0, ...Array.from(values).slice(1));
        stats.mouthPeak = Math.max(stats.mouthPeak, stats.lastMouthPeak);
      }
      return send.call(this, location, values, ...args);
    };
  }
}

let browser;
let page;
const pageErrors = [];
const consoleErrors = [];
const responses = [];
try {
  await stage('launch browser');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.join(repoRoot, 'docs/pages-demo-evidence/voice-sample.wav')}`] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['microphone'], { origin: new URL(pageUrl).origin });
  page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.addInitScript(probes);
  page.on('pageerror', (error) => pageErrors.push(sanitize(error.message)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(sanitize(message.text())); });
  page.on('response', (response) => {
    if (response.url().startsWith(apiBase)) responses.push({ route: response.url().slice(apiBase.length), status: response.status() });
  });
  await stage('visitor key and avatar loading');
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Add your NVIDIA API key' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).isDisabled(), true);
  evidence.visitorKeyRequired = true;
  await page.getByLabel('NVIDIA API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Use key', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.scene-unavailable'));
  evidence.avatarLoaded = true;
  await stage('live chat and speech');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Explain how rain forms in two short sentences.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitForReply(page, 0);
  evidence.chat = true;
  await page.waitForFunction(() => window.__demoProbe.snapshot().sourcesStarted > 0 || document.querySelector('.speech-mode')?.textContent.includes('Text only'));
  evidence.speechMode = await page.locator('.speech-mode').textContent();
  await stage('rendered mouth movement');
  await page.waitForFunction(() => window.__demoProbe.snapshot().mouthPeak > 0.1, null, { timeout: 15000 });
  await page.waitForFunction(() => window.__demoProbe.snapshot().acousticTimelines > 0, null, { timeout: 15000 });
  evidence.playback = await page.evaluate(() => window.__demoProbe.snapshot());
  assert.match(evidence.speechMode, /Jason/);
  evidence.speech = true;
  await page.screenshot({ path: path.join(artifactDir, 'public-speaking.png') });
  const stop = page.getByRole('button', { name: 'Stop speaking', exact: true });
  if (await stop.isVisible()) await stop.click();
  await page.waitForFunction(() => window.__demoProbe.snapshot().lastMouthPeak < 0.001);
  evidence.stopResetsMouth = true;
  await stage('microphone transcription and second reply');
  const originalReplies = await page.locator('.chat-message.assistant:not(.streaming)').count();
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await waitForReply(page, originalReplies);
  assert.ok(responses.some((response) => response.route === '/stt' && response.status === 200));
  evidence.microphoneConversation = true;
  await stage('new chat and key clearing');
  await page.getByRole('button', { name: 'Start new conversation', exact: true }).click();
  assert.equal(await page.locator('.chat-message').count(), 0);
  evidence.newChatClears = true;
  const persisted = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
  assert.equal(persisted.some((value) => value.includes(key)), false);
  evidence.keyNotPersisted = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Add your NVIDIA API key' }).waitFor();
  evidence.reloadClearsKey = true;
  await page.screenshot({ path: path.join(artifactDir, 'public-key-entry.png') });
  assert.deepEqual(pageErrors, []);
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = sanitize(error.stack || error.message);
  if (page) {
    evidence.playback = await page.evaluate(() => window.__demoProbe?.snapshot()).catch(() => null);
    evidence.status = await page.locator('#status-bar').textContent().catch(() => null);
    await page.evaluate(() => { const input = document.querySelector('#visitor-api-key'); if (input) input.value = ''; }).catch(() => {});
    await page.screenshot({ path: path.join(artifactDir, 'public-failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  evidence.responses = responses;
  evidence.pageErrors = pageErrors;
  evidence.consoleErrors = consoleErrors;
  await browser?.close();
  await save();
  console.log(JSON.stringify(evidence, null, 2));
}
