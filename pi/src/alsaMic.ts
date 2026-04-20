/**
 * ALSA microphone input → FFT → BandResult.
 * Uses native alsa-capture (direct snd_pcm_readi, no subprocess) — HARD REQUIRED.
 * Engine refuses to start mic if vendored binding can't be loaded (no arecord
 * fallback, since arecord adds ~30-50ms latency we deliberately avoid).
 * Custom zero-alloc radix-2 FFT (no fft-js dependency).
 *
 * Event-driven: fires onFFTReady callback immediately after each FFT frame,
 * enabling the engine to process with zero additional latency.
 */

import { fft1024, FFT_N } from './fftRadix2.js';

// Dynamic import — alsa-capture is vendored as a fork in pi/vendor/alsa-capture/
// (upstream nan@2.17 is incompatible with Node 24 V8). The fork bumps nan to ^2.26.2.
// Resolution order: vendored fork → upstream npm pkg → arecord subprocess fallback.
let AlsaCapture: any = null;
let useNative = false;
let micBackend: 'alsa-vendored' | 'alsa-npm' | 'none' = 'none';
let nativeImportError: string | null = null;

// HARD-FAIL POLICY (2026-04-20): användaren har valt lägsta möjliga latens →
// arecord-fallback är borttagen. Engine vägrar starta mic om native binding
// saknas, så vi inte tyst hamnar i ett 30-50ms-läge utan att märka det.
try {
  AlsaCapture = (await import('../vendor/alsa-capture/index.js')).default;
  useNative = true;
  micBackend = 'alsa-vendored';
  console.log('[ALSA] Using native alsa-capture (vendored fork, direct snd_pcm_readi)');
} catch (eVendor: any) {
  const vendorReason = eVendor?.message ?? String(eVendor);
  try {
    AlsaCapture = (await import('alsa-capture')).default;
    useNative = true;
    micBackend = 'alsa-npm';
    console.log('[ALSA] Using native alsa-capture (npm package, direct snd_pcm_readi)');
  } catch (e: any) {
    const npmReason = e?.message ?? String(e);
    nativeImportError = `vendored: ${vendorReason}; npm: ${npmReason}`;
    console.error(`[ALSA] FATAL: Native alsa-capture unavailable (${nativeImportError})`);
    console.error(`[ALSA] Engine kommer vägra starta mic — bygg om pi/vendor/alsa-capture på Pi:n.`);
  }
}

export function getNativeImportError(): string | null { return nativeImportError; }

/** Returns which audio capture backend is currently active. */
export function getMicBackend(): 'alsa-vendored' | 'alsa-npm' | 'none' {
  return micBackend;
}


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

const SAMPLE_RATE = 48000;
const FFT_SIZE = FFT_N; // 1024
// HOP_SIZE = 512 frames (~10.7ms @ 48kHz) — FAST, frikopplad från tickMs.
// FFT körs ~93Hz för bättre transient-detektering och peak-tracking.
// Engine.tickInner triggas dock bara på tickMs-takt (gate i piEngine.onFFTFrame
// kollar `elapsed >= tickMs`) → BLE-trafik oförändrad, men engine ser senaste
// FFT-frame när den väl kör → snabbare attack-respons.
//
// CPU-konsekvens: ~93 FFT/s × ~1ms = ~9% CPU på Pi Zero 2W (mätt: tål det,
// vendor-bufferten är 8× period = 43ms vilket täcker värsta GC-pausen).
// Tidigare HOP=tickMs (40ms) → ~25Hz FFT → ~2.5% CPU. Vi byter ~6.5% extra
// CPU mot ~30ms bättre transient-respons.
const HOP_SIZE = 512;
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

// NOTE: applyHighShelfSample inlined directly into onAudioData hot loop
// (function call overhead per sample × 1920/cb = measurable on Pi Zero 2W).

function processFFT(): void {
  // Copy ring buffer in order, apply Hann window — bitmask instead of modulo
  for (let i = 0; i < FFT_SIZE; i++) {
    windowedBuf[i] = ringBuf[(ringPos + i) & FFT_MASK] * hannWindow[i];
  }

  const [fftRe, fftIm] = fft1024(windowedBuf);

  // Power spectrum + band sums — branchless, split into 4 segments instead of
  // per-bin if/else (saves ~1024 conditional branches per frame).
  // Segments: [0..LO_BIN_LOW)  [LO_BIN_LOW..LO_BIN_HIGH)  [HI_BIN_LOW..HI_BIN_HIGH)  [HI_BIN_HIGH..BIN_COUNT)
  // (LO_BIN_HIGH === HI_BIN_LOW so segments are contiguous.)
  let loSum = 0, hiSum = 0;
  let totalSum = 0;
  let flux = 0;

  // Segment 1: 0 .. LO_BIN_LOW (only total + flux)
  for (let i = 0; i < LO_BIN_LOW; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    const diff = power - prevPower[i];
    if (diff > 0) flux += diff;
    prevPower[i] = power;
  }
  // Segment 2: LO_BIN_LOW .. LO_BIN_HIGH (loSum)
  for (let i = LO_BIN_LOW; i < LO_BIN_HIGH; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    loSum += power;
    const diff = power - prevPower[i];
    if (diff > 0) flux += diff;
    prevPower[i] = power;
  }
  // Segment 3: HI_BIN_LOW .. HI_BIN_HIGH (hiSum)
  for (let i = HI_BIN_LOW; i < HI_BIN_HIGH; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    hiSum += power;
    const diff = power - prevPower[i];
    if (diff > 0) flux += diff;
    prevPower[i] = power;
  }
  // Segment 4: HI_BIN_HIGH .. BIN_COUNT (only total + flux)
  for (let i = HI_BIN_HIGH; i < BIN_COUNT; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
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
// LÄGSTA LATENS: hw:0,0 = rå hårdvara, ingen ALSA plugin-konvertering.
// Kräver att engine matchar exakt format som soundcardet stödjer (INMP441
// via google-voicehat-soundcard overlay = S32_LE 48kHz stereo — vilket är
// precis vad vi konfigurerar i startMic). plughw skulle ge ~1-2ms extra.
let currentDevice = process.env.ALSA_DEVICE ?? 'hw:0,0';
// INMP441 (Google voiceHAT-soundcard overlay) levererar bara S32_LE.
// Default till S32_LE; kan överridas via ALSA_FORMAT env för andra mikar.
let currentFormat: 'S16_LE' | 'S32_LE' = (process.env.ALSA_FORMAT as any) ?? 'S32_LE';
const BYTES_PER_SAMPLE = currentFormat === 'S32_LE' ? 4 : 2;

/** No-op: HOP_SIZE är hårdkodat till 512 (~10.7ms) och frikopplat från tickMs.
 *  Engine.tickInner gatear själv på tickMs i onFFTFrame, så vi behöver inte
 *  ändra FFT-takten när användaren drar i tick-slidern. Behållen för API-kompat. */
export function setTickHopMs(_tickMs: number): void {
  // intentionally empty — FFT körs alltid var 10.7ms, engine gatear på tickMs
}

// Software mic gain — multiplier applied to raw PCM samples before processing.
// ANTINGEN/ELLER-LOGIK:
//   autoGainEnabled === false → micGain = micGainBase   (manuell slider)
//   autoGainEnabled === true  → micGain = micGainAuto   (interpolerad från Sonos-vol)
// Cal-punkterna är absoluta gain-värden, inte multiplikatorer ovanpå base.
let micGainBase = 15.0;  // INMP441 needs ~15x to match laptop mic sensitivity
let micGainAuto = 15.0;  // Absolute gain interpolated from Sonos volume
let autoGainEnabled = false;
let micGain = 15.0;      // Effective — used in hot path

function updateEffectiveGain(): void {
  micGain = autoGainEnabled ? micGainAuto : micGainBase;
}

export function getMicGain(): number { return micGainBase; }
export function getEffectiveGain(): number { return micGain; }
export function getAutoGainMultiplier(): number { return micGainAuto; }

export function setMicGain(gain: number): void {
  micGainBase = Math.max(0.1, Math.min(50, gain));
  updateEffectiveGain();
  console.log(`[ALSA] Mic base gain set to ${micGainBase.toFixed(1)}x (effective: ${micGain.toFixed(1)}x, auto=${autoGainEnabled})`);
}

/** Two-point gain calibration.
 *  Cal-punkterna är absoluta gain-värden. När auto är på bypass:as manuell slider. */
export interface GainCalPoint { vol: number; gain: number; }

let calPoint1: GainCalPoint | null = null;
let calPoint2: GainCalPoint | null = null;
let lastSonosVol: number | null = null;  // cachat för live-omräkning vid slider-change
const AUTO_GAIN_MAX = 50.0;
const AUTO_GAIN_MIN = 0.1;

export function isAutoGainEnabled(): boolean { return autoGainEnabled; }
export function getGainCalPoints(): { point1: GainCalPoint | null; point2: GainCalPoint | null } {
  return { point1: calPoint1, point2: calPoint2 };
}

export function setGainCalPoints(p1: GainCalPoint | null, p2: GainCalPoint | null): void {
  calPoint1 = p1;
  calPoint2 = p2;
  if (p1 && p2) {
    console.log(`[ALSA] Gain cal: point1=(vol=${p1.vol}, gain=${p1.gain.toFixed(1)}), point2=(vol=${p2.vol}, gain=${p2.gain.toFixed(1)})`);
    // Räkna om direkt från senast kända volym så slider-ändringar syns omedelbart
    if (autoGainEnabled && lastSonosVol != null) {
      recomputeAutoGain(lastSonosVol);
    }
  }
}

function interpolateGain(sonosVolume: number): number {
  if (!calPoint1 || !calPoint2) return micGainBase;
  const v1 = calPoint1.vol, g1 = calPoint1.gain;
  const v2 = calPoint2.vol, g2 = calPoint2.gain;
  if (v1 === v2) return g1;
  const logG1 = Math.log(g1), logG2 = Math.log(g2);
  const t = (sonosVolume - v1) / (v2 - v1);
  const logG = logG1 + t * (logG2 - logG1);
  return Math.max(AUTO_GAIN_MIN, Math.min(AUTO_GAIN_MAX, Math.exp(logG)));
}

function recomputeAutoGain(sonosVolume: number): void {
  if (sonosVolume <= 0) { micGainAuto = AUTO_GAIN_MAX; updateEffectiveGain(); return; }
  micGainAuto = interpolateGain(sonosVolume);
  updateEffectiveGain();
}

export function setAutoGainFromVolume(sonosVolume: number): void {
  lastSonosVol = sonosVolume;
  if (!autoGainEnabled || !calPoint1 || !calPoint2) return;
  recomputeAutoGain(sonosVolume);
  console.log(`[ALSA] Auto-gain: vol=${sonosVolume} → gain=${micGainAuto.toFixed(2)}x (effective: ${micGain.toFixed(1)}x)`);
}

export function disableAutoGain(): void {
  autoGainEnabled = false;
  updateEffectiveGain();
  console.log(`[ALSA] Auto-gain disabled → manual base gain ${micGainBase.toFixed(1)}x active`);
}

export function enableAutoGain(): void {
  autoGainEnabled = true;
  updateEffectiveGain();
  console.log(`[ALSA] Auto-gain enabled → effective ${micGain.toFixed(1)}x (interpolated from Sonos vol)`);
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
      channels: 2,
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
    console.log(`[ALSA] Mic started via native ALSA (${SAMPLE_RATE}Hz, ${currentFormat}, stereo→mono downmix, period=256, fft-hop=${HOP_SIZE}, device: ${currentDevice})`);

  } else {
    handleStartFailure(
      `[ALSA] Native alsa-capture binding inte laddad — mic disabled. ` +
      `Importfel: ${nativeImportError ?? 'okänt'}. ` +
      `Kör: cd /opt/lotus-light/pi/vendor/alsa-capture && sudo npm rebuild`
    );
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
  // Stereo interleaved → ta bara vänster kanal.
  // INMP441 har ett mic-element; L/R är samma signal duplicerad eller R tyst.
  // Format-specifika loopar för att undvika closure-overhead per sample.
  // Hi-shelf (single-pole) inlinad i loop:en — sparar en function call per sample.
  // Soft-clip: algebraisk x/(1+|x|) istället för Math.tanh — ~5x snabbare,
  // samma monotona "knee"-form över [-1,+1] för våra peakar.
  const gain = micGain;
  const hsAlpha = HS_ALPHA;
  const hsG = hsGain;
  let hs = hsState;
  let pos = ringPos;
  const ring = ringBuf;
  const mask = FFT_MASK;
  let received = samplesReceived;

  if (currentFormat === 'S32_LE') {
    const samples = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
    const frameCount = samples.length >> 1;
    const INV_S32 = 1 / 2147483648;
    for (let i = 0; i < frameCount; i++) {
      let raw = samples[i << 1] * INV_S32 * gain;
      if (raw > 0.5 || raw < -0.5) {
        const a = raw < 0 ? -raw : raw;
        raw = raw / (1 + a);
      }
      if (DEBUG_ENABLED) {
        const abs = raw < 0 ? -raw : raw;
        if (abs > debugPeakRaw) debugPeakRaw = abs;
      }
      hs += hsAlpha * (raw - hs);
      ring[pos] = hs + (raw - hs) * hsG;
      pos = (pos + 1) & mask;
      received++;
    }
  } else {
    const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    const frameCount = samples.length >> 1;
    const INV_S16 = 1 / 32768;
    for (let i = 0; i < frameCount; i++) {
      let raw = samples[i << 1] * INV_S16 * gain;
      if (raw > 0.5 || raw < -0.5) {
        const a = raw < 0 ? -raw : raw;
        raw = raw / (1 + a);
      }
      if (DEBUG_ENABLED) {
        const abs = raw < 0 ? -raw : raw;
        if (abs > debugPeakRaw) debugPeakRaw = abs;
      }
      hs += hsAlpha * (raw - hs);
      ring[pos] = hs + (raw - hs) * hsG;
      pos = (pos + 1) & mask;
      received++;
    }
  }

  hsState = hs;
  ringPos = pos;
  samplesReceived = received;

  if (samplesReceived >= HOP_SIZE) {
    processFFT();
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

  // Endast native-pathen finns kvar (arecord-fallback borttagen 2026-04-20)
  capture.close();
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
  
  lastFFTTimestamp = 0;
  _fftFrameCount = 0;
  micStartError = null;
  console.log('[ALSA] Microphone stopped');
}
