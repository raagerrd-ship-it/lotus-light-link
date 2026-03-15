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

/** Apply dynamic damping (expansion or compression around adaptive center) */
export function applyDynamics(
  energyNorm: number,
  center: number,
  dynamicDamping: number,
): number {
  let result = energyNorm;

  if (dynamicDamping < 0) {
    const amount = Math.min(1, Math.abs(dynamicDamping) / 2);
    const gain = 1 + amount * 10;
    const centered = result - center;
    const denom = Math.tanh(0.5 * gain) || 1;
    const expanded = center + 0.5 * (Math.tanh(centered * gain) / denom);
    result = result * (1 - amount) + expanded * amount;
  } else if (dynamicDamping > 0) {
    const amount = Math.min(1, dynamicDamping / 3);
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
