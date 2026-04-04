// Brightness calculation — smoothing, dynamics, perceptual curve, final percentage

import type { LightCalibration } from "./lightCalibration";

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
    const amount = Math.min(1, dynamicDamping / 2);
    const exponent = 1 / (1 + amount * 4);
    const range = result >= center ? (1 - center) || 0.5 : center || 0.5;
    const normalized = (result - center) / range;
    const expanded = Math.sign(normalized) * Math.pow(Math.abs(normalized), exponent);
    const softLimit = 1.2 + amount * 0.8;
    const softened = Math.tanh(expanded * softLimit) / Math.tanh(softLimit);
    result = center + softened * range;
  } else if (dynamicDamping < 0) {
    const amount = Math.min(1, Math.abs(dynamicDamping) / 3);
    const compression = 1 / (1 + amount * 4);
    result = center + (result - center) * compression;
  }

  return Math.max(0, Math.min(1, result));
}

/** Perceptual brightness curve — maps linear energy to perceived brightness.
 *  Uses CIE lightness approximation (gamma ~2.2) so that equal steps
 *  in pct produce equal perceived changes in light output.
 *  Input/output: 0-100 */
export function perceptualBrightness(pct: number): number {
  if (pct <= 0) return 0;
  if (pct >= 100) return 100;
  const norm = pct / 100;
  // CIE L* inspired curve: slight S-curve that lifts shadows
  // and compresses highlights for more perceptually even steps
  const perceived = Math.pow(norm, 0.45); // inverse gamma ≈ 2.2
  return Math.round(perceived * 100);
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
  let pct = Math.max(floor, Math.round(rawPct * 100));

  if (cal.perceptualCurve) {
    pct = perceptualBrightness(pct);
  }

  return { pct: Math.max(floor, pct), newCenter };
}
