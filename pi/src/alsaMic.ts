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
import { dlog } from "./debugLog.js";
import { getItem, setItem } from './storage.js';

// Persistens av mic-state över restart. Tappades tidigare vid varje crash/restart →
// användaren upplevde "den glömde autogain mitt i låten" som en buggig auto-update.
// Sparas i DATA_DIR/mic-state.json via samma storage-shim som resten av engine.
const MIC_STATE_KEY = 'mic-state';
interface PersistedMicState {
  autoGainEnabled?: boolean;
  micGainBase?: number;
  calPoint1?: { vol: number; gain: number } | null;
  calPoint2?: { vol: number; gain: number } | null;
}
function saveMicState(): void {
  try {
    const s: PersistedMicState = {
      autoGainEnabled,
      micGainBase,
      calPoint1,
      calPoint2,
    };
    setItem(MIC_STATE_KEY, JSON.stringify(s));
  } catch (e: any) {
    dlog(`[ALSA] saveMicState failed: ${e?.message ?? e}`);
  }
}
function loadMicState(): PersistedMicState | null {
  try {
    const raw = getItem(MIC_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedMicState;
  } catch (e: any) {
    dlog(`[ALSA] loadMicState failed: ${e?.message ?? e}`);
    return null;
  }
}

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
  dlog('[ALSA] Using native alsa-capture (vendored fork, direct snd_pcm_readi)');
} catch (eVendor: any) {
  const vendorReason = eVendor?.message ?? String(eVendor);
  try {
    AlsaCapture = (await import('alsa-capture')).default;
    useNative = true;
    micBackend = 'alsa-npm';
    dlog('[ALSA] Using native alsa-capture (npm package, direct snd_pcm_readi)');
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
  // Säkerhetsnät: rensa alla pending timers så timeouten inte triggar mot
  // en redan ersatt waiter-array vid snabba startMic/stopMic-cykler.
  for (const w of waiters) {
    try { clearTimeout(w.timer); } catch {}
  }
  return waiters;
}

function resolveMicReadyWaiters(): void {
  for (const waiter of clearMicReadyWaiters()) {
    waiter.resolve();
  }
}

function rejectMicReadyWaiters(message: string): void {
  micStartError = message;
  const error = new Error(message);
  for (const waiter of clearMicReadyWaiters()) {
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
  /** Spectral flux summerad ENBART över sub+bas-bins (< 150 Hz). Används för
   *  kick/bastrumme-onset så hi-hats/snare inte triggar pulsen. */
  bassFlux: number;
}

const SAMPLE_RATE = 48000;
const FFT_SIZE = FFT_N; // 1024
// HOP_SIZE = 480 frames (10.0ms @ 48kHz) — exakt 100 Hz FFT-takt.
// Synkar deterministiskt mot tickMs=20ms (50 pps): exakt 2 FFT-frames per
// engine-tick → senaste FFT är max 10ms gammal när tickInner läser → jämn
// transient-respons utan jitter mellan 1 och 2 frames per tick.
// (Tidigare HOP=512 gav ~93Hz → 1.87 frames/tick → ojämn färskhet.)
//
// Engine.tickInner triggas dock bara på tickMs-takt (gate i piEngine.onFFTFrame
// kollar `elapsed >= tickMs`) → BLE-trafik oförändrad, men engine ser senaste
// FFT-frame när den väl kör → snabbare attack-respons.
//
// CPU-konsekvens: ~100 FFT/s × ~1ms ≈ 10% CPU på Pi Zero 2W (var ~9% @ HOP=512).
// Vendor-bufferten är 8× period = 46ms vilket täcker värsta GC-pausen.
const HOP_SIZE = 480;
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

// ── Beat-detektionens lågpass-brytfrekvens ──
// bassFlux summeras över alla bins UNDER denna bin (kick/bas-onset). Default 150 Hz
// (samma som tidigare fasta split). Runtime-tunbar via setBeatCutoffHz() från engine.
let beatCutoffBin = LO_BIN_HIGH;
export function setBeatCutoffHz(hz: number): void {
  if (!Number.isFinite(hz)) return;
  const bin = Math.floor(hz / BIN_WIDTH);
  beatCutoffBin = Math.max(2, Math.min(BIN_COUNT, bin));
}



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

// ── Smoothing flyttad till engine.tickInner @ 50Hz ──
// Tidigare körde vi en EMA här @ 100Hz OCH en till i tickInner → kvadrerad
// effektiv alpha (slött ljud). Sedan togs båda bort → flimmer pga FFT-rate-
// hack (10ms) aliaserades mot tick-takten (20ms). Nu: rå RMS levereras hit,
// smoothing körs på tick-takt så filtret är synkat mot output-raten.



// Noise gate borttagen 2026-04-21: brightnessFloor + dynamics + perceptualGamma
// i engine sköter redan tystnadströskeln, och den gamla gaten kvävde första
// kicken efter en tyst passage (3× knee-ramp). bassRms etc. flödar nu rakt
// från rå RMS — ingen attenuation, ingen recovery.

// ── Anti-alias smoothing över FFT-frames ──
// Tick:en (50 Hz) samplar bara hälften av FFT-frames (100 Hz), vilket gör att
// frame-to-frame-brus ser ut som synliga hopp i ljuset. En kort rolling average
// över ~3 FFT-frames glättar bruset utan att gömma transienter:
//   - Window 3 frames ≈ 30ms total averaging
//   - Kick-trummor (attack ~15ms) når full styrka inom 1-2 fönster (10-20ms latens)
//   - Långt under perceptuell tröskel för "samtidig" ljud+ljus (~50ms)
// Pre-allokerade typed arrays — noll allokering i hot path.
const FFT_SMOOTH_WINDOW = 3;
const fftBassHistory = new Float32Array(FFT_SMOOTH_WINDOW);
const fftMidHiHistory = new Float32Array(FFT_SMOOTH_WINDOW);
const fftTotalHistory = new Float32Array(FFT_SMOOTH_WINDOW);
let fftHistoryPos = 0;
let fftHistoryFilled = 0;

// Latest computed bands (static object — mutated in place)
let latestBands: BandResult = { bassRms: 0, midHiRms: 0, totalRms: 0, flux: 0, bassFlux: 0 };

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
let _onFluxReady: ((flux: number) => void) | null = null;

/** Register callback fired immediately after each FFT frame completes.
 *  The engine uses this to process with zero timer latency. */
export function onFFTReady(cb: FFTReadyCallback | null): void {
  _onFFTReady = cb;
}

export function onFluxReady(cb: ((flux: number) => void) | null): void {
  _onFluxReady = cb;
}

// ── FFT frame counter (for diagnostics: faktisk frames/s från ALSA → FFT) ──
let _fftFrameCount = 0;
export function getFFTFrameCount(): number { return _fftFrameCount; }

// ── ACR-capture: valbar rå-PCM-tap för ACRCloud-igenkänning ──
// Tappar rå vänster-kanal PRE-gain/PRE-EQ (renast fingerprint), decimerar
// 48k→8k (var 6:e sample) och buffrar Int16 mono. Bakom flagga → noll arbete
// när av (V8 eliminerar grenen i hot-path, samma mönster som DEBUG).
const ACR_SAMPLE_RATE = 8000;
const ACR_DECIM = SAMPLE_RATE / ACR_SAMPLE_RATE; // 6
const ACR_SECONDS = 10;
const ACR_MAX_SAMPLES = ACR_SAMPLE_RATE * ACR_SECONDS; // 80000
let acrCaptureActive = false;
let acrBuf = new Int16Array(ACR_MAX_SAMPLES);
let acrLen = 0;
let acrDecimCount = 0;

/** Starta en ~10s rå-PCM-capture (8kHz mono) för ACR-identifiering. */
export function startAcrCapture(): void {
  acrLen = 0;
  acrDecimCount = 0;
  acrCaptureActive = true;
}

/** Avbryt pågående ACR-capture utan att bygga WAV. */
export function stopAcrCapture(): void {
  acrCaptureActive = false;
  acrLen = 0;
}

/** True när ~10s samlats. */
export function isAcrCaptureReady(): boolean {
  return acrLen >= ACR_MAX_SAMPLES;
}

/** Bygg WAV-buffer från capturad PCM. null om inte tillräckligt samlat. */
export function getAcrCaptureWav(): Buffer | null {
  if (acrLen < ACR_SAMPLE_RATE * 3) return null; // minst 3s
  acrCaptureActive = false;
  const dataBytes = acrLen * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // PCM chunk size
  buf.writeUInt16LE(1, 20);           // PCM format
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(ACR_SAMPLE_RATE, 24);
  buf.writeUInt32LE(ACR_SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < acrLen; i++) buf.writeInt16LE(acrBuf[i], 44 + i * 2);
  return buf;
}

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
  let bassFlux = 0; // flux under beatCutoffBin (lågpass) — kick/bas-onset

  // Segment 1: 0 .. LO_BIN_LOW (only total + flux; ingår i bassFlux = sub)
  for (let i = 0; i < LO_BIN_LOW; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    const diff = power - prevPower[i];
    if (diff > 0) { flux += diff; if (i < beatCutoffBin) bassFlux += diff; }
    prevPower[i] = power;
  }
  // Segment 2: LO_BIN_LOW .. LO_BIN_HIGH (loSum; ingår i bassFlux = bas)
  for (let i = LO_BIN_LOW; i < LO_BIN_HIGH; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    loSum += power;
    const diff = power - prevPower[i];
    if (diff > 0) { flux += diff; if (i < beatCutoffBin) bassFlux += diff; }
    prevPower[i] = power;
  }
  // Segment 3: HI_BIN_LOW .. HI_BIN_HIGH (hiSum)
  for (let i = HI_BIN_LOW; i < HI_BIN_HIGH; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    hiSum += power;
    const diff = power - prevPower[i];
    if (diff > 0) { flux += diff; if (i < beatCutoffBin) bassFlux += diff; }
    prevPower[i] = power;
  }
  // Segment 4: HI_BIN_HIGH .. BIN_COUNT (only total + flux)
  for (let i = HI_BIN_HIGH; i < BIN_COUNT; i++) {
    const r = fftRe[i], m = fftIm[i];
    const power = (r * r + m * m) * INV_N2;
    totalSum += power;
    const diff = power - prevPower[i];
    if (diff > 0) { flux += diff; if (i < beatCutoffBin) bassFlux += diff; }
    prevPower[i] = power;

  }

  // ── Energy-per-octave: matchar mänsklig perception av frekvensbalans ──
  // Tidigare delades med antal bins → diskant (466 bins) dränktes vs bas (3 bins).
  // Nu: total power i bandet / antal oktaver bandet täcker → båda jämförbara.
  const rawBass = Math.sqrt(loSum * INV_LO_OCT);
  const rawMidHi = Math.sqrt(hiSum * INV_HI_OCT);
  const rawTotal = Math.sqrt(totalSum / BIN_COUNT);


  // ── Anti-alias smoothing: rolling average över senaste FFT-frames ──
  // Eliminerar frame-to-frame-brus (alias mellan ~100Hz FFT och 50Hz tick) utan
  // att gömma transient-respons. EMA-smoothingen i engine.tickInner körs ovanpå
  // detta för musikalisk mjukhet. flux smoothas EJ — onset-detektion behöver
  // skarpa transienter för att fånga kick-trummor.
  fftBassHistory[fftHistoryPos] = rawBass;
  fftMidHiHistory[fftHistoryPos] = rawMidHi;
  fftTotalHistory[fftHistoryPos] = rawTotal;
  fftHistoryPos = (fftHistoryPos + 1) % FFT_SMOOTH_WINDOW;
  if (fftHistoryFilled < FFT_SMOOTH_WINDOW) fftHistoryFilled++;

  let bassSum = 0, midHiSum = 0, totalSum_smooth = 0;
  for (let i = 0; i < fftHistoryFilled; i++) {
    bassSum += fftBassHistory[i];
    midHiSum += fftMidHiHistory[i];
    totalSum_smooth += fftTotalHistory[i];
  }
  const invFilled = 1 / fftHistoryFilled;

  latestBands.bassRms = bassSum * invFilled;
  latestBands.midHiRms = midHiSum * invFilled;
  latestBands.totalRms = totalSum_smooth * invFilled;
  latestBands.flux = flux;  // skarp — onset-detektion behöver detta
  latestBands.bassFlux = bassFlux;  // kick/bas-only flux

  // Debug logging every ~2 seconds (only when DEBUG=true)
  if (DEBUG_ENABLED) {
    debugTickCount++;
    if (debugTickCount >= DEBUG_INTERVAL) {
      dlog(`[ALSA-DBG] peak=${debugPeakRaw.toFixed(5)} bass=${latestBands.bassRms.toFixed(6)} midHi=${latestBands.midHiRms.toFixed(6)} total=${latestBands.totalRms.toFixed(6)} flux=${flux.toFixed(6)}`);
      debugTickCount = 0;
      debugPeakRaw = 0;
    }
  }

  // Stamp FFT completion time
  lastFFTTimestamp = performance.now();
  _fftFrameCount++;

  // Fire event immediately — engine can process with zero latency
  if (_onFluxReady) _onFluxReady(flux);
  if (_onFFTReady) _onFFTReady(latestBands);
}

export function getLatestBands(): BandResult {
  return latestBands;
}

export function resetFluxState(): void {
  prevPower.fill(0);
  // Nollställ anti-alias-historik så pre/post-paus-data inte blandas
  fftBassHistory.fill(0);
  fftMidHiHistory.fill(0);
  fftTotalHistory.fill(0);
  fftHistoryPos = 0;
  fftHistoryFilled = 0;
}

/** Return timestamp (performance.now) of last FFT completion */
export function getLastFFTTimestamp(): number {
  return lastFFTTimestamp;
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
  saveMicState();
  dlog(`[ALSA] Mic base gain set to ${micGainBase.toFixed(1)}x (effective: ${micGain.toFixed(1)}x, auto=${autoGainEnabled})`);
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
  saveMicState();
  if (p1 && p2) {
    dlog(`[ALSA] Gain cal: point1=(vol=${p1.vol}, gain=${p1.gain.toFixed(1)}), point2=(vol=${p2.vol}, gain=${p2.gain.toFixed(1)})`);
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
  dlog(`[ALSA] Auto-gain: vol=${sonosVolume} → gain=${micGainAuto.toFixed(2)}x (effective: ${micGain.toFixed(1)}x)`);
}

export function disableAutoGain(): void {
  autoGainEnabled = false;
  updateEffectiveGain();
  saveMicState();
  dlog(`[ALSA] Auto-gain disabled → manual base gain ${micGainBase.toFixed(1)}x active`);
}

export function enableAutoGain(): void {
  autoGainEnabled = true;
  // Räkna om direkt från senast kända Sonos-volym så vi inte fastnar på default 15x
  // tills användaren råkar dra i en slider eller volymen råkar ändras.
  if (calPoint1 && calPoint2 && lastSonosVol != null) {
    recomputeAutoGain(lastSonosVol);
    dlog(`[ALSA] Auto-gain enabled → recomputed from cached vol=${lastSonosVol} → gain=${micGainAuto.toFixed(2)}x (effective: ${micGain.toFixed(1)}x)`);
  } else {
    updateEffectiveGain();
    dlog(`[ALSA] Auto-gain enabled → effective ${micGain.toFixed(1)}x (no cached vol yet, awaiting Sonos poll)`);
  }
  saveMicState();
}

// Restore persisted state vid modulinit. Körs efter att alla let:s deklarerats.
// Krasch/restart mitt i låt → samma autogain/gain/cal som innan.
(function restoreMicState() {
  const s = loadMicState();
  if (!s) { dlog('[ALSA] No persisted mic-state found, using defaults'); return; }
  if (typeof s.micGainBase === 'number') micGainBase = Math.max(0.1, Math.min(50, s.micGainBase));
  if (s.calPoint1 && typeof s.calPoint1.vol === 'number' && typeof s.calPoint1.gain === 'number') calPoint1 = s.calPoint1;
  if (s.calPoint2 && typeof s.calPoint2.vol === 'number' && typeof s.calPoint2.gain === 'number') calPoint2 = s.calPoint2;
  if (typeof s.autoGainEnabled === 'boolean') autoGainEnabled = s.autoGainEnabled;
  updateEffectiveGain();
  dlog(`[ALSA] Restored mic-state: base=${micGainBase.toFixed(1)}x auto=${autoGainEnabled} cal=${calPoint1 && calPoint2 ? 'yes' : 'no'}`);
})();

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

// (ALSA-watchdog removed in FIX 25 — Playback-watchdog in src/index.ts now
// covers ALSA-stuck recovery via tickOkCount monitoring.)

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
    dlog(`[ALSA] Mic started via native ALSA (${SAMPLE_RATE}Hz, ${currentFormat}, stereo→mono downmix, period=256, fft-hop=${HOP_SIZE}, device: ${currentDevice})`);
    

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

/** True om ALSA-capture är aktiv just nu. Används av idle-disconnect-pathen. */
export function isMicActive(): boolean {
  return capture !== null;
}
function onAudioData(buf: Buffer): void {
  _audioCbCount++;
  _audioCbBytes += buf.byteLength;
  if (_audioCbFirstAt === 0) {
    _audioCbFirstAt = performance.now();
    dlog(`[ALSA] FIRST audio callback fired at t=${_audioCbFirstAt.toFixed(1)}ms, ${buf.byteLength} bytes`);
    resolveMicReadyWaiters();
  }
  if (_audioCbCount === 50 || _audioCbCount === 200 || (DEBUG_ENABLED && _audioCbCount % 1000 === 0)) {
    dlog(`[ALSA] audio cb count=${_audioCbCount}, totalBytes=${_audioCbBytes}, samplesReceived=${samplesReceived}, HOP_SIZE=${HOP_SIZE}`);
  }
  // Stereo interleaved → ta bara vänster kanal.
  // INMP441 har ett mic-element; L/R är samma signal duplicerad eller R tyst.
  // Hi-shelf (single-pole) inlinad i loop:en — sparar en function call per sample.
  // Soft-clip: algebraisk x/(1+|x|) istället för Math.tanh — ~5x snabbare.
  const gain = micGain;
  const hsAlpha = HS_ALPHA;
  const hsG = hsGain;
  let hs = hsState;
  let pos = ringPos;
  const ring = ringBuf;
  const mask = FFT_MASK;
  let received = samplesReceived;
  // DEBUG-branch: peak-tracking inlinad bakom konstant flagga så V8 JIT
  // kan eliminera grenarna helt i prod (DEBUG_ENABLED=false vid boot).
  let peak = DEBUG_ENABLED ? debugPeakRaw : 0;

  if (currentFormat === 'S32_LE') {
    const samples = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
    const frameCount = samples.length >> 1;
    const INV_S32 = 1 / 2147483648;
    for (let i = 0; i < frameCount; i++) {
      const rawPre = samples[i << 1] * INV_S32;
      if (acrCaptureActive && acrLen < ACR_MAX_SAMPLES && ++acrDecimCount >= ACR_DECIM) {
        acrDecimCount = 0;
        let s = rawPre * 32767;
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        acrBuf[acrLen++] = s;
      }
      let raw = rawPre * gain;
      if (raw > 0.5 || raw < -0.5) {
        const a = raw < 0 ? -raw : raw;
        raw = raw / (1 + a);
      }
      if (DEBUG_ENABLED) {
        const abs = raw < 0 ? -raw : raw;
        if (abs > peak) peak = abs;
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
      const rawPre = samples[i << 1] * INV_S16;
      if (acrCaptureActive && acrLen < ACR_MAX_SAMPLES && ++acrDecimCount >= ACR_DECIM) {
        acrDecimCount = 0;
        let s = rawPre * 32767;
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        acrBuf[acrLen++] = s;
      }
      let raw = rawPre * gain;
      if (raw > 0.5 || raw < -0.5) {
        const a = raw < 0 ? -raw : raw;
        raw = raw / (1 + a);
      }
      if (DEBUG_ENABLED) {
        const abs = raw < 0 ? -raw : raw;
        if (abs > peak) peak = abs;
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
  if (DEBUG_ENABLED) debugPeakRaw = peak;

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
  // (smoothing-state finns inte längre i alsaMic — körs i engine.tickInner)
  latestBands.bassRms = 0;
  latestBands.midHiRms = 0;
  latestBands.totalRms = 0;
  latestBands.flux = 0;
  latestBands.bassFlux = 0;
  _audioCbCount = 0;
  _audioCbBytes = 0;
  _audioCbFirstAt = 0;
  
  lastFFTTimestamp = 0;
  _fftFrameCount = 0;
  micStartError = null;
  dlog('[ALSA] Microphone stopped');
}
