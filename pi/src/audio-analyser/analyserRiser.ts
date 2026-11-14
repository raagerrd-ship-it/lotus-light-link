/**  UPPBYGGNADEN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserRiser.md */
import { type Analyser, BODY_CEIL_DB_S } from "./analyser.js";

const RISER_SPAN_DB = 60;   // RISERNS FÖNSTER
const RISER_BAND0 = 3;   // RISERN LYSSNAR OVANFÖR BASKROPPEN
const DOUBLE_FROM_START = ['novSlow'] as const;   // Talfält som ska vara flyttal från start

export class RiserDetector {
  a: Analyser;   // analysatorn som äger den här delen
  constructor(a: Analyser) {
    this.a = a;
    for (const k of DOUBLE_FROM_START) { const v = (this as unknown as Record<string, number>)[k]; if (typeof v === 'number') { (this as unknown as Record<string, number>)[k] = 0.5; (this as unknown as Record<string, number>)[k] = v; } }
  }
  aSpecSlow = 0; aNovSlow = 0;   // RISER/UPPBYGGNAD
  private bandTop = new Float32Array(8).fill(-140);   // OBEHANDLAD LOGBANDNIVÅ
  private specSlow = new Float32Array(8);
  private novSlow = 0;   // ihållande spektral novelty
  private novBaseline = 0.2;
  private centSlow = 0.3;
  private lvlSlowR = 0.3;

  /** Uppbyggnad/riser. */
  riserStep(): boolean {
    const nowWallA = this.a.hNowWall;
    const dtHop = this.a.dtHop;
    let nov = 0; const sr = this.aSpecSlow;
    for (let b = RISER_BAND0; b < 8; b++) {
      const raw = this.a.bandDbRaw[b], top = this.bandTop[b] = Math.max(raw, this.bandTop[b] - dtHop * BODY_CEIL_DB_S);
      const x = Math.max(0, 1 + (raw - top) * (1 / RISER_SPAN_DB));
      this.specSlow[b] += (x - this.specSlow[b]) * sr; nov += Math.max(0, x - this.specSlow[b]);
    }
    this.novSlow += (nov - this.novSlow) * this.aNovSlow;
    this.novBaseline += (this.novSlow - this.novBaseline) * (dtHop / 8);
    const novRiser = this.novSlow > this.novBaseline + 0.15 && this.novSlow > 0.45;
    this.centSlow += (this.a.centSmooth - this.centSlow) * (dtHop / 2.5);
    this.lvlSlowR += (this.a.lvlSmooth - this.lvlSlowR) * (dtHop / 2.5);
    const lc = this.a.levelCeil;
    const inRiser = this.a.activeMs > 2500 && this.a.lvlSmooth > 0.3 * lc && nowWallA - this.a.drop.lastDropMs > 1500 && (
        novRiser
        || (this.a.centSmooth > this.centSlow + 0.06 && this.a.lvlSmooth > this.lvlSlowR + 0.04 * lc && this.a.lvlSmooth > 0.4 * lc)
      );
    const bTarget = inRiser ? 1 : 0;
    const bRate = bTarget > this.a.buildUp ? dtHop / 3.5 : dtHop / 1.0;
    this.a.buildUp += Math.max(-bRate, Math.min(bRate, bTarget - this.a.buildUp));
    return inRiser;
  }
}
