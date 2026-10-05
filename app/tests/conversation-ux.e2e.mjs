import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createServer as createViteServer } from 'vite';

const DEFAULT_TIMEOUT_MS = 10_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importPlaywright() {
  const requested = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const importTarget = requested.startsWith('/') ? pathToFileURL(requested).href : requested;
  return import(importTarget);
}

async function assertEventually(fn, label, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 50 } = {}) {
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

function testPageHtml() {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Conversation UX Regression</title>
        <style>
          body { margin: 0; font-family: system-ui, sans-serif; }
          .chat-panel { height: 260px; display: flex; flex-direction: column; border: 1px solid #999; }
          .chat-header { display: flex; justify-content: space-between; padding: 8px; }
          .chat-messages { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
          .chat-message { min-height: 90px; border: 1px solid #ddd; padding: 8px; }
          .text-input-form { margin-top: 16px; display: flex; gap: 8px; }
        </style>
      </head>
      <body>
        <div id="root"></div>
        <script type="module">
          import React, { useEffect, useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { ChatPanel } from '/src/components/ChatPanel.jsx';
          import { TextInput } from '/src/components/TextInput.jsx';

          function Fixture() {
            const [messages, setMessages] = useState([]);
            const [streamingText, setStreamingText] = useState('');
            const [sentMessage, setSentMessage] = useState(null);
            const streamTimerRef = useRef(null);
            const resolveSubmitRef = useRef(null);

            useEffect(() => {
              window.__ux = {
                fillHistory() {
                  setMessages(Array.from({ length: 8 }, (_, index) => ({
                    role: index % 2 ? 'assistant' : 'user',
                    content: 'history ' + index + ' ' + 'long text '.repeat(30),
                  })));
                  setStreamingText('');
                },
                appendOwnMessage() {
                  setMessages((current) => [...current, { role: 'user', content: 'new own message' }]);
                },
                clearConversation() {
                  setMessages([]);
                  setStreamingText('');
                },
                startStreaming() {
                  let index = 0;
                  setStreamingText('stream start');
                  clearInterval(streamTimerRef.current);
                  streamTimerRef.current = setInterval(() => {
                    index += 1;
                    setStreamingText((current) => current + ' token-' + index);
                  }, 40);
                },
                stopStreaming() {
                  clearInterval(streamTimerRef.current);
                  streamTimerRef.current = null;
                },
                commitSent(content) {
                  setSentMessage({ role: 'user', content });
                },
                resolveSubmit(value = true) {
                  resolveSubmitRef.current?.(value);
                  resolveSubmitRef.current = null;
                },
              };
              return () => clearInterval(streamTimerRef.current);
            }, []);

            return (
              React.createElement(React.Fragment, null,
                React.createElement(ChatPanel, {
                  messages,
                  streamingText,
                  status: 'idle',
                  onNewConversation: () => setMessages([]),
                  onRetry: () => {},
                  retryDisabled: false,
                }),
                React.createElement(TextInput, {
                  onSubmit: (text) => {
                    window.__lastSubmitted = text;
                    return new Promise((resolve) => { resolveSubmitRef.current = resolve; });
                  },
                  sentMessage,
                  describedBy: undefined,
                  disabled: false,
                })
              )
            );
          }

          createRoot(document.getElementById('root')).render(React.createElement(Fixture));
        </script>
      </body>
    </html>`;
}

async function startVite() {
  const vite = await createViteServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1' },
    plugins: [{
      name: 'conversation-ux-test-page',
      configureServer(server) {
        server.middlewares.use('/conversation-ux.html', async (req, res) => {
          const html = await server.transformIndexHtml(req.url, testPageHtml());
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(html);
        });
      },
    }],
  });
  await vite.listen(0);
  const address = vite.httpServer.address();
  return { vite, origin: `http://127.0.0.1:${address.port}` };
}

async function runScenario(results, name, fn) {
  try {
    await fn();
    results.push({ name, status: 'passed' });
    console.log(`ok - ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack || error.message });
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message);
  }
}

async function main() {
  const results = [];
  const { chromium } = await importPlaywright();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const { vite, origin } = await startVite();

  try {
    await runScenario(results, 'streaming preserves manual transcript position until requested', async () => {
      const page = await browser.newPage({ viewport: { width: 600, height: 500 }, baseURL: origin });
      try {
        await page.goto('/conversation-ux.html');
        await page.waitForFunction(() => window.__ux);
        const transcript = page.locator('.chat-messages');
        await page.evaluate(() => window.__ux.fillHistory());
        await assertEventually(async () => {
          const metrics = await transcript.evaluate((element) => ({
            scrollTop: element.scrollTop,
            maxScrollTop: element.scrollHeight - element.clientHeight,
          }));
          assert.ok(metrics.maxScrollTop > 200, `expected overflowing transcript, got ${JSON.stringify(metrics)}`);
          assert.ok(metrics.scrollTop > metrics.maxScrollTop - 8, `history should initially follow latest: ${JSON.stringify(metrics)}`);
        }, 'history should overflow and follow latest');

        await transcript.evaluate((element) => { element.scrollTop = 0; });
        await page.evaluate(() => window.__ux.startStreaming());
        await delay(180);
        const readingMetrics = await transcript.evaluate((element) => ({
          scrollTop: element.scrollTop,
          maxScrollTop: element.scrollHeight - element.clientHeight,
        }));
        assert.ok(readingMetrics.scrollTop < 80, `streaming should not pull reader to bottom: ${JSON.stringify(readingMetrics)}`);
        await assert.equal(await page.getByRole('button', { name: 'Return to latest message' }).isVisible(), true);

        await page.evaluate(() => window.__ux.appendOwnMessage());
        await assertEventually(async () => {
          const metrics = await transcript.evaluate((element) => ({
            scrollTop: element.scrollTop,
            maxScrollTop: element.scrollHeight - element.clientHeight,
          }));
          assert.ok(metrics.scrollTop > metrics.maxScrollTop - 8, `new own message should follow latest: ${JSON.stringify(metrics)}`);
        }, 'new own message follows latest');

        await transcript.evaluate((element) => { element.scrollTop = 0; });
        await page.getByRole('button', { name: 'Return to latest message' }).click();
        await assertEventually(async () => {
          const metrics = await transcript.evaluate((element) => ({
            scrollTop: element.scrollTop,
            maxScrollTop: element.scrollHeight - element.clientHeight,
          }));
          assert.ok(metrics.scrollTop > metrics.maxScrollTop - 8, `return button should scroll down: ${JSON.stringify(metrics)}`);
        }, 'return to latest button works');
      } finally {
        await page.close();
      }
    });

    await runScenario(results, 'late submit resolution does not clear a newer identical draft', async () => {
      const page = await browser.newPage({ viewport: { width: 600, height: 500 }, baseURL: origin });
      try {
        await page.goto('/conversation-ux.html');
        await page.waitForFunction(() => window.__ux);
        const input = page.getByRole('textbox', { name: 'Message' });
        await input.fill('repeat');
        await page.getByRole('button', { name: 'Send message' }).click();
        await assertEventually(async () => {
          assert.equal(await page.evaluate(() => window.__lastSubmitted), 'repeat');
        }, 'submit should start');
        await page.evaluate(() => window.__ux.commitSent('repeat'));
        await assertEventually(async () => {
          assert.equal(await input.inputValue(), '');
        }, 'committed sent message clears submitted draft');
        await input.fill('repeat');
        await page.evaluate(() => window.__ux.resolveSubmit(true));
        await delay(80);
        assert.equal(await input.inputValue(), 'repeat');
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close().catch(() => {});
    await vite.close().catch(() => {});
  }

  const failed = results.filter((result) => result.status === 'failed');
  if (failed.length) {
    throw new Error(`${failed.length} conversation UX scenario(s) failed.`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
