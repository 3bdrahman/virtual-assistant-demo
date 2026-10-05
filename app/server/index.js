import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 3011;

const NIM_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_STT_URL = 'https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions';
const NVIDIA_TTS_URL = 'https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize';
const NVIDIA_TTS_STREAMING_URL = 'https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize_online';
const DEFAULT_CHAT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const NVIDIA_TTS_VOICE = 'Magpie-Multilingual.EN-US.Jason';
const MAX_JSON_BYTES = '1mb';
const MAX_PROVIDER_JSON_BYTES = 1024 * 1024;
const MAX_CHAT_MESSAGES = 25;
const MAX_CHAT_CONTENT_LENGTH = 8_000;
const MAX_STT_TEXT_LENGTH = MAX_CHAT_CONTENT_LENGTH;
const MAX_TTS_TEXT_LENGTH = 2_000;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_USER_API_KEY_LENGTH = 4096;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
const DEFAULT_STT_UPLOAD_TIMEOUT_MS = 45_000;
const VALID_ROLES = new Set(['system', 'user', 'assistant']);
const DEFAULT_PROVIDER_LIMITS = {
  windowMs: 60_000,
  maxRequests: 20,
  maxConcurrent: 2,
};

function getKey(env, name) {
  return String(env[name] || '').trim();
}

function isEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function isDisabled(value) {
  return String(value || '').trim().toLowerCase() === 'false';
}

function requiresUserKey(env) {
  return isEnabled(env.REQUIRE_USER_KEY);
}

function publicHealth(env) {
  const userKeyRequired = requiresUserKey(env);
  const hasNvidiaKey = userKeyRequired ? false : Boolean(getKey(env, 'NVIDIA_API_KEY'));
  const health = {
    ok: true,
    hasNvidiaKey,
    services: {
      nvidia: { configured: hasNvidiaKey },
    },
  };
  if (userKeyRequired) {
    health.requiresUserKey = true;
  }
  return health;
}

function redactSecrets(message, secrets = []) {
  let redacted = String(message || '');
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[redacted]');
    }
  }
  return redacted.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function hasInvalidKeyCharacter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

function resolveProviderKey(req, res, env) {
  const authorization = req.get('authorization') || '';
  const userKeyRequired = requiresUserKey(env);
  if (authorization) {
    const match = authorization.match(/^Bearer (.+)$/);
    const key = match?.[1] || '';
    if (!match || key.length === 0 || key.length > MAX_USER_API_KEY_LENGTH || hasInvalidKeyCharacter(key)) {
      res.status(401).json({ error: 'Authorization header must be a valid Bearer token.' });
      return null;
    }
    return { apiKey: key, usesVisitorKey: true };
  }

  if (userKeyRequired) {
    res.status(401).json({ error: 'NVIDIA API key is required for this demo.' });
    return null;
  }

  const ownerKey = getKey(env, 'NVIDIA_API_KEY');
  if (!ownerKey) {
    res.status(503).json({ error: 'NVIDIA API key is not configured on the server.' });
    return null;
  }
  return {
    apiKey: ownerKey,
    usesVisitorKey: false,
  };
}

function sendProviderError(res, provider, providerStatus, { usesVisitorKey = false } = {}) {
  if (providerStatus === 401 || providerStatus === 403) {
    if (usesVisitorKey) {
      return res.status(401).json({
        error: `${provider} rejected the visitor key. Please check your key and try again.`,
        providerStatus,
      });
    }
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

function sendProviderFailure(res, logger, route, provider, error, { secrets = [] } = {}) {
  if (res.destroyed) return undefined;
  if (error.name === 'AbortError' && res.writableEnded) return undefined;
  logger.error(`[API ${route}] Provider request failed:`, redactSecrets(error.message, secrets));
  if (res.headersSent) {
    if (String(res.getHeader('Content-Type')).startsWith('text/event-stream')) {
      const code = error.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable';
      res.write(`data: ${JSON.stringify({ error: { code } })}\n\n`);
    }
    return res.end();
  }
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
      if (!controller.signal.aborted) {
        controller.abort(new DOMException('Provider request finished.', 'AbortError'));
      }
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
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return 'stream must be a boolean when provided.';
  }
  return null;
}

function isStreamingPcmContentType(contentType) {
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  return type === '' || type === 'application/octet-stream' || type === 'audio/pcm';
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
    if (!origin) {
      return next();
    }

    const allowed = allowedOrigins(env, req.get('host') || '');
    if (!allowed.has(origin)) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(403).json({ error: 'Cross-origin API requests are not allowed.' });
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      return res.status(204).end();
    }
    return next();
  };
}

function browserSecurityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self)');
  return next();
}

function createProviderGate(limits = {}) {
  const windowMs = Number(limits.windowMs || DEFAULT_PROVIDER_LIMITS.windowMs);
  const maxRequests = Number(limits.maxRequests || DEFAULT_PROVIDER_LIMITS.maxRequests);
  const maxConcurrent = Number(limits.maxConcurrent || DEFAULT_PROVIDER_LIMITS.maxConcurrent);
  const clients = new Map();
  const cleanup = (now = Date.now()) => {
    for (const [ip, record] of clients) {
      record.timestamps = record.timestamps.filter((timestamp) => now - timestamp < windowMs);
      if (record.active === 0 && record.timestamps.length === 0) {
        clients.delete(ip);
      }
    }
  };

  return function acquireProviderSlot(req, res) {
    const now = Date.now();
    cleanup(now);
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
      cleanup();
    };
  };
}

function isWavBuffer(audioBuffer) {
  if (audioBuffer.length < 44) return false;
  if (audioBuffer.subarray(0, 4).toString('ascii') !== 'RIFF') return false;
  if (audioBuffer.subarray(8, 12).toString('ascii') !== 'WAVE') return false;

  const riffSize = audioBuffer.readUInt32LE(4);
  if (riffSize + 8 !== audioBuffer.length) return false;

  let offset = 12;
  let hasPcmFormat = false;
  let hasNonEmptyData = false;
  let blockAlign = 0;

  while (offset + 8 <= audioBuffer.length) {
    const chunkId = audioBuffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = audioBuffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > audioBuffer.length) return false;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) return false;
      const audioFormat = audioBuffer.readUInt16LE(chunkStart);
      const channels = audioBuffer.readUInt16LE(chunkStart + 2);
      const sampleRate = audioBuffer.readUInt32LE(chunkStart + 4);
      const byteRate = audioBuffer.readUInt32LE(chunkStart + 8);
      blockAlign = audioBuffer.readUInt16LE(chunkStart + 12);
      const bitsPerSample = audioBuffer.readUInt16LE(chunkStart + 14);
      if (audioFormat !== 1) return false;
      if (channels < 1 || channels > 2) return false;
      if (sampleRate < 8_000 || sampleRate > 192_000) return false;
      if (![8, 16, 24, 32].includes(bitsPerSample)) return false;
      const expectedBlockAlign = channels * (bitsPerSample / 8);
      if (blockAlign !== expectedBlockAlign) return false;
      if (byteRate !== sampleRate * blockAlign) return false;
      hasPcmFormat = true;
    }

    if (chunkId === 'data') {
      if (!hasPcmFormat || chunkSize % blockAlign !== 0) return false;
      hasNonEmptyData = chunkSize > 0;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  return offset === audioBuffer.length && hasPcmFormat && hasNonEmptyData;
}

function isTooLargeContentLength(req, maxBytes) {
  const contentLength = req.get('content-length');
  if (contentLength === undefined) return false;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > maxBytes;
}

async function readRequestBody(req, maxBytes, { timeoutMs } = {}) {
  let timeout;
  let timedOut = false;
  const timeoutPromise = timeoutMs > 0
    ? new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        req.pause?.();
        const error = new Error('Request body timed out.');
        error.statusCode = 408;
        reject(error);
      }, timeoutMs);
    })
    : null;

  const readPromise = (async () => {
    const chunks = [];
    let total = 0;
    const iterator = typeof req.iterator === 'function' ? req.iterator({ destroyOnReturn: false }) : req;
    for await (const chunk of iterator) {
      if (timedOut) break;
      total += chunk.length;
      if (total > maxBytes) {
        req.resume();
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  })();

  try {
    return await (timeoutPromise ? Promise.race([readPromise, timeoutPromise]) : readPromise);
  } finally {
    clearTimeout(timeout);
  }
}

function abortableReaderRead(reader, signal) {
  signal?.throwIfAborted();
  if (!signal) return reader.read();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException('Provider request aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function writeChunk(res, chunk, signal) {
  signal?.throwIfAborted();
  if (res.destroyed || res.writableEnded) {
    const error = new DOMException('Client disconnected.', 'AbortError');
    throw error;
  }
  if (!res.write(chunk)) {
    try {
      await once(res, 'drain', { signal });
    } catch (err) {
      if (signal?.aborted && signal.reason) {
        throw signal.reason;
      }
      throw err;
    }
  }
  if (typeof res.flush === 'function') res.flush();
}

async function writeUpstreamBody(upstreamBody, res, { beforeFirstWrite, signal } = {}) {
  if (!upstreamBody) {
    return 0;
  }

  let bytesWritten = 0;
  const writeBodyChunk = async (chunk) => {
    if (bytesWritten === 0) beforeFirstWrite?.();
    bytesWritten += chunk.length;
    await writeChunk(res, chunk, signal);
  };

  if (typeof upstreamBody.getReader === 'function') {
    const reader = upstreamBody.getReader();
    try {
      while (true) {
        const { done, value } = await abortableReaderRead(reader, signal);
        if (done) break;
        const chunk = Buffer.from(value);
        await writeBodyChunk(chunk);
      }
    } finally {
      await reader.cancel?.().catch(() => {});
      reader.releaseLock?.();
    }
    return bytesWritten;
  }

  for await (const chunk of upstreamBody) {
    await writeBodyChunk(chunk);
  }
  return bytesWritten;
}

async function cancelProviderBody(upstreamBody) {
  if (!upstreamBody) return;
  if (typeof upstreamBody.getReader === 'function') {
    const reader = upstreamBody.getReader();
    try {
      await reader.cancel?.();
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  if (typeof upstreamBody.destroy === 'function') {
    upstreamBody.destroy();
  }
}

async function readUpstreamText(upstreamBody, { signal, maxBytes = MAX_PROVIDER_JSON_BYTES } = {}) {
  if (!upstreamBody) return '';
  const chunks = [];
  let total = 0;
  const pushChunk = (value) => {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Provider JSON response is too large.');
      error.statusCode = 502;
      throw error;
    }
    chunks.push(chunk);
  };

  if (typeof upstreamBody.getReader === 'function') {
    const reader = upstreamBody.getReader();
    try {
      while (true) {
        const { done, value } = await abortableReaderRead(reader, signal);
        if (done) break;
        pushChunk(value);
      }
    } finally {
      await reader.cancel?.().catch(() => {});
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  for await (const chunk of upstreamBody) {
    signal?.throwIfAborted();
    pushChunk(chunk);
  }
  signal?.throwIfAborted();
  return Buffer.concat(chunks).toString('utf8');
}

async function readProviderJson(res, provider, { signal } = {}) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    await cancelProviderBody(res.body);
    const error = new Error(`${provider} returned an unexpected response format.`);
    error.statusCode = 502;
    throw error;
  }
  try {
    signal?.throwIfAborted();
    return JSON.parse(await readUpstreamText(res.body, { signal }));
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason || err;
    }
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw err;
    }
    if (err.statusCode) {
      throw err;
    }
    const error = new Error(`${provider} returned invalid JSON.`);
    error.statusCode = 502;
    throw error;
  }
}

function validateSttResponse(data) {
  return data &&
    typeof data === 'object' &&
    typeof data.text === 'string' &&
    data.text.length <= MAX_STT_TEXT_LENGTH;
}

function addStaticServing(app, logger, staticDir) {
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = staticDir || path.resolve(serverDir, '../dist');
  const indexPath = path.join(distDir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    logger.warn('[SERVER] Production dist not found; API-only server mode.');
    return;
  }

  app.use(express.static(distDir));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (path.extname(req.path)) {
      return res.status(404).type('text/plain').send('Not found.');
    }
    return res.sendFile(indexPath);
  });
}

export function createApp(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const chatTimeoutMs = options.chatTimeoutMs ?? options.providerTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const sttUploadTimeoutMs = options.sttUploadTimeoutMs ?? DEFAULT_STT_UPLOAD_TIMEOUT_MS;
  const maxAudioBytes = options.maxAudioBytes ?? MAX_AUDIO_BYTES;
  const acquireProviderSlot = createProviderGate(options.providerLimits);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === 'true');
  app.use(browserSecurityHeaders);
  app.use(sameOriginGuard(env));
  app.use(express.json({ limit: MAX_JSON_BYTES }));

  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicHealth(env));
  });

  app.post('/api/stt', async (req, res) => {
    const providerAuth = resolveProviderKey(req, res, env);
    if (!providerAuth) return undefined;
    const { apiKey, usesVisitorKey } = providerAuth;

    const contentType = (req.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!['audio/wav', 'audio/wave', 'audio/x-wav'].includes(contentType)) {
      return res.status(415).json({ error: 'Audio upload must be WAV.' });
    }

    if (isTooLargeContentLength(req, maxAudioBytes)) {
      return res.status(413).json({ error: 'Audio upload is too large.' });
    }

    try {
      const audioBuffer = await readRequestBody(req, maxAudioBytes, { timeoutMs: sttUploadTimeoutMs });
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
          await cancelProviderBody(nimRes.body);
          return sendProviderError(res, 'NVIDIA STT', nimRes.status, { usesVisitorKey });
        }

        const data = await readProviderJson(nimRes, 'NVIDIA STT', { signal: providerAbort.signal });
        if (!validateSttResponse(data)) {
          return res.status(502).json({ error: 'NVIDIA STT returned an unexpected response format.' });
        }
        return res.json(data);
      } finally {
        providerAbort.cleanup();
        releaseProviderSlot();
      }
    } catch (err) {
      if (err.statusCode === 413) {
        return res.status(413).json({ error: 'Audio upload is too large.' });
      }
      if (err.statusCode === 408) {
        return res.status(408).json({ error: 'Audio upload timed out.' });
      }
      if (err.statusCode === 502) {
        return res.status(502).json({ error: err.message });
      }
      return sendProviderFailure(res, logger, '/stt', 'NVIDIA STT', err, { secrets: [apiKey] });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const providerAuth = resolveProviderKey(req, res, env);
    if (!providerAuth) return undefined;
    const { apiKey, usesVisitorKey } = providerAuth;

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
    const providerAbort = createProviderAbort(res, chatTimeoutMs);

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
        await cancelProviderBody(nimRes.body);
        return sendProviderError(res, 'NVIDIA chat', nimRes.status, { usesVisitorKey });
      }

      const contentType = nimRes.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('text/event-stream')) {
        await cancelProviderBody(nimRes.body);
        return res.status(502).json({ error: 'NVIDIA chat returned an unexpected response format.' });
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      await writeUpstreamBody(nimRes.body, res, { signal: providerAbort.signal });
      return res.end();
    } catch (err) {
      return sendProviderFailure(res, logger, '/chat', 'NVIDIA chat', err, { secrets: [apiKey] });
    } finally {
      providerAbort.cleanup();
      releaseProviderSlot();
    }
  });

  app.post('/api/tts', async (req, res) => {
    const providerAuth = resolveProviderKey(req, res, env);
    if (!providerAuth) return undefined;
    const { apiKey, usesVisitorKey } = providerAuth;

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

      const streamingAudio = req.body.stream === true;
      const ttsRes = await fetchImpl(streamingAudio ? NVIDIA_TTS_STREAMING_URL : NVIDIA_TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: providerAbort.signal,
      });

      if (!ttsRes.ok) {
        await cancelProviderBody(ttsRes.body);
        return sendProviderError(res, 'NVIDIA TTS', ttsRes.status, { usesVisitorKey });
      }

      const contentType = ttsRes.headers.get('content-type') || '';
      const validContentType = streamingAudio
        ? isStreamingPcmContentType(contentType)
        : contentType.toLowerCase().includes('audio/wav');
      if (!validContentType) {
        await cancelProviderBody(ttsRes.body);
        return res.status(502).json({ error: 'NVIDIA TTS returned an unexpected response format.' });
      }

      const bytesWritten = await writeUpstreamBody(ttsRes.body, res, {
        signal: providerAbort.signal,
        beforeFirstWrite: () => {
          if (streamingAudio) {
            res.setHeader('Content-Type', 'audio/pcm;rate=44100;channels=1');
            res.setHeader('Cache-Control', 'no-store,no-transform');
            res.setHeader('X-Accel-Buffering', 'no');
          } else {
            res.setHeader('Content-Type', 'audio/wav');
          }
        },
      });
      if (bytesWritten === 0 && !res.headersSent) {
        return res.status(502).json({ error: 'NVIDIA TTS returned empty audio.' });
      }
      return res.end();
    } catch (err) {
      if (res.headersSent && !res.destroyed) {
        logger.error('[API /tts] Provider request failed:', redactSecrets(err.message, [apiKey]));
        res.destroy(err);
        return undefined;
      }
      return sendProviderFailure(res, logger, '/tts', 'NVIDIA TTS', err, { secrets: [apiKey] });
    } finally {
      providerAbort.cleanup();
      releaseProviderSlot();
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  if (options.serveStatic !== false && !isDisabled(env.SERVE_STATIC)) {
    addStaticServing(app, logger, options.staticDir);
  }

  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (err.type === 'charset.unsupported') {
      return res.status(415).json({ error: 'Request body charset is not supported.' });
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

function attachGracefulShutdown(server, logger) {
  let shuttingDown = false;
  let forceCloseTimer;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[SERVER] Received ${signal}; shutting down.`);
    forceCloseTimer = setTimeout(() => server.closeAllConnections(), DEFAULT_CHAT_TIMEOUT_MS + 1000);
    forceCloseTimer.unref();
    server.close((error) => {
      clearTimeout(forceCloseTimer);
      if (error) {
        logger.error('[SERVER] Shutdown failed:', error.message);
        process.exitCode = 1;
      }
    });
  };

  const onInterrupt = () => shutdown('SIGINT');
  const onTerminate = () => shutdown('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  server.once?.('close', () => {
    clearTimeout(forceCloseTimer);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  attachGracefulShutdown(start(), console);
}
