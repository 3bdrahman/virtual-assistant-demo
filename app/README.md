# Virtual Assistant

A live AI conversation with a 3D avatar. Type a question or record your voice; replies stream into the transcript and the avatar speaks them aloud. Responses come from the live provider, with Jason as the primary voice. In visitor-key mode, each visitor enters a NVIDIA key that is kept only in page memory.

## Run locally

Requirements: Node.js 22+ and a server-side NVIDIA API key. WebGL is used for the avatar; text chat remains available when WebGL is blocked.

```bash
cp .env.example .env
# Add your NVIDIA_API_KEY to .env
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Vite client proxies `/api` to the Express server on port 3011. `.env` is ignored by Git and must stay on the server.

The page rechecks service availability after startup, so it recovers when the API comes online without a reload. A failed or cancelled text request keeps the question in the input for another attempt. Use **Cancel request** while waiting for transcription, chat, or speech, and **Stop speaking** during playback. **New chat** clears the transcript and draft and cancels pending requests and microphone access without restarting the avatar. Cancelled and failed turns are excluded from subsequent AI context. Microphone permission requests can be cancelled from the microphone control.

One `NVIDIA_API_KEY` powers chat, Parakeet transcription, and Magpie speech. Provider requests time out after 30 seconds; browser requests have a 45-second deadline that includes response streaming. Microphone capture stops after 60 seconds, and audio decoding and conversion each have a 15-second deadline. Cancelling a request also cancels conversion and upstream work. If the speech service fails, the app tries browser speech only when it can identify an English male voice; otherwise the text reply remains visible. Mouth movement follows a text-timed estimate shaped by audio volume, so it is expressive rather than phoneme-accurate.

## Build and serve

```bash
npm run build
npm start
```

Express serves `dist/` and `/api` from the same origin. Set `PORT` or `PROXY_PORT` if the host needs another port. For a public deployment, configure `ALLOWED_ORIGINS` for the site origin and set `TRUST_PROXY=true` only when a trusted reverse proxy supplies client IPs. Provider requests have basic per-IP rate and concurrency limits in one Node process. Set provider-side quotas as well when exposing a funded key publicly.

### Host the app

GitHub Pages hosts the frontend with a separately hosted API relay. See the [visitor-key deployment guide](../docs/github-pages-demo.md) and [Pages workflow](../.github/workflows/pages.yml). The public relay requires visitor keys and never falls back to an owner key.

For a combined Node deployment, keep the browser and API on one origin. The repository includes a [Render Blueprint](../render.yaml) for one web service. After pushing the source to GitHub, import that Blueprint into Render and enter `NVIDIA_API_KEY` when prompted. The equivalent manual [Render Web Service](https://render.com/docs/deploy-node-express-app) settings are:

| Setting | Value |
| --- | --- |
| Root directory | `app` |
| Build command | `npm ci && npm run verify` |
| Start command | `npm start` |
| Runtime | Node.js 22+ |
| Environment | `NVIDIA_API_KEY` as a server secret |

The server listens on the host's `PORT` and `0.0.0.0`; the public URL serves both the client and `/api`. Configure `TRUST_PROXY` only after confirming the host's forwarded IP behavior. The Blueprint starts on Render's free plan. [Free web services](https://render.com/docs/free) sleep after inactivity and can take about a minute to wake; use a continuously running plan when low first-visit latency matters. For an existing Blueprint, add or update the key in the service environment; `sync: false` prompts only on initial creation.

## What is live

| Path | Provider | Credential |
| --- | --- | --- |
| Text chat | NVIDIA NIM hosted Chat Completions, streamed SSE | `NVIDIA_API_KEY` |
| Microphone transcription | NVIDIA hosted Parakeet CTC ASR | `NVIDIA_API_KEY` |
| Avatar speech | NVIDIA hosted Magpie TTS, WAV playback | `NVIDIA_API_KEY` |
| Speech fallback | Browser Web Speech API | No extra key |

The selected chat model is controlled by server-side `NVIDIA_CHAT_MODEL`. The server does not accept model selection or credentials from the browser. Browser recordings are converted to mono 16 kHz WAV before the Parakeet request. Text input remains usable if microphone access or transcription is unavailable. No real provider call is made by the automated tests.

NVIDIA hosts [chat](https://docs.api.nvidia.com/nim/reference/llm-apis), [Parakeet ASR](https://build.nvidia.com/nvidia/parakeet-ctc-1_1b-asr/api), and [Magpie TTS](https://build.nvidia.com/nvidia/magpie-tts-multilingual/api) at different endpoints. The server owns those URLs and the API key. Speech requests are limited to 2,000 characters to match [NVIDIA's TTS contract](https://docs.nvidia.com/nim/speech/latest/reference/api-references/tts/http-tts.html); larger replies remain readable and can use browser speech.

## Quality checks

```bash
npm test
npm run lint
npm run build
# Run all three gates:
npm run verify
npm audit --omit=dev
```

The tests cover streaming completion and cancellation, deadlines, WAV encoding, malformed input and provider responses, server limits, audio cleanup, and avatar damping. GitHub Actions runs tests, lint, build, and the production dependency audit. The Render build runs tests and lint before building.

For browser integration checks, provide Playwright from your QA environment, build the current client, and run:

```bash
npm run build
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:e2e
# Check rendered mouth movement and idle animation continuity:
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:avatar
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:pages
```

If Playwright is already resolvable from the project, omit `PLAYWRIGHT_MODULE`. Optionally set `CHROMIUM_EXECUTABLE_PATH` for an existing Chromium binary and `E2E_ARTIFACT_DIR` for JSON results and screenshots. The harness starts an isolated local server, uses controlled provider responses, exercises real browser recording and WAV playback, and closes its servers and browser afterward. It never calls NVIDIA or changes the server credential.

For an explicit live release check using the configured server key:

```bash
npm run test:live
```

This makes three short real provider calls: chat → synthesized speech → transcription of that speech. It prints pass/fail metadata without credentials, prompts, or audio content. Run it only when you intend to use provider quota. Physical microphone/speaker quality and the deployed HTTPS origin still need checks on the intended demo devices.

## Project layout

- `src/App.jsx`: conversation and playback flow
- `src/services/nim.js`: browser client for the local API
- `src/services/audioLipSync.js`: audio playback and avatar visemes
- `src/components/`: interface and 3D avatar
- `server/index.js`: server-side provider proxy and production static serving
- `tests/`: offline API and animation regression tests
- `tests/demo.e2e.mjs`: browser demo regression harness
- `scripts/live-smoke.mjs`: explicit live provider release check
- `../docs/demo-audit.md`: section traversal, fixes, and verification evidence

## Deployment checks

1. Deploy the Express server and built client together with a valid server-side `NVIDIA_API_KEY`. Keep `.env` and provider credentials out of the repository and browser bundle.
2. Open the public URL in a fresh browser profile. Send a text prompt, record a short spoken prompt, and confirm that an answer, audio, and avatar render on the target browser. `/api/health` reports only key presence; it does not validate provider access.
3. Check provider quotas and the deployment logs. Rate limits in this app are per IP in one Node process, so public multi-instance hosting needs a shared limiter. Confirm proxy behavior before setting `TRUST_PROXY=true`; otherwise a reverse proxy can cause demo visitors to share one limit bucket.
4. `/api/health` is a liveness/configuration check suitable for host restarts. A 200 response does not establish provider entitlement, quota, or readiness; use the live check and a deployed-browser conversation for that release decision.

The current demo has no prerecorded answer mode. When the provider is unavailable, the UI reports the failure instead of presenting a simulated response.
