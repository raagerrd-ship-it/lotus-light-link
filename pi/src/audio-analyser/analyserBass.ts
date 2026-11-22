/**  BASEN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserBass.md */
import { BASS_SPAN_DB, BE_FALLBACK_MS, BE_MEM_BEATS, stabilise, type Ser, type BassOut } from "./analyserFack.js";

const DOUBLE_FROM_START = ['blPrev1', 'blPrev2', 'blTrough', 'blAccum'] as const;   // Talfält som ska vara flyttal från start
const BE_TOP_BEATS = 16, BE_FAST_BEATS = 2, BE_BEAT_MIN_MS = 300, BE_BEAT_MAX_MS = 600;   // BASENERGIN MED SLAGET SOM TIDSENHET

/** DET BASEN LÄSER. Inget annat går att nå. S = bassEnergyStep (huvudtråden), L = accumulate/stepBassline (workern). */
export interface BassReads {
  hop:      Ser<'S', 'hop', 'dtHop'> & Ser<'L', 'hop', 'bpm' | 'kickHit'>;
  clock:    Ser<'S', 'clock', 'bpm'>;
  section:  Ser<'S', 'section', 'section'>;
  spectrum: Ser<'L', 'spectrum', 'bandLvl'>;
}

export class BassTracker {
  private readonly hop: BassReads['hop']; private readonly clock: BassReads['clock']; private readonly sec: BassReads['section'];
  private readonly sp: BassReads['spectrum'];
  constructor(r: BassReads, private readonly o: BassOut) {   // läser: r, lämnar ut: o
    this.hop = r.hop; this.clock = r.clock; this.sec = r.section; this.sp = r.spectrum;
    stabilise(this, DOUBLE_FROM_START);
  }
  private beHiShort = NaN;
  /** Stegar skalorna ett hop. */
  bassEnergyStep(sub: number, kick: number): void {
    const o = this.o, x = 5 * Math.log10(sub + 1e-7) + 15 * Math.log10(kick + 1e-7), hopMs = this.hop.dtHop * 1000;
    let per = this.clock.bpm > 40 ? 60000 / this.clock.bpm : BE_FALLBACK_MS;
    per = per < BE_BEAT_MIN_MS ? BE_BEAT_MIN_MS : per > BE_BEAT_MAX_MS ? BE_BEAT_MAX_MS : per;
    o.beHi = !(x <= o.beHi) ? x : o.beHi + (x - o.beHi) * (hopMs / (BE_TOP_BEATS * per));
    this.beHiShort = !(x <= this.beHiShort) ? x : this.beHiShort + (x - this.beHiShort) * (hopMs / (BE_FAST_BEATS * per));
    o.beRef = this.sec.section === 'high' || !(o.beHi <= o.beRef) ? o.beHi : o.beRef + (o.beHi - o.beRef) * (hopMs / (BE_MEM_BEATS * per));
    let e = 1 - (this.beHiShort - x) / BASS_SPAN_DB;
    o.beShort = e > 0 ? e : 0;
    e = 1 - (o.beHi - x) / BASS_SPAN_DB;
    o.energy = e > 0 ? e : 0;
  }
  private blAccum = 0; private blKickSeq = -100; private envSeq = 0;   // TYDLIG BASGANG
  private blPrev1 = 0; private blPrev2 = 0; private blRef = 0.1; private blLastOnset = -100;
  private blOnsets = new Int32Array(32); private blOnsetPos = 0; private blTrough = 1;
  /** Hoppets bidrag till basgången (förr två likadana rader i analyser.ts). */
  accumulate(): void {
    const bl = this.sp.bandLvl[1] + this.sp.bandLvl[2]; if (bl > this.blAccum) this.blAccum = bl; if (this.hop.kickHit >= 1) this.blKickSeq = this.envSeq;
  }
  /** TYDLIG BASGANG. */
  stepBassline(): void {
    const v = this.blAccum; this.blAccum = 0;
    const seq = ++this.envSeq;
    const p1 = this.blPrev1;
    if (v < this.blTrough) this.blTrough = v;
    if (p1 >= this.blPrev2 && p1 > v && p1 > 0.05 && p1 - this.blTrough >= 0.25 * this.blRef && seq - 1 - this.blLastOnset >= 6) {
      if (seq - 1 - this.blKickSeq >= 6) { this.blOnsets[this.blOnsetPos] = seq - 1; this.blOnsetPos = (this.blOnsetPos + 1) & 31; }
      this.blLastOnset = seq - 1;
      this.blRef += (p1 - this.blRef) * 0.1;
      this.blTrough = p1;
    } else if (this.blRef > 0.05) this.blRef *= 0.999;
    this.blPrev2 = p1; this.blPrev1 = v;
    let n = 0; for (let i = 0; i < 32; i++) if (seq - this.blOnsets[i] <= 200 && this.blOnsets[i] > 0) n++;
    const beats2s = (this.hop.bpm > 0 ? this.hop.bpm : 120) / 30;
    const opb = n / beats2s;
    this.o.onsetsPerBeat = opb;
    const raw = Math.max(0, Math.min(1, (opb - 0.4) / 0.8));
    this.o.bassline += (raw - this.o.bassline) * 0.01;
  }
}
