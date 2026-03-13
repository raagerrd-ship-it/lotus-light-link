/**
 * Interpolate an energy curve at a given time (seconds).
 * Extracted from autoCalibrate.ts for reuse.
 */
export interface EnergySample {
  t: number; // seconds
  e: number; // 0.0–1.0
}

export function interpolateEnergy(curve: EnergySample[], t: number): number {
  if (curve.length === 0) return 0;
  if (t <= curve[0].t) return curve[0].e;
  if (t >= curve[curve.length - 1].t) return curve[curve.length - 1].e;

  // Binary search for efficiency on large curves
  let lo = 0, hi = curve.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid; else hi = mid;
  }

  const prev = curve[lo];
  const next = curve[hi];
  const frac = (t - prev.t) / (next.t - prev.t);
  return prev.e + (next.e - prev.e) * frac;
}
