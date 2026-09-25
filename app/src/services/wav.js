const TRANSCRIPTION_SAMPLE_RATE = 16000;

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

export async function toTranscriptionWav(recording) {
  if (recording.type === 'audio/wav') return recording;

  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OfflineAudioContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) {
    throw new Error('This browser cannot prepare microphone audio for transcription.');
  }

  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    if (!decoded.duration) throw new Error('The recording did not contain audio.');
    const frameCount = Math.ceil(decoded.duration * TRANSCRIPTION_SAMPLE_RATE);
    const offline = new OfflineAudioContextClass(1, frameCount, TRANSCRIPTION_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeMonoPcm16(rendered.getChannelData(0));
  } finally {
    await context.close();
  }
}
