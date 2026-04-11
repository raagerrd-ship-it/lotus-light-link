/**
 * ALSA microphone input via node-record-lpcm16 → FFT → BandResult.
 * Replaces Web Audio API AnalyserNode on Raspberry Pi.
 * Uses custom zero-alloc radix-2 FFT (no fft-js dependency).
 * 
 * Event-driven: fires onFFTReady callback immediately after each FFT frame,
 * enabling the engine to process with zero additional latency.
 */

import record from 'node-record-lpcm16';
import { fft512, FFT_N } from './fftRadix2.js';

export interface BandResult {
  bassRms: number;
  midHiRms: number;
  totalRms: number;
  flux: number;
}

const SAMPLE_RATE = 44100;
const FFT_SIZE = FFT_N; // 512
const BIN_COUNT = FFT_SIZE / 2;
const BIN_WIDTH = SAMPLE_RATE / FFT_SIZE;

// Pre-computed Blackman window
const blackmanWindow = new Float64Array(FFT_SIZE);
{
  const a0 = 0.42, a1 = 0.5, a2 = 0.08;
  for (let i = 0; i < FFT_SIZE; i++) {
    blackmanWindow[i] = a0 - a1 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1))
                            + a2 * Math.cos(4 * Math.PI * i / (FFT_SIZE - 1));
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

// Latest computed bands (static object — mutated in place)
let latestBands: BandResult = { bassRms: 0, midHiRms: 0, totalRms: 0, flux: 0 };

// Debug — log every ~2 seconds at current FFT rate (44100/128 ≈ 345 frames/sec)
const DEBUG_INTERVAL = 690;
let debugTickCount = 0;
let debugPeakRaw = 0;

const hsGain = Math.pow(10, 6 / 20);
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
  // Copy ring buffer in order, apply Blackman window
  for (let i = 0; i < FFT_SIZE; i++) {
    windowedBuf[i] = ringBuf[(ringPos + i) % FFT_SIZE] * blackmanWindow[i];
  }

  const [fftRe, fftIm] = fft512(windowedBuf);

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

  // Debug logging every ~2 seconds
  debugTickCount++;
  if (debugTickCount >= DEBUG_INTERVAL) {
    console.log(`[ALSA-DBG] peak=${debugPeakRaw.toFixed(5)} bass=${latestBands.bassRms.toFixed(6)} midHi=${latestBands.midHiRms.toFixed(6)} total=${latestBands.totalRms.toFixed(6)} flux=${flux.toFixed(6)}`);
    debugTickCount = 0;
    debugPeakRaw = 0;
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
      const raw = s16 / 32768;
      const abs = raw < 0 ? -raw : raw; // branchless abs (avoid Math.abs call)
      if (abs > debugPeakRaw) debugPeakRaw = abs;
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
