# Streaming avatar speech

## Scope and plan

The baseline streams chat text, then waits for `[DONE]` before requesting a
single full-reply WAV. Playback also decodes each queued WAV only after the
preceding one finishes. The existing scene is memoized and its idle animation
already survives streamed text updates.

1. Lock the existing behavior with the unit suite (106 tests passing), then add
   a held-open chat regression that requires audible playback before `[DONE]`.
2. Feed complete early phrases into speech synthesis while text continues to
   arrive. Bound phrase sizes, run only one synthesis request at a time, and
   prepare at most two speech segments ahead of playback. Preserve all text.
3. Use the hosted online TTS endpoint for PCM streaming, bypass full-file WAV
   decoding, and schedule ready segments on the audio clock. Keep each phrase's
   lip timeline aligned to its audio; preserve smoothing across buffer boundaries.
   Keep the existing WAV API available for callers that do not request streaming.
4. Keep cancellation, incomplete-stream errors, visitor keys, and the existing
   explicit male browser voice fallback intact. All queued work belongs to the
   current request and is discarded on Stop, New chat, or key changes.
5. Verify unit tests, lint, build, controlled browser timing, and the existing
   rendered-mouth/idle regression. Report controlled timings separately from
   any live-provider measurement. No deployment or dependency changes.

The browser voice fallback is an existing compatibility path for provider or
audio output failures; test its ordering and cancellation alongside the primary
audio path. Text-only behavior remains valid when no supported voice exists.

## Provider verification

[NVIDIA's HTTP reference](https://docs.nvidia.com/nim/speech/latest/reference/api-references/tts/http-tts.html)
distinguishes complete WAV synthesis from online raw PCM streaming. An
authenticated probe on October 4, 2026 verified `/v1/audio/synthesize_online` on
the existing hosted Magpie function with the existing Jason voice: HTTP 200,
first bytes at 631 ms, completion at 829 ms, 61,880 PCM bytes. This is one small
provider probe, not an end-to-end latency guarantee. The hosted endpoint omitted
Content-Type; the relay explicitly labels its fixed mono PCM16LE/44.1 kHz format.

The browser decodes signed PCM samples directly into short AudioBuffers and
[schedules their starts on the audio clock](https://www.w3.org/TR/webaudio-1.0/#dom-audioscheduledsourcenode-start).
It does not use `decodeAudioData` on partial WAV files; that API requires complete
file data. Phrase timing remains an estimate modulated by actual audio intensity.

## Validation

- Unit/API suite: 142 tests passed. Lint and production build passed; the
  existing large avatar-scene bundle warning remains. This JavaScript project
  has no separate typecheck command.
- [Controlled browser timing](streaming-speech-evidence/controlled-timing.json):
  first playback at 538 ms while both chat and TTS remained deliberately open;
  buffered source scheduling gap was 0 seconds. Stop aborted unfinished chat
  and speech requests, stopped scheduled sources, and prevented stale speech
  after starting a new conversation.
- [Live provider timing](streaming-speech-evidence/live-timing.json): first
  text at 1,432 ms, first speech request at 1,435 ms, first PCM at 2,208 ms,
  first playback at 2,217 ms, and an audible waveform at 2,291 ms. The first
  phrase's response finished at 3,655 ms. Playback began 1,438 ms before that
  response was complete. This single run uses the real model and voice through
  a local relay; remote hosting cold starts and provider load still vary.
- [Rendered animation evidence](streaming-speech-evidence/avatar-results.json):
  GPU mouth shapes moved, Stop restored the idle mouth, the next reply animated
  again, and the idle animation recorded zero resets across conversation updates.
- [Conversation browser regressions](streaming-speech-evidence/conversation-results.json):
  all 11 scenarios passed, including speech fallback, incomplete replies,
  retries, microphone controls, bounded conversation history and mobile layouts.
- Browser fallback now starts its lip timeline on the utterance's actual start
  event. Unit regressions cover unavailable voices, stalled output, queue order,
  cancellation, and completion without leaving the UI busy.

The initial source inspection established the full-reply/full-WAV delay. The
held-stream test first failed during integration and then passed after PCM
playback was connected; its failed run is not a timed measurement of the
original application. No percentage speedup is inferred from the fixture.

## Changed surfaces and limits

- `app/src/App.jsx`: connects streamed tokens to ordered speech and keeps
  cancellation and busy controls tied to the request lifecycle.
- `app/src/services/speechStream.js`: bounded early phrase extraction and
  synthesis lookahead, with one synthesis request alongside the model stream.
- `app/src/services/nim.js` and `app/server/index.js`: opt-in streaming PCM
  transport, byte-boundary reconstruction, deadlines and cancellation. Existing
  non-streaming WAV callers retain their API.
- `app/src/services/audioLipSync.js`: scheduled PCM playback and phrase timing,
  prepared WAV playback for existing callers, and one ordered browser fallback
  queue. Removed the superseded single-decode implementation.
- Regression tests, browser fixtures, package test command and app documentation
  were updated. No dependency or avatar asset changes.

Lip timing remains estimated, not phoneme-aligned. Buffer scheduling removes
avoidable client gaps; it cannot eliminate a pause if the network/provider
delivers audio slower than playback. A partially spoken phrase is not replayed
after an audio failure, and its full text remains available in chat.
Phrase streaming uses more speech requests than a single full-reply request;
buffered text is combined to limit that overhead. Existing server rate limits
and provider concurrency limits remain in effect.
