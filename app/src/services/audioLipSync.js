/**
 * Audio playback queue with phoneme-timestamp-driven lip-sync.
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

// Phoneme duration weights for realistic speech timing (used when timestamps unavailable)
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

// Critically-damped EMA: factor = 1 - exp(-dt/tau). Frame-rate-independent.
const SMOOTH_ATTACK_TAU  = 0.045;
const SMOOTH_RELEASE_TAU = 0.110;
const SMOOTH_SIL_TAU     = 0.150;

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
    this.onPlaybackError = null;
    this.onSpeechError = null;
    this._animFrame = null;
    this._frequencyData = null;

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

  }

  init() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.4;
      this._frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
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
    const clean = (text || '').toLowerCase().replace(/[^a-z\s]/g, ' ');
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

    let totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
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
    this.queue.push({ blob: audioBlob, text: sentenceText });
    if (!this.isPlaying) this._playNext();
  }

  _analyzeFrame() {
    if (!this.analyser) return;

    const now = performance.now() / 1000;
    const dt = this._lastFrameClock ? Math.min(Math.max(now - this._lastFrameClock, 0), 0.1) : 0.016;
    this._lastFrameClock = now;

    // Get current audio time
    const audioTime = this.audioContext ? this.audioContext.currentTime - this._audioStartCtxTime : 0;
    const progress = this._playbackDuration > 0 
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

    // Volume from analyser (for intensity modulation)
    if (this.analyser && this._frequencyData) {
      this.analyser.getByteFrequencyData(this._frequencyData);
      let sumAmp = 0;
      for (let i = 0; i < this._frequencyData.length; i++) sumAmp += this._frequencyData[i];
      const volume = sumAmp / (this._frequencyData.length * 255);
      intensity *= Math.min(volume * 3, 1.0);
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

  async _playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentSource = null;
      this._resetVisemes();
      this.onIdle?.();
      return;
    }

    this.isPlaying = true;
    const generation = this._playbackGeneration;
    const item = this.queue.shift();
    const blob = item.blob;
    const text = item.text || '';
    this._textTimeline = this._buildTextTimeline(text);

    try {
      if (this.audioContext.state === 'suspended') {
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
      }
      if (generation !== this._playbackGeneration) return;

      const arrayBuffer = await blob.arrayBuffer();
      if (generation !== this._playbackGeneration) return;
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      if (generation !== this._playbackGeneration) return;

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      this.currentSource = source;

      this._playbackDuration = audioBuffer.duration || 1;
      this._lastFrameClock = 0;

      const analyze = () => {
        this._analyzeFrame();
        if (this.isPlaying) {
          this._animFrame = requestAnimationFrame(analyze);
        }
      };

      source.onended = () => {
        if (this.currentSource !== source) return;
        this.currentSource = null;
        cancelAnimationFrame(this._animFrame);
        this._playNext();
      };

      source.start(0);
      const ctx = this.audioContext;
      const baseLatency = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
      const outputLatency = (ctx.outputLatency && Number.isFinite(ctx.outputLatency)) ? ctx.outputLatency : 0;
      this._audioStartCtxTime = ctx.currentTime + baseLatency + outputLatency;
      analyze();
    } catch (err) {
      if (generation !== this._playbackGeneration) return;
      console.error('Audio playback error:', err);
      this.isPlaying = false;
      this.onPlaybackError?.(err, text);
      if (!this.isPlaying) this._playNext();
    }
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
    }
  }

  stop() {
    this.queue = [];
    this.isPlaying = false;
    this._playbackGeneration++;
    this._speechGeneration++;
    this._activeUtterance = null;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch {}
      this.currentSource = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (this._fallbackRAF) {
      cancelAnimationFrame(this._fallbackRAF);
      this._fallbackRAF = null;
    }
    cancelAnimationFrame(this._animFrame);
    this._resetVisemes();
  }

  speakTextFallback(text) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') return false;
    this.isPlaying = true;
    const utterance = new SpeechSynthesisUtterance(text);
    const generation = ++this._speechGeneration;
    this._activeUtterance = utterance;
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

    const finish = () => {
      if (this._speechGeneration !== generation || this._activeUtterance !== utterance) return;
      if (this._fallbackRAF) {
        cancelAnimationFrame(this._fallbackRAF);
        this._fallbackRAF = null;
      }
      this._activeUtterance = null;
      this.isPlaying = false;
      this._resetVisemes();
      this.onIdle?.();
    };

    utterance.onend = finish;
    utterance.onerror = () => {
      if (this._speechGeneration !== generation) return;
      this.onSpeechError?.();
      finish();
    };

    try {
      window.speechSynthesis.speak(utterance);
      tick();
      return true;
    } catch {
      this._speechGeneration++;
      this._activeUtterance = null;
      this.isPlaying = false;
      this._resetVisemes();
      return false;
    }
  }
}
