/**
 * seqPolish — analys och finslipning (DSP) av inspelade ljus-sekvenser.
 *
 * En sekvens är frames [tMs, pct, r, g, b] nedsamplade till ~25 Hz. Finslipningen
 * kör rena signalsteg på den inspelade datan (ingen ljud-analys, ingen AI):
 *   1. Luck-utfyllnad — interpolerar över tappade frames/glapp.
 *   2. Mjukare övergångar — lätt temporal utjämning av brightness/färg.
 *   3. Normalisering — skalar brightness så dynamiken utnyttjar hela spannet.
 *   4. Transient-bevarande — skarpa beat-träffar jämnas inte bort.
 */

type Frame = number[]; // [tMs, pct, r, g, b]

export interface SeqAnalysis {
  durationMs: number;
  frameCount: number;
  gaps: number;          // antal glapp (> 2× medianintervall)
  beats: number;         // antal detekterade beats
  brightnessMin: number;
  brightnessAvg: number;
  brightnessMax: number;
  flicker: number;       // medel-|Δpct| mellan frames (0-255-skala)
}

const SAMPLE_INTERVAL_MS = 40;   // ~25 Hz (matchar lightRecorder)
const SMOOTH_ALPHA = 0.5;        // EMA-faktor för mjukare övergångar
const TRANSIENT_DELTA = 40;      // pct-hopp som alltid bevaras (säkerhet)

// Beat-detektering på pct-envelopen.
const BEAT_WINDOW = 21;          // ~840 ms adaptivt tröskelfönster
const BEAT_REFRACTORY = 3;       // min 3 frames (~120 ms) mellan beats
const BEAT_K = 1.4;              // tröskel = medel + K·std av flux i fönstret
const BEAT_FLUX_FLOOR = 6;       // minsta flux (pct) för att räknas som beat
const BEAT_EMPHASIS = 1.08;      // lätt emfas på beat-toppen

/**
 * Detekterar beats ur pct-envelopen via positiv flux + adaptiv tröskel med
 * refraktärtid. Returnerar index på beat-frames (stigande).
 */
export function detectBeats(frames: Frame[]): number[] {
  const n = frames.length;
  if (n < 3) return [];
  const flux = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const d = frames[i][1] - frames[i - 1][1];
    flux[i] = d > 0 ? d : 0;
  }
  const beats: number[] = [];
  let lastBeat = -BEAT_REFRACTORY;
  const half = BEAT_WINDOW >> 1;
  for (let i = 1; i < n; i++) {
    const lo = Math.max(1, i - half), hi = Math.min(n - 1, i + half);
    let sum = 0, cnt = 0;
    for (let j = lo; j <= hi; j++) { sum += flux[j]; cnt++; }
    const mean = sum / cnt;
    let varSum = 0;
    for (let j = lo; j <= hi; j++) { const d = flux[j] - mean; varSum += d * d; }
    const std = Math.sqrt(varSum / cnt);
    const thr = Math.max(BEAT_FLUX_FLOOR, mean + BEAT_K * std);
    // Lokalt max över sina grannar + över tröskeln + refraktär.
    if (flux[i] >= thr && flux[i] >= flux[i - 1] && flux[i] >= (flux[i + 1] ?? 0) && i - lastBeat >= BEAT_REFRACTORY) {
      beats.push(i);
      lastBeat = i;
    }
  }
  return beats;
}

export function analyze(frames: Frame[]): SeqAnalysis {
  const n = frames.length;
  if (n === 0) {
    return { durationMs: 0, frameCount: 0, gaps: 0, beats: 0, brightnessMin: 0, brightnessAvg: 0, brightnessMax: 0, flicker: 0 };
  }
  let min = 255, max = 0, sum = 0, flickerSum = 0, gaps = 0;
  for (let i = 0; i < n; i++) {
    const pct = frames[i][1];
    if (pct < min) min = pct;
    if (pct > max) max = pct;
    sum += pct;
    if (i > 0) {
      flickerSum += Math.abs(pct - frames[i - 1][1]);
      const dt = frames[i][0] - frames[i - 1][0];
      if (dt > SAMPLE_INTERVAL_MS * 2.5) gaps++;
    }
  }
  return {
    durationMs: frames[n - 1][0],
    frameCount: n,
    gaps,
    beats: detectBeats(frames).length,
    brightnessMin: min,
    brightnessAvg: Math.round(sum / n),
    brightnessMax: max,
    flicker: Math.round((flickerSum / Math.max(1, n - 1)) * 10) / 10,
  };
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Skapar en jämn tidsaxel och interpolerar frames över glapp. */
function fillGaps(frames: Frame[]): Frame[] {
  const n = frames.length;
  if (n < 2) return frames.map((f) => f.slice());
  const out: Frame[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    out.push(a.slice());
    const dt = b[0] - a[0];
    if (dt > SAMPLE_INTERVAL_MS * 2.5) {
      const steps = Math.floor(dt / SAMPLE_INTERVAL_MS) - 1;
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        out.push([
          Math.round(a[0] + dt * t),
          clamp8(a[1] + (b[1] - a[1]) * t),
          clamp8(a[2] + (b[2] - a[2]) * t),
          clamp8(a[3] + (b[3] - a[3]) * t),
          clamp8(a[4] + (b[4] - a[4]) * t),
        ]);
      }
    }
  }
  out.push(frames[n - 1].slice());
  return out;
}

/** EMA-utjämning som bevarar skarpa transienter (stora pct-hopp). */
function smooth(frames: Frame[], beatSet: Set<number>): Frame[] {
  const n = frames.length;
  if (n < 2) return frames;
  const out: Frame[] = [frames[0].slice()];
  let pp = frames[0][1], pr = frames[0][2], pg = frames[0][3], pb = frames[0][4];
  for (let i = 1; i < n; i++) {
    const f = frames[i];
    // Vid en beat (eller stort hopp): skarp attack — nollställ EMA till råvärdet
    // och lägg lätt emfas på toppen så slaget poppar.
    const isBeat = beatSet.has(i);
    const transient = isBeat || Math.abs(f[1] - frames[i - 1][1]) >= TRANSIENT_DELTA;
    if (transient) {
      const emph = isBeat ? clamp8(f[1] * BEAT_EMPHASIS) : f[1];
      pp = emph; pr = f[2]; pg = f[3]; pb = f[4];
      out.push([f[0], emph, f[2], f[3], f[4]]);
    } else {
      pp = pp + (f[1] - pp) * SMOOTH_ALPHA;
      pr = pr + (f[2] - pr) * SMOOTH_ALPHA;
      pg = pg + (f[3] - pg) * SMOOTH_ALPHA;
      pb = pb + (f[4] - pb) * SMOOTH_ALPHA;
      out.push([f[0], clamp8(pp), clamp8(pr), clamp8(pg), clamp8(pb)]);
    }
  }
  return out;
}

/** Skalar brightness så att 95:e percentilen når nära taket utan att klippa. */
function normalize(frames: Frame[]): Frame[] {
  const n = frames.length;
  if (n === 0) return frames;
  const sorted = frames.map((f) => f[1]).sort((a, b) => a - b);
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  if (p95 <= 0 || p95 >= 245) return frames;
  const scale = 245 / p95;
  if (scale <= 1.02) return frames; // redan bra utnyttjat spann
  return frames.map((f) => [f[0], clamp8(f[1] * scale), f[2], f[3], f[4]]);
}

export function polish(frames: Frame[]): Frame[] {
  if (frames.length < 2) return frames.map((f) => f.slice());
  const filled = fillGaps(frames);
  const beatSet = new Set(detectBeats(filled));
  return normalize(smooth(filled, beatSet));
}

