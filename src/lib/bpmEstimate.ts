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
    return { bpm: (60 * 60) / bestLag, confidence: bestCorr };
  }
  return null;
}
