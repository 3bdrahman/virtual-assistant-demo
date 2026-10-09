# Browser compatibility checks

The October 9, 2026 controlled browser run used the current visitor-key frontend, a local API relay, and fake provider responses. It exercised first visit, key entry and rejection, typed chat, retry, New chat cancellation, avatar asset loading, microphone recording and WAV conversion, streamed PCM playback, and recovery after microphone denial. It made no NVIDIA request.

| Engine | Result | Scope |
| --- | --- | --- |
| Chrome 146 (Chromium) | 5/5 Pages scenarios passed | Browser media recording, PCM source scheduling, and the `/demo/` avatar assets; the separate GPU articulation suite remains Chromium-based. |
| Playwright Firefox 155 | 5/5 Pages scenarios passed | Native WebM/Opus recording, WAV conversion, PCM source scheduling, key recovery, cancellation, and avatar asset loading. |
| Playwright WebKit | Not run | The Linux host lacks the WebKit build's runtime libraries, including ICU 74 and JPEG 8. This does not establish Safari behavior. |

The microphone path uses `MediaRecorder` followed by NVIDIA Parakeet transcription after recording stops. It does not depend on the browser `SpeechRecognition` API. The recorder probes WebM/Opus, WebM, then MP4 at runtime. A controlled Chromium run forced the MP4 branch and passed recording, conversion, transcription, and playback. Permission denial and unavailable WebGL/audio paths have separate browser or unit regressions. Playwright's synthetic microphone and permission handling do not replace a device check.

The [voice walkthrough](showcase/README.md) has H.264/AAC MP4 and VP9/Opus WebM versions. Both played with audio in Chrome; WebM played in Firefox. This host's Firefox H.264 decoder could not open the MP4, so both formats are linked from the README.

With a matching Playwright installation and browser binaries, run from `app/`:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:pages
E2E_BROWSER=firefox PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:pages
E2E_BROWSER=webkit PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:pages
E2E_MEDIA_FORMAT=mp4 E2E_SCENARIO='recorded microphone' PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:pages
```

Set `CHROMIUM_EXECUTABLE_PATH` when using an existing Chrome binary. The WebKit command is a pending check on a host with its required runtime libraries; Playwright WebKit is not branded Safari. Physical microphone, speaker, and Safari/iOS checks remain device-specific.

Reference: [Playwright browser builds](https://playwright.dev/docs/browsers), [MediaRecorder format probing](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static), and [microphone permission behavior](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
