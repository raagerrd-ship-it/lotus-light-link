/**
 * Audio analyser — portable, framework-agnostic.
 *
 * ⚠️  MIRROR — DO NOT EDIT DIRECTLY.
 * Master: DMX Control / pi-dmx/engine/src/analyser.ts.
 * Ändra där, re-synka hit. Se README.md ("Source of truth").
 * Senast synkad: 2026-07-19.
 *
 * Feed hop-sized mono Float32 samples via process(samples). Returns a Frame
 * with level, kick, per-band spectrum/onset, BPM, drop/riser, intensity,
 * character profile.
 *
 * Design: two parallel FFTs
 *   - 512  @ every hop  → timing (RMS, kick, flux, BPM)
 *   - 2048 @ every 3rd hop → 8-band spectrum + per-band onsets (23 Hz/bin)
 *
 * Extracted from DMX Control's engine. Kept semantically identical; the
 * only change is that EngineConfig has been replaced by a small
 * AnalyserConfig so this module has no cross-project coupling.
 */

import FFT from "fft.js";

export interface AnalyserConfig {
  sampleRate: number;      // e.g. 48000
  hopSize: number;         // e.g. 480 (→ 100 Hz frame rate @ 48k)
  autoGainTarget?: number; // default 0.15
  tauUp?: number;          // seconds to raise gain, default 3
  tauDown?: number;        // seconds to lower gain, default 8
  noiseFloor?: number;     // default 0.002
}

/** External beat-grid gate (from a PLL). Optional — set null to disable. */
export interface BeatGrid { bpm: number; anchorMs: number; }

export interface Spectrum {
  sub: number; kick: number; bass: number; lowMid: number;
  mid: number; highMid: number; treble: number; air: number;
}

export interface Frame {
  level: number; levelRaw: number; levelVU: number;
  energy: number; mid: number; treble: number;
  centroid: number; flux: number;
  kick: boolean;
  gain: number;
  bpm: number; bpmConfidence: number;
  intensity: number;
  dropCount: number;
  inZone: boolean; breaking: boolean;
  buildUp: number; inRiser: boolean;
  profile: { punch: number; bass: number; bright: number; beat: number };
  beatAnchorMs: number;
  spec: Spectrum;
  onset: Spectrum;
  drum: { kick: number; snare: number; hat: number; bass: number };
}

function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export class Analyser {
  // Config
  private sampleRate: number;
  private hopSize: number;
  private fftSize = 512;
  private autoGainTarget: number;
  private tauUp: number;
  private tauDown: number;
  private noiseFloor: number;
  private beatGrid: BeatGrid | null = null;

  // Small FFT (512)
  private fft: FFT;
  private window: Float32Array;
  private buffer: Float32Array;
  private prevMag: Float32Array;
  private windowed512!: Float32Array;
  private spectrum512!: number[];
  private mag512!: Float32Array;

  // Output objects (reused; muted per hop)
  private outSpec: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outOnset: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outDrum = { kick: 0, snare: 0, hat: 0, bass: 0 };
  private outProfile = { punch: 0.4, bass: 0.5, bright: 0.3, beat: 0.5 };
  private outFrame!: Frame;

  // Kit envelopes
  private hatHit = 0;
  private snareHit = 0;
  private kickHit = 0;

  // Large FFT (2048)
  private fftBig!: FFT;
  private windowBig!: Float32Array;
  private windowedBig!: Float32Array;
  private bufferBig!: Float32Array;
  private prevMagBig!: Float32Array;
  private magBig!: Float32Array;
  private specBig!: number[];
  private static readonly BAND_HZ = [20, 60, 120, 250, 500, 2000, 5000, 10000, 16000];
  private bandLo: number[] = [];
  private bandHi: number[] = [];
  private bandPeak = new Float32Array(8);
  private onsetMed = new Float32Array(8);
  private onsetMad = new Float32Array(8);
  private static readonly ONSET_K = 3.0;
  private bandLvl = new Float32Array(8);
  private bandLvlSm = new Float32Array(8);
  private bandOn = new Float32Array(8);
  private bigCounter = 0;
  private static readonly BIG_EVERY = 3;

  // Kick detection
  private kickMed = 0.1;
  private kickMad = 0.05;
  private kickSeed = 0;
  private kickWasAbove = false;
  private kickPrimed = false;

  // BPM
  private static readonly ENV_HZ = 100;
  private static readonly ENV_LEN = 100 * 5;
  private envRing = new Float32Array(Analyser.ENV_LEN);
  private envPos = 0;
  private envFilled = 0;
  private envAccum = 0;
  private envAccumT = 0;
  private bpmCounter = 0;
  private localBpm = 0;
  private localBpmConfidence = 0;
  private static readonly BPM_MIN = 80;
  private static readonly BPM_MAX = 160;
  private octaveVote = 0;
  private bpmStable = 0;
  private newSongVote = 0;
  private bpmHist: number[] = [];
  private envScratch = new Float32Array(Analyser.ENV_LEN);
  private envPosScratch = new Float32Array(Analyser.ENV_LEN);
  private acScratch = new Float32Array(Analyser.ENV_LEN);
  private pulseScratch = new Float32Array(Analyser.ENV_LEN);
  private silentMs = 0;
  private beatAnchorMs = 0;
  private kfPrev = 0;
  private kfPrev2 = 0;
  private pendingKickMs = 0;

  // Gain
  private gain = 1;
  private gainLocked = false;
  private envelope: number;
  private lastKick = 0;
  private lastT = performance.now();

  // Smoothed
  private lvlSmooth = 0;
  private intensityEma = 0.5;
  private intensityFloor = 0.5;
  private intensitySpread = 0.05;
  private activeMs = 0;
  private levelCeil = 0.5;
  private breakAtMs = 0;
  private lastRiserMs = 0;
  private breakHoldMs = 0;
  private inZoneState = false;
  private wasInZone = false;
  private dropCount = 0;
  private lastDropMs = -1e9;
  private specSlow = new Float32Array(8);
  private novSlow = 0;
  private novBaseline = 0.2;
  private centSlow = 0.3;
  private lvlSlowR = 0.3;
  private buildUp = 0;
  private profPunch = 0.4;
  private profBass = 0.5;
  private profBright = 0.3;
  private profBeat = 0.5;
  private lvlVU = 0;
  private engSmooth = 0;
  private midSmooth = 0;
  private trbSmooth = 0;
  private centSmooth = 0.5;

  constructor(cfg: AnalyserConfig) {
    this.sampleRate = cfg.sampleRate;
    this.hopSize = cfg.hopSize;
    this.autoGainTarget = cfg.autoGainTarget ?? 0.15;
    this.tauUp = cfg.tauUp ?? 3;
    this.tauDown = cfg.tauDown ?? 8;
    this.noiseFloor = cfg.noiseFloor ?? 0.002;

    this.fft = new FFT(this.fftSize);
    this.window = hannWindow(this.fftSize);
    this.buffer = new Float32Array(this.fftSize);
    this.prevMag = new Float32Array(this.fftSize / 2);
    this.windowed512 = new Float32Array(this.fftSize);
    this.spectrum512 = this.fft.createComplexArray();
    this.mag512 = new Float32Array(this.fftSize / 2);
    this.envelope = this.autoGainTarget;

    const BIG = 2048;
    this.fftBig = new FFT(BIG);
    this.windowBig = hannWindow(BIG);
    this.windowedBig = new Float32Array(BIG);
    this.bufferBig = new Float32Array(BIG);
    this.prevMagBig = new Float32Array(BIG / 2);
    this.magBig = new Float32Array(BIG / 2);
    this.specBig = this.fftBig.createComplexArray();
    const binHzBig = this.sampleRate / BIG;
    for (let b = 0; b < 8; b++) {
      this.bandLo[b] = Math.max(1, Math.round(Analyser.BAND_HZ[b] / binHzBig));
      this.bandHi[b] = Math.min(BIG / 2, Math.round(Analyser.BAND_HZ[b + 1] / binHzBig));
      this.bandPeak[b] = 1e-4;
    }

    this.outFrame = {
      level: 0, levelRaw: 0, levelVU: 0, energy: 0, mid: 0, treble: 0, centroid: 0, flux: 0,
      kick: false, gain: 1, bpm: 0, bpmConfidence: 0, intensity: 0.5,
      dropCount: 0, inZone: false, breaking: false, buildUp: 0, inRiser: false,
      profile: this.outProfile, beatAnchorMs: 0,
      spec: this.outSpec, onset: this.outOnset, drum: this.outDrum,
    };
  }

  resetGain(startGain = 1) {
    this.gain = Math.max(0.5, Math.min(20, startGain));
    this.envelope = 0;
  }

  setGainLock(locked: boolean, fixed = 1) {
    this.gainLocked = locked;
    if (locked) { this.gain = fixed; this.envelope = 0; }
  }

  /** Optional external beat grid (PLL). Null = no grid gate on kicks. */
  setBeatGrid(grid: BeatGrid | null) { this.beatGrid = grid; }

  private computeBpm() {
    if (this.envFilled < 50) return;
    const N = this.envFilled;
    const env = this.envScratch;
    let mean = 0;
    const start = (this.envPos - N + Analyser.ENV_LEN) % Analyser.ENV_LEN;
    for (let i = 0; i < N; i++) { env[i] = this.envRing[(start + i) % Analyser.ENV_LEN]; mean += env[i]; }
    mean /= N;
    for (let i = 0; i < N; i++) env[i] -= mean;
    const HZ = Analyser.ENV_HZ;
    const lagMin = Math.floor(HZ * 60 / 185);
    const lagMax = Math.min(N - 1, Math.floor(HZ * 60 / 55));
    const ac = this.acScratch;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let sum = 0;
      const M = N - lag;
      for (let i = 0; i < M; i++) sum += env[i] * env[i + lag];
      ac[lag] = sum / M;
    }
    const envPos = this.envPosScratch;
    for (let i = 0; i < N; i++) envPos[i] = env[i] > 0 ? env[i] : 0;
    const pulse = this.pulseScratch;
    let pulseMax = 1e-9, combMax = 1e-9;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let best = 0;
      for (let ph = 0; ph < lag; ph++) {
        let s = 0, k = 0;
        for (let i = ph; i < N; i += lag) { s += envPos[i]; k++; }
        if (k > 0) { const norm = s / k; if (norm > best) best = norm; }
      }
      pulse[lag] = best;
      if (best > pulseMax) pulseMax = best;
      let comb = ac[lag];
      if (2 * lag <= lagMax) comb += 0.5 * ac[2 * lag];
      if (3 * lag <= lagMax) comb += 0.33 * ac[3 * lag];
      if (comb > combMax) combMax = comb;
    }
    let bestLag = 0, bestVal = 0;
    let scoreSum = 0, scoreCount = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let comb = ac[lag];
      if (2 * lag <= lagMax) comb += 0.5 * ac[2 * lag];
      if (3 * lag <= lagMax) comb += 0.33 * ac[3 * lag];
      const combN = comb / combMax;
      const pulseN = pulse[lag] / pulseMax;
      const bpmAt = (HZ * 60) / lag;
      const oct = Math.log2(bpmAt / 120);
      const prior = Math.exp(-(oct * oct) / 2.0);
      const score = (0.5 * combN + 0.5 * pulseN) * prior;
      scoreSum += score; scoreCount++;
      if (score > bestVal) { bestVal = score; bestLag = lag; }
    }
    if (bestLag === 0 || bestVal <= 0) return;
    const meanScore = scoreSum / Math.max(1, scoreCount);
    const rawConf = meanScore > 0 ? 1 - meanScore / bestVal : 0;
    const conf = Math.max(0, Math.min(1, (rawConf - 0.35) / 0.40));
    const P = bestLag * 2;
    if (P <= lagMax) {
      let bestPhase = 0, bestPhaseSum = -1;
      for (let ph = 0; ph < P; ph++) {
        let s = 0; for (let i = ph; i < N; i += P) s += envPos[i];
        if (s > bestPhaseSum) { bestPhaseSum = s; bestPhase = ph; }
      }
      let onE = 0, offE = 0, offC = 0;
      const offPh = (bestPhase + bestLag) % P;
      for (let i = bestPhase; i < N; i += P) onE += envPos[i];
      for (let i = offPh;    i < N; i += P) { offE += envPos[i]; offC++; }
      let posMean = 0; for (let i = 0; i < N; i++) posMean += envPos[i]; posMean /= N;
      const offAvg = offC > 0 ? offE / offC : 0;
      if (onE > 0 && offE < onE * 0.45 && offAvg < posMean * 1.2) bestLag = P;
    }
    let lagF = bestLag;
    if (bestLag > lagMin && bestLag + 1 <= lagMax) {
      const acAt = (L: number) => { let s = 0; for (let i = 0; i + L < N; i++) s += env[i] * env[i + L]; return s; };
      const yl = acAt(bestLag - 1), y0 = acAt(bestLag), yr = acAt(bestLag + 1);
      const den = yl - 2 * y0 + yr;
      if (den < 0) { const d = 0.5 * (yl - yr) / den; if (Math.abs(d) < 1) lagF = bestLag + d; }
    }
    let bpm = (HZ * 60) / lagF;
    while (bpm < Analyser.BPM_MIN) bpm *= 2;
    while (bpm >= Analyser.BPM_MAX) bpm /= 2;
    this.bpmHist.push(bpm);
    if (this.bpmHist.length > 20) this.bpmHist.shift();
    const sorted = [...this.bpmHist].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    if (this.localBpm === 0) {
      this.localBpm = Math.round(med);
      this.octaveVote = 0;
      this.bpmStable = 0;
    } else {
      const committed = this.bpmStable >= 60;
      const ratio = med / this.localBpm;
      if (ratio >= 0.9 && ratio <= 1.11) {
        this.localBpm = Math.round(this.localBpm + (med - this.localBpm) * 0.35);
        this.octaveVote *= 0.5;
        this.newSongVote *= 0.5;
        if (this.bpmStable < 100000) this.bpmStable++;
      } else if (!committed && ratio > 1.4) {
        this.octaveVote = Math.max(0, this.octaveVote) + 1;
        if (this.octaveVote >= 8) { this.localBpm = Math.round(med); this.octaveVote = 0; this.bpmStable = 0; }
      } else if (!committed && ratio < 0.7) {
        this.octaveVote = Math.min(0, this.octaveVote) - 1;
        if (this.octaveVote <= -8) { this.localBpm = Math.round(med); this.octaveVote = 0; this.bpmStable = 0; }
      } else {
        this.octaveVote *= 0.7;
        if (committed && ++this.newSongVote >= 100) {
          this.localBpm = Math.round(med);
          this.newSongVote = 0;
          this.octaveVote = 0;
          this.bpmStable = 0;
        }
      }
    }
    const cA = this.localBpmConfidence;
    this.localBpmConfidence = cA + (conf - cA) * (conf > cA ? 0.35 : 0.08);
  }

  /** Feed a hop-sized chunk of mono samples, get a Frame back. */
  process(samples: Float32Array): Frame {
    const hop = samples.length;
    this.buffer.copyWithin(0, hop);
    this.buffer.set(samples, this.buffer.length - hop);

    const windowed = this.windowed512;
    for (let i = 0; i < windowed.length; i++) windowed[i] = this.buffer[i] * this.window[i];
    const spectrum = this.spectrum512;
    this.fft.realTransform(spectrum, windowed);

    let sumSq = 0;
    for (let i = 0; i < this.buffer.length; i++) sumSq += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sumSq / this.buffer.length);

    const half = this.fftSize / 2;
    const mag = this.mag512;
    let bassEnergy = 0, midEnergy = 0, trebleEnergy = 0;
    let flux = 0, kickFlux = 0;
    let magSum = 0, magW = 0;
    const binHz = this.sampleRate / this.fftSize;
    const bassBins = Math.min(16, half);
    const kickBins = Math.min(3, half);
    const trebleStart = Math.min(half - 1, Math.round(5000 / binHz));
    const trebleEnd = Math.min(half, Math.round(13000 / binHz));
    for (let i = 0; i < half; i++) {
      const re = spectrum[2 * i];
      const im = spectrum[2 * i + 1];
      mag[i] = Math.sqrt(re * re + im * im);
      if (i < bassBins) {
        bassEnergy += mag[i];
        const d = mag[i] - this.prevMag[i];
        if (d > 0) { flux += d; if (i < kickBins) kickFlux += d; }
      } else if (i < trebleStart) {
        midEnergy += mag[i];
      } else if (i < trebleEnd) {
        trebleEnergy += mag[i];
      }
      magSum += mag[i]; magW += i * mag[i];
    }
    { const t = this.prevMag; this.prevMag = this.mag512; this.mag512 = t; }
    const energy = Math.min(1, (bassEnergy / bassBins) * 0.02 * this.gain);
    const mid = Math.min(1, (midEnergy / Math.max(1, trebleStart - bassBins)) * 0.025 * this.gain);
    const treble = Math.min(1, (trebleEnergy / Math.max(1, trebleEnd - trebleStart)) * 0.04 * this.gain);
    const centroid = magSum > 1e-6 ? Math.min(1, (magW / magSum) / half) : 0;
    const fluxNorm = Math.min(1, flux * 0.005);

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (!this.gainLocked && rms > this.noiseFloor) {
      const tau = rms * this.gain > this.envelope ? this.tauDown : this.tauUp;
      const a = 1 - Math.exp(-dt / tau);
      this.envelope += (rms * this.gain - this.envelope) * a;
      const desired = (this.autoGainTarget / Math.max(1e-4, this.envelope)) * this.gain;
      const gTau = desired > this.gain ? this.tauUp : this.tauDown;
      const ga = 1 - Math.exp(-dt / gTau);
      this.gain += (desired - this.gain) * ga;
      if (this.gain < 0.5) this.gain = 0.5;
      else if (this.gain > 20) this.gain = 20;
    }
    const level = Math.min(1, rms * this.gain);

    if (this.kickSeed < 400) {
      this.kickSeed++;
      this.kickMed += (kickFlux - this.kickMed) * 0.05;
      this.kickMad += (Math.abs(kickFlux - this.kickMed) - this.kickMad) * 0.05;
    } else {
      const kStep = 0.002;
      this.kickMed += Math.sign(kickFlux - this.kickMed) * kStep * (this.kickMed + 0.01);
      this.kickMad += Math.sign(Math.abs(kickFlux - this.kickMed) - this.kickMad) * kStep * (this.kickMad + 0.01);
    }
    const kickThresh = this.kickMed + 4.5 * this.kickMad;
    const KICK_COOLDOWN = 170;
    let above = kickFlux > kickThresh && energy > 0.06;
    const grid = this.beatGrid;
    if (above && grid && grid.bpm > 40 && this.localBpmConfidence > 0.5) {
      const beatMs = 60000 / grid.bpm;
      const gridMs = beatMs / 2;
      const offset = ((now - grid.anchorMs) % gridMs + gridMs) % gridMs;
      const distToGrid = Math.min(offset, gridMs - offset);
      const tolerance = Math.max(30, beatMs * 0.15);
      if (distToGrid > tolerance) above = false;
    }
    let kick = false;
    if (above && !this.kickWasAbove && now - this.lastKick > KICK_COOLDOWN && this.kickPrimed) {
      kick = true;
      this.lastKick = now;
    }
    this.kickWasAbove = above;
    this.kickPrimed = true;

    const frameMs0 = (this.hopSize / this.sampleRate) * 1000;
    if (rms < this.noiseFloor * 1.5) {
      this.silentMs += frameMs0;
      if (this.silentMs > 350) {
        this.localBpm = 0; this.localBpmConfidence = 0; this.octaveVote = 0;
        this.bpmStable = 0; this.newSongVote = 0; this.envFilled = 0;
        this.beatAnchorMs = 0; this.pendingKickMs = 0; this.bpmHist.length = 0;
      }
    } else {
      this.silentMs = 0;
    }
    const frameMs = frameMs0;
    this.envAccum = Math.max(this.envAccum, fluxNorm);
    this.envAccumT += frameMs;
    if (this.envAccumT >= 1000 / Analyser.ENV_HZ) {
      this.envAccumT -= 1000 / Analyser.ENV_HZ;
      this.envRing[this.envPos] = this.envAccum;
      this.envPos = (this.envPos + 1) % Analyser.ENV_LEN;
      this.envFilled = Math.min(this.envFilled + 1, Analyser.ENV_LEN);
      this.envAccum = 0;
      const stride = this.localBpm === 0 ? 1 : Analyser.ENV_HZ / 4;
      if (++this.bpmCounter >= stride) { this.bpmCounter = 0; this.computeBpm(); }
    }
    if (this.pendingKickMs > 0) {
      const ym1 = this.kfPrev2, y0 = this.kfPrev, yp1 = kickFlux;
      const denom = ym1 - 2 * y0 + yp1;
      if (denom < 0) {
        let delta = 0.5 * (ym1 - yp1) / denom;
        if (delta > 0.5) delta = 0.5; else if (delta < -0.5) delta = -0.5;
        const hopMs = frameMs0;
        this.beatAnchorMs = this.pendingKickMs + delta * hopMs;
      }
      this.pendingKickMs = 0;
    }
    if (kick) { this.beatAnchorMs = Date.now(); this.pendingKickMs = this.beatAnchorMs; }
    this.kfPrev2 = this.kfPrev;
    this.kfPrev = kickFlux;

    const dtHop = this.hopSize / this.sampleRate;
    const aAtt = 1 - Math.exp(-dtHop / 0.015);
    const aRel = 1 - Math.exp(-dtHop / 0.4);
    const smooth = (prev: number, x: number) => prev + (x - prev) * (x > prev ? aAtt : aRel);
    this.lvlSmooth = smooth(this.lvlSmooth, level);
    this.lvlVU += (level - this.lvlVU) * (1 - Math.exp(-dtHop / 0.20));
    this.engSmooth = smooth(this.engSmooth, energy);
    this.midSmooth = smooth(this.midSmooth, mid);
    this.trbSmooth = smooth(this.trbSmooth, treble);
    this.centSmooth = smooth(this.centSmooth, centroid);

    if (rms >= this.noiseFloor * 1.5) this.activeMs += dtHop * 1000;
    else this.activeMs = 0;
    const iUp = 1 - Math.exp(-dtHop / 1.5);
    const iDown = 1 - Math.exp(-dtHop / 3.0);
    this.intensityEma += (this.lvlSmooth - this.intensityEma) * (this.lvlSmooth > this.intensityEma ? iUp : iDown);
    const iWarm = this.activeMs < 8000;
    const floorRate = iWarm ? dtHop / 3 : dtHop / 150;
    if (iWarm) this.intensityFloor += (this.intensityEma - this.intensityFloor) * floorRate;
    else this.intensityFloor += Math.sign(this.intensityEma - this.intensityFloor) * floorRate * (this.intensityFloor + 0.05);
    const dev = this.intensityEma - this.intensityFloor;
    this.intensitySpread += (Math.abs(dev) - this.intensitySpread) * (iWarm ? dtHop / 3 : dtHop / 60);
    const scale = Math.max(0.015, this.intensitySpread) * 4;
    const intensity = Math.max(0, Math.min(1, 0.5 + dev / scale));

    this.bufferBig.copyWithin(0, hop);
    this.bufferBig.set(samples, this.bufferBig.length - hop);
    if (++this.bigCounter >= Analyser.BIG_EVERY) {
      this.bigCounter = 0;
      const bigDt = dtHop * Analyser.BIG_EVERY;
      for (let i = 0; i < this.bufferBig.length; i++) this.windowedBig[i] = this.bufferBig[i] * this.windowBig[i];
      this.fftBig.realTransform(this.specBig, this.windowedBig);
      const halfBig = this.bufferBig.length / 2;
      for (let i = 0; i < halfBig; i++) {
        const re = this.specBig[2 * i], im = this.specBig[2 * i + 1];
        this.magBig[i] = Math.sqrt(re * re + im * im);
      }
      const gated = rms > this.noiseFloor * 1.5;
      for (let b = 0; b < 8; b++) {
        const lo = this.bandLo[b], hi = this.bandHi[b];
        const nb = Math.max(1, hi - lo);
        let sum = 0, fl = 0;
        for (let i = lo; i < hi; i++) {
          sum += this.magBig[i];
          const d = this.magBig[i] - this.prevMagBig[i];
          if (d > 0) fl += d;
        }
        const avg = sum / nb;
        const minPeak = this.lvlSmooth * 0.15;
        if (gated && avg > this.bandPeak[b]) this.bandPeak[b] = Math.max(avg, minPeak);
        else this.bandPeak[b] = Math.max(this.bandPeak[b] * 0.9993, minPeak);
        const lvlRawB = gated ? Math.min(1, avg / (this.bandPeak[b] + 1e-6)) : 0;
        this.bandLvlSm[b] += (lvlRawB - this.bandLvlSm[b]) * (1 - Math.exp(-bigDt / 0.09));
        this.bandLvl[b] = this.bandLvlSm[b];
        const fluxN = fl / nb;
        const oStep = 0.002 * Analyser.BIG_EVERY;
        this.onsetMed[b] += Math.sign(fluxN - this.onsetMed[b]) * oStep * (this.onsetMed[b] + 0.01);
        this.onsetMad[b] += Math.sign(Math.abs(fluxN - this.onsetMed[b]) - this.onsetMad[b]) * oStep * (this.onsetMad[b] + 0.01);
        const oThr = this.onsetMed[b] + Analyser.ONSET_K * this.onsetMad[b];
        this.bandOn[b] = gated ? Math.max(0, Math.min(1, (fluxN - oThr) / Math.max(1e-6, this.onsetMad[b] * 3))) : 0;
      }
      { const t = this.prevMagBig; this.prevMagBig = this.magBig; this.magBig = t; }
    }
    this.hatHit = Math.max(this.hatHit * Math.exp(-dtHop / 0.06), this.bandOn[6]);
    this.snareHit = Math.max(this.snareHit * Math.exp(-dtHop / 0.11), this.bandOn[5]);
    if (kick) this.kickHit = 1;
    else this.kickHit = this.kickHit * Math.exp(-dtHop / 0.15);

    // Drop detection
    const nowWallA = Date.now();
    this.levelCeil = Math.max(this.lvlSmooth, this.levelCeil - dtHop * 0.015 * this.levelCeil);
    const breaking = this.lvlSmooth < this.levelCeil * 0.65;
    if (breaking) {
      this.breakHoldMs += dtHop * 1000;
      if (this.breakHoldMs > 400) this.breakAtMs = nowWallA;
    } else {
      this.breakHoldMs = 0;
    }
    if (this.lvlSmooth > this.levelCeil * 0.85 && this.lvlSmooth > 0.65) this.inZoneState = true;
    else if (this.lvlSmooth < this.levelCeil * 0.70) this.inZoneState = false;
    const inZone = this.inZoneState;
    const hadBreak = nowWallA - this.breakAtMs < 3500;
    const hadRiser = nowWallA - this.lastRiserMs < 4000;
    const dropEnergyOk = intensity > 0.45;
    const minGapMs = this.localBpm > 40 ? (32 * 60000 / this.localBpm) : 13000;
    const dropSpacingOk = nowWallA - this.lastDropMs > minGapMs;
    if (dropEnergyOk && dropSpacingOk && inZone && !this.wasInZone && (hadBreak || hadRiser) && this.activeMs > 2000) {
      this.dropCount++; this.lastDropMs = nowWallA;
    }
    this.wasInZone = inZone;

    // Riser
    let nov = 0; const sr = 1 - Math.exp(-dtHop / 2.0);
    for (let b = 0; b < 8; b++) { this.specSlow[b] += (this.bandLvl[b] - this.specSlow[b]) * sr; nov += Math.max(0, this.bandLvl[b] - this.specSlow[b]); }
    this.novSlow += (nov - this.novSlow) * (1 - Math.exp(-dtHop / 1.5));
    this.novBaseline += (this.novSlow - this.novBaseline) * (dtHop / 8);
    const novRiser = this.novSlow > this.novBaseline + 0.15 && this.novSlow > 0.45;
    this.centSlow += (this.centSmooth - this.centSlow) * (dtHop / 2.5);
    this.lvlSlowR += (this.lvlSmooth - this.lvlSlowR) * (dtHop / 2.5);
    const inRiser = this.activeMs > 2500 && this.lvlSmooth > 0.3 && nowWallA - this.lastDropMs > 1500 && (
        novRiser
        || (this.centSmooth > this.centSlow + 0.06 && this.lvlSmooth > this.lvlSlowR + 0.04 && this.lvlSmooth > 0.4)
      );
    if (inRiser) this.lastRiserMs = nowWallA;
    const bTarget = inRiser ? 1 : 0;
    const bRate = bTarget > this.buildUp ? dtHop / 3.5 : dtHop / 1.0;
    this.buildUp += Math.max(-bRate, Math.min(bRate, bTarget - this.buildUp));

    // Character profile
    let bSum = 1e-6; for (let b = 0; b < 8; b++) bSum += this.bandLvl[b];
    const bassW = (this.bandLvl[0] + this.bandLvl[1] + this.bandLvl[2]) / bSum;
    const brightW = (this.bandLvl[6] + this.bandLvl[7]) / bSum;
    const punchNow = Math.min(1, (this.bandOn[1] + this.bandOn[5] + this.bandOn[6]) * 0.8);
    const pr = 1 - Math.exp(-dtHop / 8.0);
    this.profPunch += (punchNow - this.profPunch) * pr;
    this.profBass += (bassW - this.profBass) * pr;
    this.profBright += (brightW - this.profBright) * pr;
    this.profBeat += (this.localBpmConfidence - this.profBeat) * pr;
    const cl = (x: number) => x < 0 ? 0 : x > 1 ? 1 : x;
    this.outProfile.punch = cl((this.profPunch - 0.05) / 0.40);
    this.outProfile.bass = cl((this.profBass - 0.28) / 0.30);
    this.outProfile.bright = cl((this.profBright - 0.14) / 0.19);
    this.outProfile.beat = cl(this.profBeat);

    const L = this.bandLvl, O = this.bandOn;
    const spec = this.outSpec, onset = this.outOnset;
    spec.sub = L[0]; spec.kick = L[1]; spec.bass = L[2]; spec.lowMid = L[3];
    spec.mid = L[4]; spec.highMid = L[5]; spec.treble = L[6]; spec.air = L[7];
    onset.sub = O[0]; onset.kick = O[1]; onset.bass = O[2]; onset.lowMid = O[3];
    onset.mid = O[4]; onset.highMid = O[5]; onset.treble = O[6]; onset.air = O[7];
    const dr = this.outDrum;
    dr.kick = this.kickHit; dr.snare = this.snareHit; dr.hat = this.hatHit; dr.bass = L[2];

    const f = this.outFrame;
    f.level = this.lvlSmooth; f.levelRaw = level; f.levelVU = this.lvlVU;
    f.energy = this.engSmooth; f.mid = this.midSmooth; f.treble = this.trbSmooth;
    f.centroid = this.centSmooth; f.flux = fluxNorm; f.kick = kick; f.gain = this.gain;
    f.bpm = this.localBpm; f.bpmConfidence = this.localBpmConfidence;
    f.intensity = intensity; f.beatAnchorMs = this.beatAnchorMs;
    f.dropCount = this.dropCount; f.inZone = inZone; f.breaking = breaking;
    f.buildUp = this.buildUp; f.inRiser = inRiser;
    return f;
  }
}
