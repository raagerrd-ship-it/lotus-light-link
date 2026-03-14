/**
 * Energy curve sample with frequency bands and kick markers.
 * Primary value is rawRms (raw microphone amplitude).
 * Normalized energy is derived at playback time from rawRms / peakRms.
 */
export interface EnergySample {
  t: number; // seconds (song position)
  rawRms: number; // raw RMS value from microphone
  kick?: boolean; // white kick triggered at this sample
  kickT?: number; // exact kick timestamp (seconds) with sub-sample precision
  lo?: number; // 0.0–1.0 low-band energy (<300 Hz)
  mid?: number; // 0.0–1.0 mid-band energy (300–2000 Hz)
  hi?: number; // 0.0–1.0 high-band energy (>2000 Hz)
}

export interface AgcState {
  agcMin: number;
  agcMax: number;
  agcPeakMax: number;
  avgPipelineMs?: number;
}

/**
 * Compute peak rawRms for a curve (cached via WeakMap).
 */
const peakCache = new WeakMap<EnergySample[], number>();
export function curvePeakRms(curve: EnergySample[]): number {
  let cached = peakCache.get(curve);
  if (cached != null) return cached;
  let peak = 0;
  for (const s of curve) {
    if (s.rawRms > peak) peak = s.rawRms;
  }
  peakCache.set(curve, peak);
  return peak;
}

/**
 * Interpolate normalized energy (0–1) at time t.
 */
export function interpolateEnergy(curve: EnergySample[], t: number): number {
  if (curve.length === 0) return 0;
  const peak = curvePeakRms(curve);
  if (peak === 0) return 0;

  const val = (s: EnergySample) => s.rawRms / peak;

  if (t <= curve[0].t) return val(curve[0]);
  if (t >= curve[curve.length - 1].t) return val(curve[curve.length - 1]);

  let lo = 0, hi = curve.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid; else hi = mid;
  }

  const prev = curve[lo];
  const next = curve[hi];
  const frac = (t - prev.t) / (next.t - prev.t);
  return val(prev) + (val(next) - val(prev)) * frac;
}

/**
 * Interpolate a full sample at time t, including frequency bands.
 * Returns e as normalized rawRms (0–1).
 */
export function interpolateSample(curve: EnergySample[], t: number): { t: number; e: number; rawRms: number; lo?: number; mid?: number; hi?: number; kick?: boolean } {
  const peak = curvePeakRms(curve);
  const val = (s: EnergySample) => peak > 0 ? s.rawRms / peak : 0;

  if (curve.length === 0) return { t, e: 0, rawRms: 0 };
  if (t <= curve[0].t) return { ...curve[0], t, e: val(curve[0]) };
  if (t >= curve[curve.length - 1].t) return { ...curve[curve.length - 1], t, e: val(curve[curve.length - 1]) };

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

  const rawRms = prev.rawRms + (next.rawRms - prev.rawRms) * frac;

  return {
    t,
    e: val(prev) + (val(next) - val(prev)) * frac,
    rawRms,
    lo: lerp(prev.lo, next.lo),
    mid: lerp(prev.mid, next.mid),
    hi: lerp(prev.hi, next.hi),
    kick: hasKickNearSample(prev, next, t),
  };
}

function hasKickNearSample(prev: EnergySample, next: EnergySample, t: number): boolean {
  if (prev.kickT != null && Math.abs(t - prev.kickT) < 0.03) return true;
  if (next.kickT != null && Math.abs(t - next.kickT) < 0.03) return true;
  if (prev.kick && (t - prev.t) < 0.05) return true;
  if (next.kick && (next.t - t) < 0.05) return true;
  return false;
}

/**
 * Check if there's a kick event near time t (within toleranceMs).
 */
export function hasKickNear(curve: EnergySample[], t: number, toleranceMs = 60): boolean {
  const tolSec = toleranceMs / 1000;
  let lo = 0, hi = curve.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid; else hi = mid;
  }
  for (let i = Math.max(0, lo - 2); i <= Math.min(curve.length - 1, hi + 2); i++) {
    const s = curve[i];
    if (s.kickT != null && Math.abs(t - s.kickT) <= tolSec) return true;
    if (s.kick && Math.abs(s.t - t) <= tolSec) return true;
  }
  return false;
}
