/**
 * Onset detection via spectral-flux peak-picking.
 *
 * CPU cost: sorting ~7 numbers + 2 comparisons per tick — negligible.
 */

import type { TickConstants } from "./tickConstants";

const TARGET_LOOKBACK_MS = 175;
const DEFAULT_MULTIPLIER = 1.5;
const DEFAULT_OFFSET = 0.005;

export interface OnsetState {
  /** Circular buffer of recent flux values */
  buffer: number[];
  /** Current write position */
  pos: number;
  /** Buffer size (computed from tickMs) */
  size: number;
  /** Previous flux value (for local-max check) */
  prevFlux: number;
  /** Current onset boost level (decays exponentially) */
  boost: number;
  /** Shaped envelope target — decays to create rounded peak */
  target: number;
}

export function createOnsetState(tickMs: number = 125): OnsetState {
  const size = Math.max(3, Math.round(TARGET_LOOKBACK_MS / tickMs));
  return {
    buffer: new Array(size).fill(0),
    pos: 0,
    size,
    prevFlux: 0,
    boost: 0,
    target: 0,
  };
}

/** Resize buffer if tickMs changed */
export function resizeOnsetBuffer(state: OnsetState, tickMs: number): void {
  const newSize = Math.max(3, Math.round(TARGET_LOOKBACK_MS / tickMs));
  if (newSize !== state.size) {
    state.buffer = new Array(newSize).fill(0);
    state.pos = 0;
    state.size = newSize;
  }
}

// Reusable scratch buffer for median (zero-alloc after first call)
let _medianScratch: number[] = [];

function median(arr: number[]): number {
  const n = arr.length;
  if (_medianScratch.length < n) _medianScratch = new Array(n);
  for (let i = 0; i < n; i++) _medianScratch[i] = arr[i];
  // Insertion sort (N≤7, fastest for tiny arrays)
  for (let i = 1; i < n; i++) {
    const v = _medianScratch[i];
    let j = i - 1;
    while (j >= 0 && _medianScratch[j] > v) { _medianScratch[j + 1] = _medianScratch[j]; j--; }
    _medianScratch[j + 1] = v;
  }
  const mid = n >> 1;
  return (n & 1) ? _medianScratch[mid] : (_medianScratch[mid - 1] + _medianScratch[mid]) * 0.5;
}

/** Original detectOnset — kept for standalone/test use. */
export function detectOnset(state: OnsetState, flux: number, tickMs: number): boolean {
  state.buffer[state.pos] = flux;
  state.pos = (state.pos + 1) % state.size;

  const threshold = median(state.buffer) * DEFAULT_MULTIPLIER + DEFAULT_OFFSET;
  const isOnset = flux > threshold && flux >= state.prevFlux;
  state.prevFlux = flux;

  const DECAY_PER_SEC = 0.10;
  const tickDecay = Math.pow(DECAY_PER_SEC, tickMs / 1000);

  if (isOnset) state.target = 0.22;

  const riseAlpha = 1 - Math.pow(0.15, tickMs / 125);
  if (state.boost < state.target) {
    state.boost += riseAlpha * (state.target - state.boost);
  } else {
    state.boost *= tickDecay;
  }
  state.target *= tickDecay;

  if (state.boost < 0.001) { state.boost = 0; state.target = 0; }

  return isOnset;
}

/** Fast version using precomputed decay/rise constants — zero Math.pow. */
export function detectOnsetFast(state: OnsetState, flux: number, tc: TickConstants): boolean {
  state.buffer[state.pos] = flux;
  state.pos = (state.pos + 1) % state.size;

  const threshold = median(state.buffer) * DEFAULT_MULTIPLIER + DEFAULT_OFFSET;
  const isOnset = flux > threshold && flux >= state.prevFlux;
  state.prevFlux = flux;

  if (isOnset) state.target = 0.22;

  if (state.boost < state.target) {
    state.boost += tc.onsetRiseAlpha * (state.target - state.boost);
  } else {
    state.boost *= tc.onsetDecay;
  }
  state.target *= tc.onsetDecay;

  if (state.boost < 0.001) { state.boost = 0; state.target = 0; }

  return isOnset;
}

/** Get the current boost value (0–0.22, decaying) */
export function getOnsetBoost(state: OnsetState): number {
  return state.boost;
}
