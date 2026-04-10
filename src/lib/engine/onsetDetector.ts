/**
 * Onset detection via spectral-flux peak-picking.
 *
 * Instead of a smoothed continuous transient signal, this gives discrete
 * binary onset events (yes/no per tick) by comparing flux against an
 * adaptive median-based threshold and requiring a local maximum.
 *
 * CPU cost: sorting ~7 numbers + 2 comparisons per tick — negligible.
 */

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

/**
 * Process a new flux value. Returns true if an onset was detected.
 * Shaped envelope: fast 2-tick rise to rounded peak, smooth exponential fade.
 */
export function detectOnset(state: OnsetState, flux: number, tickMs: number): boolean {
  // Write to circular buffer
  state.buffer[state.pos] = flux;
  state.pos = (state.pos + 1) % state.size;

  // Adaptive threshold: median * multiplier + offset
  const threshold = median(state.buffer) * DEFAULT_MULTIPLIER + DEFAULT_OFFSET;

  // Onset = above threshold AND local maximum (>= previous frame)
  const isOnset = flux > threshold && flux >= state.prevFlux;
  state.prevFlux = flux;

  // Decay constant: ~90% decay per second
  const DECAY_PER_SEC = 0.10;
  const tickDecay = Math.pow(DECAY_PER_SEC, tickMs / 1000);

  // On onset, set target high — boost chases target with fast rise
  if (isOnset) state.target = 0.22;

  // Fast rise (~2 ticks to peak), smooth decay
  const riseAlpha = 1 - Math.pow(0.15, tickMs / 125);
  if (state.boost < state.target) {
    state.boost += riseAlpha * (state.target - state.boost);
  } else {
    state.boost *= tickDecay;
  }
  // Decay target for rounded peak shape
  state.target *= tickDecay;

  if (state.boost < 0.001) { state.boost = 0; state.target = 0; }

  return isOnset;
}

/** Get the current boost value (0–0.22, decaying) */
export function getOnsetBoost(state: OnsetState): number {
  return state.boost;
}
