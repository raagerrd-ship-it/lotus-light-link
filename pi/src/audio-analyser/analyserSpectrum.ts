/**  SPEKTRUM (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserSpectrum.md */
import { Analyser, SECTION_AGG_HOP } from "./analyser.js";
import { SPEC_SLOTS, SPEC_MAX } from './split.js';
import FFT from "fft.js";


export class SpectrumBands {
  a: Analyser;   // analysatorn som äger den här delen
  constructor(a: Analyser) {
    this.a = a;
  }
  fftBig!: FFT;   // DUBBEL-FFT
  windowBig!: Float32Array;
  windowedBig!: Float32Array;   // scratch
  bufferBig!: Float32Array;   // egen glidande buffert
  private bigPos = 0;
  prevMagBig!: Float32Array;   // för per-band flux
  magBig!: Float32Array;   // scratch magnitud
  magBigMax = 0;   // högsta bin någon läser
  magBigView!: Float32Array;   // Cachade vyer
  prevMagBigView!: Float32Array;

  specBig!: number[];   // scratch complex
  bandLo: number[] = [];   // bin-start per band
  bandHi: number[] = [];   // bin-slut per band
  bandPeak = new Float32Array(8);   // per-band AGC-peak
  private onsetMed = new Float32Array(8);   // robust glidande median av per-band-fluxen
  private onsetMad = new Float32Array(8);   // robust MAD
  private static readonly ONSET_K = 3.0;   // troskel
  private static readonly FB_K = [385, 475, 313, 1.46, 1.62, 1.8, 2.03, 2.12];   // 2048-medel / snabbt medel, median över 4 ladan-inspelningar
  fbMag = new Float32Array(256); fbPrevMag = new Float32Array(256);
  fbLo = new Int32Array(8); fbHi = new Int32Array(8);
  fbCoef = new Float64Array(3 * 2 * 5);   // per lågband
  private fbState = new Float64Array(3 * 2 * 4);   // x1 x2 y1 y2 per biquad
  private fbPow = new Float64Array(3); private fbPrevAmp = new Float64Array(3); fbA = new Float64Array(3);
  fbAbs = new Float32Array(8); fbDbRaw = new Float32Array(8); fbLvl = new Float32Array(8);  private fbPeak = new Float32Array(8).fill(1e-4); private fbOnMed = new Float32Array(8); private fbOnMad = new Float32Array(8);
  fbAlvl = 0.5; private fbWarm = 0;
  private static readonly BASSON_DELTA = 0.07;   // Basonset-toppplockning
  private static readonly BASSON_AVG = 12; private static readonly BASSON_MAX = 4; private static readonly BASSON_WAIT = 4;
  private bassOnLastPk = -1e9;specRing: Float32Array | null = null;
specCopy = new Float32Array(0);specN = 0;  aBandLvl = 0;
  private onsetWarm = 0;   // Stor-FFT-rutor med signal i rad
  private static readonly ONSET_WARM = 183;
  /** 2048-bufferten som RING. */
  bigRingPush(samples: Float32Array): void {
    const B = this.bufferBig, N = B.length, p = this.bigPos, hop = samples.length, first = N - p;
    if (hop <= first) B.set(samples, p);
    else { B.set(samples.subarray(0, first), p); B.set(samples.subarray(first), 0); }
    this.bigPos = (p + hop) % N;
  }

  /** SNABBA BANDEN. */
  fastBandStep(samples: Float32Array): void {
    const gated = this.a.hGated;
    if (gated) this.fbWarm++; else this.fbWarm = 0;
    const warm = gated && this.fbWarm >= SpectrumBands.ONSET_WARM * Analyser.BIG_EVERY;
    const C = this.fbCoef, S = this.fbState, n = samples.length;
    for (let b = 0; b < 8; b++) {
      let avg: number, fluxN: number;
      if (b < 3) {
        const o1 = b * 10, o2 = o1 + 5, s1 = b * 8, s2 = s1 + 4;
        let x1 = S[s1], x2 = S[s1 + 1], y1 = S[s1 + 2], y2 = S[s1 + 3], u1 = S[s2], u2 = S[s2 + 1], v1 = S[s2 + 2], v2 = S[s2 + 3], pw = 0;
        const a0 = C[o1], a1 = C[o1 + 1], a2 = C[o1 + 2], a3 = C[o1 + 3], a4 = C[o1 + 4];
        const c0 = C[o2], c1 = C[o2 + 1], c2 = C[o2 + 2], c3 = C[o2 + 3], c4 = C[o2 + 4];
        for (let i = 0; i < n; i++) {
          const x = samples[i];
          const y = a0 * x + a1 * x1 + a2 * x2 - a3 * y1 - a4 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y;
          const v = c0 * y + c1 * u1 + c2 * u2 - c3 * v1 - c4 * v2; u2 = u1; u1 = y; v2 = v1; v1 = v;
          pw += v * v;
        }
        S[s1] = x1; S[s1 + 1] = x2; S[s1 + 2] = y1; S[s1 + 3] = y2; S[s2] = u1; S[s2 + 1] = u2; S[s2 + 2] = v1; S[s2 + 3] = v2;
        this.fbPow[b] += (pw / n - this.fbPow[b]) * this.fbA[b];
        avg = Math.sqrt(this.fbPow[b]) * SpectrumBands.FB_K[b];
        const d = avg - this.fbPrevAmp[b]; fluxN = d > 0 ? d : 0; this.fbPrevAmp[b] = avg;
      } else {
        const lo = this.fbLo[b], hi = this.fbHi[b], m = this.fbMag, pm = this.fbPrevMag;
        let sum = 0, fl = 0;
        for (let i = lo; i < hi; i++) { const v = m[i]; sum += v; const d = v - pm[i]; if (d > 0) fl += d; }
        const nb = hi - lo;
        avg = sum / nb * SpectrumBands.FB_K[b]; fluxN = fl / nb * SpectrumBands.FB_K[b];
      }
      this.fbAbs[b] = avg;
      if (b >= 3) this.fbDbRaw[b] = 20 * Math.log10(avg + 1e-7);
      const minPeak = this.a.lvlSmooth * 0.15;
      if (gated && avg > this.fbPeak[b]) this.fbPeak[b] = Math.max(avg, minPeak);
      else this.fbPeak[b] = Math.max(this.fbPeak[b] * 0.9993, minPeak);
      const lvlRawB = gated ? Math.min(1, avg / (this.fbPeak[b] + 1e-6)) : 0;
      this.fbLvl[b] += (lvlRawB - this.fbLvl[b]) * this.fbAlvl;
      const oStep = 0.002;
      const dOMed = fluxN - this.fbOnMed[b];
      this.fbOnMed[b] += (dOMed > 0 ? 1 : dOMed < 0 ? -1 : 0) * oStep * (this.fbOnMed[b] + 0.01);
      const dOMad = Math.abs(fluxN - this.fbOnMed[b]) - this.fbOnMad[b];
      this.fbOnMad[b] += (dOMad > 0 ? 1 : dOMad < 0 ? -1 : 0) * oStep * (this.fbOnMad[b] + 0.01);
      if (this.fbOnMed[b] < 0) this.fbOnMed[b] = 0;
      if (this.fbOnMad[b] < 0) this.fbOnMad[b] = 0;
      const oThr = this.fbOnMed[b] + SpectrumBands.ONSET_K * this.fbOnMad[b];
      this.a.fbOn[b] = warm ? Math.max(0, Math.min(1, (fluxN - oThr) / Math.max(1e-6, this.fbOnMad[b] * 3))) : 0;
    }
    { const t = this.fbPrevMag; this.fbPrevMag = this.fbMag; this.fbMag = t; }
  }

  /** Decimerad stor-FFT. */
  bigStep(): void {
    this.a.bigCounter = 0;
    { const buf = this.bufferBig, w = this.windowBig, out = this.windowedBig, B = buf.length, p = this.bigPos, n1 = B - p;
      for (let i = 0; i < n1; i++) out[i] = buf[p + i] * w[i];
      for (let i = n1; i < B; i++) out[i] = buf[i - n1] * w[i]; }
    this.fftBig.realTransform(this.specBig, this.windowedBig);
    const specBig = this.specBig, magBig = this.magBig, magMax = this.magBigMax;
    for (let i = 0; i < magMax; i++) {
      const re = specBig[2 * i], im = specBig[2 * i + 1];
      magBig[i] = Math.sqrt(re * re + im * im);
    }

    if (this.a.bigOn) { const k = ++this.specN, R = this.specRing!, o = (k % SPEC_SLOTS) * SPEC_MAX; R.set(this.magBigView.subarray(0, this.specCopy.length), o); }
    else this.a.specSink?.(this.magBigView, this.a.cfg.audio.rate / this.bufferBig.length);
    const gated = this.a.activeMs > 0;


    if (gated) this.onsetWarm++; else this.onsetWarm = 0;

    const bandLo = this.bandLo, bandHi = this.bandHi;
    const prevMagBig = this.prevMagBig;
    if (!SECTION_AGG_HOP) {
      const lo = bandLo[0], hi = bandHi[2]; let o = 0;
      for (let i = lo; i < hi; i++) { const d = 20 * Math.log10((magBig[i] + 1e-6) / (prevMagBig[i] + 1e-6)); if (d > 0) o += d; }
      o /= Math.max(1, hi - lo);
      const L = Analyser.BASSON_LEN, R = this.a.bassOnRing, n = this.a.bassOnN, A = SpectrumBands.BASSON_AVG;
      R[n % L] = o; this.a.bassOnN = n + 1;
      if (n >= 2 * A) {
        const c = n - A; const xc = R[c % L]; let ok = true;
        for (let k = 1; k <= SpectrumBands.BASSON_MAX && ok; k++) if (R[(c - k) % L] > xc) ok = false;
        if (ok) { let s = 0; for (let k = c - A; k <= n; k++) s += R[k % L]; if (xc < s / (2 * A + 1) + SpectrumBands.BASSON_DELTA) ok = false; }
        if (ok && c - this.bassOnLastPk > SpectrumBands.BASSON_WAIT) { this.bassOnLastPk = c; this.a.bassOnPeak = true; }
      }
    }
    for (let b = 0; b < 8; b++) {
      const lo = bandLo[b], hi = bandHi[b];
      const nb = Math.max(1, hi - lo);
      let sum = 0, fl = 0;
      for (let i = lo; i < hi; i++) {
        const m = magBig[i];
        sum += m;
        const d = m - prevMagBig[i];
        if (d > 0) fl += d;
      }
      const avg = sum / nb;
      this.a.bandAbs[b] = avg;
      const db = 20 * Math.log10(avg + 1e-7);
      this.a.bandDbRaw[b] = db;
      this.a.secSpecDirty = true;
      const minPeak = this.a.lvlSmooth * 0.15;
      if (gated && avg > this.bandPeak[b]) this.bandPeak[b] = Math.max(avg, minPeak);
      else this.bandPeak[b] = Math.max(this.bandPeak[b] * Analyser.PEAK_DECAY, minPeak);
      const lvlRawB = gated ? Math.min(1, avg / (this.bandPeak[b] + 1e-6)) : 0;
      this.a.bandLvl[b] += (lvlRawB - this.a.bandLvl[b]) * this.aBandLvl;
      const fluxN = fl / nb;
      const oStep = 0.002 * Analyser.BIG_EVERY;
      const dOMed = fluxN - this.onsetMed[b];
      this.onsetMed[b] += (dOMed > 0 ? 1 : dOMed < 0 ? -1 : 0) * oStep * (this.onsetMed[b] + 0.01);
      const dOMad = Math.abs(fluxN - this.onsetMed[b]) - this.onsetMad[b];
      this.onsetMad[b] += (dOMad > 0 ? 1 : dOMad < 0 ? -1 : 0) * oStep * (this.onsetMad[b] + 0.01);
      if (this.onsetMed[b] < 0) this.onsetMed[b] = 0;
      if (this.onsetMad[b] < 0) this.onsetMad[b] = 0;
      const oThr = this.onsetMed[b] + SpectrumBands.ONSET_K * this.onsetMad[b];
      this.a.bandOn[b] = (gated && this.onsetWarm >= SpectrumBands.ONSET_WARM)
        ? Math.max(0, Math.min(1, (fluxN - oThr) / Math.max(1e-6, this.onsetMad[b] * 3)))
        : 0;
    }
    { const t = this.prevMagBig; this.prevMagBig = this.magBig; this.magBig = t;
      const v = this.prevMagBigView; this.prevMagBigView = this.magBigView; this.magBigView = v; }
  }
}
