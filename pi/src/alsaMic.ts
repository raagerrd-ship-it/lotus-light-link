/**
 * ALSA microphone input → FFT → BandResult.
 * Prefers native alsa-capture (direct snd_pcm_readi, no subprocess).
 * Falls back to node-record-lpcm16 (arecord subprocess) if native addon unavailable.
 * Uses custom zero-alloc radix-2 FFT (no fft-js dependency).
 * 
 * Event-driven: fires onFFTReady callback immediately after each FFT frame,
 * enabling the engine to process with zero additional latency.
 */

import { fft1024, FFT_N } from './fftRadix2.js';
import { pipelineTiming } from './pipelineTiming.js';

// Dynamic import — alsa-capture is vendored as a fork in pi/vendor/alsa-capture/
// (upstream nan@2.17 is incompatible with Node 24 V8). The fork bumps nan to ^2.26.2.
// Resolution order: vendored fork → upstream npm pkg → arecord subprocess fallback.
let AlsaCapture: any = null;
let nodeRecord: any = null;
let useNative = false;
let micBackend: 'alsa-vendored' | 'alsa-npm' | 'arecord' | 'none' = 'none';

try {
  AlsaCapture = (await import('../vendor/alsa-capture/index.js')).default;
  useNative = true;
  micBackend = 'alsa-vendored';
  console.log('[ALSA] Using native alsa-capture (vendored fork, direct snd_pcm_readi)');
} catch (eVendor: any) {
  try {
    AlsaCapture = (await import('alsa-capture')).default;
    useNative = true;
    micBackend = 'alsa-npm';
    console.log('[ALSA] Using native alsa-capture (npm package, direct snd_pcm_readi)');
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    console.warn(`[ALSA] Native alsa-capture unavailable: ${reason}`);
    try {
      nodeRecord = (await import('node-record-lpcm16')).default;
      micBackend = 'arecord';
      console.log('[ALSA] Falling back to node-record-lpcm16 (arecord subprocess)');
    } catch (e2: any) {
      console.warn(`[ALSA] node-record-lpcm16 also unavailable: ${e2?.message ?? e2}`);
    }
  }
}

/** Returns which audio capture backend is currently active. */
export function getMicBackend(): 'alsa-vendored' | 'alsa-npm' | 'arecord' | 'none' {
  return micBackend;
}

// Timestamp (performance.now) when the last audio buffer arrived from ALSA.
// Used together with getLastWriteTime() in protocol.ts to compute end-to-end
// audio→BLE latency for the UI badge.
let lastAudioTimestamp = 0;
export function getLastAudioTimestamp(): number { return lastAudioTimestamp; }

type MicReadyWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let micStartError: string | null = null;
let micReadyWaiters: MicReadyWaiter[] = [];

function clearMicReadyWaiters(): MicReadyWaiter[] {
  const waiters = micReadyWaiters;
  micReadyWaiters = [];
  return waiters;
}

function resolveMicReadyWaiters(): void {
  for (const waiter of clearMicReadyWaiters()) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

function rejectMicReadyWaiters(message: string): void {
  micStartError = message;
  const error = new Error(message);
  for (const waiter of clearMicReadyWaiters()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

/** Resolves when the first audio callback arrives, rejects on capture error/timeout. */
export function waitForFirstAudio(timeoutMs = 2500): Promise<void> {
  if (_audioCbCount > 0) return Promise.resolve();
  if (micStartError) return Promise.reject(new Error(micStartError));

  return new Promise<void>((resolve, reject) => {
    const waiter: MicReadyWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        micReadyWaiters = micReadyWaiters.filter((entry) => entry !== waiter);
        reject(new Error(`[ALSA] No audio callback within ${timeoutMs}ms (backend=${micBackend}, device=${currentDevice}, format=${currentFormat})`));
      }, timeoutMs),
    };
    micReadyWaiters.push(waiter);
  });
}

export interface BandResult {
  bassRms: number;
  midHiRms: number;
  totalRms: number;
  flux: number;
}

const SAMPLE_RATE = 44100;
const FFT_SIZE = FFT_N; // 1024
// HOP_SIZE = tickMs * 44.1 → exakt 1 FFT per tick (1:1 mic→FFT→tick).
// Med synkron hard-fail-pipeline behövs ingen "extra" FFT-frame som
// säkerhetsmarginal — varje audio-batch driver exakt en tick.
// Default 40ms tick → hop≈1764 frames (~40ms). Sätts via setTickHopMs().
let HOP_SIZE = 1764;
const BIN_COUNT = FFT_SIZE / 2;
const BIN_WIDTH = SAMPLE_RATE / FFT_SIZE;
const FFT_MASK = FFT_SIZE - 1;

// Pre-computed Hann window (~6% more energy than Blackman, minimal spectral leakage)
const hannWindow = new Float64Array(FFT_SIZE);
{
  for (let i = 0; i < FFT_SIZE; i++) {
    hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  }
}

// Frequency band cuts (Hz)
// Bas: 60–150 Hz (~1.32 oktaver) — sub + kick fundamentals
// Mid+Hi: 150–15000 Hz (~6.64 oktaver) — vocals, snare, hats, cymbals
// Diskanten dränks tidigare av att vi delade per-bin: hi-bandet hade 466 bins
// vs basens 3, så samma energi per Hz gav 100x lägre RMS i diskant.
// Lösning: dela per oktav istället → matchar mänsklig perception.
const LO_HZ_LOW = 60;
const LO_HZ_HIGH = 150;
const HI_HZ_LOW = 150;
const HI_HZ_HIGH = 15000;
const LO_BIN_LOW = Math.max(1, Math.floor(LO_HZ_LOW / BIN_WIDTH));
const LO_BIN_HIGH = Math.floor(LO_HZ_HIGH / BIN_WIDTH);
const HI_BIN_LOW = LO_BIN_HIGH;
const HI_BIN_HIGH = Math.min(BIN_COUNT, Math.floor(HI_HZ_HIGH / BIN_WIDTH));
// Oktav-bredd per band: log2(highHz/lowHz)
const LO_OCTAVES = Math.log2(LO_HZ_HIGH / LO_HZ_LOW);
const HI_OCTAVES = Math.log2(HI_HZ_HIGH / HI_HZ_LOW);
// Normalisera så att RMS = sqrt(totalPower / oktaver) — energi-per-oktav
const INV_LO_OCT = 1 / LO_OCTAVES;
const INV_HI_OCT = 1 / HI_OCTAVES;

// Precomputed constants (avoid recomputing every FFT frame)
const INV_N2 = 1 / (FFT_SIZE * FFT_SIZE);

// Backward-compat alias för engine-kod som läser LO_CUT/MID_CUT
const LO_CUT = LO_BIN_HIGH;
const MID_CUT = HI_BIN_HIGH;
const LO_COUNT = LO_BIN_HIGH - LO_BIN_LOW;
const MID_COUNT = HI_BIN_HIGH - HI_BIN_LOW;
const HI_COUNT = BIN_COUNT - HI_BIN_HIGH;
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

// ── Asymmetric RMS pre-smoothing (noise reduction + transient preservation) ──
// Fast attack (alpha=0.8) lets kicks punch through with minimal delay (~1 frame).
// Slow release (alpha=0.15) smooths out noise on the way down.
const RMS_ATTACK_ALPHA = 0.8;   // fast rise — preserves kick transients
const RMS_RELEASE_ALPHA = 0.15; // slow fall — kills noise jitter on decay
let smoothBass = 0;
let smoothMidHi = 0;
let smoothTotal = 0;

function smoothRms(raw: number, prev: number): number {
  const alpha = raw > prev ? RMS_ATTACK_ALPHA : RMS_RELEASE_ALPHA;
  return prev + alpha * (raw - prev);
}

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

// Timestamp of last FFT completion (performance.now())
let lastFFTTimestamp = 0;

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

// ── FFT frame counter (for diagnostics: faktisk frames/s från ALSA → FFT) ──
let _fftFrameCount = 0;
export function getFFTFrameCount(): number { return _fftFrameCount; }

function applyHighShelfSample(sample: number): number {
  hsState += HS_ALPHA * (sample - hsState);
  const lo = hsState;
  const hi = sample - lo;
  return lo + hi * hsGain;
}

function processFFT(): void {
  // Copy ring buffer in order, apply Hann window — bitmask instead of modulo
  for (let i = 0; i < FFT_SIZE; i++) {
    windowedBuf[i] = ringBuf[(ringPos + i) & FFT_MASK] * hannWindow[i];
  }

  const [fftRe, fftIm] = fft1024(windowedBuf);

  // Power spectrum + band sums in single pass (oktav-baserade band)
  let loSum = 0, hiSum = 0;
  let totalSum = 0;
  let flux = 0;

  for (let i = 0; i < BIN_COUNT; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    if (i >= LO_BIN_LOW && i < LO_BIN_HIGH) loSum += power;
    else if (i >= HI_BIN_LOW && i < HI_BIN_HIGH) hiSum += power;

    const diff = power - prevPower[i];
    if (diff > 0) flux += diff;
    prevPower[i] = power;
  }

  // ── Energy-per-octave: matchar mänsklig perception av frekvensbalans ──
  // Tidigare delades med antal bins → diskant (466 bins) dränktes vs bas (3 bins).
  // Nu: total power i bandet / antal oktaver bandet täcker → båda jämförbara.
  const rawBass = Math.sqrt(loSum * INV_LO_OCT);
  const rawMidHi = Math.sqrt(hiSum * INV_HI_OCT);
  const rawTotal = Math.sqrt(totalSum / BIN_COUNT);


  smoothBass = smoothRms(rawBass, smoothBass);
  smoothMidHi = smoothRms(rawMidHi, smoothMidHi);
  smoothTotal = smoothRms(rawTotal, smoothTotal);

  // ── Noise gate: suppress signal near ambient noise floor ──
  latestBands.bassRms = applyNoiseGate(smoothBass);
  latestBands.midHiRms = applyNoiseGate(smoothMidHi);
  latestBands.totalRms = applyNoiseGate(smoothTotal);
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

  // Stamp FFT completion time
  lastFFTTimestamp = performance.now();
  _fftFrameCount++;

  // Fire event immediately — engine can process with zero latency
  if (_onFFTReady) _onFFTReady(latestBands);
}

export function getLatestBands(): BandResult {
  return latestBands;
}

export function resetFluxState(): void {
  prevPower.fill(0);
}

/** Return timestamp (performance.now) of last FFT completion */
export function getLastFFTTimestamp(): number {
  return lastFFTTimestamp;
}

/** Expose noise gate state for diagnostics — zero-alloc static object */
const _ngState = { noiseFloor: 0, threshold: 0, smoothBass: 0, smoothMidHi: 0, smoothTotal: 0 };
export function getNoiseGateState(): typeof _ngState {
  _ngState.noiseFloor = noiseFloor;
  _ngState.threshold = noiseFloor * NOISE_GATE_KNEE;
  _ngState.smoothBass = smoothBass;
  _ngState.smoothMidHi = smoothMidHi;
  _ngState.smoothTotal = smoothTotal;
  return _ngState;
}

let capture: any = null;
let currentDevice = process.env.ALSA_DEVICE ?? 'plughw:0,0';
// INMP441 (Google voiceHAT-soundcard overlay) levererar bara S32_LE.
// Default till S32_LE; kan överridas via ALSA_FORMAT env för andra mikar.
let currentFormat: 'S16_LE' | 'S32_LE' = (process.env.ALSA_FORMAT as any) ?? 'S32_LE';
const BYTES_PER_SAMPLE = currentFormat === 'S32_LE' ? 4 : 2;

/** Sätt FFT-trigger från tickMs (hop = tickMs → 1 FFT per tick, 1:1 mic→tick).
 *  ALSA-perioden är 256 frames (~5.8ms). JS-sidan ackumulerar HOP_SIZE samples
 *  innan processFFT() körs. Inget capture-restart behövs → noll glitch när
 *  användaren drar i tick-slidern. */
export function setTickHopMs(tickMs: number): void {
  const newHop = Math.max(128, Math.round(tickMs * (SAMPLE_RATE / 1000)));
  if (newHop === HOP_SIZE) return;
  HOP_SIZE = newHop;
  console.log(`[ALSA] FFT hop → ${HOP_SIZE} frames (${(HOP_SIZE / SAMPLE_RATE * 1000).toFixed(1)}ms, 1 FFT/tick @ ${tickMs}ms)`);
}

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
  if (device === currentDevice && capture) return;
  currentDevice = device;
  if (capture) {
    stopMic();
    startMic();
  }
}

export function startMic(): void {
  if (capture) return;

  micStartError = null;
  _audioCbCount = 0;
  _audioCbBytes = 0;
  _audioCbFirstAt = 0;
  lastAudioTimestamp = 0;
  lastFFTTimestamp = 0;
  _fftFrameCount = 0;

  const handleStartFailure = (message: string) => {
    console.error(message);
    rejectMicReadyWaiters(message);
  };

  if (useNative && AlsaCapture) {
    // Native path — direct ALSA snd_pcm_readi(), no subprocess.
    // periodSize=256 frames (~5.8ms) på Pi Zero 2W. 128 var för aggressivt:
    // ALSA-tråden väcktes var 2.9:e ms och JS hann inte tömma → buffer overrun
    // konstant → engine fick inga FFT-frames → 0% output.
    // Bindningen sätter buffer = period × 8 = ~46ms headroom mot eventloop-jitter.
    capture = new AlsaCapture({
      channels: 1,
      rate: SAMPLE_RATE,
      format: currentFormat,
      device: currentDevice,
      periodSize: 256,
    });

    capture.on('audio', onAudioData);
    capture.on('overrun', () => console.warn('[ALSA] Buffer overrun detected'));
    capture.on('readError', (message: string) => handleStartFailure(`[ALSA] readError: ${message}`));
    capture.on('error', (err: Error | string) => {
      const msg = typeof err === 'string' ? err : err?.message ?? String(err);
      handleStartFailure(`[ALSA] capture error: ${msg}`);
    });
    capture.on('close', () => {
      if (_audioCbCount === 0) handleStartFailure('[ALSA] capture closed before first audio callback');
    });
    console.log(`[ALSA] Mic started via native ALSA (44.1kHz, ${currentFormat}, mono, period=256, fft-hop=${HOP_SIZE}, device: ${currentDevice})`);

  } else if (nodeRecord) {
    // Fallback — arecord subprocess + pipe
    capture = nodeRecord.record({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      audioType: 'raw',
      recorder: 'arecord',
      device: currentDevice,
    });
    const stream = capture.stream();
    stream.on('data', onAudioData);
    stream.on('error', (err: any) => {
      const msg = err?.message ?? err?.code ?? (err === undefined ? '(empty error event from arecord stream — usually harmless EOF)' : String(err));
      handleStartFailure(`[ALSA] stream error: ${msg}`);
    });
    console.log(`[ALSA] Mic started via arecord (44.1kHz, 16-bit, mono, device: ${currentDevice})`);

  } else {
    handleStartFailure('[ALSA] No audio capture module available — mic disabled');
  }
}

/** Shared audio data handler for both native and fallback paths */
let _audioCbCount = 0;
let _audioCbBytes = 0;
let _audioCbFirstAt = 0;
export function getAudioCbStats() {
  return { count: _audioCbCount, bytes: _audioCbBytes, firstAt: _audioCbFirstAt };
}
function onAudioData(buf: Buffer): void {
  const tAudio = performance.now();
  lastAudioTimestamp = tAudio;
  _audioCbCount++;
  _audioCbBytes += buf.byteLength;
  if (_audioCbFirstAt === 0) {
    _audioCbFirstAt = tAudio;
    console.log(`[ALSA] FIRST audio callback fired at t=${tAudio.toFixed(1)}ms, ${buf.byteLength} bytes`);
    resolveMicReadyWaiters();
  }
  if (_audioCbCount === 50 || _audioCbCount === 200 || _audioCbCount % 1000 === 0) {
    console.log(`[ALSA] audio cb count=${_audioCbCount}, totalBytes=${_audioCbBytes}, samplesReceived=${samplesReceived}, HOP_SIZE=${HOP_SIZE}`);
  }
  // S16_LE: 2 bytes/sample, divisor 32768. S32_LE: 4 bytes/sample, divisor 2147483648.
  // INMP441 levererar 24-bit data left-justified i 32-bit container — samma divisor fungerar.
  let len: number;
  let getSample: (i: number) => number;
  if (currentFormat === 'S32_LE') {
    const samples = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
    len = samples.length;
    const INV_S32 = 1 / 2147483648;
    getSample = (i) => samples[i] * INV_S32;
  } else {
    const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    len = samples.length;
    const INV_S16 = 1 / 32768;
    getSample = (i) => samples[i] * INV_S16;
  }

  for (let i = 0; i < len; i++) {
    let raw = getSample(i) * micGain;
    if (raw > 0.5 || raw < -0.5) raw = Math.tanh(raw);
    if (DEBUG_ENABLED) {
      const abs = raw < 0 ? -raw : raw;
      if (abs > debugPeakRaw) debugPeakRaw = abs;
    }
    ringBuf[ringPos] = applyHighShelfSample(raw);
    ringPos = (ringPos + 1) & FFT_MASK;
    samplesReceived++;
  }

  if (samplesReceived >= HOP_SIZE) {
    processFFT();
    // audioToFft = ALSA buffer arrival → FFT frame complete
    pipelineTiming.recordAudioToFft(performance.now() - tAudio);
    samplesReceived = 0;
  }
}

export function stopMic(): void {
  if (!capture) return;

  if (_audioCbCount === 0) {
    rejectMicReadyWaiters('[ALSA] Microphone stopped before first audio callback');
  } else {
    resolveMicReadyWaiters();
  }

  if (useNative) {
    capture.close();
  } else {
    capture.stop();
  }
  capture = null;
  hsState = 0;
  samplesReceived = 0;
  ringPos = 0;
  ringBuf.fill(0);
  prevPower.fill(0);
  smoothBass = 0; smoothMidHi = 0; smoothTotal = 0;
  noiseFloor = 0.001;
  latestBands.bassRms = 0;
  latestBands.midHiRms = 0;
  latestBands.totalRms = 0;
  latestBands.flux = 0;
  _audioCbCount = 0;
  _audioCbBytes = 0;
  _audioCbFirstAt = 0;
  lastAudioTimestamp = 0;
  lastFFTTimestamp = 0;
  _fftFrameCount = 0;
  micStartError = null;
  console.log('[ALSA] Microphone stopped');
}
