/**
 * Auto-sync: correlate live mic peaks with saved energy curve peaks
 * to compute and maintain a drift offset (ms).
 *
 * Approach:
 * 1. Detect sharp energy rises (onsets) in the live mic signal
 * 2. When an onset is detected, find the nearest peak in the saved curve
 *    within a ±200ms search window around the current Sonos position
 * 3. The difference = drift. Smooth it with an exponential moving average.
 */

import type { EnergySample } from './energyInterpolate';

// --- Peak detection in saved curve (cached) ---

interface CurveIndex {
  /** Onset times in seconds (sharp energy rises in the saved curve) */
  onsets: number[];
}

const indexCache = new WeakMap<EnergySample[], CurveIndex>();

function buildCurveIndex(curve: EnergySample[]): CurveIndex {
  const cached = indexCache.get(curve);
  if (cached) return cached;

  const onsets: number[] = [];
  if (curve.length < 5) {
    const idx = { onsets };
    indexCache.set(curve, idx);
    return idx;
  }

  // Find local peaks in rawRms: sample is an onset if it's significantly
  // higher than the average of the previous 3 samples
  for (let i = 3; i < curve.length; i++) {
    const prev3 = (curve[i - 1].rawRms + curve[i - 2].rawRms + curve[i - 3].rawRms) / 3;
    const curr = curve[i].rawRms;
    // Onset: current > 1.5× recent average and absolute threshold
    if (curr > prev3 * 1.5 && curr > 0.005) {
      // Don't add onsets too close together (min 80ms apart)
      if (onsets.length === 0 || curve[i].t - onsets[onsets.length - 1] > 0.08) {
        onsets.push(curve[i].t);
      }
    }
  }

  // Also include kick timestamps
  for (const s of curve) {
    if (s.kickT != null) {
      // Insert if not too close to existing onset
      const exists = onsets.some(t => Math.abs(t - s.kickT!) < 0.05);
      if (!exists) onsets.push(s.kickT);
    }
  }

  onsets.sort((a, b) => a - b);

  const idx = { onsets };
  indexCache.set(curve, idx);
  return idx;
}

/**
 * Find the nearest onset in the saved curve to a given time.
 * Returns the onset time, or null if none within maxDistSec.
 */
function findNearestOnset(index: CurveIndex, timeSec: number, maxDistSec: number): number | null {
  const { onsets } = index;
  if (onsets.length === 0) return null;

  // Binary search for closest
  let lo = 0, hi = onsets.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid] <= timeSec) lo = mid; else hi = mid;
  }

  let best: number | null = null;
  let bestDist = maxDistSec;
  for (let i = Math.max(0, lo - 1); i <= Math.min(onsets.length - 1, hi + 1); i++) {
    const dist = Math.abs(onsets[i] - timeSec);
    if (dist < bestDist) {
      bestDist = dist;
      best = onsets[i];
    }
  }
  return best;
}

// --- AutoSync state ---

export interface AutoSyncState {
  /** Current smoothed drift in milliseconds (positive = curve is ahead of mic) */
  driftMs: number;
  /** Number of correlations used */
  correlations: number;
  /** Confidence 0–1 based on consistency of recent measurements */
  confidence: number;
}

const MAX_SEARCH_WINDOW_SEC = 0.2; // ±200ms
const SMOOTHING_ALPHA = 0.15; // EMA smoothing for drift
const MIN_ONSET_INTERVAL_MS = 150; // Don't process onsets faster than this
const MAX_DRIFT_MS = 300; // Clamp drift to avoid wild corrections
const CONFIDENCE_DECAY = 0.998;
const CONFIDENCE_BOOST = 0.05;

let _driftMs = 0;
let _correlations = 0;
let _confidence = 0;
let _lastOnsetTime = 0;
let _recentDrifts: number[] = [];
let _paused = false;

/** Pause/resume auto-sync (e.g. while manual latency slider is open) */
export function setAutoSyncPaused(paused: boolean) {
  _paused = paused;
}

/** Reset auto-sync state (call on track change) */
export function resetAutoSync() {
  _driftMs = 0;
  _correlations = 0;
  _confidence = 0;
  _lastOnsetTime = 0;
  _recentDrifts = [];
}

/** Get current auto-sync state */
export function getAutoSyncState(): AutoSyncState {
  return {
    driftMs: Math.round(_driftMs * 10) / 10,
    correlations: _correlations,
    confidence: Math.round(_confidence * 100) / 100,
  };
}

/** Get current drift offset in ms (for injection into position calculation) */
export function getAutoSyncDriftMs(): number {
  // Only apply drift if we have reasonable confidence
  return _confidence > 0.3 ? _driftMs : 0;
}

/**
 * Called from the tick loop when we detect a live mic onset.
 * @param liveRms Current mic RMS value
 * @param prevRms Previous smoothed RMS value  
 * @param currentPosSec Current estimated song position in seconds (before drift)
 * @param curve The saved energy curve
 */
export function reportLiveOnset(
  liveRms: number,
  prevRms: number,
  currentPosSec: number,
  curve: EnergySample[],
) {
  if (_paused) return;
  const now = performance.now();
  if (now - _lastOnsetTime < MIN_ONSET_INTERVAL_MS) return;

  // Detect onset: current RMS > 1.5× previous AND above noise floor
  const ratio = prevRms > 0.001 ? liveRms / prevRms : 0;
  if (ratio < 1.5 || liveRms < 0.008) return;

  _lastOnsetTime = now;

  // Find nearest curve onset
  const index = buildCurveIndex(curve);
  const nearest = findNearestOnset(index, currentPosSec, MAX_SEARCH_WINDOW_SEC);
  if (nearest == null) return;

  // Drift = (curve onset time) - (current position)
  // Positive = we're behind the curve (need to jump forward)
  const driftSec = nearest - currentPosSec;
  const driftMs = driftSec * 1000;

  // Clamp
  if (Math.abs(driftMs) > MAX_DRIFT_MS) return;

  // Smooth
  _driftMs = _driftMs * (1 - SMOOTHING_ALPHA) + driftMs * SMOOTHING_ALPHA;
  _correlations++;
  _confidence = Math.min(1, _confidence + CONFIDENCE_BOOST);

  // Track recent drifts for consistency check
  _recentDrifts.push(driftMs);
  if (_recentDrifts.length > 20) _recentDrifts.shift();

  // Reduce confidence if recent drifts are inconsistent
  if (_recentDrifts.length >= 5) {
    const mean = _recentDrifts.reduce((a, b) => a + b, 0) / _recentDrifts.length;
    const variance = _recentDrifts.reduce((a, d) => a + (d - mean) ** 2, 0) / _recentDrifts.length;
    const stddev = Math.sqrt(variance);
    if (stddev > 50) {
      _confidence *= 0.95; // high variance → less confidence
    }
  }
}

/**
 * Called every tick to decay confidence slowly.
 * Should be called even when no onset is detected.
 */
export function tickAutoSync() {
  _confidence *= CONFIDENCE_DECAY;
}
