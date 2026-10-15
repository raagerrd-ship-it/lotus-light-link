/**
 * BASKROPPEN SOM NIVÅ (opt-in LOTUS_BASS_BODY=1, 2026-10-15, ägaren: "jag vill att vi fixar så de följer basen lika DMX").
 * Samma basenergi som DMX kör i ladan sedan 10-12 (dmx-control effects.ts, BASENERGIN): källan är analysatorns frame.bodyDb
 * (sub+kick+bas i rå dB, före AGC:n) i stället för hela spektrumets RMS × basandelen, och fönstret FÖLJER musiken - taket direkt
 * upp och ner på WIN_S (10 s), golvet direkt ner och upp på LO_S (1 s), minst MIN_DB brett - så varje bastryck svänger över hela
 * skalan i stället för att parkera högt i en tät refräng. Tystnad flyttar inte fönstret. Ut: 0..1 som ersätter dB-fönstrets shape;
 * allt efter (shapeSmooth, uttoningen, taket, pulsen) är orört. Kurvan CURVE = DMX:s B_CURVE 3 genom utgångens gamma 1,6 (samma
 * ljus i procent som DMX-lamporna). Ren funktion så bänken (tools/tempo-facit-pc/bassBodyBench.mjs) kör exakt samma kod.
 */
export const BASS_BODY = process.env.LOTUS_BASS_BODY === '1' || process.env.LOTUS_BASS_BODY === '2';
/** LOTUS_BASS_BODY=2 (ägaren i källaren 10-15: "lite mörkare, är dock ok. känns dock som att den följer inte bara bas"): bara sub+kick
 *  (20-120 Hz) i stället för baskroppen 20-250 Hz - bandet 120-250 Hz bär röstens grundton, virvelns kropp och gitarrens låga strängar.
 *  Samma storhet som bodyDb (medel av bandens rå dB, före AGC:n), två band i stället för tre. Bänk (bassBodyBench.mjs, median 1 -> 2):
 *  ladan 24 st: r mot mellanregistret 250-1200 Hz 0,20 -> 0,15, diskanten 0,26 -> 0,23, sub+kick-trycken 0,69 -> 0,70;
 *  lotus 40 st: mellanregistret 0,08 -> 0,02, diskanten 0,07 -> 0,04, sub+kick-trycken 0,53 -> 0,59; medelljus lika. */
export const BASS_SUBKICK = process.env.LOTUS_BASS_BODY === '2';
/** Sub+kick i rå dB ur frame.specAbs (bandens medelmagnitud, samma källa som bodyDb). */
export function subKickDb(specAbs: { sub: number; kick: number } | undefined): number {
  if (!specAbs) return -90;
  return (20 * Math.log10(specAbs.sub + 1e-7) + 20 * Math.log10(specAbs.kick + 1e-7)) / 2;
}
const WIN_S = 10, LO_S = 1, MIN_DB = 6, TOP = 0.95, CURVE = 3 / 1.6;

export class BassBodyWindow {
  private hi = NaN;
  private lo = NaN;
  /** bodyDb = frame.bodyDb, dtMs = tid sedan förra anropet, silent = under tystnadsgrinden. */
  step(bodyDb: number, dtMs: number, silent: boolean): number {
    const x = Math.max(-90, bodyDb), dt = Math.max(0, dtMs) / 1000;
    if (!silent) {
      if (this.hi !== this.hi) { this.hi = x; this.lo = x; }
      this.hi = x > this.hi ? x : this.hi + (x - this.hi) * Math.min(1, dt / WIN_S);
      this.lo = x < this.lo ? x : this.lo + (x - this.lo) * Math.min(1, dt / LO_S);
    }
    if (this.hi !== this.hi) return 0;   // inget fönster än (bara tystnad sedan start)
    const span = Math.max(MIN_DB, this.hi - this.lo);
    let e = (x - (this.hi - span)) / span;
    e = e < 0 ? 0 : e > 1 ? 1 : e;
    e = e >= TOP ? 1 : e / TOP;
    return Math.pow(e, CURVE);
  }
}
