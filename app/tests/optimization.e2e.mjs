import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/index.js';

const specifier = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier);
const artifacts = process.env.E2E_ARTIFACT_DIR || '/tmp/va-optimization';
await fs.mkdir(artifacts, { recursive: true });
const baseline = process.env.OPTIMIZATION_BASELINE === 'true';
const server = http.createServer(createApp({ env: { NVIDIA_API_KEY: 'test-only' }, logger: { log() {}, warn() {}, error() {} } }));
let browser;
const requests = [];
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/\.(glb|fbx)$/, async (route) => {
    const record = { name: decodeURIComponent(new URL(route.request().url()).pathname), start: Date.now() };
    requests.push(record);
    // Expose serialization deterministically without depending on internet speed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    record.continued = Date.now();
    await route.continue();
  });
  const start = Date.now();
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.scene-unavailable'), null, { timeout: 30000 });
  const readyMs = Date.now() - start;
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return { canvas: { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight },
      assets: performance.getEntriesByType('resource').filter((entry) => /\.(glb|fbx)$/.test(decodeURI(entry.name))).map((entry) => ({ name: decodeURI(new URL(entry.name).pathname), startTime: entry.startTime, duration: entry.duration, encodedBytes: entry.encodedBodySize })) };
  });
  result.readyMs = readyMs;
  result.requests = requests.map((request) => ({ ...request, start: request.start - start, continued: request.continued - start }));
  result.assetStartSpreadMs = Math.max(...requests.map((request) => request.start)) - Math.min(...requests.map((request) => request.start));
  result.devicePixelRatio = 2;
  result.actualPixelRatio = result.canvas.width / result.canvas.clientWidth;
  result.errors = errors;
  assert.equal(requests.length, 3);
  assert.deepEqual(errors, []);
  if (!baseline) {
    assert.ok(requests.every((request) => request.start < Math.min(...requests.map((item) => item.continued))), 'all asset requests must start before the first delayed response is released');
    assert.ok(result.actualPixelRatio <= 1.5, 'high-DPI rendering should respect the pixel budget');
  }
  await page.screenshot({ path: path.join(artifacts, baseline ? 'before.png' : 'after.png') });
  await fs.writeFile(path.join(artifacts, baseline ? 'before.json' : 'after.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
