/**
 * PiLightEngine — headless audio→light pipeline for Raspberry Pi.
 * 
 * EVENT-DRIVEN ARCHITECTURE:
 * Instead of a timer polling latestBands, the ALSA mic fires onFFTReady
 * which triggers the engine immediately (if tickMs has elapsed).
 * This eliminates up to tickMs of latency from the mic→BLE path.
 * 
 * Pipeline: Mic PCM → FFT → [event] → Engine tick → BLE write
 * Latency: ~5.8ms (audio buffer) + <1ms (processing) + ~25ms (BLE) ≈ 31ms
 * 
 * Takt: band-events (och därmed motorn) körs i 75 Hz — FRAME_MS = 13.33 ms
 * (BAND_EVERY_HOPS=5 × ANALYSER_HOP=128 @ 48 kHz = 640 sampel).
 * tickMs pacar BARA BLE-slot-leasen, inte tick-takten (tick-gaten är borta).

 */

import { getLatestBands, getLatestFrame, getLatestFrameAt, resetFluxState, onFFTReady, onFluxReady, stopMic, setBeatCutoffHz, setAnalyserBeatGrid, hintAnalyserTrackChange, FRAME_MS } from './alsaMic.js';
import type { Frame } from './audio-analyser/index.js';
import { hasBeat, beatIndex, beatPhase, nextBeatIn, MIN_BEAT_CONFIDENCE, type Beat } from './audio-analyser/beatClock.js';
import { sendToBLE, clearQueuedWrite, flushQueuedWriteNow, hasQueuedWrite, setIdleColor, setSlotLeaseMs, startKeepAlive, stopKeepAlive } from './ble-driver/protocol.js';
import type { WriteResult } from './ble-driver/protocol.js';
import { bleStats as bleStatsState } from './ble-driver/state.js';
import { triggerIdleDisconnect } from './ble-driver/connect.js';
import { isControllerDrainAttached, getOutstandingPackets } from './ble-driver/controllerDrain.js';
import { getItem, setItem } from './storage.js';
import { dlog } from "./debugLog.js";
import { noteTick } from './runtimeHealth.js';


// ── Inline engine math (avoid complex path aliasing to browser engine) ──

// AGC borttaget 2026-04-20: Sonos-volym → mic-gain-kalibrering (auto-gain)
// hanterar nu nivåskalningen. Ingen behov av en till normaliseringsloop.
// Bands från ALSA är redan rätt-skalade när de når engine.

// EN ÄRLIG GAIN (2026-08-23): den dolda RAW_SCALE=5 är borta. Den mättade
// signalen redan vid RMS 0.2 → drop/breakdown-detektorn såg ingen äkta tystnad.
// Ljusstyrka är nu en LINJÄR funktion av den gain:ade rå-inputen; enda
// känslighets-kontrollen är tvåpunkts-gain-kurvan mot Sonos-volym (~5× högre tal).
// OBS: tickEnergyFloor/onsetEnergyFloor jämförs mot RÅ bands-RMS → orörda.
export function normalizeFixed(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}



// --- Precomputed tick constants ---
export interface TickConstants {
  refractoryFrames: number;
  onsetRiseAlphaFft: number;
  onsetDecayFft: number;
  gammaIsUnity: boolean;
  brightnessFloor: number;
  transientGain: number;
  lutR: Uint8Array;
  lutG: Uint8Array;
  lutB: Uint8Array;
}

export function computeTickConstants(tickMs: number, cal: LightCalibration): TickConstants {
  // fftMs = FRAME_MS: onset-alforna körs nu på sann 75 Hz-takt (var felaktigt hårdkodad 10 = 100 Hz-antagande).
  const fftMs = FRAME_MS;


  const fftRatio = fftMs / 125;
  const fftSecRatio = fftMs / 1000;


  const gammaIsUnity = cal.gammaR === 1.0 && cal.gammaG === 1.0 && cal.gammaB === 1.0;

  const lutR = new Uint8Array(256);
  const lutG = new Uint8Array(256);
  const lutB = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    if (gammaIsUnity) {
      lutR[i] = Math.max(0, Math.min(255, (i + cal.offsetR + 0.5) | 0));
      lutG[i] = Math.max(0, Math.min(255, (i + cal.offsetG + 0.5) | 0));
      lutB[i] = Math.max(0, Math.min(255, (i + cal.offsetB + 0.5) | 0));
    } else {
      const n = i / 255;
      lutR[i] = Math.max(0, Math.min(255, (Math.pow(n, cal.gammaR) * 255 + cal.offsetR + 0.5) | 0));
      lutG[i] = Math.max(0, Math.min(255, (Math.pow(n, cal.gammaG) * 255 + cal.offsetG + 0.5) | 0));
      lutB[i] = Math.max(0, Math.min(255, (Math.pow(n, cal.gammaB) * 255 + cal.offsetB + 0.5) | 0));
    }
  }

  return {
    refractoryFrames: Math.max(1, Math.round(cal.onsetRefractoryMs / FRAME_MS)),
    onsetRiseAlphaFft: 1 - Math.pow(0.05, fftRatio),
    onsetDecayFft: Math.pow(0.04, fftSecRatio),
    gammaIsUnity,
    brightnessFloor: cal.brightnessFloor,
    transientGain: cal.transientGain,

    lutR,
    lutG,
    lutB,
  };
}


// --- Calibration ---

export interface LightCalibration {
  gammaR: number; gammaG: number; gammaB: number;
  offsetR: number; offsetG: number; offsetB: number;
  /** HEARTBEAT: snabb attack (snäpper på rise). 1.0 = full snap. */
  attackAlpha: number;
  /** HEARTBEAT: mjuk release (softness-slidern). */
  releaseAlpha: number;
  /** BEAT-detektion: bas-vikt i onset-källan (ej ljusstyrka). */
  bassWeight: number;
  punchWhiteThreshold: number;
  /** Golv i procent — ljuset går aldrig under detta under play. Default 25. */
  brightnessFloor: number;
  /** 0 = av (ingen boost), 0.4 = default, upp till ~2.0 = överdrivna transienter */
  transientGain: number;
  /** Onset-tröskel: flux > median * onsetThreshold + 0.008 (1.3 = känslig, 2.5 = strikt). UI-default 1.8. */
  onsetThreshold: number;
  /** Minsta gap mellan onsets i ms — räknas om till frames via FRAME_MS (sann 75 Hz). UI-default 110ms. */
  onsetRefractoryMs: number;
   /** Anti-fladder: deadband i normaliserad enhet (0–0.08). Output ändras inte om |Δ| under detta. Skalas perceptuellt med nivå. */
   flickerDeadband: number;
   /** Attack-mjukhet vid låg energi (0–1). Lågt brus snäpper inte → inget flimmer; full snap vid hög energi. Default 0.25. */
   lowSoftFloor: number;
  /** Absolut energy-gate (totalRms) under vilken onset-detektorn inte processar.
   *  Förhindrar att den adaptiva tröskeln skalar ner till brus och flashar i tysta partier.
   *  0 = av, 0.05 = default, 0.20 = bara stark musik räknas. */
  onsetEnergyFloor: number;
  /** Tystnads-gate i tickInner: under detta är input rumsbrus, inte musik.
   *  0 = av, 0.01 = default. */
  tickEnergyFloor: number;
  /** Beat-källa för onset: 'bass' = endast kick/bas (<150Hz), 'full' = hela spektrumet. Legacy — ersatt av beatCutoffHz. */
  beatSource: 'bass' | 'full';
  /** Lågpass-brytfrekvens (Hz) för beat-detektionen: onset lyssnar på flux UNDER denna frekvens. Default 150 Hz. */
  beatCutoffHz: number;
  /** Drop-detektor på/av. Default true. */
  dropEnabled: boolean;
  /** Drop-känslighet 0.5–3.0 (lägre = lättare att trigga). Default 1.0. */
  dropSensitivity: number;
  /** Varaktighet (ms) för drop-blixten. Default 320. */
  dropFlashMs: number;
  /** Grid-driven puls: när takten är låst fyras pulsen av taktklockan i stället
   *  för av onseten. Default true. */
  beatGridPulse: boolean;
  /** Försprång (ms) på grid-pulsen — kompenserar BLE-skrivlatens (~40–60 ms). */
  beatLeadMs: number;
  /** PLL: andel av fasfelet som korrigeras per kick (0 = av). */
  beatSyncStrength: number;
  /** Drop-källa: 'analyser' = analysatorns novelty/kropp-baserade dropCount (faller
   *  tillbaka på bas-svackan när takten inte är låst), 'bass' = bara egen svacka. */
  dropSource: 'analyser' | 'bass';
  /** Extra pulsstyrka på ettan när taktfasen (barShift) är känd. 1.0 = av. */
  barAccent: number;
  /** Topp-boost: extra lyft när analysatorns intensity > 90 %. 0 = av. Default 0.2. */
  peakBoost: number;
  /** DYNAMIK: nedre input-tröskel som fraktion av gainens primärpunkt. level under
   *  inLowFrac × point1.gain → golv. Används BARA i fast-läge (adaptiveCeiling=false). */
  inLowFrac: number;
  /** DYNAMIK: övre input-tröskel som fraktion av gainens primärpunkt. level över
   *  inHighFrac × point1.gain → full. Används BARA i fast-läge. */
  inHighFrac: number;
  /** DYNAMIK: exponent på den expanderade formen. 1.0 = linjär, >1 = mer kontrast. */
  shapeExpand: number;
  /** ADAPTIVT TAK: låt inLow/inHigh följa en långsam medelnivå av level → varje låt
   *  normaliseras till sin egen energi. Default true. */
  adaptiveCeiling: boolean;
  /** Tidskonstant (ms) för det adaptiva takets EMA. Default 7000. */
  ceilFollowMs: number;
  /** Golv på medelnivån → en tyst låt drar inte upp taket på brus. Default 0.12. */
  ceilFloor: number;
  /** Multiplikator medelnivå → inLow. Default 0.55. */
  ceilLowMul: number;
  /** Multiplikator medelnivå → inHigh. Default 1.35. */
  ceilHighMul: number;
  /** PRE-DROP: hur mycket analysatorns buildUp-tension lyfter ljuset in i droppen. */
  buildUpGain: number;

  /** FÄRG-TILT: hur mycket spektralbalansen får värma/kyla palett-färgen.
   *  0 = ren palett, 0.25 = default mild. Påverkar ALDRIG brightness. */
  colorSpectralTilt: number;
  [key: string]: any;
}

const DEFAULT_CAL: LightCalibration = {
  gammaR: 1.0, gammaG: 1.0, gammaB: 1.0,
  offsetR: 0, offsetG: 0, offsetB: 0,
  attackAlpha: 1.0, releaseAlpha: 0.4,
  bassWeight: 0.95,
  punchWhiteThreshold: 100,
  brightnessFloor: 25,
  transientGain: 0.2,
  onsetThreshold: 1.8,
  onsetRefractoryMs: 200,
  flickerDeadband: 0.02,
  lowSoftFloor: 0.3,
  onsetEnergyFloor: 0.01,
  tickEnergyFloor: 0.01,
  beatSource: 'bass',
  beatCutoffHz: 150,
  dropEnabled: false,
  dropSensitivity: 1.0,
  dropFlashMs: 320,
  beatGridPulse: true,
  beatLeadMs: 45,
  beatSyncStrength: 0.10,
  dropSource: 'analyser',
  barAccent: 1.0,
  peakBoost: 0.2,
  inLowFrac: 0.022,
  inHighFrac: 0.075,
  shapeExpand: 2.0,
  adaptiveCeiling: true,
  ceilFollowMs: 7000,
  ceilFloor: 0.12,
  ceilLowMul: 0.55,
  ceilHighMul: 1.35,
  buildUpGain: 0.25,
  colorSpectralTilt: 0.25,
};



/** Rensa bort borttagna legacy-fält ur sparade inställningar (2026-08-25:
 *  Dirigenten omskriven — dynamicCenter/dynamics/perceptual-kurvan/profiler
 *  finns inte längre). */
const DROPPED_CAL_KEYS = [
  'transientBoost', 'perceptualCurve', 'perceptualGamma',
  'dynamicDamping', 'dynamicsEnabled', 'intensityInfluence',
  'lightScale', 'lightBassWeight', 'centerAdaptSeconds',
  'maxRisePerSec', 'maxFallPerSec', 'saturation',
];

function migrateLegacyCalibration(cal: any): any {
  if (!cal || typeof cal !== 'object') return cal;
  const out = { ...cal };
  // transientBoost: true → 1.0, false → 0
  if (typeof out.transientBoost === 'boolean' && out.transientGain == null) {
    out.transientGain = out.transientBoost ? 1.0 : 0;
  }
  // beatSource: 'full' → hög cutoff (hela spektrumet), 'bass' → 150 Hz. Bara om beatCutoffHz saknas.
  if (out.beatCutoffHz == null && typeof out.beatSource === 'string') {
    out.beatCutoffHz = out.beatSource === 'full' ? 15000 : 150;
  }
  for (const k of DROPPED_CAL_KEYS) delete out[k];
  return out;
}


function loadCalibration(): LightCalibration {
  try {
    const raw = getItem('light-calibration');
    if (raw) {
      const parsed = migrateLegacyCalibration(JSON.parse(raw));
      // C1: null/undefined i en sparad profil får INTE skugga DEFAULT_CAL —
      // annars föll het-pathen tillbaka på divergerande inline-literaler.
      const clean = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null));
      return { ...DEFAULT_CAL, ...clean } as LightCalibration;
    }
  } catch {}
  return { ...DEFAULT_CAL };
}


function saveCalibration(cal: LightCalibration): void {
  setItem('light-calibration', JSON.stringify(cal));
}

// Cached idle color — only re-parsed when changed via API
let _cachedIdleColor: [number, number, number] = [255, 60, 0];
let _idleColorLoaded = false;

function loadIdleColor(): [number, number, number] {
  if (_idleColorLoaded) return _cachedIdleColor;
  try {
    const raw = getItem('idle-color');
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length === 3) { _cachedIdleColor = p as [number, number, number]; } }
  } catch {}
  _idleColorLoaded = true;
  return _cachedIdleColor;
}

/** Invalidate cached idle color (call after API update) */
export function invalidateIdleColorCache(): void {
  _idleColorLoaded = false;
}

/** Fast color calibration — offset/gamma only.
 *  Saturation/vit-rensning borttagen 2026-04-25: användaren trimmar färgen
 *  i Sonos i stället, så palette-färgen ska komma orörd genom engine.
 *  cal.saturation läses inte längre — fältet bevaras i typen för
 *  bakåtkompatibilitet med sparade profiler. */
function applyColorCalibrationFast(r: number, g: number, b: number, tc: TickConstants): void {
  // Clamp input values quickly and use LUT
  let ri = (r + 0.5) | 0;
  ri = ri < 0 ? 0 : ri > 255 ? 255 : ri;
  let gi = (g + 0.5) | 0;
  gi = gi < 0 ? 0 : gi > 255 ? 255 : gi;
  let bi = (b + 0.5) | 0;
  bi = bi < 0 ? 0 : bi > 255 ? 255 : bi;

  _finalColor[0] = tc.lutR[ri];
  _finalColor[1] = tc.lutG[gi];
  _finalColor[2] = tc.lutB[bi];
}

// Reusable static arrays — zero-alloc
const _finalColor: [number, number, number] = [0, 0, 0];
const _blendColor: [number, number, number] = [0, 0, 0];

// ── Diagnostics snapshot — mutated in-place every tick, zero-alloc ──
export interface DiagSnapshot {
  rawRms: number;
  bassRms: number;
  midHiRms: number;
  bassNorm: number;
  midHiNorm: number;
  /** ABSOLUT amplitud från INPUT (rå RMS × tvåpunktsGain) */
  level: number;
  /** Långsam envelope av level — rå loudness-källa */
  ampEnv: number;
  /** SEKTIONSENERGI från analysatorn, efter heartbeat-smoothing (0..1) */
  shape: number;
  /** Loudness-viktat max för energyForm (floorN..1) */
  ceiling: number;
  /** Loudness-skala från rå amplitud-envelope (0..1) */
  loudness: number;
  /** Slutlig form från intensity + onset-punch (0..1) */
  energyForm: number;
  energyNorm: number;
  onsetBoost: number;
  brightnessPct: number;
  bleScaleRaw: number;
  finalR: number; finalG: number; finalB: number;
  tickCount: number;
  lastTickUs: number;
  inSilence: boolean;
  tickSilenceCount: number;
}

const _diag: DiagSnapshot = {
  rawRms: 0, bassRms: 0, midHiRms: 0,
  bassNorm: 0, midHiNorm: 0,
  level: 0, ampEnv: 0, shape: 0, ceiling: 0, loudness: 0, energyForm: 0,
  energyNorm: 0, onsetBoost: 0,
  brightnessPct: 0, bleScaleRaw: 0,
  finalR: 0, finalG: 0, finalB: 0,
  tickCount: 0, lastTickUs: 0,
  inSilence: false, tickSilenceCount: 0,
};


// Reusable TickData — mutated in place
const _tickData: TickData = {
  brightness: 0,
  color: [0, 0, 0],
  bassLevel: 0,
  midHiLevel: 0,
  isPlaying: false,
  tickMs: 0,
};

// ── Engine ──

export interface TickData {
  brightness: number;
  color: [number, number, number];
  bassLevel: number;
  midHiLevel: number;
  isPlaying: boolean;
  tickMs: number;
}

export type TickCallback = (data: TickData) => void;

export class PiLightEngine {
  private color: [number, number, number] = [255, 80, 0];
  // Fade-mål: setColor/setPalette sätter detta; tick-loopen tweenar `color` hit
  // över `colorFadeMs` så att lampan inte hoppar när paletten uppdateras sent.
  private colorTarget: [number, number, number] = [255, 80, 0];
  private colorFadeMs = 3000;
  private volume: number | undefined;
  private playing = false;
  private tickMs: number;

  // LOUDNESS: långsam envelope av den ABSOLUTA amplituden (level). Attack ~300ms,
  // release ~2.5s. Den bär inte musikdynamiken; den skalar bara tyst/låg volym.
  private ampEnv = 0;
  private smoothed = 0;  // heartbeat-EMA (snabb attack / mjuk release) @ tick-takt

  // Anti-flicker: senast skickad brightness (post-slew, pre-gamma, 0..1)
  private lastBrightness = 0;
  // Anti-flicker: senast UI-/BLE-rapporterad pct (för deadband-jämförelse)
  private lastSentPct = -1;

  // ── Auto-tune sampler ──
  // När aktiv: sparar varje tick (postSlew, preDeadband) som rå pct (0..100)
  // tillsammans med tickMs. Används av analyzeAutoTuneSamples() för att
  // föreslå maxFallPerSec och flickerDeadband. Ringbuffer med fast tak.
  private autoTuneActive = false;
  private autoTuneStartedAt = 0;
  private autoTuneDurationMs = 0;
  private autoTuneSamples: Float32Array = new Float32Array(0);
  private autoTuneTickMs: Float32Array = new Float32Array(0);
  private autoTunePos = 0;
  private autoTuneCount = 0;
  private autoTuneCap = 0;


  // Onset detection state — zero-alloc insertion-sort median
  private onsetBuffer: Float64Array;
  private onsetSorted: Float64Array;
  private onsetPos = 0;
  private onsetSize = 0;
  private onsetPrevFlux = 0;
  private onsetBoost = 0;
  private onsetTarget = 0;
  // Refractory period — minimum gap between onsets, räknat i frames (FRAME_MS ≈ 13.33 ms)
  private onsetFrameCounter = 0;
  private onsetLastFrameIdx = -1000;
  // Refractory räknas dynamiskt från cal.onsetRefractoryMs / FRAME_MS (sann takt 75 Hz)

  // ── Drop-detektor (lång tidshorisont, @75Hz på bas-energi) ──
  // Drops är en struktur över sekunder: breakdown/uppbyggnad → plötslig bas-explosion.
  /** B4: återanvänd grid-objekt (enkeltrådad JS → säkert att mutera). */
  private _gridScratch = { bpm: 0, anchorMs: 0 };
  private bassFast = 0;          // EMA ~150ms — aktuell bas-nivå
  private bassSlow = 0;          // EMA ~2.5s — baslinje
  private breakdownFrames = 0;   // antal frames bassFast legat lågt (i förhållande till baslinjen)
  private dropFrameCounter = 0;   // räknar varje processDrop-anrop (@75Hz)
  private dropLastFrameIdx = -100000; // refractory-räknare (frames @75Hz)
  private dropFlashUntil = 0;    // performance.now()-tidsstämpel då vit blixt slutar
  private _analyserDropCount = -1;         // flankreferens mot frame.dropCount (-1 = ej seedad)
  private _dropSourceActive: 'analyser' | 'bass' = 'bass';   // telemetri: vem triggade senast

  // ── Taktklocka (beatClock) + PLL ──
  private _beat: Beat | null = null;   // fas + tempo, knuffad av verkliga kicks
  private _beatDetBpm = 0;             // senast om-ankrat BPM från analysatorn
  private _beatErr = 0;                // utsmetat fasfel (endast telemetri)
  private _lastGridIdx = -1;           // senaste taktnummer som fyrade en puls
  private _gridPulseCount = 0;
  private _reacqUntil = 0;             // vidgat re-lås-fönster efter låtbyte
  private _beatConfidentAt = 0;        // senast takten var pålitlig (coast-timeout)
  private _beatWasLocked = false;      // har låset varit bekräftat i denna låt?

  private cal: LightCalibration;

  // Precomputed tick constants — refreshed only when tickMs or cal changes
  private tc!: TickConstants;

  private _running = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private callbacks: TickCallback[] = [];

  // Palette state — endast lagring för API/UI; färgen sätts via setColor vid låtbyte
  private _palette: [number, number, number][] = [];
  private _paletteVersion = 0;
  private _lastSeenPaletteVersion = -1;

  // Raw mode — disables all processors for gain calibration
  private _rawMode = false;
  private _savedCal: Partial<LightCalibration> | null = null;
  // TV-soft mode — bright, gentle band profile for TV/SPDIF playback
  // Dirty-flag for calibration save — avoids unnecessary disk writes
  private _calDirty = false;

  // ── Frame/analys-taps (valfria observatörer) ──
  // Frame-tap: anropas i reaktiv tickInner med den färg+brightness som accepterats
  // till BLE-writerns 1-slot (faktisk leverans kan droppa äldre frames).
  private _frameTap: ((pct: number, r: number, g: number, b: number) => void) | null = null;
  // Analys-tap: anropas per FFT-frame (~75Hz) med RÅ band/flux FÖRE ljus-estetik.
  private _analysisTap: ((bassRms: number, midHiRms: number, totalRms: number, flux: number) => void) | null = null;
  // Offline-playback/auto-sync borttaget (2026-06): allt körs realtime.

  constructor(tickMs = 25) {
    this.tickMs = tickMs;
    this.cal = loadCalibration();
    setBeatCutoffHz(this.cal.beatCutoffHz);
    this.onsetBuffer = new Float64Array(7);
    this.onsetSorted = new Float64Array(7);
    this.initOnsetBuffer();
    this.tc = computeTickConstants(tickMs, this.cal);
    setSlotLeaseMs(this.tickMs); // 1:1 med engine-ticken
  }

  getPalette(): [number, number, number][] { return this._palette; }
  setVolume(vol: number | undefined) { this.volume = vol; }
  getTickMs(): number { return this.tickMs; }

  setTickMs(ms: number) {
    this.tickMs = ms;
    this.initOnsetBuffer();
    this.tc = computeTickConstants(ms, this.cal);
    setSlotLeaseMs(this.tickMs); // 1:1 med engine-ticken
  }

  setColor(rgb: [number, number, number]) {
    this.colorTarget = [rgb[0], rgb[1], rgb[2]];
  }

  setPalette(palette: [number, number, number][]) {
    if (palette.length > 0) {
      const p = palette[0];
      this.colorTarget = [p[0], p[1], p[2]];
    }
    this._palette = palette;
    this._paletteVersion++;
  }

  /** Justera fade-tid i ms för övergången mellan gammal och ny palette-färg. */
  setColorFadeMs(ms: number) {
    this.colorFadeMs = Math.max(0, ms | 0);
    this.tc = computeTickConstants(this.tickMs, this.cal);
  }

  // ── Record / Playback API ──

  /** Sätt frame-tap (eller null för att koppla bort). */
  setFrameTap(cb: ((pct: number, r: number, g: number, b: number) => void) | null) {
    this._frameTap = cb;
  }

  /** Sätt analys-tap (rå band/flux per FFT-frame), eller null för att koppla bort. */
  setAnalysisTap(cb: ((bassRms: number, midHiRms: number, totalRms: number, flux: number) => void) | null) {
    this._analysisTap = cb;
  }



  private initOnsetBuffer(): void {
    // ~175 ms median-fönster på den SANNA frame-takten (75 Hz) ≈ 13 frames.
    // Tidigare kopplat till tickMs, som inte längre styr frame-takten (gav ~93 ms).
    this.onsetSize = Math.max(3, Math.round(175 / FRAME_MS));

    if (this.onsetBuffer.length < this.onsetSize) {
      this.onsetBuffer = new Float64Array(this.onsetSize);
      this.onsetSorted = new Float64Array(this.onsetSize);
    } else {
      this.onsetBuffer.fill(0);
      this.onsetSorted.fill(0);
    }
    this.onsetPos = 0;
    this.onsetPrevFlux = 0;
    this.onsetBoost = 0;
    this.onsetTarget = 0;
    this.onsetFrameCounter = 0;
    this.onsetLastFrameIdx = -1000;
    // Drop-detektor-state
    this.bassFast = 0;
    this.bassSlow = 0;
    this.breakdownFrames = 0;
    this.dropFrameCounter = 0;
    this.dropLastFrameIdx = -100000;
    this.dropFlashUntil = 0;
    this._analyserDropCount = -1;   // ny flankreferens mot analysatorns dropCount
  }

  /** Zero-alloc onset detection using precomputed constants.
   *  Triggers a strong, short pulse on each detected transient (kick/snare),
   *  with refractory period to avoid flutter on sustained loud passages. */
  private processOnset(flux: number, allowTrigger = true): boolean {
    const tc = this.tc;
    this.onsetBuffer[this.onsetPos] = flux;
    this.onsetPos = (this.onsetPos + 1) % this.onsetSize;

    // Insertion-sort in-place (N≤7, ~20 comparisons max)
    const n = this.onsetSize;
    const s = this.onsetSorted;
    for (let i = 0; i < n; i++) s[i] = this.onsetBuffer[i];
    for (let i = 1; i < n; i++) {
      const v = s[i];
      let j = i - 1;
      while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; }
      s[j + 1] = v;
    }

    const mid = n >> 1;
    const med = (n & 1) ? s[mid] : (s[mid - 1] + s[mid]) * 0.5;
    // Stricter threshold (cal.onsetThreshold × median + floor) → only real beats trigger, not noise
    // Adaptiv suppression: vid uthålligt hög amplitud (ampEnv > 0.5) höj tröskeln
    // upp till +75% så flux-jitter på "fulla" mixar inte staplar pulser.
    const dc = this.ampEnv;
    const suppression = dc > 0.5 ? 1 + (dc - 0.5) * 1.5 : 1;
    const threshold = med * this.cal.onsetThreshold * suppression + 0.008;

    // False-positive-skydd (2026-06-02):
    //  1) ABS_FLUX_FLOOR — i tystnad/brus faller median mot 0 och tröskeln
    //     kollapsar till +0.008; ett absolut golv hindrar flimmer i tysta partier.
    //  2) PROMINENCE — kräv att flux sticker ut TYDLIGT över median (×1.6),
    //     inte bara passerar den adaptiva tröskeln. Sållar bort sustain-jitter.
    const ABS_FLUX_FLOOR = 0.045;
    const PROMINENCE = 1.6;
    const isCandidate =
      flux > threshold &&
      flux >= this.onsetPrevFlux &&
      flux >= ABS_FLUX_FLOOR &&
      flux >= med * PROMINENCE;
    this.onsetPrevFlux = flux;


    // Refractory gate: minimum gap mellan onsets, i frames på sann takt (hoistad till tc)
    const refractoryFrames = this.tc.refractoryFrames;
    this.onsetFrameCounter++;
    let fired = false;
    if (isCandidate && (this.onsetFrameCounter - this.onsetLastFrameIdx) >= refractoryFrames) {
      fired = true;
      this.onsetLastFrameIdx = this.onsetFrameCounter;
      // strong pulse — clearly visible "in the beat". Hoppas över när gridet driver.
      if (allowTrigger) this.onsetTarget = 0.45;
    }

    // Fast rise using precomputed alpha, smooth decay using precomputed decay
    if (this.onsetBoost < this.onsetTarget) {
      this.onsetBoost += tc.onsetRiseAlphaFft * (this.onsetTarget - this.onsetBoost);
    } else {
      this.onsetBoost *= tc.onsetDecayFft;
    }
    this.onsetTarget *= tc.onsetDecayFft;

    if (this.onsetBoost < 0.001) { this.onsetBoost = 0; this.onsetTarget = 0; }
    return fired;
  }

  /**
   * TAKTKLOCKAN — tempo från analysatorn, fas låst mot verkliga trumslag (PLL).
   *
   * Tempot om-ankras bara när det avviker >2 BPM (annars ankrar varje litet
   * BPM-hopp om klockan och pulsen läses som stroboskop). Vid om-ankring bevaras
   * fasen. PLL:en knuffar sedan ankaret cal.beatSyncStrength (10 %) av fasfelet
   * per kick, adaptivt skalat med bpmConfidence, och en PI-frekvensterm nollar
   * det permanenta laget när BPM-siffran ligger ett snäpp fel (bunden ±4 BPM).
   */
  /**
   * LÅTBYTE (Sonos trackName ändrades, debouncat i index.ts).
   * En HINT, inte en reset: gatewayen kan rapportera 1-2 s sent och ett byte
   * betyder inte alltid nytt tempo. Nuvarande BPM behålls som startgissning
   * medan tempo-sökningen vidgas i ~5 s, och lås-hållningen (coast) släpps så
   * en verkligt ny takt får ta över direkt.
   */
  notifyTrackChange(): void {
    const now = Date.now();
    this._reacqUntil = now + 5000;
    this._beatWasLocked = false;      // coast gäller inom EN låt
    this._beatConfidentAt = now;      // ge nya låten full coast-budget
    this._beatDetBpm = 0;             // nästa analysator-BPM får om-ankra direkt
    hintAnalyserTrackChange(5000);
    dlog('beat', `Track change → re-acquisition window 5s (guess ${Math.round(this._beat?.bpm ?? 0)} BPM)`);
  }

  private updateBeatClock(kick: boolean): void {
    const frame = getLatestFrame();
    const bpm = frame?.bpm ?? 0;
    const conf = frame?.bpmConfidence ?? 0;
    const nowMs = Date.now();
    const reacq = nowMs < this._reacqUntil;

    if (bpm > 40) {
      // Under re-acquisition räcker 0.5 BPM avvikelse för att om-ankra (annars 2),
      // så en ny takt landar utan att glida in via PLL:en.
      if (!this._beat || Math.abs(bpm - this._beatDetBpm) > (reacq ? 0.5 : 2)) {
        this._beatDetBpm = bpm;
        let anchor = frame?.beatAnchorMs || nowMs;
        if (this._beat) {
          // Bevara nuvarande fas vid tempoändring så pulsen inte hoppar.
          const oldMs = 60000 / this._beat.bpm, newMs = 60000 / bpm;
          const ph = ((((nowMs - this._beat.anchorMs) % oldMs) + oldMs) % oldMs) / oldMs;
          anchor = nowMs - ph * newMs;
        }
        this._beat = { anchorMs: anchor, bpm, confidence: conf };
      } else {
        this._beat.confidence = conf;
      }
    }

    // ── COAST: håll låset genom breakdowns ──
    // Inom SAMMA låt (ingen track-change-hint) och när låset en gång varit
    // bekräftat: en confidence-dipp får inte tappa taktlåset — då flappar
    // grid-pulserna av/på i varje tyst parti. Vi behåller tempo+fas och låter
    // PLL:en re-synka mjukt när slagen kommer tillbaka. Låset släpps bara vid
    // faktiskt låtbyte eller >8 s helt utan pålitlig takt.
    if (this._beat) {
      if ((this._beat.confidence ?? 0) >= MIN_BEAT_CONFIDENCE) {
        this._beatConfidentAt = nowMs;
        this._beatWasLocked = true;
      } else if (this._beatWasLocked && !reacq && nowMs - this._beatConfidentAt < 8000) {
        this._beat.confidence = MIN_BEAT_CONFIDENCE;    // coasta på rutnätet
      } else if (this._beatWasLocked && nowMs - this._beatConfidentAt >= 8000) {
        this._beatWasLocked = false;                    // långvarig taktlöshet → släpp
      }
    }

    // Ge analysatorn vårt grid: den grindar kick-kandidater mot takten och kan
    // räkna taktfas (barShift). Utan grid faller den tillbaka på ogrindad flux.
    // B4: scratch-objekt i stället för nyallokering var frame (~75 Hz) — enda
    // kvarvarande per-frame-heap-allokeringen i den heta loopen (matade GC-pausen).
    if (this._beat) {
      this._gridScratch.bpm = this._beat.bpm;
      this._gridScratch.anchorMs = this._beat.anchorMs;
      setAnalyserBeatGrid(this._gridScratch);
    } else {
      setAnalyserBeatGrid(null);
    }

    if (!kick || !this._beat) return;

    const k0 = this.cal.beatSyncStrength;
    const beatMsNow = 60000 / this._beat.bpm;
    // Fasen mäts helst mot analysatorns FÄRDIGMÄTTA slagtid (sub-hop, ±1.3 ms).
    // Date.now() här bär ALSA-leveransens jitter. Bara färska värden duger.
    const kickAt = frame?.kickAtMs ?? 0;
    const nowRef = kickAt > 0 && nowMs - kickAt < 60 ? kickAt : nowMs;
    const ph = ((((nowRef - this._beat.anchorMs) % beatMsNow) + beatMsNow) % beatMsNow) / beatMsNow;

    const err = ph < 0.5 ? ph : ph - 1;    // -0.5..0.5 av ett taktslag
    if (Math.abs(err) >= 0.25) return;     // off-beat/synkoperade slag räknas ej
    this._beatErr = this._beatErr * 0.85 + err * 0.15;   // ihållande lag för UI
    if (k0 <= 0) return;

    let k = k0 * (0.3 + 1.4 * conf);       // tydlig takt → snabbare inlåsning
    if (k > 0.4) k = 0.4; else if (k < 0.03) k = 0.03;
    this._beat.anchorMs += err * beatMsNow * k;
    if (conf > 0.4) {
      this._beat.bpm += err * 0.35 * conf;
      const lo = this._beatDetBpm - 4, hi = this._beatDetBpm + 4;
      if (this._beat.bpm < lo) this._beat.bpm = lo;
      else if (this._beat.bpm > hi) this._beat.bpm = hi;
    }
  }

  /** Taktklockans tillstånd — för /api/status och UI. */
  getBeatInfo(): {
    locked: boolean; bpm: number; confidence: number; phase: number;
    nextBeatMs: number; beatErr: number; gridPulses: number; leadMs: number;
    dropSrc: 'analyser' | 'bass'; coasting: boolean; reacquiring: boolean;
  } {
    const now = Date.now();
    const lead = this.cal.beatLeadMs;
    return {
      locked: hasBeat(this._beat),
      bpm: this._beat?.bpm ?? 0,
      confidence: this._beat?.confidence ?? 0,
      phase: beatPhase(this._beat, now, lead),
      nextBeatMs: hasBeat(this._beat) ? nextBeatIn(this._beat, now, lead) : 0,
      beatErr: this._beatErr,
      gridPulses: this._gridPulseCount,
      leadMs: lead,
      dropSrc: this._dropSourceActive,
      coasting: this._beatWasLocked && (getLatestFrame()?.bpmConfidence ?? 0) < MIN_BEAT_CONFIDENCE,
      reacquiring: now < this._reacqUntil,
    };
  }

  /**
   * Drop-detektor @75Hz på bas-energi. Drops är en lång-horisont-struktur:
   * breakdown/uppbyggnad (lugnt parti) → plötslig bas-explosion. Skiljer sig
   * från onset (70ms-transient) genom att kräva ett föregående nedbrutet parti.
   * Triggar en stor vit punch-blixt (dropFlashUntil) som overridas i tickInner.
   */
  private processDrop(bassRms: number, frame: Frame | null): void {
    if (!this.cal.dropEnabled) return;
    this.dropFrameCounter++;

    // Tidsbaserade EMA:er (dt-konstanterna är 100 Hz-kalibrerade, se M4): fast ~150ms, slow ~2.5s.
    const FAST_ALPHA = 0.064;
    const SLOW_ALPHA = 0.004;
    if (this.bassSlow <= 0) {
      this.bassFast = bassRms;
      this.bassSlow = bassRms;
    } else {
      this.bassFast += FAST_ALPHA * (bassRms - this.bassFast);
      this.bassSlow += SLOW_ALPHA * (bassRms - this.bassSlow);
    }

    const sens = this.cal.dropSensitivity > 0 ? this.cal.dropSensitivity : 1.0;
    const BREAKDOWN_RATIO = 0.6;          // bassFast < 60% av baslinjen = lugnt parti
    const MIN_BREAKDOWN_FRAMES = 40;      // ≥400ms lugnt innan ett drop kan triggas
    const JUMP_FACTOR = 1.8 * sens;       // bassFast måste överstiga baslinjen så mycket
    const ABS_BASS_FLOOR = 0.06;          // absolut energi → ingen drop i tystnad
    const REFRACTORY_FRAMES = 400;        // ~4s mellan drops

    // Spåra/erodera breakdown-minnet (också när analysatorn driver dropen — den
    // egna detektorn måste vara varm den sekund taktlåset tappas).
    if (this.bassFast < this.bassSlow * BREAKDOWN_RATIO) {
      if (this.breakdownFrames < 1000) this.breakdownFrames++;
    } else if (this.breakdownFrames > 0) {
      this.breakdownFrames -= 2; // erodera över ~1s när det blir högt igen
      if (this.breakdownFrames < 0) this.breakdownFrames = 0;
    }

    // ANALYSATORNS DROP (steg 1): dropCount är MONOTON, så en flankjämförelse mot
    // vårt eget senaste värde kan aldrig missa ett drop även om vi läser glesare.
    // Den detektorn är novelty/kropp-baserad och ser drops utan bastapp, vilket
    // bas-svackan nedan per definition inte gör. Kräver taktlås — utan bpm är
    // analysatorns strukturlogik inte varm, och då är bas-svackan bättre än inget.
    const analyserOwns = this.cal.dropSource !== 'bass' && frame != null && frame.bpm > 40;
    let isDrop: boolean;
    if (analyserOwns) {
      const dc = frame!.dropCount;
      if (this._analyserDropCount < 0) { this._analyserDropCount = dc; }
      isDrop = dc > this._analyserDropCount &&
        (this.dropFrameCounter - this.dropLastFrameIdx) >= REFRACTORY_FRAMES;
      this._analyserDropCount = dc;
    } else {
      this._analyserDropCount = -1;   // ny flankreferens när/om analysatorn tar över igen
      isDrop =
        this.breakdownFrames >= MIN_BREAKDOWN_FRAMES &&
        this.bassFast >= ABS_BASS_FLOOR &&
        this.bassFast >= this.bassSlow * JUMP_FACTOR &&
        (this.dropFrameCounter - this.dropLastFrameIdx) >= REFRACTORY_FRAMES;
    }
    this._dropSourceActive = analyserOwns ? 'analyser' : 'bass';

    if (isDrop) {
      this.dropLastFrameIdx = this.dropFrameCounter;
      this.breakdownFrames = 0;
      const _now = performance.now();
      // White INSTANTLY on drop — no black dip first (no dip branch exists).
      this.dropFlashUntil = _now + (this.cal.dropFlashMs);
      bleStatsState.dropCount++;
      // Express-write: max brightness omedelbart, behåll palette-färgen
      // (2026-07-22: ingen vit tvingning — drop förstärker aktuell färg).
      if (this._bleOwner === 'active') {
        const r = this.color[0] | 0, g = this.color[1] | 0, b = this.color[2] | 0;
        const result = sendToBLE(r, g, b, 100);
        if (result === 'sent') this.lastSentPct = 100;
      }
    }
  }


  private forceIdleNow(): void {
    const idle = loadIdleColor();
    const r = idle[0] | 0, g = idle[1] | 0, b = idle[2] | 0;
    setIdleColor(r, g, b);
    // Reflektera idle-färgen i diagnostics så /api/live visar rätt
    // färg i UI:t. tickInner uppdaterar bara _diag i playing-mode, så utan
    // detta visar UI:t 0,0,0 (svart) hela tiden lampan står i idle.
    _diag.finalR = r;
    _diag.finalG = g;
    _diag.finalB = b;
    _diag.brightnessPct = 100;
    _tickData.color[0] = r;
    _tickData.color[1] = g;
    _tickData.color[2] = b;
    _tickData.brightness = 100;
  }

  // ── BLE owner-switch ──
  // EN väg åt gången: 'idle' (keep-alive @200ms bär idle-färg + länk),
  // 'active' (sendToBLE per FFT-tick under play), eller 'none' (BLE ej ansluten).
  // Övergångar sker via onBleConnected/onBleDisconnected/setPlaying.
  // tickInner returnerar tidigt om owner !== 'active' (skydd mot sen FFT-frame
  // som försöker skriva efter pause).
  private _bleOwner: 'idle' | 'active' | 'none' = 'none';

  /** True om BLE är ansluten (owner !== 'none'). */
  private get _bleConnected(): boolean { return this._bleOwner !== 'none'; }

  // ── Idle-disconnect (2 min utan musik → koppla från lampan + stoppa ALSA) ──
  // Sparar ~20-25% CPU på Pi Zero 2 W under långa pauser. Reconnect triggas
  // enbart av Sonos PLAYING-event (audio-wake medvetet uteslutet pga rumssamtal).
  // Se mem://pi/runtime/idle-disconnect-policy.
  private _idleDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleEnteredAt: number | null = null;
  private _micPausedForIdle = false;
  private _lastPlayingChangeAt = 0;
  private static readonly IDLE_DISCONNECT_MS = 2 * 60 * 1000;
  private static readonly PLAYING_DEBOUNCE_MS = 500;

  /** Status-getter för /api/status. Null om ingen idle-timer aktiv. */
  getIdleEnteredAt(): number | null { return this._idleEnteredAt; }
  isMicPausedForIdle(): boolean { return this._micPausedForIdle; }

  private clearIdleDisconnectTimer(): void {
    if (this._idleDisconnectTimer) {
      clearTimeout(this._idleDisconnectTimer);
      this._idleDisconnectTimer = null;
    }
    this._idleEnteredAt = null;
  }

  /** Publik nedrivning som lifecycle anropar vid PAUSED→IGNITION-övergång.
   *  Skickar idle-färg @ 100%, drainar HCI, stoppar keep-alive, BLE off, mic stop.
   *  Mid-flight aborts om this.playing flippar tillbaka. */
  async shutdownToIgnition(): Promise<void> { return this.handleIdleDisconnect(); }

  private async handleIdleDisconnect(): Promise<void> {
    this._idleDisconnectTimer = null;
    if (this._bleOwner === 'none') {
      this._idleEnteredAt = null;
      dlog('[Engine] shutdownToIgnition: BLE redan disconnected — no-op');
      return;
    }
    dlog('[Engine] Idle-disconnect: idle-färg @ 100% → drain HCI → BLE off → ALSA stop');

    // 1. Sista write: idle-färg @ full ljusstyrka så lampan står lyst efter disconnect.
    const idle = loadIdleColor();
    try { sendToBLE(idle[0], idle[1], idle[2], 100); } catch (e: any) {
      dlog(`[Engine] sendIdleFullBrightness failed: ${e?.message ?? e}`);
    }
    flushQueuedWriteNow();

    // 2. Vänta tills 1-slot + HCI-kön är tom så paketet faktiskt går iväg (max 500ms).
    const deadline = Date.now() + 500;
    while (hasQueuedWrite() || (isControllerDrainAttached() && getOutstandingPackets() > 0)) {
      if (Date.now() > deadline) {
        dlog('[Engine] Outstanding-wait timeout — fortsätter ändå');
        break;
      }
      await new Promise(r => setTimeout(r, 20));
      // Mid-flight abort: Sonos PLAYING kan komma in under drain-fönstret.
      // Då har wake-pathen i index.ts redan kallat alsaMic.startMic() och
      // ev. connectHardcoded() — vi får INTE fortsätta riva ner.
      if (this.playing) {
        dlog('[Engine] Idle-disconnect avbruten under drain — Sonos PLAYING kom emellan');
        this._idleEnteredAt = null;
        return;
      }
    }

    // 3. Stoppa keep-alive innan disconnect (förhindrar race med write-failure).
    stopKeepAlive();

    // 4. Disconnect (markeras som auto → Sonos PLAYING får reconnecta senare).
    try { await triggerIdleDisconnect(); } catch (e: any) {
      dlog(`[Engine] triggerIdleDisconnect failed: ${e?.message ?? e}`);
    }

    // Mid-flight abort #2: även efter triggerIdleDisconnect kan PLAYING ha
    // landat. Skippa stopMic så wake-pathens startMic() inte direkt dödas.
    if (this.playing) {
      dlog('[Engine] Idle-disconnect: BLE redan disconnectad men PLAYING kom — hoppar över stopMic');
      this._idleEnteredAt = null;
      return;
    }

    // 5. Stoppa ALSA-mic → ~20-25% CPU-besparing under idle.
    try {
      stopMic();
      this._micPausedForIdle = true;
      dlog('[Engine] ALSA-mic stoppad — väntar på Sonos PLAYING-event');
    } catch (e: any) {
      dlog(`[Engine] stopMic failed: ${e?.message ?? e}`);
    }

    this._idleEnteredAt = null;
  }

  /** Anropas av connect-hardcoded EFTER lyckad anchor write.
   *  Keep-alive kör BARA i idle-mode. Under playing räcker FFT-write-kedjan
   *  (med min 5 pkt/s garanti via stale-write-force i protocol.ts) för att
   *  hålla länken vid liv. Det hindrar att keep-alive bygger kö parallellt
   *  med active path. */
  onBleConnected(): void {
    if (this._bleOwner !== 'none') return;
    this._bleOwner = this.playing ? 'active' : 'idle';
    // Färsk session — rensa ev. pending idle-disconnect-timer + mic-paus-flagga.
    this.clearIdleDisconnectTimer();
    this._micPausedForIdle = false;
    if (!this.playing) {
      this.forceIdleNow();
      clearQueuedWrite();
      startKeepAlive();
      dlog(`[Engine] BLE connected → idle mode (keep-alive PÅ)`);
    } else {
      // Ren start: rensa onset så första riktiga beat ger en tydlig
      // puls istället för att blandas med stale state från senaste sessionen.
      this.onsetBoost = 0;
      this.onsetTarget = 0;
      this.smoothed = 0;
      this.lastBrightness = 0;
      this.lastSentPct = -1;
      this._lastTickAtForFade = 0;  // första fade efter play ska börja från noll-elapsed
      this._lastSmoothAt = 0;       // återställ tidsbaserad EMA-klocka
      stopKeepAlive();
      dlog(`[Engine] BLE connected → active mode (keep-alive AV — FFT-writes håller länken)`);
    }
  }

  /** Anropas av connect-hardcoded vid disconnect (peripheral.disconnect-event). */
  onBleDisconnected(): void {
    if (this._bleOwner === 'none') return;
    this._bleOwner = 'none';
    clearQueuedWrite();
    stopKeepAlive();
    // Rensa idle-timer (kan vara pending om disconnect kom innan timeout fyrade).
    this.clearIdleDisconnectTimer();
    dlog('[Engine] BLE disconnected → owner=none, keep-alive STOPPAD');
  }

  setPlaying(playing: boolean): void {
    const now = Date.now();
    const wasPlaying = this.playing;
    if (playing === wasPlaying) return;

    // Anti-flap debounce: Sonos kan rapportera PLAYING→STOPPED→PLAYING
    // inom <1s vid trackbyte. 500ms guard filtrerar bort snabba PAUSED-flaps.
    // VIKTIGT: debouncen gäller ENBART PLAYING→PAUSED. PLAYING måste alltid
    // släppas igenom omedelbart — annars riskerar vi att engine fastnar i
    // idle om en spurious PAUSED kom precis innan riktig PLAYING.
    //
    // BUGFIX 2026-05-02: tidigare returnerade vi UTAN att schemalägga
    // re-check, vilket innebar att PAUSED-eventet tappades för gott
    // (nästa poll såg playing===wasPlaying och tog tidig return). Det
    // gjorde att idle-disconnect aldrig triggade om paus skedde nära ett
    // trackbyte. Nu schemalägger vi en deferred re-call så state följer
    // verkligheten även när första PAUSED-flippen kommer för tidigt.
    if (!playing && now - this._lastPlayingChangeAt < PiLightEngine.PLAYING_DEBOUNCE_MS) {
      const remaining = PiLightEngine.PLAYING_DEBOUNCE_MS - (now - this._lastPlayingChangeAt);
      dlog(`[Engine] setPlaying(false) debounced — re-checkar om ${remaining}ms`);
      setTimeout(() => {
        // Vid re-check: om engine fortfarande tror att vi spelar OCH
        // ingen ny PLAYING har kommit emellan → applicera PAUSED nu.
        if (this.playing) this.setPlaying(false);
      }, remaining + 10);
      return;
    }
    this._lastPlayingChangeAt = now;

    this.playing = playing;
    dlog(`[Engine] setPlaying(${playing}) — wasPlaying=${wasPlaying}, owner=${this._bleOwner}`);

    if (!playing) {
      // active → idle: reset onset + force idle-färg, starta keep-alive.
      this.onsetBoost = 0;
      this.onsetTarget = 0;
      this.smoothed = 0;
      this.lastBrightness = 0;
      this.lastSentPct = -1;
      this._lastTickAtForFade = 0;
      this._lastSmoothAt = 0;
      this.stopLoop();
      if (this._bleOwner !== 'none') {
        this._bleOwner = 'idle';
        clearQueuedWrite();
        this.forceIdleNow();
        startKeepAlive();
        dlog('[Engine] → idle mode (owner=idle, keep-alive PÅ — väntar på lifecycle.shutdownToIgnition)');
        // OBS: 2-min idle-disconnect-timer borttagen. Lifecycle (engineLifecycle.ts)
        // schemalägger shutdownToIgnition() efter IGNITION_REENTRY_GRACE_MS (1500ms)
        // och cancellerar om PLAYING kommer tillbaka inom fönstret.
      } else {
        dlog('[Engine] → idle mode (BLE ej ansluten)');
      }
    } else {
      // idle → active: stoppa keep-alive (FFT-writes tar över), starta loop.
      // Keep-alive får ALDRIG köra parallellt med active path — det skulle
      // bygga kö i HCI-lagret.
      this.clearIdleDisconnectTimer();
      this.startLoop();
      if (this._bleOwner !== 'none') {
        this._bleOwner = 'active';
        stopKeepAlive();
        dlog('[Engine] → active mode (owner=active, keep-alive AV, FFT-writes håller länken)');
      } else {
        dlog('[Engine] → active mode (BLE ej ansluten, loop startad men inga writes)');
      }
    }
  }

  reloadCalibration(): void {
    this.cal = loadCalibration();
    setBeatCutoffHz(this.cal.beatCutoffHz);
    this._calDirty = true; // mark for next save cycle
    // Re-apply raw mode overrides if active
    if (this._rawMode) {
      this.cal.transientGain = 0;
    }
    this.tc = computeTickConstants(this.tickMs, this.cal);
  }

  /** Enable raw mode — disables all processors for gain calibration */
  setRawMode(on: boolean): void {
    if (on && !this._rawMode) {
      this._rawMode = true;
      this._savedCal = {
        transientGain: this.cal.transientGain,
      };
      this.cal.transientGain = 0;
      this.tc = computeTickConstants(this.tickMs, this.cal);
      dlog('[Engine] Raw mode ON — all processors disabled');
    } else if (!on && this._rawMode) {
      this._rawMode = false;
      if (this._savedCal) {
        Object.assign(this.cal, this._savedCal);
        this._savedCal = null;
      }
      this.tc = computeTickConstants(this.tickMs, this.cal);
      dlog('[Engine] Raw mode OFF — processors restored');
    }
  }

  isRawMode(): boolean { return this._rawMode; }


  /** Initialize engine — call once at boot. Loop only starts when setPlaying(true). */
  start(): void {
    if (this._running) return;
    this._running = true;

    // Register for FFT-driven ticks (event-driven, not polling)
    onFFTReady(() => this.onFFTFrame());
    onFluxReady((flux) => {
      if (this._loopActive && this.playing && this._bleOwner === 'active') {
        // Energy gate (2026-05-02): låt inte den adaptiva tröskeln skala ner
        // till brusgolvet och flasha i tysta partier. Hämtar bands EN gång
        // och delar med dynamicCenter-uppdateringen nedan.
        const bands = getLatestBands();
        // Analysatorns frame används bara när den är FÄRSK (<60 ms, samma guard
        // som PLL:en). Är den gammal faller varje steg nedan tillbaka på den
        // egna FFT-vägen i stället för att styra ljuset på inaktuell struktur.
        const frame = Date.now() - getLatestFrameAt() < 60 ? getLatestFrame() : null;
        const energyFloor = this.cal.onsetEnergyFloor;
        const peakBand = bands ? Math.max(bands.bassRms, bands.midHiRms) : 0;
        const passesEnergyGate =
          energyFloor <= 0 ||
          (bands != null && Number.isFinite(peakBand) && peakBand >= energyFloor);
        // Grid-driven puls (taktklockan) tar över pulsen när takten är låst OCH
        // pålitlig; annars driver den verkliga onseten pulsen som förut.
        const gridDrives = this.cal.beatGridPulse !== false && hasBeat(this._beat);
        let kickFired = false;
        if (passesEnergyGate) {
          // Lågpass-onset: bassFlux är analysatorns per-band-onsets under
          // cal.beatCutoffHz (setBeatCutoffHz) — kick skild från basgång redan
          // vid källan. Faller tillbaka på bredbands-flux om bands saknas.
          const beatFlux = bands ? bands.bassFlux : flux;

          // Onset-detektionen körs ALLTID (PLL:en behöver flankerna) — men den får
          // bara sätta pulsen när gridet inte driver den.
          kickFired = this.processOnset(beatFlux, !gridDrives);
        }
        // Taktklocka: tempo från analysatorn, fas låst mot verkliga kicks (PLL).
        this.updateBeatClock(kickFired);
        // Pulsen fyras av rutnätet med leadMs försprång → toppen landar PÅ slaget
        // trots BLE-skrivlatensen, i stället för strax efter det.
        if (gridDrives && passesEnergyGate) {
          const idx = beatIndex(this._beat, Date.now() + (this.cal.beatLeadMs));
          if (idx !== this._lastGridIdx) {
            this._lastGridIdx = idx;
            // ETTANS ACCENT (steg 5): barShift säger hur många slag ankaret ska
            // flyttas för att landa på ettan (-1 = osäkert), så ettan är de idx där
            // (idx + barShift) delas av 4. Kräver god konfidens — på ett gissat
            // rutnät hade accenten hamnat på fel slag och känts som en missad takt.
            const accent = this.cal.barAccent;
            const shift = frame?.barShift ?? -1;
            const onOne = accent > 1 && shift >= 0 && (this._beat?.confidence ?? 0) > 0.4 &&
              ((((idx + shift) % 4) + 4) % 4) === 0;
            this.onsetTarget = onOne ? Math.min(1, 0.45 * accent) : 0.45;
            this._gridPulseCount++;
          }
        }
        // Drop-detektor @75Hz (analysatorns dropCount med bas-svackan som fallback).
        if (bands) this.processDrop(bands.bassRms, frame);
        // (Dirigenten v2 2026-08-25: inget dynamicCenter. Brightness-formen
        //  kommer från analyser-intensity; rå amplitud är bara loudness-skala.)

        // Analys-tap: rapportera RÅ band/flux (oförvrängd källa) @75Hz till recorder.
        if (this._analysisTap && bands) {
          this._analysisTap(bands.bassRms, bands.midHiRms, bands.totalRms, flux);
        }
      }
    });
    // Always start the loop — CPU is negligible
    this.startLoop();
    // Keep-alive och idle-heartbeat startar INTE här — de startas först när
    // BLE faktiskt är ansluten (via onBleConnected från connect-hardcoded).
    // Annars spammar writeAsync mot null-device innan användaren tryckt connect.

    this.saveTimer = setInterval(() => {
      if (this._calDirty) {
        saveCalibration(this.cal);
        this._calDirty = false;
      }
    }, 10_000);

    dlog(`[Engine] Initialized (${this.tickMs}ms, loop always active, idle heartbeat until playback)`);
  }

  // ── Event-driven tick scheduling ──
  // Band-events fyras 75 ggr/sek (FRAME_MS = 13.33 ms). tickMs pacar bara BLE-slot-leasen,
  // inte tick-takten (tick-gaten är borta). Vi kör tickInner när
  // förflutit — ALLTID med den färska FFT-framen i handen. Tidigare schemalades
  // en setTimeout för "remaining ms" när FFT kom för tidigt, vilket innebar
  // att tickInner körde mot en GAMMAL getLatestBands() (upp till tickMs sen).
  // Det gav smygande audio-latens utan att synas i pkt/s. Borttaget.
  private _lastTickTime = 0;
  private _lastTickAtForFade = 0;
  private _lastSmoothAt = 0;   // för tidsbaserad EMA-alpha (robust mot hoppade ticks)
  private _loopActive = false;
  private _nextTickDeadline = 0;
  /** Called by ALSA FFT callback — runs in the audio data handler context */
  private onFFTFrame(): void {
    if (!this._loopActive) return;

    // EN tick för hela compute-kedjan: ljus-beslutet körs på VARJE FFT-frame
    // (~75 Hz) — ingen nedsampling, ingen aliasing, beslutet alltid ≤13.33ms
    // färskt. BLE-leveransen är frikopplad (1-plats-slot), så radions
    // conn-interval styr sändtakten, inte compute-takten.
    const now = performance.now();
    noteTick(now, this.tickMs);
    this._nextTickDeadline = now + this.tickMs;
    this._lastTickTime = now;
    this.tickInner();
  }

  private startLoop(): void {
    if (this._loopActive) return;
    this._loopActive = true;
    const now = performance.now();
    this._lastTickTime = now;
    this._nextTickDeadline = now + this.tickMs;
  }

  private stopLoop(): void {
    this._loopActive = false;
  }

  stop(): void {
    this._running = false;
    this.stopLoop();
    clearQueuedWrite();
    stopKeepAlive();
    onFFTReady(null); // unregister callback
    onFluxReady(null);
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    dlog('[Engine] Stopped');
  }

  /** Suspend engine output (for BLE tests etc.) — stops loop + keep-alive */
  suspend(): void {
    this.stopLoop();
    clearQueuedWrite();
    stopKeepAlive();
    dlog('[Engine] Suspended (BLE test mode)');
  }

  /** Resume engine output after suspend */
  resume(): void {
    this.startLoop();
    if (!this.playing && this._bleOwner !== 'none') {
      this._bleOwner = 'idle';
      this.forceIdleNow();
      startKeepAlive();
    }
    dlog(`[Engine] Resumed (${this.playing ? 'active' : 'idle'})`);
  }

  /** Restart tick scheduling — preserves all smoothing state */
  restartTimer(): void {
    this.stopLoop();
    if (this.playing) this.startLoop();
    dlog(`[Engine] Timer restarted (${this.tickMs}ms min interval = ${(1000 / this.tickMs + 0.5) | 0} Hz max, ${this.playing ? 'active' : 'idle'})`);
  }

  /** Guard against NaN/Infinity corrupting smoothing state */
  private sanitizeState(): void {
    if (!Number.isFinite(this.ampEnv)) this.ampEnv = 0;
    if (!Number.isFinite(this.smoothed)) this.smoothed = 0;
    if (!Number.isFinite(this.onsetBoost)) { this.onsetBoost = 0; this.onsetTarget = 0; }
    if (!Number.isFinite(this.lastBrightness)) this.lastBrightness = 0;
    if (!Number.isFinite(this.lastSentPct)) this.lastSentPct = -1;
    // A4: drop-EMA:erna kunde låsa till NaN permanent (togs inte av saneraren).
    if (!Number.isFinite(this.bassFast)) this.bassFast = 0;
    if (!Number.isFinite(this.bassSlow)) this.bassSlow = 0;
  }

  getDiagnostics(): DiagSnapshot { return _diag; }
  getCalibration(): LightCalibration { return this.cal; }

  // ── Auto-tune API ──
  /** Starta sampling av rå pct (post-slew, pre-deadband) i `durationMs`.
   *  Endast en session i taget — ny start avbryter pågående. */
  startAutoTune(durationMs: number): { ok: boolean; durationMs: number; capacity: number } {
    const dur = Math.max(2000, Math.min(120_000, durationMs | 0));
    // Kapacitet: tickMs (min 5ms) → reservera dur/tickMs + 20% safety
    const tm = Math.max(5, this.tickMs);
    const cap = Math.ceil((dur / tm) * 1.2) + 64;
    this.autoTuneSamples = new Float32Array(cap);
    this.autoTuneTickMs = new Float32Array(cap);
    this.autoTunePos = 0;
    this.autoTuneCount = 0;
    this.autoTuneCap = cap;
    this.autoTuneDurationMs = dur;
    this.autoTuneStartedAt = Date.now();
    this.autoTuneActive = true;
    return { ok: true, durationMs: dur, capacity: cap };
  }

  cancelAutoTune(): void {
    this.autoTuneActive = false;
    this.autoTuneSamples = new Float32Array(0);
    this.autoTuneTickMs = new Float32Array(0);
    this.autoTuneCount = 0;
    this.autoTunePos = 0;
    this.autoTuneCap = 0;
  }

  getAutoTuneStatus(): {
    active: boolean;
    elapsedMs: number;
    durationMs: number;
    sampleCount: number;
    progress: number; // 0..1
    done: boolean;
    suggestion?: {
      tickEnergyFloor: number;
      onsetEnergyFloor: number;
      silenceRms: number;
      musicRms: number;
      silenceRatio: number;        // andel ticks tolkade som tysta (0..1)
      separation: number;          // music/silence-ratio, högt = tydligt gap
      samplesUsed: number;
      sampleRateHz: number;
      isPlaying: boolean;
      hasSilentSection: boolean;   // true om vi sett < 0.02 i någon del
    };
    current?: { tickEnergyFloor: number; onsetEnergyFloor: number };
  } {
    const elapsed = this.autoTuneStartedAt ? Date.now() - this.autoTuneStartedAt : 0;
    const dur = this.autoTuneDurationMs || 1;
    const progress = Math.max(0, Math.min(1, elapsed / dur));
    const inProgress = this.autoTuneActive && elapsed < dur;

    if (this.autoTuneActive && elapsed >= dur) {
      this.autoTuneActive = false;
    }

    const result: any = {
      active: inProgress,
      elapsedMs: elapsed,
      durationMs: dur,
      sampleCount: this.autoTuneCount,
      progress,
      done: !this.autoTuneActive && this.autoTuneCount > 0,
      current: {
        tickEnergyFloor: this.cal.tickEnergyFloor,
        onsetEnergyFloor: this.cal.onsetEnergyFloor,
      },
    };
    if (!this.autoTuneActive && this.autoTuneCount > 32) {
      const s = this.analyzeAutoTuneSamples();
      result.suggestion = { ...s, isPlaying: this.playing };
    }
    return result;
  }

  /** Analys: hittar tystnads-partier (brusgolv) och musik-nivå i mic-RMS-loggen.
   *  - silenceRms = p10 av samples (representerar tysta partier / mellan-låt-glapp)
   *  - musicRms   = p70 av samples (representerar typisk musik-nivå)
   *  - tickEnergyFloor föreslås halvvägs mellan dem (geometriskt medel) men aldrig
   *    > 80% av musicRms — så musik aldrig gatas bort.
   *  - onsetEnergyFloor sätts något högre (×1.4) — beat-detektorn är känsligare.
   *  - hasSilentSection = true om vi sett samples ≤ 0.015 (rumsbrus-nivå). */
  private analyzeAutoTuneSamples(): {
    tickEnergyFloor: number;
    onsetEnergyFloor: number;
    silenceRms: number;
    musicRms: number;
    silenceRatio: number;
    separation: number;
    samplesUsed: number;
    sampleRateHz: number;
    hasSilentSection: boolean;
  } {
    const N = this.autoTuneCount;
    const cap = this.autoTuneCap;
    const buf = this.autoTuneSamples;
    const tms = this.autoTuneTickMs;
    const start = N < cap ? 0 : this.autoTunePos;
    const lin = new Float32Array(N);
    let totalDt = 0;
    for (let i = 0; i < N; i++) {
      const idx = (start + i) % cap;
      lin[i] = buf[idx];
      totalDt += tms[idx];
    }
    // Hoppa warmup (första 5 samples), sortera resten
    const skip = Math.min(5, N - 1);
    const sorted = Array.from(lin.slice(skip)).sort((a, b) => a - b);
    const pctile = (arr: number[], p: number): number =>
      arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];

    const silenceRms = pctile(sorted, 0.10);
    const musicRms = pctile(sorted, 0.70);

    // Geometriskt medel mellan brusgolv och musik = robust separator.
    // Faller tillbaka till silenceRms*1.5 om gap saknas (ingen tystnad samplad).
    const gm = silenceRms > 0 && musicRms > silenceRms
      ? Math.sqrt(silenceRms * musicRms)
      : silenceRms * 1.5;
    const cap80 = musicRms * 0.8;
    const tickRaw = Math.min(gm, cap80);
    const tickEnergyFloor = Math.round(Math.max(0.005, Math.min(0.20, tickRaw)) * 1000) / 1000;
    const onsetRaw = tickEnergyFloor * 1.4;
    const onsetEnergyFloor = Math.round(Math.max(0.005, Math.min(0.20, onsetRaw)) * 1000) / 1000;

    // Andel samples under tickEnergyFloor (= det som skulle ha gatats)
    let belowCount = 0;
    for (let i = skip; i < N; i++) if (lin[i] < tickEnergyFloor) belowCount++;
    const silenceRatio = N > skip ? belowCount / (N - skip) : 0;

    const separation = silenceRms > 0 ? Math.round((musicRms / silenceRms) * 10) / 10 : 0;
    const hasSilentSection = silenceRms <= 0.015 || sorted[0] <= 0.010;

    const avgDt = N > 0 ? totalDt / N : this.tickMs;
    const sampleRateHz = avgDt > 0 ? Math.round(10000 / avgDt) / 10 : 0;

    return {
      tickEnergyFloor,
      onsetEnergyFloor,
      silenceRms: Math.round(silenceRms * 1000) / 1000,
      musicRms: Math.round(musicRms * 1000) / 1000,
      silenceRatio: Math.round(silenceRatio * 100) / 100,
      separation,
      samplesUsed: N - skip,
      sampleRateHz,
      hasSilentSection,
    };
  }

  /** Intern: kallas från tickInner med bands.totalRms (rå mic-energi). */
  private recordAutoTuneSample(rms: number): void {
    if (!this.autoTuneActive) return;
    const elapsed = Date.now() - this.autoTuneStartedAt;
    if (elapsed >= this.autoTuneDurationMs) {
      this.autoTuneActive = false;
      return;
    }
    const cap = this.autoTuneCap;
    if (cap === 0) return;
    this.autoTuneSamples[this.autoTunePos] = rms;
    this.autoTuneTickMs[this.autoTunePos] = this.tickMs;
    this.autoTunePos = (this.autoTunePos + 1) % cap;
    if (this.autoTuneCount < cap) this.autoTuneCount++;
  }


  /** Hot path — zero-allocation, precomputed constants, event-driven from FFT */
  tickInner(): void {
    // Skip processing när engine inte spelar ELLER när vi inte är BLE-active-owner.
    // Sista guard mot sen FFT-frame som anländer efter setPlaying(false) → annars
    // kan en mic-write krocka med keep-alive som just tagit över.
    if (!this.playing || this._bleOwner !== 'active') return;

    // Offline-playback borttaget (2026-06-02): allt körs reaktivt/realtime.



    const _tickStart = performance.now();
    try {
      const cal = this.cal;
      const tc = this.tc;
      const bands = getLatestBands();
      // Steg 1 i hard-fail-pipelinen: har vi en mic-frame att jobba med?
      if (!bands || !Number.isFinite(bands.totalRms)) {
        bleStatsState.tickAbortNoMicCount++;
        return;
      }

      // ── 1. INPUT-SYNC: formen ÄR den råa, gain-satta inputen ──
      // level/shape = bands.totalRms (lightRawRms × tvåpunktsGain, ingen AGC).
      // frame.intensity (bands.shape) är sektions-relativ och används BARA till
      // topp-boosten nedan — aldrig som form-källa.
      const level = Math.max(0, Math.min(1, bands.totalRms));
      // STATISK DYNAMIK-EXPANSION: sträck det komprimerade level-området till
      // golv→tak. inLow/inHigh binds till gainens primärpunkt så de följer en
      // gain-omkalibrering men INTE volymen (level är redan volym-kompenserat).
      // Fasta tal → ingen AGC, ingen dynamicCenter.
      const gRef = (cal.gainCalibration?.point1?.gain as number) || 20;
      const inLow = (cal.inLowFrac ?? 0.009) * gRef;
      const inHigh = (cal.inHighFrac ?? 0.031) * gRef;
      let e = (level - inLow) / Math.max(1e-6, inHigh - inLow);
      e = e < 0 ? 0 : e > 1 ? 1 : e;
      const sx = cal.shapeExpand ?? 1.0;
      let shape = sx === 1 ? e : Math.pow(e, sx);

      // Mjuk topp-boost på ÄKTA toppar (intensity > 90 %), adderad FÖRE
      // smoothingen så soft-releasen fadear ner den jämnt (inget hack).
      {
        const _px = bands.shape ?? 0;
        const amt = cal.peakBoost;
        if (amt > 0 && _px > 0.9) {
          shape += (_px - 0.9) * 10 * amt;
          if (shape > 1) shape = 1;
        }
      }

      _diag.bassNorm = normalizeFixed(bands.bassRms);
      _diag.midHiNorm = normalizeFixed(bands.midHiRms);

      // ── 2. Tystnads-gate ──
      // När absolut amplitud < tickEnergyFloor är input rumsbrus, inte musik:
      // shape forceras till 0 och brightness sjunker mot golvet.
      const tickFloor = cal.tickEnergyFloor;
      const inSilence = tickFloor > 0 && level < tickFloor;
      if (inSilence) shape = 0;

      // ── 3. Långsam amplitud-envelope → LOUDNESS ──
      // Rå amplitud är uppmätt för platt inom låt. Den används därför inte som
      // dynamikbärare, utan bara för att tyst/låg volym ska lysa svagare.
      const _envElapsed = this._lastSmoothAt > 0
        ? Math.min(250, _tickStart - this._lastSmoothAt)
        : this.tickMs;
      const envUp = 1 - Math.exp(-_envElapsed / 300);
      const envDown = 1 - Math.exp(-_envElapsed / 2500);
      const envA = level > this.ampEnv ? envUp : envDown;
      this.ampEnv += envA * (level - this.ampEnv);
      const ampEnv = this.ampEnv;
      const floor = tc.brightnessFloor;
      const floorN = floor / 100;
      // EN mappning: tvåpunkts-gainen mot Sonos-volymen ger amplituden 0..1,
      // som mappas rakt in i golv..100 %. Loudness-golvet är enda ratten.
      // loudness ≡ ampEnv (clampen bet aldrig) — bara diagnostik.
      _diag.loudness = ampEnv;
      _diag.ceiling = floorN + (1 - floorN) * ampEnv;

      // ── 4. HEARTBEAT: snabb attack, mjuk release på shape ──
      // Tidsbaserad alpha så fade-takten blir identisk även när BLE hoppar frames.
      this._lastSmoothAt = _tickStart;
      const _eRatio = _envElapsed / 125;
      if (shape < this.smoothed) {
        const alpha = 1 - Math.pow(1 - cal.releaseAlpha, _eRatio);
        // Logaritmisk release: jämn, perceptuell fade (konstant ratio/tick).
        const _lo = 1e-4;
        const _c = this.smoothed < _lo ? _lo : this.smoothed;
        const _t = shape < _lo ? _lo : shape;
        this.smoothed = _c * Math.pow(_t / _c, alpha);
      } else {
        const alpha = 1 - Math.pow(1 - cal.attackAlpha, _eRatio);
        // MJUK attack vid låg energi (brus snäpper inte → inget flimmer),
        // full SNAP vid hög energi.
        const _softFloor = cal.lowSoftFloor;
        const _softK = _softFloor + (1 - _softFloor) * Math.min(1, shape / 0.5);
        this.smoothed += alpha * _softK * (shape - this.smoothed);
      }
      let shapeSm = this.smoothed;
      if (shapeSm < 0) shapeSm = 0;
      if (shapeSm > 1) shapeSm = 1;

      // ── 5. Transient boost (additiv bump, aldrig normalisering) ──
      const transientGain = tc.transientGain;
      const fluxBoost = (transientGain > 0 && !inSilence) ? this.onsetBoost * transientGain : 0;
      if (inSilence) {
        this.onsetBoost *= 0.5;
        if (this.onsetBoost < 0.001) { this.onsetBoost = 0; this.onsetTarget = 0; }
      }

      // ── 6. BRIGHTNESS: input-formen mappas rakt golv→tak (ingen loudness-faktor,
      // formen ÄR redan amplituden — att gånga med ampEnv dubbelräknar). ──
      let energyForm = shapeSm + fluxBoost;
      if (energyForm > 1) energyForm = 1;
      let outN = floorN + energyForm * (1 - floorN);
      if (outN < floorN) outN = floorN;
      if (outN > 1) outN = 1;

      _diag.energyNorm = outN;
      let pct = outN * 100;

      // Fast round + clamp
      pct = (pct + 0.5) | 0;
      if (pct > 100) pct = 100;
      if (pct < floor) pct = floor;

      // Auto-tune sampler: registrera RÅ mic-RMS (innan smoothing) så analysen
      // kan separera tysta partier (rumsbrus) från musik-nivå.
      if (this.autoTuneActive) this.recordAutoTuneSample(bands.totalRms);








      // ── 7b. Anti-flicker perceptuell deadband (Weber-Fechner) ──
      // Ögat märker större relativ förändring vid låg ljusstyrka, mindre vid hög.
      // deadbandPct skalas: ~0.5×base vid pct=0, ~1.5×base vid pct=100.
      // Om |pct - lastSentPct| under tröskeln → behåll lastSentPct (eliminerar mikrojitter).
      // Stale-write-mekanismen i protocol.ts håller fortfarande BLE-länken vid liv.
      if (this.lastSentPct >= 0 && cal.flickerDeadband > 0) {
        const deadbandPct = cal.flickerDeadband * 100 * (1.6 - 1.4 * (pct / 100));
        if (Math.abs(pct - this.lastSentPct) < deadbandPct) {
          pct = this.lastSentPct;
          bleStatsState.deadbandBlockedCount++;
        }
      }
      this.lastSentPct = pct;

      // ── Color fade-tween (mjuk övergång till nytt palette-mål) ──
      // Läs alltid palette[0] löpande som mål — så att sena palette-uppdateringar
      // från gateway syns direkt utan att kräva setPalette-call varje gång.
      if (this._paletteVersion !== this._lastSeenPaletteVersion && this._palette.length > 0) {
        const p0 = this._palette[0];
        this.colorTarget[0] = p0[0];
        this.colorTarget[1] = p0[1];
        this.colorTarget[2] = p0[2];
        this._lastSeenPaletteVersion = this._paletteVersion;
      }
      // Time-based fade: använd faktisk elapsed sedan förra tick istället för
      // precomputed alpha (som antog exakt tickMs-intervall). Skyddar mot
      // jitter (sen FFT-frame, GC-paus) som annars hade gett ojämn fade-takt.
      const _prevFadeAt = this._lastTickAtForFade || _tickStart;
      const k = this.colorFadeMs > 0
        ? Math.min(1, (_tickStart - _prevFadeAt) / this.colorFadeMs)
        : 1;
      this._lastTickAtForFade = _tickStart;
      if (k < 1) {
        const c = this.color; const t = this.colorTarget;
        c[0] += (t[0] - c[0]) * k;
        c[1] += (t[1] - c[1]) * k;
        c[2] += (t[2] - c[2]) * k;
      } else {
        this.color[0] = this.colorTarget[0];
        this.color[1] = this.colorTarget[1];
        this.color[2] = this.colorTarget[2];
      }

      // ── Color calibration ──
      // Drop-flash: medan dropFlashUntil är aktiv forceras full vit punch (pct=100)
      // som overridar normal output, sen decay tillbaka till grund nästa tick.
      const dropFlash = this.dropFlashUntil > _tickStart;
      if (dropFlash) {
        pct = 100;
        this.lastSentPct = 100; // bypassa deadband så blixten alltid skickas
      }
      // Drop längre ger max brightness men behåller palette-färg — bara
      // punchWhiteThreshold (peak-detektorn) tvingar vit.
      const isPunch = (cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold);

      // ── FÄRG-TILT på spektralbalans (helt oberoende av brightness) ──
      // bas-tung mix → varmare (rött upp, blått ner), diskant-tung → svalare.
      const tilt = cal.colorSpectralTilt;
      let cr = this.color[0], cg = this.color[1], cb = this.color[2];
      if (tilt > 0 && !inSilence) {
        // -1 (helt diskant) .. +1 (helt bas)
        const balance = (bands.bassShare ?? 0.5) * 2 - 1;
        const warm = 1 + balance * tilt;
        const cool = 1 - balance * tilt;
        cr = Math.min(255, cr * warm);
        cb = Math.min(255, cb * cool);
      }
      applyColorCalibrationFast(cr, cg, cb, tc);


      // ── BLE output (asynkron 1-slot delivery) ──
      // sendToBLE returnerar direkt efter enqueue. Writern levererar senaste
      // frame när BLE kan; busy leverans får aldrig stoppa tick/beat/smoothing.
      const writeResult: WriteResult = isPunch
        ? sendToBLE(255, 255, 255, pct)
        : sendToBLE(_finalColor[0], _finalColor[1], _finalColor[2], pct);
      switch (writeResult) {
        case 'sent':         bleStatsState.tickOkCount++; break;
        case 'no-device':    bleStatsState.tickAbortNoDeviceCount++; break;
      }

      // ── Frame-tap: rapportera queued färg+brightness till observer ──
      if (this._frameTap && writeResult === 'sent') {
        if (isPunch) this._frameTap(pct, 255, 255, 255);
        else this._frameTap(pct, _finalColor[0], _finalColor[1], _finalColor[2]);
      }

      // ── Diagnostics ──
      _diag.rawRms = bands.totalRms;
      _diag.bassRms = bands.bassRms;
      _diag.midHiRms = bands.midHiRms;
      _diag.level = level;
      _diag.ampEnv = ampEnv;
      _diag.shape = shapeSm;
      _diag.energyForm = energyForm;

      _diag.onsetBoost = this.onsetBoost;
      _diag.brightnessPct = pct;
      _diag.bleScaleRaw = pct / 100;
      _diag.finalR = isPunch ? 255 : _finalColor[0];
      _diag.finalG = isPunch ? 255 : _finalColor[1];
      _diag.finalB = isPunch ? 255 : _finalColor[2];
      _diag.tickCount++;
      _diag.lastTickUs = ((performance.now() - _tickStart) * 1000 + 0.5) | 0;
      _diag.inSilence = inSilence;
      if (inSilence) _diag.tickSilenceCount++;

      // ── Emit ──
      const td = _tickData;
      td.brightness = pct;
      td.color[0] = _finalColor[0]; td.color[1] = _finalColor[1]; td.color[2] = _finalColor[2];
      td.bassLevel = bands.bassRms;
      td.midHiLevel = bands.midHiRms;
      td.isPlaying = this.playing;
      td.tickMs = this.tickMs;
      
      const cbs = this.callbacks;
      for (let i = 0, len = cbs.length; i < len; i++) cbs[i](td);

    } catch (e) {
      console.error('[Engine] tick error (recovering):', e);
      this.sanitizeState();
    }
  }
}
