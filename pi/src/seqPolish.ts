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
  bpm: number;           // skattat tempo (0 = okänt)
  brightnessMin: number;
  brightnessAvg: number;
  brightnessMax: number;
  flicker: number;       // medel-|Δpct| mellan frames (0-255-skala)
}

// VIKTIGT: brightness (pct) ligger på 0–100-skalan — samma som enginen skickar
// till BLE. Färgkanalerna (r,g,b) ligger på 0–255. Polish rör bara pct.
const PCT_MAX = 100;             // ljus-taket (0–100)

// ── Frame-rate-oberoende konstanter ──
const CONTRAST = 1.45;           // dynamik-expansion: mörkare dalar, ljusare toppar
const BEAT_K = 2.0;              // tröskel = medel + K·std av flux i fönstret (striktare)
const BEAT_PROMINENCE = 1.5;     // topp måste vara prominent över näst-största i ±3 (striktare)
const FLOOR_PCT = 16;            // ljus-golv (lamporna slocknar aldrig helt)
const PREDIP_DEPTH = 0.6;        // hur djupt under golvet dippen drar (relativt)
const BEAT_BOOST = 1.7;          // topp-boost på slaget (tydlig taktkänsla)
const NONBEAT_DAMP = 0.45;       // hur mycket icke-beat-dynamik bevaras (0=platt golv, 1=oförändrat)
const BLE_FRAME_MS = 33;         // ~30 Hz — säker BLEDOM-nivå (sample-and-hold)
const LEAD_MS = 25;              // ljuset leder ljudet i sparad sekvens (offline-anticipation)
const BLE_FRAME_MS = 33;         // ~30 Hz — säker BLEDOM-nivå (sample-and-hold)

// ── Referensvärden, tunade för 40 ms/frame (25 Hz) ──
// Alla frame-/flux-beroende konstanter räknas om i configureFrameRate() utifrån
// sekvensens faktiska frame-intervall, så finslipningen ger samma "feel" oavsett
// inspelningstakt (nu 100 Hz / 10 ms).
const REF_MS = 40;
const SMOOTH_ALPHA_REF = 0.5;    // EMA-faktor för färg-övergångar
const ATTACK_ALPHA_REF = 0.85;   // brightness stiger snabbt (skarp attack)
const RELEASE_ALPHA_REF = 0.55;  // brightness faller raskt → tydliga dalar mellan slag
const VOCAL_ALPHA_REF = 0.18;    // mycket mjuk EMA för lugna/sång-partier
const TRANSIENT_DELTA_REF = 16;  // pct-hopp som alltid bevaras (per ref-frame)
const CALM_FLUX_BASE = 10;       // flux-referens: under detta → fullt "calm"
const CALM_WINDOW_REF = 5;       // ±frames för lokal flux-medel (calm-mått)
const BEAT_WINDOW_REF = 21;      // ~840 ms adaptivt tröskelfönster
const BEAT_REFRACTORY_REF = 3;   // min ~120 ms mellan beats
const BEAT_FLUX_FLOOR_REF = 8;   // minsta flux (per ref-frame) för att räknas som beat
const GRID_ONSET_MIN_REF = 6;    // min positiv flux runt grid-slot, annars falskt beat
const PREDIP_FRAMES_REF = 2;     // antal frames dip före slaget
const BEAT_DECAY_REF = 0.5;      // additiv boost halveras varje ref-frame efteråt
const BEAT_TAIL_REF = 5;         // antal frames decay-svansen sträcker sig
const NONBEAT_FALLOFF_REF = 4;   // frames runt ett beat som lämnas oförändrade

// ── Runtime-konstanter (sätts av configureFrameRate per sekvens) ──
let SAMPLE_INTERVAL_MS = REF_MS;
let SMOOTH_ALPHA = SMOOTH_ALPHA_REF;
let ATTACK_ALPHA = ATTACK_ALPHA_REF;
let RELEASE_ALPHA = RELEASE_ALPHA_REF;
let VOCAL_ALPHA = VOCAL_ALPHA_REF;
let TRANSIENT_DELTA = TRANSIENT_DELTA_REF;
let CALM_FLUX_REF = CALM_FLUX_BASE;
let CALM_WINDOW = CALM_WINDOW_REF;
let BEAT_WINDOW = BEAT_WINDOW_REF;
let BEAT_REFRACTORY = BEAT_REFRACTORY_REF;
let BEAT_FLUX_FLOOR = BEAT_FLUX_FLOOR_REF;
let GRID_ONSET_MIN = GRID_ONSET_MIN_REF;
let PREDIP_FRAMES = PREDIP_FRAMES_REF;
let BEAT_DECAY = BEAT_DECAY_REF;
let BEAT_TAIL = BEAT_TAIL_REF;
let NONBEAT_FALLOFF = NONBEAT_FALLOFF_REF;

/** Mediant frame-intervall (ms) ur tidsstämplarna. */
function medianFrameMs(frames: Frame[]): number {
  const n = frames.length;
  if (n < 3) return REF_MS;
  const d: number[] = [];
  for (let i = 1; i < n; i++) d.push(frames[i][0] - frames[i - 1][0]);
  d.sort((a, b) => a - b);
  const m = d[d.length >> 1];
  return m > 0 ? m : REF_MS;
}

/**
 * Skala om alla frame-/flux-beroende konstanter till sekvensens faktiska takt.
 * - EMA-alfor: 1−(1−a)^r så tidskonstanten bevaras.
 * - Fönster (frames): ×REF_MS/frameMs (fler frames vid högre takt).
 * - Per-frame flux/delta: ×frameMs/REF_MS (mindre Δ per frame vid högre takt).
 */
function configureFrameRate(frames: Frame[]): void {
  const fm = medianFrameMs(frames);
  SAMPLE_INTERVAL_MS = fm;
  const r = fm / REF_MS;     // <1 vid snabbare takt
  const inv = REF_MS / fm;   // >1 vid snabbare takt
  const ema = (a: number) => 1 - Math.pow(1 - a, r);
  SMOOTH_ALPHA = ema(SMOOTH_ALPHA_REF);
  ATTACK_ALPHA = ema(ATTACK_ALPHA_REF);
  RELEASE_ALPHA = ema(RELEASE_ALPHA_REF);
  VOCAL_ALPHA = ema(VOCAL_ALPHA_REF);
  TRANSIENT_DELTA = TRANSIENT_DELTA_REF * r;
  CALM_FLUX_REF = CALM_FLUX_BASE * r;
  BEAT_FLUX_FLOOR = BEAT_FLUX_FLOOR_REF * r;
  GRID_ONSET_MIN = GRID_ONSET_MIN_REF * r;
  CALM_WINDOW = Math.max(1, Math.round(CALM_WINDOW_REF * inv));
  BEAT_WINDOW = Math.max(3, Math.round(BEAT_WINDOW_REF * inv));
  BEAT_REFRACTORY = Math.max(1, Math.round(BEAT_REFRACTORY_REF * inv));
  PREDIP_FRAMES = Math.max(1, Math.round(PREDIP_FRAMES_REF * inv));
  BEAT_TAIL = Math.max(1, Math.round(BEAT_TAIL_REF * inv));
  NONBEAT_FALLOFF = Math.max(1, Math.round(NONBEAT_FALLOFF_REF * inv));
  BEAT_DECAY = Math.pow(BEAT_DECAY_REF, r);
}



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
    if (flux[i] < thr || i - lastBeat < BEAT_REFRACTORY) continue;
    // Strikt lokal topp över ±2 frames + prominens över näst-största i fönstret.
    let isPeak = true, secondMax = 0;
    for (let k = -2; k <= 2; k++) {
      if (k === 0) continue;
      const v = flux[i + k] ?? 0;
      if (v > flux[i]) { isPeak = false; break; }
      if (v > secondMax) secondMax = v;
    }
    if (isPeak && flux[i] >= BEAT_PROMINENCE * secondMax) {
      beats.push(i);
      lastBeat = i;
    }

  }
  return beats;
}

/**
 * Skattar tempo (BPM) från inter-beat-intervallen. Veckar oktav-fel (dubbla/
 * halva slag) mot medianen och normaliserar till ett musikaliskt spann.
 */
export function estimateBpm(frames: Frame[], beats: number[]): number {
  if (beats.length < 4) return 0;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    intervals.push(frames[beats[i]][0] - frames[beats[i - 1]][0]);
  }
  intervals.sort((a, b) => a - b);
  const median = intervals[intervals.length >> 1];
  if (median <= 0) return 0;
  let sum = 0;
  for (let iv of intervals) {
    while (iv > median * 1.4) iv /= 2;
    while (iv < median * 0.7) iv *= 2;
    sum += iv;
  }
  let bpm = 60000 / (sum / intervals.length);
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

/**
 * Bygger ett jämnt beat-grid förankrat i första detekterade slaget och snappar
 * varje rutnäts-slag till närmaste lokala energi-topp (±2 frames).
 */
function buildBeatGrid(frames: Frame[], beats: number[]): number[] {
  const bpm = estimateBpm(frames, beats);
  if (!bpm || beats.length < 4) return [];
  const periodFrames = (60000 / bpm) / SAMPLE_INTERVAL_MS;
  // Lokal positiv flux för onset-validering av varje grid-slot.
  const flux = new Float64Array(frames.length);
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i][1] - frames[i - 1][1];
    flux[i] = d > 0 ? d : 0;
  }
  const grid: number[] = [];
  for (let t = beats[0] % periodFrames; t < frames.length; t += periodFrames) {
    const idx = Math.round(t);
    let best = idx, bestV = frames[idx]?.[1] ?? -1;
    for (let k = -2; k <= 2; k++) {
      const j = idx + k;
      if (j >= 0 && j < frames.length && frames[j][1] > bestV) { bestV = frames[j][1]; best = j; }
    }
    // Hoppa över slag utan tillräcklig onset-energi (falskt beat).
    let maxFlux = 0;
    for (let k = -1; k <= 1; k++) { const v = flux[best + k] ?? 0; if (v > maxFlux) maxFlux = v; }
    if (maxFlux < GRID_ONSET_MIN) continue;
    if (grid[grid.length - 1] !== best) grid.push(best);
  }
  return grid;
}


export function analyze(frames: Frame[]): SeqAnalysis {
  const n = frames.length;
  if (n === 0) {
    return { durationMs: 0, frameCount: 0, gaps: 0, beats: 0, bpm: 0, brightnessMin: 0, brightnessAvg: 0, brightnessMax: 0, flicker: 0 };
  }
  configureFrameRate(frames);
  let min = PCT_MAX, max = 0, sum = 0, flickerSum = 0, gaps = 0;
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
  const beats = detectBeats(frames);
  return {
    durationMs: frames[n - 1][0],
    frameCount: n,
    gaps,
    beats: beats.length,
    bpm: estimateBpm(frames, beats),
    brightnessMin: min,
    brightnessAvg: Math.round(sum / n),
    brightnessMax: max,
    flicker: Math.round((flickerSum / Math.max(1, n - 1)) * 10) / 10,
  };
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Klampar brightness/pct till 0–100 (BLE-skalan enginen använder). */
function clampPct(v: number): number {
  return v < 0 ? 0 : v > PCT_MAX ? PCT_MAX : Math.round(v);
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
          clampPct(a[1] + (b[1] - a[1]) * t),
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

/**
 * Asymmetrisk attack/release-utjämning: brightness följer snabbt uppåt (skarp
 * attack) men släpps mjukt nedåt (musikalisk release). Färg jämnas symmetriskt.
 * Skarpa transienter/beats nollställer filtret så slaget landar oförmjukat.
 */
function smooth(frames: Frame[], beatSet: Set<number>): Frame[] {
  const n = frames.length;
  if (n < 2) return frames;
  // Positiv flux + per-frame "calm": låg lokal flux → mjukare (vokal-vänligt).
  const flux = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const d = frames[i][1] - frames[i - 1][1];
    flux[i] = d > 0 ? d : 0;
  }
  const calm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - CALM_WINDOW), hi = Math.min(n - 1, i + CALM_WINDOW);
    let sum = 0, cnt = 0;
    for (let j = lo; j <= hi; j++) { sum += flux[j]; cnt++; }
    let c = 1 - (sum / cnt) / CALM_FLUX_REF;
    calm[i] = c < 0 ? 0 : c > 1 ? 1 : c;
  }
  const out: Frame[] = [frames[0].slice()];
  let pp = frames[0][1], pr = frames[0][2], pg = frames[0][3], pb = frames[0][4];
  for (let i = 1; i < n; i++) {
    const f = frames[i];
    const isBeat = beatSet.has(i);
    const transient = isBeat || Math.abs(f[1] - frames[i - 1][1]) >= TRANSIENT_DELTA;
    if (transient) {
      pp = f[1]; pr = f[2]; pg = f[3]; pb = f[4];
      out.push([f[0], f[1], f[2], f[3], f[4]]);
    } else {
      const c = calm[i];
      const aUp = ATTACK_ALPHA * (1 - c) + VOCAL_ALPHA * c;
      const aDn = RELEASE_ALPHA * (1 - c) + VOCAL_ALPHA * c;
      const a = f[1] > pp ? aUp : aDn;
      pp = pp + (f[1] - pp) * a;
      pr = pr + (f[2] - pr) * SMOOTH_ALPHA;
      pg = pg + (f[3] - pg) * SMOOTH_ALPHA;
      pb = pb + (f[4] - pb) * SMOOTH_ALPHA;
      out.push([f[0], clampPct(pp), clamp8(pr), clamp8(pg), clamp8(pb)]);
    }
  }
  return out;
}


// Kontraststräckning mot 0–100: mappar [svart-percentil, vit-percentil] till
// [0, WHITE_TARGET] med en lätt gamma så dynamiken utnyttjar hela pct-spannet.
const BLACK_PCTL = 0.10, WHITE_PCTL = 0.95, WHITE_TARGET = 92,
      STRETCH_GAMMA = 1.25, MIN_SPAN = 4;

function normalize(frames: Frame[]): Frame[] {
  const n = frames.length;
  if (n === 0) return frames;
  const sorted = frames.map((f) => f[1]).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(n * q)))];
  const black = at(BLACK_PCTL), white = at(WHITE_PCTL), span = white - black;
  if (span < MIN_SPAN) return frames;
  const invSpan = 1 / span;
  return frames.map((f) => {
    let t = (f[1] - black) * invSpan; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const shaped = FLOOR_PCT + (WHITE_TARGET - FLOOR_PCT) * Math.pow(t, STRETCH_GAMMA);
    return [f[0], clampPct(shaped), f[2], f[3], f[4]];
  });
}


/**
 * Dynamik-expansion: drar brightness bort från medelvärdet så dalar blir mörkare
 * och toppar ljusare — återger ljusshow-känslan som smoothing annars plattar ut.
 */
function expand(frames: Frame[]): Frame[] {
  const n = frames.length;
  if (n === 0) return frames;
  let sum = 0;
  for (const f of frames) sum += f[1];
  const avg = sum / n;
  return frames.map((f) => [f[0], clampPct(avg + (f[1] - avg) * CONTRAST), f[2], f[3], f[4]]);
}

/**
 * Lägger en skarp attack + exponentiell decay-svans på varje grid-slag — den
 * klassiska ljus-"bumpen". Boosten är additiv så övergångar mellan slag behålls.
 */
function applyBeatEnvelope(frames: Frame[], grid: number[]): Frame[] {
  if (grid.length === 0) return frames;
  const out = frames.map((f) => f.slice());
  const range = WHITE_TARGET - FLOOR_PCT;
  for (const b of grid) {
    const base = out[b][1];
    let strength = (base - FLOOR_PCT) / range;
    strength = strength < 0 ? 0 : strength > 1 ? 1 : strength;
    // Pre-dip: dra ned ljuset strax före slaget för extra punch.
    for (let k = 1; k <= PREDIP_FRAMES; k++) {
      const idx = b - k;
      if (idx < 0) continue;
      const w = (PREDIP_FRAMES - k + 1) / PREDIP_FRAMES;
      out[idx][1] = clampPct(out[idx][1] - out[idx][1] * PREDIP_DEPTH * w * strength);
    }
    const peakBoost = clampPct(base * BEAT_BOOST) - base;
    if (peakBoost <= 0) continue;
    for (let k = 0; k <= BEAT_TAIL; k++) {
      const idx = b + k;
      if (idx >= out.length) break;
      const extra = peakBoost * Math.pow(BEAT_DECAY, k);
      out[idx][1] = clampPct(out[idx][1] + extra);
    }
  }

  return out;
}

/**
 * Dämpar allt som ligger utanför beat-slagen mot golvet så takten dominerar.
 * Frames nära ett grid-slag (±NONBEAT_FALLOFF) lämnas orörda så attack + svans
 * behåller sin punch; resten dras mjukt ned mot FLOOR_PCT.
 */
function softenNonBeats(frames: Frame[], grid: number[]): Frame[] {
  if (grid.length === 0) return frames;
  const n = frames.length;
  // Avstånd (i frames) till närmaste beat → 0..1-vikt för beat-närhet.
  const near = new Float64Array(n);
  for (const b of grid) {
    for (let k = -NONBEAT_FALLOFF; k <= BEAT_TAIL; k++) {
      const idx = b + k;
      if (idx < 0 || idx >= n) continue;
      const span = k < 0 ? NONBEAT_FALLOFF : BEAT_TAIL;
      const w = 1 - Math.abs(k) / (span + 1);
      if (w > near[idx]) near[idx] = w;
    }
  }
  return frames.map((f, i) => {
    const keep = near[i];                       // 1 vid beat, 0 långt ifrån
    const damp = NONBEAT_DAMP + (1 - NONBEAT_DAMP) * keep;
    const v = FLOOR_PCT + (f[1] - FLOOR_PCT) * damp;
    return [f[0], clampPct(v), f[2], f[3], f[4]];
  });
}

/**
 * Decimerar en färdig-finslipad sekvens till ett fast ~BLE_FRAME_MS-raster med
 * box-medel (anti-alias). BLEDOM över BLE är sample-and-hold och hinner bara
 * ~20–40 uppdateringar/s, så 100 fps-features (1-frame-attack, white-punch)
 * flimrar in/ut fas-beroende. Returnerar oförändrat om redan på/under måltakten.
 */
function decimateToBle(frames: Frame[], intervalMs: number): Frame[] {
  const n = frames.length;
  if (n < 2 || intervalMs <= 0) return frames;
  if (medianFrameMs(frames) >= intervalMs * 0.9) return frames; // redan på/under måltakten
  const out: Frame[] = [];
  let i = 0;
  for (let binStart = frames[0][0]; i < n; binStart += intervalMs) {
    const binEnd = binStart + intervalMs;
    let st = 0, sp = 0, sr = 0, sg = 0, sb = 0, cnt = 0;
    while (i < n && frames[i][0] < binEnd) {
      const f = frames[i];
      st += f[0]; sp += f[1]; sr += f[2]; sg += f[3]; sb += f[4];
      cnt++; i++;
    }
    if (cnt > 0) out.push([Math.round(st / cnt), clampPct(sp / cnt), clamp8(sr / cnt), clamp8(sg / cnt), clamp8(sb / cnt)]);
  }
  return out;
}

export function polish(frames: Frame[]): Frame[] {
  if (frames.length < 2) return frames.map((f) => f.slice());
  configureFrameRate(frames);
  const filled = fillGaps(frames);
  const rawBeats = detectBeats(filled);
  const grid = buildBeatGrid(filled, rawBeats);
  const beats = grid.length ? grid : rawBeats;
  const shaped = normalize(expand(smooth(filled, new Set(beats))));
  const softened = softenNonBeats(shaped, beats);
  const enveloped = applyBeatEnvelope(softened, beats);
  return decimateToBle(enveloped, BLE_FRAME_MS);
}


