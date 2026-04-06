/**
 * ALSA microphone input via node-record-lpcm16 → FFT → BandResult.
 * Replaces Web Audio API AnalyserNode on Raspberry Pi.
 */

import record from 'node-record-lpcm16';
// @ts-ignore — fft-js has no types
import { fft, util as fftUtil } from 'fft-js';

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

// Frequency band cuts (same as browser engine)
const LO_CUT = Math.floor(150 / BIN_WIDTH);
const MID_CUT = Math.floor(2000 / BIN_WIDTH);

// Spectral flux state
let prevPower: Float64Array = new Float64Array(BIN_COUNT);

// High-shelf filter state (simple 1-pole)
let hsState = 0;

// Ring buffer for incoming PCM samples
const ringBuf = new Float32Array(FFT_SIZE);
let ringPos = 0;
let samplesReceived = 0; // total samples since last FFT

// Latest computed bands (polled by engine tick)
let latestBands: BandResult = { bassRms: 0, midHiRms: 0, totalRms: 0, flux: 0 };

function applyHighShelf(samples: Float32Array, gainDb: number): void {
  // Simple 1-pole high-shelf approximation
  const gain = Math.pow(10, gainDb / 20);
  const alpha = 0.15; // crossover ~2kHz at 44.1k
  for (let i = 0; i < samples.length; i++) {
    hsState += alpha * (samples[i] - hsState);
    const lo = hsState;
    const hi = samples[i] - lo;
    samples[i] = lo + hi * gain;
  }
}

function processFFT(hiShelfGainDb: number): void {
  // Copy ring buffer in order
  const ordered = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    ordered[i] = ringBuf[(ringPos + i) % FFT_SIZE];
  }

  // Apply high-shelf compensation
  applyHighShelf(ordered, hiShelfGainDb);

  // Convert to array for fft-js
  const input: number[][] = [];
  for (let i = 0; i < FFT_SIZE; i++) {
    input.push([ordered[i], 0]);
  }

  const spectrum = fft(input);
  const magnitudes = fftUtil.fftMag(spectrum);

  let loSum = 0, midSum = 0, hiSum = 0;
  let loCount = 0, midCount = 0, hiCount = 0;
  let totalSum = 0;
  let flux = 0;

  for (let i = 0; i < BIN_COUNT; i++) {
    const power = (magnitudes[i] / FFT_SIZE) ** 2;
    totalSum += power;
    if (i < LO_CUT) { loSum += power; loCount++; }
    else if (i < MID_CUT) { midSum += power; midCount++; }
    else { hiSum += power; hiCount++; }

    const diff = power - prevPower[i];
    if (diff > 0) flux += diff;
    prevPower[i] = power;
  }

  latestBands = {
    bassRms: loCount > 0 ? Math.sqrt(loSum / loCount) : 0,
    midHiRms: Math.sqrt((midSum + hiSum) / Math.max(1, midCount + hiCount)),
    totalRms: BIN_COUNT > 0 ? Math.sqrt(totalSum / BIN_COUNT) : 0,
    flux,
  };
}

export function getLatestBands(): BandResult {
  return latestBands;
}

export function resetFluxState(): void {
  prevPower.fill(0);
}

let recorder: any = null;
let hiShelfGainDb = 6;
let currentDevice = process.env.ALSA_DEVICE ?? 'plughw:0,0';

export function setHiShelfGain(db: number): void {
  hiShelfGainDb = db;
}

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
    // 16-bit signed LE PCM → float
    const samples = buf.length / 2;
    for (let i = 0; i < samples; i++) {
      const s16 = buf.readInt16LE(i * 2);
      ringBuf[ringPos] = s16 / 32768;
      ringPos = (ringPos + 1) % FFT_SIZE;
      samplesReceived++;
    }

    // Only process FFT when we have at least half a window of new data
    // Prevents redundant FFTs on the same data (saves CPU on Pi Zero)
    if (samplesReceived >= FFT_SIZE / 2) {
      processFFT(hiShelfGainDb);
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
    console.log('[ALSA] Microphone stopped');
  }
}
