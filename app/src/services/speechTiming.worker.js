import { SpeechTiming } from './speechTiming.js';

// Alignment runs after audio arrives and never blocks either playback startup
// or the render thread. The caller discards results from cancelled phrases.
globalThis.onmessage = ({ data }) => {
  const timing = new SpeechTiming(data.sampleRate);
  timing.frames = data.frames;
  timing.samples = data.samples;
  timing.peak = data.peak;
  globalThis.postMessage({ id: data.id, generation: data.generation, timeline: timing.align(data.timeline) });
};
