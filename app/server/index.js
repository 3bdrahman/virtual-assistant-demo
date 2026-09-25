import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 3011;

const NIM_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_STT_URL = 'https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions';
const NVIDIA_TTS_URL = 'https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize';
const DEFAULT_CHAT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const NVIDIA_TTS_VOICE = 'Magpie-Multilingual.EN-US.Aria';
const MAX_JSON_BYTES = '1mb';
const MAX_CHAT_MESSAGES = 25;
const MAX_CHAT_CONTENT_LENGTH = 8_000;
const MAX_TTS_TEXT_LENGTH = 5_000;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const VALID_ROLES = new Set(['system', 'user', 'assistant']);
const DEFAULT_PROVIDER_LIMITS = {
  windowMs: 60_000,
  maxRequests: 20,
  maxConcurrent: 2,
};

function getKey(env, name) {
  return String(env[name] || '').trim();
}

function publicHealth(env) {
  const hasNvidiaKey = Boolean(getKey(env, 'NVIDIA_API_KEY'));
  return {
    ok: true,
    hasNvidiaKey,
    services: {
      nvidia: { configured: hasNvidiaKey },
    },
  };
}

function sendProviderError(res, provider, providerStatus) {
  if (providerStatus === 401 || providerStatus === 403) {
    return res.status(503).json({
      error: `${provider} rejected the server key. The demo owner needs to update it.`,
      providerStatus,
    });
  }
  const status = providerStatus === 429 ? 429 : providerStatus >= 500 ? 503 : 502;
  return res.status(status).json({
    error: `${provider} provider error.`,
    providerStatus,
  });
}

function sendProviderFailure(res, logger, route, provider, error) {
  if (res.destroyed) return undefined;
  logger.error(`[API ${route}] Provider request failed:`, error.message);
  if (res.headersSent) return res.end();
  if (error.name === 'TimeoutError') {
    return res.status(504).json({ error: `${provider} timed out. Please try again.` });
  }
  return res.status(503).json({ error: `${provider} provider is unavailable.` });
}

function createProviderAbort(res, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Provider timed out.', 'TimeoutError')), timeoutMs);
  const onClose = () => controller.abort();
  res.once('close', onClose);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      res.off('close', onClose);
    },
  };
}

function getChatModel(env) {
  return String(env.NVIDIA_CHAT_MODEL || DEFAULT_CHAT_MODEL).trim() || DEFAULT_CHAT_MODEL;
}

function isJsonRequest(req) {
  const contentType = req.get('content-type') || '';
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function validateChatPayload(body) {
  if (!body || !Array.isArray(body.messages)) {
    return 'messages must be an array.';
  }

  if (body.messages.length < 1 || body.messages.length > MAX_CHAT_MESSAGES) {
    return `messages must contain 1-${MAX_CHAT_MESSAGES} entries.`;
  }

  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      return 'each message must be an object.';
    }
    if (!VALID_ROLES.has(message.role)) {
      return 'message role must be system, user, or assistant.';
    }
    if (typeof message.content !== 'string' || message.content.trim().length === 0) {
      return 'message content must be a non-empty string.';
    }
    if (message.content.length > MAX_CHAT_CONTENT_LENGTH) {
      return `message content must be ${MAX_CHAT_CONTENT_LENGTH} characters or fewer.`;
    }
  }

  const firstTurn = body.messages[0].role === 'system' ? 1 : 0;
  if (firstTurn === body.messages.length) {
    return 'messages must include a user turn.';
  }
  for (let index = firstTurn; index < body.messages.length; index++) {
    const expectedRole = (index - firstTurn) % 2 === 0 ? 'user' : 'assistant';
    if (body.messages[index].role !== expectedRole) {
      return 'messages must alternate user and assistant turns after an optional system message.';
    }
  }
  if (body.messages.at(-1).role !== 'user') {
    return 'messages must end with a user turn.';
  }

  if (body.model !== undefined) {
    return 'model is selected by the server.';
  }

  return null;
}

function validateTtsPayload(body) {
  if (!body || typeof body.text !== 'string' || body.text.trim().length === 0) {
    return 'text must be a non-empty string.';
  }
  if (body.text.length > MAX_TTS_TEXT_LENGTH) {
    return `text must be ${MAX_TTS_TEXT_LENGTH} characters or fewer.`;
  }
  if (body.voice !== undefined) {
    return 'voice is selected by the server.';
  }
  return null;
}

function allowedOrigins(env, host) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const devOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    `http://${host}`,
    `https://${host}`,
  ];
  return new Set([...devOrigins, ...configured]);
}

function sameOriginGuard(env) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin || req.method === 'GET' || req.method === 'HEAD') {
      return next();
    }

    const allowed = allowedOrigins(env, req.get('host') || '');
    if (!allowed.has(origin)) {
      return res.status(403).json({ error: 'Cross-origin API requests are not allowed.' });
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      return res.status(204).end();
    }
    return next();
  };
}

function createProviderGate(limits = {}) {
  const windowMs = Number(limits.windowMs || DEFAULT_PROVIDER_LIMITS.windowMs);
  const maxRequests = Number(limits.maxRequests || DEFAULT_PROVIDER_LIMITS.maxRequests);
  const maxConcurrent = Number(limits.maxConcurrent || DEFAULT_PROVIDER_LIMITS.maxConcurrent);
  const clients = new Map();

  return function acquireProviderSlot(req, res) {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const record = clients.get(ip) || { timestamps: [], active: 0 };
    record.timestamps = record.timestamps.filter((timestamp) => now - timestamp < windowMs);

    if (record.active >= maxConcurrent) {
      res.setHeader('Retry-After', '5');
      res.status(429).json({ error: 'Too many provider requests already running. Please retry in a moment.' });
      clients.set(ip, record);
      return null;
    }

    if (record.timestamps.length >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((record.timestamps[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many provider requests. Please try again shortly.' });
      clients.set(ip, record);
      return null;
    }

    record.timestamps.push(now);
    record.active += 1;
    clients.set(ip, record);

    return () => {
      record.active = Math.max(0, record.active - 1);
      record.timestamps = record.timestamps.filter((timestamp) => Date.now() - timestamp < windowMs);
      if (record.active === 0 && record.timestamps.length === 0) {
        clients.delete(ip);
      } else {
        clients.set(ip, record);
      }
    };
  };
}

function isWavBuffer(audioBuffer) {
  return audioBuffer.length >= 12 &&
    audioBuffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    audioBuffer.subarray(8, 12).toString('ascii') === 'WAVE';
}

async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeUpstreamBody(upstreamBody, res) {
  if (!upstreamBody) {
    return;
  }

  if (typeof upstreamBody.getReader === 'function') {
    const reader = upstreamBody.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      if (typeof res.flush === 'function') res.flush();
    }
    return;
  }

  for await (const chunk of upstreamBody) {
    res.write(chunk);
    if (typeof res.flush === 'function') res.flush();
  }
}

function addStaticServing(app, logger) {
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(serverDir, '../dist');
  const indexPath = path.join(distDir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    logger.warn('[SERVER] Production dist not found; API-only server mode.');
    return;
  }

  app.use(express.static(distDir));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(indexPath);
  });
}

export function createApp(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const acquireProviderSlot = createProviderGate(options.providerLimits);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === 'true');
  app.use(sameOriginGuard(env));
  app.use(express.json({ limit: MAX_JSON_BYTES }));

  app.get('/api/health', (_req, res) => {
    res.json(publicHealth(env));
  });

  app.post('/api/stt', async (req, res) => {
    const apiKey = getKey(env, 'NVIDIA_API_KEY');
    if (!apiKey) {
      return res.status(503).json({ error: 'NVIDIA API key is not configured on the server.' });
    }

    const contentType = (req.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!['audio/wav', 'audio/wave', 'audio/x-wav'].includes(contentType)) {
      return res.status(415).json({ error: 'Audio upload must be WAV.' });
    }

    try {
      const audioBuffer = await readRequestBody(req, MAX_AUDIO_BYTES);
      if (audioBuffer.length === 0) {
        return res.status(400).json({ error: 'Audio upload cannot be empty.' });
      }
      if (!isWavBuffer(audioBuffer)) {
        return res.status(400).json({ error: 'Audio upload must be a valid WAV file.' });
      }

      const releaseProviderSlot = acquireProviderSlot(req, res);
      if (!releaseProviderSlot) return undefined;
      const providerAbort = createProviderAbort(res, providerTimeoutMs);

      try {
        const formData = new FormData();
        formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
        formData.append('language', 'en-US');

        const nimRes = await fetchImpl(NVIDIA_STT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
          signal: providerAbort.signal,
        });

        if (!nimRes.ok) {
          return sendProviderError(res, 'NVIDIA STT', nimRes.status);
        }

        const data = await nimRes.json();
        return res.json(data);
      } finally {
        providerAbort.cleanup();
        releaseProviderSlot();
      }
    } catch (err) {
      if (err.statusCode === 413) {
        return res.status(413).json({ error: 'Audio upload is too large.' });
      }
      return sendProviderFailure(res, logger, '/stt', 'NVIDIA STT', err);
    }
  });

  app.post('/api/chat', async (req, res) => {
    const apiKey = getKey(env, 'NVIDIA_API_KEY');
    if (!apiKey) {
      return res.status(503).json({ error: 'NVIDIA API key is not configured on the server.' });
    }

    if (!isJsonRequest(req)) {
      return res.status(415).json({ error: 'Request body must be JSON.' });
    }

    const validationError = validateChatPayload(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (req.socket) {
      req.socket.setNoDelay(true);
    }

    const releaseProviderSlot = acquireProviderSlot(req, res);
    if (!releaseProviderSlot) return undefined;
    const providerAbort = createProviderAbort(res, providerTimeoutMs);

    try {
      const selectedModel = getChatModel(env);
      logger.log('[API /chat] Streaming chat request:', { model: selectedModel });

      const nimRes = await fetchImpl(`${NIM_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: req.body.messages,
          stream: true,
          max_tokens: 256,
          temperature: 0.7,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: providerAbort.signal,
      });

      if (!nimRes.ok) {
        return sendProviderError(res, 'NVIDIA chat', nimRes.status);
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      await writeUpstreamBody(nimRes.body, res);
      return res.end();
    } catch (err) {
      return sendProviderFailure(res, logger, '/chat', 'NVIDIA chat', err);
    } finally {
      providerAbort.cleanup();
      releaseProviderSlot();
    }
  });

  app.post('/api/tts', async (req, res) => {
    const apiKey = getKey(env, 'NVIDIA_API_KEY');
    if (!apiKey) {
      return res.status(503).json({ error: 'NVIDIA API key is not configured on the server.' });
    }

    if (!isJsonRequest(req)) {
      return res.status(415).json({ error: 'Request body must be JSON.' });
    }

    const validationError = validateTtsPayload(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const releaseProviderSlot = acquireProviderSlot(req, res);
    if (!releaseProviderSlot) return undefined;
    const providerAbort = createProviderAbort(res, providerTimeoutMs);

    try {
      const formData = new FormData();
      formData.append('text', req.body.text);
      formData.append('language', 'en-US');
      formData.append('voice', NVIDIA_TTS_VOICE);
      formData.append('encoding', 'LINEAR_PCM');
      formData.append('sample_rate_hz', '44100');

      const ttsRes = await fetchImpl(NVIDIA_TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: providerAbort.signal,
      });

      if (!ttsRes.ok) {
        return sendProviderError(res, 'NVIDIA TTS', ttsRes.status);
      }

      const contentType = ttsRes.headers.get('content-type') || '';
      if (!contentType.includes('audio/wav')) {
        return res.status(502).json({ error: 'NVIDIA TTS returned an unexpected response format.' });
      }

      res.setHeader('Content-Type', 'audio/wav');
      await writeUpstreamBody(ttsRes.body, res);
      return res.end();
    } catch (err) {
      return sendProviderFailure(res, logger, '/tts', 'NVIDIA TTS', err);
    } finally {
      providerAbort.cleanup();
      releaseProviderSlot();
    }
  });

  if (options.serveStatic !== false) {
    addStaticServing(app, logger);
  }

  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    logger.error('[SERVER] Request failed:', err.message);
    return res.status(500).json({ error: 'Server request failed.' });
  });

  return app;
}

export function start(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const port = Number(env.PORT || env.PROXY_PORT || DEFAULT_PORT);
  const host = options.host || '0.0.0.0';
  const app = options.app || createApp({ ...options, env, logger });

  return app.listen(port, host, (error) => {
    if (error) {
      logger.error('[SERVER] Failed to start:', error.message);
      throw error;
    }
    logger.log(`[SERVER] Proxy server running on http://localhost:${port}`);
    logger.log('[SERVER] Environment loaded:', {
      hasNvidiaKey: Boolean(getKey(env, 'NVIDIA_API_KEY')),
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start();
}
