/** DELAD ANALYSATOR (2026-09-21): transporten mellan den SNABBA tråden (ljudvägen: FFT, band, onset, kick, nivå, drop — måste svara inom en hop) och den LÅNGSAMMA (tempo, gridfas, sektioner, upprepning — sekunder är ok). Anteckningar (kommentarerna som stod i koden): docs/analysator/split.md */

import { trustStep } from "./analyserClock.js";   // tilliten utjämnas i hoppets tid
import { platser, antal } from "./analyserFack.js";
export const RING_N = 1024;
export const RING_MARGIN = 8;   // records workern lämnar orörda mot skrivaren

export const R_SEQ = 0, R_PERF = 1, R_WALL = 2, R_ENV = 3, R_BASS = 4, R_FLAGS = 5, R_HINT_MS = 6, R_VCLOCK = 7,
  R_TS = 8, R_FLAGCNT = 9, R_HIGH = 10, R_BIGSEQ = 11;   // Record-fält (kärnan)

export const F_SIL350 = 1, F_SIL10 = 2, F_RESET_TEMPO = 4, F_HINT = 8, F_RESET_BAR = 16, F_VCLOCK_SET = 32, F_VCLOCK_NULL = 64;   // Flaggor
export const FLAG_BITS = 7;

export const FLAG_MOD = 128;   // ROBUSTHET
export function packFlagCounts(cnt: ArrayLike<number>): number {
  let v = 0, m = 1;
  for (let k = 0; k < FLAG_BITS; k++) { v += (cnt[k] % FLAG_MOD) * m; m *= FLAG_MOD; }
  return v;
}
/** Bitmask över flaggor vars räknare skiljer mellan `before` och `after`. */
export function lostFlags(before: number, after: number, ownFlags: number): number {
  let lost = 0;
  for (let k = 0; k < FLAG_BITS; k++) {
    const a = Math.floor(after / FLAG_MOD ** k) % FLAG_MOD, b = Math.floor(before / FLAG_MOD ** k) % FLAG_MOD;
    let d = (a - b + FLAG_MOD) % FLAG_MOD;
    if (ownFlags & (1 << k)) d = (d - 1 + FLAG_MOD) % FLAG_MOD;
    if (d !== 0) lost |= 1 << k;
  }
  return lost;
}

export const C_WRITE = 0;   // Kontrollord
export const C_READ = 1;   // antal lästa records
export const C_STATE_SEQ = 2;   // seqlock för tillståndsblocket
export const C_WAITING = 3;   // 1 = workern ligger i Atomics.wait

/** SEQ-WRAP. */
export function seqLow(seq: number): number { return seq | 0; }
/** Signerad skillnad. */
export function seqDelta(ctrlLow: number, mySeq: number): number { return (ctrlLow - (mySeq | 0)) | 0; }

export const S_REC_SEQ = 0, S_BPM = 1, S_CONF = 2, S_BPMF = 3, S_PROCESSED = 4, S_LAG_MS = 5, S_LAG_MAX = 6,
  S_BUSY_US = 7, S_BUSY_MAX_US = 8, S_SKIPPED = 9, S_LOST_FLAGS = 10;   // Tillståndsblock (kärnan)

export const SECTIONS = ['', 'intro', 'low', 'build', 'high', 'break'];
export function sectionCode(s: string): number { const i = SECTIONS.indexOf(s); return i < 0 ? 0 : i; }

export interface SplitBuffers { ctrl: SharedArrayBuffer; ring: SharedArrayBuffer; state: SharedArrayBuffer; hop?: SharedArrayBuffer; hopState?: SharedArrayBuffer ;   // taktvägen
  big?: SharedArrayBuffer; bigPcm?: SharedArrayBuffer; bigState?: SharedArrayBuffer; spec?: SharedArrayBuffer  }   // stora vägen

/** Meddelanden main ↔ worker. */
export type WorkerMsg = { type: 'stop' } | { type: 'crash' };
/** cfg ar en KOPIA. */
export interface WorkerData { cfg: unknown; buffers: SplitBuffers; resumeSeq: number ; sync?: boolean ;   // senast lästa record
  part?: 'all' | 'lane' | 'slow'  }   // två trådar med stora vägen

export function createSplitBuffers(hopLane = false): SplitBuffers {
  const b: SplitBuffers = {
    ctrl: new SharedArrayBuffer(16 * 4),
    ring: new SharedArrayBuffer(RING_N * REC_LEN * 8),
    state: new SharedArrayBuffer(STATE_LEN * 8),
  };
  if (hopLane) { b.hop = new SharedArrayBuffer(HOP_RING_N * HOP_REC_LEN * 8); b.hopState = new SharedArrayBuffer(FEED_STATE_LEN * 8); }
  b.big = new SharedArrayBuffer(BIG_RING_N * BIG_REC_LEN * 8); b.bigPcm = new SharedArrayBuffer(BIG_RING_N * BIG_HOP_MAX * 4);
  b.bigState = new SharedArrayBuffer(BIG_STATE_LEN * 8); b.spec = new SharedArrayBuffer(SPEC_SLOTS * SPEC_MAX * 4);
  return b;
}

export function viewsOf(b: SplitBuffers): { ctrl: Int32Array; ring: Float64Array; state: Float64Array } {
  return { ctrl: new Int32Array(b.ctrl), ring: new Float64Array(b.ring), state: new Float64Array(b.state) };
}

/** Skriv tillståndsblocket under seqlock. */
export function stateWrite(ctrl: Int32Array, state: Float64Array, fill: (s: Float64Array) => void, word = C_STATE_SEQ): void {
  const s = Atomics.load(ctrl, word);
  Atomics.store(ctrl, word, s + 1);
  fill(state);
  Atomics.store(ctrl, word, s + 2);
}

/** Läs tillståndsblocket konsistent till `out`. */
export function stateRead(ctrl: Int32Array, state: Float64Array, out: Float64Array, word = C_STATE_SEQ): boolean {
  for (let tries = 0; tries < 4; tries++) {
    const s1 = Atomics.load(ctrl, word);
    if (s1 & 1) continue;
    out.set(state);
    const s2 = Atomics.load(ctrl, word);
    if (s1 === s2) return true;
  }
  return false;
}

/** stateRead med minne. */
export class StateReader {
  private w = -1;   // ordet vid senaste lyckade läsningen
  read(ctrl: Int32Array, state: Float64Array, out: Float64Array, word = C_STATE_SEQ): boolean {
    if (Atomics.load(ctrl, word) === this.w) return true;
    for (let tries = 0; tries < 4; tries++) {
      const s1 = Atomics.load(ctrl, word);
      if (s1 & 1) continue;
      out.set(state);
      const s2 = Atomics.load(ctrl, word);
      if (s1 === s2) { this.w = s1; return true; }
    }
    return false;
  }
}

/** SYNK-LÄGET. */
export function syncWait(ctrl: Int32Array, word: number, ready: () => boolean): void {
  for (let i = 0; i < 300; i++) {
    const v = Atomics.load(ctrl, word);
    if (ready()) return;
    Atomics.wait(ctrl, word, v, 100);
  }
  throw new Error('analyser-split sync: workern svarar inte (30 s)');
}

export const BIG_RING_N = 2048, BIG_HOP_MAX = 256;   // STORA VÄGEN
export const B_SEQ = 0, B_N = 1, B_ENVF = 2;   // hopprecordet (kärnan)
export const C_BIG_WRITE = 8, C_BIG_READ = 9, C_BIG_SEQ = 10 , C_WAITING_B = 11 ;
export const BS_SEQ = 0, BS_SPEC_N = 1, BS_SKIPPED = 2;   // storblocket (kärnan)

// FACKENS PLATSER (steg 18) ur taggarna (analyserFack.ts TRAD): IN följer hopprecordet B (tempot recordet R), UT storblocket BS (tempot och sektionen tillståndsblocket S).
export const B = platser('IN', ['hop', 'level', 'spectrum', 'kick', 'bass', 'riser', 'drop', 'character', 'section'], B_ENVF + 1);
export const R = platser('IN', ['clock'], R_BIGSEQ + 1);
export const BS = platser('UT', ['hop', 'level', 'spectrum', 'kick', 'bass', 'riser', 'drop', 'character'], BS_SKIPPED + 1);
export const S = platser('UT', ['clock', 'section'], S_LOST_FLAGS + 1);
if (B.LEN - B_ENVF - 1 + R.LEN - R_BIGSEQ - 1 !== antal('IN') || BS.LEN - BS_SKIPPED - 1 + S.LEN - S_LOST_FLAGS - 1 !== antal('UT')) throw new Error('split: ett IN- eller UT-fält saknar plats');
export const BIG_REC_LEN = B.LEN, REC_LEN = R.LEN, BIG_STATE_LEN = BS.LEN, STATE_LEN = S.LEN;
export const SPEC_SLOTS = 16, SPEC_MAX = 1024;   // 16 spektra

export const HOP_REC_LEN = 22;   // TAKTVÄGEN
export const HOP_RING_N = 4096;
export const H_SEQ = 0, H_NOW = 1 , H_TS = 2 ,
  H_BPM = 3, H_CONF = 4, H_ANCHOR = 5, H_KICKAT = 6, H_BARSHIFT = 7, H_ON_KICK = 8, H_ON_HIMID = 9, H_ON_TREBLE = 10, H_SA_SUB = 11, H_SA_KICK = 12, H_SA_BASS = 13 ,
  H_BOUND = 14 , H_QUIET = 15 ,
  H_SURE = 16 , H_UNDER = 17 , H_SA_TREBLE = 18, H_SA_LOWMID = 19, H_SA_MID = 20, H_SA_HIMID = 21;
export const C_HOP_WRITE = 4, C_HOP_READ = 5, C_FEED_SEQ = 6 , C_WAKE = 7 ;
export const FS_HOP_SEQ = 0, FS_BEAT = 1 , FS_ANCHOR = 2, FS_BPM = 3, FS_BCONF = 4,
  FS_BEATERR = 5 , FS_FCONF = 6 , FS_GRID = 7 ,
  FS_GANCHOR = 8, FS_GBPM = 9, FS_GCONF = 10, FS_RT_CNT = 11 , FS_RB_CNT = 12 ,
  FS_PROCESSED = 13, FS_LAG_MS = 14, FS_LAG_MAX = 15, FS_BUSY_US = 16, FS_BUSY_MAX_US = 17, FS_SKIPPED = 18,
  FS_BARK = 19 ;
export const FEED_STATE_LEN = 20;

/** Det taktmatningen läser ur ramen, och det den skriver. */
export interface HopFrame { bpm: number; bpmConfidence: number; kickAnchorMs: number; kickAtMs: number; barShift: number; beatTrust?: number;
  onset: { kick: number; highMid: number; treble: number }; specAbs: { sub: number; kick: number; bass: number; treble: number; lowMid: number; mid: number; highMid: number } }
export interface HopGrid { anchorMs: number; bpm: number; confidence?: number }
export interface HopCfg { beat?: HopGrid | null; beatErr?: number }
export interface HopTarget { resetTempo(): void; resetBar(): void; setClockGrid?(g: HopGrid | null): void; trackBoundaries?: number; quietMs?: number; boundSure?: boolean; bodyUnderDb?: number;
   setClock?(bpm: number, conf: number): void }   // EN KÄLLA
/** Systemets taktmatning. */
export interface HopFeed { update(frame: HopFrame, cfg: HopCfg, an: HopTarget, now: number): void;  barKnown?(): boolean }   // EN ETTA

/** Taktvägen, snabba sidan. */
export class HopLaneFast {
  private readonly ctrl: Int32Array; private readonly ring: Float64Array; private readonly state: Float64Array;
  private readonly s = new Float64Array(FEED_STATE_LEN); private readonly sr = new StateReader();
  private seq = 0; private applied = 0; private rt = 0; private rb = 0;
  private readonly grid = { anchorMs: 0.5, bpm: 0.5, confidence: 0.5 };
  clockBpm = 0; clockConf = 0; private trust = 0; private trustAt = 0;   // Klockans tempo/tillit efter senaste feed
  barKnown = false;   // EN ETTA
  peer: HopLaneSlow | null = null;   // inline-läget
  constructor(b: SplitBuffers, private readonly sync = false) {
    this.ctrl = new Int32Array(b.ctrl); this.ring = new Float64Array(b.hop!); this.state = new Float64Array(b.hopState!);
  }
  /** Ett hop. */
  feed(f: HopFrame, cfg: HopCfg, an: HopTarget): void {
    const r = this.ring, ctrl = this.ctrl, seq = ++this.seq, o = (seq % HOP_RING_N) * HOP_REC_LEN;
    const now = Date.now();
    r[o + H_NOW] = now; r[o + H_TS] = performance.timeOrigin + performance.now();
    r[o + H_BPM] = f.bpm; r[o + H_CONF] = f.bpmConfidence; r[o + H_ANCHOR] = f.kickAnchorMs; r[o + H_KICKAT] = f.kickAtMs; r[o + H_BARSHIFT] = f.barShift;
    r[o + H_ON_KICK] = f.onset?.kick ?? 0; r[o + H_ON_HIMID] = f.onset?.highMid ?? 0; r[o + H_ON_TREBLE] = f.onset?.treble ?? 0;
    r[o + H_SA_SUB] = f.specAbs?.sub ?? 0; r[o + H_SA_KICK] = f.specAbs?.kick ?? 0; r[o + H_SA_BASS] = f.specAbs?.bass ?? 0; r[o + H_SA_TREBLE] = f.specAbs?.treble ?? 0;
    r[o + H_SA_LOWMID] = f.specAbs?.lowMid ?? 0; r[o + H_SA_MID] = f.specAbs?.mid ?? 0; r[o + H_SA_HIMID] = f.specAbs?.highMid ?? 0;
    r[o + H_BOUND] = an.trackBoundaries ?? 0; r[o + H_QUIET] = an.quietMs ?? 0; r[o + H_SURE] = an.boundSure ? 1 : 0; r[o + H_UNDER] = an.bodyUnderDb ?? 0;
    r[o + H_SEQ] = seq;
    Atomics.store(ctrl, C_HOP_WRITE, seqLow(seq)); Atomics.add(ctrl, C_WAKE, 1);
    if (Atomics.load(ctrl, C_WAITING) || Atomics.load(ctrl, C_WAITING_B)) Atomics.notify(ctrl, C_WAKE);
    if (this.peer) this.peer.drain();
    else if (this.sync) syncWait(ctrl, C_FEED_SEQ, () => this.sr.read(ctrl, this.state, this.s, C_FEED_SEQ) && this.s[FS_HOP_SEQ] >= seq);
    this.apply(cfg, an);
    const b = cfg.beat; f.bpm = b ? b.bpm : 0; f.bpmConfidence = b ? (b.confidence ?? 0) : 0; this.clockBpm = f.bpm; this.clockConf = f.bpmConfidence;
    { const dt = this.trustAt > 0 ? now - this.trustAt : 0; this.trustAt = now; f.beatTrust = this.trust = trustStep(this.trust, f.bpmConfidence, cfg.beatErr ?? 0, dt > 250 ? 250 : dt); }
  }
  private apply(cfg: HopCfg, an: HopTarget): void {
    const s = this.s, ctrl = this.ctrl;
    if (!this.sr.read(ctrl, this.state, s, C_FEED_SEQ) || s[FS_HOP_SEQ] === 0) return;
    if (s[FS_HOP_SEQ] === this.applied) return;
    this.applied = s[FS_HOP_SEQ];
    if (s[FS_RT_CNT] !== this.rt) { this.rt = s[FS_RT_CNT]; an.resetTempo(); }
    if (s[FS_RB_CNT] !== this.rb) { this.rb = s[FS_RB_CNT]; an.resetBar(); }
    if (s[FS_GRID] === 1) { const g = this.grid; g.anchorMs = s[FS_GANCHOR]; g.bpm = s[FS_GBPM]; g.confidence = s[FS_GCONF]; an.setClockGrid?.(g); }
    else an.setClockGrid?.(null);
    const bc = s[FS_BEAT];
    if (bc === 1) {
      if (!cfg.beat) cfg.beat = { anchorMs: s[FS_ANCHOR], bpm: s[FS_BPM], confidence: s[FS_BCONF] };
      else { cfg.beat.anchorMs = s[FS_ANCHOR]; cfg.beat.bpm = s[FS_BPM]; cfg.beat.confidence = s[FS_BCONF]; }
    } else cfg.beat = bc === -1 ? null : undefined;
    const be = s[FS_BEATERR]; if (be === be) cfg.beatErr = be;
    this.barKnown = s[FS_BARK] === 1;
  }
  /** Hälsa: hur långt efter taktvägen ligger. */
  stats(): { written: number; processed: number; behind: number; lagMs: number; lagMaxMs: number; busyUs: number; busyMaxUs: number; skipped: number } {
    const s = this.s;
    return { written: this.seq, processed: s[FS_PROCESSED], behind: this.seq - s[FS_HOP_SEQ], lagMs: +s[FS_LAG_MS].toFixed(2), lagMaxMs: +s[FS_LAG_MAX].toFixed(2),
      busyUs: +s[FS_BUSY_US].toFixed(1), busyMaxUs: Math.round(s[FS_BUSY_MAX_US]), skipped: s[FS_SKIPPED] };
  }
}

/** Taktvägen, långsamma sidan. */
export class HopLaneSlow {
  private readonly ctrl: Int32Array; private readonly ring: Float64Array; private readonly state: Float64Array;
  private seq: number; private rt: number; private rb: number; private processed: number;
  private skipped = 0; private lagMaxMs = 0; private busyEmaUs = 0; private busyMaxUs = 0; private fconf = NaN;
  private readonly fr = { bpm: 0.5, bpmConfidence: 0.5, kickAnchorMs: 0.5, kickAtMs: 0.5, barShift: 0.5,
    onset: { kick: 0.5, highMid: 0.5, treble: 0.5 }, specAbs: { sub: 0.5, kick: 0.5, bass: 0.5, treble: 0.5, lowMid: 0.5, mid: 0.5, highMid: 0.5 } };
  private readonly cfg: HopCfg = { beat: undefined, beatErr: undefined };
  private grid: HopGrid | null = null;
  private readonly target: HopTarget = { trackBoundaries: 0, quietMs: 0, resetTempo: () => { this.rt++; }, resetBar: () => { this.rb++; }, setClockGrid: (g) => { this.grid = g; } };
  constructor(b: SplitBuffers, private readonly feed: HopFeed, private readonly notify = false) {
    this.ctrl = new Int32Array(b.ctrl); this.ring = new Float64Array(b.hop!); this.state = new Float64Array(b.hopState!);
    const sq = Atomics.load(this.ctrl, C_FEED_SEQ); if (sq & 1) Atomics.store(this.ctrl, C_FEED_SEQ, sq + 1);
    const st = this.state; this.seq = st[FS_HOP_SEQ]; this.rt = st[FS_RT_CNT]; this.rb = st[FS_RB_CNT]; this.processed = st[FS_PROCESSED];
  }
  readSeq(): number { return this.seq; }
  /** Behandla alla hop-record sedan sist, publicera. */
  drain(): number {
    const ctrl = this.ctrl, r = this.ring, fr = this.fr;
    const w = this.seq + seqDelta(Atomics.load(ctrl, C_HOP_WRITE), this.seq); let n = 0, lagMs = 0;
    if (w - this.seq > HOP_RING_N - RING_MARGIN) { this.skipped += (w - this.seq) - (HOP_RING_N - RING_MARGIN); this.seq = w - (HOP_RING_N - RING_MARGIN); }
    while (this.seq < w) {
      const seq = ++this.seq, o = (seq % HOP_RING_N) * HOP_REC_LEN;
      if (r[o + H_SEQ] !== seq) { this.skipped++; continue; }
      const t0 = performance.now();
      this.target.trackBoundaries = r[o + H_BOUND]; this.target.quietMs = r[o + H_QUIET]; this.target.boundSure = r[o + H_SURE] === 1; this.target.bodyUnderDb = r[o + H_UNDER];
      fr.bpm = r[o + H_BPM]; fr.bpmConfidence = r[o + H_CONF]; fr.kickAnchorMs = r[o + H_ANCHOR]; fr.kickAtMs = r[o + H_KICKAT]; fr.barShift = r[o + H_BARSHIFT];
      fr.onset.kick = r[o + H_ON_KICK]; fr.onset.highMid = r[o + H_ON_HIMID]; fr.onset.treble = r[o + H_ON_TREBLE];
      fr.specAbs.sub = r[o + H_SA_SUB]; fr.specAbs.kick = r[o + H_SA_KICK]; fr.specAbs.bass = r[o + H_SA_BASS]; fr.specAbs.treble = r[o + H_SA_TREBLE];
      fr.specAbs.lowMid = r[o + H_SA_LOWMID]; fr.specAbs.mid = r[o + H_SA_MID]; fr.specAbs.highMid = r[o + H_SA_HIMID];
      const cin = fr.bpmConfidence;
      this.feed.update(fr, this.cfg, this.target, r[o + H_NOW]);
      this.fconf = fr.bpmConfidence !== cin ? fr.bpmConfidence : NaN;
      const t1 = performance.now(), us = (t1 - t0) * 1000;
      this.busyEmaUs = this.busyEmaUs === 0 ? us : this.busyEmaUs + 0.02 * (us - this.busyEmaUs);
      if (us > this.busyMaxUs) this.busyMaxUs = us;
      lagMs = performance.timeOrigin + t1 - r[o + H_TS]; if (lagMs > this.lagMaxMs) this.lagMaxMs = lagMs;
      n++;
    }
    if (n > 0) {
      this.processed += n;
      Atomics.store(ctrl, C_HOP_READ, seqLow(this.seq));
      stateWrite(ctrl, this.state, (s) => {
        const b = this.cfg.beat, g = this.grid;
        s[FS_HOP_SEQ] = this.seq; s[FS_BEAT] = b ? 1 : b === null ? -1 : 0;
        if (b) { s[FS_ANCHOR] = b.anchorMs; s[FS_BPM] = b.bpm; s[FS_BCONF] = b.confidence ?? 0; }
        s[FS_BEATERR] = this.cfg.beatErr ?? NaN; s[FS_FCONF] = this.fconf;
        s[FS_GRID] = g ? 1 : 0; if (g) { s[FS_GANCHOR] = g.anchorMs; s[FS_GBPM] = g.bpm; s[FS_GCONF] = g.confidence ?? 0; }
        s[FS_RT_CNT] = this.rt; s[FS_RB_CNT] = this.rb;
        s[FS_PROCESSED] = this.processed; s[FS_LAG_MS] = lagMs; s[FS_LAG_MAX] = this.lagMaxMs; s[FS_BUSY_US] = this.busyEmaUs; s[FS_BUSY_MAX_US] = this.busyMaxUs; s[FS_SKIPPED] = this.skipped;
        s[FS_BARK] = this.feed.barKnown?.() ? 1 : 0;
      }, C_FEED_SEQ);
      if (this.notify) Atomics.notify(ctrl, C_FEED_SEQ);
    }
    return n;
  }
}
