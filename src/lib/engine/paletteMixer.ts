/**
 * Palette rotation logic — extracted from LightEngine for maintainability.
 * Pure functions, no side effects.
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

/**
 * Advance palette and return the current color.
 * Returns null if palette mode is off or palette has < 2 colors.
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

  const pLen = palette.length;
  const s = { ...state };

  if (mode === 'timed') {
    s.tickCounter++;
    const speed = Math.max(1, Math.round((cal.paletteRotationSpeed ?? 8) * (125 / tickMs)));
    if (s.tickCounter >= speed) {
      s.tickCounter = 0;
      s.index = (s.index + 1) % pLen;
    }
    return { color: palette[s.index], state: s };
  }

  if (mode === 'bass') {
    const isHigh = smoothedBass > 0.45;
    if (isHigh && !s.bassWasHigh) {
      s.index = (s.index + 1) % pLen;
    }
    s.bassWasHigh = isHigh;
    return { color: palette[s.index], state: s };
  }

  if (mode === 'energy') {
    const idx = Math.min(pLen - 1, Math.floor(rawEnergy * pLen));
    s.index = idx;
    return { color: palette[idx], state: s };
  }

  if (mode === 'blend') {
    const clampedEnergy = Math.min(1, Math.max(0, rawEnergy));
    const pos = clampedEnergy * (pLen - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(pLen - 1, lo + 1);
    const t = pos - lo;
    const cLo = palette[lo];
    const cHi = palette[hi];
    const color: [number, number, number] = [
      Math.round(cLo[0] + (cHi[0] - cLo[0]) * t),
      Math.round(cLo[1] + (cHi[1] - cLo[1]) * t),
      Math.round(cLo[2] + (cHi[2] - cLo[2]) * t),
    ];
    s.index = lo;
    return { color, state: s };
  }

  return null;
}
