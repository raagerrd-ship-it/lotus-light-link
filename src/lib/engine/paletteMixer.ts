/**
 * Palette rotation logic — extracted from LightEngine for maintainability.
 * Zero-allocation: mutates state in-place, reuses result objects.
 */

import type { LightCalibration } from "./lightCalibration";

export type PaletteMode = 'off' | 'timed' | 'bass' | 'energy' | 'blend';

export interface PaletteState {
  index: number;
  tickCounter: number;
  bassWasHigh: boolean;
}

export function createPaletteState(): PaletteState {
  return { index: 0, tickCounter: 0, bassWasHigh: false };
}

export interface PaletteResult {
  color: [number, number, number];
  state: PaletteState;
}

// Reusable result object — mutated in place
const _result: PaletteResult = {
  color: [0, 0, 0],
  state: { index: 0, tickCounter: 0, bassWasHigh: false },
};

/** Copy state into reusable result and return it */
function emitResult(color: [number, number, number], state: PaletteState): PaletteResult {
  _result.color = color;
  _result.state = state;
  return _result;
}

/**
 * Original advancePalette — kept for standalone/test use.
 */
export function advancePalette(
  palette: [number, number, number][],
  state: PaletteState,
  mode: PaletteMode,
  cal: Pick<LightCalibration, 'paletteRotationSpeed'>,
  smoothedBass: number,
  rawEnergy: number,
  tickMs: number,
): PaletteResult | null {
  if (mode === 'off' || palette.length < 2) return null;
  const speed = Math.max(1, Math.round((cal.paletteRotationSpeed ?? 8) * (125 / tickMs)));
  return advancePaletteCore(palette, state, mode, speed, smoothedBass, rawEnergy);
}

/**
 * Fast version using precomputed timed speed — zero Math.round/division.
 */
export function advancePaletteFast(
  palette: [number, number, number][],
  state: PaletteState,
  mode: PaletteMode,
  preTimedSpeed: number,
  smoothedBass: number,
  rawEnergy: number,
): PaletteResult | null {
  if (mode === 'off' || palette.length < 2) return null;
  return advancePaletteCore(palette, state, mode, preTimedSpeed, smoothedBass, rawEnergy);
}

/** Shared core logic */
function advancePaletteCore(
  palette: [number, number, number][],
  state: PaletteState,
  mode: PaletteMode,
  timedSpeed: number,
  smoothedBass: number,
  rawEnergy: number,
): PaletteResult | null {
  const pLen = palette.length;

  if (mode === 'timed') {
    state.tickCounter++;
    if (state.tickCounter >= timedSpeed) {
      state.tickCounter = 0;
      state.index = (state.index + 1) % pLen;
    }
    return emitResult(palette[state.index], state);
  }

  if (mode === 'bass') {
    const isHigh = smoothedBass > 0.45;
    if (isHigh && !state.bassWasHigh) {
      state.index = (state.index + 1) % pLen;
    }
    state.bassWasHigh = isHigh;
    return emitResult(palette[state.index], state);
  }

  if (mode === 'energy') {
    const idx = Math.min(pLen - 1, (rawEnergy * pLen) | 0);
    state.index = idx;
    return emitResult(palette[idx], state);
  }

  if (mode === 'blend') {
    const clampedEnergy = Math.min(1, Math.max(0, rawEnergy));
    const pos = clampedEnergy * (pLen - 1);
    const lo = pos | 0;
    const hi = Math.min(pLen - 1, lo + 1);
    const t = pos - lo;
    const cLo = palette[lo];
    const cHi = palette[hi];
    _blendColor[0] = (cLo[0] + (cHi[0] - cLo[0]) * t + 0.5) | 0;
    _blendColor[1] = (cLo[1] + (cHi[1] - cLo[1]) * t + 0.5) | 0;
    _blendColor[2] = (cLo[2] + (cHi[2] - cLo[2]) * t + 0.5) | 0;
    state.index = lo;
    return emitResult(_blendColor, state);
  }

  return null;
}

// Reusable blend color tuple
const _blendColor: [number, number, number] = [0, 0, 0];
