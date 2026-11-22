/**  NIVÅN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserLevel.md */
import { type Ser, type LevelOut } from "./analyserFack.js";
import { F_SIL350, F_SIL10 } from './split.js';

/** DET NIVÅN LÄSER. Inget annat går att nå. zeroBpm = kommando till klockan. Bara huvudtråden. */
export interface LevelReads {
  hop:   Ser<'S', 'hop', 'rms' | 'now' | 'dt' | 'hopMs' | 'dtHop' | 'gated' | 'role' | 'cfg'>;
  clock: Ser<'S', 'clock', 'bpm' | 'zeroBpm'>;
}
/** Nivåns kommando till kärnan: flagga tystnad till workern. */
export interface LevelCmd { flagSlow(f: number): void }

export class LevelTracker {
  private readonly h: LevelReads['hop']; private readonly ck: LevelReads['clock'];
  constructor(r: LevelReads, private readonly o: LevelOut, private readonly cmd: LevelCmd) {   // läser: r, lämnar ut: o
    this.h = r.hop; this.ck = r.clock;
  }
  private aAtt = 0; private aRel = 0; private aIUp = 0; private aIDown = 0;
  /** Takterna ur hoppets längd (konstruktorn): utjämningen och intensiteten. */
  rates(dtHop: number): void {
    this.aAtt = 1 - Math.exp(-dtHop / 0.015);
    this.aRel = 1 - Math.exp(-dtHop / 0.4);
    this.aIUp = 1 - Math.exp(-dtHop / 1.5);
    this.aIDown = 1 - Math.exp(-dtHop / 3.0);
  }
  private silenceArmed = false;   // true = tystnadssläppningen redan gjord för denna tystnad
  private intensityEma = 0.5;   // sektionsenergi
  private intensityFloor = 0.5;   // dess robusta P50-baslinje
  private intensitySpread = 0.05;   // glidande medelabsolutavvikelse


  private static readonly AGC_BLOCKS = 16;   // PERCENTIL-AGC
  private static readonly AGC_BLOCK_MS = 128;
  private agcBlocks = new Float32Array(LevelTracker.AGC_BLOCKS);
  private agcBlockIdx = 0;
  private agcBlockMax = 0;
  private agcBlockStartMs = 0;
  private agcBlocksFilled = 0;

  resetAgcBlocks(): void {
    this.agcBlocks.fill(0);
    this.agcBlockIdx = 0; this.agcBlockMax = 0; this.agcBlockStartMs = 0; this.agcBlocksFilled = 0;
  }

  /** Mata in rå rms. */
  private agcEnvelope(rawRms: number, nowMs: number): number {
    if (rawRms > this.agcBlockMax) this.agcBlockMax = rawRms;
    if (this.agcBlockStartMs === 0) this.agcBlockStartMs = nowMs;
    if (nowMs - this.agcBlockStartMs >= LevelTracker.AGC_BLOCK_MS) {
      this.agcBlocks[this.agcBlockIdx] = this.agcBlockMax;
      this.agcBlockIdx = (this.agcBlockIdx + 1) % LevelTracker.AGC_BLOCKS;
      if (this.agcBlocksFilled < LevelTracker.AGC_BLOCKS) this.agcBlocksFilled++;
      this.agcBlockMax = 0;
      this.agcBlockStartMs = nowMs;
    }
    if (this.agcBlocksFilled < 2) return 0;
    let top = 0, second = 0;
    for (let i = 0; i < this.agcBlocksFilled; i++) {
      const v = this.agcBlocks[i];
      if (v > top) { second = top; top = v; }
      else if (v > second) { second = v; }
    }
    return second;
  }

  /** Hoppet: AGC (bara mic, över brusgolvet), tystnaden, rå nivå, utjämningen, intensiteten, nivåtaket. */
  hopStep(): void {
    const o = this.o;
    if (!o.gainLocked && this.h.rms > this.h.cfg.detection.noiseFloor) this.agcStep();
    this.silenceStep();
    const x = Math.min(1, this.h.rms * o.gain), p = o.lvlSmooth;
    o.level = x;
    o.lvlSmooth = p + (x - p) * (x > p ? this.aAtt : this.aRel);
    this.intensityStep();
    this.zoneStep();
  }

  /** AGC (bara mic). */
  private agcStep(): void {
    const rms = this.h.rms, now = this.h.now, dt = this.h.dt;
    const d = this.h.cfg.detection;
      const env = this.agcEnvelope(rms, now);
      if (env > 0) {
        this.o.envelope = env;
        const desired = d.autoGainTarget / Math.max(1e-4, env);
        const gTau = desired > this.o.gain ? d.tauUp * 2 : d.tauDown * 0.25;
        const ga = 1 - Math.exp(-dt / gTau);
        this.o.gain += (desired - this.o.gain) * ga;
        if (this.o.gain < 0.5) this.o.gain = 0.5;
        else if (this.o.gain > 20) this.o.gain = 20;
      }
  }

  /** Tystnadsflanken. */
  private silenceStep(): void {
    const hopMs = this.h.hopMs;
    if (!this.h.gated) {
      this.o.silentMs += hopMs;
      if (this.o.silentMs > 350 && !this.silenceArmed) {
        this.silenceArmed = true;
        if (this.h.role === 'fast') this.cmd.flagSlow(F_SIL350);
      } else if (this.silenceArmed && this.o.silentMs > 10000 && this.ck.bpm !== 0) {
        this.ck.zeroBpm();
        this.cmd.flagSlow(F_SIL10);
      }
    } else {
      this.o.silentMs = 0;
      this.silenceArmed = false;
    }
  }

  /** Sektionsenergi 0..1. */
  private intensityStep(): void {
    const dtHop = this.h.dtHop;
    if (this.h.gated) this.o.activeMs += dtHop * 1000;
    else this.o.activeMs = 0;
    const iUp = this.aIUp;
    const iDown = this.aIDown;
    this.intensityEma += (this.o.lvlSmooth - this.intensityEma) * (this.o.lvlSmooth > this.intensityEma ? iUp : iDown);
    const iWarm = this.o.activeMs < 8000;
    const floorRate = iWarm ? dtHop / 3 : dtHop / 150;
    if (iWarm) this.intensityFloor += (this.intensityEma - this.intensityFloor) * floorRate;
    else this.intensityFloor += (this.intensityEma > this.intensityFloor ? 1 : this.intensityEma < this.intensityFloor ? -1 : 0) * floorRate * (this.intensityFloor + 0.05);
    const dev = this.intensityEma - this.intensityFloor;
    this.intensitySpread += (Math.abs(dev) - this.intensitySpread) * (iWarm ? dtHop / 3 : dtHop / 60);
    const scale = Math.max(0.015, this.intensitySpread) * 4;
    const intensity = Math.max(0, Math.min(1, 0.5 + dev / scale));
    this.o.intensity = intensity;
  }

  /** NIVÅTAKET OCH TOPP-ZONEN. */
  private zoneStep(): void {
    this.o.levelCeil = Math.max(this.o.lvlSmooth, this.o.levelCeil - this.h.dtHop * 0.015 * this.o.levelCeil);
    if (this.o.lvlSmooth > this.o.levelCeil * 0.85) this.o.inZone = true;
    else if (this.o.lvlSmooth < this.o.levelCeil * 0.70) this.o.inZone = false;
  }
}
