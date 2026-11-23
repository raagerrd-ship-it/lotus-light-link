/**  UPPBYGGNADEN (utbruten ur analyser.ts 2026-11-14; nyckelknippa sedan steg 40). Anteckningar: docs/analysator/analyserRiser.md */
import { type Ser, type RiserOut } from "./analyserFack.js";
import { K } from "./analyserDrop.js";
import { BS } from "./split.js";

const P = BS.riser;   // platserna i storblocket
const EFTER_DROP_MS = 1500;   // inte direkt efter en drop
const NYCKLAR = (1 << K.AKTIV) | (1 << K.DISKANT);   // drop-stenens nycklar som uppbyggnaden kräver (AKTIV: musik; DISKANT: diskanten håller i luckan)

/** DET UPPBYGGNADEN LÄSER (workern). Inget annat går att nå. */
export interface RiserReads {
  hop:  Ser<'L', 'hop', 'nowWall' | 'dtHop'>;
  drop: Ser<'L', 'drop', 'lastDropMs' | 'dropKeys' | 'gap'>;
}

export class RiserDetector {
  private readonly h: RiserReads['hop']; private readonly dp: RiserReads['drop'];
  constructor(r: RiserReads, private readonly o: RiserOut) {   // läser: r, lämnar ut: o
    this.h = r.hop; this.dp = r.drop;
  }

  /** Uppbyggnad: knippan LUCKA (basen ur just nu) + AKTIV + DISKANT + EFTER DROP; buildUp = förloppet 0..1 (0 när basen är tillbaka). */
  riserStep(): void {
    const dtHop = this.h.dtHop;
    const inRiser = this.dp.gap
      && (this.dp.dropKeys & NYCKLAR) === NYCKLAR
      && this.h.nowWall - this.dp.lastDropMs > EFTER_DROP_MS;
    const bTarget = inRiser ? 1 : 0;
    const bRate = bTarget > this.o.buildUp ? dtHop / 3.5 : this.dp.gap ? dtHop / 1.0 : 1;   // basen tillbaka = förloppet slut
    this.o.buildUp += Math.max(-bRate, Math.min(bRate, bTarget - this.o.buildUp));
    this.o.inRiser = inRiser;
  }

  /** Transporten: workern packar uppbyggnaden i storblocket, huvudtråden packar upp. */
  pack(s: Float64Array): void { s[P.buildUp] = this.o.buildUp; s[P.inRiser] = this.o.inRiser ? 1 : 0; }
  unpack(s: Float64Array): void { this.o.buildUp = s[P.buildUp]; this.o.inRiser = s[P.inRiser] === 1; }
}
