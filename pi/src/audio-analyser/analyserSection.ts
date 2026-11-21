/**  SEKTIONSFÖLJAREN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserSection.md */
import { Analyser, SECTION_AGG_HOP, SECTION_SCORE_F32 } from "./analyser.js";

const DOUBLE_FROM_START = ['secHiStartMs', 'secHiEndMs', 'secPct', 'secSongStartMs', 'secBlkMs', 'secBlkInt', 'secBlkCent', 'secBlkRms2', 'secCurDbSum'] as const;   // Talfält som ska vara flyttal från start

export class SectionTracker {
  a: Analyser;   // analysatorn som äger den här delen
  constructor(a: Analyser) {
    this.a = a;
    for (const k of DOUBLE_FROM_START) { const v = (this as unknown as Record<string, number>)[k]; if (typeof v === 'number') { (this as unknown as Record<string, number>)[k] = 0.5; (this as unknown as Record<string, number>)[k] = v; } }
  }
  private static readonly PREDICT_SRC = 2;   // Forutsagelsens kallor


  private static readonly PREDICT_LAT = 4;   // Frasregel
  private static readonly PREDICT_RISE = 4;

  private static readonly RANK_HI = 0.67;
  private static readonly RANK_LO = 0.33;
  private static readonly RANK_W_DENS = 0.5;
  private static readonly RANK_W_CENT = 0.5;
  private static readonly RANK_W_BASSON = 0;   // NYA SARDRAG I RANGPOANGEN
  private static readonly RANK_W_BASSENV = 0;
  private static readonly RANK_W_HIGH = 1.0;
  private static readonly RANK_W_FLAT = 0;
  private static readonly RANK_W_FLUX = 0;
  private static readonly RANK_W_DYN = 0;
  private secBlkBon = 0; private secBlkBpk = 0; private secBlkFlux = 0; private secBlkRms4 = 0;
  secBlkH: { bon: number[]; bpk: number[]; high: number[]; flat: number[]; flux: number[]; dyn: number[] } = { bon: [], bpk: [], high: [], flat: [], flux: [], dyn: [] };
  private static readonly RANK_HYST = 0.15;



  secBlkCentH: number[] = []; private secScoreBuf: Float64Array | Float32Array = SECTION_SCORE_F32 ? new Float32Array(600) : new Float64Array(600);   // ATERINTRADE
  secBlkHighH: number[] = [];


 private bndRef = new Float32Array(9);   // levelVsHighDb-referens
  private secBlkRms2 = 0;secBlkDb: number[] = [];secBlkDens: number[] = [];
  private secHiStartMs = 0;   // frasgittrets ankare
  private secLog: Array<{ label: string; startMs: number; endMs: number; db: number; dens: number }> = [];
  private secCurDbSum = 0; private secCurDbN = 0; private secCurDens = 0; lastHighDb = NaN;
  private static readonly SEC_EDGE_DB = 4;   // SNABBA KANTER
  secCarryHighDb = NaN; private secHiEndMs = 0; private secEdgeBuf = new Float64Array(16);
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
  secBlkT: number[] = []; secRank = { md: 0, sd: 1, mk: 0, sk: 1 }; private secScoreSorted = new Float64Array(601);   // 2026-10-17

  secBlkFeat: Float32Array[] = [];secBlkHi: number[] = []; private secPct = 0;   // KLANGMALL
  private repeatHighRun = 0; private secHighRunMs = 0;
  shIn = { hops: 0.5, intSum: 0.5, kicks: 0.5, breaking: false, nowMs: 0.5, dtMs: 0.5, rms2Sum: 0.5, centSum: 0.5, specOff: 0.5, bonSum: 0.5, bpk: 0.5, fluxSum: 0.5, rms4Sum: 0.5 };   // sectionHop:s summor
  secVDrops = 0;   // slow + stora vägen
  private static readonly SECTION_EARLY_S = 45;   // TIDIG REFRANG KRAVER NIVA


  /** SEKTION. */
  private secDropsNow(): number { return this.a.f.hop.role === 'slow' && this.a.f.hop.bigOn ? this.secVDrops : this.a.drop.dropCand + this.a.drop.secBodyRet; }
  sectionReset(): void {
    this.a.secBuildAt = 0; this.a.secBuildSeen = 0;
    this.a.section = 'intro'; this.a.sectionStartMs = 0; this.a.sectionIndex = 0; this.a.sectionTier = 1; this.a.repeatSim = 0; this.a.repeatAgoMs = 0; this.a.repeatSection = '';
    this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0);
    this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0; const H = this.secBlkH; H.bon.length = 0; H.bpk.length = 0; H.high.length = 0; H.flat.length = 0; H.flux.length = 0; H.dyn.length = 0;
    this.secTierRun = 0; this.secTierCand = 1; this.secRiseRun = 0; this.secSongStartMs = 0; this.secBlkRms2 = 0; this.secBlkDb.length = 0; this.secBlkDens.length = 0; this.secBlkCentH.length = 0; this.secDropSeen = this.secDropsNow(); this.secSilentBlocks = 0; this.secDropHoldUntil = 0;
    this.secHistN = 0; this.secHistPos = 0; this.secFpN = 0; this.secFpPos = 0; this.secFpLab.length = 0; this.secFpAcc.fill(0); this.secFpAccN = 0;
    this.secLog.length = 0; this.secCurDbSum = 0; this.secCurDbN = 0; this.secCurDens = 0; this.lastHighDb = NaN; this.secCarryHighDb = NaN; this.secHiEndMs = 0; this.a.expectHighMs = 0; this.a.expectSource = 0; this.a.prevSection = ''; this.a.levelVsHighDb = 0;

    this.secHiStartMs = 0; this.secPct = 0;
    this.secFp2N = 0; this.secFp2Pos = 0; this.secFp2Lab.length = 0; this.secFp2Acc.fill(0); this.secFp2AccN = 0; this.secFp2AccDb = 0; this.secFp2AccDens = 0;
    this.secBlkT.length = 0; this.secRank.md = 0; this.secRank.sd = 1; this.secRank.mk = 0; this.secRank.sk = 1; this.a.repeatTier = -1; this.a.repeatHighAtMs = 0; this.a.repeatHighEndAtMs = 0; this.repeatHighRun = 0; this.secHighRunMs = 0;
    this.secBlkFeat.length = 0; this.secBlkHi.length = 0; this.secPct = 0;

    this.secBlkHighH.length = 0; this.bndRef.fill(0); this.a.boundaryNov = 0;
  }

  /** Tar BLOCKSUMMOR. */
  sectionHop(spec: ArrayLike<number>): void {
    const I = this.shIn, hops = I.hops, intSum = I.intSum, kicks = I.kicks, breaking = I.breaking, nowMs = I.nowMs, dtMs = I.dtMs, rms2Sum = I.rms2Sum, centSum = I.centSum,
      specOff = I.specOff, bonSum = I.bonSum, bpk = I.bpk, fluxSum = I.fluxSum, rms4Sum = I.rms4Sum;
    if (this.secSongStartMs === 0) { this.secSongStartMs = nowMs; this.a.sectionStartMs = nowMs; this.secDropSeen = this.secDropsNow(); }
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
    if (this.a.activeMs === 0) { if (++this.secSilentBlocks >= 10) { this.sectionReset(); return; } }
    else this.secSilentBlocks = 0;
    let tier = bInt >= 0.62 ? 2 : bInt <= 0.40 ? 0 : 1;
    {
      const db = 10 * Math.log10(this.secBlkRms2 / n + 1e-10); this.secBlkDb.push(db); this.secBlkDens.push(bKicks); this.secBlkCentH.push(bCent); this.secBlkHighH.push(bHigh); if (Analyser.REPEAT & 1) this.secBlkT.push(nowMs);
      { const H = this.secBlkH; H.bon.push(bBon); H.bpk.push(bBpk); H.high.push(bHigh); H.flat.push(bFlat); H.flux.push(bFlux); H.dyn.push(bDyn); }
      if (this.secBlkDb.length > 600) { this.secBlkDb.shift(); this.secBlkDens.shift(); this.secBlkCentH.shift(); this.secBlkHighH.shift(); { const H = this.secBlkH; H.bon.shift(); H.bpk.shift(); H.high.shift(); H.flat.shift(); H.flux.shift(); H.dyn.shift(); } if (Analyser.REPEAT & 1) this.secBlkT.shift();  }
      const nb = this.secBlkDb.length;
      if (nb >= 20) {
        tier = this.rankTier(nb);
      } else { tier = 1; this.secPct = 0; }
    }
    if (tier === this.secTierCand) this.secTierRun++; else { this.secTierCand = tier; this.secTierRun = 1; }
    const runNeed = (Analyser.RANK_RUN_IN > 0 && this.secTierCand === 2 && this.a.sectionTier < 2) ? Analyser.RANK_RUN_IN : Analyser.RANK_RUN;
    if (this.secTierRun >= runNeed) this.a.sectionTier = this.secTierCand;
    let edgeUp = false, edgeDown = false, fallen = false;
    {
      const D = this.secBlkDb, nb = D.length, E = SectionTracker.SEC_EDGE_DB, ref = this.lastHighDb === this.lastHighDb ? this.lastHighDb : this.secCarryHighDb;
      fallen = nb >= 2 && blkDb <= this.lastHighDb - E && D[nb - 2] <= this.lastHighDb - E / 2;
      if (this.a.section === 'high') edgeDown = fallen;
      else if (blkDb >= ref - E) {
        const barMs = this.a.localBpm > 40 ? 240000 / this.a.localBpm : 4 * Analyser.BE_FALLBACK_MS;
        const m = Math.min(nb - 1, 4 * Math.max(2, Math.min(4, Math.round(barMs / 1000)))), w = this.secEdgeBuf;
        if (m >= 4) {
          for (let i = 0; i < m; i++) { const v = D[nb - 2 - i]; let k = i; while (k > 0 && w[k - 1] > v) { w[k] = w[k - 1]; k--; } w[k] = v; }
          edgeUp = blkDb - w[m >> 1] >= E;
        }
      }
      if (edgeUp || edgeDown) { this.a.sectionTier = edgeUp ? 2 : 0; this.secTierCand = this.a.sectionTier; this.secTierRun = 0; }
    }
    const st = this.a.sectionTier;
    this.secHist[this.secHistPos] = bInt; this.secHistPos = (this.secHistPos + 1) & 15; if (this.secHistN < 16) this.secHistN++;
    const rise = this.secHistN >= 9 ? bInt - this.secHist[(this.secHistPos - 9 + 16) & 15] : 0;
    this.secRiseRun = rise >= 0.10 ? this.secRiseRun + 1 : 0;
    const sinceStart = nowMs - this.secSongStartMs; const dropEv = this.secDropsNow(); const dropped = dropEv !== this.secDropSeen; this.secDropSeen = dropEv;
    const prev = this.a.section; let label: string;
    {
      if (this.secBlkDb.length < 20) label = edgeDown ? 'low' : edgeUp || (Analyser.BODY_HIGH_MS > 0 && (dropped || prev === 'high')) ? 'high' : 'intro';
      else if (dropped || st === 2) label = 'high';
      else if (st === 0) label = 'low';
      else label = prev === 'high' || prev === 'break' ? 'break' : (prev === 'low' || prev === 'intro' || prev === 'build') ? 'build' : prev;
      if (label === 'high' && !dropped && !edgeUp && prev !== 'high' && sinceStart < SectionTracker.SECTION_EARLY_S * 1000 && this.secBlkDb.length >= 4) {
        const D = this.secBlkDb, nb = D.length; const srt = D.slice().sort((a, b) => a - b); const med = srt[nb >> 1];
        const m4 = (D[nb - 1] + D[nb - 2] + D[nb - 3] + D[nb - 4]) / 4;
        if (m4 < med + Analyser.SECTION_EARLY_DB) label = prev === 'intro' || prev === 'low' || prev === 'build' ? 'build' : prev;
      }
      if ((Analyser.REPEAT & 64) && this.a.repeatSim >= SectionTracker.REPEAT_THR && this.a.repeatHighAtMs > 0 && st >= 1 && label !== 'high' && !dropped) {
        const d = this.a.repeatHighAtMs - nowMs; if (d >= -1500 && d <= 1000) label = 'high';
      }
      if ((Analyser.REPEAT & 48) && prev === 'high' && label === 'break' && st === 1) {
        {
          let hold = (Analyser.REPEAT & 16) ? Math.min(40000, this.secHighRunMs) : 0;
          if ((Analyser.REPEAT & 32) && this.a.localBpm > 0) hold = Math.max(hold, 8 * 240000 / this.a.localBpm);
          if (nowMs - this.a.sectionStartMs < hold) label = 'high';
        }
      }
      if (dropped && label === 'high') this.secDropHoldUntil = nowMs + (Analyser.RANK_WIN + Analyser.RANK_RUN) * 1000;
      else if (prev === 'high' && label !== 'high' && st >= 1 && nowMs < this.secDropHoldUntil) label = 'high';
    }
    if (label === 'high' && prev !== 'high' && !dropped && !edgeUp && fallen && nowMs - this.secHiEndMs < Analyser.BE_MEM_BEATS * (this.a.localBpm > 40 ? 60000 / this.a.localBpm : Analyser.BE_FALLBACK_MS)) {
      label = prev === 'break' ? 'break' : 'build'; this.a.sectionTier = 1;
    }
    const dwellMs = label === 'high' ? 4000 : 8000;
    const dwellOk = nowMs - this.a.sectionStartMs >= dwellMs || (prev === 'high' && label === 'break') || (Analyser.BODY_HIGH_MS > 0 && dropped && label === 'high') || edgeUp || edgeDown;
    if (label !== prev && dwellOk) {
      const dbMean = this.secCurDbN ? this.secCurDbSum / this.secCurDbN : blkDb;
      this.secLog.push({ label: prev, startMs: this.a.sectionStartMs, endMs: nowMs, db: dbMean, dens: this.secCurDbN ? this.secCurDens / this.secCurDbN : 0 });
      if (this.secLog.length > 48) this.secLog.shift();
      if (prev === 'high') { this.lastHighDb = dbMean; this.secHiEndMs = nowMs; }
      this.a.prevSection = prev; this.secCurDbSum = 0; this.secCurDbN = 0; this.secCurDens = 0;
      this.a.sectionStartMs = nowMs; if (label === 'high') { this.a.sectionIndex++; this.secHiStartMs = nowMs; } this.a.section = label;
    }
    if (prev === 'build' || this.a.section === 'build') { if (this.a.section === 'build' && (this.a.secBuildAt === 0 || nowMs - this.a.secBuildSeen > 2000)) this.a.secBuildAt = nowMs; this.a.secBuildSeen = nowMs; }
    this.secCurDbSum += blkDb; this.secCurDbN++; this.secCurDens += bKicks;
    if (this.a.secDump) { const row = [(nowMs - this.secSongStartMs) / 1000, blkDb, bKicks, bCent, bInt, breaking ? 1 : 0, dropped ? 1 : 0]; for (let i = 0; i < 8; i++) row.push(this.secBlkSpec[i] / n); row.push(st, ['intro', 'low', 'build', 'high', 'break'].indexOf(this.a.section)); this.a.secDump.push(row); }
    if (this.a.section === 'high') { this.lastHighDb = this.secCurDbSum / this.secCurDbN; }
    this.a.levelVsHighDb = Number.isFinite(this.lastHighDb) ? blkDb - this.lastHighDb : 0;
    this.predictHigh(nowMs, bInt);
    if (this.a.dbgSecBlock) this.a.dbgSecBlock({ nowMs, section: this.a.section, sectionStartMs: this.a.sectionStartMs, prev, label, bpm: this.a.localBpm, bInt, bKicks, bCent, blkDb, buildUp: this.a.buildUp, riseRun: this.secRiseRun, rise, dropped, breaking, tier: this.a.sectionTier, repeatSim: this.a.repeatSim, repeatAgoMs: this.a.repeatAgoMs, repeatSection: this.a.repeatSection, spec: Array.from(this.secBlkSpec, (v) => v / n), lastHighDb: this.lastHighDb, expectHighMs: this.a.expectHighMs, expectSource: this.a.expectSource, beatPhaseMs: this.a.beatPhaseMs, secLogN: this.secLog.length, secLogLast: this.secLog[this.secLog.length - 1] ?? null, bBon, bBpk, bFlux, bDyn, bHigh, bFlat, pct: this.secPct });
    if (Analyser.REPEAT & 1) { this.repeatStep(nowMs, blkDb, bKicks, bCent, bInt); this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0); this.secBlkRms2 = 0; this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0; return; }
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
      this.a.repeatSim = best; this.a.repeatAgoMs = best > 0 ? nowMs - bestAt : 0; this.a.repeatSection = bestLab;
      const o = this.secFpPos * D; for (let i = 0; i < D; i++) this.secFp[o + i] = acc[i];
      this.secFpT[this.secFpPos] = nowMs; this.secFpLab[this.secFpPos] = this.a.section;
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
    let win = 0; const W = Math.min(Analyser.RANK_WIN, nb); for (let i = nb - W; i < nb; i++) win += S[i]; win /= W;
    let below = 0, cnt = 0;
    { let acc = 0; for (let e = 1; e <= nb; e++) { acc += S[e - 1]; if (e > W) acc -= S[e - 1 - W]; if (e >= W) { cnt++; if (acc / W < win) below++; } } }
    const pct = below / cnt; const cur = this.a.sectionTier, h = SectionTracker.RANK_HYST; this.secPct = pct;
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
    this.secFp2T[pos] = nowMs; this.secFp2Db[pos] = this.secFp2AccDb / this.secFp2AccN; this.secFp2Dens[pos] = this.secFp2AccDens / this.secFp2AccN; this.secFp2Lab[pos] = this.a.section;
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
    const prevAt = this.a.repeatHighAtMs;
    this.a.repeatSim = best; this.a.repeatTier = -1; this.a.repeatHighAtMs = 0; this.a.repeatHighEndAtMs = 0;
    const nb = this.secBlkDb.length; if (nb < 20) { this.a.repeatAgoMs = 0; this.a.repeatSection = ''; return; }
    const R = this.secRank; const score = (db: number, dens: number) => (db - R.md) / R.sd + (dens - R.mk) / R.sk;
    const ss = this.secScoreSorted; for (let i = 0; i < nb; i++) ss[i] = score(this.secBlkDb[i], this.secBlkDens[i]); ss.subarray(0, nb).sort();
    const pct = (v: number) => { let lo = 0, hi = nb; while (lo < hi) { const mid = (lo + hi) >> 1; if (ss[mid] < v) lo = mid + 1; else hi = mid; } return lo / nb; };
    if (Analyser.REPEAT & 16) {
      let run = 0, gap = 0, bestRun = 0;
      for (let i = 0; i < nb; i++) {
        if (this.secBlkT[i] >= this.a.sectionStartMs) break;
        if (pct(score(this.secBlkDb[i], this.secBlkDens[i])) >= SectionTracker.RANK_HI) { run += 1 + gap; gap = 0; if (run > bestRun) bestRun = run; }
        else if (run > 0 && ++gap > 2) { run = 0; gap = 0; }
      }
      this.secHighRunMs = bestRun * 1000;
    }
    if (bestM < 0) { this.a.repeatAgoMs = 0; this.a.repeatSection = ''; return; }
    const kEnd = idx(bestM); const lagMs = nowMs - this.secFp2T[kEnd];
    this.a.repeatAgoMs = lagMs; this.a.repeatSection = this.secFp2Lab[kEnd];
    let ps = 0; for (let j = 0; j < W; j++) { const k = idx(bestM + j); ps += score(this.secFp2Db[k], this.secFp2Dens[k]); } ps /= W;
    const p = pct(ps); this.a.repeatTier = p >= SectionTracker.RANK_HI ? 2 : p <= SectionTracker.RANK_LO ? 0 : 1;
    const tEnd = this.secFp2T[kEnd]; let run = 0, at = 0, endAt = 0, lowRun = 0;
    for (let i = 0; i < nb; i++) {
      if (this.secBlkT[i] <= tEnd) continue;
      const hi = pct(score(this.secBlkDb[i], this.secBlkDens[i])) >= SectionTracker.RANK_HI;
      if (at === 0) { if (hi) { if (++run >= 2) at = this.secBlkT[i - 1] + lagMs; } else run = 0; }
      else if (!hi) { if (++lowRun >= 3) { endAt = this.secBlkT[i - 2] + lagMs; break; } } else lowRun = 0;
    }
    this.a.repeatHighEndAtMs = at > 0 ? endAt : 0;
    if (at > 0 && prevAt > nowMs && Math.abs(at - prevAt) <= 4000) { at = prevAt; this.repeatHighRun++; }
    else this.repeatHighRun = at > 0 ? 1 : 0;
    this.a.repeatHighAtMs = at;
  }

  /** FORUTSAGELSE av nasta 'high'. */
  private predictHigh(nowMs: number, bInt: number): void {
    const bpm = this.a.localBpm; const barMs = bpm > 0 ? 240000 / bpm : 0;
    let exp = 0, src = 0;
    if ((Analyser.REPEAT & 4) && this.a.section !== 'high' && this.a.repeatSim >= SectionTracker.REPEAT_THR && this.repeatHighRun >= 2 && this.a.repeatHighAtMs > nowMs + 500 && this.a.repeatHighAtMs - nowMs <= 32000) { exp = this.a.repeatHighAtMs; src = 4; }
    if (!exp && this.a.section !== 'high' && barMs > 0) {
      if (SectionTracker.PREDICT_SRC & 1) for (let i = this.secLog.length - 2; i >= 0; i--) {
        const a = this.secLog[i], b = this.secLog[i + 1];
        if (a.label !== this.a.section || b.label !== 'high') continue;
        const bars = Math.max(4, Math.round((a.endMs - a.startMs) / barMs / 4) * 4);
        const cand = this.a.sectionStartMs + bars * barMs;
        if (cand > nowMs + 500) { exp = cand; src = 1; }
        break;
      }
      const rising = this.secRiseRun >= SectionTracker.PREDICT_RISE;
      if (!exp && (SectionTracker.PREDICT_SRC & 2) && rising) {
        const anchor = this.secHiStartMs > 0 ? this.secHiStartMs : this.a.sectionStartMs;
        const L = SectionTracker.PREDICT_LAT * barMs;
        const elapsed = nowMs - anchor; const k = Math.ceil((elapsed + barMs) / L);
        const cand = anchor + k * L;
        if (cand - nowMs <= 16 * barMs) { exp = cand; src = 2; }
      }
    }
    if (exp === 0 && this.a.expectHighMs > 0 && this.a.section !== 'high' && this.a.expectHighMs > nowMs - 2000) { exp = this.a.expectHighMs; src = this.a.expectSource; }
    this.a.expectHighMs = exp; this.a.expectSource = src;
  }

  /** Roll 'all'. */
  sectionFlushAgg(): void {
    const g = this.a.secAgg; if (g.n === 0) return;
    { const I = this.shIn; I.hops = g.n; I.intSum = g.int; I.kicks = g.kicks; I.breaking = g.breaking > 0; I.nowMs = g.wall; I.dtMs = g.dt; I.rms2Sum = g.rms2; I.centSum = g.cent;
      I.specOff = 0; I.bonSum = g.bon; I.bpk = g.bpk; I.fluxSum = g.flux; I.rms4Sum = g.rms4; }
    this.sectionHop(g.spec);
    g.n = 0; g.int = 0; g.kicks = 0; g.breaking = 0; g.rms2 = 0; g.cent = 0; g.dt = 0; g.spec.fill(0); g.bon = 0; g.bpk = 0; g.flux = 0; g.rms4 = 0;
  }

  /** Sektionens blocksummor per hop. */
  sectionAggStep(): void {
    const intensity = this.a.hIntensity, kick = this.a.hKick, breaking = this.a.f.hop.breaking, rms = this.a.f.hop.rms, fluxNorm = this.a.f.hop.flux, nowWallA = this.a.f.hop.nowWall;
    const dtHop = this.a.f.hop.dtHop;
      if (this.a.f.hop.bigOn) return;
      if (SECTION_AGG_HOP) {
        const sp = this.a.secSpecHop;
        if (this.a.secSpecDirty) { this.a.secSpecDirty = false; for (let i = 0; i < 8; i++) sp[i] = Math.pow(10, this.a.bandDbRaw[i] / 20); }
        if (this.a.f.hop.role === 'fast') {
          const g = this.a.secAgg; g.n++; g.int += intensity; if (kick) g.kicks++; g.rms2 += rms * rms; g.cent += this.a.f.hop.centSmooth; g.dt += this.a.f.hop.dtHop * 1000;
          g.breaking = breaking ? 1 : 0; g.wall = this.a.wallNow(); g.drops = this.a.drop.dropCand + this.a.drop.secBodyRet; g.active = this.a.activeMs; g.build = this.a.buildUp;
          for (let i = 0; i < 8; i++) g.spec[i] += sp[i];
        } else { const I = this.shIn; I.hops = 1; I.intSum = intensity; I.kicks = kick ? 1 : 0; I.breaking = breaking; I.nowMs = this.a.wallNow(); I.dtMs = this.a.f.hop.dtHop * 1000;
          I.rms2Sum = rms * rms; I.centSum = this.a.f.hop.centSmooth; I.specOff = 0; I.bonSum = 0; I.bpk = 0; I.fluxSum = 0; I.rms4Sum = 0; this.sectionHop(sp); }
      } else {
        const g = this.a.secAgg; g.n++; g.int += intensity; if (kick) g.kicks++; if (breaking) g.breaking = 1; g.rms2 += rms * rms; g.cent += this.a.f.hop.centSmooth; g.dt += dtHop * 1000; g.wall = nowWallA;
        for (let i = 0; i < 8; i++) g.spec[i] += this.a.bandAbs[i];
        g.bon += this.a.bassOnRing[(this.a.bassOnN - 1 + Analyser.BASSON_LEN) % Analyser.BASSON_LEN]; if (this.a.bassOnPeak) { g.bpk++; this.a.bassOnPeak = false; } g.flux += fluxNorm; g.rms4 += rms * rms * rms * rms;
      }
  }
}
