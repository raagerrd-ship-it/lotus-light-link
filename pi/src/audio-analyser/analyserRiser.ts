/**  UPPBYGGNADEN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserRiser.md */
import { BODY_CEIL_DB_S, stabilise, type Ser, type RiserOut } from "./analyserFack.js";
import { BS } from "./split.js";

const P = BS.riser;   // platserna i storblocket
const RISER_SPAN_DB = 60;   // RISERNS FÖNSTER
const RISER_BAND0 = 3;   // RISERN LYSSNAR OVANFÖR BASKROPPEN
const DOUBLE_FROM_START = ['novSlow'] as const;   // Talfält som ska vara flyttal från start

/** DET UPPBYGGNADEN LÄSER (workern). Inget annat går att nå. */
export interface RiserReads {
  hop:      Ser<'L', 'hop', 'nowWall' | 'dtHop' | 'centSmooth' | 'lvlSmooth'>;
  spectrum: Ser<'L', 'spectrum', 'bandDbRaw'>;
  level:    Ser<'L', 'level', 'levelCeil' | 'activeMs'>;
  drop:     Ser<'L', 'drop', 'lastDropMs'>;
}

export class RiserDetector {
  private readonly h: RiserReads['hop']; private readonly sp: RiserReads['spectrum']; private readonly lv: RiserReads['level']; private readonly dp: RiserReads['drop'];
  constructor(r: RiserReads, private readonly o: RiserOut) {   // läser: r, lämnar ut: o
    this.h = r.hop; this.sp = r.spectrum; this.lv = r.level; this.dp = r.drop;
    stabilise(this, DOUBLE_FROM_START);
  }
  private aSpecSlow = 0; private aNovSlow = 0;   // RISER/UPPBYGGNAD
  private bandTop = new Float32Array(8).fill(-140);   // OBEHANDLAD LOGBANDNIVÅ
  private specSlow = new Float32Array(8);
  private novSlow = 0;   // ihållande spektral novelty
  private novBaseline = 0.2;
  private centSlow = 0.3;
  private lvlSlowR = 0.3;

  /** Utjämningens takt per hopp. */
  rates(dtHop: number): void { this.aSpecSlow = 1 - Math.exp(-dtHop / 2.0); this.aNovSlow = 1 - Math.exp(-dtHop / 1.5); }

  /** Uppbyggnad/riser. */
  riserStep(): void {
    const nowWallA = this.h.nowWall;
    const dtHop = this.h.dtHop;
    let nov = 0; const sr = this.aSpecSlow;
    for (let b = RISER_BAND0; b < 8; b++) {
      const raw = this.sp.bandDbRaw[b], top = this.bandTop[b] = Math.max(raw, this.bandTop[b] - dtHop * BODY_CEIL_DB_S);
      const x = Math.max(0, 1 + (raw - top) * (1 / RISER_SPAN_DB));
      this.specSlow[b] += (x - this.specSlow[b]) * sr; nov += Math.max(0, x - this.specSlow[b]);
    }
    this.novSlow += (nov - this.novSlow) * this.aNovSlow;
    this.novBaseline += (this.novSlow - this.novBaseline) * (dtHop / 8);
    const novRiser = this.novSlow > this.novBaseline + 0.15 && this.novSlow > 0.45;
    this.centSlow += (this.h.centSmooth - this.centSlow) * (dtHop / 2.5);
    this.lvlSlowR += (this.h.lvlSmooth - this.lvlSlowR) * (dtHop / 2.5);
    const lc = this.lv.levelCeil;
    const inRiser = this.lv.activeMs > 2500 && this.h.lvlSmooth > 0.3 * lc && nowWallA - this.dp.lastDropMs > 1500 && (
        novRiser
        || (this.h.centSmooth > this.centSlow + 0.06 && this.h.lvlSmooth > this.lvlSlowR + 0.04 * lc && this.h.lvlSmooth > 0.4 * lc)
      );
    const bTarget = inRiser ? 1 : 0;
    const bRate = bTarget > this.o.buildUp ? dtHop / 3.5 : dtHop / 1.0;
    this.o.buildUp += Math.max(-bRate, Math.min(bRate, bTarget - this.o.buildUp));
    this.o.inRiser = inRiser;
  }

  /** Transporten: workern packar uppbyggnaden i storblocket, huvudtråden packar upp. */
  pack(s: Float64Array): void { s[P.buildUp] = this.o.buildUp; s[P.inRiser] = this.o.inRiser ? 1 : 0; }
  unpack(s: Float64Array): void { this.o.buildUp = s[P.buildUp]; this.o.inRiser = s[P.inRiser] === 1; }
}
