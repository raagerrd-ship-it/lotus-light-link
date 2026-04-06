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
}

export function createOnsetState(tickMs: number = 125): OnsetState {
  const size = Math.max(3, Math.round(TARGET_LOOKBACK_MS / tickMs));
  return {
    buffer: new Array(size).fill(0),
    pos: 0,
    size,
    prevFlux: 0,
    boost: 0,
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

function median(arr: number[]): number {
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Process a new flux value. Returns true if an onset was detected.
 * Also updates the internal boost level with exponential decay.
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

  // Decay existing boost: ~90% decay per second
  const DECAY_PER_SEC = 0.10; // remaining fraction after 1s
  state.boost *= Math.pow(DECAY_PER_SEC, tickMs / 1000);

  // On onset, set boost to peak
  if (isOnset) {
    state.boost = 0.20;
  }

  // Clean up tiny values
  if (state.boost < 0.001) state.boost = 0;

  return isOnset;
}

/** Get the current boost value (0–0.20, decaying) */
export function getOnsetBoost(state: OnsetState): number {
  return state.boost;
}
