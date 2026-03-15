// Automatic Gain Control — pure state machine, no React dependencies

export const AGC_MAX_DECAY = 0.995;
export const AGC_MIN_RISE = 0.9999;
export const AGC_ATTACK = 0.1;
export const AGC_ATTACK_LEARN = 0.25; // Faster attack during learning phase
export const AGC_FLOOR = 0.002;
export const PEAK_MAX_DECAY = 0.9998;

export interface AgcState {
  max: number;
  min: number;
  peakMax: number;
}

export function createAgcState(savedMax = 0.01, savedMin = 0): AgcState {
  return {
    max: savedMax > 0 ? savedMax : 0.01,
    min: savedMin,
    peakMax: savedMax > 0 ? savedMax : 0.01,
  };
}

/** Rescale all AGC levels proportionally (e.g. after volume change) */
export function rescaleAgc(state: AgcState, ratio: number): void {
  state.max = Math.max(AGC_FLOOR, state.max * ratio);
  state.min = Math.max(0, state.min * ratio);
  state.peakMax = Math.max(state.max, state.peakMax * ratio);
}

/** Update global AGC envelope from smoothed RMS. Use `learning` for faster adaptation. */
export function updateGlobalAgc(state: AgcState, smoothed: number, learning = false): void {
  const attack = learning ? AGC_ATTACK_LEARN : AGC_ATTACK;

  if (smoothed > state.max) {
    state.max += (smoothed - state.max) * attack;
  } else {
    state.max *= AGC_MAX_DECAY;
  }

  if (smoothed < state.min || state.min === 0) {
    state.min = smoothed;
  } else {
    state.min += (smoothed - state.min) * (1 - AGC_MIN_RISE);
  }

  if (state.max > state.peakMax) {
    state.peakMax = state.max;
  } else {
    state.peakMax *= PEAK_MAX_DECAY;
  }
}

/** Compute the absolute-factor-scaled effective max */
export function getEffectiveMax(state: AgcState): number {
  const absoluteFactor = Math.min(1, Math.max(0.08, state.max / state.peakMax));
  return 100 * absoluteFactor;
}

/** Normalize a value using global AGC range */
export function normalizeValue(value: number, state: AgcState): number {
  const range = Math.max(AGC_FLOOR, state.max - state.min);
  return Math.min(1, Math.max(0, (value - state.min) / range));
}
