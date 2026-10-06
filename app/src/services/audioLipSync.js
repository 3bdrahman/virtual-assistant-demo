/**
 * Streamed audio playback with pronunciation-driven, acoustically retimed lips.
 *
 * PCM poses follow the device output clock. Browser speech uses word boundary
 * events when available; pronunciation inside each word remains an estimate.
 */

import { SpringDamper } from '../utils/springDamper.js';
import { VISEMES, buildVisemeTimeline } from './visemePronunciation.js';
import { SpeechTiming } from './speechTiming.js';
import { articulationTargets } from './visemeArticulation.js';

const ALL_VISEME_KEYS = Object.values(VISEMES);
const PLAYBACK_DECODE_TIMEOUT_MS = 15_000;
const MAX_DECODE_AHEAD = 2;
const MALE_VOICE_NAME_PATTERN = /\bmale\b/i;

export class AudioLipSync {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.queue = [];
    this.isPlaying = false;
    this.currentSource = null;
    this.currentViseme = VISEMES.sil;
    this.currentIntensity = 0;

    this.visemeWeights = {};
    for (const v of ALL_VISEME_KEYS) this.visemeWeights[v] = 0;
    this.visemeWeights[VISEMES.sil] = 1;

    this.onIdle = null;
    this.onPlaybackStart = null;
    this.onPlaybackError = null;
    this.onSpeechError = null;
    this.onQueueChange = null;
    this._animFrame = null;
    this._waveformData = null;
    this._ownsAudioContext = false;

    this._audioStartCtxTime = 0;

    // Spring dampers for each viseme
    this.visemeDampers = new Map();
    for (const v of ALL_VISEME_KEYS) {
      this.visemeDampers.set(v, new SpringDamper(0, 0.005, v));
    }

    // Browser speech state and shared text timeline
    this._fallbackRAF = null;
    this._fallbackProgress = 0;
    this._textTimeline = null;
    this._fallbackLastClock = 0;
    this._speechGeneration = 0;
    this._playbackGeneration = 0;
    this._activeUtterance = null;
    this._speechTimeout = null;
    this._playbackDecodeTimeout = null;
    this._rejectPlaybackDecode = null;
    this._queuePumpPromise = null;
    this._nextQueueId = 1;
    this._activeAudioItem = null;
    this._scheduleCursor = 0;
    this._dispatchingPlaybackError = false;
    this._resumePromise = null;
    this._timingWorker = null;
    this._timingWorkerFailed = false;

  }

  get pendingCount() {
    return this.queue.length;
  }

  init() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      this._ownsAudioContext = true;
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.4;
      this._waveformData = new Float32Array(this.analyser.fftSize);
    }
  }

  prepare() {
    this.init();
    return this.audioContext.state === 'suspended'
      ? this.audioContext.resume()
      : Promise.resolve();
  }


  /**
   * Build an estimated viseme timeline from text using weighted durations.
   */
  _buildTextTimeline(text) {
    return buildVisemeTimeline(text);
  }

  enqueue(audioBlob, sentenceText = '') {
    this.init();
    this.queue.push(this._createQueueItem('audio', { blob: audioBlob, text: sentenceText }));
    this._notifyQueueChange();
    this._requestQueuePump();
  }

  enqueueText(text) {
    return this._enqueueTextItem(text, false);
  }

  beginPcm(text = '', { speechId = null, sampleRate = 44100 } = {}) {
    this.init();
    const item = this._createQueueItem('pcm', { text });
    item.speechId = speechId || `pcm-${item.id}`;
    item.sampleRate = sampleRate;
    item.chunks = [];
    item.final = false;
    item.scheduledDuration = 0;
    item.receivedDuration = 0;
    item.textTimeline = this._buildTextTimeline(text);
    item.estimatedDuration = Math.max(item.textTimeline.reduce((sum, unit) => sum + (unit.weight || 1), 0) * 0.085, 0.3);
    item.timing = new SpeechTiming(sampleRate);
    item.progress = 0;
    item.startTime = null;
    item.endedDuration = 0;
    item.started = false;
    item.audible = false;
    this.queue.push(item);
    this._notifyQueueChange();
    this._requestQueuePump();
    return item.speechId;
  }

  enqueuePcm(samples, text = '', { speechId = null, sampleRate = 44100, final = false } = {}) {
    const id = speechId || this.beginPcm(text, { sampleRate });
    const group = this.queue.find((candidate) => candidate.kind === 'pcm' && candidate.speechId === id);
    // Late chunks must not recreate a cancelled or failed phrase.
    if (!group || group.final) return false;
    if (text && !group.text) group.text = text;

    group.timing.append(samples);
    const buffer = this._createPcmAudioBuffer(samples, group.sampleRate);
    group.chunks.push({
      buffer,
      duration: buffer.duration,
      offset: group.receivedDuration,
      source: null,
      startTime: 0,
      startTimer: null,
      ended: false,
      scheduled: false,
    });
    group.receivedDuration += buffer.duration;
    if (final) { group.final = true; this._alignSpeech(group); }
    this._requestQueuePump();
    return group.speechId;
  }

  finishPcm(speechId) {
    const item = this.queue.find((candidate) => candidate.kind === 'pcm' && candidate.speechId === speechId);
    if (!item) return false;
    item.final = true;
    this._alignSpeech(item);
    if (item.chunks.every((chunk) => chunk.ended)) {
      if (this._activeAudioItem === item) this._activeAudioItem = null;
      if (this.currentSource && item.chunks.some((chunk) => chunk.source === this.currentSource)) {
        this.currentSource = null;
      }
      this._removeQueueItem(item);
      this._requestQueuePump();
      this._settleIdleIfEmpty();
      return true;
    }
    this._requestQueuePump();
    return true;
  }

  _createPcmAudioBuffer(samples, sampleRate) {
    const audioBuffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
    audioBuffer.getChannelData(0).set(samples);
    return audioBuffer;
  }

  _createQueueItem(kind, { blob = null, text = '', voice = null } = {}) {
    return {
      id: this._nextQueueId++,
      kind,
      blob,
      text: text || '',
      voice,
      state: 'queued',
      audioBuffer: null,
      source: null,
      startTime: 0,
      duration: 0,
      startTimer: null,
      decodeTimeout: null,
      decodeReject: null,
      generation: this._playbackGeneration,
      playbackStarted: false,
    };
  }

  _notifyQueueChange() {
    this.onQueueChange?.(this.pendingCount);
  }

  _requestQueuePump() {
    if (this._queuePumpPromise) return;
    const generation = this._playbackGeneration;
    this._queuePumpPromise = Promise.resolve().then(() => {
      this._queuePumpPromise = null;
      if (generation !== this._playbackGeneration) return;
      this._pumpQueue();
    });
  }

  _removeQueueItem(item) {
    const index = this.queue.indexOf(item);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this._notifyQueueChange();
    return true;
  }

  _outputTime() {
    const context = this.audioContext;
    if (!context) return 0;
    const stamp = context.getOutputTimestamp?.();
    if (stamp && stamp.performanceTime > 0 && Number.isFinite(stamp.contextTime)) {
      const elapsed = (performance.now() - stamp.performanceTime) / 1000;
      if (elapsed >= 0 && elapsed < 0.25) return Math.min(context.currentTime, Math.max(0, stamp.contextTime + elapsed));
    }
    return Math.max(0, context.currentTime - (context.baseLatency || 0) - (context.outputLatency || 0));
  }

  _alignSpeech(item) {
    item.timing?.finish();
    if (!item.timing || this._timingWorkerFailed || typeof Worker !== 'function') return;
    try {
      if (!this._timingWorker) {
        this._timingWorker = new Worker(new URL('./speechTiming.worker.js', import.meta.url), { type: 'module' });
        this._timingWorker.onmessage = ({ data }) => {
          if (data.generation !== this._playbackGeneration) return;
          const phrase = this.queue.find((candidate) => candidate.id === data.id);
          if (phrase && data.timeline.length) phrase.alignedTimeline = data.timeline;
        };
        this._timingWorker.onerror = (event) => {
          event.preventDefault?.();
          console.warn('Speech timing worker unavailable; using estimated pronunciation timing.');
          this._timingWorkerFailed = true;
          this._timingWorker?.terminate();
          this._timingWorker = null;
        };
      }
      this._timingWorker.postMessage({ id: item.id, generation: this._playbackGeneration,
        sampleRate: item.timing.sampleRate, frames: item.timing.frames,
        samples: item.timing.samples, peak: item.timing.peak, timeline: item.textTimeline });
    } catch (error) {
      console.warn('Speech timing unavailable; using estimated pronunciation timing.', error);
      this._timingWorkerFailed = true;
      this._timingWorker?.terminate();
      this._timingWorker = null;
    }
  }

  _poseTimeline(item, duration) {
    if (item?.alignedTimeline) return item.alignedTimeline;
    const source = item?.textTimeline || this._textTimeline || [];
    if (item?.poseDuration === duration) return item.poseTimeline;
    const timeline = source.map((unit) => ({ ...unit, start: unit.startFrac * duration, end: unit.endFrac * duration }));
    if (item) { item.poseDuration = duration; item.poseTimeline = timeline; }
    return timeline;
  }

  _updateArticulation(timeline, seconds, rms, dt) {
    const frame = articulationTargets(timeline, seconds, rms);
    this.currentViseme = frame.viseme;
    this.currentIntensity = frame.intensity;
    const closing = (frame.weights.viseme_PP || 0) > 0.5;
    for (const viseme of ALL_VISEME_KEYS) {
      const target = frame.weights[viseme] || 0;
      const current = this.visemeWeights[viseme] || 0;
      const consonant = ['viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD', 'viseme_CH', 'viseme_SS'].includes(viseme);
      const tau = closing ? (viseme === VISEMES.PP ? 0.018 : 0.015)
        : target > current ? (consonant ? 0.028 : 0.045) : 0.055;
      const damper = this.visemeDampers.get(viseme);
      damper.updateParameters(tau, tau);
      this.visemeWeights[viseme] = Math.max(0, Math.min(1, damper.update(target, dt)));
    }
    const total = ALL_VISEME_KEYS.reduce((sum, key) => sum + (key === VISEMES.sil ? 0 : this.visemeWeights[key]), 0);
    if (total > 1) for (const key of ALL_VISEME_KEYS) if (key !== VISEMES.sil) this.visemeWeights[key] /= total;
  }

  _analyzeFrame() {
    if (!this.analyser) return;
    const now = performance.now() / 1000;
    const dt = this._lastFrameClock ? Math.min(Math.max(now - this._lastFrameClock, 0), 0.1) : 0.016;
    this._lastFrameClock = now;
    const item = this._activeAudioItem;
    const seconds = item?.kind === 'pcm' ? this._pcmTime(item) : this._outputTime() - this._audioStartCtxTime;
    if (item?.kind === 'pcm') this._pcmProgress(item);
    let rms = 0;
    if (item?.timing) {
      // Reading the received samples at the output position avoids the analyser
      // window's additional lag and the browser's render-ahead audio clock.
      rms = item.timing.rmsAt(seconds);
    } else if (this._waveformData) {
      this.analyser.getFloatTimeDomainData(this._waveformData);
      let energy = 0;
      for (const sample of this._waveformData) energy += sample * sample;
      rms = Math.sqrt(energy / this._waveformData.length);
    }
    this._updateArticulation(this._poseTimeline(item, this._playbackDuration || 1), seconds, rms, dt);
  }

  _pumpQueue() {
    if (this.queue.length === 0) {
      this._settleIdleIfEmpty();
      return;
    }

    this.isPlaying = true;
    if (this.audioContext?.state === 'suspended' && this.queue.some((item) => item.kind === 'pcm' && item.chunks.length)) {
      if (!this._resumePromise) {
        const generation = this._playbackGeneration;
        const pending = this._ensureAudioOutputReady(generation).then(() => {
          if (this.audioContext?.state === 'suspended') throw new Error('Audio output did not start.');
        }).catch((error) => {
          if (generation !== this._playbackGeneration) return;
          for (const item of [...this.queue]) {
            if (item.kind === 'pcm') this._handlePlaybackItemError(item, error);
          }
        }).finally(() => {
          if (this._resumePromise !== pending) return;
          this._resumePromise = null;
          this._requestQueuePump();
        });
        this._resumePromise = pending;
      }
      return;
    }
    this._startQueuedDecodes();
    this._scheduleReadyAudio();
    this._scheduleReadyPcm();
    this._startQueuedTextIfReady();
  }

  _startQueuedDecodes() {
    let activeDecodeWindow = 0;
    for (const item of this.queue) {
      if (item.kind !== 'audio') continue;
      if (item.state === 'decoding' || item.state === 'ready' || item.state === 'scheduled' || item.state === 'playing') {
        activeDecodeWindow++;
      }
    }

    for (const item of this.queue) {
      if (activeDecodeWindow >= MAX_DECODE_AHEAD) return;
      if (item.kind !== 'audio' || item.state !== 'queued') continue;
      item.state = 'decoding';
      item.generation = this._playbackGeneration;
      activeDecodeWindow++;
      this._decodeQueuedAudio(item);
    }
  }

  async _ensureAudioOutputReady(generation) {
    if (this.audioContext?.state !== 'suspended') return;
    let timer;
    try {
      await Promise.race([
        this.audioContext.resume(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Audio output did not start.')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (generation !== this._playbackGeneration) throw new Error('Audio playback was cancelled.');
  }

  _decodeAudioBufferForItem(arrayBuffer, item) {
    const decodePromise = this.audioContext.decodeAudioData(arrayBuffer);
    let timeoutId = null;
    const deadline = new Promise((_, reject) => {
      item.decodeReject = reject;
      timeoutId = setTimeout(() => {
        item.decodeTimeout = null;
        item.decodeReject = null;
        reject(new Error('Audio playback decoding timed out.'));
      }, PLAYBACK_DECODE_TIMEOUT_MS);
      item.decodeTimeout = timeoutId;
      this._rejectPlaybackDecode = reject;
      this._playbackDecodeTimeout = timeoutId;
    });

    return Promise.race([decodePromise, deadline]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
      if (this._playbackDecodeTimeout === timeoutId) {
        this._playbackDecodeTimeout = null;
        this._rejectPlaybackDecode = null;
      }
      item.decodeTimeout = null;
      item.decodeReject = null;
    });
  }

  async _decodeQueuedAudio(item) {
    const generation = item.generation;
    try {
      await this._ensureAudioOutputReady(generation);
      if (generation !== this._playbackGeneration || !this.queue.includes(item)) return;

      const arrayBuffer = await item.blob.arrayBuffer();
      if (generation !== this._playbackGeneration || !this.queue.includes(item)) return;

      const audioBuffer = await this._decodeAudioBufferForItem(arrayBuffer, item);
      if (generation !== this._playbackGeneration || !this.queue.includes(item)) return;

      item.audioBuffer = audioBuffer;
      item.duration = audioBuffer.duration || 1;
      item.state = 'ready';
      this._requestQueuePump();
    } catch (err) {
      if (generation !== this._playbackGeneration || !this.queue.includes(item)) return;
      this._handlePlaybackItemError(item, err);
    }
  }

  _scheduleReadyAudio() {
    if (!this.audioContext || !this.analyser) return;

    let cursor = this._scheduleCursor || 0;
    for (const item of this.queue) {
      if (item.kind === 'text' || item.kind === 'pcm') break;
      if (item.kind !== 'audio') continue;
      if (item.state === 'queued' || item.state === 'decoding') break;
      if (item.state === 'scheduled' || item.state === 'playing') {
        cursor = Math.max(cursor, item.startTime + item.duration);
        continue;
      }
      if (item.state !== 'ready') break;

      const source = this.audioContext.createBufferSource();
      source.buffer = item.audioBuffer;
      source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      item.source = source;
      item.state = 'scheduled';

      const startTime = Math.max(this.audioContext.currentTime, cursor || this.audioContext.currentTime);
      item.startTime = startTime;
      cursor = startTime + item.duration;
      this._scheduleCursor = cursor;

      source.onended = () => this._finishAudioItem(item, source);
      source.start(startTime);

      if (this.queue[0] === item) {
        this._markAudioItemStarted(item);
      } else {
        const delayMs = Math.max((startTime - this.audioContext.currentTime) * 1000, 0);
        item.startTimer = setTimeout(() => {
          item.startTimer = null;
          if (this.queue[0] === item) this._markAudioItemStarted(item);
        }, delayMs);
      }
    }
  }

  _scheduleReadyPcm() {
    if (!this.audioContext || !this.analyser) return;
    for (const item of this.queue) {
      if (item.kind !== 'pcm') break;
      for (const chunk of item.chunks) {
        if (chunk.scheduled) continue;
        const source = this.audioContext.createBufferSource();
        source.buffer = chunk.buffer;
        source.connect(this.analyser);
        this.analyser.connect(this.audioContext.destination);

        const startTime = Math.max(this.audioContext.currentTime, this._scheduleCursor || this.audioContext.currentTime);
        chunk.source = source;
        chunk.startTime = startTime;
        chunk.scheduled = true;
        item.scheduledDuration += chunk.duration;
        this._scheduleCursor = startTime + chunk.duration;
        if (item.startTime === null) item.startTime = startTime;
        item.duration = item.scheduledDuration;

        source.onended = () => this._finishPcmChunk(item, chunk, source);
        source.start(startTime);

        if (!item.audible && this.queue[0] === item) {
          this._markPcmGroupStarted(item, chunk);
        } else {
          const delayMs = Math.max((startTime - this.audioContext.currentTime) * 1000, 0);
          chunk.startTimer = setTimeout(() => {
            chunk.startTimer = null;
            if (!this.queue.includes(item)) return;
            if (!item.audible) this._markPcmGroupStarted(item, chunk);
            else if (this._activeAudioItem === item) this.currentSource = source;
          }, delayMs);
        }
      }
      // Until EOF this phrase may still receive more audio. Its successor
      // cannot claim an audio-clock position yet.
      if (!item.final) break;
    }
  }

  _pcmTime(item) {
    const audibleTime = this._outputTime();
    let elapsed = 0;
    for (const chunk of item.chunks) {
      if (chunk.scheduled && audibleTime >= chunk.startTime) {
        elapsed = Math.max(elapsed, chunk.offset + Math.min(audibleTime - chunk.startTime, chunk.duration));
      }
    }
    return elapsed;
  }

  _pcmProgress(item) {
    const elapsed = this._pcmTime(item);
    this._playbackDuration = item.final ? item.receivedDuration : Math.max(item.estimatedDuration, elapsed + 0.3);
    item.progress = Math.min(Math.max(item.progress, elapsed / Math.max(this._playbackDuration, 0.1)), item.final ? 1 : 0.97);
    return item.progress;
  }

  _markPcmGroupStarted(item, chunk) {
    if (!this.queue.includes(item) || item.kind !== 'pcm') return;
    item.started = true;
    item.audible = true;
    item.state = 'playing';
    this._activeAudioItem = item;
    this.currentSource = chunk.source;
    item.textTimeline ||= this._buildTextTimeline(item.text);
    this._textTimeline = item.textTimeline;
    this._playbackDuration = item.final ? item.receivedDuration : item.estimatedDuration;
    this._lastFrameClock = 0;

    this._audioStartCtxTime = item.startTime;

    this.onPlaybackStart?.(item.text);
    this._ensureAudioAnalysisLoop();
  }

  _finishPcmChunk(item, chunk, source) {
    if (!this.queue.includes(item) || chunk.source !== source || chunk.ended) return;
    chunk.ended = true;
    if (chunk.startTimer) {
      clearTimeout(chunk.startTimer);
      chunk.startTimer = null;
    }
    try { source.disconnect(); } catch {}
    item.endedDuration += chunk.duration;

    const nextChunk = item.chunks.find((candidate) => candidate.scheduled && !candidate.ended);
    if (nextChunk) {
      this.currentSource = nextChunk.source;
      return;
    }

    if (item.final) {
      if (this._activeAudioItem === item) {
        this._activeAudioItem = null;
        this.currentSource = null;
      }
      item.audible = false;
      this._removeQueueItem(item);
      const next = this.queue[0];
      const nextChunk = next?.kind === 'pcm' && next.chunks.find((candidate) => candidate.scheduled && !candidate.ended);
      if (nextChunk && !next.audible) this._markPcmGroupStarted(next, nextChunk);
      this._requestQueuePump();
      this._settleIdleIfEmpty();
      return;
    }

    item.audible = false;
    this._activeAudioItem = null;
    this.currentSource = null;
    this.isPlaying = false;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._animFrame);
    this._animFrame = null;
    this._resetVisemes();
    this.onIdle?.();
  }

  _markAudioItemStarted(item) {
    if (!this.queue.includes(item) || item.kind !== 'audio') return;
    item.state = 'playing';
    this._activeAudioItem = item;
    this.currentSource = item.source;
    item.textTimeline ||= this._buildTextTimeline(item.text);
    this._textTimeline = item.textTimeline;
    this._playbackDuration = item.duration || 1;
    this._lastFrameClock = 0;

    this._audioStartCtxTime = item.startTime;

    if (!item.playbackStarted) {
      item.playbackStarted = true;
      this.onPlaybackStart?.(item.text);
    }
    this._ensureAudioAnalysisLoop();
  }

  _ensureAudioAnalysisLoop() {
    if (this._animFrame) return;
    const analyze = () => {
      this._analyzeFrame();
      if (this.isPlaying && this._activeAudioItem) {
        this._animFrame = requestAnimationFrame(analyze);
      } else {
        this._animFrame = null;
      }
    };
    analyze();
  }

  _finishAudioItem(item, source) {
    if (item.source !== source || !this.queue.includes(item)) return;
    if (item.startTimer) {
      clearTimeout(item.startTimer);
      item.startTimer = null;
    }
    try { source.disconnect(); } catch {}
    item.source = null;
    if (this._activeAudioItem === item) {
      this._activeAudioItem = null;
      this.currentSource = null;
    }
    this._removeQueueItem(item);

    const next = this.queue[0];
    if (next?.kind === 'audio' && (next.state === 'scheduled' || next.state === 'playing')) {
      this._markAudioItemStarted(next);
    }

    this._requestQueuePump();
    this._settleIdleIfEmpty();
  }

  _handlePlaybackItemError(item, err) {
    console.error('Audio playback error:', err);
    const text = item.text || '';
    this._removeQueueItem(item);
    this._dispatchingPlaybackError = true;
    try {
      this.onPlaybackError?.(err, text);
    } finally {
      this._dispatchingPlaybackError = false;
    }
    this._requestQueuePump();
    this._settleIdleIfEmpty();
  }

  _settleIdleIfEmpty() {
    if (this.queue.length > 0 || this._activeUtterance || this._activeAudioItem) return;
    if (!this.isPlaying && !this.currentSource) return;
    this.isPlaying = false;
    this.currentSource = null;
    this._scheduleCursor = 0;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._animFrame);
    this._animFrame = null;
    this._resetVisemes();
    this.onIdle?.();
  }

  _resetVisemes() {
    this.currentViseme = VISEMES.sil;
    this.currentIntensity = 0;
    this._textTimeline = null;
    this._lastFrameClock = 0;
    this._fallbackProgress = 0;
    this._fallbackLastClock = 0;
    for (const v of ALL_VISEME_KEYS) {
      this.visemeWeights[v] = v === VISEMES.sil ? 1 : 0;
      this.visemeDampers.get(v)?.reset(v === VISEMES.sil ? 1 : 0, 0);
    }
  }

  stop() {
    const queuedItems = this.queue;
    this.queue = [];
    this.isPlaying = false;
    this._playbackGeneration++;
    this._speechGeneration++;
    for (const item of queuedItems) {
      if (item.decodeTimeout) {
        clearTimeout(item.decodeTimeout);
        item.decodeTimeout = null;
      }
      if (item.decodeReject) {
        item.decodeReject(new Error('Audio playback was cancelled.'));
        item.decodeReject = null;
      }
      if (item.startTimer) {
        clearTimeout(item.startTimer);
        item.startTimer = null;
      }
      if (item.source) {
        try { item.source.stop(); } catch {}
        try { item.source.disconnect(); } catch {}
        item.source = null;
      }
      if (item.chunks) {
        for (const chunk of item.chunks) {
          if (chunk.startTimer) {
            clearTimeout(chunk.startTimer);
            chunk.startTimer = null;
          }
          if (chunk.source) {
            try { chunk.source.stop(); } catch {}
            try { chunk.source.disconnect(); } catch {}
            chunk.source = null;
          }
        }
      }
    }
    this._playbackDecodeTimeout = null;
    this._rejectPlaybackDecode = null;
    this._queuePumpPromise = null;
    this._resumePromise = null;
    this._activeAudioItem = null;
    this._scheduleCursor = 0;
    this._activeUtterance = null;
    if (this._speechTimeout) {
      clearTimeout(this._speechTimeout);
      this._speechTimeout = null;
    }
    if (this.currentSource) {
      const source = this.currentSource;
      this.currentSource = null;
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (this._fallbackRAF) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._fallbackRAF);
      this._fallbackRAF = null;
    }
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._animFrame);
    this._animFrame = null;
    this._resetVisemes();
    this._notifyQueueChange();
  }

  dispose() {
    this.stop();
    this._timingWorker?.terminate();
    this._timingWorker = null;
    this._timingWorkerFailed = false;

    const context = this.audioContext;
    const ownsAudioContext = this._ownsAudioContext;
    try { this.analyser?.disconnect?.(); } catch {}
    this.audioContext = null;
    this.analyser = null;
    this._waveformData = null;
    this._ownsAudioContext = false;

    if (!ownsAudioContext || !context || context.state === 'closed' || typeof context.close !== 'function') {
      return Promise.resolve();
    }

    return context.close().catch((error) => {
      console.warn('Audio context cleanup failed:', error);
    });
  }

  _selectMaleSpeechVoice(speechSynthesis) {
    let voices;
    try {
      voices = speechSynthesis.getVoices?.();
    } catch {
      return null;
    }

    if (!Array.isArray(voices)) return null;
    return voices.find((voice) => {
      const lang = typeof voice.lang === 'string' ? voice.lang : '';
      if (!/^en(?:[-_]|$)/i.test(lang)) return false;
      if (voice.gender === 'male') return true;
      if (voice.gender && voice.gender !== 'male') return false;
      const name = typeof voice.name === 'string' ? voice.name : '';
      return MALE_VOICE_NAME_PATTERN.test(name);
    }) || null;
  }

  _enqueueTextItem(text, insertAtFront) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') return false;
    const voice = this._selectMaleSpeechVoice(window.speechSynthesis);
    if (!voice) return false;

    const item = this._createQueueItem('text', { text, voice });
    if (insertAtFront) {
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }
    this._notifyQueueChange();
    this._requestQueuePump();
    return true;
  }

  _startQueuedTextIfReady() {
    const item = this.queue[0];
    if (!item || item.kind !== 'text' || item.state !== 'queued') return;
    if (this._activeAudioItem || this.currentSource || this._activeUtterance) return;
    this._startSpeechItem(item);
  }

  _startSpeechItem(item) {
    item.state = 'playing';
    const started = this._startSpeech(item.text, item.voice, {
      onFinish: () => {
        this._removeQueueItem(item);
        this._requestQueuePump();
        this._settleIdleIfEmpty();
      },
      onStart: () => {
        this.onPlaybackStart?.(item.text);
      },
    });
    if (!started) {
      this._removeQueueItem(item);
      this.onSpeechError?.();
      this._requestQueuePump();
      this._settleIdleIfEmpty();
    }
    return started;
  }

  _startSpeech(text, voice, { onFinish = null, onStart = null } = {}) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') return false;
    const selectedVoice = voice || this._selectMaleSpeechVoice(window.speechSynthesis);
    if (!selectedVoice) return false;

    this.isPlaying = true;
    const utterance = new SpeechSynthesisUtterance(text);
    const generation = ++this._speechGeneration;
    this._activeUtterance = utterance;
    utterance.voice = selectedVoice;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    this._textTimeline = this._buildTextTimeline(text);
    this._fallbackProgress = 0;
    this._fallbackLastClock = performance.now() / 1000;

    const totalDurationEstimate = utterance.text.length * 0.075;

    const tick = () => {
      if (!this.isPlaying || this._speechGeneration !== generation) return;
      const now = performance.now() / 1000;
      const dt = Math.min(Math.max(now - this._fallbackLastClock, 0), 0.1);
      this._fallbackLastClock = now;

      this._fallbackProgress += dt / Math.max(totalDurationEstimate, 0.1);
      const progress = Math.min(this._fallbackProgress, 0.9999);

      this._updateArticulation(this._poseTimeline(null, totalDurationEstimate), progress * totalDurationEstimate, 0.08, dt);
      this._fallbackRAF = requestAnimationFrame(tick);
    };

    utterance.onboundary = (event) => {
      if (generation !== this._speechGeneration || this._activeUtterance !== utterance || event.name !== 'word') return;
      const unit = this._textTimeline?.find((entry) => entry.charStart <= event.charIndex && entry.charEnd > event.charIndex);
      if (unit) this._fallbackProgress = unit.startFrac;
      this._fallbackLastClock = performance.now() / 1000;
    };

    utterance.onstart = () => {
      if (this._speechGeneration !== generation || this._activeUtterance !== utterance) return;
      this._fallbackLastClock = performance.now() / 1000;
      onStart?.();
      tick();
    };

    const finish = () => {
      if (this._speechGeneration !== generation || this._activeUtterance !== utterance) return;
      if (this._fallbackRAF) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._fallbackRAF);
        this._fallbackRAF = null;
      }
      if (this._speechTimeout) {
        clearTimeout(this._speechTimeout);
        this._speechTimeout = null;
      }
      this._activeUtterance = null;
      if (!onFinish) this.isPlaying = false;
      this._resetVisemes();
      onFinish?.();
      if (!onFinish) this.onIdle?.();
    };

    utterance.onend = finish;
    utterance.onerror = () => {
      if (this._speechGeneration !== generation) return;
      this.onSpeechError?.();
      finish();
    };

    try {
      window.speechSynthesis.speak(utterance);
      if (this._speechGeneration !== generation || this._activeUtterance !== utterance || !this.isPlaying) {
        return true;
      }
      const maxSpeechMs = Math.min(Math.max(totalDurationEstimate * 2000 + 3000, 6000), 60000);
      this._speechTimeout = setTimeout(() => {
        if (this._speechGeneration !== generation || this._activeUtterance !== utterance) return;
        this.onSpeechError?.();
        try { window.speechSynthesis.cancel(); } catch {}
        finish();
      }, maxSpeechMs);
      return true;
    } catch {
      this._speechGeneration++;
      this._activeUtterance = null;
      if (this._speechTimeout) {
        clearTimeout(this._speechTimeout);
        this._speechTimeout = null;
      }
      this.isPlaying = false;
      this._resetVisemes();
      return false;
    }
  }

  speakTextFallback(text) {
    if (this._dispatchingPlaybackError || this.queue.length > 0 || this._activeAudioItem || this.currentSource) {
      return this._enqueueTextItem(text, true);
    }
    return this._startSpeech(text, null);
  }
}
