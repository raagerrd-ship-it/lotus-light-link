/**  KICKDETEKTORN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserKick.md */
import { Analyser } from "./analyser.js";

const KICK_CAP_MS = 330;   // Ratt MED systemprefix
const DOUBLE_FROM_START = ['lastKick'] as const;   // Talfält som ska vara flyttal från start

export class KickDetector {
  a: Analyser;   // analysatorn som äger den här delen
  constructor(a: Analyser) {
    this.a = a;
    for (const k of DOUBLE_FROM_START) { const v = (this as unknown as Record<string, number>)[k]; if (typeof v === 'number') { (this as unknown as Record<string, number>)[k] = 0.5; (this as unknown as Record<string, number>)[k] = v; } }
  }

  private kickMed = 0.1;   // robust glidande MEDIAN av kick-fluxen
  private kickMad = 0.05;   // robust MAD
  private kickSeed = 0;   // warmup-räknare
  private kickWasAbove = false;   // stigande-flank-detektion
  private kickPrimed = false;   // false på första framen
  private static readonly KICK_K = 4.5;   // KICKDETEKTOR-RATTAR
  lastKick = 0;

  /** Kick-detektorn. */
  kickStep(): boolean {
    const kickFlux = this.a.f.hop.kickFlux, energy = this.a.f.hop.energy, now = this.a.f.hop.now;
    if (this.kickSeed < 400) {
      this.kickSeed++;
      this.kickMed += (kickFlux - this.kickMed) * 0.05;
      this.kickMad += (Math.abs(kickFlux - this.kickMed) - this.kickMad) * 0.05;
    } else {
      const kStep = 0.002;
      const dMed = kickFlux - this.kickMed;
      this.kickMed += (dMed > 0 ? 1 : dMed < 0 ? -1 : 0) * kStep * (this.kickMed + 0.01);
      const dMad = Math.abs(kickFlux - this.kickMed) - this.kickMad;
      this.kickMad += (dMad > 0 ? 1 : dMad < 0 ? -1 : 0) * kStep * (this.kickMad + 0.01);
      if (this.kickMed < 0) this.kickMed = 0;
      if (this.kickMad < 0) this.kickMad = 0;
    }
    const kickThresh = this.kickMed + KickDetector.KICK_K * this.kickMad;
    const dk = this.a.dbgKick;
    if (dk === null) this.a.dbgKick = { flux: kickFlux, thresh: kickThresh, med: this.kickMed, mad: this.kickMad, energy, gain: this.a.gain, rms: this.a.dbgRms, env: this.a.envelope, locked: this.a.gainLocked };
    else { dk.flux = kickFlux; dk.thresh = kickThresh; dk.med = this.kickMed; dk.mad = this.kickMad; dk.energy = energy; dk.gain = this.a.gain; dk.rms = this.a.dbgRms; dk.env = this.a.envelope; dk.locked = this.a.gainLocked; }
    const gk = this.a.beatSrc.beat;
    const cb = gk && gk.bpm > 40 ? gk.bpm : 0;
    const KICK_COOLDOWN = Analyser.KICK_COOLDOWN_MS > 0 ? Analyser.KICK_COOLDOWN_MS
      : (cb > 0 ? Math.max(170, Math.min(KICK_CAP_MS, (60000 / cb) * 0.6)) : 170);
    let above = kickFlux > kickThresh && energy > Analyser.KICK_EFLOOR;
    const grid = this.a.beatSrc.beat;
    if (above && grid && grid.bpm > 40 && (grid.confidence ?? 0) > 0.5) {
      const beatMs = 60000 / grid.bpm;
      const gridMs = beatMs / 2;
      const offset = ((this.a.wallNow() - grid.anchorMs) % gridMs + gridMs) % gridMs;

      const distToGrid = Math.min(offset, gridMs - offset);
      const tolerance = Math.max(30, beatMs * 0.15);
      if (distToGrid > tolerance && !Analyser.KICK_NOGATE) above = false;
    }
    let kick = false;
    if (above && !this.kickWasAbove && now - this.lastKick > KICK_COOLDOWN && this.kickPrimed) {
      kick = true;
      this.lastKick = now;
    }
    this.kickWasAbove = above;
    this.kickPrimed = true;
    return kick;
  }

  /** Forfinar forra kickens fas. */
  kickRefine(): void {
    const kickFlux = this.a.f.hop.kickFlux, hopMs = this.a.f.hop.hopMs;
    let kickAtMs = 0;
      const ym1 = this.a.kfPrev2, y0 = this.a.kfPrev, yp1 = kickFlux;
      const denom = ym1 - 2 * y0 + yp1;
      if (denom < 0) {
        let delta = 0.5 * (ym1 - yp1) / denom;
        if (delta > 0.5) delta = 0.5; else if (delta < -0.5) delta = -0.5;
        this.a.beatAnchorMs = this.a.pendingKickMs + delta * hopMs;

      }
      this.a.pendingKickMs = 0;
      kickAtMs = this.a.beatAnchorMs;
    this.a.hKickAt = kickAtMs;
  }
}
