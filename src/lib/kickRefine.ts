/**
 * Kick refinement: removes false-positive kicks via
 * local contrast filtering, debouncing, and optional beat-grid snapping.
 */

import type { EnergySample } from "./energyInterpolate";
import type { BeatGrid } from "./bpmEstimate";

/**
 * Refine kick markers on an energy curve.
 * 1. Threshold: mark candidates above 70% of global peak
 * 2. Local contrast: candidate must be ≥1.3× local average (±5 samples)
 * 3. Debounce: minimum 100ms between kicks, keep strongest in cluster
 * 4. Beat-snap bonus: if beatGrid exists, prefer kicks near beats (±50ms)
 */
export function refineKicks(
  samples: EnergySample[],
  beatGrid?: BeatGrid | null,
): void {
  // Reset all kicks
  for (const s of samples) {
    s.kick = false;
    s.kickT = undefined;
  }

  const globalPeak = samples.reduce((max, s) => Math.max(max, s.rawRms), 0);
  if (globalPeak <= 0) return;

  const kickThreshold = globalPeak * 0.70;
  const contrastRadius = 5;
  const contrastFactor = 1.3;
  const debounceMs = 100;
  const beatSnapMs = 50;

  // Step 1+2: find candidates that pass threshold AND local contrast
  interface Candidate {
    idx: number;
    t: number;
    rms: number;
    nearBeat: boolean;
  }

  const candidates: Candidate[] = [];

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.rawRms < kickThreshold) continue;

    // Local contrast: compare to average of neighbors
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - contrastRadius); j <= Math.min(samples.length - 1, i + contrastRadius); j++) {
      if (j === i) continue;
      sum += samples[j].rawRms;
      count++;
    }
    const localAvg = count > 0 ? sum / count : 0;
    if (localAvg > 0 && s.rawRms < localAvg * contrastFactor) continue;

    // Step 4: check beat proximity
    let nearBeat = false;
    if (beatGrid && beatGrid.beats.length > 0) {
      const beatSnapSec = beatSnapMs / 1000;
      for (const b of beatGrid.beats) {
        if (Math.abs(s.t - b) < beatSnapSec) {
          nearBeat = true;
          break;
        }
      }
    }

    candidates.push({ idx: i, t: s.t, rms: s.rawRms, nearBeat });
  }

  // Step 3: debounce — keep strongest in each 100ms cluster
  // If beatGrid exists, prefer beat-aligned kicks in tiebreaks
  const debounceSec = debounceMs / 1000;
  const kept: Candidate[] = [];

  for (const c of candidates) {
    if (kept.length === 0) {
      kept.push(c);
      continue;
    }

    const last = kept[kept.length - 1];
    if (c.t - last.t < debounceSec) {
      // Within debounce window — keep the better one
      const cScore = c.rms * (c.nearBeat ? 1.2 : 1.0);
      const lastScore = last.rms * (last.nearBeat ? 1.2 : 1.0);
      if (cScore > lastScore) {
        kept[kept.length - 1] = c;
      }
    } else {
      kept.push(c);
    }
  }

  // Apply to samples
  for (const k of kept) {
    samples[k.idx].kick = true;
    samples[k.idx].kickT = samples[k.idx].t;
  }
}
