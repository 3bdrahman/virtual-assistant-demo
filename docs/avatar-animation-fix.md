# Avatar animation repair

## Reported failures and causes

The demo could play speech while the mouth remained still, and the idle avatar repeatedly appeared to reset.

1. The bundled GLB exposes 15 Oculus `viseme_*` morph targets on its head and teeth. `Avatar.jsx` converted those weights to ARKit names such as `jawOpen`, absent from this asset, so its actual mouth targets stayed at zero.
2. `useAnimations` received a newly constructed clips array on every React render. Its effect cleanup stopped the mixer whenever blink state or conversation updates rerendered the avatar. Clip names were also changed after the hook had indexed them.
3. Audio intensity averaged all frequency bins, including empty bins. A clearly audible narrow-band signal could therefore fall below the mouth-opening threshold.

The prior demo audit checked audio state and avatar loading, but did not verify actual rendered mouth deformation or animation continuity. Those checks were insufficient for these failures.

## Changes

- Bind smoothed speech weights directly to the morph targets present in the head, teeth, and eye meshes. Remove the unused ARKit translation.
- Clone and name the FBX clips before binding; memoize the prepared clips array. Play the greeting once, then transition to the idle animation on the mixer's completion event.
- Measure waveform RMS for mouth intensity so audible audio is not diluted by unused spectral bins.
- Add regression tests using the actual GLB and FBX assets, plus a Chromium check of GPU morph uniforms and idle action time.

## Evidence

- `npm test`: 73 tests passed, including new asset binding and audible-signal regressions.
- `npm run lint` and `npm run build`: passed.
- Live NVIDIA speech on the running local demo produced a rendered mouth weight of 0.42779, returning to 0 after Stop speaking. Evidence: [GPU measurements](avatar-animation-evidence/live-rendered-mouth.json), [idle](avatar-animation-evidence/live-idle.png), [speaking](avatar-animation-evidence/live-speaking.png).
- The original bundle failed the GPU regression with a maximum mouth change of **0**.
- The fixed browser regression passed: mouth shapes varied on the GPU, Stop speaking returned them to the idle baseline, and a second reply animated again. The actual idle action clock progressed with **zero resets** before speech and across conversation updates, with two stable animation actions. [Measurements](avatar-animation-evidence/avatar-results.json).

Run the focused browser regression with `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:avatar`; optionally provide `CHROMIUM_EXECUTABLE_PATH` and `E2E_ARTIFACT_DIR`.

Lip motion remains an estimated text timeline shaped by audio intensity. This repair establishes visible movement and stable animation; it does not claim phoneme-accurate alignment.
