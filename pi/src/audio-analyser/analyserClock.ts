/** TAKTMATNINGEN (utbruten ur index.ts 2026-10-10, ordagrant): fasprediktionstilliten, den löpande takten (10-19, ersatte kick-PLL:en och fasfoljaren), taktfasen (ettan) och coasten som haller cfg.beat (ankare + bpm + konfi Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserClock.md */
import type { Frame } from "./analyser.js";   // ANALYSATORNS KLOCKA
export const MIN_BEAT_CONFIDENCE = 0.20;   // Klockans grind
export const SYNC_ERR_FRAC = 0.2, TRUST_TAU_MS = 81;   // TILLITEN TILL TAKTEN
export function trustStep(prev: number, conf: number, beatErr: number, dtMs: number): number {
  let raw = (conf - MIN_BEAT_CONFIDENCE) / 0.37; raw = raw > 0 ? (raw > 1 ? 1 : raw) : 0;
  const se = beatErr < 0 ? -beatErr : beatErr;
  if (se > SYNC_ERR_FRAC) { const m = 1 - (se - SYNC_ERR_FRAC) / SYNC_ERR_FRAC; raw *= m > 0 ? m : 0; }
  return dtMs > 0 ? prev + (raw - prev) * (1 - Math.exp(-dtMs / TRUST_TAU_MS)) : prev;
}
export const GRID_EARLY_MS = 20;   // Effektklockan ligger så många ms före vikningstoppen
let isLogOn: () => boolean = () => false;
/** Systemets loggbrytare. */
export function setClockLog(f: () => boolean): void { isLogOn = f; }
/** Klockans utfall. */
export interface ClockCfg { beat?: { anchorMs: number; bpm: number; confidence?: number } | null; beatErr?: number }
type EngineConfig = ClockCfg;

const GRID_ON_CONF = 0.35;   // COAST: konfidensen dippar i breakdowns/brus men TEMPOT är oftast fortfarande...
const GRID_COAST_MS = 4000;   // så länge håller vi gridet på svag konfidens

const TRUST_REPEAT_BEATS = 2, TRUST_REPEAT_TOL = 0.06;   // TILLITEN
const TRUST_UP = Number(process.env.DMX_TRUST_UP || '0.12'), TRUST_LEAK_MS = Number(process.env.DMX_TRUST_LEAK_MS || '4000');   // PROVRATTAR 2026-11-07
const ONSET_WIN_MS = 5000, ONSET_EVERY_MS = 250, ONSET_BINS = 48, ONSET_RING = 1024, ONSET_MIN_PEAK = 1.5;   // LÖPANDE TAKT
const FEED_RISE_HOPS = 6;   // BASENS STIGNING
const PH_B = 6, PH_W = 4, PH_LAG_A = 0.05, PH_LAG_MAX = 30;   // FASEN UR BANDEN (a6)
const BREAK_HOLD_MS = 20000;   // TVÅ RUTNÄT
const BREAK_RESTORE_MS = Number(process.env.DMX_BREAK_RESTORE_MS ?? String(BREAK_HOLD_MS));
const BAR_DECAY = 0.99, BAR_MIN = 16, BAR_MARGIN = 0.06, BAR_W_BASS = 0.5, BAR_WIN0 = -0.2, BAR_WIN1 = 0.3, BAR_RISE_HOPS = 6, BAR_R_MAX = 2, BAR_W_BEAT = 0.25, BAR_Q = 8, BAR_BEAT_Q = 2;   // ETTAN I EFFEKTKLOCKANS RUTNÄT
const TG_HOLD = 1.35;   // HELA TEMPOOMRÅDET
const TG_SIB = [Math.round(Math.log2(4 / 3) * 139), Math.round(Math.log2(3 / 2) * 139)];   // 4:3 och 3:2 i rutnätets steg
const TG_SNAP = 0.03, TG_EDGE = 1.03, TG_OCT_UP = 0.85, TG_OCT_DN = 0.4, TG_OCT_A = 0.1;
const KICK_PHASE_MS = 45;   // EN KÄLLA
const TG_GRID_EXTRA_MS = 5;   // a8r (ladan-provet 11-08, punkt 3)
const TG_WIN_MS = 5000, TG_FULL_N = 900, TG_FWIN_MS = 3500, TG_FFULL_N = 630, TG_FA = 0.4, TG_SW_STEPS = 6, TG_SW_N = 2;   // TEMPOGRAMMETS FÖNSTER OCH MINNE
const TG_NOISE = 0.6, TG_NB = 2, TG_SW_P = 1, TG_SW_G = 2, TG_HL_A = 0.5, TG_LOCK_N = 8, TG_LA = 0.04, TG_KNOWN = 0.5, SCAN_HOLD = 1.06;   // HÅLLEN TOLKNING EFTER SÄKER LÅSNING
const TG_SONG_A = 1 / 160;   // LÅTENS MINNE
const TG_BRK_DB = 24, TG_BRK_MAX_MS = 30000;   // BREAK OCH DROP ÄR SAMMA LÅT
const TG_Q_SIM = 0.5, TG_Q_LEAD = 1;   // BEVISETS KVALITET: utmanarens mönster finns (= PW_MIN), annars ska bevissumman leda med ett helt golv (= TG_SW_P)
const BND_QUIET_BEATS = 1;   // MINNET VID GRÄNSEN: så många slag tyst = låten tog slut
const HV_R = [4 / 3, 3 / 4, 3 / 2, 2 / 3, 5 / 4, 4 / 5], HV_K = 1.25, HV_N = 5, HV_AGE = 30, TG_OCT_LO = 79.6, TG_OCT_LO_N = 8;   // a3 TOPPRÖSTEN
const PW_RING = 4096, PW_WIN_MS = 10000, PW_MIN = 0.5, PW_Q = [4 / 3, 3 / 4, 3 / 2, 2 / 3];   // TAKTENS SJÄLVLIKHET
const TG_K = 139, TG_STEP = Math.pow(2, 1 / TG_K), TG_PER_HOP = 1, TG_A = 0.21, TG_MIN_N = 300, TG_FINE = 0.0025, TG_HALF = ONSET_BINS >> 1;
const TG_FINE_MAX = 0.0125;   // FINTEMPOTS BAND
const FRESH_MS = 8000, FRESH_TEMPO = 0.04, JUMP_FRAC = 0.12, LM_TAU_MS = 10000, LM_K = 1.2;   // DET TRÖTTA LÅSET (a5)
const PM_WIN_MS = 2000, PM_MIN = 0.55, PM_GAP = 0.2, PM_PRE = 0.7, PM_RAT = 0.75, PM_JUMP = 0.2, PM_PRE0 = 3500, PM_PRE1 = 1000, PM_HOLD_MS = ONSET_WIN_MS;   // SAMMA MÖNSTER, FLYTTAT (fas1 f4)

/** FAS-PREDIKTIONSTILLIT. */
export function publishPhase(f: { beatPhaseMs: number; beatPhaseConf: number; barShift: number }, b: ClockCfg["beat"], barKnown: boolean,
  ref: { anchorMs: number; bpm: number } | null | undefined, now: number, offsetMs: number): void {
  if (!b || !(b.bpm > 40)) { f.beatPhaseMs = 0; f.beatPhaseConf = 0; f.barShift = -1; return; }
  const per = 60000 / b.bpm, j = Math.floor((now - b.anchorMs) / per);
  f.beatPhaseMs = b.anchorMs - offsetMs; f.beatPhaseConf = 1 / Math.max(0.05, 1 - (b.confidence ?? 0));
  if (!barKnown) { f.barShift = -1; return; }
  const r = ref && ref.bpm > 40 && Math.abs(ref.bpm / b.bpm - 1) < 0.04 ? ref : b;
  const ir = Math.round((b.anchorMs + j * per - r.anchorMs) / (60000 / r.bpm));
  f.barShift = (((((j % 4) + 4) % 4) - ir) % 4 + 4) % 4;
}

export class BeatFeed {
  private trustSm = 0; private trustAt = 0;   // dirigenternas tillit
  onBeatRate = 0;   // andel kickar med |fasfel| < 0.25
  repeatRate = 0;   // TRUST_REPEAT
  pllKicks = 0;   // hur mycket bevis fasprediktionen faktiskt vilar pa
  private lastTrustLog = 0;
  private lastPllKickMs = 0;
  private readonly kickRing = new Float64Array(64); private kickRingPos = 0; private kickRingN = 0; private kickRingLast = 0;
  private gridWeakSince = 0;   // ms-tidpunkt då konfidensen föll under grinden
  private gridCoasting = false;
  private readonly onT = new Float64Array(ONSET_RING); private readonly onV = new Float32Array(ONSET_RING); private readonly hiV = new Float32Array(ONSET_RING); private hiPrev = 0; private onPos = 0; private onN = 0; private onHalf = false; private onPrev = 0;   // LÖPANDE TAKT
  private readonly foldS = new Float64Array(ONSET_BINS); private readonly foldN = new Float64Array(ONSET_BINS); private onNext = 0;
  onsetFixes = 0;
  private readonly phV = new Float32Array(ONSET_RING * PH_B); private readonly phA = new Float64Array(FEED_RISE_HOPS * PH_B); private readonly phP = new Float64Array(PH_B);   // FASEN UR BANDEN
  private readonly phF = new Float64Array(ONSET_BINS * PH_B); private readonly phC = new Float64Array(ONSET_BINS);
  private readonly phWt = new Float64Array(PH_B); private readonly phWb = new Float64Array(PH_B); private readonly phWc = new Float64Array(PH_B);
  private readonly riseDb = new Float64Array(FEED_RISE_HOPS); private risePos = 0;
  private readonly fullS = new Float64Array(ONSET_BINS); private readonly fullN = new Float64Array(ONSET_BINS);   // HELA TEMPOOMRÅDET
  private readonly tgAcc = new Float64Array(TG_K).fill(-1); private readonly tgH = new Float64Array(ONSET_BINS); private tgK = 0; private tgN = 0;
  private readonly tgAccF = new Float64Array(TG_K).fill(-1); private tgSw = 0; tgSwitches = 0;   // TVÅ MINNEN
  private readonly tgF = new Float64Array(TG_K); private readonly tgW = new Float64Array(TG_K); private readonly tgQ = new Float64Array(TG_K);   // HÅLLEN TOLKNING
  private brkAt = -1e12; private brkArm = false; private brkFrom = 0;   // BREAK-HÅLLET
  private sure = false; private first = true;   // LÅTENS MINNE
  private readonly tgD = new Float64Array(TG_K); private tgR = -1; private tgHl = 0; private tgLk = 0; private tgLkK = -1;
  private readonly tgAccL = new Float64Array(TG_K).fill(-1); private tgLN = 0;   // k4b (lånat av k2b)
  tempoBpm = 0;   // EN TEMPOSÖKNING
  tgClear = 1;   // TEMPOTS TYDLIGHET 0..1
  private hvRun = 0; hvSwitches = 0; private hvAge = 0; private hvVoted = false; private hvKeep = 0; private hvEver = false; private octLoN = 0; private hvT0 = 0; private hvBest = 0;   // a3 TOPPRÖSTEN
  private readonly pwE = new Float32Array(PW_RING); private readonly pwH = new Float32Array(PW_RING); private readonly pwT = new Float64Array(PW_RING); private pwPos = 0; private pwN = 0;   // TAKTENS SJÄLVLIKHET
  private pwWn = 0; private pwDt = 0; private pwCand = 0; private pwRun = 0; private pwQuietAt = 0; pwVetos = 0; pwFixes = 0;
  private tgHalfR = 0; octR = 0; private octN = 0; private octHi = false;   // OKTAVKANTEN
  private goodOn = 0; private goodRep = 0; private goodAt = 0;   // TAKTEN GENOM BREAKET
  private readonly barK = new Float64Array(4); private readonly barL = new Float64Array(4);   // ETTAN (a5)
  private barN = 0; private barIdx = NaN; private bK = 0; private bL = 0; private barOff = 0; barShifts = 0;
  private barM = 0; private barJ = 0; private barJr = 0; private barPT = 0; private barPI = NaN;   // ettan räknas i musikens slag (a1, per slag a6)
  private readonly barR = new Float64Array(4); private bE = 0; private bE1 = 0; private bE2 = 0; private bEm = 0;   // kickens återstart (a2)
  private readonly barX = new Float64Array(4); private readonly barV = new Float64Array(BAR_Q); private readonly barVc = new Float64Array(BAR_Q); private barTi = NaN; private barTe = 0;   // backbeaten (a8r)
  private readonly linK = new Float64Array(BAR_RISE_HOPS); private readonly linL = new Float64Array(BAR_RISE_HOPS); private linPos = 0;
  private innerAnchor = 0; private innerBpm = 0; private innerValid = false;
  private readonly anaGrid = { anchorMs: 0, bpm: 0, confidence: 0 };   // EN KÄLLA
  private boundSeen = 0;
  private quietAt = -1e12; private pend = false;   // MINNET VID GRÄNSEN
  /** Det cfg analysatorn ska byggas med. */
  barKnown(): boolean { return this.barN >= BAR_MIN; }
  static analyserCfg<T extends object>(cfg: T): T { return { ...cfg, beat: null }; }

  private foldMean(k: number): number { const q = (k + ONSET_BINS) % ONSET_BINS; return this.foldN[q] ? this.foldS[q] / this.foldN[q] : 0; }
  /** FASEN UR BANDEN. */
  private phFold(): number {
    const F = this.phF, N = this.foldN, C = this.phC; C.fill(0); this.phWt.fill(0); let any = false;
    for (let k = 0; k < PH_B; k++) {
      let mu = 0, mx = 0;
      for (let b = 0; b < ONSET_BINS; b++) { const v = N[b] ? F[b * PH_B + k] / N[b] : 0; mu += v; if (v > mx) mx = v; }
      mu /= ONSET_BINS; if (!(mu > 0)) continue;
      const w = (mx / mu - 1) / mu; any = true; this.phWt[k] = w;
      for (let b = 0; b < ONSET_BINS; b++) if (N[b]) C[b] += w * F[b * PH_B + k] / N[b];
    }
    if (!any) return 0;
    let m = 0; for (let b = 0; b < ONSET_BINS; b++) m += C[b];
    return m / ONSET_BINS;
  }

  private scanStep = 0.005; private scanC = 99; private scanEnd = 0; private scanRef = 0; private scanNow = 0; private scanC0 = 0;   // Sökningen sprids över hoppen
  private bestScore = 0; private bestBpm = 0; private bestPh = 0; private scanFar = 0; private bestLag = NaN; private phLag = 0;
  private freshTo = 0; jumpVetos = 0; private readonly lm = new Float64Array(ONSET_BINS); private readonly lmTmp = new Float64Array(ONSET_BINS); private lmT = 0; private lmS = 1;   // DET TRÖTTA LÅSET
  private readonly pmM = new Float64Array(ONSET_BINS * PH_B); private readonly pmS = new Float64Array(ONSET_BINS * PH_B); private readonly pmN = new Float64Array(ONSET_BINS); private readonly pmC = new Float64Array(ONSET_BINS); private pmTo = 0; private pmR = NaN; pmJumps = 0; private readonly pmHt = new Float64Array(16); private readonly pmHc = new Float64Array(16); private pmHp = 0;   // SAMMA MÖNSTER, FLYTTAT

  /** LÖPANDE TAKT. */
  private onsetStep(cfg: EngineConfig, now: number): void {
    const beat = cfg.beat; if (!beat || beat.bpm <= 0) { this.scanC = 99; return; }
    if (this.scanC > this.scanEnd) {
      if (now < this.onNext) return;
      this.onNext = now + ONSET_EVERY_MS;
      this.scanRef = beat.anchorMs; this.scanNow = now;
      const cb = this.scanFar > 0 ? this.scanFar : beat.bpm; this.scanFar = 0;
      if (this.tempoBpm > 0 && Math.abs(cb / this.tempoBpm - 1) > FRESH_TEMPO) this.freshTo = now + FRESH_MS;
      if (this.tempoBpm > 0 && Math.abs(cb / this.tempoBpm - 1) > TG_FINE_MAX) { this.scanC0 = this.tempoBpm; this.scanStep = TG_FINE; this.scanEnd = 5; }
      else if (this.tempoBpm > 0) { this.scanC0 = cb; this.scanStep = 0.005; this.scanEnd = 5; }
      else { this.scanC0 = beat.bpm; this.scanStep = 0.005; this.scanEnd = 5; }

      this.scanC = -5; this.bestScore = 0;
    }
    const c = this.scanC++, ref = this.scanRef;
    const bpm = this.scanC0 * (1 + c * this.scanStep), bm = 60000 / bpm;
    this.foldS.fill(0); this.foldN.fill(0); this.phF.fill(0);
    let tot = 0, n = 0; const PV = this.phV, PF = this.phF;
    for (let i = 0; i < this.onN; i++) {
      const j = (this.onPos - 1 - i + ONSET_RING) % ONSET_RING, t = this.onT[j];
      if (t > this.scanNow) continue;
      if (this.scanNow - t > ONSET_WIN_MS) break;
      const r = (t - ref) % bm, b = Math.floor(((r < 0 ? r + bm : r) / bm) * ONSET_BINS) % ONSET_BINS;
      this.foldS[b] += this.onV[j]; this.foldN[b]++; tot += this.onV[j]; n++;
      const o = b * PH_B, q = j * PH_B; for (let k = 0; k < PH_B; k++) PF[o + k] += PV[q + k];
    }
    if (n >= 100 && tot > 0) {
      const mean = this.phFold(), C = this.phC; let mx = 0, mb = 0;
      for (let b = 0; b < ONSET_BINS; b++) { const v = C[b]; if (v > mx) { mx = v; mb = b; } }
      const score = mean > 0 ? (mx / mean) * (c === 0 && this.scanStep === 0.005 ? SCAN_HOLD : 1) : 0;
      if (score > this.bestScore) {
        const a = C[(mb + ONSET_BINS - 1) % ONSET_BINS], cc = C[mb], d = C[(mb + 1) % ONSET_BINS], den = a - 2 * cc + d;
        const off = den < 0 ? 0.5 * (a - d) / den : 0;
        this.bestScore = score; this.bestBpm = bpm; this.bestPh = (mb + 0.5 + off) / ONSET_BINS; this.phWb.set(this.phWt);
        let sx = 0, sb = 0; for (let b = 0; b < ONSET_BINS; b++) { const v = this.foldMean(b); if (v > sx) { sx = v; sb = b; } }
        const dd = Math.abs(sb - mb), dk = dd < ONSET_BINS - dd ? dd : ONSET_BINS - dd;
        if (dk <= PH_W && sx > 0) { const a2 = this.foldMean(sb - 1), d2 = this.foldMean(sb + 1), de = a2 - 2 * sx + d2; let l = (sb + 0.5 + (de < 0 ? 0.5 * (a2 - d2) / de : 0)) / ONSET_BINS - this.bestPh; l -= Math.round(l); this.bestLag = l; }
        else this.bestLag = NaN;
      }
    }
    if (c < this.scanEnd || this.bestScore < ONSET_MIN_PEAK) return;
    if (this.tempoBpm > 0) this.bestBpm = Math.min(159.9, Math.max(80, this.bestBpm));
    if (this.tempoBpm > 0 && Math.abs(this.bestBpm / this.tempoBpm - 1) > TG_FINE_MAX) { this.scanFar = this.bestBpm; return; }
    const oldMs = 60000 / beat.bpm, idx = Math.floor((now - beat.anchorMs) / oldMs), fr = (now - beat.anchorMs) / oldMs - idx;
    const nb = 60000 / this.bestBpm;
    beat.bpm = this.bestBpm; beat.anchorMs = now - (idx + fr) * nb;
    const shift = ((((beat.anchorMs - ref) % nb) + nb) % nb) / nb;
    if (this.bestLag === this.bestLag && now >= this.pmTo) { const l = this.phLag + PH_LAG_A * (this.bestLag * nb - this.phLag); this.phLag = l > PH_LAG_MAX ? PH_LAG_MAX : l < -PH_LAG_MAX ? -PH_LAG_MAX : l; }
    const lag = this.phLag / nb; let err = this.bestPh + lag - shift; err -= Math.round(err);
    const big = err >= JUMP_FRAC || err <= -JUMP_FRAC; this.phWc.set(this.phWb);
    const pj = this.pmJump(now, beat.anchorMs, nb);
    if (pj !== 0) { beat.anchorMs += pj * nb; this.pmTo = now + PM_HOLD_MS; this.pmJumps++; }
    else if (!big || (now >= this.pmTo && (now < this.freshTo || this.lmAt(err - lag) * LM_K >= this.lmAt(-lag)))) { beat.anchorMs += err * nb; if (big) this.lmTurn(err); } else this.jumpVetos++;
    this.onsetFixes++;
  }

  /** SAMMA MÖNSTER, FLYTTAT: banden de senaste PM_WIN_MS mot bandminnet; hela mönstret flyttat = hoppet (bråkdel), annars 0. */
  private pmJump(now: number, anchor: number, bm: number): number {
    if (now < this.freshTo || now < this.pmTo) { this.pmR = NaN; return 0; }
    const S = this.pmS, N = this.pmN, M = this.pmM, PV = this.phV, C = this.pmC, B = ONSET_BINS; S.fill(0); N.fill(0); C.fill(0);
    for (let i = 0; i < this.onN; i++) {
      const j = (this.onPos - 1 - i + ONSET_RING) % ONSET_RING, t = this.onT[j];
      if (now - t > PM_WIN_MS) break;
      const r = (t - anchor) % bm, b = Math.floor(((r < 0 ? r + bm : r) / bm) * B) % B;
      N[b]++; const o = b * PH_B, q = j * PH_B; for (let k = 0; k < PH_B; k++) S[o + k] += PV[q + k];
    }
    for (let b = 0; b < B; b++) { if (!N[b]) { this.pmR = NaN; return 0; } for (let k = 0; k < PH_B; k++) S[b * PH_B + k] /= N[b]; }
    let wt = 0;
    for (let k = 0; k < PH_B; k++) {
      let mm = 0, sm = 0; for (let b = 0; b < B; b++) { mm += M[b * PH_B + k]; sm += S[b * PH_B + k]; } mm /= B; sm /= B;
      let mv = 0, sv = 0; for (let b = 0; b < B; b++) { const x = M[b * PH_B + k] - mm, y = S[b * PH_B + k] - sm; mv += x * x; sv += y * y; }
      if (!(mm > 0) || !(mv > 0)) continue;
      const w = Math.sqrt(mv / B) / mm; wt += w;   // bandets tydlighet i minnet
      if (!(sv > 0)) continue;
      const g = w / Math.sqrt(mv * sv);
      for (let r = 0; r < B; r++) { let a = 0; for (let b = 0; b < B; b++) a += (S[b * PH_B + k] - sm) * (M[((b - r + B) % B) * PH_B + k] - mm); C[r] += g * a; }
    }
    if (!(wt > 0)) { this.pmR = NaN; return 0; }
    let rb = 0, cb = -1e9; for (let r = 0; r < B; r++) if (C[r] > cb) { cb = C[r]; rb = r; }
    const rr = rb > B / 2 ? rb - B : rb; let pre = 0;
    for (let i = 0; i < 16; i++) { const dt = now - this.pmHt[i]; if (dt >= PM_PRE1 && dt <= PM_PRE0 && this.pmHc[i] > pre) pre = this.pmHc[i]; }
    this.pmHt[this.pmHp] = now; this.pmHc[this.pmHp] = C[0] / wt; this.pmHp = (this.pmHp + 1) & 15;   // före hoppet satt mönstret på klockan
    if (Math.abs(rr) / B < PM_JUMP || cb / wt < PM_MIN || (cb - C[0]) / wt < PM_GAP || pre < PM_PRE || cb / wt < PM_RAT * pre) { this.pmR = NaN; return 0; }
    const a = C[(rb + B - 1) % B], d = C[(rb + 1) % B], den = a - 2 * cb + d, e = (rr + (den < 0 ? 0.5 * (a - d) / den : 0)) / B;
    const p = this.pmR; this.pmR = e;
    if (!(p === p) || Math.abs(p - e) > 2 / B) return 0;
    this.pmR = NaN; return e;
  }
  private lmClear(): void { this.lm.fill(0); this.pmM.fill(0); }

  /** DET TRÖTTA LÅSET. */
  private lmAt(ph: number): number {
    const c = Math.round(ph * ONSET_BINS); let v = 0;
    for (let d = -2; d <= 2; d++) { const x = this.lm[(((c + d) % ONSET_BINS) + ONSET_BINS) % ONSET_BINS]; if (x > v) v = x; }
    return v;
  }
  private lmTurn(err: number): void {
    const r = Math.round(err * ONSET_BINS), L = this.lm, T = this.lmTmp; T.set(L);
    for (let b = 0; b < ONSET_BINS; b++) L[b] = T[(((b + r) % ONSET_BINS) + ONSET_BINS) % ONSET_BINS];
    const M = this.pmM, U = this.pmS; U.set(M);
    for (let b = 0; b < ONSET_BINS; b++) { const s = ((((b + r) % ONSET_BINS) + ONSET_BINS) % ONSET_BINS) * PH_B; for (let k = 0; k < PH_B; k++) M[b * PH_B + k] = U[s + k]; }
  }
  private lmAdd(now: number, b: { anchorMs: number; bpm: number }, v: number, q: number): void {
    const per = 60000 / b.bpm; let p = (now - b.anchorMs) / per; p -= Math.floor(p);
    const dec = this.lmT > 0 && now > this.lmT ? Math.exp(-(now - this.lmT) / LM_TAU_MS) : 1; this.lmT = now;
    const L = this.lm; this.lmS *= dec;   // lat dämpning: tabellen = L x lmS, jämförelserna (lmAt mot lmAt) tar ut skalan
    if (this.lmS < 1e-200) { for (let i = 0; i < ONSET_BINS; i++) L[i] *= this.lmS; for (let i = 0; i < ONSET_BINS * PH_B; i++) this.pmM[i] *= this.lmS; this.lmS = 1; }
    const bi = Math.floor(p * ONSET_BINS) % ONSET_BINS; L[bi] += v / this.lmS;
    for (let k = 0; k < PH_B; k++) this.pmM[bi * PH_B + k] += this.phV[q + k] / this.lmS;
  }

  /** EN TEMPOSÖKNING. */
  private tgScore(bpm: number, now: number, win = TG_WIN_MS): number {
    const S = this.fullS, N = this.fullN, Hs = this.tgH, oT = this.onT, oV = this.onV, oH = this.hiV; S.fill(0); N.fill(0); Hs.fill(0);
    let lo = 0, hi = this.onN;
    while (lo < hi) { const m = (lo + hi) >> 1; if (now - oT[(this.onPos - 1 - m + 2 * ONSET_RING) % ONSET_RING] > win) hi = m; else lo = m + 1; }
    const n = lo;
    if (n < TG_MIN_N) { this.tgN = n; return 0; }
    const jo = (this.onPos - n + 2 * ONSET_RING) % ONSET_RING; let j = jo;
    const dt = (oT[(this.onPos + ONSET_RING - 1) % ONSET_RING] - oT[jo]) / (n - 1), step = (dt * bpm / 60000) * ONSET_BINS;
    let tot = 0, totH = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const b = ph | 0, v = oV[j], h = oH[j];
      S[b] += v; Hs[b] += h; N[b]++; tot += v; totH += h;
      ph += step; if (ph >= ONSET_BINS) ph -= ONSET_BINS;
      j = j === ONSET_RING - 1 ? 0 : j + 1;
    }
    this.tgN = n;
    if (tot <= 0 || totH <= 0) return 0;
    let mx = 0, mb = 0, hx = 0, hb = 0;
    for (let b = 0; b < ONSET_BINS; b++) { if (!N[b]) continue; const v = S[b] / N[b], h = Hs[b] / N[b]; if (v > mx) { mx = v; mb = b; } if (h > hx) { hx = h; hb = b; } }
    const q = (mb + TG_HALF) % ONSET_BINS, qh = (hb + TG_HALF) % ONSET_BINS;
    this.tgHalfR = mx > 0 && N[q] ? S[q] / N[q] / mx : 0;
    const fb = (mx + (N[q] ? S[q] / N[q] : 0)) / 2 / (tot / n), fh = (hx + (N[qh] ? Hs[qh] / N[qh] : 0)) / 2 / (totH / n);
    return fb * fh;
  }

  /** EN TEMPOSÖKNING. */
  private tgStep(now: number): void {
    const acc = this.tgAcc;
    for (let r = 0; r < TG_PER_HOP; r++) {
      const k = this.tgK, bk0 = 80 * Math.pow(TG_STEP, k), accF = this.tgAccF;
      const sf = this.tgScore(bk0, now, TG_FWIN_MS);
      this.tgF[k] = sf;
      if (sf > 0) accF[k] = accF[k] < 0 || this.tgN < TG_FFULL_N ? sf : accF[k] + TG_FA * (sf - accF[k]);
      const s = this.tgScore(bk0, now);
      if (s > 0) acc[k] = acc[k] < 0 || this.tgN < TG_FULL_N ? s : acc[k] + TG_A * (s - acc[k]);
      if (s > 0) { const L = this.tgAccL; L[k] = L[k] < 0 ? s : L[k] + (this.tgLN * TG_LA < 1 ? 1 / (this.tgLN + 1) : this.sure ? Math.max(1 / (this.tgLN + 1), TG_SONG_A) : TG_LA) * (s - L[k]); if (k === TG_K - 1) this.tgLN++; }
      if (++this.tgK < TG_K) continue;
      this.tgK = 0;
      if (now - this.brkAt >= TG_WIN_MS) { this.brkArm = true; this.brkFrom = 0; }
      else if (this.brkArm && this.tempoBpm > 0) {
        if (this.brkFrom === 0) this.brkFrom = now;
        if (now - this.brkFrom < TG_BRK_MAX_MS) return;
        this.brkArm = false;
      }
      const F = this.tgF, W = this.tgW, Q = this.tgQ, D = this.tgD;
      let any = false, nc = 0;
      for (let i = 0; i < TG_K; i++) { Q[i] = F[i] > 0 ? Math.log(F[i]) : 0; if (F[i] > 0) any = true; }
      if (any) {
        for (let i = 0; i < TG_K; i++) { let v = Q[i]; for (let d = 1; d <= TG_NB; d++) { const a = Q[(i + d) % TG_K], b = Q[(i + TG_K - d) % TG_K]; if (a > v) v = a; if (b > v) v = b; } W[i] = v; }
        Q.sort(); nc = Q[TG_K >> 1] + TG_NOISE;
      }
      const song = this.sure && this.tgLN * TG_LA >= 1;
      if (song) { this.tgR = -1; this.tgLk = 0; this.tgLkK = -1; this.tgSw = 0; this.first = false; }
      if (this.tgR >= 0 && any) {
        const r0 = this.tgR, e = Math.max(0, W[r0] - nc); let nk = r0, mx = 0;
        this.tgHl += TG_HL_A * (e - this.tgHl); D[r0] += e; mx = D[r0];
        const fl = -(TG_SW_P + TG_SW_G * this.tgHl);
        for (let i = 0; i < TG_K; i++) { if (i === r0) continue; const d = Math.max(D[i], fl) + W[i] - nc; D[i] = d; if (d > mx) { mx = d; nk = i; } }
        for (let i = 0; i < TG_K; i++) D[i] -= mx;
        const d0 = Math.abs(nk - r0);
        if (Math.min(d0, TG_K - d0) > 2 && (-D[r0] >= TG_Q_LEAD || this.pwReal(nk, now))) {
          for (let i = 0; i < TG_K; i++) if (F[i] > 0) { acc[i] = F[i]; accF[i] = F[i]; }
          this.tgR = -1; this.tgLk = 0; this.tgLkK = -1; this.tgSw = 0; this.tgSwitches++;
        } else if (Math.min(d0, TG_K - d0) <= 2) this.tgR = nk;
      }
      if (this.tgR >= 0) {
        const r = this.tgR, L = this.tgAccL; let fk = -1, fv = 0; for (let i = 0; i < TG_K; i++) if (accF[i] > fv) { fv = accF[i]; fk = i; }
        const d0 = fk < 0 ? 0 : Math.abs(fk - r), dd = Math.min(d0, TG_K - d0);
        const fc = Math.max(accF[r], accF[(r + 1) % TG_K], accF[(r + TG_K - 1) % TG_K]);
        if (fk >= 0 && dd > TG_SW_STEPS && fv >= fc * TG_HOLD) {
          if (++this.tgSw >= TG_SW_N) {
            let lf = 0, lr = 0; for (let d = -2; d <= 2; d++) { const a = L[(fk + d + TG_K) % TG_K], b = L[(r + d + TG_K) % TG_K]; if (a > lf) lf = a; if (b > lr) lr = b; }
            if (lf < TG_KNOWN * lr && this.pwReal(fk, now)) { acc.set(accF); this.tgSwitches++; this.tgR = -1; this.tgLk = 0; this.tgLkK = -1; }
            this.tgSw = 0;
          }
        } else this.tgSw = 0;
      }
      const held = this.tgR >= 0, A = song ? this.tgAccL : acc;
      if (held || song) {  }
      else if (this.tgN < TG_FULL_N) acc.set(accF);
      else if (this.tempoBpm > 0) {
        let fk = -1, fv = 0; for (let i = 0; i < TG_K; i++) if (accF[i] > fv) { fv = accF[i]; fk = i; }
        const kc0 = ((Math.round(Math.log(this.tempoBpm / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K;
        const d0 = fk < 0 ? 0 : ((fk - kc0) % TG_K + TG_K) % TG_K, dd = Math.min(d0, TG_K - d0);
        const fc = Math.max(accF[kc0], accF[(kc0 + 1) % TG_K], accF[(kc0 + TG_K - 1) % TG_K]);
        if (fk >= 0 && dd > TG_SW_STEPS && fv >= fc * TG_HOLD) { if (++this.tgSw >= TG_SW_N) { acc.set(accF); this.tgSw = 0; this.tgSwitches++; } } else this.tgSw = 0;
      }
      let bk = -1, bv = 0;
      if (held) { bk = this.tgR; bv = acc[bk]; for (let d = -2, c0 = bk; d <= 2; d++) { const j = (c0 + d + TG_K) % TG_K; if (acc[j] > bv) { bv = acc[j]; bk = j; } } if (!(bv > 0)) bk = -1; }
      else for (let i = 0; i < TG_K; i++) if (A[i] > bv) { bv = A[i]; bk = i; }
      if (bk < 0) { this.tempoBpm = 0; return; }
      { let sv = 0;
        for (let i = 0; i < TG_K; i++) { const v = A[i], dd = Math.abs(i - bk), d = dd < TG_K - dd ? dd : TG_K - dd;
          if (d > 2 && v > sv && v >= A[(i + 1) % TG_K] && v >= A[(i + TG_K - 1) % TG_K]) sv = v; }
        this.tgClear = Math.max(0, Math.min(1, 3 * (1 - sv / bv))); }
      if (!held && !song && this.tempoBpm > 0) {
        const kc = ((Math.round(Math.log(this.tempoBpm / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K, cv = Math.max(acc[kc], acc[(kc + 1) % TG_K], acc[(kc + TG_K - 1) % TG_K]);
        const d = ((bk - kc) % TG_K + TG_K) % TG_K, sib = TG_SIB.some((q) => Math.abs(d - q) <= 2 || Math.abs(d - (TG_K - q)) <= 2);
        if (sib && cv > 0 && bv < cv * TG_HOLD) { this.tgLk = 0; this.tempoBpm = this.pwJudge(this.tempoBpm, now); return; }
      }
      if (!held && !song) {
        const dl = Math.abs(bk - this.tgLkK), same = this.tgLkK >= 0 && Math.min(dl, TG_K - dl) <= 2;
        const e = any ? W[bk] - nc : 0;
        this.tgLk = same && e > 0 && this.tgN >= TG_FULL_N ? this.tgLk + 1 : 0; this.tgLkK = bk;
        if (this.tgLk >= TG_LOCK_N) { this.tgR = bk; this.tgLk = 0; D.fill(0); this.tgHl = e; this.first = false; }
      }
      const a = A[(bk + TG_K - 1) % TG_K], c = A[(bk + 1) % TG_K], den = a - 2 * bv + c;
      const off = a >= 0 && c >= 0 && den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      let t = 80 * Math.pow(TG_STEP, bk + off);
      if (!(t < 80 * TG_EDGE || t > 160 / TG_EDGE)) this.octLoN = 0;
      if (t < 80 * TG_EDGE || t > 160 / TG_EDGE) { const lo = t < 120 ? t : t / 2; this.tgScore(lo, now);
        this.octLoN = lo < TG_OCT_LO ? this.octLoN + 1 : 0;
        this.octR = this.octN++ === 0 ? this.tgHalfR : this.octR + TG_OCT_A * (this.tgHalfR - this.octR);
        if (this.octN === 1) this.octHi = this.octR >= TG_OCT_UP; else if (this.octHi ? this.octR < TG_OCT_DN : this.octR >= TG_OCT_UP) this.octHi = !this.octHi;
        t = this.octHi || this.octLoN >= TG_OCT_LO_N ? 2 * lo : lo; }
      { const r0 = this.tempoBpm, pc = Math.min(159.9, Math.max(80, this.peakVote(t, now))), pj = this.pwJudge(pc, now); this.tempoBpm = pj;
        if (pj !== pc && this.first) this.tgLk = 0;
        if (pj !== pc && pj !== r0 && this.tgR >= 0) { this.tgR = ((Math.round(Math.log(pj / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K; this.tgD.fill(0); } }
      return;
    }
  }
  /** a3 TOPPRÖSTEN. */
  private peakVote(t0: number, now: number): number {
    const open = this.hvAge++ < HV_AGE;
    if (!open) {
      if (this.hvAge === HV_AGE + 1) this.hvKeep = this.hvEver ? this.tempoBpm : 0;
      const k = this.hvKeep;
      if (k > 0 && Math.abs(t0 / k - 1) >= 0.02) {
        let sib = false; for (let i = 0; i < HV_R.length; i++) { let c = t0 * HV_R[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2; if (Math.abs(c / k - 1) < 0.02) sib = true; }
        if (sib && this.peakScore(k, now) * HV_K >= this.peakScore(t0, now)) return k;
        this.hvKeep = 0;
      }
      if (!this.hvVoted) return t0;
    }
    const p0 = this.peakScore(t0, now); if (!(p0 > 0)) { this.hvRun = 0; this.hvVoted = false; return t0; }
    const cur = this.tempoBpm; let best = t0, bs = p0 * HV_K;
    for (let i = 0; i < HV_R.length; i++) {
      let c = t0 * HV_R[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2;
      const v = this.peakScore(c, now) * (this.hvEver && cur > 0 && Math.abs(c / cur - 1) < 0.02 ? HV_K : 1);
      if (v > bs) { bs = v; best = c; }
    }
    if (best === t0) { this.hvRun = 0; this.hvVoted = false; return t0; }
    if (this.hvEver && cur > 0 && Math.abs(best / cur - 1) < 0.02) { this.hvRun = 0; return best; }
    if (this.hvRun > 0 && (Math.abs(t0 / this.hvT0 - 1) >= 0.02 || Math.abs(best / this.hvBest - 1) >= 0.02)) this.hvRun = 0;
    this.hvT0 = t0; this.hvBest = best;
    if (open && ++this.hvRun >= HV_N) { this.hvRun = 0; this.hvSwitches++; this.hvVoted = true; this.hvEver = true; return best; }
    if (!open) this.hvVoted = false;
    return t0;
  }
  /** Topp-poängen på bpm. */
  private peakScore(bpm: number, now: number): number {
    const S = this.fullS, N = this.fullN, Hs = this.tgH, oT = this.onT, oV = this.onV, oH = this.hiV; S.fill(0); N.fill(0); Hs.fill(0);
    let lo = 0, hi = this.onN;
    while (lo < hi) { const m = (lo + hi) >> 1; if (now - oT[(this.onPos - 1 - m + 2 * ONSET_RING) % ONSET_RING] > TG_WIN_MS) hi = m; else lo = m + 1; }
    const n = lo; if (n < TG_MIN_N) return 0;
    const jo = (this.onPos - n + 2 * ONSET_RING) % ONSET_RING;
    const dt = (oT[(this.onPos + ONSET_RING - 1) % ONSET_RING] - oT[jo]) / (n - 1), step = (dt * bpm / 60000) * ONSET_BINS;
    let j = jo, ph = 0, tot = 0, totH = 0;
    for (let i = 0; i < n; i++) { const b = ph | 0, v = oV[j], h = oH[j]; S[b] += v; Hs[b] += h; N[b]++; tot += v; totH += h; ph += step; if (ph >= ONSET_BINS) ph -= ONSET_BINS; j = j === ONSET_RING - 1 ? 0 : j + 1; }
    if (tot <= 0 || totH <= 0) return 0;
    let mx = 0, hx = 0;
    for (let b = 0; b < ONSET_BINS; b++) { if (!N[b]) continue; const v = S[b] / N[b], h = Hs[b] / N[b]; if (v > mx) mx = v; if (h > hx) hx = h; }
    return (mx / (tot / n)) * (hx / (totH / n));
  }
  /** Är a ett syskon till b. */
  private pwSib(a: number, b: number): boolean {
    for (let i = 0; i < PW_Q.length; i++) { let c = b * PW_Q[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2; if (Math.abs(a / c - 1) <= TG_SNAP) return true; }
    return false;
  }
  /** Seriens likhet med sig själv `lag` värden bort, över fönstret pwWn. */
  private pwCorr(x: Float32Array, lag: number): number {
    const n = this.pwWn, m = n - lag; if (m < 200) return 0;
    const M = PW_RING - 1, j0 = this.pwPos - n + 2 * PW_RING; let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < m; i++) { const a = x[(j0 + i) & M], b = x[(j0 + i + lag) & M]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
    const va = saa - sa * sa / m, vb = sbb - sb * sb / m;
    return va > 0 && vb > 0 ? (sab - sa * sb / m) / Math.sqrt(va * vb) : 0;
  }
  /** Långsamma minnets poäng kring bpm. */
  private pwAt(bpm: number): number { const acc = this.tgAcc, k = ((Math.round(Math.log(bpm / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K; let v = 0; for (let i = -2; i <= 2; i++) { const x = acc[(k + i + TG_K) % TG_K]; if (x > v) v = x; } return v; }
  /** Mönstrets självlikhet 2 och 4 slag bort på tempot bpm, bas + diskant. */
  private pwSim(bpm: number): number {
    const l2 = Math.round(120000 / bpm / this.pwDt), l4 = Math.round(240000 / bpm / this.pwDt);
    return this.pwCorr(this.pwE, l2) + this.pwCorr(this.pwE, l4) + this.pwCorr(this.pwH, l2) + this.pwCorr(this.pwH, l4);
  }
  /** TAKTENS SJÄLVLIKHET. */
  private pwJudge(cand: number, now: number): number {
    const reg = this.tempoBpm, fc = this.first;
    if (!(reg > 0)) { this.pwQuietAt = now + PW_WIN_MS; this.pwRun = 0; if (!fc) return cand; }
    const moved = reg > 0 && Math.abs(cand / reg - 1) > TG_SNAP, sib = moved && this.pwSib(cand, reg);
    if (moved && !sib) { this.pwQuietAt = now + PW_WIN_MS; this.pwRun = 0; if (!fc) return cand; }
    if (!fc && now < this.pwQuietAt) return cand;
    const M = PW_RING - 1; let lo = 0, hi = this.pwN;
    while (lo < hi) { const m = (lo + hi) >> 1; if (now - this.pwT[(this.pwPos - 1 - m + 2 * PW_RING) & M] > PW_WIN_MS) hi = m; else lo = m + 1; }
    if (lo < 1000) return cand;
    this.pwWn = lo; this.pwDt = (this.pwT[(this.pwPos - 1 + PW_RING) & M] - this.pwT[(this.pwPos - lo + 2 * PW_RING) & M]) / (lo - 1); if (!(this.pwDt > 0)) return cand;
    if (fc) {
      const sC = this.pwSim(cand); let bs = 0, bb = 0;
      for (let i = 0; i < PW_Q.length; i++) { let c = cand * PW_Q[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2; const v = this.pwSim(c); if (v > bs) { bs = v; bb = c; } }
      if (!(bs >= PW_MIN && bs > (sC > 0 ? sC * TG_HOLD : 0))) return cand;
      this.pwWn = lo >> 1; return this.pwSim(bb) >= PW_MIN ? bb : cand;
    }
    const sR = this.pwSim(reg);
    if (sib) {
      const sC = this.pwSim(cand);
      if (sR >= PW_MIN && sR > (sC > 0 ? sC * TG_HOLD : 0)) {
        this.pwWn = lo >> 1; const sN = this.pwSim(reg);
        if (sN >= PW_MIN) { this.pwVetos++; this.pwRun = 0; return reg; }
      }
      this.pwRun = 0; return cand;
    }
    let bs = 0, bb = 0;
    for (let i = 0; i < PW_Q.length; i++) { let c = cand * PW_Q[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2; const v = this.pwSim(c); if (v > bs) { bs = v; bb = c; } }
    if (bs >= PW_MIN && bs > (sR > 0 ? sR * TG_HOLD : 0) && this.pwAt(bb) * TG_HOLD >= this.pwAt(cand)) {
      if (this.pwRun > 0 && Math.abs(bb / this.pwCand - 1) <= TG_SNAP) this.pwRun++; else { this.pwCand = bb; this.pwRun = 1; }
      if (this.pwRun >= HV_N) { this.pwRun = 0; this.pwFixes++; return bb; }
    } else this.pwRun = 0;
    return cand;
  }
  /** BEVISETS KVALITET: upprepar sig mönstret på hypotesen k i vittnets senare halva? */
  private pwReal(k: number, now: number): boolean {
    const M = PW_RING - 1; let lo = 0, hi = this.pwN;
    while (lo < hi) { const m = (lo + hi) >> 1; if (now - this.pwT[(this.pwPos - 1 - m + 2 * PW_RING) & M] > PW_WIN_MS) hi = m; else lo = m + 1; }
    if (lo < 1000) return true;
    this.pwDt = (this.pwT[(this.pwPos - 1 + PW_RING) & M] - this.pwT[(this.pwPos - lo + 2 * PW_RING) & M]) / (lo - 1); if (!(this.pwDt > 0)) return true;
    this.pwWn = lo >> 1; return this.pwSim(80 * Math.pow(TG_STEP, k)) >= TG_Q_SIM;
  }
  private tgReset(soft = false): void { if (!soft) { this.pwN = 0; this.tgAcc.fill(-1); this.tgAccF.fill(-1); } this.pwRun = 0; this.tgSw = 0; this.tgR = -1; this.brkArm = false; this.brkFrom = 0; this.tgLk = 0; this.tgLkK = -1; this.tgHl = 0; this.tgAccL.fill(-1); this.tgLN = 0; this.tgK = 0; this.tempoBpm = 0; this.octN = 0; this.hvRun = 0; this.hvAge = 0; this.hvVoted = false; this.hvKeep = 0; this.hvEver = false; this.first = true; }

  /** Kom en tidigare kick. */
  private kickRepeats(t: number, lag: number, tol: number): boolean {
    const want = t - lag;
    for (let i = 0; i < this.kickRingN; i++) {
      const k = this.kickRing[(this.kickRingPos - 1 - i + 64) & 63];
      if (k < want - tol) return false;
      if (Math.abs(k - want) < tol) return true;
    }
    return false;
  }

  private barReset(): void { this.barK.fill(0); this.barL.fill(0); this.barR.fill(0); this.barX.fill(0); this.barTi = NaN; this.bE1 = 0; this.bE2 = 0; this.bEm = 0; this.barN = 0; this.barIdx = NaN; this.barM = this.barOff & 3; this.barJ = 0; this.barJr = 0; this.barPI = NaN; }

  /** ETTAN (se BAR_DECAY). */
  private barStep(frame: Frame, beat: NonNullable<EngineConfig["beat"]>, now: number): void {
    const sa = frame.specAbs, p = this.linPos, k = (sa?.sub ?? 0) + (sa?.kick ?? 0), l = sa?.bass ?? 0;
    const rk = k - this.linK[p], rl = l - this.linL[p]; this.linK[p] = k; this.linL[p] = l; this.linPos = (p + 1) % BAR_RISE_HOPS;
    if (!(beat.bpm > 40)) return;
    const per = 60000 / beat.bpm, pos = (now - beat.anchorMs) / per, idx = Math.floor(pos - BAR_WIN0);
    if (idx !== this.barIdx) {
      if (idx === this.barIdx + 1) this.barCommit(beat.anchorMs + this.barIdx * per, per);
      this.barIdx = idx; this.bK = 0; this.bL = 0; this.bE = 0;
    }
    if (pos - idx <= BAR_WIN1) {
      if (rk > this.bK) this.bK = rk;
      if (k > this.bE) this.bE = k;
      if (rl > this.bL) this.bL = rl;
    }
    { const ti = Math.floor(pos);
      if (ti !== this.barTi) { if (ti === this.barTi + 1) this.barBack(); this.barTi = ti; this.barV.fill(0); this.barVc.fill(0); }
      const q = Math.min(BAR_Q - 1, Math.floor((pos - ti) * BAR_Q)); this.barV[q] += sa?.treble ?? 0; this.barVc[q]++; }
    { const d = ((((this.barM + this.barJr - this.barOff) % 4) + 4) % 4); if (d) this.barOff += d; }
  }

  /** Backbeaten: diskantens anslag i slagets första fjärdedel mot resten av slaget, bokfört på slagets plats (virvel/clap på 2 och 4). */
  private barBack(): void {
    const V = this.barV, C = this.barVc, e = this.barTe; let m = 0, a = 0, b = 0;
    for (let q = 0; q < BAR_Q; q++) { if (!(C[q] > 0)) return; m += V[q] / C[q]; }
    m /= BAR_Q;
    if (e > 0) {
      for (let q = 0; q < BAR_Q; q++) { const v = V[q] / C[q], z = Math.log((v > 0.3 * e ? v : 0.3 * e) / e); if (q < BAR_BEAT_Q) a += z; else b += z; }
      this.barX[(((this.barTi - this.barJr) % 4) + 4) % 4] += a / BAR_BEAT_Q - b / (BAR_Q - BAR_BEAT_Q);
    }
    this.barTe = e > 0 ? e + 0.05 * (m - e) : m;
  }

  /** Slaget barIdx är färdigmätt. */
  private barCommit(tb: number, per: number): void {
    if (this.barPI === this.barPI) { const j = this.barJ + (this.barIdx - this.barPI) - (tb - this.barPT) / per; this.barJ = j - 4 * Math.floor(j / 4); }
    this.barPT = tb; this.barPI = this.barIdx; const jr = this.barJr = Math.floor(this.barJ + 0.5);
    const K = this.barK, L = this.barL, R = this.barR, slot = (((this.barIdx - jr) % 4) + 4) % 4;
    for (let i = 0; i < 4; i++) { K[i] *= BAR_DECAY; L[i] *= BAR_DECAY; R[i] *= BAR_DECAY; this.barX[i] *= BAR_DECAY; }
    K[slot] += this.bK; L[slot] += this.bL;
    { const e = this.bE, pm = this.bE1 > this.bE2 ? this.bE1 : this.bE2;
      if (this.bEm > 0 && e > pm) R[slot] += Math.min(BAR_R_MAX, (e - pm) / this.bEm);
      this.bE2 = this.bE1; this.bE1 = e; this.bEm += (e - this.bEm) / 16; }
    if (this.barN < 1000) this.barN++;
    if (this.barN < BAR_MIN) return;
    const sK = K[0] + K[1] + K[2] + K[3], sL = L[0] + L[1] + L[2] + L[3], sR = R[0] + R[1] + R[2] + R[3], X = this.barX;
    const sX = Math.abs(X[0]) + Math.abs(X[1]) + Math.abs(X[2]) + Math.abs(X[3]);
    if (!(sK > 0)) return;
    let bi = 0, best = -1e9, second = -1e9;
    for (let i = 0; i < 4; i++) {
      const v = K[i] / sK + (sR > 0 ? R[i] / sR : 0) + (sL > 0 ? BAR_W_BASS * L[i] / sL : 0)
        + (sX > 0 ? BAR_W_BEAT * (X[(i + 1) & 3] + X[(i + 3) & 3] - X[i] - X[(i + 2) & 3]) / sX : 0);
      if (v > best) { second = best; best = v; bi = i; } else if (v > second) second = v;
    }
    if (bi !== this.barM && best - second >= BAR_MARGIN) { this.barM = bi; this.barShifts++; }
  }

  /** LÅTGRÄNSEN. */
  private relock(soft: boolean, now: number): void {
    this.freshTo = now + FRESH_MS; this.lmClear(); this.tgReset(soft); this.barReset(); this.goodRep = 0; this.goodOn = 0; this.onNext = 0;
  }

  /** MINNET VID GRÄNSEN. */
  private sameSong(now: number): boolean {
    if (this.sure || this.brkAt !== now || !this.brkArm || !(this.tempoBpm > 0) || this.quietAt >= (this.brkFrom || now)) return false;   // inte i ett hållet break, eller låten tystnade
    const F = this.tgAccF, kc = ((Math.round(Math.log(this.tempoBpm / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K; let fk = kc, fv = 0;
    for (let i = 0; i < TG_K; i++) if (F[i] > fv) { fv = F[i]; fk = i; }
    const d0 = Math.abs(fk - kc);
    return Math.min(d0, TG_K - d0) <= TG_SW_STEPS || fv < Math.max(F[kc], F[(kc + 1) % TG_K], F[(kc + TG_K - 1) % TG_K]) * TG_HOLD;   // breakets rytm säger inte emot det hållna tempot
  }

  /** EN KÄLLA. */
  update(frame: Frame, cfg: EngineConfig, an: { resetTempo(): void; resetBar(): void; setClockGrid?(g: EngineConfig["beat"]): void; trackBoundaries?: number; quietMs?: number; boundSure?: boolean; bodyUnderDb?: number; setClock?(bpm: number, conf: number): void }, now = Date.now()): void {
    this.sure = !!an.boundSure; if ((an.bodyUnderDb ?? 0) >= TG_BRK_DB) this.brkAt = now;
    const nb = an.trackBoundaries ?? 0;
    const q = (an.quietMs ?? 0) >= BND_QUIET_BEATS * 60000 / (this.innerBpm > 80 ? this.innerBpm : 80); if (q) this.quietAt = now;
    if (nb !== this.boundSeen) { this.boundSeen = nb; this.pend = this.sameSong(now); if (!this.pend) this.relock(!this.sure && !((an.quietMs ?? 0) > 0), now); }
    else if (this.pend && (q || now - this.brkAt >= TG_WIN_MS)) { this.pend = false; if (q) this.relock(false, now); }   // tystnar låten i breaket var gränsen sann
    if (cfg.beat && this.innerValid) { cfg.beat.anchorMs = this.innerAnchor; cfg.beat.bpm = this.innerBpm; }
    this.updateInner(frame, cfg, now, an.quietMs ?? 0);
    const b = cfg.beat;
    if (b) {
      this.innerAnchor = b.anchorMs; this.innerBpm = b.bpm; this.innerValid = true;
      const g = this.anaGrid; g.anchorMs = b.anchorMs + KICK_PHASE_MS; g.bpm = b.bpm; g.confidence = b.confidence ?? 0;
      an.setClockGrid?.(this.gridWeakSince === 0 ? g as EngineConfig["beat"] : null);
      b.anchorMs += this.barOff * (60000 / b.bpm) - GRID_EARLY_MS - TG_GRID_EXTRA_MS;
    } else { this.innerValid = false; an.setClockGrid?.(null); }
    frame.bpm = b ? b.bpm : 0; frame.bpmConfidence = b ? (b.confidence ?? 0) : 0;
    an.setClock?.(frame.bpm, frame.bpmConfidence);
    { const dt = this.trustAt > 0 ? now - this.trustAt : 0; this.trustAt = now; frame.beatTrust = this.trustSm = trustStep(this.trustSm, frame.bpmConfidence, cfg.beatErr ?? 0, dt > 250 ? 250 : dt); }
  }

  private updateInner(frame: Frame, cfg: EngineConfig, now: number, quietMs: number): void {
    if (cfg.beat && this.lastPllKickMs) {
      const quiet = now - this.lastPllKickMs;
      if (quiet > 1500) {
        this.onBeatRate *= Math.max(0, 1 - (quiet - 1500) / TRUST_LEAK_MS);
        this.repeatRate *= Math.max(0, 1 - (quiet - 1500) / TRUST_LEAK_MS);
        if (quiet > 8000) this.pllKicks = 0;
      }
    }
    if (now - this.lastTrustLog > 4000) { this.lastTrustLog = now; if (isLogOn()) console.log(`[tillit] mönster ${this.repeatRate.toFixed(2)} · fasträff ${this.onBeatRate.toFixed(2)} · bpm ${cfg.beat ? cfg.beat.bpm.toFixed(1) : 0}`); }
    const pllConf = this.pllKicks >= 12 ? this.onBeatRate : 0;
    if (quietMs > 10000) {
      if (cfg.beat || this.onN > 0) { this.barReset(); cfg.beat = null; cfg.beatErr = 0; this.onN = 0; this.scanC = 99; this.tgReset(); }
      return;
    }
    const beat0 = cfg.beat;
    if (frame.kickAtMs > 0 && beat0) {
      const beatMs = 60000 / beat0.bpm;
      const ph = ((((frame.kickAtMs - beat0.anchorMs) % beatMs) + beatMs) % beatMs) / beatMs;
      const err = ph < 0.5 ? ph : ph - 1;
      const onBeat = Math.abs(err) < 0.25;
      if (BREAK_RESTORE_MS > 0) {
        const quiet = this.lastPllKickMs ? now - this.lastPllKickMs : 0;
        if (quiet > 1500 && onBeat && this.goodRep > 0 && now - this.goodAt < BREAK_RESTORE_MS + 1500) {
          beat0.anchorMs += err * beatMs;
          this.onBeatRate = Math.max(this.onBeatRate, this.goodOn); this.repeatRate = Math.max(this.repeatRate, this.goodRep);
          if (this.pllKicks < 12) this.pllKicks = 12;
        }
      }
      if (onBeat) cfg.beatErr = (cfg.beatErr ?? 0) * 0.85 + err * 0.15;
      { const x = onBeat ? 1 : 0; this.onBeatRate += (x - this.onBeatRate) * (x > this.onBeatRate ? TRUST_UP : 0.12); }
      { const x = onBeat || this.kickRepeats(frame.kickAtMs, TRUST_REPEAT_BEATS * beatMs, TRUST_REPEAT_TOL * beatMs) ? 1 : 0; this.repeatRate += (x - this.repeatRate) * (x > this.repeatRate ? TRUST_UP : 0.12); }
      this.lastPllKickMs = now;
      if (this.pllKicks < 40) this.pllKicks++;
      if (BREAK_RESTORE_MS > 0 && this.pllKicks >= 12) { this.goodOn = this.onBeatRate; this.goodRep = this.repeatRate; this.goodAt = this.lastPllKickMs; }
    }
    if (frame.kickAtMs > 0 && frame.kickAtMs !== this.kickRingLast) { this.kickRingLast = frame.kickAtMs; this.kickRing[this.kickRingPos] = frame.kickAtMs; this.kickRingPos = (this.kickRingPos + 1) & 63; if (this.kickRingN < 64) this.kickRingN++; }
    {
      const sa = frame.specAbs, db = 20 * Math.log10((sa?.sub ?? 0) + (sa?.kick ?? 0) + 1e-7);
      { const H = this.phA, P = this.phP, o = this.risePos * PH_B, w = this.onPos * PH_B, V = this.phV;
        for (let k = 0; k < PH_B; k++) {
          const x = k === 0 ? sa?.sub ?? 0 : k === 1 ? sa?.kick ?? 0 : k === 2 ? sa?.bass ?? 0 : k === 3 ? sa?.lowMid ?? 0 : k === 4 ? sa?.mid ?? 0 : (sa?.highMid ?? 0) + (sa?.treble ?? 0);
          const r = x - H[o + k], u = r > 0 ? r : 0; H[o + k] = x;
          if (this.onHalf) V[w + k] = u > P[k] ? u : P[k];
          P[k] = u;
        } }
      const old = this.riseDb[this.risePos]; this.riseDb[this.risePos] = db; this.risePos = (this.risePos + 1) % FEED_RISE_HOPS;
      const ok = old !== 0 && db > old ? db - old : 0;
      const hi = (frame.onset?.highMid ?? 0) + (frame.onset?.treble ?? 0);
      if (this.onHalf) { this.onT[this.onPos] = now; this.onV[this.onPos] = ok > this.onPrev ? ok : this.onPrev; this.hiV[this.onPos] = hi > this.hiPrev ? hi : this.hiPrev; this.pwT[this.pwPos] = now; this.pwE[this.pwPos] = this.onV[this.onPos]; this.pwH[this.pwPos] = this.hiV[this.onPos]; if (cfg.beat && cfg.beat.bpm > 0) { let v = 0; for (let k = 0; k < PH_B; k++) v += this.phWc[k] * this.phV[this.onPos * PH_B + k]; this.lmAdd(now, cfg.beat, v, this.onPos * PH_B); } this.pwPos = (this.pwPos + 1) & (PW_RING - 1); if (this.pwN < PW_RING) this.pwN++;
        this.onPos = (this.onPos + 1) % ONSET_RING; if (this.onN < ONSET_RING) this.onN++; }
      this.onPrev = ok; this.hiPrev = hi; this.onHalf = !this.onHalf;
      this.tgStep(now);
      if (!cfg.beat && this.tempoBpm > 0) { cfg.beat = { anchorMs: frame.kickAnchorMs || now, bpm: this.tempoBpm, confidence: 0 }; this.freshTo = now + FRESH_MS; this.lmClear(); }
      this.onsetStep(cfg, now);
    }
    if (cfg.beat) this.barStep(frame, cfg.beat, now);
    if (cfg.beat) {
      if (pllConf >= GRID_ON_CONF) { this.gridWeakSince = 0; this.gridCoasting = false; }
      else if (pllConf < MIN_BEAT_CONFIDENCE) {
        if (this.gridWeakSince === 0) { this.gridWeakSince = now; this.gridCoasting = true; }
        else if (now - this.gridWeakSince >= GRID_COAST_MS) { this.gridCoasting = false; this.gridWeakSince = now; }
      }
      const live = this.repeatRate * this.tgClear;
      cfg.beat.confidence = this.gridCoasting ? Math.max(live, MIN_BEAT_CONFIDENCE) : live;
    }
  }
}


