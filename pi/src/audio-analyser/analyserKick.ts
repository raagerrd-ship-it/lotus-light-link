/**  KICKDETEKTORN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserKick.md */
import { sysEnv, type Ser, type KickOut } from "./analyserFack.js";

const KICK_CAP_MS = 330;   // Ratt MED systemprefix
const KICK_NOGATE = sysEnv('KICK_NOGATE') === '1';
const KICK_COOLDOWN_MS = Number(sysEnv('KICK_COOLDOWN')) || 0;   // 0 = tempoanpassad
const KICK_EFLOOR = Number(sysEnv('KICK_EFLOOR')) || 0.06;

/** DET KICKEN LÄSER. Inget annat går att nå. */
export interface KickReads {
  hop:   Ser<'S', 'hop', 'kickFlux' | 'energy' | 'now' | 'hopMs' | 'rms' | 'wallNow'>;
  level: Ser<'S', 'level', 'gain' | 'envelope' | 'gainLocked'>;
  clock: Ser<'S', 'clock', 'src'>;
}

export class KickDetector {
  private readonly h: KickReads['hop']; private readonly lv: KickReads['level']; private readonly ck: KickReads['clock'];
  constructor(r: KickReads, private readonly o: KickOut) {   // läser: r, lämnar ut: o
    this.h = r.hop; this.lv = r.level; this.ck = r.clock;
  }

  private kickMed = 0.1;   // robust glidande MEDIAN av kick-fluxen
  private kickMad = 0.05;   // robust MAD
  private kickSeed = 0;   // warmup-räknare
  private kickWasAbove = false;   // stigande-flank-detektion
  private kickPrimed = false;   // false på första framen
  private static readonly KICK_K = 4.5;   // KICKDETEKTOR-RATTAR

  /** Hoppet: detektorn, sedan ankaret. */
  hopStep(): void { this.kickStep(); this.anchorStep(); }

  /** Kick-detektorn. */
  private kickStep(): void {
    const kickFlux = this.h.kickFlux, energy = this.h.energy, now = this.h.now;
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
    const dk = this.o.dbgKick;
    if (dk === null) this.o.dbgKick = { flux: kickFlux, thresh: kickThresh, med: this.kickMed, mad: this.kickMad, energy, gain: this.lv.gain, rms: this.h.rms, env: this.lv.envelope, locked: this.lv.gainLocked };
    else { dk.flux = kickFlux; dk.thresh = kickThresh; dk.med = this.kickMed; dk.mad = this.kickMad; dk.energy = energy; dk.gain = this.lv.gain; dk.rms = this.h.rms; dk.env = this.lv.envelope; dk.locked = this.lv.gainLocked; }
    const gk = this.ck.src.beat;
    const cb = gk && gk.bpm > 40 ? gk.bpm : 0;
    const KICK_COOLDOWN = KICK_COOLDOWN_MS > 0 ? KICK_COOLDOWN_MS
      : (cb > 0 ? Math.max(170, Math.min(KICK_CAP_MS, (60000 / cb) * 0.6)) : 170);
    let above = kickFlux > kickThresh && energy > KICK_EFLOOR;
    const grid = this.ck.src.beat;
    if (above && grid && grid.bpm > 40 && (grid.confidence ?? 0) > 0.5) {
      const beatMs = 60000 / grid.bpm;
      const gridMs = beatMs / 2;
      const offset = ((this.h.wallNow() - grid.anchorMs) % gridMs + gridMs) % gridMs;

      const distToGrid = Math.min(offset, gridMs - offset);
      const tolerance = Math.max(30, beatMs * 0.15);
      if (distToGrid > tolerance && !KICK_NOGATE) above = false;
    }
    let kick = false;
    if (above && !this.kickWasAbove && now - this.o.lastKick > KICK_COOLDOWN && this.kickPrimed) {
      kick = true;
      this.o.lastKick = now;
    }
    this.kickWasAbove = above;
    this.kickPrimed = true;
    this.o.kick = kick;
  }

  /** Ankaret: förra kickens förfining, den här kickens ankare, fluxhistoriken. */
  private anchorStep(): void {
    const o = this.o;
    o.kickAt = 0;
    if (o.pendingKickMs > 0) this.kickRefine();
    if (o.kick) {
      o.beatAnchorMs = this.h.wallNow();
      o.pendingKickMs = o.beatAnchorMs;
    }
    o.kfPrev2 = o.kfPrev;
    o.kfPrev = this.h.kickFlux;
  }

  /** Forfinar forra kickens fas. */
  private kickRefine(): void {
    const kickFlux = this.h.kickFlux, hopMs = this.h.hopMs;
    let kickAtMs = 0;
      const ym1 = this.o.kfPrev2, y0 = this.o.kfPrev, yp1 = kickFlux;
      const denom = ym1 - 2 * y0 + yp1;
      if (denom < 0) {
        let delta = 0.5 * (ym1 - yp1) / denom;
        if (delta > 0.5) delta = 0.5; else if (delta < -0.5) delta = -0.5;
        this.o.beatAnchorMs = this.o.pendingKickMs + delta * hopMs;

      }
      this.o.pendingKickMs = 0;
      kickAtMs = this.o.beatAnchorMs;
    this.o.kickAt = kickAtMs;
  }

  /** Hopp i klockan (setVirtualClock): kickens minne nollas. */
  reset(): void { const o = this.o; o.lastKick = 0; o.pendingKickMs = 0; o.beatAnchorMs = 0; }
}
