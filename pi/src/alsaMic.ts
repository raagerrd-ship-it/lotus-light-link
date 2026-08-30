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
import { noteOverrun, noteNativeCall } from './runtimeHealth.js';


let _overrunLogAt = 0;

// Persistens av mic-state över restart. Tappades tidigare vid varje crash/restart →
// användaren upplevde "den glömde autogain mitt i låten" som en buggig auto-update.
// Sparas i DATA_DIR/mic-state.json via samma storage-shim som resten av engine.
const MIC_STATE_KEY = 'mic-state';
interface PersistedMicState {
  micGainBase?: number;
  calPoint1?: { vol: number; gain: number } | null;
  calPoint2?: { vol: number; gain: number } | null;
  /** Gammalt format (FIX 4): volym → ref. Migreras till learnedGain vid load. */
  learnedGainRefs?: Record<string, number>;
  /** FIX 4b: volym → {ref, sum, count, learnMs, locked}. */
  learnedGain?: Record<string, LgEntry>;
}
function saveMicState(): void {
  try {
    const learned: Record<string, LgEntry> = {};
    for (const [vol, e] of lgTable) learned[String(vol)] = e;
    const s: PersistedMicState = {
      micGainBase,
      calPoint1,
      calPoint2,
      learnedGain: learned,
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
  /** DIRIGENTEN, insignal 2: SEKTIONSENERGI (0..1) från analysatorn.
   *  Följer uppbyggnader/breakdowns; rå amplitud får bara skala loudness. */
  shape: number;
  /** Spektral andel bas (0..1) — bara för färg-tilt, aldrig brightness. */
  bassShare: number;
  /** Spektral andel mid/diskant (0..1) — bara för färg-tilt. */
  hiShare: number;
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
const BAND_EVERY_HOPS = 7;
let bandHopCounter = 0;

// ── BandResult ur analysatorns oktavband ──
// spec/onset är per-band AGC:ade 0..1. Motorn använder bara spektral andel här;
// brightness-formen kommer från frame.intensity och nivåskalan från lightRawRms×gain.

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

// LJUS-TAPP: ~130 ms EMA av RÅ (o-gainad) block-RMS. micGain appliceras i
// emitBands → ljusnivån är linjär i användarens gain, helt utan AGC.
let lightRawRms = 0;
let _lastLightSum = -1;
let _lastFrameCount = -1;
let _contentFreezeStreak = 0;
let _contentFreezeAt = 0;
// Andra freeze-detektorn: fångar en DMA-wedge som varierar sista decimalen.
let _micPlaybackGate = false;
let _stableRmsSince = 0;
let _stableRmsValue = 0;
const STABLE_RMS_MIN = 0.003;
// RELATIVT fönster: lightRawRms är en 130 ms EMA — ett fast absolut tak på 2e-5
// gav falsk "frys" på lugna, jämna partier (2e-5 vid nivå 0.003 = 0.7 %) →
// onödiga reopen och till slut process-restart. En äkta DMA-wedge ger EXAKT
// noll variation, så ett relativt golv fångar den ändå.
const STABLE_RMS_DELTA = 0.00002;
const STABLE_RMS_REL = 0.02;


/** Matas från Sonos playback-state; freeze-diagnostik kör bara under PLAYING. */
export function setMicPlaybackGate(playing: boolean): void {
  _micPlaybackGate = playing;
  if (!playing) { _stableRmsSince = 0; _stableRmsValue = 0; }
}

/** Ms som micens RMS varit nästan konstant under PLAYING (0 = ej fruset). */
export function getMicStableContentFrozenMs(): number {
  return _stableRmsSince > 0 ? Math.round(performance.now() - _stableRmsSince) : 0;
}

/** Ms som mic-buffertens innehåll varit byte-identiskt (0 = ej fruset). */
export function getMicContentFrozenMs(): number {
  return _contentFreezeStreak > 0 ? Math.round(performance.now() - _contentFreezeAt) : 0;
}


// Latest computed bands (static object — mutated in place)
let latestBands: BandResult = { bassRms: 0, midHiRms: 0, totalRms: 0, flux: 0, bassFlux: 0, shape: 0, bassShare: 0.5, hiShare: 0.5 };


// Timestamp of last FFT completion (performance.now())
let lastFFTTimestamp = 0;

// Debug — only active when DEBUG=true env var is set
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const DEBUG_INTERVAL = 690; // ~2 seconds at 44100/128 ≈ 345 frames/sec
let debugTickCount = 0;
let debugPeakRaw = 0;

const hsGain = Math.pow(10, 9 / 20);  // +9dB hi-shelf for INMP441 at ~1m distance
const HS_ALPHA = 0.15;
// ring = hs + (rawPre - hs) * hsGain, med hs redan uppdaterad → återanvänd deltat:
// (rawPre - hs_new) = (1 - HS_ALPHA) * d, alltså ring = hs_new + d * HS_D_COEFF.
const HS_D_COEFF = (1 - HS_ALPHA) * hsGain;


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

/**
 * Sann dirigent-takt: emitBands fyras var BAND_EVERY_HOPS:te analysator-hop.
 * 128 × 5 / 48000 = 13.333… ms → 75 Hz (INTE 100 Hz som gamla kommentarer påstod).
 */
export const FRAME_MS = (ANALYSER_HOP * BAND_EVERY_HOPS / SAMPLE_RATE) * 1000;

// TVÅ TAPPAR (2026-08-24): ring-bufferten innehåller RÅ (o-gainad) mic-signal.
//  • ANALYS-tappen: RÅ signal → analysatorns AGC gör HELA gainen dynamiskt
//    (mål 0.8 = 80 % med headroom). INGEN fast pre-gain: en fast faktor före
//    AGC:n kan bränna in klippning som AGC:n inte kan ta bort (uppmätt v1.0.743:
//    level pinnad 100 → ostabilt beat-lås). Klampen höjs istället till 600× så
//    AGC:n själv når målet från rå mic-nivå. Tystnad hanteras av noiseFloor-
//    gaten i analysatorn (AGC:n fryser då och förstärker inte mic-brus).
//    Användarens gain rör ALDRIG denna väg.
//  • LJUS-tappen: egen linjär RMS × micGain (tvåpunkts Sonos-kurva) → brightness.
//    Ingen AGC, ingen normalisering → gainen är effektiv hela vägen till lampan.
const analyser = createAnalyser({
  sampleRate: SAMPLE_RATE,
  hopSize: ANALYSER_HOP,
  // Percentil-AGC: 0.75 är ett TAK för topparna (95:e percentilen), inte ett medel.
  autoGainTarget: 0.75,
  maxGain: 200,
  noiseFloor: 0.0015,
});
analyser.setGainLock(false);
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
/** Mjuk låtbytes-hint till tempo-sökningen (Sonos trackName ändrades). */
export function hintAnalyserTrackChange(windowMs = 5000): void {
  analyser.hintTrackChange(windowMs);
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
 *   bassRms/midHiRms : spektral ANDEL (ur specAbs) × ljus-amplituden
 *   totalRms         : ljus-amplituden = rå RMS × micGain (ingen AGC)
 *   flux             : analysatorns bredbands-flux (skarp, för onset)
 *   bassFlux         : summerad per-band-onset under beatCutoffHz (kick/bas)
 */
// Återanvänd buffert — emitBands körs 100 Hz, ingen per-frame allokering.
const _onsetScratch = new Float64Array(8);

function emitBands(frame: Frame): void {
  const a = frame.specAbs;
  const o = frame.onset;
  // TVÅ TAPPAR (2026-08-24): amplituden kommer INTE från frame.levelVU längre —
  // den är AGC:ad och normaliserar bort användarens gain (ljuset blev gain-
  // okänsligt och pinnade ~50 %). Ljuset drivs av den egna linjära RMS:en ×
  // micGain (tvåpunkts Sonos-kurva). Analysatorns AGC rör bara detektionen.
  let amp = lightRawRms * micGainAuto;
  if (amp > 1) amp = 1;

  // Den ABSOLUTA bandmagnituden används bara som SPEKTRAL ANDEL (bas kontra
  // resten) — aldrig som nivå, eftersom den är AGC:ad.
  const lowAbs = a.sub + a.kick + a.bass;
  const hiAbs = a.lowMid + a.mid + a.highMid + a.treble + a.air;
  const totAbs = lowAbs + hiAbs + 1e-9;
  const lowFrac = lowAbs / totAbs;
  const hiFrac = hiAbs / totAbs;
  // share/0.5 → en jämnt fördelad mix ger 1.0 i båda tapparna (inget tapp vid w=0.5).
  const lowShare = Math.min(1, lowFrac / 0.5);
  const hiShare = Math.min(1, hiFrac / 0.5);


  latestBands.bassRms = amp * lowShare;
  latestBands.midHiRms = amp * hiShare;
  latestBands.totalRms = amp;
  latestBands.flux = frame.flux;

  // DIRIGENTEN v2: shape = sektionsrelativ energi. levelVU är uppmätt för platt
  // på riktiga låtar; intensity följer uppbyggnader och breakdowns.
  latestBands.bassShare = lowFrac;
  latestBands.hiShare = hiFrac;

  // Nivå-hälsa på den LINJÄRA totalnivån (samma tal som input-baren visar).
  // Inte max(bass, midHi) — de är andelar mot 0.5 och pinnas nära 1.0.
  const be = latestBands.totalRms;
  if (be > healthBandPeakWin) healthBandPeakWin = be;
  if (be >= 1) healthClipFrames++;
  healthFrames++;


  // bassFlux: onset-energi i banden under cutoffen. Onsets är 0..1 per band;
  // medelvärdet håller samma storleksordning som gamla flux (0.05–0.5) så
  // processOnsets absoluta golv (0.045) och median-prominens gäller oförändrat.
  const onsets = _onsetScratch;
  onsets[0] = o.sub; onsets[1] = o.kick; onsets[2] = o.bass; onsets[3] = o.lowMid;
  onsets[4] = o.mid; onsets[5] = o.highMid; onsets[6] = o.treble; onsets[7] = o.air;
  let bf = 0;
  for (let i = 0; i < beatCutoffBands; i++) bf += onsets[i];
  latestBands.bassFlux = bf / beatCutoffBands;

  // Liten bassFlux-additiv (~0–0.15) ger beat-punch utan att suga ihop formen.
  const beatPunch = Math.min(0.15, latestBands.bassFlux * 0.25);
  latestBands.shape = Math.min(1, Math.max(0, frame.intensity + beatPunch));

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
  lightRawRms = 0;
  latestBands.flux = 0;
  latestBands.bassFlux = 0;
  latestBands.shape = 0;
  bandHopCounter = 0;
  // Analysatorns AGC startas om — men SEEDAD från kalibreringen (se
  // seedAnalyserGain) istället för 1×, så den är i rätt storleksordning direkt.
  seedAnalyserGain('reset');

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
// EN GAIN-KÄLLA (2026-08-23): tvåpunkts-kurvan mot Sonos-volym är ALLTID gainen.
// Inget "manuellt läge", ingen adaptiv AGC, ingen auto-omkalibrering. Saknas
// cal-punkter används micGainBase som ren fallback (och som mål för engångs-
// verktyget "kalibrera automatiskt").
let micGainBase = 75.0;  // fallback innan kurvan är satt (RAW_SCALE=5 borta → ~5× högre tal)
let micGainAuto = 75.0;  // gain interpolerad från Sonos-volym (kurvan)
// micGain borttagen (FIX 2) — micGainAuto ÄR den effektiva gainen; enda writern
// var `micGain = micGainAuto`. Seed-on-large-change jämför nu ny vs förra värdet.
let prevGainForSeed = 75.0;

function updateEffectiveGain(): void {
  const prev = prevGainForSeed;
  prevGainForSeed = micGainAuto;
  // Din kalibrering är en MÄTNING av rummets nivå vid en given Sonos-volym —
  // alltså exakt den information AGC:n annars måste jobba upp sig till. Vi
  // SEEDAR därför analysatorns AGC-startvärde när kurvan flyttar sig markant
  // (>1.5× upp/ner). Det är bara ett startvärde: AGC:n fortsätter fritt och
  // ingen användar-gain rör rå-PCM:en eller ringen.
  if (prev > 0 && (micGainAuto / prev > 1.5 || prev / micGainAuto > 1.5)) seedAnalyserGain('gain-change');
}

/** Seedar analysatorns AGC från ljus-kalibreringen (storleksordning, inte exakt).
 *  Ljus-tappen är kalibrerad så att rms × micGain ≈ 1 vid topparna; AGC:n siktar
 *  på 0.8 av snitt-envelopen, så micGain är rätt storleksordning att börja på. */
function seedAnalyserGain(reason: string): void {
  const seed = Math.max(0.5, Math.min(AUTO_GAIN_MAX, micGainAuto));
  analyser.resetGain(seed);
  dlog(`[ALSA] AGC seedad till ${seed.toFixed(1)}x från kalibreringen (${reason})`);
}

export function getMicGain(): number { return micGainBase; }

export function getEffectiveGain(): number { return micGainAuto; }
export function getAutoGainMultiplier(): number { return micGainAuto; }

/** Sätt gain direkt (engångs-kalibreringsverktyget). Kurvan skriver över den
 *  vid nästa volym-recompute — punkterna är auktoritativa. */
export function setMicGain(gain: number): void {
  micGainBase = Math.max(0.1, Math.min(AUTO_GAIN_MAX, gain));
  micGainAuto = micGainBase;
  updateEffectiveGain();
  saveMicState();
  dlog(`[ALSA] Mic gain set directly to ${micGainBase.toFixed(1)}x`);
}


/** Two-point gain calibration — ENDA gain-källan (manuell, deterministisk kurva).
 *  Cal-punkterna är absoluta gain-värden, interpolerade på Sonos-volym. */
export interface GainCalPoint { vol: number; gain: number; }

// Defaults = live-intrimmade värden (v1.0.749, 2026-08-25): full 0–100 % span,
// pinnat 7 %, 0 % input-klipp efter percentil-AGC:n (mål 0.75).
// Live-intrimmade defaults (2026-08-25) — gäller tills storage laddar egna punkter.
let calPoint1: GainCalPoint | null = { vol: 12, gain: 12 };
let calPoint2: GainCalPoint | null = { vol: 45, gain: 1.2 };
let lastSonosVol: number | null = null;  // cachat för live-omräkning vid slider-change
const AUTO_GAIN_MAX = 300.0;
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
  const newGain = Math.max(0.1, Math.min(AUTO_GAIN_MAX, micCalTargetRms / measuredRms));
  micGainBase = newGain;
  micGainAuto = newGain;
  updateEffectiveGain();
  saveMicState();
  micCalLastResult = { ok: true, measuredRms, newGain, oldGain, targetRms: micCalTargetRms, samples: micCalCount, at: Date.now() };
  dlog(`[ALSA] Mic-gain calibration DONE: measuredRms=${measuredRms.toFixed(4)} → base gain ${oldGain.toFixed(2)}x → ${newGain.toFixed(2)}x (target ${micCalTargetRms.toFixed(2)})`);
}


/** Kurvan är alltid gain-källan — behålls för API-kompatibilitet. */
export function isAutoGainEnabled(): boolean { return true; }

export function getGainCalPoints(): { point1: GainCalPoint | null; point2: GainCalPoint | null } {
  return { point1: calPoint1, point2: calPoint2 };
}

/** A3: cal-gain måste vara positiv och finit — annars ger Math.log() NaN som
 *  förgiftar micGain → alla band-RMS → hela ljus-kedjan, utan återhämtning. */
function sanitizeCalPoint(p: GainCalPoint | null): GainCalPoint | null {
  if (!p) return null;
  if (!Number.isFinite(p.vol) || !Number.isFinite(p.gain)) return null;
  const gain = Math.max(AUTO_GAIN_MIN, Math.min(AUTO_GAIN_MAX, p.gain));
  if (!(gain > 0)) return null;
  return { vol: Math.max(0, Math.min(100, p.vol)), gain };
}

export function setGainCalPoints(p1: GainCalPoint | null, p2: GainCalPoint | null): void {
  calPoint1 = sanitizeCalPoint(p1);
  calPoint2 = sanitizeCalPoint(p2);
  p1 = calPoint1; p2 = calPoint2;
  saveMicState();
  if (p1 && p2) {
    dlog(`[ALSA] Gain cal: point1=(vol=${p1.vol}, gain=${p1.gain.toFixed(1)}), point2=(vol=${p2.vol}, gain=${p2.gain.toFixed(1)})`);
    // Räkna om direkt från senast kända volym så slider-ändringar syns omedelbart
    if (lastSonosVol != null) recomputeAutoGain(lastSonosVol);
    else { micGainAuto = interpolateGain(p1.vol); updateEffectiveGain(); }
  }
}

function interpolateGain(sonosVolume: number): number {
  if (!calPoint1 || !calPoint2) return micGainBase;
  const v1 = calPoint1.vol, g1 = calPoint1.gain;
  const v2 = calPoint2.vol, g2 = calPoint2.gain;
  // A3: log(0)/log(neg) → -Inf/NaN. Bättre ett trubbigt base-gain än NaN i kedjan.
  if (!(g1 > 0) || !(g2 > 0) || !Number.isFinite(sonosVolume)) return micGainBase;
  if (v1 === v2) return g1;
  const logG1 = Math.log(g1), logG2 = Math.log(g2);
  const t = (sonosVolume - v1) / (v2 - v1);
  const logG = logG1 + t * (logG2 - logG1);
  const out = Math.exp(logG);
  if (!Number.isFinite(out)) return micGainBase;
  return Math.max(AUTO_GAIN_MIN, Math.min(AUTO_GAIN_MAX, out));
}

// ── FIX 4b: lärd volym→gain, "lär → LÅS → sparat" (per volym) ──
// Anpassar sig mot SONOS-VOLYMEN, inte mot ljudnivån. Per volym ackumuleras ett
// STABILT AGGREGAT (löpande medel av 4s-p90 över alla låtar) — INTE en EMA som
// dras mot senaste låten. Efter lgLockAfterMs gate:ad musik låses ref:et och
// gainen står helt still. Omlärning sker explicit via relearnGain().
export type LgEntry = { ref: number; sum: number; count: number; learnMs: number; locked: boolean };

let lgEnabled = true;
let lgTarget = 0.6;
let lgWinSec = 4;
let lgLockAfterMs = 1_200_000;  // 20 min gate:ad musik → lås
const LG_SETTLE_MS = 3000;      // frys efter volymbyte
const LG_NOISE_FLOOR = 0.0015;  // under detta = tystnad

const lgTable = new Map<number, LgEntry>();   // volym → tillstånd (persisteras)

let lgRing: number[] = [];
let lgRingVol: number | null = null;
let lgVolChangedAt = -1e9;
let _lgLastVol: number | null = null;
let lgLearnAllowed = false;      // sätts av index: spelar && ej TV-läge
let lgSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Gate:ar inlärningen. TV-läge har icke-normaliserat ljud → skulle korrumpera tabellen. */
export function setGainLearnGate(playing: boolean, tvMode: boolean): void {
  lgLearnAllowed = playing && !tvMode;
}

export function setLearnedGainParams(p: { enabled?: boolean; target?: number; winSec?: number; lockAfterMs?: number }): void {
  if (typeof p.enabled === 'boolean') lgEnabled = p.enabled;
  if (Number.isFinite(p.target) && (p.target as number) > 0) lgTarget = p.target as number;
  if (Number.isFinite(p.winSec) && (p.winSec as number) > 0) lgWinSec = p.winSec as number;
  if (Number.isFinite(p.lockAfterMs) && (p.lockAfterMs as number) > 0) lgLockAfterMs = p.lockAfterMs as number;
}

function scheduleLgSave(): void {
  if (lgSaveTimer) return;
  lgSaveTimer = setTimeout(() => { lgSaveTimer = null; saveMicState(); }, 30000);
  (lgSaveTimer as any)?.unref?.();
}

function gainFromRef(ref: number): number {
  return Math.max(AUTO_GAIN_MIN, Math.min(AUTO_GAIN_MAX, lgTarget / ref));
}

function learnGainSample(blockRms: number, blockSec: number): void {
  if (!lgEnabled) return;
  const v = lastSonosVol;
  if (v == null || !(v > 0) || !lgLearnAllowed) return;
  if (v !== _lgLastVol) { _lgLastVol = v; lgVolChangedAt = performance.now(); }
  if (!(blockRms > LG_NOISE_FLOOR)) return;
  if (performance.now() - lgVolChangedAt < LG_SETTLE_MS) { lgRing.length = 0; return; }
  let e = lgTable.get(v);
  if (e && e.locked) return;                    // LÅST → rör inte
  if (lgRingVol !== v) { lgRing.length = 0; lgRingVol = v; }
  const winN = Math.max(8, Math.round(lgWinSec / Math.max(1e-4, blockSec)));
  lgRing.push(blockRms);
  if (lgRing.length > winN) lgRing.shift();
  if (lgRing.length < winN) return;
  const s = [...lgRing].sort((a, b) => a - b);
  const measured = s[Math.floor(s.length * 0.9)];
  if (!(measured > 0) || !Number.isFinite(measured)) return;
  if (!e) e = { ref: measured, sum: 0, count: 0, learnMs: 0, locked: false };
  // AGGREGAT: löpande medel av p90 över alla låtar (ej EMA mot senaste låten)
  e.sum += measured;
  e.count += 1;
  e.ref = e.sum / e.count;
  e.learnMs += blockSec * 1000;
  if (e.learnMs >= lgLockAfterMs) {
    e.locked = true;
    dlog(`[ALSA] Lärd gain LÅST vid vol=${v}: ref=${e.ref.toFixed(5)} gain=${gainFromRef(e.ref).toFixed(2)}x`);
  }
  lgTable.set(v, e);
  scheduleLgSave();
}

/** Gain för en volym: lärt värde → interpolerade lärda grannar → tvåpunkts-prior. */
function learnedGainFor(v: number): number | null {
  const e = lgTable.get(v);
  if (e && e.ref > 1e-6) return gainFromRef(e.ref);
  const ks = [...lgTable.keys()].sort((a, b) => a - b);
  const lo = ks.filter(k => k <= v).pop();
  const hi = ks.find(k => k >= v);
  if (lo != null && hi != null && lo !== hi) {
    const rl = lgTable.get(lo)!.ref, rh = lgTable.get(hi)!.ref, t = (v - lo) / (hi - lo);
    const r = Math.exp(Math.log(rl) + t * (Math.log(rh) - Math.log(rl)));
    if (!(r > 1e-6)) return null;
    return gainFromRef(r);
  }
  return null;   // olärt → cold start (tvåpunkts-prior)
}

/** Lås upp en volym (eller alla) → lär om från prior. För rums-/uppställningsändring. */
export function relearnGain(vol?: number): void {
  if (vol == null) lgTable.clear();
  else lgTable.delete(vol);
  lgRing.length = 0;
  lgRingVol = null;
  saveMicState();
  refreshAutoGain();
}

export function getLearnedGainState(): {
  enabled: boolean;
  target: number;
  lockAfterMs: number;
  entries: Array<{ vol: number; ref: number; gain: number; learnMs: number; locked: boolean }>;
} {
  return {
    enabled: lgEnabled,
    target: lgTarget,
    lockAfterMs: lgLockAfterMs,
    entries: [...lgTable.entries()].sort((a, b) => a[0] - b[0]).map(([vol, e]) => ({
      vol, ref: e.ref, gain: gainFromRef(e.ref), learnMs: Math.round(e.learnMs), locked: e.locked,
    })),
  };
}


function recomputeAutoGain(sonosVolume: number): void {
  // Volym 0 = mutad/ingen uppspelning, INTE "svag signal som behöver mer gain".
  // Tidigare AUTO_GAIN_MAX (300×) här → rumsbrus pinnade ljuset på 100 % i tyst rum.
  // Ren fallthrough duger inte: kurvan extrapolerar (vol 0 → ~28×). Att behålla
  // föregående gain är rätt i båda fallen: äkta mute → tystnadsgolvet tar ljuset
  // till idle ändå; falsk 0:a från pollning → ändringen blir osynlig. `!(v > 0)`
  // fångar även NaN.
  if (!(sonosVolume > 0)) return;
  if (lgEnabled) {
    const g = learnedGainFor(sonosVolume);
    if (g != null) { micGainAuto = g; updateEffectiveGain(); return; }
  }
  micGainAuto = interpolateGain(sonosVolume);
  updateEffectiveGain();
}

/** Kör periodiskt (1 Hz) så micGainAuto följer det långsamt förfinade ref:et. */
export function refreshAutoGain(): void {
  if (lastSonosVol != null) recomputeAutoGain(lastSonosVol);
}

export function setAutoGainFromVolume(sonosVolume: number): void {
  lastSonosVol = sonosVolume;
  recomputeAutoGain(sonosVolume);
  dlog(`[ALSA] Gain-kurva: vol=${sonosVolume} → gain=${micGainAuto.toFixed(2)}x`);
}


// Restore persisted state vid modulinit. Körs efter att alla let:s deklarerats.
// Krasch/restart mitt i låt → samma gain/cal som innan.
(function restoreMicState() {
  const s = loadMicState();
  if (!s) { dlog('[ALSA] No persisted mic-state found, using defaults'); return; }
  // A3: typeof NaN === 'number' → NaN slank igenom förr. Kräv finita värden.
  if (Number.isFinite(s.micGainBase)) micGainBase = Math.max(0.1, Math.min(AUTO_GAIN_MAX, s.micGainBase as number));
  const p1 = sanitizeCalPoint(s.calPoint1 ?? null);
  const p2 = sanitizeCalPoint(s.calPoint2 ?? null);
  if (p1) calPoint1 = p1;
  if (p2) calPoint2 = p2;
  if (s.learnedGain) {
    for (const [k, e] of Object.entries(s.learnedGain)) {
      const vol = Number(k);
      if (!Number.isFinite(vol) || vol <= 0 || !e || !Number.isFinite(e.ref) || !(e.ref > 0)) continue;
      lgTable.set(vol, {
        ref: e.ref,
        sum: Number.isFinite(e.sum) ? e.sum : e.ref,
        count: Number.isFinite(e.count) && e.count > 0 ? e.count : 1,
        learnMs: Number.isFinite(e.learnMs) ? e.learnMs : 0,
        locked: e.locked === true,
      });
    }
  } else if (s.learnedGainRefs) {
    // Migrera gammalt format (volym→number): gamla värdet blir seed, aggregatet
    // byggs om rent och mognar till lås.
    for (const [k, v] of Object.entries(s.learnedGainRefs)) {
      const vol = Number(k);
      if (Number.isFinite(vol) && vol > 0 && Number.isFinite(v) && (v as number) > 0) {
        lgTable.set(vol, { ref: v as number, sum: v as number, count: 1, learnMs: 0, locked: false });
      }
    }
  }
  if (lgTable.size > 0) {
    const locked = [...lgTable.values()].filter(e => e.locked).length;
    dlog(`[ALSA] Restored ${lgTable.size} lärda gain-punkter (${locked} låsta)`);
  }

  micGainAuto = calPoint1 && calPoint2 ? interpolateGain(calPoint1.vol) : micGainBase;

  updateEffectiveGain();
  dlog(`[ALSA] Restored mic-state: gain=${micGainAuto.toFixed(1)}x cal=${calPoint1 && calPoint2 ? 'yes' : 'no'}`);
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

  _captureOpenedAt = performance.now();   // C2: baseline för first-audio-stall
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
    dlog(`[ALSA] Mic started via native ALSA (${SAMPLE_RATE}Hz, ${currentFormat}, left-channel select, period=256, band-hop=${BAND_EVERY_HOPS}×${ANALYSER_HOP}, device: ${currentDevice})`);
    

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
// Mäter den LJUS-DRIVANDE signalen: bandenergin som motorn normaliserar (max av
// bass/midHi), inte hela ljudet. Då gäller modellen "max använd input → gain →
// 100 %" exakt, och baren visar när topparna slår i taket (energyNorm > 1 → 1).
let healthBandPeakWin = 0;
let healthClipFrames = 0;
let healthFrames = 0;
let healthWinAt = 0;
let healthBandPeak = 0;
let healthClipPct = 0;

export interface MicHealth {
  /** Peak bandenergi 0..1+ i senaste fönstret (1.0 = 100 % ljus). */
  peak: number;
  /** Andel band-frames (0..1) som slog i 100 %-taket. */
  clipPct: number;
  /** 'low' = för lite gain (peak < 0.15), 'hot' = i taket, annars 'ok'. */
  status: 'low' | 'ok' | 'hot';
}

export function getMicHealth(): MicHealth {
  const now = performance.now();
  if (now - healthWinAt >= 1000 && healthFrames > 0) {
    healthBandPeak = healthBandPeakWin;
    healthClipPct = healthClipFrames / healthFrames;
    healthBandPeakWin = 0; healthClipFrames = 0; healthFrames = 0;
    healthWinAt = now;
  }
  const status: MicHealth['status'] =
    healthClipPct > 0.01 || healthBandPeak >= 1 ? 'hot' : healthBandPeak < 0.15 ? 'low' : 'ok';
  return { peak: healthBandPeak, clipPct: healthClipPct, status };
}


function onAudioData(buf: Buffer): void {
  const _cbT0 = performance.now();
  _lastAudioCbAt = _cbT0;
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
  // RINGEN ÄR O-GAINAD (2026-08-24): användarens gain appliceras inte här längre.
  // Analys-tappen skalas ENBART av analysatorns AGC; ljus-tappen med micGain på
  // den linjära RMS:en nedan. En delad gain på rå-PCM:en fick analysatorn att
  // klippa (level pinnad 100 %) och blandade ihop de två vägarna.
  
  const hsAlpha = HS_ALPHA;
  let hs = hsState;

  let pos = ringPos;
  const ring = ringBuf;
  const mask = RING_MASK;
  // Debug-peak (pre-gain) — nivå-hälsan mäts på bandenergin i emitBands().
  let prePeak = 0;
  // Kalibrering: samma rawPre²-summa som ljus-tappen → commit från den.
  const calOn = micCalActive;
  // LJUS-TAPP: block-RMS på rå signal (gain appliceras efteråt → linjärt).
  let lightSumLocal = 0;
  let frameCount = 0;


  if (currentFormat === 'S32_LE') {
    const samples = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
    frameCount = samples.length >> 1;
    const INV_S32 = 1 / 2147483648;
    for (let i = 0; i < frameCount; i++) {
      const rawPre = samples[i << 1] * INV_S32;
      lightSumLocal += rawPre * rawPre;
      if (acrCaptureActive && acrLen < ACR_MAX_SAMPLES && ++acrDecimCount >= ACR_DECIM) {
        acrDecimCount = 0;
        let s = rawPre * 32767;
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        acrBuf[acrLen++] = s;
      }

      const absPre = rawPre < 0 ? -rawPre : rawPre;
      if (absPre > prePeak) prePeak = absPre;
      const d = rawPre - hs;
      hs += hsAlpha * d;
      ring[pos] = hs + d * HS_D_COEFF;
      pos = (pos + 1) & mask;
    }
  } else {
    const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    frameCount = samples.length >> 1;
    const INV_S16 = 1 / 32768;
    for (let i = 0; i < frameCount; i++) {
      const rawPre = samples[i << 1] * INV_S16;
      lightSumLocal += rawPre * rawPre;
      if (acrCaptureActive && acrLen < ACR_MAX_SAMPLES && ++acrDecimCount >= ACR_DECIM) {
        acrDecimCount = 0;
        let s = rawPre * 32767;
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        acrBuf[acrLen++] = s;
      }

      const absPre = rawPre < 0 ? -rawPre : rawPre;
      if (absPre > prePeak) prePeak = absPre;
      const d = rawPre - hs;
      hs += hsAlpha * d;
      ring[pos] = hs + d * HS_D_COEFF;
      pos = (pos + 1) & mask;
    }
  }

  hsState = hs;
  ringPos = pos;
  const peak = prePeak * micGainAuto;
  if (peak > debugPeakRaw) debugPeakRaw = peak;

  // LJUS-NIVÅ: ~130 ms EMA av block-RMS (samma tidskonstant som analysatorns
  // levelVU hade) — men helt utan AGC. Gain appliceras i emitBands.
  if (frameCount > 0) {
    const blockRms = Math.sqrt(lightSumLocal / frameCount);
    const dt = frameCount / SAMPLE_RATE;
    const a = 1 - Math.exp(-dt / 0.13);
    lightRawRms = lightRawRms === 0 ? blockRms : lightRawRms + (blockRms - lightRawRms) * a;
    learnGainSample(blockRms, dt);   // FIX 4: lärd volym→gain (gate:ad, långsam)
    if (_micPlaybackGate && lightRawRms >= STABLE_RMS_MIN) {
      const tol = Math.max(STABLE_RMS_DELTA, lightRawRms * STABLE_RMS_REL);
      if (_stableRmsSince === 0 || Math.abs(lightRawRms - _stableRmsValue) > tol) {

        _stableRmsSince = performance.now();
        _stableRmsValue = lightRawRms;
      }
    } else {
      _stableRmsSince = 0;
      _stableRmsValue = lightRawRms;
    }
  }


  // Innehålls-frys-detektor: en wedged I2S-DMA matar IDENTISKA bytes varje callback.
  // lightSumLocal är en deterministisk summa av blocket → byte-identiskt block ⇒
  // bit-identisk summa. Äkta tystnad har alltid LSB-brus → summan skiljer varje
  // gång. K identiska summor i rad ⟹ enheten matar frusen buffert. frameCount
  // matchas också, så jitter (1–3 hops/callback) aldrig triggar falskt.
  if (frameCount > 0) {
    if (lightSumLocal === _lastLightSum && frameCount === _lastFrameCount) {
      if (_contentFreezeStreak === 0) _contentFreezeAt = performance.now();
      _contentFreezeStreak++;
    } else {
      _contentFreezeStreak = 0;
      _lastLightSum = lightSumLocal;
      _lastFrameCount = frameCount;
    }
  }



  if (calOn && micCalActive) {
    micCalSumSq += lightSumLocal;
    micCalCount += frameCount;
    if (performance.now() - micCalStartAt >= micCalDurationMs) finishMicCalibration();
  }



  // Portable analyser: egen 128-hop-tap (375 Hz), decoupled från 480-hop-FFT:n.
  // Dränera alla kompletta 128-block som ackumulerats. periodSize=256 → oftast
  // 2 hops per callback; jitter kan ge 1 eller 3. Läser bakåt från ringPos.
  analyserSamplesReceived += frameCount;
  while (analyserSamplesReceived >= ANALYSER_HOP) {
    const off = analyserSamplesReceived;
    const start = (ringPos - off) & mask;
    // Bulk-copy när blocket är kontiguet i ringen (~87.5 % av hoppen).
    if (start + ANALYSER_HOP <= RING_SIZE) {
      analyserScratch.set(ringBuf.subarray(start, start + ANALYSER_HOP));
    } else {
      for (let i = 0; i < ANALYSER_HOP; i++) analyserScratch[i] = ringBuf[(start + i) & mask];
    }
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


  // Hela audio-callbacken (downmix + analysator-hops + engine-tick) är det enda
  // som kör på event-loopen i mic-vägen. Tar den >200ms är det den som fryser
  // ticken — noteNativeCall loggar med kontext och exponerar maxNativeCallMs.
  noteNativeCall('alsa-audio-cb', performance.now() - _cbT0, `bytes=${buf.byteLength} hops=${analyserHopCount}`);
}

// ── Mic-stall-watchdog (2026-08-25) ──
// ALSA-capturen kan sluta leverera audio-callbacks utan att fyra 'error' eller
// 'close' (controller/DMA-stall). Då kommer inga FFT-frames → motorns tick
// fryser → playback-watchdogen hard-restartade hela processen. Nu re-initieras
// bara capturen. Anropas från 1 Hz-schedulern i index.ts.
let _lastAudioCbAt = 0;
let _micRestartCount = 0;
const MIC_STALL_MS = 1500;

export function getLastAudioCbAt(): number { return _lastAudioCbAt; }
export function getMicRestartCount(): number { return _micRestartCount; }

// C1/C2: reopen skjuts upp så gamla capture-tråden hinner släppa hw:0,0
// (annars -EBUSY-race), och "startad men aldrig levererat" räknas som stall så
// watchdogen fortsätter retria en mic som aldrig ger sin första callback.
const REOPEN_DELAY_MS = 120;
const FIRST_AUDIO_GRACE_MS = 3000;
let _reopenPending = false;
let _captureOpenedAt = 0;

/** True om capturen är aktiv men inte levererat audio på MIC_STALL_MS. */
export function isMicStalled(): boolean {
  if (_reopenPending) return false;            // reopen är på väg — vänta ut den
  if (!capture) return false;
  if (_lastAudioCbAt === 0) {
    // C2: aldrig levererat sedan open → stall efter grace-perioden.
    return _captureOpenedAt > 0 && performance.now() - _captureOpenedAt >= FIRST_AUDIO_GRACE_MS;
  }
  return performance.now() - _lastAudioCbAt >= MIC_STALL_MS;
}

/** Stäng och starta om ALSA-capturen utan process-restart. */
export function restartCapture(reason: string): boolean {
  if (_reopenPending) return true;             // redan på väg
  if (!capture) return false;                  // C3: icke-omstartbart (ej wedged)
  const ageMs = _lastAudioCbAt === 0 ? -1 : Math.round(performance.now() - _lastAudioCbAt);
  console.warn(`[ALSA] restartCapture (${reason}): senaste audio-cb ${ageMs}ms sedan — re-initierar capturen`);
  try { stopMic(); } catch (e: any) { console.warn(`[ALSA] stopMic under restart: ${e?.message ?? e}`); }
  _lastAudioCbAt = 0;
  _reopenPending = true;
  setTimeout(() => {
    _reopenPending = false;
    try {
      startMic();
    } catch (e: any) {
      console.error(`[ALSA] startMic under restart misslyckades: ${e?.message ?? e}`);
      return;
    }
    // Bekräfta att capturen faktiskt levererar — annars markerar isMicStalled()
    // den som stall igen efter grace-perioden och watchdogen retriar.
    void waitForFirstAudio(FIRST_AUDIO_GRACE_MS).catch(() => {
      console.warn('[ALSA] restartCapture: ingen audio inom grace — watchdogen retriar');
    });
  }, REOPEN_DELAY_MS);
  _micRestartCount++;
  return true;
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
  lightRawRms = 0;
  _lastLightSum = -1;
  _lastFrameCount = -1;
  _contentFreezeStreak = 0;
  _contentFreezeAt = 0;
  _stableRmsSince = 0;
  _stableRmsValue = 0;
  latestBands.flux = 0;
  latestBands.bassFlux = 0;
  latestBands.shape = 0;
  _audioCbCount = 0;
  _audioCbBytes = 0;
  _audioCbFirstAt = 0;
  
  lastFFTTimestamp = 0;
  _fftFrameCount = 0;
  micStartError = null;
  _captureOpenedAt = 0;
  dlog('[ALSA] Microphone stopped');
}
