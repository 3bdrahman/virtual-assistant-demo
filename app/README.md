# Virtual Assistant

A live AI conversation with a 3D avatar. Type a question or record your voice; replies stream into the transcript and the avatar speaks them aloud. The interface has no canned answers or visitor-facing API key form.

## Run locally

Requirements: Node.js 22+ and a server-side NVIDIA API key. WebGL is used for the avatar; text chat remains available when WebGL is blocked.

```bash
cp .env.example .env
# Add your NVIDIA_API_KEY to .env
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Vite client proxies `/api` to the Express server on port 3011. `.env` is ignored by Git and must stay on the server.

One `NVIDIA_API_KEY` powers chat, Parakeet transcription, and Magpie speech. Provider requests time out after 30 seconds so a stalled call does not leave the interface waiting indefinitely. If the speech service fails, the app labels and tries browser speech synthesis; if that is unavailable, the text reply remains visible. Mouth movement follows a text-timed estimate shaped by audio volume, so it is expressive rather than phoneme-accurate.

## Build and serve

```bash
npm run build
npm start
```

Express serves `dist/` and `/api` from the same origin. Set `PORT` or `PROXY_PORT` if the host needs another port. For a public deployment, configure `ALLOWED_ORIGINS` for the site origin and set `TRUST_PROXY=true` only when a trusted reverse proxy supplies client IPs. Provider requests have basic per-IP rate and concurrency limits in one Node process. Set provider-side quotas as well when exposing a funded key publicly.

### Host the app

GitHub Pages serves static files and cannot run this Express API. Keep the browser and API on one origin with a Node web service. The repository includes a [Render Blueprint](../render.yaml) for one web service. After pushing the source to GitHub, import that Blueprint into Render and enter `NVIDIA_API_KEY` when prompted. The equivalent manual [Render Web Service](https://render.com/docs/deploy-node-express-app) settings are:

| Setting | Value |
| --- | --- |
| Root directory | `app` |
| Build command | `npm ci && npm run build` |
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

NVIDIA hosts [chat](https://docs.api.nvidia.com/nim/re/reference/llm-apis), [Parakeet ASR](https://build.nvidia.com/nvidia/parakeet-ctc-1_1b-asr/api), and [Magpie TTS](https://build.nvidia.com/nvidia/magpie-tts-multilingual/api) at different endpoints. The server owns those URLs and the API key.

## Quality checks

```bash
npm test
npm run lint
npm run build
```

The tests cover streaming completion, WAV encoding, server validation and rate limits, and avatar damping. The build and tests do not prove external provider availability; verify the deployed key and speech models with a live conversation after deployment.

## Project layout

- `src/App.jsx`: conversation and playback flow
- `src/services/nim.js`: browser client for the local API
- `src/services/audioLipSync.js`: audio playback and avatar visemes
- `src/components/`: interface and 3D avatar
- `server/index.js`: server-side provider proxy and production static serving
- `tests/`: offline API and animation regression tests

## Deployment checks

1. Deploy the Express server and built client together with a valid server-side `NVIDIA_API_KEY`. Keep `.env` and provider credentials out of the repository and browser bundle.
2. Open the public URL in a fresh browser profile. Send a text prompt, record a short spoken prompt, and confirm that an answer, audio, and avatar render on the target browser. `/api/health` reports only key presence; it does not validate provider access.
3. Check provider quotas and the deployment logs. Rate limits in this app are per IP in one Node process, so public multi-instance hosting needs a shared limiter.

The current demo has no prerecorded answer mode. When the provider is unavailable, the UI reports the failure instead of presenting a simulated response.
