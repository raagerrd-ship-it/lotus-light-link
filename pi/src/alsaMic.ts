/**
 * ALSA microphone input → analysator → BandResult.
 * Uses native alsa-capture (direct snd_pcm_readi, no subprocess) — HARD REQUIRED.
 * Engine refuses to start mic if vendored binding can't be loaded (no arecord
 * fallback, since arecord adds ~30-50ms latency we deliberately avoid).
 *
 * EN KÄLLA (2026-08-23): den egna 1024-FFT-pipen är BORTA. Allt spektrum
 * beräknas nu EN gång, i audio-analyser (512 @375 Hz + 2048 @125 Hz), och
 * motorns BandResult härleds ur analysatorns oktavband/onsets. Ingen signal
 * beräknas längre två gånger → en plats att felsöka, en kalibrering.
 *
 * Event-driven: onFFTReady/onFluxReady fyras på BAND_HOP-takt (~75 Hz) direkt
 * efter en analysator-hop, så motorn får noll extra latens.
 */

import { dlog } from "./debugLog.js";
import { getItem, setItem } from './storage.js';
import { createAnalyser, type Frame } from './audio-analyser/index.js';
import { noteOverrun } from './runtimeHealth.js';


let _overrunLogAt = 0;

// Persistens av mic-state över restart. Tappades tidigare vid varje crash/restart →
// användaren upplevde "den glömde autogain mitt i låten" som en buggig auto-update.
// Sparas i DATA_DIR/mic-state.json via samma storage-shim som resten av engine.
const MIC_STATE_KEY = 'mic-state';
interface PersistedMicState {
  autoGainEnabled?: boolean;
  autoGainUserDisabled?: boolean;
  micGainBase?: number;
  calPoint1?: { vol: number; gain: number } | null;
  calPoint2?: { vol: number; gain: number } | null;
}
function saveMicState(): void {
  try {
    const s: PersistedMicState = {
      autoGainEnabled,
      autoGainUserDisabled,
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

// Ringbuffert-storlek. Behöver bara rymma några analysator-hops (jitter kan ge
// 3 hops i en callback) — 1024 ger gott om marginal.
const RING_SIZE = 1024;
const RING_MASK = RING_SIZE - 1;

// ── Band-takt mot motorn ──
// Motorn tickar på 25 ms (40 pps). Analysatorn producerar en frame var 128:e
// sample (2.67 ms). Vi fyrar band-eventet var 5:e hop ≈ 640 samples ≈ 13.3 ms
// (~75 Hz) → ungefär 2 band-events per tick, precis som den gamla 600-hoppen,
// men UTAN en andra FFT.
const BAND_EVERY_HOPS = 5;
let bandHopCounter = 0;

// ── BandResult ur analysatorns oktavband ──
// spec/onset är per-band AGC:ade 0..1. Motorn förväntar sig RMS-liknande värden
// i ~0–0.2-domänen (RAW_SCALE=5 i piEngine) → BAND_SCALE flyttar dit.
// frame.levelVU (auto-gainad, hop-takt-smoothad RMS) används som amplitud så
// tystnad ger 0 och tickEnergyFloor/onsetEnergyFloor fortsätter fungera.
const BAND_SCALE = 0.45;
// Bandvikter: låg = sub/kick/bas, hög = lowMid..air (summerar till 1 var).
const W_SUB = 0.35, W_KICK = 0.45, W_BASS = 0.20;
const W_LOWMID = 0.20, W_MID = 0.30, W_HIGHMID = 0.25, W_TREBLE = 0.15, W_AIR = 0.10;

// Övre kant (Hz) per analysator-band, i ordning sub..air.
const BAND_TOP_HZ = [60, 120, 250, 500, 2000, 5000, 10000, 16000];
// beatCutoffHz väljer vilka band som ingår i bassFlux (kick/bas-onset).
let beatCutoffBands = 3;   // default 250 Hz → sub+kick+bas
export function setBeatCutoffHz(hz: number): void {
  if (!Number.isFinite(hz)) return;
  let n = 1;
  for (let i = 0; i < BAND_TOP_HZ.length; i++) if (BAND_TOP_HZ[i] <= hz) n = i + 1;
  beatCutoffBands = Math.max(1, Math.min(BAND_TOP_HZ.length, n));
}

// Ring buffer for incoming PCM samples
const ringBuf = new Float32Array(RING_SIZE);
let ringPos = 0;

// High-shelf filter state
let hsState = 0;

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

// ── Portable analyser (dubbel-FFT: BPM, drop, per-band spec/onset, profile) ──
// Körs parallellt med den befintliga 1024-FFT-pipen och matas på SIN EGEN
// hop-takt (128 samples @ 48 kHz = 375 Hz), inte huvud-FFT:ns 100 Hz.
// Skälet: analysatorns interna konstanter (BIG_EVERY=3 → 2048-FFT vid 125 Hz,
// kickSeed<400 ≈ 1s uppvärmning, per-band-onset-median-fönster) är intrimmade
// mot 375 Hz i DMX-projektet. Att köra den på 100 Hz skulle ge 3.75× för glesa
// onsets och 4s kick-warmup. Egen tap = drop-in-passform utan omkalibrering.
const ANALYSER_HOP = 128;
const analyser = createAnalyser({ sampleRate: SAMPLE_RATE, hopSize: ANALYSER_HOP });
const analyserScratch = new Float32Array(ANALYSER_HOP);
let analyserSamplesReceived = 0;
let latestFrame: Frame | null = null;
let latestFrameAt = 0;
export function getLatestFrame(): Frame | null { return latestFrame; }
/** Väggklocka (ms) då senaste framen producerades — färskhetsguard hos motorn. */
export function getLatestFrameAt(): number { return latestFrameAt; }
/** Mata analysatorn med motorns PLL-grid → kick-grindning + taktfas (barShift). */
export function setAnalyserBeatGrid(grid: { bpm: number; anchorMs: number } | null): void {
  analyser.setBeatGrid(grid);
}


// ── Analyser cost budget (ms per 128-hop @ 375 Hz) ──────────────────────────
// Budget = 1000/375 ≈ 2.67 ms per hop. Överskrids den kappar ALSA bufferten
// och samples försvinner tyst → "ljuset känns segt" utan hög CPU. Mät ms/hop,
// INTE CPU-% (referens: DMX Zero 2W 1.03–1.26 ms/hop, spak = BIG_EVERY).
// EMA + max över senaste ~1s (~375 hops) exponeras via getAnalyserCost().
const ANALYSER_BUDGET_MS = 1000 / 375; // ≈2.667
let analyserMsEMA = 0;                 // α=0.02 → ~50-hop tidskonstant
let analyserMsMax = 0;                 // sedan senaste getAnalyserCost()-läsning
let analyserHopCount = 0;
let analyserOverBudgetCount = 0;       // hops > budget sedan senaste läsning
export function getAnalyserCost(): { msEMA: number; msMax: number; hops: number; overBudget: number; budgetMs: number } {
  const out = { msEMA: analyserMsEMA, msMax: analyserMsMax, hops: analyserHopCount, overBudget: analyserOverBudgetCount, budgetMs: ANALYSER_BUDGET_MS };
  analyserMsMax = 0;
  analyserOverBudgetCount = 0;
  return out;
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

/**
 * Härled motorns BandResult ur analysatorns senaste frame. INGEN egen FFT —
 * spektrumet är redan beräknat en gång i audio-analyser.
 *   bassRms/midHiRms : viktad oktavbands-nivå (AGC 0..1) × levelVU × BAND_SCALE
 *   totalRms         : levelVU × BAND_SCALE (auto-gainad RMS, tystnad → 0)
 *   flux             : analysatorns bredbands-flux (skarp, för onset)
 *   bassFlux         : summerad per-band-onset under beatCutoffHz (kick/bas)
 */
function emitBands(frame: Frame): void {
  const s = frame.spec;
  const o = frame.onset;
  const amp = frame.levelVU * BAND_SCALE;

  latestBands.bassRms = (W_SUB * s.sub + W_KICK * s.kick + W_BASS * s.bass) * amp;
  latestBands.midHiRms =
    (W_LOWMID * s.lowMid + W_MID * s.mid + W_HIGHMID * s.highMid +
     W_TREBLE * s.treble + W_AIR * s.air) * amp;
  latestBands.totalRms = amp;
  latestBands.flux = frame.flux;

  // bassFlux: onset-energi i banden under cutoffen. Onsets är 0..1 per band;
  // medelvärdet håller samma storleksordning som gamla flux (0.05–0.5) så
  // processOnsets absoluta golv (0.045) och median-prominens gäller oförändrat.
  const onsets = [o.sub, o.kick, o.bass, o.lowMid, o.mid, o.highMid, o.treble, o.air];
  let bf = 0;
  for (let i = 0; i < beatCutoffBands; i++) bf += onsets[i];
  latestBands.bassFlux = bf / beatCutoffBands;

  if (DEBUG_ENABLED) {
    debugTickCount++;
    if (debugTickCount >= DEBUG_INTERVAL) {
      dlog(`[ALSA-DBG] peak=${debugPeakRaw.toFixed(5)} bass=${latestBands.bassRms.toFixed(6)} midHi=${latestBands.midHiRms.toFixed(6)} total=${latestBands.totalRms.toFixed(6)} flux=${latestBands.flux.toFixed(6)} bassFlux=${latestBands.bassFlux.toFixed(6)}`);
      debugTickCount = 0;
      debugPeakRaw = 0;
    }
  }

  lastFFTTimestamp = performance.now();
  _fftFrameCount++;

  if (_onFluxReady) _onFluxReady(latestBands.flux);
  if (_onFFTReady) _onFFTReady(latestBands);
}

export function getLatestBands(): BandResult {
  return latestBands;
}

export function resetFluxState(): void {
  latestBands.bassRms = 0;
  latestBands.midHiRms = 0;
  latestBands.totalRms = 0;
  latestBands.flux = 0;
  latestBands.bassFlux = 0;
  bandHopCounter = 0;
  // Analysatorns AGC återinförs från neutral så första låtens gain inte hänger kvar
  analyser.resetGain();
  latestFrame = null;
  latestFrameAt = 0;
  analyserSamplesReceived = 0;
  analyserMsEMA = 0; analyserMsMax = 0; analyserHopCount = 0; analyserOverBudgetCount = 0;
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
// Explicit user-override: satt av disableAutoGain(), blockerar auto-reaktivering
// från Sonos-volym-pathen tills användaren själv slår på auto-gain igen.
let autoGainUserDisabled = false;
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

// ── Mic-gain kalibrering (15s mätning, target RMS 0.35) ──
// Samlar rawPre² (pre-gain, post-format-normalisering) → beräknar refGain så att
// vid nuvarande ljudnivå ger den effektiva signalen target-RMS. Låter användaren
// trycka en knapp när musiken spelar på en normal-nivå.
const MIC_CAL_TARGET_RMS = 0.35;
const MIC_CAL_DURATION_MS_DEFAULT = 15000;
let micCalActive = false;
let micCalSumSq = 0;
let micCalCount = 0;
let micCalStartAt = 0;
let micCalDurationMs = MIC_CAL_DURATION_MS_DEFAULT;
let micCalTargetRms = MIC_CAL_TARGET_RMS;
let micCalLastResult: { ok: boolean; measuredRms: number; newGain: number; oldGain: number; targetRms: number; samples: number; at: number } | null = null;

export function startMicGainCalibration(opts?: { durationMs?: number; targetRms?: number }): { started: boolean; durationMs: number; targetRms: number } {
  micCalDurationMs = Math.max(2000, Math.min(60000, opts?.durationMs ?? MIC_CAL_DURATION_MS_DEFAULT));
  micCalTargetRms = Math.max(0.05, Math.min(0.9, opts?.targetRms ?? MIC_CAL_TARGET_RMS));
  micCalSumSq = 0;
  micCalCount = 0;
  micCalStartAt = performance.now();
  micCalActive = true;
  dlog(`[ALSA] Mic-gain calibration started (${micCalDurationMs}ms, target RMS ${micCalTargetRms.toFixed(2)})`);
  return { started: true, durationMs: micCalDurationMs, targetRms: micCalTargetRms };
}

export function getMicGainCalibrationStatus() {
  if (micCalActive) {
    const elapsed = performance.now() - micCalStartAt;
    return {
      active: true,
      elapsedMs: Math.round(elapsed),
      durationMs: micCalDurationMs,
      targetRms: micCalTargetRms,
      samples: micCalCount,
      lastResult: micCalLastResult,
    };
  }
  return { active: false, lastResult: micCalLastResult };
}

function finishMicCalibration(): void {
  micCalActive = false;
  if (micCalCount < 100) {
    dlog(`[ALSA] Mic-gain calibration: too few samples (${micCalCount}), aborting`);
    micCalLastResult = { ok: false, measuredRms: 0, newGain: micGainBase, oldGain: micGainBase, targetRms: micCalTargetRms, samples: micCalCount, at: Date.now() };
    return;
  }
  const measuredRms = Math.sqrt(micCalSumSq / micCalCount);
  if (measuredRms < 1e-6) {
    dlog(`[ALSA] Mic-gain calibration: silence (rms=${measuredRms.toExponential(2)}), aborting`);
    micCalLastResult = { ok: false, measuredRms, newGain: micGainBase, oldGain: micGainBase, targetRms: micCalTargetRms, samples: micCalCount, at: Date.now() };
    return;
  }
  const oldGain = micGainBase;
  const newGain = Math.max(0.1, Math.min(50, micCalTargetRms / measuredRms));
  micGainBase = newGain;
  updateEffectiveGain();
  saveMicState();
  micCalLastResult = { ok: true, measuredRms, newGain, oldGain, targetRms: micCalTargetRms, samples: micCalCount, at: Date.now() };
  dlog(`[ALSA] Mic-gain calibration DONE: measuredRms=${measuredRms.toFixed(4)} → base gain ${oldGain.toFixed(2)}x → ${newGain.toFixed(2)}x (target ${micCalTargetRms.toFixed(2)})`);
}


export function isAutoGainEnabled(): boolean { return autoGainEnabled; }
export function isAutoGainUserDisabled(): boolean { return autoGainUserDisabled; }

/** Auto-aktivera auto-gain (första Sonos-volymen). Respekterar user-override:
 *  har användaren stängt av auto-gain via API:t händer inget. */
export function maybeAutoEnableAutoGain(): boolean {
  if (autoGainEnabled || autoGainUserDisabled) return false;
  enableAutoGain();
  return true;
}
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
  autoGainUserDisabled = true;
  updateEffectiveGain();
  saveMicState();
  dlog(`[ALSA] Auto-gain disabled → manual base gain ${micGainBase.toFixed(1)}x active`);
}

export function enableAutoGain(): void {
  autoGainEnabled = true;
  autoGainUserDisabled = false;
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
  if (typeof s.autoGainUserDisabled === 'boolean') autoGainUserDisabled = s.autoGainUserDisabled;
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
    capture.on('overrun', () => {
      noteOverrun();
      // Loggen är throttlad — räknaren i /api/status.runtime är sanningen.
      if (_overrunLogAt + 10000 < Date.now()) {
        _overrunLogAt = Date.now();
        console.warn('[ALSA] Buffer overrun detected');
      }
    });
    capture.on('readError', (message: string) => handleStartFailure(`[ALSA] readError: ${message}`));
    capture.on('error', (err: Error | string) => {
      const msg = typeof err === 'string' ? err : err?.message ?? String(err);
      handleStartFailure(`[ALSA] capture error: ${msg}`);
    });
    capture.on('close', () => {
      if (_audioCbCount === 0) handleStartFailure('[ALSA] capture closed before first audio callback');
    });
    dlog(`[ALSA] Mic started via native ALSA (${SAMPLE_RATE}Hz, ${currentFormat}, stereo→mono downmix, period=256, band-hop=${BAND_EVERY_HOPS}×${ANALYSER_HOP}, device: ${currentDevice})`);
    

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
// ── Nivå-hälsa (gain mot Sonos) ──
// Fönster om ~1 s. Peaken mäts PRE-gain och multipliceras med aktuell gain vid
// läsning — annars döljer soft-clip-knät (x/(1+|x|)) gain-ändringar helt: 10x och
// 40x hamnar båda kring 0.7 och mätaren ser frusen ut.
const CLIP_LEVEL = 0.9;
let healthPrePeakWin = 0;
let healthClipWin = 0;
let healthSampWin = 0;
let healthWinAt = 0;
let healthPrePeak = 0;
let healthClipPct = 0;

export interface MicHealth {
  /** Post-gain peak 0..1+ (utan soft-clip) i senaste fönstret. */
  peak: number;
  /** Andel samples (0..1) som nådde soft-clip-knät. */
  clipPct: number;
  /** 'low' = för lite gain (peak < 0.15), 'hot' = clipping, annars 'ok'. */
  status: 'low' | 'ok' | 'hot';
}

export function getMicHealth(): MicHealth {
  const now = performance.now();
  if (now - healthWinAt >= 1000 && healthSampWin > 0) {
    healthPrePeak = healthPrePeakWin;
    healthClipPct = healthClipWin / healthSampWin;
    healthPrePeakWin = 0; healthClipWin = 0; healthSampWin = 0;
    healthWinAt = now;
  }
  const peak = healthPrePeak * micGain;
  const status: MicHealth['status'] =
    healthClipPct > 0.001 || peak >= 1 ? 'hot' : peak < 0.15 ? 'low' : 'ok';
  return { peak, clipPct: healthClipPct, status };
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
    dlog(`[ALSA] audio cb count=${_audioCbCount}, totalBytes=${_audioCbBytes}, analyserHops=${analyserHopCount}`);
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
  const mask = RING_MASK;
  // Nivå-hälsa: peak + clip-räknare på post-gain-signalen (före soft-clip-knät).
  // Två jämförelser per sample @48 kHz ≈ försumbart, och ger UI:t ett svar på
  // om gainen ligger rätt mot Sonos-volymen.
  let peak = 0;
  let clipLocal = 0;
  let sampLocal = 0;
  // Kalibrering: ackumulera rawPre² lokalt (block-summa) → commit efter loop.
  const calOn = micCalActive;
  let calSumLocal = 0;
  let calCntLocal = 0;


  if (currentFormat === 'S32_LE') {
    const samples = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
    const frameCount = samples.length >> 1;
    const INV_S32 = 1 / 2147483648;
    for (let i = 0; i < frameCount; i++) {
      const rawPre = samples[i << 1] * INV_S32;
      if (calOn) { calSumLocal += rawPre * rawPre; calCntLocal++; }
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
      const absRaw = raw < 0 ? -raw : raw;
      if (absRaw > peak) peak = absRaw;
      if (absRaw > CLIP_LEVEL) clipLocal++;
      sampLocal++;
      hs += hsAlpha * (raw - hs);
      ring[pos] = hs + (raw - hs) * hsG;
      pos = (pos + 1) & mask;
    }
  } else {
    const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    const frameCount = samples.length >> 1;
    const INV_S16 = 1 / 32768;
    for (let i = 0; i < frameCount; i++) {
      const rawPre = samples[i << 1] * INV_S16;
      if (calOn) { calSumLocal += rawPre * rawPre; calCntLocal++; }
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
      const absRaw = raw < 0 ? -raw : raw;
      if (absRaw > peak) peak = absRaw;
      if (absRaw > CLIP_LEVEL) clipLocal++;
      sampLocal++;
      hs += hsAlpha * (raw - hs);
      ring[pos] = hs + (raw - hs) * hsG;
      pos = (pos + 1) & mask;
    }
  }

  hsState = hs;
  const prevRingPos = ringPos;
  ringPos = pos;
  const newSamples = (pos - prevRingPos) & mask; // frames tillförda denna callback
  if (peak > debugPeakRaw) debugPeakRaw = peak;
  healthPeakWin = peak > healthPeakWin ? peak : healthPeakWin;
  healthClipWin += clipLocal;
  healthSampWin += sampLocal;

  if (calOn && micCalActive) {
    micCalSumSq += calSumLocal;
    micCalCount += calCntLocal;
    if (performance.now() - micCalStartAt >= micCalDurationMs) finishMicCalibration();
  }



  // Portable analyser: egen 128-hop-tap (375 Hz), decoupled från 480-hop-FFT:n.
  // Dränera alla kompletta 128-block som ackumulerats. periodSize=256 → oftast
  // 2 hops per callback; jitter kan ge 1 eller 3. Läser bakåt från ringPos.
  analyserSamplesReceived += newSamples;
  while (analyserSamplesReceived >= ANALYSER_HOP) {
    const off = analyserSamplesReceived;
    const start = (ringPos - off) & mask;
    for (let i = 0; i < ANALYSER_HOP; i++) analyserScratch[i] = ringBuf[(start + i) & mask];
    const t0 = performance.now();
    latestFrame = analyser.process(analyserScratch);
    latestFrameAt = Date.now();
    const dt = performance.now() - t0;
    // EMA (α=0.02 ≈ 50-hop tidskonstant) + max sedan senaste läsning
    analyserMsEMA = analyserMsEMA === 0 ? dt : analyserMsEMA + 0.02 * (dt - analyserMsEMA);
    if (dt > analyserMsMax) analyserMsMax = dt;
    if (dt > ANALYSER_BUDGET_MS) analyserOverBudgetCount++;
    analyserHopCount++;
    analyserSamplesReceived -= ANALYSER_HOP;
    // Band-event mot motorn var BAND_EVERY_HOPS:e analysator-hop (~75 Hz).
    if (++bandHopCounter >= BAND_EVERY_HOPS) {
      bandHopCounter = 0;
      if (latestFrame) emitBands(latestFrame);
    }
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
  ringPos = 0;
  ringBuf.fill(0);
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
