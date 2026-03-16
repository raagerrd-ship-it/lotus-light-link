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

/** Extra moving-average smoothing. Returns new smoothed value and updated history buffer. */
export function extraSmooth(history: number[], newVal: number, windowSize: number): { smoothed: number; history: number[] } {
  if (windowSize <= 1) return { smoothed: newVal, history: [] };
  const buf = history.length >= windowSize ? history.slice(-(windowSize - 1)) : [...history];
  buf.push(newVal);
  const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
  return { smoothed: avg, history: buf };
}

/** Convert smoothing 0–100 to window size 1–20 */
export function smoothingToWindow(smoothing: number): number {
  return Math.max(1, Math.round(smoothing / 5));
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
  cal: Pick<LightCalibration, 'bassWeight' | 'dynamicDamping'>,
): { pct: number; newCenter: number } {
  let energyNorm = bassNorm * cal.bassWeight + midHiNorm * (1 - cal.bassWeight);

  const newCenter = dynamicCenter + (energyNorm - dynamicCenter) * 0.008;
  energyNorm = applyDynamics(energyNorm, newCenter, cal.dynamicDamping);

  const rawPct = (energyNorm * effectiveMax) / 100;
  const pct = Math.round(rawPct * 100);

  return { pct, newCenter };
}
