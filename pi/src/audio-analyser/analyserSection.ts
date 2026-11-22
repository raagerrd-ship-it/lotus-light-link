/**  SEKTIONSFÖLJAREN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserSection.md */
import { sysEnv, numEnv, stabilise, BE_FALLBACK_MS, BE_MEM_BEATS, BODY_HIGH_MS,
  type Ser, type SectionOut } from "./analyserFack.js";
import { S, BS, SECTIONS, sectionCode } from "./split.js";
const P = S.section;   // platserna i tillståndsblocket

const SECTION_SCORE_F32 = sysEnv('SECTION_SCORE_F32') === '1';   // Rangpoangens buffert i 32-bitars flyttal
const SECTION_CARRY = numEnv('SECTION_CARRY', 0);   // block som bärs över låtgränsen
const RANK_WIN = numEnv('SECTION_WIN', 4);   // RANG-RATTAR
const RANK_RUN = numEnv('SECTION_RUN', 3);
const RANK_RUN_IN = numEnv('SECTION_RUN_IN', 0);   // SNABB ATTACK
const REPEAT = Number(sysEnv('SECTION_REPEAT')) || 0;   // UPPREPNINGSMINNE v2
const SECTION_EARLY_DB = Number(sysEnv('SECTION_EARLY_DB')) || 3;
const DOUBLE_FROM_START = ['secHiStartMs', 'secHiEndMs', 'secPct', 'secSongStartMs', 'secBlkMs', 'secBlkInt', 'secBlkCent', 'secBlkRms2', 'secCurDbSum'] as const;   // Talfält som ska vara flyttal från start

/** DET SEKTIONEN LÄSER (workern: bigAgg och blocken; odelat sectionAggStep). Inget annat går att nå. */
export interface SectionReads {
  hop:      Ser<'L', 'hop', 'role' | 'bigOn' | 'rms' | 'nowWall' | 'dtHop' | 'centSmooth' | 'wallNow' | 'breaking'>;
  level:    Ser<'L', 'level', 'activeMs' | 'intensity'>;
  kick:     Ser<'L', 'kick', 'kick'>;
  clock:    Ser<'L', 'clock', 'bpm' | 'phaseMs'>;
  drop:     Ser<'L', 'drop', 'dropCand' | 'secBodyRet'>;
  riser:    Ser<'L', 'riser', 'buildUp'>;
  spectrum: Ser<'L', 'spectrum', 'bigN' | 'bandDbRaw'>;
}

export class SectionTracker {
  private readonly h: SectionReads['hop']; private readonly lv: SectionReads['level']; private readonly kk: SectionReads['kick']; private readonly ck: SectionReads['clock'];
  private readonly dr: SectionReads['drop']; private readonly ri: SectionReads['riser']; private readonly sp: SectionReads['spectrum'];
  constructor(r: SectionReads, private readonly o: SectionOut) {   // läser: r, lämnar ut: o
    this.h = r.hop; this.lv = r.level; this.kk = r.kick; this.ck = r.clock; this.dr = r.drop; this.ri = r.riser; this.sp = r.spectrum;
    stabilise(this, DOUBLE_FROM_START);
    stabilise(this.secRank, ['md', 'sd', 'mk', 'sk']);   // förr sist i Analysers konstruktor
  }
  private static readonly PREDICT_SRC = 2;   // Forutsagelsens kallor


  private static readonly PREDICT_LAT = 4;   // Frasregel
  private static readonly PREDICT_RISE = 4;

  private static readonly RANK_HI = 0.67;
  private static readonly RANK_LO = 0.33;
  private static readonly RANK_W_DENS = 0.5;
  private static readonly RANK_W_CENT = 0.5;
  private static readonly RANK_W_BASSON = 0;   // NYA SARDRAG I RANGPOANGEN
  private static readonly RANK_W_BASSENV = 0;
  private static readonly RANK_W_HIGH = 1.0;
  private static readonly RANK_W_FLAT = 0;
  private static readonly RANK_W_FLUX = 0;
  private static readonly RANK_W_DYN = 0;
  private secBlkBon = 0; private secBlkBpk = 0; private secBlkFlux = 0; private secBlkRms4 = 0;
  private secBlkH: { bon: number[]; bpk: number[]; high: number[]; flat: number[]; flux: number[]; dyn: number[] } = { bon: [], bpk: [], high: [], flat: [], flux: [], dyn: [] };
  private static readonly RANK_HYST = 0.15;



  private secBlkCentH: number[] = []; private secScoreBuf: Float64Array | Float32Array = SECTION_SCORE_F32 ? new Float32Array(600) : new Float64Array(600);   // ATERINTRADE
  private secBlkHighH: number[] = [];


 private bndRef = new Float32Array(9);   // levelVsHighDb-referens
  private secBlkRms2 = 0; private secBlkDb: number[] = []; private secBlkDens: number[] = [];
  private secHiStartMs = 0;   // frasgittrets ankare
  private secLog: Array<{ label: string; startMs: number; endMs: number; db: number; dens: number }> = [];
  private secCurDbSum = 0; private secCurDbN = 0; private secCurDens = 0; private lastHighDb = NaN;
  private static readonly SEC_EDGE_DB = 4;   // SNABBA KANTER
  private secCarryHighDb = NaN; private secHiEndMs = 0; private secEdgeBuf = new Float64Array(16);
  private secBlkMs = 0; private secBlkN = 0; private secBlkInt = 0; private secBlkKicks = 0; private secBlkCent = 0; private secBlkSpec = new Float32Array(8);
  private secTierRun = 0; private secTierCand = 1; private secRiseRun = 0; private secSongStartMs = 0; private secDropSeen = 0; private secSilentBlocks = 0; private secDropHoldUntil = 0;
  private secHist = new Float32Array(16); private secHistPos = 0; private secHistN = 0;
  private static readonly FP_DIM = 11; private static readonly FP_MAX = 96;
  private secFp = new Float32Array(SectionTracker.FP_MAX * SectionTracker.FP_DIM); private secFpT = new Float64Array(SectionTracker.FP_MAX); private secFpLab: string[] = [];
  private secFpN = 0; private secFpPos = 0; private secFpAcc = new Float32Array(SectionTracker.FP_DIM); private secFpAccN = 0;
  private static readonly REPEAT_THR = 0.7;
  private static readonly REPEAT_STEP = 2;
  private static readonly REPEAT_W = 2;
  private static readonly FP2_DIM = 12; private static readonly FP2_MAX = 128;
  private secFp2 = new Float32Array(SectionTracker.FP2_MAX * SectionTracker.FP2_DIM); private secFp2Z = new Float32Array(SectionTracker.FP2_MAX * SectionTracker.FP2_DIM);
  private secFp2T = new Float64Array(SectionTracker.FP2_MAX); private secFp2Db = new Float32Array(SectionTracker.FP2_MAX); private secFp2Dens = new Float32Array(SectionTracker.FP2_MAX); private secFp2Lab: string[] = [];
  private secFp2N = 0; private secFp2Pos = 0; private secFp2Acc = new Float32Array(SectionTracker.FP2_DIM); private secFp2AccN = 0; private secFp2AccDb = 0; private secFp2AccDens = 0;
  private secFp2Mu = new Float32Array(SectionTracker.FP2_DIM); private secFp2Sd = new Float32Array(SectionTracker.FP2_DIM);
  private secBlkT: number[] = []; private secRank = { md: 0, sd: 1, mk: 0, sk: 1 }; private secScoreSorted = new Float64Array(601);   // 2026-10-17

  private secBlkFeat: Float32Array[] = []; private secBlkHi: number[] = []; private secPct = 0;   // KLANGMALL
  private repeatHighRun = 0; private secHighRunMs = 0;
  private shIn = { hops: 0.5, intSum: 0.5, kicks: 0.5, breaking: false, nowMs: 0.5, dtMs: 0.5, rms2Sum: 0.5, centSum: 0.5, specOff: 0.5, bonSum: 0.5, bpk: 0.5, fluxSum: 0.5, rms4Sum: 0.5 };   // sectionHop:s summor
  private specSeen = -1;   // senast sedda bigN; -1 = smutsigt från start
  private readonly agg = { n: 0, int: 0, kicks: 0, breaking: 0, rms2: 0, cent: 0, dt: 0, wall: 0, drops: 0, spec: new Float64Array(8), bon: 0, bpk: 0, flux: 0, rms4: 0 };   // insamlarens summor (förr Analyser.secAgg)
  private readonly wire = { drops: 0 };   // workerns indata (förr secVDrops)
  private readonly secSpecHop = new Float64Array(8);   // Bandens absoluta magnitud for sektionsblocket
  secDump: number[][] | null = sysEnv('SECTION_DUMP') === '1' ? [] : null;   // Korbanks-dump
  dbgSecBlock: ((b: Record<string, unknown>) => void) | null = null;   // Korbanks-krok
  private static readonly SECTION_EARLY_S = 45;   // TIDIG REFRANG KRAVER NIVA


  /** SEKTION. */
  private dropsNow(): number { return this.h.role === 'slow' ? this.wire.drops : this.dr.dropCand + this.dr.secBodyRet; }
  sectionReset(): void {
    this.o.secBuildAt = 0; this.o.secBuildSeen = 0;
    this.o.section = 'intro'; this.o.sectionStartMs = 0; this.o.sectionIndex = 0; this.o.sectionTier = 1; this.o.repeatSim = 0; this.o.repeatAgoMs = 0; this.o.repeatSection = '';
    this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0);
    this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0; const H = this.secBlkH; H.bon.length = 0; H.bpk.length = 0; H.high.length = 0; H.flat.length = 0; H.flux.length = 0; H.dyn.length = 0;
    this.secTierRun = 0; this.secTierCand = 1; this.secRiseRun = 0; this.secSongStartMs = 0; this.secBlkRms2 = 0; this.secBlkDb.length = 0; this.secBlkDens.length = 0; this.secBlkCentH.length = 0; this.secDropSeen = this.dropsNow(); this.secSilentBlocks = 0; this.secDropHoldUntil = 0;
    this.secHistN = 0; this.secHistPos = 0; this.secFpN = 0; this.secFpPos = 0; this.secFpLab.length = 0; this.secFpAcc.fill(0); this.secFpAccN = 0;
    this.secLog.length = 0; this.secCurDbSum = 0; this.secCurDbN = 0; this.secCurDens = 0; this.lastHighDb = NaN; this.secCarryHighDb = NaN; this.secHiEndMs = 0; this.o.expectHighMs = 0; this.o.expectSource = 0; this.o.prevSection = ''; this.o.levelVsHighDb = 0;

    this.secHiStartMs = 0; this.secPct = 0;
    this.secFp2N = 0; this.secFp2Pos = 0; this.secFp2Lab.length = 0; this.secFp2Acc.fill(0); this.secFp2AccN = 0; this.secFp2AccDb = 0; this.secFp2AccDens = 0;
    this.secBlkT.length = 0; this.secRank.md = 0; this.secRank.sd = 1; this.secRank.mk = 0; this.secRank.sk = 1; this.o.repeatTier = -1; this.o.repeatHighAtMs = 0; this.o.repeatHighEndAtMs = 0; this.repeatHighRun = 0; this.secHighRunMs = 0;
    this.secBlkFeat.length = 0; this.secBlkHi.length = 0; this.secPct = 0;

    this.secBlkHighH.length = 0; this.bndRef.fill(0); this.o.boundaryNov = 0;
  }

  /** Tar BLOCKSUMMOR. */
  private sectionHop(spec: ArrayLike<number>): void {
    const I = this.shIn, hops = I.hops, intSum = I.intSum, kicks = I.kicks, breaking = I.breaking, nowMs = I.nowMs, dtMs = I.dtMs, rms2Sum = I.rms2Sum, centSum = I.centSum,
      specOff = I.specOff, bonSum = I.bonSum, bpk = I.bpk, fluxSum = I.fluxSum, rms4Sum = I.rms4Sum;
    if (this.secSongStartMs === 0) { this.secSongStartMs = nowMs; this.o.sectionStartMs = nowMs; this.secDropSeen = this.dropsNow(); }
    this.secBlkMs += dtMs; this.secBlkN += hops; this.secBlkInt += intSum; this.secBlkKicks += kicks; this.secBlkCent += centSum; this.secBlkRms2 += rms2Sum;
    this.secBlkBon += bonSum; this.secBlkBpk += bpk; this.secBlkFlux += fluxSum; this.secBlkRms4 += rms4Sum;
    for (let i = 0; i < 8; i++) this.secBlkSpec[i] += spec[specOff + i];
    if (this.secBlkMs < 1000) return;
    this.sectionBlock(nowMs, breaking);
  }

  /** Blockets sardrag och etikett. */
  private sectionBlock(nowMs: number, breaking: boolean): void {
    const n = this.secBlkN || 1; const bInt = this.secBlkInt / n; const bKicks = this.secBlkKicks; const bCent = this.secBlkCent / n;
    const blkDb = 10 * Math.log10(this.secBlkRms2 / n + 1e-10);
    const bBon = this.secBlkBon / n, bBpk = this.secBlkBpk / Math.max(0.25, this.secBlkMs / 1000), bFlux = this.secBlkFlux / n;
    const m2 = this.secBlkRms2 / n, v2 = this.secBlkRms4 / n - m2 * m2; const bDyn = m2 > 1e-12 ? Math.sqrt(Math.max(0, v2)) / m2 : 0;
    let sAr = 0, sGe = 0; for (let i = 0; i < 8; i++) { const v = this.secBlkSpec[i] / n + 1e-7; sAr += v; sGe += Math.log(v); }
    const bFlat = Math.exp(sGe / 8) / (sAr / 8); const bHigh = 20 * Math.log10((this.secBlkSpec[6] + this.secBlkSpec[7]) / n + 1e-7);
    if (this.lv.activeMs === 0) { if (++this.secSilentBlocks >= 10) { this.sectionReset(); return; } }
    else this.secSilentBlocks = 0;
    let tier = bInt >= 0.62 ? 2 : bInt <= 0.40 ? 0 : 1;
    {
      const db = 10 * Math.log10(this.secBlkRms2 / n + 1e-10); this.secBlkDb.push(db); this.secBlkDens.push(bKicks); this.secBlkCentH.push(bCent); this.secBlkHighH.push(bHigh); if (REPEAT & 1) this.secBlkT.push(nowMs);
      { const H = this.secBlkH; H.bon.push(bBon); H.bpk.push(bBpk); H.high.push(bHigh); H.flat.push(bFlat); H.flux.push(bFlux); H.dyn.push(bDyn); }
      if (this.secBlkDb.length > 600) { this.secBlkDb.shift(); this.secBlkDens.shift(); this.secBlkCentH.shift(); this.secBlkHighH.shift(); { const H = this.secBlkH; H.bon.shift(); H.bpk.shift(); H.high.shift(); H.flat.shift(); H.flux.shift(); H.dyn.shift(); } if (REPEAT & 1) this.secBlkT.shift();  }
      const nb = this.secBlkDb.length;
      if (nb >= 20) {
        tier = this.rankTier(nb);
      } else { tier = 1; this.secPct = 0; }
    }
    if (tier === this.secTierCand) this.secTierRun++; else { this.secTierCand = tier; this.secTierRun = 1; }
    const runNeed = (RANK_RUN_IN > 0 && this.secTierCand === 2 && this.o.sectionTier < 2) ? RANK_RUN_IN : RANK_RUN;
    if (this.secTierRun >= runNeed) this.o.sectionTier = this.secTierCand;
    let edgeUp = false, edgeDown = false, fallen = false;
    {
      const D = this.secBlkDb, nb = D.length, E = SectionTracker.SEC_EDGE_DB, ref = this.lastHighDb === this.lastHighDb ? this.lastHighDb : this.secCarryHighDb;
      fallen = nb >= 2 && blkDb <= this.lastHighDb - E && D[nb - 2] <= this.lastHighDb - E / 2;
      if (this.o.section === 'high') edgeDown = fallen;
      else if (blkDb >= ref - E) {
        const barMs = this.ck.bpm > 40 ? 240000 / this.ck.bpm : 4 * BE_FALLBACK_MS;
        const m = Math.min(nb - 1, 4 * Math.max(2, Math.min(4, Math.round(barMs / 1000)))), w = this.secEdgeBuf;
        if (m >= 4) {
          for (let i = 0; i < m; i++) { const v = D[nb - 2 - i]; let k = i; while (k > 0 && w[k - 1] > v) { w[k] = w[k - 1]; k--; } w[k] = v; }
          edgeUp = blkDb - w[m >> 1] >= E;
        }
      }
      if (edgeUp || edgeDown) { this.o.sectionTier = edgeUp ? 2 : 0; this.secTierCand = this.o.sectionTier; this.secTierRun = 0; }
    }
    const st = this.o.sectionTier;
    this.secHist[this.secHistPos] = bInt; this.secHistPos = (this.secHistPos + 1) & 15; if (this.secHistN < 16) this.secHistN++;
    const rise = this.secHistN >= 9 ? bInt - this.secHist[(this.secHistPos - 9 + 16) & 15] : 0;
    this.secRiseRun = rise >= 0.10 ? this.secRiseRun + 1 : 0;
    const sinceStart = nowMs - this.secSongStartMs; const dropEv = this.dropsNow(); const dropped = dropEv !== this.secDropSeen; this.secDropSeen = dropEv;
    const prev = this.o.section; let label: string;
    {
      if (this.secBlkDb.length < 20) label = edgeDown ? 'low' : edgeUp || (BODY_HIGH_MS > 0 && (dropped || prev === 'high')) ? 'high' : 'intro';
      else if (dropped || st === 2) label = 'high';
      else if (st === 0) label = 'low';
      else label = prev === 'high' || prev === 'break' ? 'break' : (prev === 'low' || prev === 'intro' || prev === 'build') ? 'build' : prev;
      if (label === 'high' && !dropped && !edgeUp && prev !== 'high' && sinceStart < SectionTracker.SECTION_EARLY_S * 1000 && this.secBlkDb.length >= 4) {
        const D = this.secBlkDb, nb = D.length; const srt = D.slice().sort((a, b) => a - b); const med = srt[nb >> 1];
        const m4 = (D[nb - 1] + D[nb - 2] + D[nb - 3] + D[nb - 4]) / 4;
        if (m4 < med + SECTION_EARLY_DB) label = prev === 'intro' || prev === 'low' || prev === 'build' ? 'build' : prev;
      }
      if ((REPEAT & 64) && this.o.repeatSim >= SectionTracker.REPEAT_THR && this.o.repeatHighAtMs > 0 && st >= 1 && label !== 'high' && !dropped) {
        const d = this.o.repeatHighAtMs - nowMs; if (d >= -1500 && d <= 1000) label = 'high';
      }
      if ((REPEAT & 48) && prev === 'high' && label === 'break' && st === 1) {
        {
          let hold = (REPEAT & 16) ? Math.min(40000, this.secHighRunMs) : 0;
          if ((REPEAT & 32) && this.ck.bpm > 0) hold = Math.max(hold, 8 * 240000 / this.ck.bpm);
          if (nowMs - this.o.sectionStartMs < hold) label = 'high';
        }
      }
      if (dropped && label === 'high') this.secDropHoldUntil = nowMs + (RANK_WIN + RANK_RUN) * 1000;
      else if (prev === 'high' && label !== 'high' && st >= 1 && nowMs < this.secDropHoldUntil) label = 'high';
    }
    if (label === 'high' && prev !== 'high' && !dropped && !edgeUp && fallen && nowMs - this.secHiEndMs < BE_MEM_BEATS * (this.ck.bpm > 40 ? 60000 / this.ck.bpm : BE_FALLBACK_MS)) {
      label = prev === 'break' ? 'break' : 'build'; this.o.sectionTier = 1;
    }
    const dwellMs = label === 'high' ? 4000 : 8000;
    const dwellOk = nowMs - this.o.sectionStartMs >= dwellMs || (prev === 'high' && label === 'break') || (BODY_HIGH_MS > 0 && dropped && label === 'high') || edgeUp || edgeDown;
    if (label !== prev && dwellOk) {
      const dbMean = this.secCurDbN ? this.secCurDbSum / this.secCurDbN : blkDb;
      this.secLog.push({ label: prev, startMs: this.o.sectionStartMs, endMs: nowMs, db: dbMean, dens: this.secCurDbN ? this.secCurDens / this.secCurDbN : 0 });
      if (this.secLog.length > 48) this.secLog.shift();
      if (prev === 'high') { this.lastHighDb = dbMean; this.secHiEndMs = nowMs; }
      this.o.prevSection = prev; this.secCurDbSum = 0; this.secCurDbN = 0; this.secCurDens = 0;
      this.o.sectionStartMs = nowMs; if (label === 'high') { this.o.sectionIndex++; this.secHiStartMs = nowMs; } this.o.section = label;
    }
    if (prev === 'build' || this.o.section === 'build') { if (this.o.section === 'build' && (this.o.secBuildAt === 0 || nowMs - this.o.secBuildSeen > 2000)) this.o.secBuildAt = nowMs; this.o.secBuildSeen = nowMs; }
    this.secCurDbSum += blkDb; this.secCurDbN++; this.secCurDens += bKicks;
    if (this.secDump) { const row = [(nowMs - this.secSongStartMs) / 1000, blkDb, bKicks, bCent, bInt, breaking ? 1 : 0, dropped ? 1 : 0]; for (let i = 0; i < 8; i++) row.push(this.secBlkSpec[i] / n); row.push(st, ['intro', 'low', 'build', 'high', 'break'].indexOf(this.o.section)); this.secDump.push(row); }
    if (this.o.section === 'high') { this.lastHighDb = this.secCurDbSum / this.secCurDbN; }
    this.o.levelVsHighDb = Number.isFinite(this.lastHighDb) ? blkDb - this.lastHighDb : 0;
    this.predictHigh(nowMs, bInt);
    if (this.dbgSecBlock) this.dbgSecBlock({ nowMs, section: this.o.section, sectionStartMs: this.o.sectionStartMs, prev, label, bpm: this.ck.bpm, bInt, bKicks, bCent, blkDb, buildUp: this.ri.buildUp, riseRun: this.secRiseRun, rise, dropped, breaking, tier: this.o.sectionTier, repeatSim: this.o.repeatSim, repeatAgoMs: this.o.repeatAgoMs, repeatSection: this.o.repeatSection, spec: Array.from(this.secBlkSpec, (v) => v / n), lastHighDb: this.lastHighDb, expectHighMs: this.o.expectHighMs, expectSource: this.o.expectSource, beatPhaseMs: this.ck.phaseMs, secLogN: this.secLog.length, secLogLast: this.secLog[this.secLog.length - 1] ?? null, bBon, bBpk, bFlux, bDyn, bHigh, bFlat, pct: this.secPct });
    if (REPEAT & 1) { this.repeatStep(nowMs, blkDb, bKicks, bCent, bInt); this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0); this.secBlkRms2 = 0; this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0; return; }
    let sum = 0; for (let i = 0; i < 8; i++) sum += this.secBlkSpec[i];
    const acc = this.secFpAcc; for (let i = 0; i < 8; i++) acc[i] += sum > 0 ? this.secBlkSpec[i] / sum : 0;
    acc[8] += bCent; acc[9] += Math.min(1, bKicks / 4); acc[10] += bInt; this.secFpAccN++;
    if (this.secFpAccN >= 4) {
      const D = SectionTracker.FP_DIM; let nrm = 0; for (let i = 0; i < D; i++) { acc[i] /= this.secFpAccN; nrm += acc[i] * acc[i]; }
      nrm = Math.sqrt(nrm) || 1; for (let i = 0; i < D; i++) acc[i] /= nrm;
      let best = 0, bestAt = 0, bestLab = '';
      for (let k = 0; k < this.secFpN; k++) {
        if (nowMs - this.secFpT[k] < 16000) continue;
        let dot = 0; const o = k * D; for (let i = 0; i < D; i++) dot += acc[i] * this.secFp[o + i];
        if (dot > best) { best = dot; bestAt = this.secFpT[k]; bestLab = this.secFpLab[k]; }
      }
      this.o.repeatSim = best; this.o.repeatAgoMs = best > 0 ? nowMs - bestAt : 0; this.o.repeatSection = bestLab;
      const o = this.secFpPos * D; for (let i = 0; i < D; i++) this.secFp[o + i] = acc[i];
      this.secFpT[this.secFpPos] = nowMs; this.secFpLab[this.secFpPos] = this.o.section;
      this.secFpPos = (this.secFpPos + 1) % SectionTracker.FP_MAX; if (this.secFpN < SectionTracker.FP_MAX) this.secFpN++;
      acc.fill(0); this.secFpAccN = 0;
    }
    this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0); this.secBlkRms2 = 0; this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0;
  }

  /** RANGBERÄKNINGEN. */
  private rankTier(nb: number): number {
    const D = this.secBlkDb, K = this.secBlkDens, C = this.secBlkCentH, wk = SectionTracker.RANK_W_DENS, wc = SectionTracker.RANK_W_CENT;
    let md = 0, mk = 0, mc = 0; for (let i = 0; i < nb; i++) { md += D[i]; mk += K[i]; mc += C[i]; } md /= nb; mk /= nb; mc /= nb;
    let sd = 0, sk = 0, sc = 0; for (let i = 0; i < nb; i++) { sd += (D[i] - md) ** 2; sk += (K[i] - mk) ** 2; sc += (C[i] - mc) ** 2; }
    sd = Math.max(1.0, Math.sqrt(sd / nb)); sk = Math.max(0.3, Math.sqrt(sk / nb)); sc = Math.max(0.02, Math.sqrt(sc / nb));
    this.secRank.md = md; this.secRank.sd = sd; this.secRank.mk = mk; this.secRank.sk = sk;
    const terms = this.secTerms; let nt = 0;
    {
      const H = this.secBlkH;
      nt = this.rankTerm(nt, H.bpk, SectionTracker.RANK_W_BASSON, 0.5, nb); nt = this.rankTerm(nt, H.bon, SectionTracker.RANK_W_BASSENV, 0.02, nb); nt = this.rankTerm(nt, this.secBlkHighH, SectionTracker.RANK_W_HIGH, 1.0, nb);
      nt = this.rankTerm(nt, H.flat, SectionTracker.RANK_W_FLAT, 0.02, nb); nt = this.rankTerm(nt, H.flux, SectionTracker.RANK_W_FLUX, 0.01, nb); nt = this.rankTerm(nt, H.dyn, SectionTracker.RANK_W_DYN, 0.05, nb);
    }
    const S = this.secScoreBuf;
    for (let i = 0; i < nb; i++) {
      let v = (D[i] - md) / sd + wk * (K[i] - mk) / sk + wc * (C[i] - mc) / sc;
      for (let t = 0; t < nt; t++) { const T = terms[t]; v += T.w * (T.X[i] - T.m) / T.s; }
      S[i] = v;
    }
    let win = 0; const W = Math.min(RANK_WIN, nb); for (let i = nb - W; i < nb; i++) win += S[i]; win /= W;
    let below = 0, cnt = 0;
    { let acc = 0; for (let e = 1; e <= nb; e++) { acc += S[e - 1]; if (e > W) acc -= S[e - 1 - W]; if (e >= W) { cnt++; if (acc / W < win) below++; } } }
    const pct = below / cnt; const cur = this.o.sectionTier, h = SectionTracker.RANK_HYST; this.secPct = pct;
    return pct >= SectionTracker.RANK_HI - (cur === 2 ? h : 0) ? 2 : pct <= SectionTracker.RANK_LO + (cur === 0 ? h : 0) ? 0 : 1;
  }

  /** En RANK_W_*-term. */
  private rankTerm(nt: number, X: number[], w: number, floor: number, nb: number): number {
    if (w === 0) return nt;
    let m = 0; for (let i = 0; i < nb; i++) m += X[i]; m /= nb; let s = 0; for (let i = 0; i < nb; i++) s += (X[i] - m) ** 2; s = Math.max(floor, Math.sqrt(s / nb));
    const T = this.secTerms[nt]; T.X = X; T.w = w; T.m = m; T.s = s; return nt + 1;
  }
  private secTerms = [0, 1, 2, 3, 4, 5].map(() => ({ X: [] as number[], w: 0.5, m: 0.5, s: 0.5 }));

  /** UPPREPNINGSMINNE v2. */
  private repeatStep(nowMs: number, blkDb: number, bKicks: number, bCent: number, bInt: number): void {
    const D = SectionTracker.FP2_DIM, MAX = SectionTracker.FP2_MAX, acc = this.secFp2Acc;
    let sum = 0; for (let i = 0; i < 8; i++) sum += this.secBlkSpec[i];
    for (let i = 0; i < 8; i++) acc[i] += sum > 0 ? this.secBlkSpec[i] / sum : 0;
    acc[8] += bCent; acc[9] += Math.min(1, bKicks / 4); acc[10] += bInt; acc[11] += blkDb / 10; this.secFp2AccDb += blkDb; this.secFp2AccDens += bKicks; this.secFp2AccN++;
    if (this.secFp2AccN < SectionTracker.REPEAT_STEP) return;
    const pos = this.secFp2Pos, o = pos * D; for (let i = 0; i < D; i++) this.secFp2[o + i] = acc[i] / this.secFp2AccN;
    this.secFp2T[pos] = nowMs; this.secFp2Db[pos] = this.secFp2AccDb / this.secFp2AccN; this.secFp2Dens[pos] = this.secFp2AccDens / this.secFp2AccN; this.secFp2Lab[pos] = this.o.section;
    this.secFp2Pos = (pos + 1) % MAX; if (this.secFp2N < MAX) this.secFp2N++;
    acc.fill(0); this.secFp2AccN = 0; this.secFp2AccDb = 0; this.secFp2AccDens = 0;
    const N = this.secFp2N; const idx = (m: number) => (pos - m + MAX) % MAX;
    const mu = this.secFp2Mu, sd = this.secFp2Sd; mu.fill(0); sd.fill(0);
    for (let m = 0; m < N; m++) { const q = idx(m) * D; for (let i = 0; i < D; i++) mu[i] += this.secFp2[q + i]; }
    for (let i = 0; i < D; i++) mu[i] /= N;
    for (let m = 0; m < N; m++) { const q = idx(m) * D; for (let i = 0; i < D; i++) sd[i] += (this.secFp2[q + i] - mu[i]) ** 2; }
    for (let i = 0; i < D; i++) sd[i] = Math.max(1e-3, Math.sqrt(sd[i] / N));
    const z = this.secFp2Z;
    for (let m = 0; m < N; m++) { const q = idx(m) * D; let nrm = 0; for (let i = 0; i < D; i++) { const v = (this.secFp2[q + i] - mu[i]) / sd[i]; z[q + i] = v; nrm += v * v; } nrm = Math.sqrt(nrm) || 1; for (let i = 0; i < D; i++) z[q + i] /= nrm; }
    const W = Math.min(SectionTracker.REPEAT_W, N); let best = 0, bestM = -1;
    for (let m = W; m + W - 1 < N; m++) {
      if (nowMs - this.secFp2T[idx(m)] < 16000) continue;
      let s = 0; for (let j = 0; j < W; j++) { const a = idx(j) * D, b = idx(m + j) * D; for (let i = 0; i < D; i++) s += z[a + i] * z[b + i]; }
      s /= W; if (s > best) { best = s; bestM = m; }
    }
    const prevAt = this.o.repeatHighAtMs;
    this.o.repeatSim = best; this.o.repeatTier = -1; this.o.repeatHighAtMs = 0; this.o.repeatHighEndAtMs = 0;
    const nb = this.secBlkDb.length; if (nb < 20) { this.o.repeatAgoMs = 0; this.o.repeatSection = ''; return; }
    const R = this.secRank; const score = (db: number, dens: number) => (db - R.md) / R.sd + (dens - R.mk) / R.sk;
    const ss = this.secScoreSorted; for (let i = 0; i < nb; i++) ss[i] = score(this.secBlkDb[i], this.secBlkDens[i]); ss.subarray(0, nb).sort();
    const pct = (v: number) => { let lo = 0, hi = nb; while (lo < hi) { const mid = (lo + hi) >> 1; if (ss[mid] < v) lo = mid + 1; else hi = mid; } return lo / nb; };
    if (REPEAT & 16) {
      let run = 0, gap = 0, bestRun = 0;
      for (let i = 0; i < nb; i++) {
        if (this.secBlkT[i] >= this.o.sectionStartMs) break;
        if (pct(score(this.secBlkDb[i], this.secBlkDens[i])) >= SectionTracker.RANK_HI) { run += 1 + gap; gap = 0; if (run > bestRun) bestRun = run; }
        else if (run > 0 && ++gap > 2) { run = 0; gap = 0; }
      }
      this.secHighRunMs = bestRun * 1000;
    }
    if (bestM < 0) { this.o.repeatAgoMs = 0; this.o.repeatSection = ''; return; }
    const kEnd = idx(bestM); const lagMs = nowMs - this.secFp2T[kEnd];
    this.o.repeatAgoMs = lagMs; this.o.repeatSection = this.secFp2Lab[kEnd];
    let ps = 0; for (let j = 0; j < W; j++) { const k = idx(bestM + j); ps += score(this.secFp2Db[k], this.secFp2Dens[k]); } ps /= W;
    const p = pct(ps); this.o.repeatTier = p >= SectionTracker.RANK_HI ? 2 : p <= SectionTracker.RANK_LO ? 0 : 1;
    const tEnd = this.secFp2T[kEnd]; let run = 0, at = 0, endAt = 0, lowRun = 0;
    for (let i = 0; i < nb; i++) {
      if (this.secBlkT[i] <= tEnd) continue;
      const hi = pct(score(this.secBlkDb[i], this.secBlkDens[i])) >= SectionTracker.RANK_HI;
      if (at === 0) { if (hi) { if (++run >= 2) at = this.secBlkT[i - 1] + lagMs; } else run = 0; }
      else if (!hi) { if (++lowRun >= 3) { endAt = this.secBlkT[i - 2] + lagMs; break; } } else lowRun = 0;
    }
    this.o.repeatHighEndAtMs = at > 0 ? endAt : 0;
    if (at > 0 && prevAt > nowMs && Math.abs(at - prevAt) <= 4000) { at = prevAt; this.repeatHighRun++; }
    else this.repeatHighRun = at > 0 ? 1 : 0;
    this.o.repeatHighAtMs = at;
  }

  /** FORUTSAGELSE av nasta 'high'. */
  private predictHigh(nowMs: number, bInt: number): void {
    const bpm = this.ck.bpm; const barMs = bpm > 0 ? 240000 / bpm : 0;
    let exp = 0, src = 0;
    if ((REPEAT & 4) && this.o.section !== 'high' && this.o.repeatSim >= SectionTracker.REPEAT_THR && this.repeatHighRun >= 2 && this.o.repeatHighAtMs > nowMs + 500 && this.o.repeatHighAtMs - nowMs <= 32000) { exp = this.o.repeatHighAtMs; src = 4; }
    if (!exp && this.o.section !== 'high' && barMs > 0) {
      if (SectionTracker.PREDICT_SRC & 1) for (let i = this.secLog.length - 2; i >= 0; i--) {
        const a = this.secLog[i], b = this.secLog[i + 1];
        if (a.label !== this.o.section || b.label !== 'high') continue;
        const bars = Math.max(4, Math.round((a.endMs - a.startMs) / barMs / 4) * 4);
        const cand = this.o.sectionStartMs + bars * barMs;
        if (cand > nowMs + 500) { exp = cand; src = 1; }
        break;
      }
      const rising = this.secRiseRun >= SectionTracker.PREDICT_RISE;
      if (!exp && (SectionTracker.PREDICT_SRC & 2) && rising) {
        const anchor = this.secHiStartMs > 0 ? this.secHiStartMs : this.o.sectionStartMs;
        const L = SectionTracker.PREDICT_LAT * barMs;
        const elapsed = nowMs - anchor; const k = Math.ceil((elapsed + barMs) / L);
        const cand = anchor + k * L;
        if (cand - nowMs <= 16 * barMs) { exp = cand; src = 2; }
      }
    }
    if (exp === 0 && this.o.expectHighMs > 0 && this.o.section !== 'high' && this.o.expectHighMs > nowMs - 2000) { exp = this.o.expectHighMs; src = this.o.expectSource; }
    this.o.expectHighMs = exp; this.o.expectSource = src;
  }

  /** Odelat: sektionens block per hop (delat gör workern det i bigAgg/fromRecord). */
  sectionAggStep(): void {
    const intensity = this.lv.intensity, kick = this.kk.kick, breaking = this.h.breaking, rms = this.h.rms;
      if (this.h.bigOn) return;
      const sp = this.secSpecHop;
      if (this.sp.bigN !== this.specSeen) { this.specSeen = this.sp.bigN; for (let i = 0; i < 8; i++) sp[i] = Math.pow(10, this.sp.bandDbRaw[i] / 20); }
      const I = this.shIn; I.hops = 1; I.intSum = intensity; I.kicks = kick ? 1 : 0; I.breaking = breaking; I.nowMs = this.h.wallNow(); I.dtMs = this.h.dtHop * 1000;
      I.rms2Sum = rms * rms; I.centSum = this.h.centSmooth; I.specOff = 0; I.bonSum = 0; I.bpk = 0; I.fluxSum = 0; I.rms4Sum = 0; this.sectionHop(sp);
  }

  /** slow + stora vägen: sektionens hopaggregat (förr Analyser.bigAgg); hoppets värden ur facken (hopprecordet). */
  bigAgg(): void {
    const h = this.h, intensity = this.lv.intensity, kick = this.kk.kick, breaking = h.breaking, wall = h.nowWall;
    const dp = this.dr;
    const rms = h.rms;
    const sp = this.secSpecHop;
    if (this.sp.bigN !== this.specSeen) { this.specSeen = this.sp.bigN; for (let i = 0; i < 8; i++) sp[i] = Math.pow(10, this.sp.bandDbRaw[i] / 20); }
    const g = this.agg; g.n++; g.int += intensity; if (kick) g.kicks++; g.rms2 += rms * rms; g.cent += h.centSmooth; g.dt += h.dtHop * 1000;
    g.breaking = breaking ? 1 : 0; g.wall = wall; g.drops = dp.dropCand + dp.secBodyRet;
    for (let i = 0; i < 8; i++) g.spec[i] += sp[i];
  }

  /** Workern: ett record stänger blocket ur hoppens summor (förr sist i slowStep). */
  fromRecord(): void {
      const g = this.agg;
      if (g.n > 0) this.wire.drops = g.drops;
      if (g.n > 0) {
        const I = this.shIn; I.hops = g.n; I.intSum = g.int; I.kicks = g.kicks; I.breaking = g.breaking > 0; I.nowMs = g.wall; I.dtMs = g.dt; I.rms2Sum = g.rms2; I.centSum = g.cent;
        I.specOff = 0; I.bonSum = g.bon; I.bpk = g.bpk; I.fluxSum = g.flux; I.rms4Sum = g.rms4;
        this.sectionHop(g.spec);
        g.n = 0; g.int = 0; g.kicks = 0; g.breaking = 0; g.rms2 = 0; g.cent = 0; g.dt = 0; g.spec.fill(0); g.bon = 0; g.bpk = 0; g.flux = 0; g.rms4 = 0;
      }
  }

  /** Workern startar om: dropkandidaterna ur senaste BS_-blocket. */
  resume(st: Float64Array): void { this.wire.drops = st[BS.drop.dropCand]; }

  /** Workern: sektionens fält till tillståndsblocket (drainRecords). */
  pack(s: Float64Array): void {
    const o = this.o;
    s[P.section] = sectionCode(o.section); s[P.sectionStartMs] = o.sectionStartMs; s[P.sectionIndex] = o.sectionIndex; s[P.sectionTier] = o.sectionTier; s[P.secBuildAt] = o.secBuildAt; s[P.secBuildSeen] = o.secBuildSeen;
    s[P.repeatSim] = o.repeatSim; s[P.repeatAgoMs] = o.repeatAgoMs; s[P.repeatSection] = sectionCode(o.repeatSection);
    s[P.expectHighMs] = o.expectHighMs; s[P.expectSource] = o.expectSource; s[P.prevSection] = sectionCode(o.prevSection); s[P.levelVsHighDb] = o.levelVsHighDb;
  }
  /** Huvudtråden: sektionens fält ur tillståndsblocket (pullSlowState). */
  unpack(s: Float64Array): void {
    const sc = this.o;
    sc.section = SECTIONS[s[P.section]] || 'intro'; sc.sectionStartMs = s[P.sectionStartMs]; sc.sectionIndex = s[P.sectionIndex]; sc.sectionTier = s[P.sectionTier]; sc.secBuildAt = s[P.secBuildAt]; sc.secBuildSeen = s[P.secBuildSeen];
    sc.repeatSim = s[P.repeatSim]; sc.repeatAgoMs = s[P.repeatAgoMs]; sc.repeatSection = SECTIONS[s[P.repeatSection]] || '';
    sc.expectHighMs = s[P.expectHighMs]; sc.expectSource = s[P.expectSource]; sc.prevSection = SECTIONS[s[P.prevSection]] || ''; sc.levelVsHighDb = s[P.levelVsHighDb];
  }

  /** Låtgränsen (hintTrackChange): SECTION_CARRY block bärs över, annars nollning. */
  carry(): void {
      const N = SECTION_CARRY;
      if (N > 0) {
        const keep = <T>(x: T[]) => x.slice(Math.max(0, x.length - N)); const H = this.secBlkH;
        const c = [keep(this.secBlkDb), keep(this.secBlkDens), keep(this.secBlkCentH), keep(this.secBlkHighH), keep(this.secBlkT), keep(this.secBlkFeat), keep(this.secBlkHi), keep(H.bon), keep(H.bpk), keep(H.high), keep(H.flat), keep(H.flux), keep(H.dyn)];
        const hd = this.lastHighDb === this.lastHighDb ? this.lastHighDb : this.secCarryHighDb;
        this.sectionReset(); this.secCarryHighDb = hd;
        const put = <T>(x: T[], v: T[]) => { x.length = 0; for (const e of v) x.push(e); };
        put(this.secBlkDb, c[0] as number[]); put(this.secBlkDens, c[1] as number[]); put(this.secBlkCentH, c[2] as number[]); put(this.secBlkHighH, c[3] as number[]); put(this.secBlkT, c[4] as number[]); put(this.secBlkFeat, c[5] as Float32Array[]); put(this.secBlkHi, c[6] as number[]);
        put(H.bon, c[7] as number[]); put(H.bpk, c[8] as number[]); put(H.high, c[9] as number[]); put(H.flat, c[10] as number[]); put(H.flux, c[11] as number[]); put(H.dyn, c[12] as number[]);
      } else this.sectionReset();
  }
}
