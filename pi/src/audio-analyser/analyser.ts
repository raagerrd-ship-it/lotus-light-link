/** ENAD ANALYSATOR (2026-09-24) — en fil, samma byte i lotus-light-link (pi/src/audio-analyser/) och dmx-control (pi-dmx/engine/src/). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyser.md */

import { sysEnv, stabilise, makeFack, off, stenarAv, type Fack, BODY_CEIL_DB_S, BE_FALLBACK_MS, BASS_SPAN_DB, BIG_EVERY,
  type BeatGrid, type AnalyserDetection, type Cfg, type Role } from './analyserFack.js';
export { BASS_SPAN_DB, BODY_CEIL_DB_S };
export type { BeatGrid, AnalyserDetection, Cfg, Role };
import {
  REC_LEN, RING_N, R_SEQ, R_PERF, R_WALL, R_FLAGS, R_HINT_MS, R_VCLOCK, R_TS, R_FLAGCNT, RING_MARGIN, FLAG_BITS, B, BS, S, R,
  packFlagCounts, lostFlags, seqLow, seqDelta, C_WAITING, C_STATE_SEQ, S_LOST_FLAGS,
  F_SIL350, F_SIL10, F_RESET_TEMPO, F_HINT, F_RESET_BAR, F_VCLOCK_SET, F_VCLOCK_NULL,
  C_WRITE, C_READ, S_REC_SEQ, S_BPM, S_CONF, S_PROCESSED, S_LAG_MS, S_LAG_MAX, S_BUSY_US, S_BUSY_MAX_US, S_SKIPPED, STATE_LEN,
  SECTIONS, sectionCode, viewsOf, stateWrite, stateRead, createSplitBuffers, type SplitBuffers, type WorkerData,
  C_WAKE, syncWait, HopLaneFast, HopLaneSlow, StateReader, type HopFeed,
  R_BIGSEQ, BIG_REC_LEN, BIG_RING_N, BIG_HOP_MAX, B_SEQ, B_N,
  B_ENVF, C_WAITING_B, C_BIG_WRITE, C_BIG_READ, C_BIG_SEQ, BS_SEQ,
  BS_SPEC_N, BS_SKIPPED, BIG_STATE_LEN, SPEC_SLOTS, SPEC_MAX,
} from './split.js';
const Bh = B.hop, Bf = B.fft, Bl = B.level, Bk = B.kick, Rc = R.clock, BSs = BS.spectrum, Sc = S.clock;   // kärnans platser ur taggarna
import FFT from "fft.js";
import { BeatFeed, publishPhase, type ClockCfg } from "./analyserClock.js";   // ANALYSATORNS KLOCKA
import { DropDetector } from "./analyserDrop.js";
import { SectionTracker } from "./analyserSection.js";
import { RiserDetector } from "./analyserRiser.js";
import { CharacterProfile } from "./analyserCharacter.js";
import { KickDetector } from "./analyserKick.js";
import { BassTracker } from "./analyserBass.js";
import { LevelTracker } from "./analyserLevel.js";
import { SpectrumBands } from "./analyserSpectrum.js";
import { SmallFft, hannWindow } from "./analyserFft.js";

/** Sann om ratten ar satt till nagot icke-tomt. */
function sysOn(name: string): boolean { return !!sysEnv(name); }
const BPM_TRACE = sysOn('BPM_TRACE');

export interface AnalyserConfig {
  sampleRate?: number;   // Platt form
  hopSize?: number;
  fftSize?: number;   // Small-FFT size
  autoGainTarget?: number;
  tauUp?: number;
  tauDown?: number;
  noiseFloor?: number;
  silenceLevel?: number;   // Släckgränsen på frame.level
  maxGain?: number;   // Upper clamp for analyser gain
  onsetEnhancements?: boolean;   // Enable log-compressed, adaptively whitened and normalized onset features
  audio?: { rate: number };   // Nastlad form
  fft?: { size: number; hop: number };
  detection?: AnalyserDetection;
  beat?: BeatGrid | null;
  role?: Role;   // DELAD ANALYSATOR
  split?: SplitBuffers;
  resumeSeq?: number;   // Seq att fortsatta fran
}

/** DELAD ANALYSATOR. */
export interface SplitInit {
  role: Role;
  split?: SplitBuffers;
  resumeSeq?: number;
  sync?: boolean;   // Bänkens synk-läge
}

/** Rikt log-spektrum. */
export interface Spectrum {
  sub: number;
  kick: number;
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  treble: number;
  air: number;
}

export const SILENCE_LEVEL = 0.05;   // Släckgränsens standard
let silenceLevelLive = SILENCE_LEVEL;
/** Samma tystnadsbeslut som frame.silent för den som bara har nivån. */
export function silentLevel(level: number): boolean { return level <= silenceLevelLive; }

export interface Frame {
  silent: boolean;   // TYSTNAD
  level: number;   // 0..1, auto-gained RMS
  levelVU: number;   // 0..1, ~200ms symmetriskt smoothat PÅ HOP-TAKT
  energy: number;   // 0..1, bass-band spectral energy

  centroid: number;   // mid/treble på 512-FFT:n är BORTA
  flux: number;   // 0..1, bass-band spectral flux
  kick: boolean;   // true on rising edge only
  gain: number;   // current auto-gain factor
  bpm: number;   // 0 = ej låst
  bpmConfidence: number;   // 0..1, hur tydlig vinnande takttoppen är
  intensity: number;   // 0..1 SEKTIONSENERGI relativt låtens eget snitt
  dropCount: number;   // DROP-DETEKTION
  miniDropCount: number;   // MINIDROP
  dropBuildCount: number;   // UPPBYGGNAD: stiger när en uppbyggnad börjar (basen dras ur, högst var 3:e s)
  dropDemoted: number; dropSpaced: number;   // EN DROPDETEKTOR
  nearDropDb: number; nearDipDb: number; liftDb: number; stopCount: number; stopS: number; dropMiniBack: number; dropKeys: number; dropNear: number;   // LYFT/NÄSTAN-DROP/STOPP; dropMiniBack: minidropens baskropp föll tillbaka
  levelInZone: boolean;   // nivån är i låtens topp-zon
  levelBreaking: boolean;   // nivån är i en svacka/break
  buildUp: number;   // UPPBYGGNAD
  sectionBuildProg: number;   // UPPBYGGNADENS FÖRLOPP 0..1
  inRiser: boolean;
  profile: { punch: number; bass: number; bright: number; beat: number; bassline: number };   // KARAKTÄRSPROFIL
  kickAnchorMs: number;   // wall-clock ms för ett taktslag
  kickAtMs: number;
  barShift: number;   // TAKTFAS
  beatPhaseMs: number;   // GRIDFAS
  beatPhaseConf: number;   // Gridfasens on/half-kvot
  beatTrust: number;   // TILLITEN TILL TAKTEN 0..1
  section: string;   // SEKTION
  sectionAgeMs: number;   // ms sedan sektionen borjade
  sectionIndex: number;   // antal 'high'-partier hittills i laten
  sectionTier: number;   // 0 lag / 1 mellan / 2 hog
  repeatSim: number; repeatAgoMs: number;   // UPPREPNING
  expectHighInMs: number; prevSection: string; sectionLevelVsHighDb: number; sectionBars: number;   // SEKTIONSMINNE + FORUTSAGELSE
  spec: Spectrum;   // Rikt spektrum + per-band onset
  specAbs: Spectrum;   // Absolut per-band magnitud före AGC, för Lotus ljusväg och bandandelar
  bodyDb: number;   // BASKROPPEN I RA dB
  bassEnergy: number; bassEnergyShort: number; bassLevel: number;   // BASENERGIN 0..1
  midHiDb: number;   // ABSOLUT mid+diskant-niva i dB
  onset: Spectrum;   // per-band ONSET/anslag
  drum: { kick: number; snare: number; hat: number; bass: number };   // TRUM-KIT-envelopes
  stenarAv: number;   // en bit per avstängd sten (analyserFack.ts stenarAv)
}

const DOUBLE_FROM_START = [
  'lastT', 'tickT',
  'lvlVU',
] as const;   // Instansfalt som MATT
/** TYPSTABILA TALFALT. */
function stabiliseNumbers(o: object): void {
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) { const v = r[k]; if (typeof v === 'number') { r[k] = 0.5; r[k] = v; } }
}

export class Analyser {
  readonly f: Fack = makeFack(() => this.wallNow());   // FACKEN
  get role(): Role { return this.f.hop.role; }   get bigOn(): boolean { return this.f.hop.bigOn; }   get cfg(): Cfg { return this.f.hop.cfg; }
  get bandOn(): Float32Array { return this.f.spectrum.bandOn; }   get beatSrc(): { beat?: BeatGrid | null } { return this.f.clock.src; }   // verktygen
  get bodyUnderDb(): number { return this.f.drop.bodyUnderDb; }   get bassOnsetsPerBeat(): number { return this.f.bass.onsetsPerBeat; }   // klockan (HopTarget), verktygen
  get boundaryNov(): number { return this.f.section.boundaryNov; }   // boundaryBench.mjs
  private outSpecAbs: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outSpec: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outOnset: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outDrum = { kick: 0, snare: 0, hat: 0, bass: 0 };   // trum-envelopes
  private outFrame!: Frame;   // ETT återanvänt Frame
  private static readonly BAND_HZ = [20, 60, 120, 250, 500, 1200, 3500, 10000, 16000];
  static readonly BE_FALLBACK_MS = BE_FALLBACK_MS;

  static readonly BIG_EVERY = BIG_EVERY;
  private static readonly FB_TAU_MS = [12, 6, 3];
  setSpectrumSink(fn: ((mag: Float32Array, binHz: number) => void) | null): void { this.f.spectrum.sink = fn; }
  private static readonly ENV_HZ = 100;


  private static readonly GRID_PHASE_OFFSET_MS = Number(sysEnv('GRID_PHASE_OFFSET_MS')) || 0;   // Fasval

  private tickT = 0;   // 100 Hz-steget
  private splitCtrl: Int32Array | null = null; private splitRing: Float64Array | null = null; private splitState: Float64Array | null = null;
  private stateCopy = new Float64Array(STATE_LEN); private stateRd = new StateReader();   // a7: kopian bara när blocket ändrats
  private recSeq = 0;   // fast: senast skrivna record
  private barrierSeq = 0;   // fast: tillstand aldre an detta record ignoreras
  private pendFlags = 0; private pendHintMs = 0; private pendVclock = 0;
  private flagCnt = new Int32Array(FLAG_BITS);   // fast: antal ganger varje flagga rests
  private slowLastCnt = -1;   // slow: R_FLAGCNT i senast behandlade record
  private slowGap = false;   // slow: records tappade sedan senast behandlade
  private slowLostFlags = 0;   // slow: antal flaggor som aterskapats ur raknarna efter tapp
  splitRestarts = 0;   // fast: antal omstarter av workern
  hopLane: HopLaneFast | null = null;   // TAKTVÄGEN
  hopSelf = false;   // EN KLOCKA
  private syncWorker = false;   // fast: vänta på workern efter varje record
  private inlinePeer: Analyser | null = null;
  private bigRing: Float64Array | null = null; private bigPcm: Float32Array | null = null; private bigState: Float64Array | null = null;   private bigSeq = 0; private bigCopy = new Float64Array(BIG_STATE_LEN); private bigRd = new StateReader();  private specDelivered = 0;  private bigSkipped = 0;
  private bigEnvFlag = 0;
  bigYield: (() => void) | null = null;   // PI:NS VERKLIGHET
  private slowBusyEmaUs = 0; private slowBusyMaxUs = 0; private slowLagMaxMs = 0; private slowSkipped = 0; private slowProcessed = 0;

  private aVU = 0;
  private dKick = 0;
  private silenceLevel = SILENCE_LEVEL;
  /** Släckgränsen live. */
  setSilenceLevel(v: number | undefined): void { this.silenceLevel = silenceLevelLive = v ?? SILENCE_LEVEL; }
  private lvlVU = 0;



  /** Called when the input routing changes. */
  resetGain(startGain = 1) {
    this.f.level.gain = Math.max(0.5, Math.min(20, startGain));
    this.f.level.envelope = this.f.hop.cfg.detection.autoGainTarget;
    this.levels.resetAgcBlocks();
  }

  /** Lock the AGC. */
  setGainLock(locked: boolean, fixed = 1) {
    this.f.level.gainLocked = locked;
    if (locked) { this.f.level.gain = fixed; this.f.level.envelope = this.f.hop.cfg.detection.autoGainTarget; this.levels.resetAgcBlocks(); }
  }

  /** DELAD ANALYSATOR. */
  flagSlow(f: number): void {
    if (this.f.hop.role !== 'fast') return;
    this.pendFlags |= f; this.barrierSeq = this.recSeq + 1;
    for (let k = 0; k < FLAG_BITS; k++) if (f & (1 << k)) this.flagCnt[k]++;
  }
  /** Ett record per 100 Hz-steg. */
  private pushSlowRecord(): void {
    const r = this.splitRing!, ctrl = this.splitCtrl!;
    const seq = ++this.recSeq; const o = (seq % RING_N) * REC_LEN;
    r[o + R_PERF] = this.perfNow(); r[o + R_WALL] = this.wallNow(); r[o + R_TS] = Date.now();
    r[o + R_FLAGS] = this.pendFlags; r[o + R_HINT_MS] = this.pendHintMs; r[o + R_VCLOCK] = this.pendVclock;
    r[o + R_FLAGCNT] = packFlagCounts(this.flagCnt);
    r[o + Rc.bpm] = this.f.clock.bpm; r[o + Rc.conf] = this.f.clock.conf;
    r[o + R_BIGSEQ] = this.bigSeq;
    r[o + R_SEQ] = seq;
    this.pendFlags = 0;
    Atomics.store(ctrl, C_WRITE, seqLow(seq));
    Atomics.add(ctrl, C_WAKE, 1);
    if ((this.syncWorker || !this.hopLane) && (Atomics.load(ctrl, C_WAITING) || Atomics.load(ctrl, C_WAITING_B))) Atomics.notify(ctrl, C_WAKE);
    if (this.inlinePeer) { this.inlinePeer.drainRecords(); this.pullSlowState(); }
    else if (this.syncWorker) { syncWait(ctrl, C_STATE_SEQ, () => this.stateRd.read(ctrl, this.splitState!, this.stateCopy) && this.stateCopy[S_REC_SEQ] >= seq); this.pullSlowState(); }
  }
  /** Hamta tempo/gridfas/sektion ur tillstandsblocket. */
  private pullSlowState(): void {
    if (!this.stateRd.read(this.splitCtrl!, this.splitState!, this.stateCopy)) return;
    const s = this.stateCopy; if (s[S_REC_SEQ] < this.barrierSeq) return;
    this.sections?.unpack(s);
  }
  setInlinePeer(slow: Analyser | null): void { this.inlinePeer = slow; }
  /** Halsa for /api/live. */
  getSplitStats(): { role: string; written: number; processed: number; behind: number; lagMs: number; lagMaxMs: number; busyUs: number; busyMaxUs: number; skipped: number; lostFlags: number; restarts: number } | null {
    if (this.f.hop.role !== 'fast') return null;
    const s = this.stateCopy;
    return { role: this.f.hop.role, written: this.recSeq, processed: s[S_PROCESSED], behind: this.recSeq - s[S_REC_SEQ], lagMs: +s[S_LAG_MS].toFixed(1), lagMaxMs: +s[S_LAG_MAX].toFixed(1),
      busyUs: Math.round(s[S_BUSY_US]), busyMaxUs: Math.round(s[S_BUSY_MAX_US]), skipped: s[S_SKIPPED], lostFlags: s[S_LOST_FLAGS], restarts: this.splitRestarts };
  }
  /** fast: senast skrivna record. */
  fastWriteSeq(): number { return this.recSeq; }
  fastReadSeq(): number { const d = seqDelta(Atomics.load(this.splitCtrl!, C_READ), this.recSeq); return d > 0 ? this.recSeq : this.recSeq + d; }

  /** DELAD ANALYSATOR. */
  slowReadSeq(): number { return this.recSeq; }
  /** Behandla alla records som skrivits sedan sist, publicera tillstandet. */
  drainRecords(): number {
    const ctrl = this.splitCtrl!, r = this.splitRing!;
    const w = this.recSeq + seqDelta(Atomics.load(ctrl, C_WRITE), this.recSeq); let n = 0;
    if (w - this.recSeq > RING_N - RING_MARGIN) { this.slowSkipped += (w - this.recSeq) - (RING_N - RING_MARGIN); this.recSeq = w - (RING_N - RING_MARGIN); this.slowGap = true; }
    let lagMs = 0;
    while (this.recSeq < w) {
      const seq = ++this.recSeq; const o = (seq % RING_N) * REC_LEN;
      if (r[o + R_SEQ] !== seq) { this.slowSkipped++; this.slowGap = true; continue; }
      const t0 = performance.now();
      if (this.slowGap) {
        if (this.slowLastCnt >= 0) {
          const lost = lostFlags(this.slowLastCnt, r[o + R_FLAGCNT], r[o + R_FLAGS]);
          if (lost) { this.slowLostFlags++; this.applyFlags(lost, 5000, r[o + R_PERF]); }
        }
        this.slowGap = false;
      }
      this.drainBig(r[o + R_BIGSEQ]);
      this.slowStep(o); this.slowLastCnt = r[o + R_FLAGCNT];
      if (this.bigYield) this.bigYield();
      const us = (performance.now() - t0) * 1000;
      this.slowBusyEmaUs = this.slowBusyEmaUs === 0 ? us : this.slowBusyEmaUs + 0.02 * (us - this.slowBusyEmaUs);
      if (us > this.slowBusyMaxUs) this.slowBusyMaxUs = us;
      lagMs = Date.now() - r[o + R_TS]; if (lagMs > this.slowLagMaxMs) this.slowLagMaxMs = lagMs;
      n++;
    }
    if (n > 0) {
      this.slowProcessed += n;
      Atomics.store(ctrl, C_READ, seqLow(this.recSeq));
      stateWrite(ctrl, this.splitState!, (s) => {
        s[S_REC_SEQ] = this.recSeq; s[S_BPM] = this.f.clock.bpm; s[S_CONF] = this.f.clock.conf;
        this.sections?.pack(s);
        s[S_PROCESSED] = this.slowProcessed; s[S_LAG_MS] = lagMs; s[S_LAG_MAX] = this.slowLagMaxMs; s[S_BUSY_US] = this.slowBusyEmaUs; s[S_BUSY_MAX_US] = this.slowBusyMaxUs; s[S_SKIPPED] = this.slowSkipped; s[S_LOST_FLAGS] = this.slowLostFlags;
      });
      if (this.syncWorker) Atomics.notify(ctrl, C_STATE_SEQ);
    }
    this.drainBig(Infinity);
    return n;
  }

  /** STORA VÄGEN. */
  private pushBig(samples: Float32Array): void {
    const h = this.f.hop;
    const lv = this.f.level, sp = this.f.spectrum, kk = this.f.kick, ff = this.f.fft;
    const r = this.bigRing!, ctrl = this.splitCtrl!, seq = ++this.bigSeq, slot = seq % BIG_RING_N, o = slot * BIG_REC_LEN, n = samples.length;
    this.bigPcm!.set(samples, slot * BIG_HOP_MAX);
    r[o + B_N] = n; r[o + Bf.rms] = ff.rms; r[o + Bh.nowWall] = h.nowWall; r[o + Bf.centSmooth] = ff.centSmooth; r[o + Bh.breaking] = h.breaking ? 1 : 0;
    r[o + Bh.kickHit] = h.kickHit; r[o + Bh.sec] = sectionCode(h.sec); r[o + Bh.lvh] = h.lvh; r[o + Bh.conf] = h.conf; r[o + Bh.bpm] = h.bpm;
    r[o + Bh.gridMs] = h.gridMs; r[o + Bh.trust] = h.trust; r[o + Bh.barKnown] = h.barKnown ? 1 : 0;
    r[o + Bl.lvlSmooth] = lv.lvlSmooth; r[o + Bl.activeMs] = lv.activeMs; r[o + Bl.intensity] = lv.intensity; r[o + Bl.levelCeil] = lv.levelCeil; r[o + Bk.kick] = kk.kick ? 1 : 0;
    r[o + B_ENVF] = this.bigEnvFlag; this.bigEnvFlag = 0;
    r[o + B_SEQ] = seq;
    Atomics.store(ctrl, C_BIG_WRITE, seqLow(seq)); Atomics.add(ctrl, C_WAKE, 1);
    if ((this.syncWorker || !this.hopLane) && (Atomics.load(ctrl, C_WAITING) || Atomics.load(ctrl, C_WAITING_B))) Atomics.notify(ctrl, C_WAKE);
    if (this.inlinePeer) this.inlinePeer.drainBig(Infinity);
    else if (this.syncWorker) syncWait(ctrl, C_BIG_SEQ, () => this.bigRd.read(ctrl, this.bigState!, this.bigCopy, C_BIG_SEQ) && this.bigCopy[BS_SEQ] >= seq);
    const s = this.bigCopy;
    if (!this.bigRd.read(ctrl, this.bigState!, s, C_BIG_SEQ) || s[BS_SEQ] === 0) return;
    sp.bodyDb = s[BSs.bodyDb]; this.drop?.unpack(s); this.riser?.unpack(s); this.character?.unpack(s);
    const sn = s[BS_SPEC_N];
    if (sn > this.specDelivered) {
      const sink = sp.sink, binHz = h.cfg.audio.rate / this.bands.bufferBig.length, R = this.bands.specRing!, c = this.bands.specCopy;
      for (let k = Math.max(this.specDelivered + 1, sn - SPEC_SLOTS + 1); k <= sn; k++) {
        if (sink) { const o2 = (k % SPEC_SLOTS) * SPEC_MAX; c.set(R.subarray(o2, o2 + c.length)); sink(c, binHz); }
      }
      this.specDelivered = sn;
    }
  }

  /** slow: behandla hop-recorden t.o.m. */
  drainBig(limit: number): number {
    const h = this.f.hop;
    const lv = this.f.level, kk = this.f.kick, ff = this.f.fft;
    const ctrl = this.splitCtrl!, r = this.bigRing!, pcm = this.bigPcm!;
    let w = this.bigSeq + seqDelta(Atomics.load(ctrl, C_BIG_WRITE), this.bigSeq); if (limit < w) w = limit;
    if (w - this.bigSeq > BIG_RING_N - RING_MARGIN) { this.bigSkipped += (w - this.bigSeq) - (BIG_RING_N - RING_MARGIN); this.bigSeq = w - (BIG_RING_N - RING_MARGIN); }
    let n = 0;
    while (this.bigSeq < w) {
      const seq = ++this.bigSeq, slot = seq % BIG_RING_N, o = slot * BIG_REC_LEN;
      if (r[o + B_SEQ] !== seq) { this.bigSkipped++; continue; }
      const hn = r[o + B_N];
      this.bass?.accumulate();
      ff.rms = r[o + Bf.rms]; h.nowWall = r[o + Bh.nowWall]; ff.centSmooth = r[o + Bf.centSmooth]; h.breaking = r[o + Bh.breaking] === 1;
      h.kickHit = r[o + Bh.kickHit]; h.sec = SECTIONS[r[o + Bh.sec]]; h.lvh = r[o + Bh.lvh]; h.conf = r[o + Bh.conf]; h.bpm = r[o + Bh.bpm];
      h.gridMs = r[o + Bh.gridMs]; h.trust = r[o + Bh.trust]; h.barKnown = r[o + Bh.barKnown] === 1;
      lv.lvlSmooth = r[o + Bl.lvlSmooth]; lv.activeMs = r[o + Bl.activeMs]; lv.intensity = r[o + Bl.intensity]; lv.levelCeil = r[o + Bl.levelCeil]; kk.kick = r[o + Bk.kick] === 1;
      if (r[o + B_ENVF] === 1) this.bass?.stepBassline();
      { const po = slot * BIG_HOP_MAX; this.bands.bigRingPush(pcm.subarray(po, po + hn)); }
      this.bands.bigTick();
      this.slowPart();
      this.sections?.bigAgg();
      n++;
      if (this.bigYield) this.bigYield();
    }
    if (n > 0) {
      Atomics.store(ctrl, C_BIG_READ, seqLow(this.bigSeq));
      stateWrite(ctrl, this.bigState!, (s) => {
        s[BS_SEQ] = this.bigSeq; s[BSs.bodyDb] = this.f.spectrum.bodyDb; this.drop?.pack(s); this.riser?.pack(s); this.character?.pack(s); s[BS_SPEC_N] = this.bands.specN; s[BS_SKIPPED] = this.bigSkipped;
      }, C_BIG_SEQ);
      if (this.syncWorker) Atomics.notify(ctrl, C_BIG_SEQ);
    }
    return n;
  }
  /** slow: alla hop-record lästa?. */
  bigIdle(): boolean { return seqLow(this.bigSeq) === Atomics.load(this.splitCtrl!, C_BIG_WRITE); }
  /** Snabba sidans kommandon i exakt den ordning de restes. */
  private applyFlags(flags: number, hintMs: number, vclock: number): void {
    if (flags & F_VCLOCK_NULL) this.setVirtualClock(null); else if (flags & F_VCLOCK_SET) this.setVirtualClock(vclock);
    if (flags & F_RESET_TEMPO) this.resetTempo();
    if (flags & F_HINT) this.hintTrackChange(hintMs);
    if (flags & F_RESET_BAR) this.resetBar();
    if (flags & F_SIL10) this.f.clock.zeroBpm();
  }
  /** Ett record. */
  private slowStep(o: number): void {
    const r = this.splitRing!;
    this.applyFlags(r[o + R_FLAGS], r[o + R_HINT_MS], r[o + R_VCLOCK]);
    this.virtualMs = r[o + R_PERF]; this.virtualOn = true;
    this.f.clock.bpm = r[o + Rc.bpm], this.f.clock.conf = r[o + Rc.conf];
    this.sections?.fromRecord();
  }

  /** Sparets tid. */
  private traceT(): number { return (this.wallNow() - 1700000000000) / 1000; }
  /** Nollställ analysatorns kopia av klockans tempo. */
  resetTempo(): void {
    if (BPM_TRACE) console.log(`[bpmrst] t=${this.traceT().toFixed(1)} RESET bpm=${this.f.clock.bpm}`);
    this.flagSlow(F_RESET_TEMPO);
    this.f.clock.bpm = 0; this.f.clock.conf = 0;
  }

  trackBoundaries = 0;   // LÅTGRÄNSEN
  boundSure = false;   // LÅTGRÄNSEN ÄR SÄKER
  /** Tystnad i ms. */
  get quietMs(): number { return this.f.level.silentMs; }
  /** EN KÄLLA. */
  setClock(bpm: number, conf: number): void { this.f.clock.bpm = bpm > 40 ? bpm : 0; this.f.clock.conf = bpm > 40 ? conf : 0; }
  hintTrackChange(windowMs = 5000, sections = true): void {
    if (this.f.hop.role !== 'slow') this.trackBoundaries++;
    if (BPM_TRACE) console.log(`[bpmrst] t=${this.traceT().toFixed(1)} HINT bpm=${this.f.clock.bpm} conf=${this.f.clock.conf.toFixed(2)}`);
    if (this.f.hop.role === 'fast') { this.pendHintMs = windowMs; this.flagSlow(F_HINT); }
    if (sections) this.sections?.carry();
  }

  /** Taktfasen är applicerad av motorn. */
  resetBar(): void { this.flagSlow(F_RESET_BAR); }

  private lastT = 0;   // 0 = "ej satt"

  private virtualMs = NaN; private virtualOn = false;   // VIRTUELL KLOCKA
  /** Driv analysatorn på en virtuell klocka. */
  setVirtualClock(ms: number | null) {
    if (this.f.hop.role === 'fast') { if (ms === null) this.flagSlow(F_VCLOCK_NULL); else { this.pendVclock = ms; this.flagSlow(F_VCLOCK_SET); } }
    const prev = this.virtualMs;
    const jump = ms === null || !this.virtualOn || ms < prev || ms - prev > 1000;
    if (ms === null) { this.virtualOn = false; this.virtualMs = NaN; } else { this.virtualOn = true; this.virtualMs = ms; }
    if (!jump) return;
    this.kicks?.reset(); this.sections?.sectionReset();
    this.lastT = 0;
  }
  /** KORBANK. */
  advanceVirtualClock(ms: number): void { this.virtualMs = ms; this.virtualOn = true; }
  private perfNow(): number { return this.virtualOn ? this.virtualMs : performance.now(); }
  private audioClockMs = -1;   // LJUDKLOCKAN
  private audioToWallOffset = 0;
  private audioOffsetSeeded = false;
  setAudioClockMs(ms: number): void {
    this.audioClockMs = ms;
    const raw = Date.now() - ms;
    if (!this.audioOffsetSeeded) { this.audioToWallOffset = raw; this.audioOffsetSeeded = true; return; }
    if (Math.abs(raw - this.audioToWallOffset) > 250) { this.audioToWallOffset = raw; return; }
    this.audioToWallOffset += (raw - this.audioToWallOffset) * 0.0005;
  }
  /** Tillbaka till Date.now(). */
  clearAudioClock(): void { this.audioClockMs = -1; this.audioOffsetSeeded = false; this.audioToWallOffset = 0; }
  wallNow(): number {
    if (this.virtualOn) return this.virtualEpoch + this.virtualMs;
    return this.audioClockMs >= 0 ? this.audioClockMs + this.audioToWallOffset : Date.now();
  }
  private virtualEpoch = 1700000000000;


  /** EN KLOCKA. */
  setBeatGrid(grid: BeatGrid | null): void { this.extGrid = grid; }
  private extGrid: BeatGrid | null = null;
  /** Klockans inre rutnät. */
  setClockGrid(grid: BeatGrid | null): void { this.f.clock.src.beat = grid; }

  constructor(cfgIn: AnalyserConfig, splitIn?: SplitInit) {
    const h = this.f.hop;
    h.role = splitIn?.role ?? cfgIn.role ?? 'all';
    const splitBuf = splitIn?.split ?? cfgIn.split;
    if (h.role !== 'all') {
      if (!splitBuf) throw new Error('Analyser: roll ' + h.role + ' kraver split-buffertar');
      const v = viewsOf(splitBuf); this.splitCtrl = v.ctrl; this.splitRing = v.ring; this.splitState = v.state;
      this.recSeq = splitIn?.resumeSeq ?? cfgIn.resumeSeq ?? 0;
      this.syncWorker = splitIn?.sync === true;
      if (h.role === 'slow') {
        this.slowGap = true;
        const sq = Atomics.load(v.ctrl, C_STATE_SEQ); if (sq & 1) Atomics.store(v.ctrl, C_STATE_SEQ, sq + 1);
      }
      if (!splitBuf.big || !splitBuf.bigPcm || !splitBuf.bigState || !splitBuf.spec) throw new Error('Analyser: delat läge kräver stora vägens buffertar (createSplitBuffers)');
      {
        h.bigOn = true;
        this.bigRing = new Float64Array(splitBuf.big); this.bigPcm = new Float32Array(splitBuf.bigPcm); this.bigState = new Float64Array(splitBuf.bigState); this.bands.specRing = new Float32Array(splitBuf.spec);
        if (h.role === 'slow') {
          const sq = Atomics.load(v.ctrl, C_BIG_SEQ); if (sq & 1) Atomics.store(v.ctrl, C_BIG_SEQ, sq + 1);
          const st = this.bigState; this.bigSeq = st[BS_SEQ]; this.bands.resume(st); this.drop?.resume(st); this.sections?.resume(st);
        }
      }
    }
    const cfg = h.cfg = {
      audio: { rate: cfgIn.audio?.rate ?? cfgIn.sampleRate ?? 48000 },
      fft: { size: cfgIn.fft?.size ?? cfgIn.fftSize ?? 512, hop: cfgIn.fft?.hop ?? cfgIn.hopSize ?? 128 },
      detection: cfgIn.detection ?? {
        autoGainTarget: cfgIn.autoGainTarget ?? 0.15,
        tauUp: cfgIn.tauUp ?? 3,
        tauDown: cfgIn.tauDown ?? 8,
        noiseFloor: cfgIn.noiseFloor ?? 0.002,
        maxGain: cfgIn.maxGain ?? 20,
      },
      onset: { enhancements: cfgIn.onsetEnhancements ?? false },
    };
    this.f.clock.src = cfgIn.detection ? cfgIn : { beat: null };
    this.setSilenceLevel(cfgIn.silenceLevel);
    this.f.level.envelope = cfg.detection.autoGainTarget;
    const BIG = 2048;
    this.bands.fftBig = new FFT(BIG);
    this.bands.windowBig = hannWindow(BIG);
    this.bands.windowedBig = new Float32Array(BIG);
    this.bands.bufferBig = new Float32Array(BIG);
    this.bands.prevMagBig = new Float32Array(BIG / 2);
    this.bands.magBig = new Float32Array(BIG / 2);
    this.bands.specBig = this.bands.fftBig.createComplexArray();
    const binHzBig = cfg.audio.rate / BIG;
    for (let b = 0; b < 8; b++) {
      this.bands.bandLo[b] = Math.max(1, Math.round(Analyser.BAND_HZ[b] / binHzBig));
      this.bands.bandHi[b] = Math.min(BIG / 2, Math.round(Analyser.BAND_HZ[b + 1] / binHzBig));
      this.bands.bandPeak[b] = 1e-4;
    }
    {
      const binHz = cfg.audio.rate / cfg.fft.size, half = cfg.fft.size / 2;
      for (let b = 3; b < 8; b++) { this.bands.fbLo[b] = Math.max(1, Math.round(Analyser.BAND_HZ[b] / binHz)); this.bands.fbHi[b] = Math.min(half, Math.max(this.bands.fbLo[b] + 1, Math.round(Analyser.BAND_HZ[b + 1] / binHz))); }
      const dtMs = cfg.fft.hop / cfg.audio.rate * 1000;
      for (let b = 0; b < 3; b++) {
        for (let s = 0; s < 2; s++) {
          const f0 = Analyser.BAND_HZ[b + s], w = 2 * Math.PI * f0 / cfg.audio.rate, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
          const o = (b * 2 + s) * 5, C = this.bands.fbCoef;
          if (s === 0) { C[o] = (1 + c) / 2 / a0; C[o + 1] = -(1 + c) / a0; C[o + 2] = (1 + c) / 2 / a0; }
          else { C[o] = (1 - c) / 2 / a0; C[o + 1] = (1 - c) / a0; C[o + 2] = (1 - c) / 2 / a0; }
          C[o + 3] = -2 * c / a0; C[o + 4] = (1 - al) / a0;
        }
        this.bands.fbA[b] = 1 - Math.exp(-dtMs / Analyser.FB_TAU_MS[b]);
      }
      this.bands.fbAlvl = 1 - Math.exp(-dtMs / 90);
    }
    this.bands.magBigMax = Math.min(BIG / 2, this.bands.bandHi[7] + 1);
    this.bands.magBigView = this.bands.magBig.subarray(0, this.bands.magBigMax);
    this.bands.prevMagBigView = this.bands.prevMagBig.subarray(0, this.bands.magBigMax);
    if (h.bigOn) this.bands.specCopy = new Float32Array(Math.min(SPEC_MAX, this.bands.magBigMax));

    const dtHop = cfg.fft.hop / cfg.audio.rate;
    h.dtHop = dtHop;
    h.hopMs = dtHop * 1000;

    this.fft.init(this.bands.fbHi[7] + 1);
    this.aVU = 1 - Math.exp(-dtHop / 0.20);
    this.levels.rates(dtHop);
    this.bands.rates(dtHop);
    this.dKick = Math.exp(-dtHop / 0.15);
    this.character?.rates(dtHop);
    this.outFrame = {
      silent: true, level: 0, levelVU: 0, energy: 0, centroid: 0, flux: 0,
      kick: false, gain: 1, bpm: 0, bpmConfidence: 0, intensity: 0.5,
      dropCount: 0, miniDropCount: 0, dropBuildCount: 0, dropDemoted: 0, dropSpaced: 0, nearDropDb: 0, nearDipDb: 0, liftDb: 0, stopCount: 0, stopS: 0, dropMiniBack: 0, dropKeys: 0, dropNear: 0, bodyDb: 0, bassEnergy: 0, bassEnergyShort: 0, bassLevel: 1, midHiDb: -120, levelInZone: false, levelBreaking: false, buildUp: 0, sectionBuildProg: 0, inRiser: false, profile: this.f.character.profile, kickAnchorMs: 0,
      kickAtMs: 0, barShift: -1, beatPhaseMs: 0, beatPhaseConf: 0, beatTrust: 0, section: 'intro', sectionAgeMs: 0, sectionIndex: 0, sectionTier: 1, repeatSim: 0, repeatAgoMs: 0, expectHighInMs: -1, prevSection: '', sectionLevelVsHighDb: 0, sectionBars: 0,
      spec: this.outSpec, specAbs: this.outSpecAbs, onset: this.outOnset, drum: this.outDrum, stenarAv: stenarAv(this.f),
    };
    for (const o of [this.outFrame, this.f.character.profile, this.outSpec, this.outSpecAbs, this.outOnset, this.outDrum]) stabiliseNumbers(o);
    stabilise(this, DOUBLE_FROM_START);
  }

  /** Feed a hop-sized chunk of mono samples, get a frame back. */
  process(samples: Float32Array): Frame {
    const h = this.f.hop;
    const sc = this.f.section;
    const lv = this.f.level, kk = this.f.kick, ck = this.f.clock, ff = this.f.fft;
    if (this.hopLane) this.setClock(this.hopLane.clockBpm, this.hopLane.clockConf);
    if (h.role === 'fast') this.pullSlowState();
    this.fft.hopStep(samples);

    const now = this.perfNow();
    const dt = this.lastT === 0 ? 0 : Math.max(0, Math.min(0.1, (now - this.lastT) / 1000));
    this.lastT = now;
    h.now = now; h.dt = dt;
    h.gated = ff.rms >= h.cfg.detection.noiseFloor * 1.5;
    this.levels.hopStep();
    const level = lv.level;

    this.kicks?.hopStep();

    const hopMs = h.hopMs;

    const big = h.bigOn;
    if (!big) this.bass?.accumulate();
    this.tickT += hopMs;
    if (this.tickT >= 1000 / Analyser.ENV_HZ) this.tickStep();

    this.lvlVU += (level - this.lvlVU) * this.aVU;

    if (!big) {
    this.bands.bigRingPush(samples);
    this.bands.bigTick();
    }
    this.bands.fastBandStep(samples);
    if (kk.kick) h.kickHit = 1;
    else h.kickHit = h.kickHit * this.dKick;
    const nowWallA = this.wallNow();
    const breaking = lv.lvlSmooth < lv.levelCeil * 0.65;

    h.nowWall = nowWallA; h.sec = sc.section; h.lvh = sc.levelVsHighDb; h.conf = ck.conf;   // IN: färdiga före pushBig
    this.bass?.bassEnergyStep(this.bands.fbAbs[0], this.bands.fbAbs[1]);   // basen före pushBig: workern kan få värdet samma hopp
    if (big) {
      h.breaking = breaking;
      this.pushBig(samples);
    } else {
      this.slowPart();
    }
    h.breaking = breaking;
    return this.fillFrame();
  }

  /** DEN LÅNGSAMMA DELEN: stenarna efter stor-FFT:n, i workern (drainBig) eller odelat (process). En ny sten här. */
  private slowPart(): void {
    this.drop?.dropStep();
    this.riser?.riserStep();
    this.character?.profileStep();
  }

  /** 100 Hz-steget: tempot sett vid hoppet, basgångens steg, recordet till workern. */
  private tickStep(): void {
    const h = this.f.hop, ck = this.f.clock;
    this.tickT -= 1000 / Analyser.ENV_HZ;
    h.bpm = ck.bpm; if (h.bigOn) this.bigEnvFlag = 1; else this.bass?.stepBassline();
    { const ln = this.hopLane, b = this.clockOut.beat, a = ln ? ln.clockAnchor : b ? b.anchorMs : 0;   // TAKTPOSITIONEN: klockans utfall efter förra hoppet, samma rutnät som effekterna
      h.gridMs = a > 0 ? a + this.wallNow() - Date.now() : 0;   // ankaret i analysatorns väggklocka (klockan går i Date.now)
      h.barKnown = ln ? ln.barKnown : !!this.clock?.barKnown(); h.trust = this.outFrame.beatTrust; }
    if (h.role === 'fast') this.pushSlowRecord();
  }

  /** Muterar det ateranvanda Frame:t. */
  private fillFrame(): Frame {
    const h = this.f.hop;
    const sc = this.f.section;
    const bo = this.f.bass, ri = this.f.riser, dp = this.f.drop;
    const lv = this.f.level, sp = this.f.spectrum, kk = this.f.kick, ck = this.f.clock, ff = this.f.fft;
    const fluxNorm = ff.flux, kick = kk.kick, intensity = lv.intensity, bodyNow = sp.bodyDb, inZone = lv.inZone, breaking = h.breaking,
      inRiser = ri.inRiser, kickAtMs = kk.kickAt;
    const L = this.bands.fbLvl, A = this.bands.fbAbs, O = sp.fbOn;
    const spec = this.outSpec, specAbs = this.outSpecAbs, onset = this.outOnset;
    spec.sub = L[0]; spec.kick = L[1]; spec.bass = L[2]; spec.lowMid = L[3]; spec.mid = L[4]; spec.highMid = L[5]; spec.treble = L[6]; spec.air = L[7];
    specAbs.sub = A[0]; specAbs.kick = A[1]; specAbs.bass = A[2]; specAbs.lowMid = A[3]; specAbs.mid = A[4]; specAbs.highMid = A[5]; specAbs.treble = A[6]; specAbs.air = A[7];
    onset.sub = O[0]; onset.kick = O[1]; onset.bass = O[2]; onset.lowMid = O[3]; onset.mid = O[4]; onset.highMid = O[5]; onset.treble = O[6]; onset.air = O[7];
    const dr = this.outDrum;
    dr.kick = h.kickHit; dr.snare = sp.snareHit; dr.hat = sp.hatHit; dr.bass = L[2];

    const f = this.outFrame;
    f.silent = lv.lvlSmooth <= this.silenceLevel; f.level = lv.lvlSmooth; f.levelVU = this.lvlVU;
    f.energy = ff.engSmooth;
    f.centroid = ff.centSmooth; f.flux = fluxNorm; f.kick = kick; f.gain = lv.gain;
    f.bpm = ck.bpm; f.bpmConfidence = ck.conf; f.intensity = intensity; f.kickAnchorMs = kk.beatAnchorMs;
    f.bodyDb = bodyNow; f.bassEnergy = f.silent ? 0 : bo.energy; f.bassEnergyShort = f.silent ? 0 : bo.beShort; f.bassLevel = Math.pow(10, (bo.beHi - bo.beRef) / 20);
    { let s2 = 1e-12; for (let b = 3; b < 8; b++) { const lin = Math.pow(10, this.bands.fbDbRaw[b] / 20); s2 += lin * lin; } f.midHiDb = 20 * Math.log10(Math.sqrt(s2)); }
    f.dropCount = dp.dropCount; f.miniDropCount = dp.miniDropCount; f.dropBuildCount = dp.buildStartCount; f.dropDemoted = dp.dropDemoted; f.dropSpaced = dp.dropSpaced;
    f.nearDropDb = dp.nearDropDb; f.nearDipDb = dp.nearDipDb; f.liftDb = dp.liftDb; f.stopCount = dp.stopCount; f.stopS = dp.stopS; f.dropMiniBack = dp.dropMiniBack; f.dropKeys = dp.dropKeys; f.dropNear = dp.dropNear; f.levelInZone = inZone; f.levelBreaking = breaking; f.buildUp = ri.buildUp; f.inRiser = inRiser;
    f.kickAtMs = kickAtMs; f.barShift = -1;
    this.sections?.sectionAggStep();
    const nowS = this.wallNow();
    f.sectionBuildProg = sc.secBuildAt > 0 && nowS - sc.secBuildSeen <= 2000 ? Math.min(1, (nowS - sc.secBuildAt) / (32 * (ck.bpm > 0 ? 60000 / ck.bpm : Analyser.BE_FALLBACK_MS))) : 0;
    f.section = sc.section; f.sectionAgeMs = sc.sectionStartMs > 0 ? nowS - sc.sectionStartMs : 0; f.sectionIndex = sc.sectionIndex; f.sectionTier = sc.sectionTier;
    f.repeatSim = sc.repeatSim; f.repeatAgoMs = sc.repeatAgoMs;
    f.expectHighInMs = sc.section === 'high' ? 0 : sc.expectHighMs > 0 ? Math.max(0, sc.expectHighMs - nowS) : -1;
    f.prevSection = sc.prevSection; f.sectionLevelVsHighDb = sc.levelVsHighDb;
    f.sectionBars = ck.bpm > 0 && sc.sectionStartMs > 0 ? (nowS - sc.sectionStartMs) / (240000 / ck.bpm) : 0;
    if (this.clock || this.hopSelf) {
      if (this.clock) this.clock.update(f, this.clockOut, this, Date.now());
      else this.hopLane!.feed(f, this.clockOut, this);
      publishPhase(f, this.clockOut.beat, this.clock ? this.clock.barKnown() : this.hopLane!.barKnown, this.extGrid, Date.now(), Analyser.GRID_PHASE_OFFSET_MS);
    }
    return f;
  }
  clock: BeatFeed | null = null;   // ANALYSATORNS KLOCKA utan taktväg
  readonly clockOut: ClockCfg = { beat: undefined, beatErr: undefined };
  /** Klockans utfall till motorn. */
  publishClock(cfg: ClockCfg): void { cfg.beat = this.clockOut.beat; cfg.beatErr = this.clockOut.beatErr; }
  // KEDJAN. Stäng av en sten = byt dess rad mot off('namn', this.f.<fack>) (t.ex. off('sektion', this.f.section)).
  readonly drop: DropDetector | null = new DropDetector(this.f, this.f.drop);   // DROP: flanken, slam-kandidaten, minidrop, lyft/nästan-drop/stopp
  readonly sections: SectionTracker | null = new SectionTracker(this.f, this.f.section);   // SEKTIONER
  readonly riser: RiserDetector | null = new RiserDetector(this.f, this.f.riser);   // UPPBYGGNAD
  readonly character: CharacterProfile | null = new CharacterProfile(this.f, this.f.character);   // KARAKTÄR
  readonly kicks: KickDetector | null = new KickDetector(this.f, this.f.kick);   // KICK: anslag i snabba vägen
  readonly bass: BassTracker | null = new BassTracker(this.f, this.f.bass);   // BAS: basenergin per slag och basgången
  private readonly cmd = { flagSlow: (fl: number) => this.flagSlow(fl) };   // bunden en gång: nivån flaggar tystnad till workern
  readonly levels = new LevelTracker(this.f, this.f.level, this.cmd);   // NIVÅ: förstärkning/AGC, tystnad, intensitet, nivåtak och topp-zon
  readonly bands = new SpectrumBands(this.f, this.f.spectrum);   // SPEKTRUM
  readonly fft = new SmallFft(this.f, this.f.fft);   // LILLA FFT:N: fönstrets rms, energi, flöde, kickflöde, centroid
}

export const WORKER_RESTART_BACKOFF_MS = [1000, 2000, 5000, 5000, 5000];   // DELAD ANALYSATOR
export const WORKER_RESTART_MAX = 5;
export const WORKER_RESTART_WINDOW_MS = 10 * 60_000;

export function createAnalyser(cfg: AnalyserConfig, modeIn?: 'worker' | 'inline' | 'sync'): Analyser {
  const mode = modeIn ?? sysEnv('ANALYSER_SPLIT');
  const cm = clockMode();
  if (mode !== 'worker' && mode !== 'inline' && mode !== 'sync') { const a = new Analyser(cfg); a.clock = new BeatFeed(); return a; }
  const sync = mode === 'sync';
  const feedMk = cm === 'slow' ? hopFeedFactory() : undefined;
  const buffers = createSplitBuffers(!!feedMk);
  const fast = new Analyser(cfg, { role: 'fast', split: buffers, sync });
  if (cm === 'inline') fast.clock = new BeatFeed();
  if (feedMk) { fast.hopLane = new HopLaneFast(buffers, sync); fast.hopSelf = sysEnv('BEAT_FEED') === undefined; }
  if (mode === 'inline') {
    fast.setInlinePeer(new Analyser(cfg, { role: 'slow', split: buffers }));
    if (feedMk) fast.hopLane!.peer = new HopLaneSlow(buffers, feedMk());
    return fast;
  }
  const withWorker = ({ Worker }: typeof import('node:worker_threads')) => {
    let stopped = false;
    const attempts: number[] = [];
    const parts: Array<'all' | 'lane' | 'slow'> = ['all'];
    const workers: Array<{ postMessage: (m: unknown) => void }> = [];
    const start = (part: 'all' | 'lane' | 'slow', resumeSeq: number, why: string) => {
      const data: WorkerData = { cfg: { ...cfg }, buffers, resumeSeq, sync, part };
      const w = new Worker(new URL('./slowWorker.js', import.meta.url), { workerData: data });
      w.on('error', (e) => console.error('[analyser-split] worker FEL:', e?.message ?? e));
      w.on('exit', (code) => {
        if (stopped || code === 0) { console.log(`[analyser-split] worker stangd (kod ${code})`); return; }
        const now = Date.now();
        while (attempts.length && now - attempts[0] > WORKER_RESTART_WINDOW_MS) attempts.shift();
        if (attempts.length >= WORKER_RESTART_MAX) {
          console.error(`[analyser-split] worker dog (kod ${code}) — ${WORKER_RESTART_MAX} omstarter pa ${WORKER_RESTART_WINDOW_MS / 60000} min, ger upp: tempo/sektion fryser pa senaste tillstandet; starta om motorn`);
          return;
        }
        const delay = WORKER_RESTART_BACKOFF_MS[Math.min(attempts.length, WORKER_RESTART_BACKOFF_MS.length - 1)];
        attempts.push(now);
        console.warn(`[analyser-split] worker dog (kod ${code}) — omstart #${attempts.length} om ${delay} ms, aterupptar vid record ${fast.fastReadSeq()} (skrivet ${fast.fastWriteSeq()})`);
        const t = setTimeout(() => { if (stopped) return; fast.splitRestarts++; start(part, part === 'lane' ? 0 : fast.fastReadSeq(), 'omstart'); }, delay);
        t.unref();
      });
      w.unref();
      workers[parts.indexOf(part)] = w;
      if (part !== 'lane') (fast as unknown as { __worker: unknown }).__worker = w;
      console.log(`[analyser-split] langsam analysator i worker startad (${part}) — ${why}, fran record ${resumeSeq}`);
    };
    (fast as unknown as { __stopWorker: () => void }).__stopWorker = () => {
      stopped = true;
      for (const w of workers) w?.postMessage({ type: 'stop' });
    };
    for (const p of parts) start(p, 0, 'start');
  };
  if (sync) withWorker((process as unknown as { getBuiltinModule(id: string): typeof import('node:worker_threads') }).getBuiltinModule('node:worker_threads'));
  else import('node:worker_threads').then(withWorker).catch((e) => console.error('[analyser-split] kunde inte starta worker:', e?.message ?? e));
  return fast;
}

/** TAKTVÄGEN. */
export function hopFeedFactory(): (() => HopFeed) | undefined {
  return clockMode() === 'slow' ? () => new BeatFeed() : undefined;
}
/** VAR KLOCKAN KÖRS. */
function clockMode(): 'slow' | 'inline' { return sysEnv('BEAT_FEED') === 'inline' ? 'inline' : 'slow'; }
