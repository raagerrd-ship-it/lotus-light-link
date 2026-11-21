/**  BASEN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserBass.md */
import { Analyser } from "./analyser.js";

const DOUBLE_FROM_START = ['blPrev1', 'blPrev2', 'blTrough'] as const;   // Talfält som ska vara flyttal från start

export class BassTracker {
  a: Analyser;   // analysatorn som äger den här delen
  constructor(a: Analyser) {
    this.a = a;
    for (const k of DOUBLE_FROM_START) { const v = (this as unknown as Record<string, number>)[k]; if (typeof v === 'number') { (this as unknown as Record<string, number>)[k] = 0.5; (this as unknown as Record<string, number>)[k] = v; } }
  }
  private static readonly BE_TOP_BEATS = 16; private static readonly BE_FAST_BEATS = 2;  private static readonly BE_BEAT_MIN_MS = 300; private static readonly BE_BEAT_MAX_MS = 600;  beHi = NaN; private beHiShort = NaN; beRef = NaN; beShort = 0;   // BASENERGIN MED SLAGET SOM TIDSENHET
  /** Stegar skalorna ett hop. */
  bassEnergyStep(sub: number, kick: number): number {
    const x = 5 * Math.log10(sub + 1e-7) + 15 * Math.log10(kick + 1e-7), hopMs = this.a.f.hop.dtHop * 1000;
    let per = this.a.localBpm > 40 ? 60000 / this.a.localBpm : Analyser.BE_FALLBACK_MS;
    per = per < BassTracker.BE_BEAT_MIN_MS ? BassTracker.BE_BEAT_MIN_MS : per > BassTracker.BE_BEAT_MAX_MS ? BassTracker.BE_BEAT_MAX_MS : per;
    this.beHi = !(x <= this.beHi) ? x : this.beHi + (x - this.beHi) * (hopMs / (BassTracker.BE_TOP_BEATS * per));
    this.beHiShort = !(x <= this.beHiShort) ? x : this.beHiShort + (x - this.beHiShort) * (hopMs / (BassTracker.BE_FAST_BEATS * per));
    this.beRef = this.a.section === 'high' || !(this.beHi <= this.beRef) ? this.beHi : this.beRef + (this.beHi - this.beRef) * (hopMs / (Analyser.BE_MEM_BEATS * per));
    let e = 1 - (this.beHiShort - x) / Analyser.BE_SPAN_DB;
    this.beShort = e > 0 ? e : 0;
    e = 1 - (this.beHi - x) / Analyser.BE_SPAN_DB;
    return e > 0 ? e : 0;
  }
  private blPrev1 = 0; private blPrev2 = 0; private blRef = 0.1; private blLastOnset = -100;
  private blOnsets = new Int32Array(32); private blOnsetPos = 0; envSeq = 0; private blTrough = 1;
  /** TYDLIG BASGANG. */
  stepBassline(): void {
    const v = this.a.blAccum; this.a.blAccum = 0;
    const seq = ++this.envSeq;
    const p1 = this.blPrev1;
    if (v < this.blTrough) this.blTrough = v;
    if (p1 >= this.blPrev2 && p1 > v && p1 > 0.05 && p1 - this.blTrough >= 0.25 * this.blRef && seq - 1 - this.blLastOnset >= 6) {
      if (seq - 1 - this.a.blKickSeq >= 6) { this.blOnsets[this.blOnsetPos] = seq - 1; this.blOnsetPos = (this.blOnsetPos + 1) & 31; }
      this.blLastOnset = seq - 1;
      this.blRef += (p1 - this.blRef) * 0.1;
      this.blTrough = p1;
    } else if (this.blRef > 0.05) this.blRef *= 0.999;
    this.blPrev2 = p1; this.blPrev1 = v;
    let n = 0; for (let i = 0; i < 32; i++) if (seq - this.blOnsets[i] <= 200 && this.blOnsets[i] > 0) n++;
    const beats2s = (this.a.f.hop.bpm > 0 ? this.a.f.hop.bpm : 120) / 30;
    const opb = n / beats2s;
    this.a.bassOnsetsPerBeat = opb;
    const raw = Math.max(0, Math.min(1, (opb - 0.4) / 0.8));
    this.a.profBassline += (raw - this.a.profBassline) * 0.01;
  }
}
