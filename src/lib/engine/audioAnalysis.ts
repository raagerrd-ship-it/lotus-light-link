// FFT-based frequency band analysis + spectral flux
// Zero-allocation: reuses a single result object between ticks.

export interface BandResult {
  bassRms: number;
  midHiRms: number;
  totalRms: number;
  /** Spectral flux: sum of positive changes between frames (onset/transient strength) */
  flux: number;
}

// Reusable previous-frame buffer (zero-alloc between ticks)
let _prevPower: Float64Array | null = null;

// Reusable result object — mutated in place, never re-allocated
const _bandResult: BandResult = { bassRms: 0, midHiRms: 0, totalRms: 0, flux: 0 };

// Precomputed dB→power lookup table (256 entries covering -128..0 dB range)
// Index i maps to dB value (i - 128), so power = 10^((i-128)/10)
const _dbLut = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  _dbLut[i] = Math.pow(10, (i - 200) / 10);
}

/** Fast dB→power using lookup + linear interpolation */
function dbToPower(db: number): number {
  // Clamp to LUT range: -200..+55 dB
  const idx = db + 200;
  if (idx <= 0) return _dbLut[0];
  if (idx >= 255) return _dbLut[255];
  const lo = idx | 0; // fast floor
  const frac = idx - lo;
  return _dbLut[lo] + frac * (_dbLut[lo + 1] - _dbLut[lo]);
}

export function computeBands(analyser: AnalyserNode, freqData: Float32Array<ArrayBuffer>): BandResult {
  analyser.getFloatFrequencyData(freqData);
  const sampleRate = analyser.context.sampleRate;
  const binWidth = sampleRate / analyser.fftSize;
  const loCut = (150 / binWidth) | 0;
  const midCut = (2000 / binWidth) | 0;
  const bins = freqData.length;

  // Lazy-init previous power buffer
  if (!_prevPower || _prevPower.length !== bins) {
    _prevPower = new Float64Array(bins);
  }

  let loSum = 0, midSum = 0, hiSum = 0;
  let loCount = 0, midCount = 0, hiCount = 0;
  let totalSum = 0;
  let flux = 0;

  for (let i = 0; i < bins; i++) {
    const power = dbToPower(freqData[i]);
    totalSum += power;
    if (i < loCut) { loSum += power; loCount++; }
    else if (i < midCut) { midSum += power; midCount++; }
    else { hiSum += power; hiCount++; }

    // Spectral flux: only count positive changes (onsets, not offsets)
    const diff = power - _prevPower[i];
    if (diff > 0) flux += diff;
    _prevPower[i] = power;
  }

  _bandResult.bassRms = loCount > 0 ? Math.sqrt(loSum / loCount) : 0;
  _bandResult.midHiRms = Math.sqrt((midSum + hiSum) / Math.max(1, midCount + hiCount));
  _bandResult.totalRms = bins > 0 ? Math.sqrt(totalSum / bins) : 0;
  _bandResult.flux = flux;

  return _bandResult;
}

/** Reset spectral flux state (call on track change) */
export function resetFluxState(): void {
  if (_prevPower) _prevPower.fill(0);
}
