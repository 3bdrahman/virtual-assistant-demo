/**
 * NIM API client — talks to our local proxy server.
 * Handles NVIDIA transcription, streaming chat, and speech synthesis.
 */

import { toTranscriptionWav } from './wav.js';

const API_BASE = '/api';

// ── STT: Send recorded audio, get transcript ──────────────────
export async function transcribe(audioBlob) {
  const wavBlob = await toTranscriptionWav(audioBlob);
  let res;
  try {
    res = await fetch(`${API_BASE}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBlob,
    });
  } catch {
    throw new Error('Failed to connect to the server.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Transcription failed');
  }

  const data = await res.json();
  return data.text || '';
}

// ── LLM: Stream chat completion ────────────────────────────────
export async function streamChat(messages, { onToken } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
  } catch {
    throw new Error('Failed to connect to the server.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Chat failed');
  }

  if (!res.body) throw new Error('AI response had no stream.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let sseBuffer = '';
  let completed = false;

  const processText = (textChunk) => {
    fullText += textChunk;
    onToken?.(textChunk, fullText);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') {
          completed = true;
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) throw new Error(parsed.error.message || 'AI provider error.');
          const delta = parsed.choices?.[0]?.delta;
          const token = delta?.content || '';
          if (token) {
            processText(token);
          }
        } catch (error) {
          throw new Error(`Invalid AI stream: ${error.message}`);
        }
      }
    }

    if (sseBuffer.trim().startsWith('data: ')) {
      const data = sseBuffer.trim().slice(6).trim();
      if (data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) throw new Error(parsed.error.message || 'AI provider error.');
          const token = parsed.choices?.[0]?.delta?.content || '';
          if (token) {
            processText(token);
          }
        } catch (error) {
          throw new Error(`Invalid AI stream: ${error.message}`);
        }
      } else {
        completed = true;
      }
    }
  } catch (err) {
    throw new Error(`AI response was interrupted: ${err.message}`);
  }

  if (!completed) throw new Error('AI response was incomplete. Please try again.');

  return fullText;
}

// ── TTS: NVIDIA Magpie returns WAV audio ───────────────────────
export async function synthesize(text) {
  let res;
  try {
    res = await fetch(`${API_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

  } catch {
    throw new Error('Failed to connect to the speech server.');
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Speech synthesis failed.');
  }

  const audioBlob = await res.blob();
  if (!audioBlob.type.startsWith('audio/') || audioBlob.size === 0) {
    throw new Error('Speech server returned invalid audio.');
  }
  return audioBlob;
}

// ── Health check ──────────────────────────────────────────────
export async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return await res.json();
  } catch {
    return { ok: false, hasNvidiaKey: false };
  }
}
