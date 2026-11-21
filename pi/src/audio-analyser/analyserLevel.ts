/**  NIVÅN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserLevel.md */
import { Analyser } from "./analyser.js";
import { F_SIL350, F_SIL10 } from './split.js';


export class LevelTracker {
  a: Analyser;   // analysatorn som äger den här delen
  constructor(a: Analyser) {
    this.a = a;
  }
  aIUp = 0; aIDown = 0;  silentMs = -0;   // typstabilt
  private silenceArmed = false;   // true = tystnadssläppningen redan gjord för denna tystnad
  private intensityEma = 0.5;   // sektionsenergi
  private intensityFloor = 0.5;   // dess robusta P50-baslinje
  private intensitySpread = 0.05;   // glidande medelabsolutavvikelse

  inZoneState = false;   // hysteres för topp-zonen

  private static readonly AGC_BLOCKS = 16;   // PERCENTIL-AGC
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

  /** AGC (bara mic). */
  agcStep(): void {
    const rms = this.a.f.hop.rms, now = this.a.f.hop.now, dt = this.a.f.hop.dt;
    const d = this.a.f.hop.cfg.detection;
      const env = this.agcEnvelope(rms, now);
      if (env > 0) {
        this.a.envelope = env;
        const desired = d.autoGainTarget / Math.max(1e-4, env);
        const gTau = desired > this.a.gain ? d.tauUp * 2 : d.tauDown * 0.25;
        const ga = 1 - Math.exp(-dt / gTau);
        this.a.gain += (desired - this.a.gain) * ga;
        if (this.a.gain < 0.5) this.a.gain = 0.5;
        else if (this.a.gain > 20) this.a.gain = 20;
      }
  }

  /** Tystnadsflanken. */
  silenceStep(): void {
    const hopMs = this.a.f.hop.hopMs;
    if (!this.a.f.hop.gated) {
      this.silentMs += hopMs;
      if (this.silentMs > 350 && !this.silenceArmed) {
        this.silenceArmed = true;
        if (this.a.f.hop.role === 'fast') this.a.flagSlow(F_SIL350);
      } else if (this.silenceArmed && this.silentMs > 10000 && this.a.localBpm !== 0) {
        this.a.localBpm = 0;
        this.a.flagSlow(F_SIL10);
      }
    } else {
      this.silentMs = 0;
      this.silenceArmed = false;
    }
  }

  /** Sektionsenergi 0..1. */
  intensityStep(): void {
    const dtHop = this.a.f.hop.dtHop;
    if (this.a.f.hop.gated) this.a.activeMs += dtHop * 1000;
    else this.a.activeMs = 0;
    const iUp = this.aIUp;
    const iDown = this.aIDown;
    this.intensityEma += (this.a.f.hop.lvlSmooth - this.intensityEma) * (this.a.f.hop.lvlSmooth > this.intensityEma ? iUp : iDown);
    const iWarm = this.a.activeMs < 8000;
    const floorRate = iWarm ? dtHop / 3 : dtHop / 150;
    if (iWarm) this.intensityFloor += (this.intensityEma - this.intensityFloor) * floorRate;
    else this.intensityFloor += (this.intensityEma > this.intensityFloor ? 1 : this.intensityEma < this.intensityFloor ? -1 : 0) * floorRate * (this.intensityFloor + 0.05);
    const dev = this.intensityEma - this.intensityFloor;
    this.intensitySpread += (Math.abs(dev) - this.intensitySpread) * (iWarm ? dtHop / 3 : dtHop / 60);
    const scale = Math.max(0.015, this.intensitySpread) * 4;
    const intensity = Math.max(0, Math.min(1, 0.5 + dev / scale));
    this.a.hIntensity = intensity;
  }

  /** NIVÅTAKET OCH TOPP-ZONEN. */
  zoneStep(): void {
    this.a.levelCeil = Math.max(this.a.f.hop.lvlSmooth, this.a.levelCeil - this.a.f.hop.dtHop * 0.015 * this.a.levelCeil);
    if (this.a.f.hop.lvlSmooth > this.a.levelCeil * 0.85) this.inZoneState = true;
    else if (this.a.f.hop.lvlSmooth < this.a.levelCeil * 0.70) this.inZoneState = false;
  }
}
