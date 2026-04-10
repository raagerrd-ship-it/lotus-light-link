/**
 * ALSA microphone input via node-record-lpcm16 → FFT → BandResult.
 * Replaces Web Audio API AnalyserNode on Raspberry Pi.
 */

import record from 'node-record-lpcm16';
// @ts-ignore — fft-js has no types
import fftJs from 'fft-js';
const { fft } = fftJs;

export interface BandResult {
  bassRms: number;
  midHiRms: number;
  totalRms: number;
  flux: number;
}

const SAMPLE_RATE = 44100;
const FFT_SIZE = 512;
const BIN_COUNT = FFT_SIZE / 2;
const BIN_WIDTH = SAMPLE_RATE / FFT_SIZE;

// Pre-computed Blackman window (matches browser AnalyserNode default)
const blackmanWindow = new Float64Array(FFT_SIZE);
{
  const a0 = 0.42, a1 = 0.5, a2 = 0.08;
  for (let i = 0; i < FFT_SIZE; i++) {
    blackmanWindow[i] = a0 - a1 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1))
                            + a2 * Math.cos(4 * Math.PI * i / (FFT_SIZE - 1));
  }
}

// Frequency band cuts (same as browser engine)
const LO_CUT = Math.floor(150 / BIN_WIDTH);
const MID_CUT = Math.floor(2000 / BIN_WIDTH);

// Spectral flux state
let prevPower: Float64Array = new Float64Array(BIN_COUNT);

// Pre-allocated magnitude buffer (avoids fftUtil.fftMag allocation each frame)
const magnitudeBuf = new Float64Array(BIN_COUNT);

// High-shelf filter state (simple 1-pole)
let hsState = 0;

// Ring buffer for incoming PCM samples
const ringBuf = new Float32Array(FFT_SIZE);
let ringPos = 0;

// Pre-allocated FFT working buffers (zero-alloc hot path)
const orderedBuf = new Float32Array(FFT_SIZE);
const fftInput: number[][] = Array.from({ length: FFT_SIZE }, () => [0, 0]);
let samplesReceived = 0; // total samples since last FFT

// Latest computed bands (polled by engine tick)
let latestBands: BandResult = { bassRms: 0, midHiRms: 0, totalRms: 0, flux: 0 };

// Debug: periodic signal level logging
let debugTickCount = 0;
let debugPeakRaw = 0;  // peak absolute sample value since last log

const hsGain = Math.pow(10, 6 / 20); // fixed 6dB for INMP441 @ ~1m
const HS_ALPHA = 0.15; // crossover ~2kHz at 44.1k

/** Apply high-shelf to a single sample (called on incoming PCM, once per sample) */
function applyHighShelfSample(sample: number): number {
  hsState += HS_ALPHA * (sample - hsState);
  const lo = hsState;
  const hi = sample - lo;
  return lo + hi * hsGain;
}

function processFFT(): void {
  // Copy ring buffer in order, apply Blackman window to prevent spectral leakage
  for (let i = 0; i < FFT_SIZE; i++) {
    const sample = ringBuf[(ringPos + i) % FFT_SIZE] * blackmanWindow[i];
    orderedBuf[i] = sample;
    fftInput[i][0] = sample;
    fftInput[i][1] = 0;
  }

  const spectrum = fft(fftInput);

  // Compute magnitudes inline — zero allocation (replaces fftUtil.fftMag)
  for (let i = 0; i < BIN_COUNT; i++) {
    const re = spectrum[i][0], im = spectrum[i][1];
    magnitudeBuf[i] = Math.sqrt(re * re + im * im);
  }

  let loSum = 0, midSum = 0, hiSum = 0;
  let loCount = 0, midCount = 0, hiCount = 0;
  let totalSum = 0;
  let flux = 0;

  for (let i = 0; i < BIN_COUNT; i++) {
    const power = (magnitudeBuf[i] / FFT_SIZE) ** 2;
    totalSum += power;
    if (i < LO_CUT) { loSum += power; loCount++; }
    else if (i < MID_CUT) { midSum += power; midCount++; }
    else { hiSum += power; hiCount++; }

    const diff = power - prevPower[i];
    if (diff > 0) flux += diff;
    prevPower[i] = power;
  }

  latestBands.bassRms = loCount > 0 ? Math.sqrt(loSum / loCount) : 0;
  latestBands.midHiRms = Math.sqrt((midSum + hiSum) / Math.max(1, midCount + hiCount));
  latestBands.totalRms = BIN_COUNT > 0 ? Math.sqrt(totalSum / BIN_COUNT) : 0;
  latestBands.flux = flux;

  // Debug: log signal levels every ~2 seconds
  debugTickCount++;
  if (debugTickCount >= 20) {
    console.log(`[ALSA-DBG] peak=${debugPeakRaw.toFixed(5)} bass=${latestBands.bassRms.toFixed(6)} midHi=${latestBands.midHiRms.toFixed(6)} total=${latestBands.totalRms.toFixed(6)} flux=${latestBands.flux.toFixed(6)}`);
    debugTickCount = 0;
    debugPeakRaw = 0;
  }
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

/** Restart mic with a new ALSA device. Stops current recording and starts with the new device. */
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
    // 16-bit signed LE PCM → float, high-shelf filtered, into ring buffer
    const samples = buf.length / 2;
    for (let i = 0; i < samples; i++) {
      const s16 = buf.readInt16LE(i * 2);
      const raw = s16 / 32768;
      const abs = Math.abs(raw);
      if (abs > debugPeakRaw) debugPeakRaw = abs;
      ringBuf[ringPos] = applyHighShelfSample(raw);
      ringPos = (ringPos + 1) % FFT_SIZE;
      samplesReceived++;
    }

    // Only process FFT when we have at least half a window of new data
    if (samplesReceived >= FFT_SIZE / 2) {
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
    // Reset filter and buffer state to prevent glitches on restart
    hsState = 0;
    samplesReceived = 0;
    ringPos = 0;
    ringBuf.fill(0);
    prevPower.fill(0);
    console.log('[ALSA] Microphone stopped');
  }
}
