/**  LILLA FFT:N (utbruten ur analyser.ts 2026-11-22). Anteckningar: docs/analysator/analyserFft.md */
import { stabilise, type Ser, type FftOut } from "./analyserFack.js";
import FFT from "fft.js";

/** DET LILLA FFT:N LÄSER. Inget annat går att nå. Bara huvudtråden. */
export interface FftReads {
  hop:   Ser<'S', 'hop', 'cfg' | 'dtHop'>;
  level: Ser<'S', 'level', 'gain'>;
}

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export class SmallFft {
  private readonly h: FftReads['hop']; private readonly lv: FftReads['level'];
  constructor(r: FftReads, private readonly o: FftOut) {   // läser: r, lämnar ut: o
    this.h = r.hop; this.lv = r.level;
    stabilise(this, ['sumSq']);
  }
  private static readonly ONSET_PEAK_FLOOR = 0.05;
  private fft!: FFT;
  private window!: Float32Array;
  private buffer!: Float32Array;   // glidande fönster
  private onsetPrev!: Float32Array;
  private onsetPeakReady = false;
  private windowed512!: Float32Array;   // scratch
  private spectrum512!: number[];
  private sumSq = 0;   // löpande kvadratsumma över fönstret
  private rmsRecalc = 0;
  private fbMax = 0;   // spektrumets högsta snabba bin + 1
  private aAtt = 0; private aRel = 0;

  /** Konstruktorn: fönstret, FFT:n, takterna. fbTop = spektrumets högsta snabba bin + 1. */
  init(fbTop: number): void {
    const n = this.h.cfg.fft.size, half = n / 2, dtHop = this.h.dtHop;
    this.fft = new FFT(n);
    this.window = hannWindow(n);
    this.buffer = new Float32Array(n);
    this.onsetPrev = new Float32Array(half);
    this.windowed512 = new Float32Array(n);
    this.spectrum512 = this.fft.createComplexArray();
    this.fbMax = Math.min(half, fbTop);
    if (this.o.fbMag.length < half) { this.o.fbMag = new Float32Array(half); this.o.fbPrevMag = new Float32Array(half); }
    this.aAtt = 1 - Math.exp(-dtHop / 0.015);
    this.aRel = 1 - Math.exp(-dtHop / 0.4);
  }

  /** Hoppet: fönstret (rms), 512-FFT:n (flöde, kickflöde, energi, centroid, snabba bandens magnitud), utjämningen av energi och centroid. */
  hopStep(samples: Float32Array): void {
    const o = this.o;
    const hop = samples.length;
    let ss = this.sumSq;
    for (let i = 0; i < hop; i++) { const v = this.buffer[i]; ss -= v * v; }
    this.buffer.copyWithin(0, hop);
    this.buffer.set(samples, this.buffer.length - hop);
    for (let i = this.buffer.length - hop; i < this.buffer.length; i++) { const v = this.buffer[i]; ss += v * v; }
    if (++this.rmsRecalc >= 400 || ss < 0) {
      this.rmsRecalc = 0; ss = 0;
      for (let i = 0; i < this.buffer.length; i++) { const v = this.buffer[i]; ss += v * v; }
    }
    this.sumSq = ss;
    o.rms = Math.sqrt(ss / this.buffer.length);

    const windowed = this.windowed512;
    { const buf = this.buffer, win = this.window; for (let i = 0; i < windowed.length; i++) windowed[i] = buf[i] * win[i]; }
    const spectrum = this.spectrum512;
    this.fft.realTransform(spectrum, windowed);

    const half = this.h.cfg.fft.size / 2;
    let bassEnergy = 0;
    let flux = 0;
    let kickFlux = 0;
    let powSum = 0, powW = 0;
    const bassBins = Math.min(16, half);
    const kickBins = Math.min(1, half);
    const enhancedOnset = this.h.cfg.onset.enhancements;

    { const t = o.fbPrevMag; o.fbPrevMag = o.fbMag; o.fbMag = t; }   // spektrumets snabba band läser fbMag (nu) och fbPrevMag (förra hoppet)
    const fbMax = this.fbMax, fbMag = o.fbMag;
    const onsetPrev = this.onsetPrev, peakReady = this.onsetPeakReady, PFLOOR = SmallFft.ONSET_PEAK_FLOOR;
    for (let i = 0; i < bassBins; i++) {
      const re = spectrum[2 * i];
      const im = spectrum[2 * i + 1];
      const p = re * re + im * im;
      const m = Math.sqrt(p);
      bassEnergy += m;
      let onsetMag = m;
      if (enhancedOnset) {
        const compressed = Math.log1p(m);
        onsetMag = peakReady ? compressed / Math.max(PFLOOR, compressed) : 0;   // toppen = hoppets eget värde
      }
      const dd = onsetMag - onsetPrev[i];
      onsetPrev[i] = onsetMag;
      if (dd > 0) { flux += dd; if (i < kickBins) kickFlux += dd; }
      powSum += p; powW += i * p;
      if (i < fbMax) fbMag[i] = m;
    }
    const fbEnd = Math.max(bassBins, Math.min(fbMax, half));
    for (let i = bassBins; i < fbEnd; i++) {
      const re = spectrum[2 * i], im = spectrum[2 * i + 1], p = re * re + im * im;
      powSum += p; powW += i * p;
      fbMag[i] = Math.sqrt(p);
    }
    for (let i = fbEnd; i < half; i++) {
      const re = spectrum[2 * i], im = spectrum[2 * i + 1], p = re * re + im * im;
      powSum += p; powW += i * p;
    }
    this.onsetPeakReady = true;
    const energy = Math.min(1, (bassEnergy / bassBins) * 0.02 * this.lv.gain);
    const centroid = powSum > 1e-12 ? Math.min(1, Math.sqrt(1.47 * (powW / powSum) / half)) : 0;
    o.flux = Math.min(1, flux * (enhancedOnset ? 0.08 : 0.005));
    o.kickFlux = kickFlux; o.energy = energy;
    const e = o.engSmooth, c = o.centSmooth;   // asymmetrisk utjämning (stiger 15 ms, faller 400 ms)
    o.engSmooth = e + (energy - e) * (energy > e ? this.aAtt : this.aRel);
    o.centSmooth = c + (centroid - c) * (centroid > c ? this.aAtt : this.aRel);
  }
}
