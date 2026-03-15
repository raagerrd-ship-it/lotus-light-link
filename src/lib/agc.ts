// Automatic Gain Control — pure state machine, no React dependencies

export const AGC_MAX_DECAY = 0.995;
export const AGC_MIN_RISE = 0.9999;
export const AGC_ATTACK = 0.1;
export const AGC_FLOOR = 0.002;
export const PEAK_MAX_DECAY = 0.9998;

export interface AgcState {
  max: number;
  min: number;
  peakMax: number;
  bassMax: number;
  bassMin: number;
  midHiMax: number;
  midHiMin: number;
}

export function createAgcState(savedMax = 0.01, savedMin = 0): AgcState {
  return {
    max: savedMax > 0 ? savedMax : 0.01,
    min: savedMin,
    peakMax: savedMax > 0 ? savedMax : 0.01,
    bassMax: 0.01,
    bassMin: 0,
    midHiMax: 0.01,
    midHiMin: 0,
  };
}

/** Rescale all AGC levels proportionally (e.g. after volume change) */
export function rescaleAgc(state: AgcState, ratio: number): void {
  state.max = Math.max(AGC_FLOOR, state.max * ratio);
  state.min = Math.max(0, state.min * ratio);
  state.peakMax = Math.max(state.max, state.peakMax * ratio);
  state.bassMax = Math.max(AGC_FLOOR, state.bassMax * ratio);
  state.bassMin = Math.max(0, state.bassMin * ratio);
  state.midHiMax = Math.max(AGC_FLOOR, state.midHiMax * ratio);
  state.midHiMin = Math.max(0, state.midHiMin * ratio);
}

/** Update global AGC envelope from smoothed RMS */
export function updateGlobalAgc(state: AgcState, smoothed: number): void {
  if (smoothed > state.max) {
    state.max += (smoothed - state.max) * AGC_ATTACK;
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

/** Update a single band's AGC max/min */
export function updateBandAgc(
  value: number,
  state: AgcState,
  band: 'bass' | 'midHi',
  attack: number,
  decay: number,
): void {
  const maxKey = band === 'bass' ? 'bassMax' : 'midHiMax';
  const minKey = band === 'bass' ? 'bassMin' : 'midHiMin';

  if (value > state[maxKey]) {
    state[maxKey] += (value - state[maxKey]) * attack;
  } else {
    state[maxKey] *= decay;
  }
  if (value < state[minKey] || state[minKey] === 0) {
    state[minKey] = value;
  } else {
    state[minKey] += (value - state[minKey]) * 0.001;
  }
}

/** Compute the absolute-factor-scaled effective max */
export function getEffectiveMax(state: AgcState): number {
  const absoluteFactor = Math.min(1, Math.max(0.08, state.max / state.peakMax));
  return 100 * absoluteFactor;
}

/** Normalize a band value using its AGC range */
export function normalizeBand(value: number, state: AgcState, band: 'bass' | 'midHi'): number {
  const max = band === 'bass' ? state.bassMax : state.midHiMax;
  const min = band === 'bass' ? state.bassMin : state.midHiMin;
  const range = Math.max(AGC_FLOOR, max - min);
  return Math.min(1, Math.max(0, (value - min) / range));
}
