const TRANSCRIPTION_SAMPLE_RATE = 16000;
const MAX_TRANSCRIPTION_AUDIO_SECONDS = 90;
const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
const AUDIO_CONVERSION_TIMEOUT_MS = 15_000;
const AUDIO_CONTEXT_CLOSE_TIMEOUT_MS = 1_000;

function createAbortError() {
  const error = new Error('Audio conversion was cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

async function withConversionDeadline(createPromise, { signal, message }) {
  throwIfAborted(signal);
  let timeoutId;
  let abortHandler;
  try {
    const promise = createPromise();
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), AUDIO_CONVERSION_TIMEOUT_MS);
        if (signal) {
          abortHandler = () => reject(createAbortError());
          signal.addEventListener('abort', abortHandler, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

async function closeContextWithDeadline(context) {
  if (typeof context.close !== 'function') return;
  let timeoutId;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Audio context cleanup timed out.')), AUDIO_CONTEXT_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function encodeMonoPcm16(samples, sampleRate = TRANSCRIPTION_SAMPLE_RATE) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export async function toTranscriptionWav(recording, { signal } = {}) {
  throwIfAborted(signal);
  if (!recording || recording.size <= 0) {
    throw new Error('The recording did not contain audio.');
  }
  if (recording.size > MAX_RECORDING_BYTES) {
    throw new Error('The recording is too large to transcribe. Please try a shorter message.');
  }

  if (recording.type === 'audio/wav' && recording.size >= 44) {
    const header = new DataView(await recording.slice(0, 44).arrayBuffer());
    const hasText = (offset, value) => [...value].every((character, index) => header.getUint8(offset + index) === character.charCodeAt(0));
    if (hasText(0, 'RIFF') && hasText(8, 'WAVE') && hasText(12, 'fmt ') && hasText(36, 'data') &&
        header.getUint32(16, true) === 16 && header.getUint16(20, true) === 1 &&
        header.getUint16(22, true) === 1 && header.getUint32(24, true) === TRANSCRIPTION_SAMPLE_RATE &&
        header.getUint16(34, true) === 16 && header.getUint32(40, true) > 0 &&
        header.getUint32(40, true) <= recording.size - 44) {
      const dataBytes = header.getUint32(40, true);
      const durationSeconds = dataBytes / (TRANSCRIPTION_SAMPLE_RATE * 2);
      if (durationSeconds > MAX_TRANSCRIPTION_AUDIO_SECONDS) {
        throw new Error('The recording is too long to transcribe. Please try a shorter message.');
      }
      return recording;
    }
  }

  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OfflineAudioContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) {
    throw new Error('This browser cannot prepare microphone audio for transcription.');
  }

  const context = new AudioContextClass();
  try {
    const recordingBuffer = await recording.arrayBuffer();
    throwIfAborted(signal);
    const decoded = await withConversionDeadline(
      () => context.decodeAudioData(recordingBuffer),
      { signal, message: 'Audio decoding timed out. Please try again.' },
    );
    if (!decoded.duration) throw new Error('The recording did not contain audio.');
    if (decoded.duration > MAX_TRANSCRIPTION_AUDIO_SECONDS) {
      throw new Error('The recording is too long to transcribe. Please try a shorter message.');
    }
    const frameCount = Math.ceil(decoded.duration * TRANSCRIPTION_SAMPLE_RATE);
    const offline = new OfflineAudioContextClass(1, frameCount, TRANSCRIPTION_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await withConversionDeadline(
      () => offline.startRendering(),
      { signal, message: 'Audio conversion timed out. Please try again.' },
    );
    return encodeMonoPcm16(rendered.getChannelData(0));
  } finally {
    try {
      await closeContextWithDeadline(context);
    } catch {}
  }
}
