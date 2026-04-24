---
name: Onset-tuning via cal-fält
description: Två cal-fält styr beat-detektion — onsetThreshold (1.3-2.5) och onsetRefractoryMs (50-250). Exponeras som slidrar i PiMobile under Mjukhet-blocket.
type: feature
---
Beat-detektion (`processOnset` i pi/src/piEngine.ts) är runtime-tunbar via två fält i `LightCalibration`:

- **`onsetThreshold`** (default 1.8, range 1.3–2.5)
  Multiplikator på rullande median av spectral flux: `flux > median × onsetThreshold + 0.008`
  Lägre = fler beats triggar (känsligare). Högre = bara tydliga slag.

- **`onsetRefractoryMs`** (default 110ms, range 50–250ms)
  Minsta tid mellan onsets. Räknas dynamiskt om till FFT-frames @ 100Hz:
  `refractoryFrames = round(onsetRefractoryMs / 10)` (clampad till min 1).
  Högt värde = lugnare puls även på snabba beats.

**Profil-defaults** (sync mellan `pi/src/configServer.ts` DEFAULT_PROFILES och `src/pages/PiMobile.tsx` PRESET_CALS):
- Lugn:   threshold 2.0, refractory 150ms
- Normal: threshold 1.8, refractory 110ms
- Party:  threshold 1.6, refractory 90ms
- Custom: threshold 1.8, refractory 110ms

**UI**: Slidrar i `SLIDER_CONFIG` direkt under `softness` (= i Mjukhet/Attack-blocket). Värden persisteras via `/api/profiles` PUT precis som övriga cal-fält. Forward-kompat — gamla profiler utan fälten får defaults via merge i `loadProfilesFile` och `loadCalibration`.
