/**
 * ALSA microphone input via node-record-lpcm16 → FFT → BandResult.
 * Replaces Web Audio API AnalyserNode on Raspberry Pi.
 * Uses custom zero-alloc radix-2 FFT (no fft-js dependency).
 * 
 * Event-driven: fires onFFTReady callback immediately after each FFT frame,
 * enabling the engine to process with zero additional latency.
 */

import record from 'node-record-lpcm16';
import { fft1024, FFT_N } from './fftRadix2.js';

export interface BandResult {
  bassRms: number;
  midHiRms: number;
  totalRms: number;
  flux: number;
}

const SAMPLE_RATE = 44100;
const FFT_SIZE = FFT_N; // 1024
const BIN_COUNT = FFT_SIZE / 2;
const BIN_WIDTH = SAMPLE_RATE / FFT_SIZE;

// Pre-computed Hann window (~6% more energy than Blackman, minimal spectral leakage)
const hannWindow = new Float64Array(FFT_SIZE);
{
  for (let i = 0; i < FFT_SIZE; i++) {
    hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  }
}

// Frequency band cuts
const LO_CUT = Math.floor(150 / BIN_WIDTH);
const MID_CUT = Math.floor(2000 / BIN_WIDTH);

// Precomputed constants (avoid recomputing every FFT frame)
const INV_N2 = 1 / (FFT_SIZE * FFT_SIZE);
const LO_COUNT = LO_CUT;
const MID_COUNT = MID_CUT - LO_CUT;
const HI_COUNT = BIN_COUNT - MID_CUT;
const MID_HI_COUNT = MID_COUNT + HI_COUNT;

// Spectral flux state
let prevPower: Float64Array = new Float64Array(BIN_COUNT);

// High-shelf filter state
let hsState = 0;

// Ring buffer for incoming PCM samples
const ringBuf = new Float32Array(FFT_SIZE);
let ringPos = 0;

// Windowed sample buffer (input to FFT)
const windowedBuf = new Float64Array(FFT_SIZE);
let samplesReceived = 0;

// ── RMS pre-smoothing (noise reduction) ──
// Exponential moving average on RMS values before the engine sees them.
// At ~345 FFT frames/sec, alpha=0.3 gives ~3-frame smoothing (~9ms) — 
// kills jitter from amplified mic noise without adding perceptible latency.
const RMS_SMOOTH_ALPHA = 0.3;
let smoothBass = 0;
let smoothMidHi = 0;
let smoothTotal = 0;

// ── Noise gate ──
// Soft gate: signal below noiseFloor is exponentially attenuated.
// The floor adapts slowly to track ambient noise level.
const NOISE_FLOOR_TRACK_ALPHA = 0.001;  // very slow — tracks over ~3 seconds
const NOISE_GATE_KNEE = 3.0;            // gate ratio: signal must be 3x noise floor for full pass
let noiseFloor = 0.001;

function applyNoiseGate(rms: number): number {
  // Track noise floor (slow minimum follower)
  if (rms < noiseFloor || noiseFloor < 0.0001) {
    noiseFloor = rms;  // instant drop
  } else {
    noiseFloor += NOISE_FLOOR_TRACK_ALPHA * (rms - noiseFloor);
  }
  // Soft gate: ramp from 0→1 as signal goes from 1x→3x noise floor
  const threshold = noiseFloor * NOISE_GATE_KNEE;
  if (rms <= noiseFloor) return 0;
  if (rms >= threshold) return rms;
  // Smooth quadratic ramp in the knee region
  const t = (rms - noiseFloor) / (threshold - noiseFloor);
  return rms * (t * t);
}

// Latest computed bands (static object — mutated in place)
let latestBands: BandResult = { bassRms: 0, midHiRms: 0, totalRms: 0, flux: 0 };

// Debug — only active when DEBUG=true env var is set
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const DEBUG_INTERVAL = 690; // ~2 seconds at 44100/128 ≈ 345 frames/sec
let debugTickCount = 0;
let debugPeakRaw = 0;

const hsGain = Math.pow(10, 9 / 20);  // +9dB hi-shelf for INMP441 at ~1m distance
const HS_ALPHA = 0.15;

// ── Event-driven FFT callback ──
type FFTReadyCallback = (bands: BandResult) => void;
let _onFFTReady: FFTReadyCallback | null = null;

/** Register callback fired immediately after each FFT frame completes.
 *  The engine uses this to process with zero timer latency. */
export function onFFTReady(cb: FFTReadyCallback | null): void {
  _onFFTReady = cb;
}

function applyHighShelfSample(sample: number): number {
  hsState += HS_ALPHA * (sample - hsState);
  const lo = hsState;
  const hi = sample - lo;
  return lo + hi * hsGain;
}

function processFFT(): void {
  // Copy ring buffer in order, apply Hann window
  for (let i = 0; i < FFT_SIZE; i++) {
    windowedBuf[i] = ringBuf[(ringPos + i) % FFT_SIZE] * hannWindow[i];
  }

  const [fftRe, fftIm] = fft1024(windowedBuf);

  // Power spectrum + band sums in single pass (precomputed constants, no counters)
  let loSum = 0, midSum = 0, hiSum = 0;
  let totalSum = 0;
  let flux = 0;

  for (let i = 0; i < BIN_COUNT; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    if (i < LO_CUT) loSum += power;
    else if (i < MID_CUT) midSum += power;
    else hiSum += power;

    const diff = power - prevPower[i];
    if (diff > 0) flux += diff;
    prevPower[i] = power;
  }

  latestBands.bassRms = Math.sqrt(loSum / LO_COUNT);
  latestBands.midHiRms = Math.sqrt((midSum + hiSum) / MID_HI_COUNT);
  latestBands.totalRms = Math.sqrt(totalSum / BIN_COUNT);
  latestBands.flux = flux;

  // Debug logging every ~2 seconds (only when DEBUG=true)
  if (DEBUG_ENABLED) {
    debugTickCount++;
    if (debugTickCount >= DEBUG_INTERVAL) {
      console.log(`[ALSA-DBG] peak=${debugPeakRaw.toFixed(5)} bass=${latestBands.bassRms.toFixed(6)} midHi=${latestBands.midHiRms.toFixed(6)} total=${latestBands.totalRms.toFixed(6)} flux=${flux.toFixed(6)}`);
      debugTickCount = 0;
      debugPeakRaw = 0;
    }
  }

  // Fire event immediately — engine can process with zero latency
  if (_onFFTReady) _onFFTReady(latestBands);
}

export function getLatestBands(): BandResult {
  return latestBands;
}

export function resetFluxState(): void {
  prevPower.fill(0);
}

let recorder: any = null;
let currentDevice = process.env.ALSA_DEVICE ?? 'plughw:0,0';

// Software mic gain — multiplier applied to raw PCM samples before processing
let micGainBase = 15.0;  // INMP441 needs ~15x to match laptop mic sensitivity
let micGainAuto = 1.0;   // Auto-gain multiplier from Sonos volume
let micGain = 1.0;       // Effective = base * auto

function updateEffectiveGain(): void {
  micGain = micGainBase * micGainAuto;
}

export function getMicGain(): number { return micGainBase; }
export function getEffectiveGain(): number { return micGain; }
export function getAutoGainMultiplier(): number { return micGainAuto; }

export function setMicGain(gain: number): void {
  micGainBase = Math.max(0.1, Math.min(50, gain));
  updateEffectiveGain();
  console.log(`[ALSA] Mic base gain set to ${micGainBase.toFixed(1)}x (effective: ${micGain.toFixed(1)}x)`);
}

/** Two-point gain calibration.
 *  Two reference points: (vol1, gain1) and (vol2, gain2).
 *  Auto-gain interpolates/extrapolates in log space between them. */
export interface GainCalPoint { vol: number; gain: number; }

let calPoint1: GainCalPoint | null = null;  // low volume point
let calPoint2: GainCalPoint | null = null;  // high volume point
const AUTO_GAIN_MAX = 12.0;
const AUTO_GAIN_MIN = 0.3;
// Auto-gain only activates when calibration points exist
let autoGainEnabled = false;

export function isAutoGainEnabled(): boolean { return autoGainEnabled; }
export function getGainCalPoints(): { point1: GainCalPoint | null; point2: GainCalPoint | null } {
  return { point1: calPoint1, point2: calPoint2 };
}

export function setGainCalPoints(p1: GainCalPoint | null, p2: GainCalPoint | null): void {
  calPoint1 = p1;
  calPoint2 = p2;
  if (p1 && p2) {
    console.log(`[ALSA] Gain cal: point1=(vol=${p1.vol}, gain=${p1.gain.toFixed(1)}), point2=(vol=${p2.vol}, gain=${p2.gain.toFixed(1)})`);
  }
}

function interpolateGain(sonosVolume: number): number {
  if (!calPoint1 || !calPoint2) {
    // No calibration → no auto-gain adjustment
    return 1.0;
  }
  // Log-linear interpolation between the two calibrated points
  const v1 = calPoint1.vol, g1 = calPoint1.gain;
  const v2 = calPoint2.vol, g2 = calPoint2.gain;
  if (v1 === v2) return g1; // degenerate
  const logG1 = Math.log(g1), logG2 = Math.log(g2);
  const t = (sonosVolume - v1) / (v2 - v1);
  const logG = logG1 + t * (logG2 - logG1);
  return Math.min(AUTO_GAIN_MAX, Math.max(AUTO_GAIN_MIN, Math.exp(logG)));
}

export function setAutoGainFromVolume(sonosVolume: number): void {
  if (!autoGainEnabled || !calPoint1 || !calPoint2) return;
  if (sonosVolume <= 0) { micGainAuto = AUTO_GAIN_MAX; updateEffectiveGain(); return; }
  micGainAuto = interpolateGain(sonosVolume);
  updateEffectiveGain();
  console.log(`[ALSA] Auto-gain: vol=${sonosVolume} → multiplier=${micGainAuto.toFixed(2)}x (effective: ${micGain.toFixed(1)}x)`);
}

export function disableAutoGain(): void {
  autoGainEnabled = false;
  micGainAuto = 1.0;
  updateEffectiveGain();
  console.log(`[ALSA] Auto-gain disabled (effective: ${micGain.toFixed(1)}x)`);
}

export function enableAutoGain(): void {
  autoGainEnabled = true;
  console.log(`[ALSA] Auto-gain enabled`);
}

export function getAlsaDevice(): string {
  return currentDevice;
}

export function setAlsaDevice(device: string): void {
  if (device === currentDevice && recorder) return;
  currentDevice = device;
  if (recorder) {
    stopMic();
    startMic();
  }
}

export function startMic(): void {
  if (recorder) return;

  recorder = record.record({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    audioType: 'raw',
    recorder: 'arecord',
    device: currentDevice,
  });

  const stream = recorder.stream();

  stream.on('data', (buf: Buffer) => {
    const samples = buf.length / 2;
    for (let i = 0; i < samples; i++) {
      const s16 = buf.readInt16LE(i * 2);
      let raw = (s16 / 32768) * micGain;
      // Tanh soft-clip — preserves dynamics instead of hard clipping
      if (raw > 0.5 || raw < -0.5) raw = Math.tanh(raw);
      if (DEBUG_ENABLED) {
        const abs = raw < 0 ? -raw : raw;
        if (abs > debugPeakRaw) debugPeakRaw = abs;
      }
      ringBuf[ringPos] = applyHighShelfSample(raw);
      ringPos = (ringPos + 1) % FFT_SIZE;
      samplesReceived++;
    }

    // Trigger FFT every 128 samples (~2.9ms) with 75% overlap on 512-point window.
    if (samplesReceived >= 128) {
      processFFT();
      samplesReceived = 0;
    }
  });

  stream.on('error', (err: Error) => {
    console.error('[ALSA] stream error:', err.message);
  });

  console.log(`[ALSA] Microphone started (44.1kHz, 16-bit, mono, device: ${currentDevice})`);
}

export function stopMic(): void {
  if (recorder) {
    recorder.stop();
    recorder = null;
    hsState = 0;
    samplesReceived = 0;
    ringPos = 0;
    ringBuf.fill(0);
    prevPower.fill(0);
    console.log('[ALSA] Microphone stopped');
  }
}
