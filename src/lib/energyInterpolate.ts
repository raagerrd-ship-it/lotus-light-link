/**
 * Energy curve sample with optional frequency bands and kick markers.
 */
export interface EnergySample {
  t: number; // seconds (song position)
  e: number; // 0.0–1.0 normalized energy
  rawRms?: number; // raw RMS value before AGC normalization
  kick?: boolean; // white kick triggered at this sample
  kickT?: number; // exact kick timestamp (seconds) with sub-sample precision
  lo?: number; // 0.0–1.0 low-band energy (<300 Hz)
  mid?: number; // 0.0–1.0 mid-band energy (300–2000 Hz)
  hi?: number; // 0.0–1.0 high-band energy (>2000 Hz)
  rtt?: number; // Sonos position RTT in ms at recording time
}

export interface AgcState {
  agcMin: number;
  agcMax: number;
  agcPeakMax: number;
  avgPipelineMs?: number; // average mic→BLE pipeline latency at recording time
}

/**
 * Interpolate energy at time t.
 */
export function interpolateEnergy(curve: EnergySample[], t: number): number {
  if (curve.length === 0) return 0;
  if (t <= curve[0].t) return curve[0].e;
  if (t >= curve[curve.length - 1].t) return curve[curve.length - 1].e;

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

/**
 * Interpolate a full sample at time t, including frequency bands.
 */
export function interpolateSample(curve: EnergySample[], t: number): EnergySample {
  if (curve.length === 0) return { t, e: 0 };
  if (t <= curve[0].t) return { ...curve[0], t };
  if (t >= curve[curve.length - 1].t) return { ...curve[curve.length - 1], t };

  let lo = 0, hi = curve.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid; else hi = mid;
  }

  const prev = curve[lo];
  const next = curve[hi];
  const frac = (t - prev.t) / (next.t - prev.t);
  const lerp = (a: number | undefined, b: number | undefined) =>
    a != null && b != null ? a + (b - a) * frac : (a ?? b);

  return {
    t,
    e: prev.e + (next.e - prev.e) * frac,
    lo: lerp(prev.lo, next.lo),
    mid: lerp(prev.mid, next.mid),
    hi: lerp(prev.hi, next.hi),
    // Kick: use precise kickT if available, else fall back to sample proximity
    kick: hasKickNearSample(prev, next, t),
  };
}

function hasKickNearSample(prev: EnergySample, next: EnergySample, t: number): boolean {
  // Use precise kickT timestamps when available
  if (prev.kickT != null && Math.abs(t - prev.kickT) < 0.03) return true;
  if (next.kickT != null && Math.abs(t - next.kickT) < 0.03) return true;
  // Fall back to boolean kick flag
  if (prev.kick && (t - prev.t) < 0.05) return true;
  if (next.kick && (next.t - t) < 0.05) return true;
  return false;
}

/**
 * Check if there's a kick event near time t (within toleranceMs).
 * Uses precise kickT timestamps when available.
 */
export function hasKickNear(curve: EnergySample[], t: number, toleranceMs = 60): boolean {
  const tolSec = toleranceMs / 1000;
  // Binary search
  let lo = 0, hi = curve.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid; else hi = mid;
  }
  // Check neighborhood
  for (let i = Math.max(0, lo - 2); i <= Math.min(curve.length - 1, hi + 2); i++) {
    const s = curve[i];
    // Precise timestamp
    if (s.kickT != null && Math.abs(t - s.kickT) <= tolSec) return true;
    // Boolean flag fallback
    if (s.kick && Math.abs(s.t - t) <= tolSec) return true;
  }
  return false;
}
