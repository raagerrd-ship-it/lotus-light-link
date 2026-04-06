// Brightness calculation — smoothing, dynamics, perceptual curve, final percentage

import type { LightCalibration } from "./lightCalibration";
import { getDimmingGamma } from "./bledom";

export interface SmoothedBands {
  bass: number;
  midHi: number;
}

/** Apply attack/release smoothing to a single value */
export function smooth(prev: number, raw: number, attackAlpha: number, releaseAlpha: number): number {
  const alpha = raw > prev ? attackAlpha : releaseAlpha;
  return prev + alpha * (raw - prev);
}

/** Symmetric exponential low-pass filter for smooth curves between values.
 *  Unlike attack/release (asymmetric), this smooths equally in both directions
 *  giving naturally rounded transitions — like cubic spline interpolation on a chart.
 *  smoothing 0 = bypass, 100 = very smooth curves. */
export function extraSmooth(prev: number, newVal: number, smoothing: number): number {
  if (smoothing <= 0) return newVal;
  const alpha = Math.exp(-smoothing * 0.04);
  return prev + alpha * (newVal - prev);
}

/** Apply dynamic damping (expansion or compression around adaptive center) */
export function applyDynamics(
  energyNorm: number,
  center: number,
  dynamicDamping: number,
): number {
  let result = energyNorm;

  if (dynamicDamping > 0) {
    // Expansion: power curve pushes values away from center.
    // Gain allows output > 1.0 so the light can exceed the raw input level.
    const amount = Math.min(1, dynamicDamping / 2);
    const exponent = 1 / (1 + amount * 4);
    const range = result >= center ? (1 - center) || 0.5 : center || 0.5;
    const normalized = (result - center) / range;
    const expanded = Math.sign(normalized) * Math.pow(Math.abs(normalized), exponent);
    // Apply gain that scales with amount — up to 1.5× overshoot
    const gain = 1 + amount * 0.5;
    result = center + expanded * range * gain;
    // Soft-clamp: allow up to ~1.4 but taper gently
    const ceiling = 1 + amount * 0.4;
    if (result > ceiling) result = ceiling + (result - ceiling) * 0.2;
  } else if (dynamicDamping < 0) {
    const amount = Math.min(1, Math.abs(dynamicDamping) / 3);
    const compression = 1 / (1 + amount * 4);
    result = center + (result - center) * compression;
  }

  return Math.max(0, result);
}

/** Perceptual brightness curve — maps linear energy to perceived brightness.
 *  Uses the user's dimming gamma setting for consistent behavior.
 *  Input/output: 0-100 */
export function perceptualBrightness(pct: number, floor: number = 0): number {
  if (pct <= floor) return floor;
  if (pct >= 100) return 100;
  const norm = (pct - floor) / (100 - floor);
  const perceived = Math.pow(norm, getDimmingGamma());
  return floor + perceived * (100 - floor); // float — caller rounds
}

/** Compute final brightness percentage from smoothed bands */
export function computeBrightnessPct(
  bassNorm: number,
  midHiNorm: number,
  effectiveMax: number,
  dynamicCenter: number,
  cal: Pick<LightCalibration, 'bassWeight' | 'dynamicDamping' | 'brightnessFloor' | 'perceptualCurve'>,
  fluxBoost: number = 0,
): { pct: number; newCenter: number } {
  let energyNorm = bassNorm * cal.bassWeight + midHiNorm * (1 - cal.bassWeight);

  // Add spectral flux boost for transients/onsets
  energyNorm = Math.min(1, energyNorm + fluxBoost);

  const newCenter = dynamicCenter + (energyNorm - dynamicCenter) * 0.008;
  energyNorm = applyDynamics(energyNorm, newCenter, cal.dynamicDamping);

  const rawPct = (energyNorm * effectiveMax) / 100;
  const floor = cal.brightnessFloor ?? 0;
  let pct = Math.max(floor, rawPct * 100);

  if (cal.perceptualCurve) {
    pct = perceptualBrightness(pct, floor);
  }

  // Return float — let caller round at the last possible moment (after extraSmooth)
  return { pct: Math.max(floor, pct), newCenter };
}
