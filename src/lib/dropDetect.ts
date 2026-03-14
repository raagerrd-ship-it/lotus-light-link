/**
 * Drop detection from energy curve.
 * Detects rapid energy increases (build-up → drop pattern) by looking for
 * sustained low energy followed by a sharp rise.
 */

import type { EnergySample } from "./energyInterpolate";
import { computeRamp } from "./songAnalysis";

export interface Drop {
  t: number;        // drop hit time (seconds)
  intensity: number; // 0-1 how strong the drop is
  buildStart: number; // when the build-up started
  rampSlope?: number;  // energy increase per second during build-up
  rampR2?: number;     // regression fit quality (0-1, >0.5 = clear ramp)
}

/**
 * Detect drops in an energy curve.
 * A drop is defined as: a period of relatively low/declining energy
 * followed by a rapid energy increase within a short window.
 */
export function detectDrops(curve: EnergySample[]): Drop[] {
  if (curve.length < 50) return [];

  const drops: Drop[] = [];
  const windowSec = 2.0;    // look-back window for build-up detection
  const riseFactor = 2.5;   // energy must rise by this factor
  const minDropGap = 8.0;   // minimum seconds between drops
  const smoothWindow = 5;   // samples to smooth over

  // Smooth energy to reduce noise
  const smoothed = smoothEnergy(curve, smoothWindow);

  // Compute rolling stats
  for (let i = 20; i < smoothed.length - 5; i++) {
    const t = curve[i].t;
    const e = smoothed[i];

    // Find the average energy in the window before this point
    const windowStart = t - windowSec;
    let windowSum = 0;
    let windowCount = 0;
    let windowMin = 1;
    for (let j = i - 1; j >= 0 && curve[j].t >= windowStart; j--) {
      windowSum += smoothed[j];
      windowCount++;
      if (smoothed[j] < windowMin) windowMin = smoothed[j];
    }

    if (windowCount < 3) continue;
    const windowAvg = windowSum / windowCount;

    // Check for rapid rise: current energy vs recent average
    if (windowAvg < 0.01) continue; // avoid division by near-zero
    const riseRatio = e / windowAvg;

    if (riseRatio >= riseFactor && e > 0.4) {
      // Check minimum gap from last drop
      const lastDrop = drops[drops.length - 1];
      if (lastDrop && (t - lastDrop.t) < minDropGap) {
        // Keep the stronger one
        if (riseRatio > lastDrop.intensity * riseFactor) {
          const bsT = curve[Math.max(0, i - windowCount)].t;
          const ramp = computeRamp(curve, bsT, t);
          drops[drops.length - 1] = {
            t,
            intensity: Math.min(1, (riseRatio - riseFactor) / riseFactor),
            buildStart: bsT,
            rampSlope: ramp.slope,
            rampR2: ramp.r2,
          };
        }
        continue;
      }

      const buildStartT = curve[Math.max(0, i - windowCount)].t;
      const ramp = computeRamp(curve, buildStartT, t);
      drops.push({
        t,
        intensity: Math.min(1, (riseRatio - riseFactor) / riseFactor),
        buildStart: buildStartT,
        rampSlope: ramp.slope,
        rampR2: ramp.r2,
      });
    }
  }

  return drops;
}

/**
 * Check if we're currently in a drop moment (within durationMs of a drop hit).
 */
export function isInDrop(drops: Drop[], timeSec: number, durationMs = 3000): boolean {
  const durSec = durationMs / 1000;
  for (const drop of drops) {
    if (timeSec >= drop.t && timeSec < drop.t + durSec) return true;
  }
  return false;
}

/**
 * Check if we're in a build-up phase leading to a drop.
 * Returns 0-1 intensity (0 = not in build-up, 1 = about to drop).
 */
export function getBuildUpIntensity(drops: Drop[], timeSec: number): number {
  for (const drop of drops) {
    if (timeSec >= drop.buildStart && timeSec < drop.t) {
      const total = drop.t - drop.buildStart;
      if (total <= 0) continue;
      const progress = (timeSec - drop.buildStart) / total;

      // Use ramp regression for smoother exponential build if available
      if (drop.rampR2 != null && drop.rampR2 > 0.4 && drop.rampSlope != null && drop.rampSlope > 0) {
        // Exponential ramp: slow start, accelerating toward drop
        const expProgress = Math.pow(progress, 1.5 + drop.rampR2);
        return Math.min(1, expProgress * drop.intensity);
      }

      return Math.min(1, progress * drop.intensity);
    }
  }
  return 0;
}

function smoothEnergy(curve: EnergySample[], window: number): number[] {
  const result = new Array(curve.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < curve.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(curve.length - 1, i + half); j++) {
      sum += curve[j].rawRms;
      count++;
    }
    result[i] = sum / count;
  }
  return result;
}
