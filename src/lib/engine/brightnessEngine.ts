// Brightness calculation — smoothing, dynamics, final percentage

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
  // Alpha from 1.0 (no filter) to 0.05 (heavy smoothing)
  // Using exponential curve for natural feel
  const alpha = Math.exp(-smoothing * 0.04);  // 0→1.0, 50→0.135, 100→0.018
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
    // Positive = expand dynamics (more contrast both up AND down)
    // Power curve pushes away from center, tanh soft-clips the extremes
    const amount = Math.min(1, dynamicDamping / 2);
    const exponent = 1 / (1 + amount * 4);
    // Asymmetric range: above center uses (1-center), below uses center
    // This prevents net upward drift from expansion
    const range = result >= center ? (1 - center) || 0.5 : center || 0.5;
    const normalized = (result - center) / range; // -1..1
    const expanded = Math.sign(normalized) * Math.pow(Math.abs(normalized), exponent);
    // Soft-limit: tanh squashes extremes so it doesn't just pin at 0%/100%
    const softLimit = 1.2 + amount * 0.8;
    const softened = Math.tanh(expanded * softLimit) / Math.tanh(softLimit);
    result = center + softened * range;
  } else if (dynamicDamping < 0) {
    // Negative = compress dynamics (less contrast)
    const amount = Math.min(1, Math.abs(dynamicDamping) / 3);
    const compression = 1 / (1 + amount * 4);
    result = center + (result - center) * compression;
  }

  return Math.max(0, Math.min(1, result));
}

/** Compute final brightness percentage from smoothed bands */
export function computeBrightnessPct(
  bassNorm: number,
  midHiNorm: number,
  effectiveMax: number,
  dynamicCenter: number,
  cal: Pick<LightCalibration, 'bassWeight' | 'dynamicDamping' | 'brightnessFloor'>,
): { pct: number; newCenter: number } {
  let energyNorm = bassNorm * cal.bassWeight + midHiNorm * (1 - cal.bassWeight);

  const newCenter = dynamicCenter + (energyNorm - dynamicCenter) * 0.008;
  energyNorm = applyDynamics(energyNorm, newCenter, cal.dynamicDamping);

  const rawPct = (energyNorm * effectiveMax) / 100;
  const floor = cal.brightnessFloor ?? 0;
  const pct = Math.max(floor, Math.round(rawPct * 100));

  return { pct, newCenter };
}
