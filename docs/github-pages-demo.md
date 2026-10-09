# GitHub Pages demo with visitor keys

The demo is live at **https://3bdrahman.github.io/virtual-assistant-demo/**, with its API at **https://virtual-assistant-pages-api.onrender.com/api**. See the [showcase screenshots and silent walkthrough](../README.md) for the current experience. The explicit real-provider browser check is described below.

Each visitor supplies a NVIDIA key; it stays in page memory, is sent in an Authorization header to the API relay, and is forwarded to the fixed NVIDIA endpoints. Reloading clears it. Changing or removing it also starts a new conversation. The Render free instance can need about a minute to wake; the page reconnects automatically.

GitHub Pages is [static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages). The NVIDIA endpoints currently do not allow the browser CORS preflight needed for direct calls: the chat OPTIONS response had no Access-Control-Allow-Origin, and both speech OPTIONS requests returned 401. Putting a key in the browser does not remove that restriction. The relay is required for this version of the demo.

## API host

Deploy the existing `app/` Node service on an HTTPS host, using these settings:

| Setting | Value |
| --- | --- |
| Root directory | `app` |
| Node | 22 or later |
| Build | `npm ci && npm test && npm run lint` |
| Start | `npm start` |
| Health path | `/api/health` |
| `REQUIRE_USER_KEY` | `true` |
| `SERVE_STATIC` | `false` |
| `ALLOWED_ORIGINS` | `https://3bdrahman.github.io` for the detected repository |
| `NVIDIA_API_KEY` | Leave unset |

An API-only Render configuration is provided in [render-pages-api.yaml](../render-pages-api.yaml). The existing `render.yaml` remains the combined frontend/API deployment option. Confirm the host's forwarded-IP behavior before setting `TRUST_PROXY`; do not enable it blindly. Rate limits remain per IP and per Node process.

The allowed origin excludes the repository path. A custom Pages domain needs its own exact HTTPS origin. The provider key is not an API-host environment secret in this deployment mode: every request requires its visitor's key, and missing or invalid credentials never fall back to an owner key.

## GitHub Pages frontend

The repository `3bdrahman/virtual-assistant-demo` now has Pages enabled and `DEMO_API_URL` set to the deployed relay. For future deployments or another repository:

1. Set the repository Actions variable `DEMO_API_URL` to the complete API base, such as `https://your-api.example/api`. This is a public URL, not a provider key.
2. Choose **GitHub Actions** as the repository's Pages source.
3. Run **Deploy visitor-key demo to Pages**, defined in [.github/workflows/pages.yml](../.github/workflows/pages.yml).

The workflow is manual. It verifies the relay's health, exact CORS origin, Authorization preflight, and rejection of requests with no key before publishing. It also runs tests, lint, build, and the production dependency audit. No NVIDIA key is needed in GitHub Actions.

The workflow derives the correct Pages base path through `actions/configure-pages`; model files, animations, JavaScript, CSS, and the favicon use that base. The frontend is built with `VITE_REQUIRE_USER_KEY=true` and `VITE_API_BASE_URL` pointing to the relay.

## Local modes

The usual `npm run dev` or `npm run build && npm start` keeps the existing server-key mode for local use. Set `REQUIRE_USER_KEY=true` on the local server to use the visitor-key form on the same origin. For a separate static frontend, set `VITE_API_BASE_URL` at build time and include its origin in the API's `ALLOWED_ORIGINS`.

Only `VITE_*` settings intended to be public belong in the frontend build. Never put a NVIDIA key in a Vite variable, repository file, URL, or the Pages artifact.

## Verification

From `app/`:

```bash
npm run verify
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:pages
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:avatar
```

`test:pages` builds under `/demo/`, serves static files and the API on different origins, and uses fake provider keys. It checks key entry, headers, bad-key recovery, isolation between browser contexts, reload/removal, cancellation, new conversations, and avatar asset paths. It does not publish a site or consume NVIDIA quota.

The explicit `npm run test:live` command makes real NVIDIA calls. The primary voice is Jason. Browser speech fallback is used only when an available English voice is explicitly labelled male; otherwise the text remains available.

An earlier public check verified real chat and Jason speech, GPU mouth movement, stop/reset, microphone transcription of a generated speech fixture, a second reply, new-chat clearing, no persisted key, and key removal on reload. Its recorded run had no browser errors or retries. Physical microphone/speaker quality and other browser engines remain device-specific checks.

The October 2026 release candidate has 162 passing unit/API tests plus controlled Pages, streaming, avatar, articulation, and conversation browser checks. A hosted-provider timeout found during an earlier public check led to a longer bounded chat response window, persistent failure details, and a Retry button that also reuses recorded transcripts. Earlier deployment evidence is in [release evidence](public-demo-evidence/verification-summary.json); run `test:public` against each new deployment rather than treating that result as current.
