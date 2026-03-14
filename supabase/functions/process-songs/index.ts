import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Types ──

interface EnergySample {
  t: number;
  rawRms: number;
  kick?: boolean;
  kickT?: number;
  lo?: number;
  mid?: number;
  hi?: number;
}

interface SongSection {
  start: number;
  end: number;
  type: string;
  intensity: number;
}

interface BeatGrid {
  bpm: number;
  offsetSec: number;
  beats: number[];
}

interface Drop {
  t: number;
  intensity: number;
  buildStart: number;
  rampSlope?: number;
  rampR2?: number;
}

interface DynamicRange {
  p10: number;
  p50: number;
  p90: number;
  peak: number;
}

interface Transition {
  time: number;
  fromType: string;
  toType: string;
  type: "hard" | "fade";
  crossfadeMs: number;
  energyDelta: number;
}

// ── Utility functions ──

function curvePeakRms(curve: EnergySample[]): number {
  let peak = 0;
  for (const s of curve) if (s.rawRms > peak) peak = s.rawRms;
  return peak;
}

// ── BPM Estimation ──

function estimateBpmFromHistory(history: number[]): { bpm: number; confidence: number } | null {
  if (history.length < 120) return null;
  const len = history.length;
  let mean = 0;
  for (let i = 0; i < len; i++) mean += history[i];
  mean /= len;

  const minLag = 18;
  const maxLag = Math.min(90, len - 1);
  let bestLag = 30;
  let bestCorr = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0, norm1 = 0, norm2 = 0;
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
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  if (bestCorr > 0.15) {
    let bpm = (60 * 60) / bestLag;
    if (bpm > 140) {
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
        if (hCorr > bestCorr * 0.5) bpm = bpm / 2;
      }
    }
    return { bpm, confidence: bestCorr };
  }
  return null;
}

function estimateBpm(curve: EnergySample[]): number | null {
  if (curve.length < 120) return null;
  const peak = curvePeakRms(curve);
  const history = curve.map(s => peak > 0 ? s.rawRms / peak : 0);
  const result = estimateBpmFromHistory(history);
  return result ? Math.round(result.bpm) : null;
}

// ── Beat Grid ──

function findNearestIndex(times: number[], target: number): number {
  let lo = 0, hi = times.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) lo = mid; else hi = mid;
  }
  return Math.abs(times[lo] - target) < Math.abs(times[hi] - target) ? lo : hi;
}

function extractBeatGrid(times: number[], energies: number[], bpm: number): BeatGrid | null {
  if (times.length < 50 || bpm <= 0) return null;
  const beatPeriod = 60 / bpm;
  const songDuration = times[times.length - 1];
  const onsets: number[] = new Array(energies.length).fill(0);
  for (let i = 1; i < energies.length; i++) {
    onsets[i] = Math.max(0, energies[i] - energies[i - 1]);
  }

  let bestPhase = 0, bestScore = -1;
  for (let p = 0; p < 50; p++) {
    const phase = (p / 50) * beatPeriod;
    let score = 0, beatCount = 0;
    for (let beatTime = phase; beatTime < songDuration; beatTime += beatPeriod) {
      const idx = findNearestIndex(times, beatTime);
      if (idx < 0) continue;
      for (let j = Math.max(0, idx - 3); j <= Math.min(onsets.length - 1, idx + 3); j++) {
        score += onsets[j] * Math.exp(-Math.abs(times[j] - beatTime) * 10);
      }
      beatCount++;
    }
    if (beatCount > 0) score /= beatCount;
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }

  const beats: number[] = [];
  for (let t = bestPhase; t < songDuration; t += beatPeriod) {
    beats.push(Math.round(t * 1000) / 1000);
  }
  return { bpm, offsetSec: bestPhase, beats };
}

function buildBeatGrid(curve: EnergySample[], bpm: number): BeatGrid | null {
  const peak = curvePeakRms(curve);
  return extractBeatGrid(
    curve.map(s => s.t),
    curve.map(s => peak > 0 ? s.rawRms / peak : 0),
    bpm,
  );
}

// ── Dynamic Range ──

function analyzeDynamicRange(curve: EnergySample[]): DynamicRange {
  if (curve.length === 0) return { p10: 0, p50: 0, p90: 0, peak: 0 };
  const sorted = curve.map(s => s.rawRms).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.floor(sorted.length * p)] ?? 0;
  return { p10: pct(0.10), p50: pct(0.50), p90: pct(0.90), peak: sorted[sorted.length - 1] };
}

// ── Ramp / Build-up Regression ──

function computeRamp(curve: EnergySample[], tStart: number, tEnd: number): { slope: number; r2: number } {
  const peak = curvePeakRms(curve);
  if (peak === 0) return { slope: 0, r2: 0 };
  const points: { x: number; y: number }[] = [];
  for (const s of curve) {
    if (s.t >= tStart && s.t <= tEnd) points.push({ x: s.t - tStart, y: s.rawRms / peak });
  }
  if (points.length < 3) return { slope: 0, r2: 0 };
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of points) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x; }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const meanY = sumY / n;
  const intercept = (sumY - slope * sumX) / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) { ssRes += (p.y - (intercept + slope * p.x)) ** 2; ssTot += (p.y - meanY) ** 2; }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope: Math.round(slope * 1000) / 1000, r2: Math.round(r2 * 100) / 100 };
}

// ── Drop Detection ──

function smoothEnergyNormalized(curve: EnergySample[], window: number, peak: number): number[] {
  const result = new Array(curve.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < curve.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(curve.length - 1, i + half); j++) {
      sum += curve[j].rawRms / peak; count++;
    }
    result[i] = sum / count;
  }
  return result;
}

function detectDrops(curve: EnergySample[]): Drop[] {
  if (curve.length < 50) return [];
  const peak = Math.max(...curve.map(s => s.rawRms), 0.001);
  const drops: Drop[] = [];
  const windowSec = 2.0, riseFactor = 1.8, minDropGap = 8.0;
  const smoothed = smoothEnergyNormalized(curve, 5, peak);

  for (let i = 20; i < smoothed.length - 5; i++) {
    const t = curve[i].t, e = smoothed[i];
    const windowStart = t - windowSec;
    let windowSum = 0, windowCount = 0, windowMin = 1;
    for (let j = i - 1; j >= 0 && curve[j].t >= windowStart; j--) {
      windowSum += smoothed[j]; windowCount++; if (smoothed[j] < windowMin) windowMin = smoothed[j];
    }
    if (windowCount < 3) continue;
    const windowAvg = windowSum / windowCount;
    if (windowAvg < 0.02) continue;
    const riseRatio = e / windowAvg;
    if (riseRatio >= riseFactor && e > 0.3) {
      const lastDrop = drops[drops.length - 1];
      if (lastDrop && (t - lastDrop.t) < minDropGap) {
        if (riseRatio > lastDrop.intensity * riseFactor) {
          const bsT = curve[Math.max(0, i - windowCount)].t;
          const ramp = computeRamp(curve, bsT, t);
          drops[drops.length - 1] = { t, intensity: Math.min(1, (riseRatio - riseFactor) / riseFactor), buildStart: bsT, rampSlope: ramp.slope, rampR2: ramp.r2 };
        }
        continue;
      }
      const buildStartT = curve[Math.max(0, i - windowCount)].t;
      const ramp = computeRamp(curve, buildStartT, t);
      drops.push({ t, intensity: Math.min(1, (riseRatio - riseFactor) / riseFactor), buildStart: buildStartT, rampSlope: ramp.slope, rampR2: ramp.r2 });
    }
  }
  return drops;
}

// ── Transitions ──

function avgEnergyInRange(curve: EnergySample[], peak: number, tStart: number, tEnd: number): number {
  let sum = 0, count = 0;
  for (const s of curve) {
    if (s.t >= tStart && s.t < tEnd) { sum += s.rawRms / peak; count++; }
  }
  return count > 0 ? sum / count : 0;
}

function analyzeTransitions(sections: SongSection[], curve: EnergySample[]): Transition[] {
  if (!sections || sections.length < 2 || curve.length < 10) return [];
  const peak = curvePeakRms(curve);
  if (peak === 0) return [];
  const transitions: Transition[] = [];
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    const transTime = a.end;
    const aEnergy = avgEnergyInRange(curve, peak, transTime - 0.5, transTime);
    const bEnergy = avgEnergyInRange(curve, peak, transTime, transTime + 0.5);
    const delta = bEnergy - aEnergy;
    const absDelta = Math.abs(delta);
    const isHard = absDelta > 0.15;
    transitions.push({
      time: transTime, fromType: a.type, toType: b.type,
      type: isHard ? "hard" : "fade",
      crossfadeMs: isHard ? 50 : Math.round(300 + (1 - absDelta / 0.15) * 700),
      energyDelta: Math.round(delta * 100) / 100,
    });
  }
  return transitions;
}

// ── Beat Strengths ──

function interpolateEnergy(curve: EnergySample[], t: number): number {
  if (curve.length === 0) return 0;
  const peak = curvePeakRms(curve);
  if (peak === 0) return 0;
  const val = (s: EnergySample) => s.rawRms / peak;
  if (t <= curve[0].t) return val(curve[0]);
  if (t >= curve[curve.length - 1].t) return val(curve[curve.length - 1]);
  let lo = 0, hi = curve.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (curve[mid].t <= t) lo = mid; else hi = mid; }
  const prev = curve[lo], next = curve[hi];
  const frac = (t - prev.t) / (next.t - prev.t);
  return val(prev) + (val(next) - val(prev)) * frac;
}

function analyzeBeatStrengths(curve: EnergySample[], beatGrid: BeatGrid): number[] {
  if (!beatGrid || beatGrid.beats.length === 0 || curve.length < 10) return [];
  const strengths: number[] = [];
  for (const beatTime of beatGrid.beats) strengths.push(interpolateEnergy(curve, beatTime));
  const maxStrength = Math.max(...strengths, 0.001);
  return strengths.map(s => Math.round((s / maxStrength) * 100) / 100);
}

// ── Pre-baked brightness curve (professional lighting design) ──
//
// Philosophy: We are designing LIGHTING, not visualizing audio.
// Key principles from DMX/WLED/concert LD practice:
// 1. CIE 1931 perceptual curve — human eye perceives brightness logarithmically
// 2. Separate envelope followers per frequency band (bass/mid/hi)
// 3. ADSR beat envelopes — not just exponential decay
// 4. Anticipation dips — contrast boost before beats
// 5. Noise gate / squelch — silence = dark, no nervous flicker
// 6. Section mood — intentional floor/ceiling per song part

interface BrightnessSample {
  t: number;
  b: number; // 0-100 brightness %
}

// Section mood: floor/ceiling define the brightness range,
// beat = how much beats add, react = how much audio modulates within range
const SECTION_MOOD: Record<string, { floor: number; ceil: number; beat: number; react: number }> = {
  intro:      { floor: 3,  ceil: 20,  beat: 0.05, react: 0.3 },
  verse:      { floor: 8,  ceil: 50,  beat: 0.2,  react: 0.5 },
  pre_chorus: { floor: 15, ceil: 70,  beat: 0.4,  react: 0.6 },
  chorus:     { floor: 25, ceil: 100, beat: 0.7,  react: 0.8 },
  bridge:     { floor: 5,  ceil: 40,  beat: 0.15, react: 0.4 },
  drop:       { floor: 40, ceil: 100, beat: 1.0,  react: 0.9 },
  build_up:   { floor: 8,  ceil: 65,  beat: 0.5,  react: 0.6 },
  break:      { floor: 2,  ceil: 12,  beat: 0.02, react: 0.2 },
  outro:      { floor: 3,  ceil: 18,  beat: 0.05, react: 0.3 },
};
const DEFAULT_MOOD = { floor: 15, ceil: 80, beat: 0.3, react: 0.6 };

// ── CIE 1931 Perceptual Curve ──
// Maps linear brightness (0-1) to perceptually uniform LED PWM value.
// Low values spread out more, high values compress — matches human vision.
function cieLightness(linearVal: number): number {
  const v = Math.max(0, Math.min(1, linearVal));
  // CIE L* to Y (inverse): convert linear energy to perceptual brightness
  // Then we want the inverse: given a desired perceptual level, what PWM?
  // For LED control: PWM = ((L*+16)/116)^3 when L*>=8, else L*/903.3
  // We use L* = v * 100, then compute Y
  const Lstar = v * 100;
  if (Lstar <= 8) {
    return Lstar / 903.3;
  }
  return Math.pow((Lstar + 16) / 116, 3);
}

// ── ADSR Beat Envelope ──
// Professional beat pulse shape: instant attack, fast decay, sustain plateau, smooth release
function adsrBeatPulse(phase: number, isDownbeat: boolean): number {
  // phase: 0 = beat hit, 1 = next beat
  // ADSR timing as fraction of beat period:
  const attackEnd = 0.02;   // ~10ms at 120bpm (500ms period)
  const decayEnd = 0.14;    // ~70ms decay
  const sustainEnd = 0.35;  // sustain plateau
  const sustainLevel = isDownbeat ? 0.55 : 0.40;

  if (phase < attackEnd) {
    // Attack: instant ramp to 1.0
    return phase / attackEnd;
  } else if (phase < decayEnd) {
    // Decay: drop from 1.0 to sustain level
    const decayProgress = (phase - attackEnd) / (decayEnd - attackEnd);
    return 1.0 - (1.0 - sustainLevel) * decayProgress;
  } else if (phase < sustainEnd) {
    // Sustain: hold at sustain level
    return sustainLevel;
  } else {
    // Release: smooth fade to 0
    const releaseProgress = (phase - sustainEnd) / (1.0 - sustainEnd);
    return sustainLevel * Math.exp(-releaseProgress * 3.5);
  }
}

function computeBrightnessCurve(
  curve: EnergySample[],
  sections: SongSection[] | null,
  beatGrid: BeatGrid | null,
  drops: Drop[] | null,
  transitions: { time: number; type: string; crossfadeMs: number }[] | null,
  beatStrengths: number[] | null,
  dynamicRange: DynamicRange | null,
  cal: { attackAlpha: number; releaseAlpha: number; dynamicDamping: number; minBrightness: number; maxBrightness: number },
): BrightnessSample[] {
  const peak = curvePeakRms(curve);
  if (peak === 0) return curve.map(s => ({ t: s.t, b: 0 }));

  const result: BrightnessSample[] = [];

  // ── Noise gate threshold (P10) ──
  // Anything below P10 is treated as silence → fixed ambient floor, no reactivity
  const allRms = curve.map(s => s.rawRms).sort((a, b) => a - b);
  const p10raw = allRms[Math.floor(allRms.length * 0.1)] ?? 0;
  const p90raw = allRms[Math.floor(allRms.length * 0.9)] ?? peak;
  const noiseGateThreshold = p10raw / peak;
  const dynamicSpread = Math.max(0.05, (p90raw - p10raw) / peak);

  // ── Per-band envelope state ──
  // Separate EMA followers with band-specific attack/release
  let envBass = 0;  // drives 70% of brightness
  let envMid = 0;   // drives 20% — color modulation + subtle brightness
  let envHi = 0;    // drives 10% — sparkle/strobe accents

  // Band-specific EMA coefficients (tuned for ~100ms sample interval)
  // Converted from ms-based times: alpha ≈ 1 - exp(-interval/tau)
  const BASS_ATTACK = 0.45;  const BASS_RELEASE = 0.12;   // 15ms attack, 80ms release
  const MID_ATTACK = 0.55;   const MID_RELEASE = 0.18;    // 10ms attack, 50ms release
  const HI_ATTACK = 0.70;    const HI_RELEASE = 0.28;     // 5ms attack, 30ms release

  // ── Helpers ──
  const getSection = (t: number): SongSection | null => {
    if (!sections) return null;
    for (const s of sections) if (t >= s.start && t < s.end) return s;
    return null;
  };

  const getBuildUp = (t: number): number => {
    if (!drops) return 0;
    for (const drop of drops) {
      if (t >= drop.buildStart && t < drop.t) {
        const total = drop.t - drop.buildStart;
        if (total <= 0) continue;
        const progress = (t - drop.buildStart) / total;
        if (drop.rampR2 != null && drop.rampR2 > 0.4 && drop.rampSlope != null && drop.rampSlope > 0) {
          return Math.min(1, Math.pow(progress, 1.5 + drop.rampR2) * drop.intensity);
        }
        return Math.min(1, progress * drop.intensity);
      }
    }
    return 0;
  };

  const isInDropFn = (t: number): boolean => {
    if (!drops) return false;
    for (const d of drops) if (t >= d.t && t < d.t + 3) return true;
    return false;
  };

  // Find nearest beat index for anticipation dips and strength lookup
  const findNearestBeat = (t: number): { dist: number; index: number; phase: number; isDownbeat: boolean } => {
    if (!beatGrid || beatGrid.beats.length === 0) return { dist: 999, index: -1, phase: 0, isDownbeat: false };
    let closest = 0, minDist = Math.abs(beatGrid.beats[0] - t);
    for (let i = 1; i < beatGrid.beats.length; i++) {
      const dist = Math.abs(beatGrid.beats[i] - t);
      if (dist < minDist) { minDist = dist; closest = i; }
      if (beatGrid.beats[i] > t + 0.2) break;
    }
    const beatPeriod = 60 / beatGrid.bpm;
    const phase = ((t - beatGrid.offsetSec) / beatPeriod) % 1;
    const normalizedPhase = phase < 0 ? phase + 1 : phase;
    // Downbeat = every 4th beat (beat 1 of the bar)
    const isDownbeat = closest % 4 === 0;
    return { dist: minDist, index: closest, phase: normalizedPhase, isDownbeat };
  };

  const getTransition = (t: number): { active: boolean; type: string; progress: number } => {
    if (!transitions) return { active: false, type: 'fade', progress: 1 };
    for (const tr of transitions) {
      const durSec = tr.crossfadeMs / 1000;
      const halfBefore = durSec * 0.3;
      const halfAfter = durSec * 0.7;
      if (t >= tr.time - halfBefore && t < tr.time + halfAfter) {
        const elapsed = t - (tr.time - halfBefore);
        return { active: true, type: tr.type, progress: Math.min(1, elapsed / durSec) };
      }
    }
    return { active: false, type: 'fade', progress: 1 };
  };

  // Ambient floor for noise-gated passages (2-3%)
  const AMBIENT_FLOOR = 2;

  for (const sample of curve) {
    const t = sample.t;
    const rawNorm = sample.rawRms / peak;

    // ── Step 1: Noise Gate ──
    // Below P10 threshold → fixed ambient, no reactive lighting
    if (rawNorm < noiseGateThreshold * 1.1) {
      // Check if we're in a break with breathing effect
      const section = getSection(t);
      const sectionType = section?.type ?? null;
      if (sectionType === 'break') {
        // Slow breathing: 0.5 Hz sine wave
        const breath = Math.sin(t * 0.5 * Math.PI * 2) * 0.5 + 0.5;
        const breathBrightness = AMBIENT_FLOOR + breath * 3; // 2-5%
        result.push({ t, b: Math.round(breathBrightness) });
      } else {
        result.push({ t, b: AMBIENT_FLOOR });
      }
      // Reset envelopes gently to avoid pop when sound returns
      envBass *= 0.95;
      envMid *= 0.95;
      envHi *= 0.95;
      continue;
    }

    // ── Step 2: Per-band envelope followers ──
    // Percentile-stretch the overall signal
    const stretchedEnergy = Math.min(1, Math.max(0, (rawNorm - noiseGateThreshold) / dynamicSpread));

    const bass = sample.lo ?? rawNorm;
    const mid = sample.mid ?? rawNorm * 0.5;
    const hi = sample.hi ?? rawNorm * 0.3;

    // Apply band-specific EMA
    const bassAlpha = bass > envBass ? BASS_ATTACK : BASS_RELEASE;
    envBass += (bass - envBass) * bassAlpha;

    const midAlpha = mid > envMid ? MID_ATTACK : MID_RELEASE;
    envMid += (mid - envMid) * midAlpha;

    const hiAlpha = hi > envHi ? HI_ATTACK : HI_RELEASE;
    envHi += (hi - envHi) * hiAlpha;

    // Blend bands: bass-heavy weighting (professional LDs always prioritize bass for brightness)
    const blended = envBass * 0.70 + envMid * 0.20 + envHi * 0.10;

    // ── Step 3: CIE 1931 perceptual curve ──
    // Convert linear energy to perceptually uniform brightness
    const perceptual = cieLightness(blended);

    // ── Step 4: Section mood mapping ──
    const section = getSection(t);
    const sectionType = section?.type ?? null;
    const mood = sectionType ? (SECTION_MOOD[sectionType] ?? DEFAULT_MOOD) : DEFAULT_MOOD;

    // Scale floor/ceiling by calibration range
    const calRange = cal.maxBrightness - cal.minBrightness;
    const moodFloor = cal.minBrightness + (mood.floor / 100) * calRange;
    const moodCeil = cal.minBrightness + (mood.ceil / 100) * calRange;

    // Map perceptual energy into section's brightness range
    const moodMid = (moodFloor + moodCeil) / 2;
    const halfRange = (moodCeil - moodFloor) / 2;
    let pct = moodMid + (perceptual * 2 - 1) * halfRange * mood.react;

    // ── Step 5: Build-up effects ──
    const buildUp = getBuildUp(t);
    if (buildUp > 0) {
      if (buildUp > 0.9) {
        // Blackout before drop — dramatic contrast
        const blackoutProgress = (buildUp - 0.9) / 0.1;
        pct = pct * (1 - blackoutProgress * 0.92);
      } else if (buildUp > 0.4 && beatGrid && beatGrid.bpm > 0) {
        // 16th-note acceleration toward drop
        const breathFreq = 2 + Math.pow(buildUp, 2) * 12; // exponential freq ramp
        const breath = Math.sin(t * breathFreq * Math.PI * 2) * 0.5 + 0.5;
        const breathAmt = Math.pow((buildUp - 0.4) / 0.6, 1.5) * 0.35;
        pct = pct * (1 - breathAmt + breathAmt * breath);
      }
    }

    // ── Step 6: Drop aftermath — force high intensity ──
    if (isInDropFn(t)) {
      pct = Math.max(pct, moodCeil * 0.75);
    }

    // ── Step 7: ADSR Beat pulse with anticipation dip ──
    if (mood.beat > 0 && beatGrid && beatGrid.bpm > 0) {
      const beat = findNearestBeat(t);
      const beatPeriodSec = 60 / beatGrid.bpm;

      // Anticipation dip: 30ms before beat, reduce brightness by 20%
      const dipWindowSec = 0.030;
      // Find time to next beat
      let timeToNextBeat = 999;
      if (beat.index >= 0 && beat.index < beatGrid.beats.length) {
        // Check current and next beat
        for (let bi = Math.max(0, beat.index); bi <= Math.min(beatGrid.beats.length - 1, beat.index + 1); bi++) {
          const diff = beatGrid.beats[bi] - t;
          if (diff > 0 && diff < timeToNextBeat) timeToNextBeat = diff;
        }
      }

      if (timeToNextBeat <= dipWindowSec && timeToNextBeat > 0) {
        // Anticipation dip — pull brightness down for contrast
        const dipStrength = 0.20 * mood.beat;
        pct = pct * (1 - dipStrength);
      }

      // ADSR pulse (only near a beat)
      if (beat.dist < 0.15) {
        const pulse = adsrBeatPulse(beat.phase, beat.isDownbeat);
        const beatBoost = pulse * mood.beat * 30;
        // Downbeats get extra punch
        const downbeatMultiplier = beat.isDownbeat ? 1.3 : 1.0;
        pct = Math.min(100, pct + beatBoost * downbeatMultiplier);
      }
    }

    // ── Step 8: Break breathing (for sections with some audio above gate) ──
    if (sectionType === 'break' && buildUp <= 0) {
      const breath = Math.sin(t * 0.5 * Math.PI * 2) * 0.5 + 0.5;
      pct = AMBIENT_FLOOR + breath * (moodCeil - AMBIENT_FLOOR);
    }

    // ── Step 9: Hard transition flash ──
    const trans = getTransition(t);
    if (trans.active && trans.type === 'hard' && trans.progress < 0.15) {
      pct = Math.min(100, pct + 35);
    }

    pct = Math.max(cal.minBrightness, Math.min(cal.maxBrightness, pct));
    result.push({ t, b: Math.round(pct) });
  }

  return result;
}

// ── Auto-calibration: EMA dynamics grid search ──

function findOptimalDynamics(normalized: number[]): { attack: number; release: number; damping: number } {
  let bestAttack = 0.3, bestRelease = 0.05, bestDamping = 1.0, bestMSE = Infinity;

  const runEMA = (attack: number, release: number, damping: number): number => {
    let smoothed = normalized[0] || 0;
    let mse = 0;
    for (let i = 0; i < normalized.length; i++) {
      const raw = normalized[i];
      const alpha = raw > smoothed ? attack : release;
      smoothed += (raw - smoothed) * alpha;
      const dampedSmoothed = Math.pow(smoothed, 1 / damping);
      const err = dampedSmoothed - normalized[i];
      mse += err * err;
    }
    return mse / normalized.length;
  };

  // Coarse grid
  for (let attack = 0.15; attack <= 0.85; attack += 0.1) {
    for (let release = 0.03; release <= 0.18; release += 0.03) {
      for (let damping = 1.0; damping <= 2.5; damping += 0.5) {
        const mse = runEMA(attack, release, damping);
        if (mse < bestMSE) { bestMSE = mse; bestAttack = attack; bestRelease = release; bestDamping = damping; }
      }
    }
  }

  // Fine grid around best
  for (let attack = Math.max(0.1, bestAttack - 0.1); attack <= Math.min(0.9, bestAttack + 0.1); attack += 0.02) {
    for (let release = Math.max(0.02, bestRelease - 0.03); release <= Math.min(0.2, bestRelease + 0.03); release += 0.005) {
      for (let damping = Math.max(1.0, bestDamping - 0.5); damping <= Math.min(3.0, bestDamping + 0.5); damping += 0.1) {
        const mse = runEMA(attack, release, damping);
        if (mse < bestMSE) { bestMSE = mse; bestAttack = attack; bestRelease = release; bestDamping = damping; }
      }
    }
  }

  return {
    attack: Math.round(bestAttack * 100) / 100,
    release: Math.round(bestRelease * 1000) / 1000,
    damping: Math.round(bestDamping * 10) / 10,
  };
}

// ── Main handler ──

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Find songs that have energy_curve but are missing analysis fields
    const { data: songs, error } = await supabase
      .from("song_analysis")
      .select("id, track_name, artist_name, energy_curve, bpm, beat_grid, drops, dynamic_range, transitions, beat_strengths, sections, brightness_curve")
      .not("energy_curve", "is", null);

    if (error) throw error;

    let processed = 0;
    const results: string[] = [];

    for (const song of (songs ?? [])) {
      const curve = song.energy_curve as unknown as EnergySample[];
      if (!Array.isArray(curve) || curve.length < 50) continue;

      const updates: Record<string, unknown> = {};
      let needsUpdate = false;

      // BPM
      let bpm = song.bpm as number | null;
      if (!bpm) {
        bpm = estimateBpm(curve);
        if (bpm) { updates.bpm = bpm; needsUpdate = true; }
      }

      // Beat grid
      let beatGrid = song.beat_grid as BeatGrid | null;
      if (!beatGrid && bpm) {
        beatGrid = buildBeatGrid(curve, bpm);
        if (beatGrid) { updates.beat_grid = beatGrid; needsUpdate = true; }
      }

      // Drops
      if (!song.drops) {
        const drops = detectDrops(curve);
        if (drops.length > 0) { updates.drops = drops; needsUpdate = true; }
      }

      // Dynamic range
      if (!song.dynamic_range) {
        updates.dynamic_range = analyzeDynamicRange(curve);
        needsUpdate = true;
      }

      // Beat strengths
      if (!song.beat_strengths && beatGrid) {
        const strengths = analyzeBeatStrengths(curve, beatGrid);
        if (strengths.length > 0) { updates.beat_strengths = strengths; needsUpdate = true; }
      }

      // Sections (trigger AI analysis)
      const sections = song.sections as unknown as SongSection[] | null;
      if (!sections || (sections as unknown[]).length === 0) {
        try {
          const url = Deno.env.get("SUPABASE_URL")!;
          const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
          const resp = await fetch(`${url}/functions/v1/analyze-sections`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ songId: song.id }),
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data.sections && data.sections.length > 0) {
              // Sections already saved by analyze-sections, compute transitions
              const newTransitions = analyzeTransitions(data.sections, curve);
              if (newTransitions.length > 0) { updates.transitions = newTransitions; needsUpdate = true; }
            }
          }
        } catch (e) {
          console.error(`[process-songs] section analysis failed for ${song.track_name}:`, e);
        }
      }

      // Transitions (if we have sections but no transitions)
      if (!song.transitions && sections && (sections as unknown[]).length > 1) {
        const transitions = analyzeTransitions(sections, curve);
        if (transitions.length > 0) { updates.transitions = transitions; needsUpdate = true; }
      }

      if (needsUpdate) {
        await supabase.from("song_analysis").update(updates as any).eq("id", song.id);
        processed++;
        results.push(song.track_name);
      }
    }

    // ── Multi-song auto-calibration ──
    // Recompute global dynamics params if any songs were processed
    if (processed > 0) {
      try {
        const { data: allSongs } = await supabase
          .from("song_analysis")
          .select("track_name, artist_name, energy_curve")
          .not("energy_curve", "is", null);

        const validSongs = (allSongs ?? []).filter(
          (s: any) => Array.isArray(s.energy_curve) && s.energy_curve.length > 50,
        );

        if (validSongs.length > 0) {
          const perSongResults: { attack: number; release: number; damping: number }[] = [];

          for (const s of validSongs) {
            const curve = s.energy_curve as EnergySample[];
            let peak = 0;
            for (const sample of curve) if (sample.rawRms > peak) peak = sample.rawRms;
            if (peak === 0) continue;

            // Normalize curve and run EMA grid search
            const normalized = curve.map(sample => sample.rawRms / peak);
            const best = findOptimalDynamics(normalized);
            perSongResults.push(best);
          }

          if (perSongResults.length > 0) {
            const median = (arr: number[]) => {
              const sorted = [...arr].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
            };

            const globalAttack = Math.round(median(perSongResults.map(r => r.attack)) * 100) / 100;
            const globalRelease = Math.round(median(perSongResults.map(r => r.release)) * 1000) / 1000;
            const globalDamping = Math.round(median(perSongResults.map(r => r.damping)) * 10) / 10;

            // Update all device_calibration rows with new dynamics
            const { data: devices } = await supabase
              .from("device_calibration")
              .select("id, calibration");

            for (const device of (devices ?? [])) {
              const cal = (device.calibration as Record<string, unknown>) ?? {};
              const updated = {
                ...cal,
                attackAlpha: globalAttack,
                releaseAlpha: globalRelease,
                dynamicDamping: globalDamping,
              };
              await supabase
                .from("device_calibration")
                .update({ calibration: updated })
                .eq("id", device.id);
            }

            console.log(`[process-songs] auto-calibration: attack=${globalAttack} release=${globalRelease} damping=${globalDamping} from ${perSongResults.length} songs`);
          }
        }
      } catch (e) {
        console.error("[process-songs] auto-calibration error:", e);
      }
    }

    // ── Bake brightness curves ──
    const defaultCal = { attackAlpha: 0.3, releaseAlpha: 0.05, dynamicDamping: 1.0, minBrightness: 3, maxBrightness: 100 };

    // Bake for all songs that have analysis but missing brightness_curve (or were just processed)
    const { data: allForBake } = await supabase
      .from("song_analysis")
      .select("id, track_name, energy_curve, sections, beat_grid, drops, transitions, beat_strengths, dynamic_range, brightness_curve, bpm, calibration_snapshot")
      .not("energy_curve", "is", null);

    let baked = 0;
    for (const song of (allForBake ?? [])) {
      const curve = song.energy_curve as unknown as EnergySample[];
      if (!Array.isArray(curve) || curve.length < 50) continue;

      // Skip if already baked and not just re-processed
      if (song.brightness_curve && !results.includes(song.track_name)) continue;

      // Need at least BPM to bake a decent curve
      if (!song.bpm) continue;

      // Use the calibration snapshot saved at recording time (per-song), fallback to defaults
      const snapshot = song.calibration_snapshot as Record<string, unknown> | null;
      const songCal = snapshot ? {
        attackAlpha: (snapshot.attackAlpha as number) ?? defaultCal.attackAlpha,
        releaseAlpha: (snapshot.releaseAlpha as number) ?? defaultCal.releaseAlpha,
        dynamicDamping: (snapshot.dynamicDamping as number) ?? defaultCal.dynamicDamping,
        minBrightness: (snapshot.minBrightness as number) ?? defaultCal.minBrightness,
        maxBrightness: (snapshot.maxBrightness as number) ?? defaultCal.maxBrightness,
      } : defaultCal;

      const bc = computeBrightnessCurve(
        curve,
        song.sections as unknown as SongSection[] | null,
        song.beat_grid as unknown as BeatGrid | null,
        song.drops as unknown as Drop[] | null,
        song.transitions as unknown as { time: number; type: string; crossfadeMs: number }[] | null,
        song.beat_strengths as unknown as number[] | null,
        song.dynamic_range as unknown as DynamicRange | null,
        songCal,
      );

      await supabase.from("song_analysis").update({ brightness_curve: bc } as any).eq("id", song.id);
      baked++;
    }

    console.log(`[process-songs] processed ${processed} songs, baked ${baked} brightness curves:`, results);

    return new Response(JSON.stringify({ processed, songs: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[process-songs] error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
