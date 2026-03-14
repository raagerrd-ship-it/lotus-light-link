/**
 * Post-recording song analysis functions.
 * Computes dynamic range, transitions, and beat strengths from recorded energy curves.
 */

import type { EnergySample } from "./energyInterpolate";
import { curvePeakRms, interpolateEnergy } from "./energyInterpolate";
import type { SongSection } from "./sectionLighting";
import type { BeatGrid } from "./bpmEstimate";

// ── Dynamic Range ──

export interface DynamicRange {
  p10: number;  // 10th percentile rawRms
  p50: number;  // median rawRms
  p90: number;  // 90th percentile rawRms
  peak: number; // absolute peak rawRms
}

export function analyzeDynamicRange(curve: EnergySample[]): DynamicRange {
  if (curve.length === 0) return { p10: 0, p50: 0, p90: 0, peak: 0 };
  const sorted = curve.map(s => s.rawRms).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.floor(sorted.length * p)] ?? 0;
  return {
    p10: pct(0.10),
    p50: pct(0.50),
    p90: pct(0.90),
    peak: sorted[sorted.length - 1],
  };
}

// ── Transitions ──

export interface Transition {
  time: number;           // transition timestamp (seconds)
  fromType: string;       // section type ending
  toType: string;         // section type starting
  type: 'hard' | 'fade';  // transition style
  crossfadeMs: number;    // recommended crossfade duration
  energyDelta: number;    // normalized energy change (-1 to 1)
}

/**
 * Analyze transitions between sections.
 * Compares average energy in last 0.5s of section A vs first 0.5s of section B.
 */
export function analyzeTransitions(sections: SongSection[], curve: EnergySample[]): Transition[] {
  if (!sections || sections.length < 2 || curve.length < 10) return [];

  const peak = curvePeakRms(curve);
  if (peak === 0) return [];

  const transitions: Transition[] = [];
  const WINDOW = 0.5; // seconds to sample on each side

  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i];
    const b = sections[i + 1];
    const transTime = a.end;

    // Sample energy on each side of the transition
    const aEnergy = avgEnergyInRange(curve, peak, transTime - WINDOW, transTime);
    const bEnergy = avgEnergyInRange(curve, peak, transTime, transTime + WINDOW);

    const delta = bEnergy - aEnergy;
    const absDelta = Math.abs(delta);

    // Hard cut: >15% energy change, Fade: ≤15%
    const isHard = absDelta > 0.15;

    transitions.push({
      time: transTime,
      fromType: a.type,
      toType: b.type,
      type: isHard ? 'hard' : 'fade',
      crossfadeMs: isHard ? 50 : Math.round(300 + (1 - absDelta / 0.15) * 700),
      energyDelta: Math.round(delta * 100) / 100,
    });
  }

  return transitions;
}

function avgEnergyInRange(curve: EnergySample[], peak: number, tStart: number, tEnd: number): number {
  let sum = 0;
  let count = 0;
  for (const s of curve) {
    if (s.t >= tStart && s.t < tEnd) {
      sum += s.rawRms / peak;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ── Beat Strengths ──

/**
 * Analyze per-beat intensity from the beat grid.
 * Returns normalized strength (0-1) for each beat, with downbeats (beat 0 mod 4) naturally stronger.
 */
export function analyzeBeatStrengths(curve: EnergySample[], beatGrid: BeatGrid): number[] {
  if (!beatGrid || beatGrid.beats.length === 0 || curve.length < 10) return [];

  const peak = curvePeakRms(curve);
  if (peak === 0) return [];

  const strengths: number[] = [];
  for (const beatTime of beatGrid.beats) {
    const e = interpolateEnergy(curve, beatTime);
    strengths.push(e);
  }

  // Normalize to 0-1 range within the beat strengths
  const maxStrength = Math.max(...strengths, 0.001);
  return strengths.map(s => Math.round((s / maxStrength) * 100) / 100);
}

// ── Build-up Ramp Regression ──

export interface RampStats {
  slope: number;  // energy increase per second
  r2: number;     // goodness of fit (0-1)
}

/**
 * Linear regression over a time window of energy samples.
 * Returns slope and R² to quantify build-up ramps.
 */
export function computeRamp(curve: EnergySample[], tStart: number, tEnd: number): RampStats {
  const peak = curvePeakRms(curve);
  if (peak === 0) return { slope: 0, r2: 0 };

  const points: { x: number; y: number }[] = [];
  for (const s of curve) {
    if (s.t >= tStart && s.t <= tEnd) {
      points.push({ x: s.t - tStart, y: s.rawRms / peak });
    }
  }

  if (points.length < 3) return { slope: 0, r2: 0 };

  // Linear regression: y = a + b*x
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
    sumYY += p.y * p.y;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;

  // R²
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  const intercept = (sumY - slope * sumX) / n;
  for (const p of points) {
    const predicted = intercept + slope * p.x;
    ssRes += (p.y - predicted) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }

  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  return {
    slope: Math.round(slope * 1000) / 1000,
    r2: Math.round(r2 * 100) / 100,
  };
}
