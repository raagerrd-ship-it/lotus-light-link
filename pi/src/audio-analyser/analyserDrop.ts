/**  DROP-DETEKTORN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserDrop.md */
import { env, sysEnv, stabilise, BODY_CEIL_DB_S, BODY_HIGH_MS, BODY_HIGH_DB,
  type Ser, type DropOut } from "./analyserFack.js";
import { BS } from "./split.js";

const P = BS.drop;   // platserna i storblocket
const BODY_RISE_DB = Number(env('BODY_RISE_DB') ?? 17);   // DROP-DETEKTOR
const BODY_GONE_MIN_MS = Number(env('BODY_GONE_MIN_MS') ?? 2000);   // breakdown-langd som kravs
const DROP_QUALITY_DB = Number(env('DROP_QUALITY_DB') ?? 3.5);   // HARD KVALITETSGRIND vid fyrningen
const DROP_RISE_LOW_DB = Number(env('DROP_RISE_LOW_DB') ?? 0);   // DROP_RISE_MIN
const DROP_UNDERPEAK_MIN = Number(env('DROP_UNDERPEAK_MIN') ?? 0);   // LUGN-SEKTIONS-GRIND
const MINI_SPACING_MS = Number(env('MINI_SPACING_MS') ?? 0);   // KICK-LAS
const DROP_TRACE = !!sysEnv('DROP_TRACE');

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
const MINI_PEAK_DB = 10;
const MINI_TOPGONE_MS = 250;   // en minidrop per kick-lucka: flankens topp >= FLANK_GONE_DB under taket så länge
const HI_VETO_DB = 0;   // diskanten (band 6, 2 s) minst så här mot sitt 30 s-medel när flanken landar, annars minidrop
const DROP_SHORT_MS = 4000;   // minsta drop-avstand nar dropen ESKALERAR
const DROP_LONG_MS = 20000;   // annars maste sa har lang tid ga
const DROP_ESCALATE_DB = 3;   // tatare drops maste vara TYDLIGT starkare for att fyra
const FLANK_GONE_DB = 10, FLANK_BREAK_S = 4, FLANK_LAND_DB = 1.5, FLANK_RISE_DB = 12, FLANK_HOLD_S = 0.6, FLANK_GRACE_S = 1;   // FULL DROP PÅ FLANKEN
const FLANK_SHORT_S = 2, FLANK_SHORT_RISE_DB = 24, FLANK_SILENT_LV = 0.005;
const BUILD_SPACING_MS = 3000;   // UPPBYGGNADEN börjar när basen dras ur (kick-luckan), högst en gång per 3 s
const SHOW_DROP_GAP_MS = 12000;   // spärr mellan full drops
const NEAR_RISE_DB = 10, NEAR_DIP_DB = 8, LIFT_DB = 10, STOP_MINI_S = 0.6;   // LYFT/NÄSTAN-DROP/STOPP
const DOUBLE_FROM_START = ['bodyEnv', 'bodyFast', 'bodyCeil', 'bodyPeak', 'lastGoneSpanMs', 'lastMiniGoneMs', 'lastMiniMs', 'miniGoneMs', 'bodyGoneMs', 'lastBodyGoneMs', 'dropArmUntil', 'dropArmAt', 'fdGone', 'fdSpan', 'fdEnd', 'fdAt', 'fdQuietAt', 'lastShowDropMs', 'nearB', 'nearNorm', 'nearFloor', 'liftCalm', 'liftLift', 'liftHistAt', 'stopRunS', 'hiFast', 'hiNorm'] as const;   // Talfält som ska vara flyttal från start

/** DET DROP LÄSER (workern). Inget annat går att nå. */
export interface DropReads {
  hop:      Ser<'L', 'hop', 'dtHop' | 'nowWall' | 'body' | 'lvlSmooth' | 'sec' | 'lvh' | 'wallNow'>;
  spectrum: Ser<'L', 'spectrum', 'bandDbRaw'>;
  level:    Ser<'L', 'level', 'activeMs'>;
  riser:    Ser<'L', 'riser', 'buildUp'>;
}

export class DropDetector {
  private readonly h: DropReads['hop']; private readonly sp: DropReads['spectrum']; private readonly lv: DropReads['level']; private readonly ri: DropReads['riser'];
  constructor(r: DropReads, private readonly o: DropOut) {   // läser: r, lämnar ut: o
    this.h = r.hop; this.sp = r.spectrum; this.lv = r.level; this.ri = r.riser;
    stabilise(this, DOUBLE_FROM_START);
  }
  private secBodyArmMs = 0;
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
  private lastMiniMs = -1e9; private miniGoneMs = 0; private lastMiniGoneMs = -1e9; private wasMiniOnset = false;
  private dropArmUntil = 0; private dropArmAt = 0; private dropArmGoneMs = -1.5;   // armerat drop-fonster
  private calmHoldStart = -0; private calmHoldRise = -0;   // DROP_CALM_LAND_MS

  private goneEpisodeMs = -1.5;
  private fdGone = -0; private fdSpan = -0; private fdEnd = -1e12; private fdAbove = true; private fdAt = -1e12; private fdQuietAt = -1e12; private lastShowDropMs = -1e12;
  private fdT = new Float64Array(1024); private fdV = new Float64Array(1024); private fdS0 = 0; private fdN = 0;
  private nearOn = false; private nearB = -0; private nearNorm = -0; private nearFloor = 1e9; private liftCalm = -0; private liftLift = -0;
  private liftHist = new Float64Array(240); private liftW = 0; private liftN = 0; private liftHistAt = -1e12; private stopRunS = -0;
  private fdTop = -0; private miniEp = -1.5; private miniEpUsed = -2.5; private hiFast = -120.5; private hiNorm = -120.5;
  private lastEpAt = -1.5e12;

  /** Drop-detektionen. */
  dropStep(): void {
    const nowWallA = this.h.nowWall, bodyNow = this.h.body;
    const dtHop = this.h.dtHop;
    this.bodyEnv += (bodyNow - this.bodyEnv) * Math.min(1, dtHop / 0.35);
    this.bodyFast += (bodyNow - this.bodyFast) * Math.min(1, dtHop / BODY_FAST_S);
    const bodyPeek = this.bodyFast;
    this.bodyCeil = Math.max(this.bodyEnv, this.bodyCeil - dtHop * BODY_CEIL_DB_S);
    this.bodyPeak = Math.max(this.bodyEnv, this.bodyPeak - dtHop * 0.04);
    this.o.bodyUnderDb = this.bodyCeil - this.bodyEnv;
    { const x = this.sp.bandDbRaw[6]; if (this.hiNorm < -120) { this.hiFast = x; this.hiNorm = x; } this.hiFast += (x - this.hiFast) * Math.min(1, dtHop / 2); this.hiNorm += (this.hiFast - this.hiNorm) * Math.min(1, dtHop / 30); }
    const flank = this.flankStep(nowWallA, dtHop);
    this.liftStep(nowWallA, dtHop, bodyNow);

    if (this.bodyEnv < this.bodyCeil - BODY_GONE_DB) {
      this.bodyGoneMs += dtHop * 1000;
      if (this.bodyGoneMs >= BODY_GONE_MIN_MS) {
        if (this.bodyGoneMs - dtHop * 1000 < BODY_GONE_MIN_MS) this.goneEpisodeMs = nowWallA;
        this.lastBodyGoneMs = nowWallA;
      }
    } else {
      if (BODY_HIGH_MS > 0 && this.bodyGoneMs >= BODY_HIGH_MS) this.secBodyArmMs = nowWallA;
      if (this.bodyGoneMs > 0) this.lastGoneSpanMs = this.bodyGoneMs; this.bodyGoneMs = 0;
      if (this.secBodyArmMs > 0) { if (nowWallA - this.secBodyArmMs > 2000) this.secBodyArmMs = 0; else if (this.bodyEnv >= this.bodyPeak - BODY_HIGH_DB) { this.o.secBodyRet++; this.secBodyArmMs = 0; } }
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

    const sinceDrop = nowWallA - this.o.lastDropMs;
    const stronger = bodyRise > this.lastDropRise + DROP_ESCALATE_DB;
    const dropSpacingOk = sinceDrop > DROP_LONG_MS || (sinceDrop > DROP_SHORT_MS && stronger);

    const bodyOnsetEdge = bodyOnset && !this.wasBodyOnset;
    this.wasBodyOnset = bodyOnset;
    if (bodyOnsetEdge && this.goneEpisodeMs !== this.dropArmGoneMs) { this.dropArmUntil = nowWallA + DROP_ARM_MS; this.dropArmAt = nowWallA; this.dropArmGoneMs = this.goneEpisodeMs; }
    const armed = bodyOnsetEdge || nowWallA < this.dropArmUntil;
    if (MINI_SPACING_MS > 0) {
      if (this.fdTop < this.bodyCeil - FLANK_GONE_DB) { this.miniGoneMs += dtHop * 1000; if (this.miniGoneMs >= MINI_TOPGONE_MS) { if (this.miniGoneMs - dtHop * 1000 < MINI_TOPGONE_MS) { this.miniEp = nowWallA; if (nowWallA - this.lastEpAt >= BUILD_SPACING_MS) this.o.buildStartCount++; this.lastEpAt = nowWallA; } this.lastMiniGoneMs = nowWallA; } }
      else this.miniGoneMs = 0;
      const nv = hist[(this.bodyHistPos + HL - 1) % HL]; const mnRef = nv < riseRef ? nv : riseRef;
      const miniOnset = (bodyPeek - mnRef) > MINI_RISE_DB && bodyPeek > this.bodyPeak - MINI_PEAK_DB && nowWallA - this.lastMiniGoneMs < 4000;
      const miniEdge = miniOnset && !this.wasMiniOnset; this.wasMiniOnset = miniOnset;
      if (miniEdge && this.miniEp !== this.miniEpUsed && this.lv.activeMs > 2000 && nowWallA - this.o.lastDropMs > MINI_SPACING_MS && nowWallA - this.lastMiniMs > MINI_SPACING_MS
          && (DROP_UNDERPEAK_MIN <= 0 || this.bodyPeak - bodyPeek >= DROP_UNDERPEAK_MIN)) {
        this.o.miniDropCount++; this.lastMiniMs = nowWallA; this.miniEpUsed = this.miniEp;
        if (DROP_TRACE) console.log(`[minidrop] wall ${this.h.wallNow()} rise ${(bodyPeek - mnRef).toFixed(1)} underPeak ${(this.bodyPeak - bodyPeek).toFixed(1)} goneAgo ${((nowWallA - this.lastMiniGoneMs)/1000).toFixed(1)}s`);
      }
    }
    const fullSlam = this.bodyPeak - bodyPeek < DROP_QUALITY_DB;
    if (DROP_TRACE && bodyOnsetEdge && !(dropSpacingOk && fullSlam)) console.log(`[dropedge] rise ${bodyRise.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s spacingOk ${dropSpacingOk} sinceDrop ${(sinceDrop/1000).toFixed(1)}s`);
    const notAtCeil = DROP_UNDERPEAK_MIN <= 0 || this.bodyPeak - this.bodyFast >= DROP_UNDERPEAK_MIN;
    let fireNow = dropSpacingOk && armed && this.lv.activeMs > 2000 && fullSlam && notAtCeil;
    let fireTag = '';
    const underNow = this.bodyPeak - bodyPeek;
    if (fireNow) {
      const calm = (this.h.sec === 'low' || this.h.sec === 'intro') || this.h.lvh <= -DROP_CALM_DB;
      let strong = this.ri.buildUp >= DROP_CALM_BUILD || underNow < DROP_CALM_Q || bodyRise >= BODY_RISE_DB + DROP_CALM_RISE_DB;
      if (this.h.sec === 'intro') strong = this.ri.buildUp >= DROP_CALM_BUILD;
      if (calm && !strong) {
        fireNow = false;
        if (DROP_CALM_LAND_MS > 0 && this.calmHoldStart === 0) { this.calmHoldStart = nowWallA; this.calmHoldRise = bodyRise; }
        if (DROP_TRACE && bodyOnsetEdge) console.log(`[dropcalm] wall ${this.h.wallNow()} ${DROP_CALM_LAND_MS > 0 ? 'HALLS' : 'NEKAD'} sect ${this.h.sec} lvh ${this.h.lvh.toFixed(1)} build ${this.ri.buildUp.toFixed(2)} underPeak ${underNow.toFixed(1)} rise ${bodyRise.toFixed(1)}`);
      }
    }
    if (this.calmHoldStart > 0) {
      if (!fullSlam) { if (DROP_TRACE) console.log(`[dropcalm] wall ${this.h.wallNow()} SLAPPT efter ${(nowWallA - this.calmHoldStart).toFixed(0)} ms (underPeak ${underNow.toFixed(1)})`); this.calmHoldStart = 0; }
      else if (fireNow) this.calmHoldStart = 0;
      else if (nowWallA - this.calmHoldStart >= DROP_CALM_LAND_MS && dropSpacingOk) { fireNow = true; fireTag = ` CALMLAND +${(nowWallA - this.calmHoldStart).toFixed(0)}ms`; bodyRise = Math.max(bodyRise, this.calmHoldRise); this.calmHoldStart = 0; }
    }
    if (fireNow) {
      this.dropArmUntil = 0; this.calmHoldStart = 0;
      this.o.dropCand++; this.o.lastDropMs = nowWallA; this.lastDropRise = bodyRise;
      console.log(`[dropfire] wall ${this.h.wallNow()}${fireTag} rise ${bodyRise.toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} ceil ${this.bodyCeil.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} sinceDrop ${(sinceDrop/1000).toFixed(1)}s goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s goneSpan ${(this.lastGoneSpanMs/1000).toFixed(1)}s edgeAgo ${(nowWallA - this.dropArmAt).toFixed(0)}ms`);
    }
    this.dropClassify(flank, fireNow, nowWallA);
  }

  /** EN DROPDETEKTOR. */
  private dropClassify(flank: boolean, cand: boolean, nowWallA: number): void {
    if (flank) {
      if (this.hiFast - this.hiNorm < HI_VETO_DB) { this.o.dropDemoted++; this.o.miniDropCount++; }
      else if (nowWallA - this.lastShowDropMs < SHOW_DROP_GAP_MS) { this.o.dropSpaced++; this.o.miniDropCount++; }
      else { this.lastShowDropMs = nowWallA; this.o.dropCount++; }
    } else if (cand && nowWallA - this.fdAt > 2000) { this.o.dropDemoted++; this.o.miniDropCount++; }
  }

  /** FULL DROP PÅ FLANKEN. */
  private flankStep(now: number, dt: number): boolean {
    const CAP = 1024, T = this.fdT, V = this.fdV, f = this.bodyFast, ceil = this.bodyCeil;
    if (this.fdN === CAP) { this.fdS0 = (this.fdS0 + 1) & (CAP - 1); this.fdN--; }
    { const w = (this.fdS0 + this.fdN) & (CAP - 1); T[w] = now; V[w] = f; this.fdN++; }
    while (this.fdN > 1 && now - T[this.fdS0] > FLANK_HOLD_S * 1000) { this.fdS0 = (this.fdS0 + 1) & (CAP - 1); this.fdN--; }
    let top = -1e9, low = 1e9; for (let q = 0; q < this.fdN; q++) { const i = (this.fdS0 + q) & (CAP - 1); if (V[i] > top) top = V[i]; if (now - T[i] <= 500 && V[i] < low) low = V[i]; }
    this.fdTop = top;
    if (top < ceil - FLANK_GONE_DB) this.fdGone += dt; else { if (this.fdGone > 0) { this.fdSpan = this.fdGone; this.fdEnd = now; } this.fdGone = 0; }
    const above = f > ceil - FLANK_LAND_DB, edge = above && !this.fdAbove; this.fdAbove = above;
    const span = this.fdGone > 0 ? this.fdGone : now - this.fdEnd < FLANK_GRACE_S * 1000 ? this.fdSpan : 0;
    if (this.h.lvlSmooth <= FLANK_SILENT_LV) this.fdQuietAt = now;
    if (!edge || f - low < FLANK_RISE_DB || (span < FLANK_BREAK_S && !(span >= FLANK_SHORT_S && ceil - low >= FLANK_SHORT_RISE_DB))) return false;
    if (now - this.fdQuietAt < span * 1000 + 500) { this.fdGone = 0; this.fdSpan = 0; if (DROP_TRACE) console.log(`[flank] ingen drop: helt tyst i breaket (latstart), break ${span.toFixed(1)} s`); return false; }
    this.fdGone = 0; this.fdSpan = 0; this.fdAt = now; this.o.dropRiseDb = f - low;
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
    this.o.nearDropDb = near ? rise : 0; this.o.nearDipDb = near ? dip : 0;
    this.o.liftDb = this.liftN >= 240 && this.liftCalm > -80 && this.liftLift >= LIFT_DB ? this.liftLift : 0;
    if (this.nearB < this.nearNorm - 12) this.stopRunS += dt;
    else if (this.nearB >= this.nearNorm - 1) {
      if (this.stopRunS >= STOP_MINI_S && this.stopRunS <= 3) { this.o.stopCount++; this.o.stopS = this.stopRunS; }
      this.stopRunS = 0;
    }
  }

  /** Transporten: workern packar dropens UT-fält i storblocket (drainBig), huvudtråden packar upp (pushBig). */
  pack(s: Float64Array): void {
    const o = this.o;
    s[P.dropCount] = o.dropCount; s[P.miniDropCount] = o.miniDropCount; s[P.buildStartCount] = o.buildStartCount; s[P.dropCand] = o.dropCand; s[P.bodyUnderDb] = o.bodyUnderDb;
    s[P.dropDemoted] = o.dropDemoted; s[P.dropSpaced] = o.dropSpaced; s[P.dropRiseDb] = o.dropRiseDb; s[P.nearDropDb] = o.nearDropDb; s[P.nearDipDb] = o.nearDipDb; s[P.liftDb] = o.liftDb; s[P.stopCount] = o.stopCount; s[P.stopS] = o.stopS;
  }
  unpack(s: Float64Array): void {
    const o = this.o;
    o.dropCount = s[P.dropCount]; o.miniDropCount = s[P.miniDropCount]; o.buildStartCount = s[P.buildStartCount]; o.dropCand = s[P.dropCand]; o.bodyUnderDb = s[P.bodyUnderDb];
    o.dropDemoted = s[P.dropDemoted]; o.dropSpaced = s[P.dropSpaced]; o.dropRiseDb = s[P.dropRiseDb]; o.nearDropDb = s[P.nearDropDb]; o.nearDipDb = s[P.nearDipDb]; o.liftDb = s[P.liftDb]; o.stopCount = s[P.stopCount]; o.stopS = s[P.stopS];
  }
  /** Workern startar om: räknarna ur senaste storblocket (fem fält saknas som förut). */
  resume(s: Float64Array): void {
    const o = this.o;
    o.dropCount = s[P.dropCount]; o.miniDropCount = s[P.miniDropCount]; o.buildStartCount = s[P.buildStartCount]; o.dropCand = s[P.dropCand];
    o.dropDemoted = s[P.dropDemoted]; o.dropSpaced = s[P.dropSpaced]; o.stopCount = s[P.stopCount];
  }
}
