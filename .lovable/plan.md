

## Problem

When a saved energy curve exists, the mic is still used for two things beyond sync:
1. **Curve blending** (lines 392-410): mic data is blended 20% into the saved curve, gradually corrupting it with ambient noise
2. **AGC normalization** (lines 420-456): the curve-derived RMS goes through mic-oriented AGC smoothing (attack/release/min/max tracking), adding unnecessary lag and making the output sensitive to volume fluctuations

The user's intent: once a curve is saved, the mic should **only** correlate beats for auto-sync. The lamp brightness should come purely from the deterministic curve data, making it immune to ambient noise.

## Plan

### 1. Remove mic-to-curve blending in curve mode
In the curve-driven branch (lines 392-410 in MicPanel.tsx), remove the code that records blended samples back into `recordedSamplesRef`. Keep only the auto-sync `reportLiveOnset` call.

### 2. Simplify normalization for curve mode  
The curve already produces a normalized energy value (0–1) via `interpolateSample`. Instead of feeding it through the mic-oriented AGC pipeline (which tracks min/max/decay and distorts the curve's intended dynamics), in curve mode:
- Skip AGC entirely — map the curve's `e` value directly to brightness
- Still apply `dynamicDamping`, section adjustments, beat pulse, and build-up logic
- Still apply volume compensation (recVol vs curVol)

This means the brightness calculation in curve mode becomes:
```
normalized = clamp(curveEnergy * volumeCompensation, 0, 1)
normalized = pow(normalized, dynamicDamping)
pct = minBrightness + normalized * (maxBrightness - minBrightness)
// then section/beat/build-up adjustments as before
```

### 3. Keep mic active but minimal
The mic stays active in curve mode solely for:
- `reportLiveOnset()` — feeding the auto-sync beat correlator
- Reading `smoothedRef.current` for onset comparison baseline

No mic data gets written back to the curve.

### Files changed
- `src/components/MicPanel.tsx` — restructure the tick loop to bifurcate curve vs mic normalization paths

