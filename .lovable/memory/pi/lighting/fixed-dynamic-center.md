---
name: Fast dynamicCenter
description: PiLightEngine applyDynamics uses a fixed center=0.5 by default so sustained energy rises stay visible instead of being sucked back into a running average.
type: feature
---

`dynamicCenter` no longer chases the music with a 5-second moving average. Default `centerAdaptSeconds: 999` in `pi/src/piEngine.ts` keeps the center frozen at 0.5, so `applyDynamics` expands absolute energy around a fixed point. Sustained build-ups stay up, only fast transients are expanded around the midpoint.

- Config key: `centerAdaptSeconds` (seconds). 0 or 999 = effectively fixed at 0.5. Low values like 5 reproduce the old adaptive normalizing behavior.
- The `centerAlpha` / `centerAlphaFft` precomputed factors are derived from `1 - exp(-dt / centerAdaptSeconds)`.
- When fixed, `intensityInfluence` still works but only on the rare adaptive path; it has no effect when the center is frozen.
- Clamp 0.2–0.7 is only applied while adapting; fixed mode holds exactly 0.5.

File: `pi/src/piEngine.ts` (`computeTickConstants`, `onFluxReady`, `applyDynamics`).
Version: 1.0.751.
