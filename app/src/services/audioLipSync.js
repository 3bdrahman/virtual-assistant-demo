/**
 * Audio playback with estimated text-driven lip-sync.
 *
 * Uses a text timeline modulated by the playback volume for NVIDIA WAV
 * audio, and the same timeline with estimated timing for browser speech.
 */

// ── Oculus Viseme set (matches RPM Wolf3D_Head morph targets) ──
const VISEMES = {
  sil: 'viseme_sil',
  PP:  'viseme_PP',
  FF:  'viseme_FF',
  TH:  'viseme_TH',
  DD:  'viseme_DD',
  kk:  'viseme_kk',
  CH:  'viseme_CH',
  SS:  'viseme_SS',
  nn:  'viseme_nn',
  RR:  'viseme_RR',
  aa:  'viseme_aa',
  E:   'viseme_E',
  I:   'viseme_I',
  O:   'viseme_O',
  U:   'viseme_U',
};

const ALL_VISEME_KEYS = Object.values(VISEMES);

// FSM phoneme categories
const FSM = { silence: 0, vowel: 1, plosive: 2, fricative: 3 };

const VISEME_CATEGORY = {
  [VISEMES.sil]: FSM.silence,
  [VISEMES.PP]:  FSM.plosive,
  [VISEMES.FF]:  FSM.fricative,
  [VISEMES.TH]:  FSM.fricative,
  [VISEMES.DD]:  FSM.plosive,
  [VISEMES.kk]:  FSM.plosive,
  [VISEMES.CH]:  FSM.fricative,
  [VISEMES.SS]:  FSM.fricative,
  [VISEMES.nn]:  FSM.plosive,
  [VISEMES.RR]:  FSM.fricative,
  [VISEMES.aa]:  FSM.vowel,
  [VISEMES.E]:   FSM.vowel,
  [VISEMES.I]:   FSM.vowel,
  [VISEMES.O]:   FSM.vowel,
  [VISEMES.U]:   FSM.vowel,
};

// ── Coarticulation: secondary shapes that blend with the primary ──
const COARTICULATION = {
  [VISEMES.aa]: { [VISEMES.E]: 0.15, [VISEMES.O]: 0.10, [VISEMES.RR]: 0.08 },
  [VISEMES.E]:  { [VISEMES.aa]: 0.12, [VISEMES.I]: 0.10, [VISEMES.RR]: 0.05 },
  [VISEMES.I]:  { [VISEMES.E]: 0.12, [VISEMES.SS]: 0.08, [VISEMES.CH]: 0.05 },
  [VISEMES.O]:  { [VISEMES.U]: 0.15, [VISEMES.aa]: 0.10, [VISEMES.RR]: 0.08 },
  [VISEMES.U]:  { [VISEMES.O]: 0.15, [VISEMES.PP]: 0.05, [VISEMES.FF]: 0.04 },
  [VISEMES.PP]: { [VISEMES.nn]: 0.08, [VISEMES.FF]: 0.06, [VISEMES.U]: 0.05 },
  [VISEMES.FF]: { [VISEMES.TH]: 0.10, [VISEMES.PP]: 0.06 },
  [VISEMES.TH]: { [VISEMES.FF]: 0.08, [VISEMES.DD]: 0.08, [VISEMES.nn]: 0.05 },
  [VISEMES.DD]: { [VISEMES.nn]: 0.10, [VISEMES.kk]: 0.08, [VISEMES.TH]: 0.06 },
  [VISEMES.kk]: { [VISEMES.DD]: 0.08, [VISEMES.nn]: 0.06, [VISEMES.RR]: 0.05 },
  [VISEMES.CH]: { [VISEMES.SS]: 0.10, [VISEMES.I]: 0.06 },
  [VISEMES.SS]: { [VISEMES.CH]: 0.08, [VISEMES.I]: 0.08, [VISEMES.TH]: 0.05 },
  [VISEMES.nn]: { [VISEMES.DD]: 0.10, [VISEMES.kk]: 0.05 },
  [VISEMES.RR]: { [VISEMES.aa]: 0.10, [VISEMES.O]: 0.08, [VISEMES.E]: 0.06 },
};

// ── Character → viseme mapping for estimated speech timing ─────
const CHAR_TO_VISEME = {
  // Vowels
  'a': VISEMES.aa, 'A': VISEMES.aa,
  'e': VISEMES.E,  'E': VISEMES.E,
  'i': VISEMES.I,  'I': VISEMES.I,
  'o': VISEMES.O,  'O': VISEMES.O,
  'u': VISEMES.U,  'U': VISEMES.U,
  'y': VISEMES.I,  'Y': VISEMES.I,
  // Plosives
  'p': VISEMES.PP, 'P': VISEMES.PP,
  'b': VISEMES.PP, 'B': VISEMES.PP,
  't': VISEMES.DD, 'T': VISEMES.DD,
  'd': VISEMES.DD, 'D': VISEMES.DD,
  'k': VISEMES.kk, 'K': VISEMES.kk,
  'g': VISEMES.kk, 'G': VISEMES.kk,
  // Fricatives
  'f': VISEMES.FF, 'F': VISEMES.FF,
  'v': VISEMES.FF, 'V': VISEMES.FF,
  's': VISEMES.SS, 'S': VISEMES.SS,
  'z': VISEMES.SS, 'Z': VISEMES.SS,
  'h': VISEMES.sil, 'H': VISEMES.sil,
  // Affricates / postalveolars
  'c': VISEMES.CH, 'C': VISEMES.CH, // will be refined by context
  'j': VISEMES.CH, 'J': VISEMES.CH,
  // Nasals
  'm': VISEMES.PP, 'M': VISEMES.PP,
  'n': VISEMES.nn, 'N': VISEMES.nn,
  // Liquids
  'l': VISEMES.nn, 'L': VISEMES.nn,
  'r': VISEMES.RR, 'R': VISEMES.RR,
  // Special
  ' ': VISEMES.sil,
  '\t': VISEMES.sil,
  '\n': VISEMES.sil,
  '.': VISEMES.sil,
  ',': VISEMES.sil,
  '?': VISEMES.sil,
  '!': VISEMES.sil,
  ';': VISEMES.sil,
  ':': VISEMES.sil,
  '-': VISEMES.sil,
  '\'': VISEMES.sil,
  '"': VISEMES.sil,
  '(': VISEMES.sil,
  ')': VISEMES.sil,
};

const DEFAULT_VISEME = VISEMES.aa;

// Character-derived viseme duration weights for estimated speech timing.
const PHONEME_WEIGHTS = {
  [VISEMES.sil]: 1.4,
  [VISEMES.aa]:  2.4,
  [VISEMES.E]:   2.4,
  [VISEMES.I]:   2.4,
  [VISEMES.O]:   2.4,
  [VISEMES.U]:   2.4,
  [VISEMES.nn]:  1.6,
  [VISEMES.RR]:  1.6,
  [VISEMES.FF]:  1.2,
  [VISEMES.SS]:  1.2,
  [VISEMES.TH]:  1.2,
  [VISEMES.CH]:  1.2,
  [VISEMES.PP]:  0.6,
  [VISEMES.DD]:  0.6,
  [VISEMES.kk]:  0.6,
};

// Spring response constants used by the frame-rate-independent dampers.
const SMOOTH_ATTACK_TAU  = 0.045;
const SMOOTH_RELEASE_TAU = 0.110;
const SMOOTH_SIL_TAU     = 0.150;
const PLAYBACK_DECODE_TIMEOUT_MS = 15_000;
const MAX_DECODE_AHEAD = 2;
const MALE_VOICE_NAME_PATTERN = /\bmale\b/i;

import { SpringDamper } from '../utils/springDamper.js';

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
    const clean = Array.from(text || '', (character) => {
      const lower = character.toLowerCase();
      if (CHAR_TO_VISEME[lower] || /\s/.test(lower)) return lower;
      if (/[.,?!;:'"()-]/.test(lower)) return ' ';
      return '*';
    }).join('');
    const items = [];
    let idx = 0;
    while (idx < clean.length) {
      const ch = clean[idx];
      if (ch === ' ') {
        items.push({ viseme: VISEMES.sil, weight: PHONEME_WEIGHTS[VISEMES.sil] });
        idx++;
        while (idx < clean.length && clean[idx] === ' ') idx++;
        continue;
      }
      const viseme = CHAR_TO_VISEME[ch] || DEFAULT_VISEME;
      items.push({ viseme, weight: PHONEME_WEIGHTS[viseme] || 1.0 });
      idx++;
    }

    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    let currentAccum = 0;
    return items.map(item => {
      const startFrac = currentAccum / (totalWeight || 1);
      currentAccum += item.weight;
      const endFrac = currentAccum / (totalWeight || 1);
      return { viseme: item.viseme, startFrac, endFrac };
    });
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
    item.estimatedDuration = Math.max(text.length * 0.065, 0.5);
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
    if (final) group.final = true;
    this._requestQueuePump();
    return group.speechId;
  }

  finishPcm(speechId) {
    const item = this.queue.find((candidate) => candidate.kind === 'pcm' && candidate.speechId === speechId);
    if (!item) return false;
    item.final = true;
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

  _analyzeFrame() {
    if (!this.analyser) return;

    const now = performance.now() / 1000;
    const dt = this._lastFrameClock ? Math.min(Math.max(now - this._lastFrameClock, 0), 0.1) : 0.016;
    this._lastFrameClock = now;

    // Get current audio time
    const audioTime = this.audioContext ? this.audioContext.currentTime - this._audioStartCtxTime : 0;
    const progress = this._activeAudioItem?.kind === 'pcm' ? this._pcmProgress(this._activeAudioItem) : this._playbackDuration > 0
      ? Math.min(Math.max(audioTime / this._playbackDuration, 0), 1)
      : 0;

    // Determine current viseme from the estimated text timeline.
    let targetViseme = VISEMES.sil;
    let intensity = 0;

    if (this._textTimeline && this._textTimeline.length > 0) {
      for (const item of this._textTimeline) {
        if (progress >= item.startFrac && progress <= item.endFrac) {
          targetViseme = item.viseme;
          intensity = 1.0;
          break;
        }
      }
    }

    // Waveform RMS measures audible energy. Averaging the whole frequency
    // spectrum dilutes speech with empty bins and can suppress the mouth.
    if (this.analyser && this._waveformData) {
      this.analyser.getFloatTimeDomainData(this._waveformData);
      let sumSquares = 0;
      for (const sample of this._waveformData) sumSquares += sample * sample;
      const volume = Math.sqrt(sumSquares / this._waveformData.length);
      intensity *= Math.min(volume * 6, 1);
    }

    // Update viseme
    this.currentViseme = targetViseme;
    this._fsmState = VISEME_CATEGORY[targetViseme] || FSM.silence;
    this.currentIntensity = intensity;

    // Build targets with coarticulation
    const targets = {};
    for (const v of ALL_VISEME_KEYS) targets[v] = 0;

    if (targetViseme === VISEMES.sil || intensity < 0.04) {
      targets[VISEMES.sil] = 1.0;
    } else {
      targets[targetViseme] = intensity;

      // Coarticulation neighbors
      const neighbors = COARTICULATION[targetViseme];
      if (neighbors) {
        for (const [nv, bf] of Object.entries(neighbors)) {
          targets[nv] = Math.min(intensity * bf * 0.5, 0.12);
        }
      }
    }

    // Apply spring-damper smoothing
    const isConsonant = this._fsmState === FSM.plosive || this._fsmState === FSM.fricative;
    const attackTau = isConsonant ? SMOOTH_ATTACK_TAU : SMOOTH_ATTACK_TAU * 1.4;
    const releaseTau = targetViseme === VISEMES.sil ? SMOOTH_SIL_TAU : (isConsonant ? SMOOTH_RELEASE_TAU : SMOOTH_RELEASE_TAU * 1.4);

    for (const v of ALL_VISEME_KEYS) {
      const target = targets[v] || 0;
      const current = this.visemeWeights[v] || 0;
      const baseTau = target > current ? attackTau : releaseTau;

      let damper = this.visemeDampers.get(v);
      if (!damper) {
        damper = new SpringDamper(current, baseTau, v);
        this.visemeDampers.set(v, damper);
      } else {
        damper.updateParameters(baseTau, v);
      }

      this.visemeWeights[v] = damper.update(target, dt);
    }

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

  _pcmProgress(item) {
    const ctx = this.audioContext;
    const audibleTime = ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
    let elapsed = item.endedDuration;
    for (const chunk of item.chunks) {
      if (chunk.scheduled && audibleTime >= chunk.startTime) {
        elapsed = Math.max(elapsed, chunk.offset + Math.min(audibleTime - chunk.startTime, chunk.duration));
      }
    }
    this._playbackDuration = item.final ? item.receivedDuration : Math.max(item.estimatedDuration, elapsed + 0.3);
    // Sample offsets exclude network stalls. Never rewind when the final
    // duration replaces the estimate or more audio arrives.
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
    this._textTimeline = this._buildTextTimeline(item.text);
    this._playbackDuration = item.final ? item.receivedDuration : item.estimatedDuration;
    this._lastFrameClock = 0;

    const ctx = this.audioContext;
    const baseLatency = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    const outputLatency = (ctx.outputLatency && Number.isFinite(ctx.outputLatency)) ? ctx.outputLatency : 0;
    this._audioStartCtxTime = item.startTime + baseLatency + outputLatency;

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
    this._textTimeline = this._buildTextTimeline(item.text);
    this._playbackDuration = item.duration || 1;
    this._lastFrameClock = 0;

    const ctx = this.audioContext;
    const baseLatency = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    const outputLatency = (ctx.outputLatency && Number.isFinite(ctx.outputLatency)) ? ctx.outputLatency : 0;
    this._audioStartCtxTime = item.startTime + baseLatency + outputLatency;

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

      const timeline = this._textTimeline;
      let viseme = VISEMES.sil;
      if (timeline) {
        for (const item of timeline) {
          if (progress >= item.startFrac && progress <= item.endFrac) { viseme = item.viseme; break; }
        }
      }
      const volume = 0.6 + 0.3 * Math.sin(Math.min(progress * Math.PI * 8, Math.PI * 2));

      const targets = {};
      for (const v of ALL_VISEME_KEYS) targets[v] = 0;
      if (viseme !== VISEMES.sil) {
        targets[viseme] = Math.min(volume * 0.85, 1.0);
        const neighbors = COARTICULATION[viseme];
        if (neighbors) {
          for (const [nv, bf] of Object.entries(neighbors)) {
            targets[nv] = volume * bf * 0.45;
          }
        }
      } else {
        targets[VISEMES.sil] = 1.0;
      }

      const isConsonant = VISEME_CATEGORY[viseme] === FSM.plosive || VISEME_CATEGORY[viseme] === FSM.fricative;
      const attackTau = isConsonant ? SMOOTH_ATTACK_TAU : SMOOTH_ATTACK_TAU * 1.4;
      const releaseTau = viseme === VISEMES.sil ? SMOOTH_SIL_TAU : (isConsonant ? SMOOTH_RELEASE_TAU : SMOOTH_RELEASE_TAU * 1.4);

      for (const v of ALL_VISEME_KEYS) {
        const target = targets[v] || 0;
        const current = this.visemeWeights[v] || 0;
        const baseTau = target > current ? attackTau : releaseTau;

        let damper = this.visemeDampers.get(v);
        if (!damper) {
          damper = new SpringDamper(current, baseTau, v);
          this.visemeDampers.set(v, damper);
        } else {
          damper.updateParameters(baseTau, v);
        }

        this.visemeWeights[v] = damper.update(target, dt);
      }

      this.currentViseme = viseme;
      this.currentIntensity = volume;
      this._fallbackRAF = requestAnimationFrame(tick);
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
