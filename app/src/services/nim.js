import { toTranscriptionWav } from './wav.js';

const API_BASE = (import.meta.env?.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');
export const REQUIRES_USER_KEY = import.meta.env?.VITE_REQUIRE_USER_KEY === 'true';
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REPLY_LENGTH = 8_000;
const MAX_EVENT_LENGTH = 64 * 1024;

export function apiRelayOrigin() {
  return new URL(API_BASE, globalThis.location?.href || 'http://localhost').origin;
}

function requestHeaders(contentType, apiKey) {
  const headers = { 'Content-Type': contentType };
  if (apiKey) {
    if (typeof apiKey !== 'string' || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey)) throw new Error('Enter a valid NVIDIA API key without spaces.');
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

// Keep the deadline active through response-body consumption, not just headers.
async function withDeadline({ signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}, operation) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('The request timed out. Please try again.', 'TimeoutError')), timeoutMs);
  try {
    controller.signal.throwIfAborted();
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function apiFetch(path, options) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, credentials: 'omit', redirect: 'error' });
  } catch (error) {
    options.signal.throwIfAborted();
    throw new Error('Failed to connect to the server.', { cause: error });
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new Error(typeof data?.error === 'string' ? data.error : `Request failed (${response.status}). Please try again.`);
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function transcribe(audioBlob, { apiKey, ...options } = {}) {
  return withDeadline(options, async (signal) => {
    const wavBlob = await toTranscriptionWav(audioBlob, { signal });
    signal.throwIfAborted();
    const response = await apiFetch('/stt', {
      method: 'POST', headers: requestHeaders('audio/wav', apiKey), body: wavBlob, signal,
    });
    const data = await response.json();
    if (typeof data?.text !== 'string' || data.text.length > MAX_REPLY_LENGTH) {
      throw new Error('Speech server returned an invalid transcript. Please try again.');
    }
    return data.text;
  });
}

export async function streamChat(messages, { onToken, apiKey, ...options } = {}) {
  return withDeadline({ ...options, timeoutMs: options.timeoutMs ?? 75_000 }, async (signal) => {
    const response = await apiFetch('/chat', {
      method: 'POST', headers: requestHeaders('application/json', apiKey),
      body: JSON.stringify({ messages }), signal,
    });
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
      throw new Error('AI server returned an invalid stream.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let eventData = [];
    let eventLength = 0;
    let completed = false;
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });

    const dispatch = () => {
      if (!eventData.length || completed) return;
      const data = eventData.join('\n');
      eventData = [];
      eventLength = 0;
      if (data.trim() === '[DONE]') { completed = true; return; }
      let parsed;
      try { parsed = JSON.parse(data); }
      catch { throw new Error('Invalid AI stream data.'); }
      if (parsed?.error?.code === 'provider_timeout') throw new Error('The AI timed out. Please retry your message.');
      if (parsed?.error) throw new Error('The AI provider could not finish the reply. Please retry your message.');
      const token = parsed?.choices?.[0]?.delta?.content;
      if (token == null) return;
      if (typeof token !== 'string') throw new Error('Invalid AI stream text.');
      if (fullText.length + token.length > MAX_REPLY_LENGTH) throw new Error('The AI reply was too long. Please ask a shorter question.');
      fullText += token;
      if (token) onToken?.(token, fullText);
    };
    const line = (value) => {
      if (value === '') { dispatch(); return; }
      if (value === 'data' || value.startsWith('data:')) {
        const data = value === 'data' ? '' : value.slice(5).replace(/^ /, '');
        eventLength += data.length;
        if (eventLength > MAX_EVENT_LENGTH) throw new Error('Invalid AI stream: event too large.');
        eventData.push(data);
      }
    };
    const consume = (final = false) => {
      let match;
      while (!completed && (match = /\r\n|\r|\n/.exec(buffer))) {
        // A CR at a chunk boundary may be the first half of CRLF.
        if (!final && match[0] === '\r' && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (buffer.length > MAX_EVENT_LENGTH) throw new Error('Invalid AI stream: event too large.');
      if (final && !completed) { if (buffer) line(buffer); dispatch(); }
    };

    try {
      while (!completed) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        consume(done);
        if (done) break;
      }
      if (!completed) throw new Error('AI response was incomplete. Please try again.');
      return fullText;
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
      reader.releaseLock();
    }
  });
}

export async function synthesize(text, { apiKey, ...options } = {}) {
  return withDeadline(options, async (signal) => {
    const response = await apiFetch('/tts', {
      method: 'POST', headers: requestHeaders('application/json', apiKey),
      body: JSON.stringify({ text }), signal,
    });
    const blob = await response.blob();
    if (!blob.type.startsWith('audio/') || blob.size === 0) throw new Error('Speech server returned invalid audio.');
    return blob;
  });
}

export async function checkHealth(timeoutMs = 5000) {
  try {
    return await withDeadline({ timeoutMs }, async (signal) => {
      const response = await apiFetch('/health', { signal, cache: 'no-store' });
      const data = await response.json();
      return { ok: data?.ok === true, hasNvidiaKey: data?.hasNvidiaKey === true, ...(data?.requiresUserKey === true ? { requiresUserKey: true } : {}) };
    });
  } catch {
    return { ok: false, hasNvidiaKey: false };
  }
}
