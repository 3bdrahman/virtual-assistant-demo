const FIRST_CHUNK_LIMIT = 160;
const CHUNK_LIMIT = 600;
const PHRASE_WAIT_MS = 600;

// Wait for a following space before treating a streamed period as a sentence
// end: the next token may complete a decimal, abbreviation, or domain name.
function chunkEnd(text, { first, finished, force }) {
  const limit = first ? FIRST_CHUNK_LIMIT : CHUNK_LIMIT;
  const minimum = first ? 24 : 96;
  const boundaries = /[.!?。！？]["'”’)\]]*(?=\s|$)|\n+/gu;
  let sentenceEnd = 0;
  for (const match of text.matchAll(boundaries)) {
    const end = match.index + match[0].length;
    if (end > limit) break;
    if (!finished && end === text.length) continue;
    if (/\.$/.test(match[0]) && /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|[a-z])\.$/i.test(text.slice(0, end))) continue;
    if (end < minimum && !finished) continue;
    sentenceEnd = end;
    if (first) return end;
  }
  if (finished && text.length <= limit) return text.length;
  if (sentenceEnd) return sentenceEnd;
  if (text.length > limit || (force && text.length >= 40)) {
    const bounded = text.slice(0, limit + 1);
    const spaces = [...bounded.matchAll(/\s/gu)];
    const end = spaces.at(-1)?.index;
    if (end > 0) return end;
    if (text.length > limit) {
      // Avoid splitting a UTF-16 surrogate pair in text without spaces.
      return /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
    }
  }
  return 0;
}

/** Incremental text -> ordered speech, with one provider call and bounded lookahead. */
export class SpeechStream {
  constructor({ signal, synthesize, onAudio, onFallback, onError, onSynthesizing, getPendingCount = () => 0 }) {
    this.signal = signal;
    this.synthesize = synthesize;
    this.onAudio = onAudio;
    this.onFallback = onFallback;
    this.onError = onError;
    this.onSynthesizing = onSynthesizing;
    this.getPendingCount = getPendingCount;
    this.buffer = '';
    this.first = true;
    this.finished = false;
    this.closed = false;
    this.busy = false;
    this.fallback = false;
    this.force = false;
    this.timer = null;
    this.done = new Promise((resolve) => { this.resolve = resolve; });
    this.abort = () => this._close();
    if (signal?.aborted) this._close();
    else signal?.addEventListener('abort', this.abort, { once: true });
  }

  push(token) {
    if (this.closed || this.finished) return;
    this.buffer += token;
    this.resume();
  }

  finish() {
    this.finished = true;
    this.resume();
    return this.done;
  }

  // Playback invokes this when a queued segment finishes and frees capacity.
  resume() {
    if (this.closed || this.busy) return;
    this.buffer = this.buffer.trimStart();
    if (!this.buffer) {
      if (this.finished) this._close();
      return;
    }
    if (this.getPendingCount() >= 2) return;
    const end = chunkEnd(this.buffer, this);
    if (!end) {
      if (this.timer === null && this.buffer.length >= 40) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.force = true;
          this.resume();
        }, PHRASE_WAIT_MS);
      }
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
    this.force = false;
    const text = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end);
    this.first = false;
    this.busy = true;
    void this._speak(text);
  }

  async _speak(text) {
    try {
      if (this.fallback) {
        this.onFallback(text);
      } else {
        this.onSynthesizing?.();
        const audio = await this.synthesize(text);
        if (!this.closed) this.onAudio?.(audio, text);
      }
    } catch (error) {
      if (!this.closed) {
        // Once a provider fails, keep the remaining segments in browser voice;
        // already queued/spoken audio must never be repeated.
        this.fallback = true;
        this.onError?.(error);
        // A partially delivered phrase cannot safely be replayed in full.
        // Its complete text remains in the transcript; later phrases can use
        // browser speech without repeating words the user already heard.
        if (!error.partialAudio) this.onFallback(text);
      }
    } finally {
      this.busy = false;
      this.resume();
    }
  }

  _close() {
    this.closed = true;
    this.buffer = '';
    clearTimeout(this.timer);
    this.timer = null;
    this.signal?.removeEventListener('abort', this.abort);
    this.resolve();
  }
}
