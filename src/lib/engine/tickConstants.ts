/**
 * Pre-computed tick-rate & calibration-dependent constants.
 * Eliminates ~15 Math.pow() calls per tick by caching values
 * that only change when tickMs or calibration changes.
 */

import type { LightCalibration } from "./lightCalibration";

export interface TickConstants {
  tickMs: number;

  // smooth() — precomputed adjusted alphas
  attackAlpha: number;   // 1 - (1 - cal.attackAlpha)^(tickMs/125)
  releaseAlpha: number;  // 1 - (1 - cal.releaseAlpha)^(tickMs/125)

  // onset detector
  onsetDecay: number;      // 0.10^(tickMs/1000)
  onsetRiseAlpha: number;  // 1 - 0.15^(tickMs/125)

  // AGC decay rates (per-tick from per-second)
  agcDecayNormal: number;
  agcDecayMedium: number;
  agcDecayFast: number;
  quietMediumTicks: number;
  quietFastTicks: number;

  // brightness center tracking
  centerAlpha: number;  // 1 - (1 - 0.008)^(tickMs/125)

  // extra smoothing (only valid when cal.smoothing > 0)
  extraSmoothAlpha: number;

  // palette timed speed
  paletteTimedSpeed: number;

  // color calibration fast-path flag
  gammaIsUnity: boolean;
}

// Per-second decay constants (from agc.ts)
const AGC_MAX_DECAY_PER_SEC = 0.99840;
const AGC_QUIET_DECAY_MEDIUM_PER_SEC = 0.98410;
const AGC_QUIET_DECAY_FAST_PER_SEC = 0.92274;
const QUIET_MS_MEDIUM = 2000;
const QUIET_MS_FAST = 5000;

/** Compute all tick constants. Call when tickMs or cal changes. */
export function computeTickConstants(tickMs: number, cal: LightCalibration): TickConstants {
  const ratio = tickMs / 125;
  const secRatio = tickMs / 1000;

  // Extra smoothing alpha
  const sm = cal.smoothing ?? 0;
  let extraSmoothAlpha = 0;
  if (sm > 0) {
    const alphaRef = Math.exp(-sm * 0.04);
    extraSmoothAlpha = Math.pow(alphaRef, ratio);
  }

  return {
    tickMs,
    attackAlpha: 1 - Math.pow(1 - cal.attackAlpha, ratio),
    releaseAlpha: 1 - Math.pow(1 - cal.releaseAlpha, ratio),
    onsetDecay: Math.pow(0.10, secRatio),
    onsetRiseAlpha: 1 - Math.pow(0.15, ratio),
    agcDecayNormal: Math.pow(AGC_MAX_DECAY_PER_SEC, secRatio),
    agcDecayMedium: Math.pow(AGC_QUIET_DECAY_MEDIUM_PER_SEC, secRatio),
    agcDecayFast: Math.pow(AGC_QUIET_DECAY_FAST_PER_SEC, secRatio),
    quietMediumTicks: Math.round(QUIET_MS_MEDIUM / tickMs),
    quietFastTicks: Math.round(QUIET_MS_FAST / tickMs),
    centerAlpha: 1 - Math.pow(1 - 0.008, ratio),
    extraSmoothAlpha,
    paletteTimedSpeed: Math.max(1, Math.round((cal.paletteRotationSpeed ?? 8) * (125 / tickMs))),
    gammaIsUnity: cal.gammaR === 1.0 && cal.gammaG === 1.0 && cal.gammaB === 1.0,
  };
}
