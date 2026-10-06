// Coarse acoustic timing, not a speech recognizer: duration priors retain sound
// order while energy/noise evidence adjusts nearby boundaries and real pauses.
export class SpeechTiming {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.frameSamples = Math.max(1, Math.round(sampleRate * 0.01));
    this.frames = [];
    this.samples = 0;
    this.count = 0;
    this.energy = 0;
    this.crossings = 0;
    this.previous = 0;
    this.peak = 0;
  }

  get duration() { return this.samples / this.sampleRate; }

  append(samples) {
    for (const value of samples) {
      this.energy += value * value;
      if ((value >= 0) !== (this.previous >= 0)) this.crossings++;
      this.previous = value;
      this.samples++;
      if (++this.count === this.frameSamples) this._flush();
    }
  }

  _flush() {
    if (!this.count) return;
    const rms = Math.sqrt(this.energy / this.count);
    this.frames.push({ start: (this.samples - this.count) / this.sampleRate,
      end: this.duration, rms, crossings: this.crossings * this.sampleRate / this.count });
    this.peak = Math.max(this.peak, rms);
    this.count = this.energy = this.crossings = 0;
  }

  finish() { this._flush(); }

  rmsAt(seconds) {
    if (seconds < 0 || seconds >= this.duration) return 0;
    return this.frames[Math.floor(seconds * this.sampleRate / this.frameSamples)]?.rms || 0;
  }

  align(timeline) {
    const frames = this.frames;
    if (!timeline.length || timeline.length > 600 || frames.length > 10000 || this.peak < 0.003) return [];
    if (timeline.some((unit) => !unit.viseme || !Number.isFinite(unit.startFrac) || !Number.isFinite(unit.endFrac) || unit.endFrac <= unit.startFrac)) return [];
    const threshold = Math.max(0.0025, Math.min(0.015, this.peak * 0.08));
    const audible = (frame) => frame.rms >= threshold || (frame.crossings > 2400 && frame.rms >= Math.max(0.001, threshold * 0.25));
    const voicedStart = frames.findIndex(audible);
    let voicedEnd = frames.length - 1;
    while (voicedEnd > voicedStart && !audible(frames[voicedEnd])) voicedEnd--;
    if (voicedStart < 0) return [];
    const padding = Math.max(1, Math.round(this.sampleRate * 0.025 / this.frameSamples));
    const first = Math.max(0, voicedStart - padding);
    const last = Math.min(frames.length, voicedEnd + 1 + padding);
    const count = last - first;
    if (count < timeline.length) return [];
    const radius = Math.max(6, Math.min(32, Math.round(count * 0.12)));
    let previous = new Float64Array(count + 1).fill(Infinity);
    previous[0] = 0;
    const paths = [];

    for (let index = 0; index < timeline.length; index++) {
      const unit = timeline[index];
      const pause = unit.viseme === 'viseme_sil';
      const duration = Math.max(1, (unit.endFrac - unit.startFrac) * count);
      const expectedEnd = Math.round(unit.endFrac * count);
      const prefix = new Float64Array(count + 1);
      for (let frame = 0; frame < count; frame++) {
        const features = frames[first + frame];
        const quiet = !audible(features);
        const noisy = features.crossings > 2400;
        let cost;
        if (pause) cost = quiet ? 0 : 2.5;
        else if (unit.phoneme === 'P' || unit.phoneme === 'B') cost = quiet ? 0 : noisy ? 0.6 : 1.1;
        else if (['viseme_FF', 'viseme_SS', 'viseme_CH', 'viseme_TH'].includes(unit.viseme)) cost = quiet ? 2 : noisy ? 0 : 0.7;
        else if (['viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U'].includes(unit.viseme)) cost = quiet ? 3 : noisy ? 1.2 : 0;
        else cost = quiet ? 0.8 : noisy ? 0.7 : 0.1;
        prefix[frame + 1] = prefix[frame] + cost;
      }
      const next = new Float64Array(count + 1).fill(Infinity);
      const path = new Int32Array(count + 1).fill(-1);
      const lower = index === timeline.length - 1 ? count : Math.max(index + 1, expectedEnd - radius);
      const upper = index === timeline.length - 1 ? count : Math.min(count, expectedEnd + radius);
      const maxDuration = Math.min(count, Math.ceil(duration * 3 + 8));
      for (let end = lower; end <= upper; end++) {
        for (let start = Math.max(0, end - maxDuration); start <= end - (pause ? 0 : 1); start++) {
          if (!Number.isFinite(previous[start])) continue;
          const durationCost = 0.45 * (end - start - duration) ** 2 / (duration + 2);
          const driftCost = 0.3 * ((end - expectedEnd) / radius) ** 2;
          const cost = previous[start] + prefix[end] - prefix[start] + durationCost + driftCost;
          if (cost < next[end]) { next[end] = cost; path[end] = start; }
        }
      }
      paths.push(path);
      previous = next;
    }
    if (!Number.isFinite(previous[count])) return [];
    const result = [];
    let end = count;
    for (let index = timeline.length - 1; index >= 0; index--) {
      const start = paths[index][end];
      if (start < 0) return [];
      if (end > start) result.push({ ...timeline[index], start: frames[first + start].start, end: frames[first + end - 1].end });
      end = start;
    }
    return result.reverse();
  }
}
