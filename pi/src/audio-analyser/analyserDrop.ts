/**  DROP-DETEKTORN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserDrop.md */
import { Analyser, BODY_CEIL_DB_S, BODY_GONE_MIN_MS, BODY_RISE_DB, DROP_QUALITY_DB, DROP_RISE_LOW_DB, DROP_TRACE, DROP_UNDERPEAK_MIN, MINI_SPACING_MS } from "./analyser.js";

const BODY_GONE_DB = 5;
const BODY_PEAK_DB = 10;   // BRED onset-grind
const DROP_ARM_MS = 300;   // ARMERAT FONSTER
const BODY_FAST_S = 0.06;   // FYR-LAGG
const DROP_RISE_LOW_Q = 3;
const DROP_CALM_DB = 6;   // STRIKT INTRO
const DROP_CALM_BUILD = 0.25;
const DROP_CALM_Q = 1.5;
const DROP_CALM_RISE_DB = 8;
const DROP_CALM_LAND_MS = 0;
const MINI_RISE_DB = 10;
const MINI_GONE_DB = 3;
const MINI_GONE_MS = 800;
const MINI_PEAK_DB = 10;
const DROP_SHORT_MS = 4000;   // minsta drop-avstand nar dropen ESKALERAR
const DROP_LONG_MS = 20000;   // annars maste sa har lang tid ga
const DROP_ESCALATE_DB = 3;   // tatare drops maste vara TYDLIGT starkare for att fyra
const FLANK_GONE_DB = 10, FLANK_BREAK_S = 4, FLANK_LAND_DB = 6, FLANK_RISE_DB = 12, FLANK_HOLD_S = 0.6, FLANK_GRACE_S = 1;   // FULL DROP PÅ FLANKEN
const FLANK_SHORT_S = 2, FLANK_SHORT_RISE_DB = 24, FLANK_SILENT_LV = 0.005;
const SHOW_DROP_GAP_MS = 12000;   // spärr mellan full drops
const NEAR_RISE_DB = 10, NEAR_DIP_DB = 8, LIFT_DB = 10, STOP_MINI_S = 0.6;   // LYFT/NÄSTAN-DROP/STOPP
const DOUBLE_FROM_START = ['bodyEnv', 'bodyFast', 'bodyCeil', 'bodyPeak', 'lastGoneSpanMs', 'lastDropMs', 'lastMiniGoneMs', 'lastMiniMs', 'miniGoneMs', 'bodyGoneMs', 'lastBodyGoneMs', 'dropArmUntil', 'dropArmAt', 'fdGone', 'fdSpan', 'fdEnd', 'fdAt', 'fdQuietAt', 'lastShowDropMs', 'dropRiseDb', 'nearB', 'nearNorm', 'nearFloor', 'liftCalm', 'liftLift', 'liftHistAt', 'stopRunS', 'nearDropDb', 'nearDipDb', 'liftDb', 'stopS'] as const;   // Talfält som ska vara flyttal från start

export class DropDetector {
  a: Analyser;   // analysatorn som äger den här delen
  constructor(a: Analyser) {
    this.a = a;
    for (const k of DOUBLE_FROM_START) { const v = (this as unknown as Record<string, number>)[k]; if (typeof v === 'number') { (this as unknown as Record<string, number>)[k] = 0.5; (this as unknown as Record<string, number>)[k] = v; } }
  }
  secBodyRet = 0; private secBodyArmMs = 0;
  private bodyEnv = -120;   // BASKROPPEN
  private bodyFast = -120;   // Snabb envelopp
  private bodyCeil = -300;
  private bodyPeak = -300;   // SEG topp
  private lastGoneSpanMs = 0;
  private lastDropRise = -0;   // 0 = HeapNumber
  private wasBodyOnset = false;
  private bodyHist = new Float32Array(200);   // ANSLAGSDETEKTION
  private bodyHistPos = 0;
  private bodyHistLen = 1;
  private bodyGoneMs = 0;   // Ihållande bas-FRÅNVARO
  private lastBodyGoneMs = -1e9;
  miniDropCount = 0; private lastMiniMs = -1e9; private miniGoneMs = 0; private lastMiniGoneMs = -1e9; private wasMiniOnset = false;
  private dropArmUntil = 0; private dropArmAt = 0; private dropArmGoneMs = -1.5;   // armerat drop-fonster
  private calmHoldStart = -0; private calmHoldRise = -0;   // DROP_CALM_LAND_MS

  private goneEpisodeMs = -1.5;
  dropCount = 0;   // monoton drop-räknare
  dropCand = 0;   // slam-kandidaterna
  dropDemoted = 0; dropSpaced = 0; dropRiseDb = -0;
  private fdGone = -0; private fdSpan = -0; private fdEnd = -1e12; private fdAbove = true; private fdAt = -1e12; private fdQuietAt = -1e12; private lastShowDropMs = -1e12;
  private fdT = new Float64Array(1024); private fdV = new Float64Array(1024); private fdS0 = 0; private fdN = 0;
  private nearOn = false; private nearB = -0; private nearNorm = -0; private nearFloor = 1e9; private liftCalm = -0; private liftLift = -0;
  private liftHist = new Float64Array(240); private liftW = 0; private liftN = 0; private liftHistAt = -1e12; private stopRunS = -0;
  nearDropDb = -0; nearDipDb = -0; liftDb = -0; stopCount = 0; stopS = -0;
  lastDropMs = -1.5e9;   // utanfor Smi-intervallet

  /** Drop-detektionen. */
  dropStep(): void {
    const nowWallA = this.a.hNowWall, bodyNow = this.a.hBody;
    const dtHop = this.a.dtHop;
    this.bodyEnv += (bodyNow - this.bodyEnv) * Math.min(1, dtHop / 0.35);
    this.bodyFast += (bodyNow - this.bodyFast) * Math.min(1, dtHop / BODY_FAST_S);
    const bodyPeek = this.bodyFast;
    this.bodyCeil = Math.max(this.bodyEnv, this.bodyCeil - dtHop * BODY_CEIL_DB_S);
    this.bodyPeak = Math.max(this.bodyEnv, this.bodyPeak - dtHop * 0.04);
    this.a.bodyUnderDb = this.bodyCeil - this.bodyEnv;
    const flank = this.flankStep(nowWallA, dtHop);
    this.liftStep(nowWallA, dtHop, bodyNow);

    if (this.bodyEnv < this.bodyCeil - BODY_GONE_DB) {
      this.bodyGoneMs += dtHop * 1000;
      if (this.bodyGoneMs >= BODY_GONE_MIN_MS) {
        if (this.bodyGoneMs - dtHop * 1000 < BODY_GONE_MIN_MS) this.goneEpisodeMs = nowWallA;
        this.lastBodyGoneMs = nowWallA;
      }
    } else {
      if (Analyser.BODY_HIGH_MS > 0 && this.bodyGoneMs >= Analyser.BODY_HIGH_MS) this.secBodyArmMs = nowWallA;
      if (this.bodyGoneMs > 0) this.lastGoneSpanMs = this.bodyGoneMs; this.bodyGoneMs = 0;
      if (this.secBodyArmMs > 0) { if (nowWallA - this.secBodyArmMs > 2000) this.secBodyArmMs = 0; else if (this.bodyEnv >= this.bodyPeak - Analyser.BODY_HIGH_DB) { this.secBodyRet++; this.secBodyArmMs = 0; } }
    }
    const hist = this.bodyHist, HL = hist.length;
    const oldest = hist[(this.bodyHistPos + HL - this.bodyHistLen) % HL];
    let riseRef = oldest;
    { const pos = this.bodyHistPos, len = this.bodyHistLen; let mn = oldest;
      const n1 = len < pos ? len : pos;
      for (let j = pos - n1; j < pos; j++) { const v = hist[j]; if (v < mn) mn = v; }
      for (let j = HL - (len - n1); j < HL; j++) { const v = hist[j]; if (v < mn) mn = v; }
      riseRef = mn; }
    let bodyRise = bodyPeek - riseRef;
    hist[this.bodyHistPos] = this.bodyFast;
    this.bodyHistPos = (this.bodyHistPos + 1) % HL;
    const want = Math.min(HL - 1, Math.max(1, Math.round(0.5 / dtHop)));
    if (this.bodyHistLen < want) this.bodyHistLen++;
    const landsHigh = bodyPeek > this.bodyPeak - BODY_PEAK_DB;
    const riseOk = bodyRise > BODY_RISE_DB || (DROP_RISE_LOW_DB > 0 && bodyRise > DROP_RISE_LOW_DB && this.bodyPeak - bodyPeek < DROP_RISE_LOW_Q);
    const bodyOnset = riseOk && landsHigh && nowWallA - this.lastBodyGoneMs < 6000;

    const sinceDrop = nowWallA - this.lastDropMs;
    const stronger = bodyRise > this.lastDropRise + DROP_ESCALATE_DB;
    const dropSpacingOk = sinceDrop > DROP_LONG_MS || (sinceDrop > DROP_SHORT_MS && stronger);

    const bodyOnsetEdge = bodyOnset && !this.wasBodyOnset;
    this.wasBodyOnset = bodyOnset;
    if (bodyOnsetEdge && this.goneEpisodeMs !== this.dropArmGoneMs) { this.dropArmUntil = nowWallA + DROP_ARM_MS; this.dropArmAt = nowWallA; this.dropArmGoneMs = this.goneEpisodeMs; }
    const armed = bodyOnsetEdge || nowWallA < this.dropArmUntil;
    if (MINI_SPACING_MS > 0) {
      if (this.bodyEnv < this.bodyCeil - MINI_GONE_DB) { this.miniGoneMs += dtHop * 1000; if (this.miniGoneMs >= MINI_GONE_MS) this.lastMiniGoneMs = nowWallA; }
      else this.miniGoneMs = 0;
      const nv = hist[(this.bodyHistPos + HL - 1) % HL]; const mnRef = nv < riseRef ? nv : riseRef;
      const miniOnset = (bodyPeek - mnRef) > MINI_RISE_DB && bodyPeek > this.bodyPeak - MINI_PEAK_DB && nowWallA - this.lastMiniGoneMs < 4000;
      const miniEdge = miniOnset && !this.wasMiniOnset; this.wasMiniOnset = miniOnset;
      if (miniEdge && this.a.activeMs > 2000 && nowWallA - this.lastDropMs > MINI_SPACING_MS && nowWallA - this.lastMiniMs > MINI_SPACING_MS
          && (DROP_UNDERPEAK_MIN <= 0 || this.bodyPeak - bodyPeek >= DROP_UNDERPEAK_MIN)) {
        this.miniDropCount++; this.lastMiniMs = nowWallA;
        if (DROP_TRACE) console.log(`[minidrop] wall ${this.a.wallNow()} rise ${(bodyPeek - mnRef).toFixed(1)} underPeak ${(this.bodyPeak - bodyPeek).toFixed(1)} goneAgo ${((nowWallA - this.lastMiniGoneMs)/1000).toFixed(1)}s`);
      }
    }
    const fullSlam = this.bodyPeak - bodyPeek < DROP_QUALITY_DB;
    if (DROP_TRACE && bodyOnsetEdge && !(dropSpacingOk && fullSlam)) console.log(`[dropedge] rise ${bodyRise.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s spacingOk ${dropSpacingOk} sinceDrop ${(sinceDrop/1000).toFixed(1)}s`);
    const notAtCeil = DROP_UNDERPEAK_MIN <= 0 || this.bodyPeak - this.bodyFast >= DROP_UNDERPEAK_MIN;
    let fireNow = dropSpacingOk && armed && this.a.activeMs > 2000 && fullSlam && notAtCeil;
    let fireTag = '';
    const underNow = this.bodyPeak - bodyPeek;
    if (fireNow) {
      const calm = (this.a.dSec === 'low' || this.a.dSec === 'intro') || this.a.dLvh <= -DROP_CALM_DB;
      let strong = this.a.buildUp >= DROP_CALM_BUILD || underNow < DROP_CALM_Q || bodyRise >= BODY_RISE_DB + DROP_CALM_RISE_DB;
      if (this.a.dSec === 'intro') strong = this.a.buildUp >= DROP_CALM_BUILD;
      if (calm && !strong) {
        fireNow = false;
        if (DROP_CALM_LAND_MS > 0 && this.calmHoldStart === 0) { this.calmHoldStart = nowWallA; this.calmHoldRise = bodyRise; }
        if (DROP_TRACE && bodyOnsetEdge) console.log(`[dropcalm] wall ${this.a.wallNow()} ${DROP_CALM_LAND_MS > 0 ? 'HALLS' : 'NEKAD'} sect ${this.a.dSec} lvh ${this.a.dLvh.toFixed(1)} build ${this.a.buildUp.toFixed(2)} underPeak ${underNow.toFixed(1)} rise ${bodyRise.toFixed(1)}`);
      }
    }
    if (this.calmHoldStart > 0) {
      if (!fullSlam) { if (DROP_TRACE) console.log(`[dropcalm] wall ${this.a.wallNow()} SLAPPT efter ${(nowWallA - this.calmHoldStart).toFixed(0)} ms (underPeak ${underNow.toFixed(1)})`); this.calmHoldStart = 0; }
      else if (fireNow) this.calmHoldStart = 0;
      else if (nowWallA - this.calmHoldStart >= DROP_CALM_LAND_MS && dropSpacingOk) { fireNow = true; fireTag = ` CALMLAND +${(nowWallA - this.calmHoldStart).toFixed(0)}ms`; bodyRise = Math.max(bodyRise, this.calmHoldRise); this.calmHoldStart = 0; }
    }
    if (fireNow) {
      this.dropArmUntil = 0; this.calmHoldStart = 0;
      this.dropCand++; this.lastDropMs = nowWallA; this.lastDropRise = bodyRise;
      console.log(`[dropfire] wall ${this.a.wallNow()}${fireTag} rise ${bodyRise.toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} ceil ${this.bodyCeil.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} sinceDrop ${(sinceDrop/1000).toFixed(1)}s goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s goneSpan ${(this.lastGoneSpanMs/1000).toFixed(1)}s edgeAgo ${(nowWallA - this.dropArmAt).toFixed(0)}ms`);
    }
    this.dropClassify(flank, fireNow, nowWallA);
  }

  /** EN DROPDETEKTOR. */
  private dropClassify(flank: boolean, cand: boolean, nowWallA: number): void {
    if (flank) {
      if (nowWallA - this.lastShowDropMs < SHOW_DROP_GAP_MS) { this.dropSpaced++; this.miniDropCount++; }
      else { this.lastShowDropMs = nowWallA; this.dropCount++; }
    } else if (cand && nowWallA - this.fdAt > 2000) { this.dropDemoted++; this.miniDropCount++; }
  }

  /** FULL DROP PÅ FLANKEN. */
  private flankStep(now: number, dt: number): boolean {
    const CAP = 1024, T = this.fdT, V = this.fdV, f = this.bodyFast, ceil = this.bodyCeil;
    if (this.fdN === CAP) { this.fdS0 = (this.fdS0 + 1) & (CAP - 1); this.fdN--; }
    { const w = (this.fdS0 + this.fdN) & (CAP - 1); T[w] = now; V[w] = f; this.fdN++; }
    while (this.fdN > 1 && now - T[this.fdS0] > FLANK_HOLD_S * 1000) { this.fdS0 = (this.fdS0 + 1) & (CAP - 1); this.fdN--; }
    let top = -1e9, low = 1e9; for (let q = 0; q < this.fdN; q++) { const i = (this.fdS0 + q) & (CAP - 1); if (V[i] > top) top = V[i]; if (now - T[i] <= 500 && V[i] < low) low = V[i]; }
    if (top < ceil - FLANK_GONE_DB) this.fdGone += dt; else { if (this.fdGone > 0) { this.fdSpan = this.fdGone; this.fdEnd = now; } this.fdGone = 0; }
    const above = f > ceil - FLANK_LAND_DB, edge = above && !this.fdAbove; this.fdAbove = above;
    const span = this.fdGone > 0 ? this.fdGone : now - this.fdEnd < FLANK_GRACE_S * 1000 ? this.fdSpan : 0;
    if (this.a.lvlSmooth <= FLANK_SILENT_LV) this.fdQuietAt = now;
    if (!edge || f - low < FLANK_RISE_DB || (span < FLANK_BREAK_S && !(span >= FLANK_SHORT_S && ceil - low >= FLANK_SHORT_RISE_DB))) return false;
    if (now - this.fdQuietAt < span * 1000 + 500) { this.fdGone = 0; this.fdSpan = 0; if (DROP_TRACE) console.log(`[flank] ingen drop: helt tyst i breaket (latstart), break ${span.toFixed(1)} s`); return false; }
    this.fdGone = 0; this.fdSpan = 0; this.fdAt = now; this.dropRiseDb = f - low;
    if (DROP_TRACE) console.log(`[flank] full drop pa flanken: break ${span.toFixed(1)} s, stigning ${(f - low).toFixed(1)} dB`);
    return true;
  }

  /** NÄSTAN-DROP, ENERGILYFT, STOPP. */
  private liftStep(now: number, dt: number, body: number): void {
    const x = Math.max(-90, body);
    if (!this.nearOn) { this.nearOn = true; this.nearB = x; this.nearNorm = x; }
    this.nearB += (x - this.nearB) * Math.min(1, dt / 0.12);
    this.nearNorm += (this.nearB - this.nearNorm) * Math.min(1, dt / 8);
    const h = this.liftHist;
    if (now - this.liftHistAt >= 25) {
      this.liftHistAt = now; h[this.liftW] = this.nearB; this.liftW = (this.liftW + 1) % 240; if (this.liftN < 240) this.liftN++;
      const n = this.liftN, o0 = this.liftW - n + 240;
      let fl = 1e9; for (let q = Math.max(0, n - 60), j = (o0 + q) % 240; q < n; q++) { const v = h[j]; if (v < fl) fl = v; if (++j === 240) j = 0; }
      this.nearFloor = fl;
      if (n >= 240) {
        let sum = 0; for (let q = 0, j = o0 % 240; q < 160; q++) { sum += h[j]; if (++j === 240) j = 0; }
        let now6 = 0; for (let q = n - 24, j = (o0 + q) % 240; q < n; q++) { now6 += h[j]; if (++j === 240) j = 0; }
        this.liftCalm = sum / 160; this.liftLift = now6 / 24 - this.liftCalm;
      }
    }
    const floor = this.nearFloor, rise = this.nearB - floor, dip = this.nearNorm - floor;
    const near = rise >= NEAR_RISE_DB && dip >= NEAR_DIP_DB && floor > -80 && this.nearB >= this.nearNorm - 1;
    this.nearDropDb = near ? rise : 0; this.nearDipDb = near ? dip : 0;
    this.liftDb = this.liftN >= 240 && this.liftCalm > -80 && this.liftLift >= LIFT_DB ? this.liftLift : 0;
    if (this.nearB < this.nearNorm - 12) this.stopRunS += dt;
    else if (this.nearB >= this.nearNorm - 1) {
      if (this.stopRunS >= STOP_MINI_S && this.stopRunS <= 3) { this.stopCount++; this.stopS = this.stopRunS; }
      this.stopRunS = 0;
    }
  }
}
