/**
 * Energy curve sample with optional frequency bands and kick markers.
 * Primary value is rawRms (raw microphone amplitude).
 * The 'e' field is derived at playback time by normalizing rawRms against the curve's peak.
 */
export interface EnergySample {
  t: number; // seconds (song position)
  e?: number; // 0.0–1.0 normalized energy (derived, legacy, or blended)
  rawRms?: number; // raw RMS value from microphone
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
  avgPipelineMs?: number; // average mic→BLE pipeline latency at recording time
}

/**
 * Get the energy value for a sample, preferring rawRms normalized against peak.
 */
function sampleEnergy(s: EnergySample, peakRms: number): number {
  if (s.rawRms != null && peakRms > 0) return Math.min(1, s.rawRms / peakRms);
  return s.e ?? 0;
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
    if (s.rawRms != null && s.rawRms > peak) peak = s.rawRms;
  }
  peakCache.set(curve, peak);
  return peak;
}

/**
 * Interpolate energy at time t.
 */
export function interpolateEnergy(curve: EnergySample[], t: number): number {
  if (curve.length === 0) return 0;
  const peak = curvePeakRms(curve);
  if (t <= curve[0].t) return sampleEnergy(curve[0], peak);
  if (t >= curve[curve.length - 1].t) return sampleEnergy(curve[curve.length - 1], peak);

  let lo = 0, hi = curve.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid; else hi = mid;
  }

  const prev = curve[lo];
  const next = curve[hi];
  const frac = (t - prev.t) / (next.t - prev.t);
  const ePrev = sampleEnergy(prev, peak);
  const eNext = sampleEnergy(next, peak);
  return ePrev + (eNext - ePrev) * frac;
}

/**
 * Interpolate a full sample at time t, including frequency bands.
 */
export function interpolateSample(curve: EnergySample[], t: number): EnergySample & { e: number } {
  const peak = curvePeakRms(curve);
  if (curve.length === 0) return { t, e: 0 };
  if (t <= curve[0].t) return { ...curve[0], t, e: sampleEnergy(curve[0], peak) };
  if (t >= curve[curve.length - 1].t) return { ...curve[curve.length - 1], t, e: sampleEnergy(curve[curve.length - 1], peak) };

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

  const ePrev = sampleEnergy(prev, peak);
  const eNext = sampleEnergy(next, peak);

  return {
    t,
    e: ePrev + (eNext - ePrev) * frac,
    rawRms: lerp(prev.rawRms, next.rawRms),
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
