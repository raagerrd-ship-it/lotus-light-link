/**
 * Auto-calibration: cross-correlate mic RMS against a known energy curve
 * to find latency offset, gain factor, and optimal dynamics parameters.
 */

export interface EnergySample {
  t: number; // seconds
  e: number; // 0.0–1.0
}

export interface MicSample {
  t: number; // seconds (relative to song start)
  rms: number; // raw RMS from mic
}

export interface CalibrationResult {
  latencyMs: number;
  gain: number;
  attackAlpha: number;
  releaseAlpha: number;
  dynamicDamping: number;
  correlation: number; // quality metric 0–1
}

/**
 * Interpolate energy curve at a given time.
 */
function interpolateEnergy(curve: EnergySample[], t: number): number {
  if (curve.length === 0) return 0;
  if (t <= curve[0].t) return curve[0].e;
  if (t >= curve[curve.length - 1].t) return curve[curve.length - 1].e;

  for (let i = 1; i < curve.length; i++) {
    if (curve[i].t >= t) {
      const prev = curve[i - 1];
      const next = curve[i];
      const frac = (t - prev.t) / (next.t - prev.t);
      return prev.e + (next.e - prev.e) * frac;
    }
  }
  return curve[curve.length - 1].e;
}

/**
 * Compute Pearson correlation between two arrays.
 */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;

  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }

  const den = Math.sqrt(denA * denB);
  return den < 1e-10 ? 0 : num / den;
}

/**
 * Find optimal latency offset via cross-correlation.
 * Tests offsets from -500ms to +500ms in 5ms steps.
 */
function findLatency(
  energyCurve: EnergySample[],
  micSamples: MicSample[],
): { latencyMs: number; correlation: number } {
  const STEP_MS = 5;
  const RANGE_MS = 500;

  let bestOffset = 0;
  let bestCorr = -Infinity;

  for (let offsetMs = -RANGE_MS; offsetMs <= RANGE_MS; offsetMs += STEP_MS) {
    const offsetSec = offsetMs / 1000;

    const expected: number[] = [];
    const actual: number[] = [];

    for (const s of micSamples) {
      const adjustedT = s.t + offsetSec;
      const e = interpolateEnergy(energyCurve, adjustedT);
      expected.push(e);
      actual.push(s.rms);
    }

    const corr = pearson(expected, actual);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestOffset = offsetMs;
    }
  }

  return { latencyMs: bestOffset, correlation: Math.max(0, bestCorr) };
}

/**
 * Compute gain as median ratio of mic RMS to expected energy.
 */
function findGain(
  energyCurve: EnergySample[],
  micSamples: MicSample[],
  latencyMs: number,
): number {
  const offsetSec = latencyMs / 1000;
  const ratios: number[] = [];

  for (const s of micSamples) {
    const e = interpolateEnergy(energyCurve, s.t + offsetSec);
    if (e > 0.05 && s.rms > 0.001) {
      ratios.push(s.rms / e);
    }
  }

  if (ratios.length === 0) return 1;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

/**
 * Simulate EMA envelope with given params and compute MSE against expected.
 */
function simulateEMA(
  expected: number[],
  actual: number[],
  attack: number,
  release: number,
  damping: number,
): number {
  let smoothed = actual[0] || 0;
  let mse = 0;
  const n = expected.length;

  for (let i = 0; i < n; i++) {
    const raw = actual[i];
    const alpha = raw > smoothed ? attack : release;
    smoothed += (raw - smoothed) * alpha;
    const dampedSmoothed = Math.pow(smoothed, 1 / damping);
    const err = dampedSmoothed - expected[i];
    mse += err * err;
  }

  return mse / n;
}

/**
 * Find optimal dynamics parameters by grid search.
 */
function findDynamics(
  energyCurve: EnergySample[],
  micSamples: MicSample[],
  latencyMs: number,
  gain: number,
): { attackAlpha: number; releaseAlpha: number; dynamicDamping: number } {
  const offsetSec = latencyMs / 1000;

  const expected: number[] = [];
  const normalized: number[] = [];

  for (const s of micSamples) {
    expected.push(interpolateEnergy(energyCurve, s.t + offsetSec));
    normalized.push(s.rms / Math.max(0.001, gain));
  }

  let bestAttack = 0.5;
  let bestRelease = 0.08;
  let bestDamping = 1.0;
  let bestMSE = Infinity;

  // Coarse grid
  for (let attack = 0.15; attack <= 0.85; attack += 0.1) {
    for (let release = 0.03; release <= 0.18; release += 0.03) {
      for (let damping = 1.0; damping <= 2.5; damping += 0.5) {
        const mse = simulateEMA(expected, normalized, attack, release, damping);
        if (mse < bestMSE) {
          bestMSE = mse;
          bestAttack = attack;
          bestRelease = release;
          bestDamping = damping;
        }
      }
    }
  }

  // Fine grid around best
  const fineAttackMin = Math.max(0.1, bestAttack - 0.1);
  const fineAttackMax = Math.min(0.9, bestAttack + 0.1);
  const fineReleaseMin = Math.max(0.02, bestRelease - 0.03);
  const fineReleaseMax = Math.min(0.2, bestRelease + 0.03);
  const fineDampingMin = Math.max(1.0, bestDamping - 0.5);
  const fineDampingMax = Math.min(3.0, bestDamping + 0.5);

  for (let attack = fineAttackMin; attack <= fineAttackMax; attack += 0.02) {
    for (let release = fineReleaseMin; release <= fineReleaseMax; release += 0.005) {
      for (let damping = fineDampingMin; damping <= fineDampingMax; damping += 0.1) {
        const mse = simulateEMA(expected, normalized, attack, release, damping);
        if (mse < bestMSE) {
          bestMSE = mse;
          bestAttack = attack;
          bestRelease = release;
          bestDamping = damping;
        }
      }
    }
  }

  return {
    attackAlpha: Math.round(bestAttack * 100) / 100,
    releaseAlpha: Math.round(bestRelease * 1000) / 1000,
    dynamicDamping: Math.round(bestDamping * 10) / 10,
  };
}

/**
 * Run full auto-calibration.
 */
export function runAutoCalibration(
  energyCurve: EnergySample[],
  micSamples: MicSample[],
): CalibrationResult {
  if (energyCurve.length < 5 || micSamples.length < 10) {
    return {
      latencyMs: 0,
      gain: 1,
      attackAlpha: 0.5,
      releaseAlpha: 0.08,
      dynamicDamping: 1.0,
      correlation: 0,
    };
  }

  const { latencyMs, correlation } = findLatency(energyCurve, micSamples);
  const gain = findGain(energyCurve, micSamples, latencyMs);
  const dynamics = findDynamics(energyCurve, micSamples, latencyMs, gain);

  return {
    latencyMs,
    gain,
    ...dynamics,
    correlation,
  };
}

// --- Multi-song calibration ---

export interface PerSongResult {
  trackName: string;
  artistName: string;
  attackAlpha: number;
  releaseAlpha: number;
  dynamicDamping: number;
  correlation: number;
}

export interface MultiSongCalibrationResult {
  attackAlpha: number;
  releaseAlpha: number;
  dynamicDamping: number;
  perSong: PerSongResult[];
}

export interface SongInput {
  trackName: string;
  artistName: string;
  energyCurve: { t: number; rawRms: number }[];
}

/**
 * Run calibration across multiple songs, returning the median of each parameter.
 * Converts rawRms curves to normalized energy (rawRms/peakRms) for the calibration engine.
 */
export function runMultiSongCalibration(songs: SongInput[]): MultiSongCalibrationResult {
  const results: PerSongResult[] = [];

  for (const song of songs) {
    const curve = song.energyCurve;
    if (!curve || curve.length < 50) continue;

    // Find peak rawRms
    let peak = 0;
    for (const s of curve) { if (s.rawRms > peak) peak = s.rawRms; }
    if (peak === 0) continue;

    // Convert to normalized energy curve
    const normalizedCurve: EnergySample[] = curve.map(s => ({
      t: s.t,
      e: s.rawRms / peak,
    }));

    // Use the same curve as both "reference" and "mic input"
    // This finds optimal smoothing parameters for the curve's dynamics
    const micSamples: MicSample[] = curve.map(s => ({
      t: s.t,
      rms: s.rawRms / peak,
    }));

    const result = runAutoCalibration(normalizedCurve, micSamples);

    results.push({
      trackName: song.trackName,
      artistName: song.artistName,
      attackAlpha: result.attackAlpha,
      releaseAlpha: result.releaseAlpha,
      dynamicDamping: result.dynamicDamping,
      correlation: result.correlation,
    });
  }

  if (results.length === 0) {
    return {
      attackAlpha: 0.3,
      releaseAlpha: 0.05,
      dynamicDamping: 1.0,
      perSong: [],
    };
  }

  // Take median of each parameter
  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  return {
    attackAlpha: Math.round(median(results.map(r => r.attackAlpha)) * 100) / 100,
    releaseAlpha: Math.round(median(results.map(r => r.releaseAlpha)) * 1000) / 1000,
    dynamicDamping: Math.round(median(results.map(r => r.dynamicDamping)) * 10) / 10,
    perSong: results,
  };
}
