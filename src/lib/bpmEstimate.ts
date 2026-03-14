/**
 * Auto-correlation BPM estimation from energy history.
 * Returns { bpm, confidence } or null if insufficient data.
 */
export function estimateBpmFromHistory(
  history: number[],
): { bpm: number; confidence: number } | null {
  if (history.length < 120) return null; // need ~2s minimum

  const len = history.length;
  let mean = 0;
  for (let i = 0; i < len; i++) mean += history[i];
  mean /= len;

  const minLag = 18; // 200 BPM
  const maxLag = Math.min(90, len - 1); // 40 BPM
  let bestLag = 30;
  let bestCorr = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let norm1 = 0;
    let norm2 = 0;
    const n = len - lag;
    for (let i = 0; i < n; i++) {
      const a = history[i] - mean;
      const b = history[i + lag] - mean;
      corr += a * b;
      norm1 += a * a;
      norm2 += b * b;
    }
    const denom = Math.sqrt(norm1 * norm2);
    if (denom > 0) corr /= denom;

    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestCorr > 0.15) {
    let bpm = (60 * 60) / bestLag;

    // BPM halving: if > 160, check if half-tempo lag has comparable correlation
    if (bpm > 160) {
      const halfLag = bestLag * 2;
      if (halfLag < len - 1) {
        let hCorr = 0, hN1 = 0, hN2 = 0;
        const hn = len - halfLag;
        for (let i = 0; i < hn; i++) {
          const a = history[i] - mean;
          const b = history[i + halfLag] - mean;
          hCorr += a * b;
          hN1 += a * a;
          hN2 += b * b;
        }
        const hDenom = Math.sqrt(hN1 * hN2);
        if (hDenom > 0) hCorr /= hDenom;

        // Use half-tempo if correlation is at least 70% as good
        if (hCorr > bestCorr * 0.7) {
          bpm = bpm / 2;
        }
      }
    }

    return { bpm, confidence: bestCorr };
  }
  return null;
}

/**
 * Extract a beat grid (array of exact beat timestamps in seconds)
 * from an energy curve using the estimated BPM.
 *
 * Uses onset detection to find the best phase alignment,
 * then generates beat timestamps for the entire song duration.
 */
export interface BeatGrid {
  bpm: number;
  offsetSec: number; // phase offset of first beat
  beats: number[];   // exact beat timestamps in seconds
}

export function extractBeatGrid(
  times: number[],
  energies: number[],
  bpm: number,
): BeatGrid | null {
  if (times.length < 50 || bpm <= 0) return null;

  const beatPeriod = 60 / bpm;
  const songDuration = times[times.length - 1];

  // Compute onset strength (energy derivative, rectified)
  const onsets: number[] = new Array(energies.length).fill(0);
  for (let i = 1; i < energies.length; i++) {
    const diff = energies[i] - energies[i - 1];
    onsets[i] = Math.max(0, diff); // only positive changes (onsets)
  }

  // Find optimal phase by testing different offsets
  // and scoring how well beats align with onsets
  const numPhaseTests = 50;
  let bestPhase = 0;
  let bestScore = -1;

  for (let p = 0; p < numPhaseTests; p++) {
    const phase = (p / numPhaseTests) * beatPeriod;
    let score = 0;
    let beatCount = 0;

    for (let beatTime = phase; beatTime < songDuration; beatTime += beatPeriod) {
      // Find nearest sample to this beat time
      const idx = findNearestIndex(times, beatTime);
      if (idx < 0) continue;

      // Score: sum onset strength in a small window around the beat
      const windowSamples = 3; // ~300ms window
      for (let j = Math.max(0, idx - windowSamples); j <= Math.min(onsets.length - 1, idx + windowSamples); j++) {
        const dist = Math.abs(times[j] - beatTime);
        const weight = Math.exp(-dist * 10); // gaussian-ish weighting
        score += onsets[j] * weight;
      }
      beatCount++;
    }

    if (beatCount > 0) score /= beatCount;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  // Generate the beat grid with optimal phase
  const beats: number[] = [];
  for (let t = bestPhase; t < songDuration; t += beatPeriod) {
    beats.push(Math.round(t * 1000) / 1000); // round to ms
  }

  return { bpm, offsetSec: bestPhase, beats };
}

function findNearestIndex(times: number[], target: number): number {
  let lo = 0, hi = times.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) lo = mid; else hi = mid;
  }
  return Math.abs(times[lo] - target) < Math.abs(times[hi] - target) ? lo : hi;
}

/**
 * Find the nearest beat time to a given position.
 * Returns the beat time or null if no beats.
 */
export function nearestBeat(beats: number[], timeSec: number): number | null {
  if (beats.length === 0) return null;
  let lo = 0, hi = beats.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= timeSec) lo = mid; else hi = mid;
  }
  return Math.abs(beats[lo] - timeSec) < Math.abs(beats[hi] - timeSec) ? beats[lo] : beats[hi];
}

/**
 * Get beat phase (0-1) at a given time using a beat grid.
 * More accurate than BPM-only calculation as it uses the actual phase offset.
 */
export function beatGridPhase(grid: BeatGrid, timeSec: number): number {
  const beatPeriod = 60 / grid.bpm;
  const phase = ((timeSec - grid.offsetSec) / beatPeriod) % 1;
  return phase < 0 ? phase + 1 : phase;
}
