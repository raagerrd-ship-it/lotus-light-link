// FFT-based frequency band analysis + spectral flux

export interface BandResult {
  bassRms: number;
  midHiRms: number;
  totalRms: number;
  /** Spectral flux: sum of positive changes between frames (onset/transient strength) */
  flux: number;
}

// Reusable previous-frame buffer (zero-alloc between ticks)
let _prevPower: Float64Array | null = null;

export function computeBands(analyser: AnalyserNode, freqData: Float32Array<ArrayBuffer>): BandResult {
  analyser.getFloatFrequencyData(freqData);
  const sampleRate = analyser.context.sampleRate;
  const binWidth = sampleRate / analyser.fftSize;
  const loCut = Math.floor(150 / binWidth);
  const midCut = Math.floor(2000 / binWidth);
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
    const power = Math.pow(10, freqData[i] / 10);
    totalSum += power;
    if (i < loCut) { loSum += power; loCount++; }
    else if (i < midCut) { midSum += power; midCount++; }
    else { hiSum += power; hiCount++; }

    // Spectral flux: only count positive changes (onsets, not offsets)
    const diff = power - _prevPower[i];
    if (diff > 0) flux += diff;
    _prevPower[i] = power;
  }

  const bassRms = loCount > 0 ? Math.sqrt(loSum / loCount) : 0;
  const midHiRms = Math.sqrt((midSum + hiSum) / Math.max(1, midCount + hiCount));
  const totalRms = bins > 0 ? Math.sqrt(totalSum / bins) : 0;

  return { bassRms, midHiRms, totalRms, flux };
}

/** Reset spectral flux state (call on track change) */
export function resetFluxState(): void {
  if (_prevPower) _prevPower.fill(0);
}
