

## Analysis of Sync Diag Screenshot

The image clearly shows:
- **Orange (mic)**: Sharp, high kick peaks with lots of transient detail
- **Green (curve)**: Smoother, lower amplitude — kicks are dampened

Two distinct problems:

### Problem 1: Kick transients are too soft in the baked curve

In `process-songs/index.ts`, the baked curve applies EMA smoothing *before* the kick boost. The EMA has already flattened the kick transient by the time the 40% headroom boost is applied. Meanwhile, the live mic AGC reacts to the *raw* sharp transient.

**Fix**: For kick-marked samples, bypass or reduce EMA smoothing so the kick transient passes through sharper. Specifically:
- When `sample.kick` is true, blend in more of the raw RMS value *before* EMA smoothing (e.g., use a much higher attack alpha like 0.8 instead of the normal cal.attackAlpha)
- Increase the kick headroom boost from 40% to 60%

### Problem 2: Amplitude scaling mismatch

The green line sits generally lower than orange. The baked curve AGC state evolves differently from the live mic AGC because it processes the entire song sequentially (no real gaps, no volume changes). This means `absoluteFactor` and `agcPeakMax` track differently.

**Fix**: After computing the full baked curve, normalize its overall amplitude range to match the theoretical mic output range. Specifically, scale the curve so its p95 brightness matches roughly 85-90% of maxBrightness (matching typical mic behavior).

### Implementation Plan

1. **Sharper kicks in baked curve** (`supabase/functions/process-songs/index.ts`):
   - In the per-sample loop, when `sample.kick` is true, use a much faster attack alpha (0.8) for EMA so the transient passes through
   - Increase kick headroom boost from 0.4 to 0.6

2. **Amplitude normalization pass** (`supabase/functions/process-songs/index.ts`):
   - After computing all brightness values, find p95 brightness
   - If p95 is significantly below `maxBrightness * 0.85`, scale all values up proportionally
   - This ensures the green line's amplitude envelope matches the orange line

3. **Re-bake existing curves** (database migration to clear `brightness_curve` so they regenerate)

