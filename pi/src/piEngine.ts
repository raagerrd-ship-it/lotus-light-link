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
 * The tickMs setting controls minimum interval between ticks,
 * NOT a polling rate. Faster tickMs = more responsive, more CPU.
 */

import { getLatestBands, resetFluxState, onFFTReady, onFluxReady, setTickHopMs, setMicSmoothing, stopMic } from './alsaMic.js';
import { sendToBLE, canWriteNow, setIdleColor, getDimmingGamma, setSlotLeaseMs, startKeepAlive, stopKeepAlive } from './ble/protocol.js';
import type { WriteResult } from './ble/protocol.js';
import { bleStats as bleStatsState } from './ble/state.js';
import { triggerIdleDisconnect } from './ble/connect-hardcoded.js';
import { isControllerDrainAttached, getOutstandingPackets } from './ble/controllerDrain.js';
import { getItem, setItem } from './storage.js';
import { dlog } from "./debugLog.js";

// ── Inline engine math (avoid complex path aliasing to browser engine) ──

// AGC borttaget 2026-04-20: Sonos-volym → mic-gain-kalibrering (auto-gain)
// hanterar nu nivåskalningen. Ingen behov av en till normaliseringsloop.
// Bands från ALSA är redan rätt-skalade när de når engine.

const RAW_SCALE = 5; // Fast skalning från RMS (~0–0.2 normalt) till 0–1-domän
export function normalizeFixed(value: number): number {
  const n = value * RAW_SCALE;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}


// --- Precomputed tick constants ---
export interface TickConstants {
  attackAlpha: number;
  releaseAlpha: number;
  onsetDecay: number;
  onsetRiseAlpha: number;
  onsetRiseAlphaFft: number;
  onsetDecayFft: number;
  centerAlpha: number;
  centerAlphaFft: number;
  gammaIsUnity: boolean;
  dimmingGamma: number;
  brightnessFloor: number;
  transientGain: number;
  perceptualGamma: number;
  dynamicsEnabled: boolean;
  lutR: Uint8Array;
  lutG: Uint8Array;
  lutB: Uint8Array;
}

export function computeTickConstants(tickMs: number, cal: LightCalibration): TickConstants {
  const ratio = tickMs / 125;
  const secRatio = tickMs / 1000;
  const fftMs = 10; // HOP_SIZE=480 @ 48kHz → 100Hz FFT-takt
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
    attackAlpha: 1 - Math.pow(1 - cal.attackAlpha, ratio),
    releaseAlpha: 1 - Math.pow(1 - cal.releaseAlpha, ratio),
    // Snabbare decay → kortare, skarpare puls (matchar trum-attack ~80ms)
    onsetDecay: Math.pow(0.04, secRatio),
    onsetRiseAlpha: 1 - Math.pow(0.05, ratio), // snabbare attack på pulsen
    onsetRiseAlphaFft: 1 - Math.pow(0.05, fftRatio),
    onsetDecayFft: Math.pow(0.04, fftSecRatio),
    centerAlpha: 1 - Math.pow(1 - 0.002, ratio),
    centerAlphaFft: 1 - Math.pow(1 - 0.002, fftRatio),
    gammaIsUnity,
    dimmingGamma: getDimmingGamma(),
    brightnessFloor: cal.brightnessFloor ?? 0,
    transientGain: cal.transientGain ?? 1.0,
    perceptualGamma: cal.perceptualGamma ?? 0,
    dynamicsEnabled: cal.dynamicsEnabled !== false,
    lutR,
    lutG,
    lutB,
  };
}

// --- Dynamics (zero-alloc, no Math.pow/Math.sign) ---
export function applyDynamics(energyNorm: number, center: number, dynamicDamping: number): number {
  let result = energyNorm;
  if (dynamicDamping > 0) {
    const amount = dynamicDamping < 2 ? dynamicDamping * 0.5 : 1;
    const exponent = 1 / (1 + amount * 4);
    const range = result >= center ? (1 - center) || 0.5 : center || 0.5;
    const normalized = (result - center) / range;
    // Fast pow approximation: exp(exponent * ln(|x|)) via Math.exp/Math.log
    const absN = normalized < 0 ? -normalized : normalized;
    const powered = absN > 0.0001 ? Math.exp(exponent * Math.log(absN)) : 0;
    const expanded = normalized < 0 ? -powered : powered;
    const gain = 1 + amount * 0.5;
    result = center + expanded * range * gain;
    const ceiling = 1 + amount * 0.4;
    if (result > ceiling) result = ceiling + (result - ceiling) * 0.2;
  } else if (dynamicDamping < 0) {
    const absDamp = -dynamicDamping;
    const amount = absDamp < 3 ? absDamp / 3 : 1;
    const compression = 1 / (1 + amount * 4);
    result = center + (result - center) * compression;
  }
  return result < 0 ? 0 : result;
}

// --- Calibration ---

export interface LightCalibration {
  gammaR: number; gammaG: number; gammaB: number;
  offsetR: number; offsetG: number; offsetB: number;
  attackAlpha: number; releaseAlpha: number;
  dynamicDamping: number; bassWeight: number;
  punchWhiteThreshold: number;
  brightnessFloor: number;
  /** 0 = av (ingen boost), 1.0 = nuvarande default, upp till ~2.0 = överdrivna transienter */
  transientGain: number;
  /** 0 = av (linjärt, kurvan hoppas helt över), 1.0 = linjärt via math, 1.8 = tidigare default, upp till 3.0 = kraftig mörkkomprimering */
  perceptualGamma: number;
  dynamicsEnabled: boolean;
  /** Onset-tröskel: flux > median * onsetThreshold + 0.008 (1.3 = känslig, 2.5 = strikt). UI-default 1.8. */
  onsetThreshold: number;
  /** Minsta gap mellan onsets i ms — räknas om till frames @ 100Hz FFT-takt. UI-default 110ms. */
  onsetRefractoryMs: number;
  /** Anti-fladder: deadband i normaliserad enhet (0–0.08). Output ändras inte om |Δ| under detta. Skalas perceptuellt med nivå. */
  flickerDeadband: number;
  /** Absolut energy-gate (totalRms) under vilken onset-detektorn inte processar.
   *  Förhindrar att den adaptiva tröskeln skalar ner till brus och flashar i tysta partier.
   *  0 = av, 0.05 = default, 0.20 = bara stark musik räknas. */
  onsetEnergyFloor: number;
  /** Tystnads-gate i tickInner. När bands.totalRms < tickEnergyFloor behandlas
   *  input som rumsbrus: energyNorm forceras till 0 via release, fluxBoost
   *  blockeras, onsetBoost bleed:as. brightnessFloor håller lampan dim solid.
   *  0 = av, 0.05 = default. */
  tickEnergyFloor: number;
  /** Beat-källa för onset: 'bass' = endast kick/bas (<150Hz), 'full' = hela spektrumet. Default 'bass'. */
  beatSource: 'bass' | 'full';
  /** Drop-detektor på/av. Default true. */
  dropEnabled: boolean;
  /** Drop-känslighet 0.5–3.0 (lägre = lättare att trigga). Default 1.0. */
  dropSensitivity: number;
  /** Varaktighet (ms) för den vita drop-blixten. Default 220. */
  dropFlashMs: number;
  [key: string]: any;
}

const DEFAULT_CAL: LightCalibration = {
  gammaR: 1.0, gammaG: 1.0, gammaB: 1.0,
  offsetR: 0, offsetG: 0, offsetB: 0,
  attackAlpha: 1.0, releaseAlpha: 0.15, dynamicDamping: 0.8,
  bassWeight: 0.9,
  punchWhiteThreshold: 100,
  brightnessFloor: 5,
  transientGain: 0.8,
  perceptualGamma: 0,
  dynamicsEnabled: true,
  onsetThreshold: 1.8,
  onsetRefractoryMs: 200,
  flickerDeadband: 0.02,
  onsetEnergyFloor: 0.01,
  tickEnergyFloor: 0.01,
  beatSource: 'bass',
  dropEnabled: true,
  dropSensitivity: 1.0,
  dropFlashMs: 220,
};

/** Migrera gamla boolean-fält från sparade inställningar till de nya numeriska */
function migrateLegacyCalibration(cal: any): any {
  if (!cal || typeof cal !== 'object') return cal;
  const out = { ...cal };
  // transientBoost: true → 1.0, false → 0
  if (typeof out.transientBoost === 'boolean' && out.transientGain == null) {
    out.transientGain = out.transientBoost ? 1.0 : 0;
  }
  delete out.transientBoost;
  // perceptualCurve: true → 1.8 (tidigare hårdkodad gamma), false → 0
  if (typeof out.perceptualCurve === 'boolean' && out.perceptualGamma == null) {
    out.perceptualGamma = out.perceptualCurve ? 1.8 : 0;
  }
  delete out.perceptualCurve;
  // Inga värde-migreringar — slider-inställningar respekteras alltid.
  // (Tidigare clampades flickerDeadband>0 → 0, brightnessFloor≥15 → 5,
  //  onsetEnergyFloor≥0.04 → 0.01, tickEnergyFloor≥0.04 → 0.01 vid varje
  //  load, vilket skrev över medvetna user-värden. Borttaget 2026-05-05.)
  return out;
}

function loadCalibration(): LightCalibration {
  try {
    const raw = getItem('light-calibration');
    if (raw) {
      const parsed = migrateLegacyCalibration(JSON.parse(raw));
      return { ...DEFAULT_CAL, ...parsed };
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
  bassNorm: number;      // bassRms * RAW_SCALE, clamped 0-1
  midHiNorm: number;     // midHiRms * RAW_SCALE, clamped 0-1
  preDynamics: number;   // energyNorm BEFORE dynamics expansion
  energyNorm: number;    // after dynamics
  dynamicCenter: number;
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
  preDynamics: 0, energyNorm: 0, dynamicCenter: 0, onsetBoost: 0,
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

  private dynamicCenter = 0.5;
  private smoothed = 0;  // EMA-state för release-smoothing @ tick-takt
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
  // Refractory period — minimum gap between onsets, räknat i FFT-frames @ 100Hz
  private onsetFrameCounter = 0;
  private onsetLastFrameIdx = -1000;
  // Refractory räknas dynamiskt från cal.onsetRefractoryMs (FFT @ 100Hz → 10ms/frame)

  // ── Drop-detektor (lång tidshorisont, @100Hz på bas-energi) ──
  // Drops är en struktur över sekunder: breakdown/uppbyggnad → plötslig bas-explosion.
  private bassFast = 0;          // EMA ~150ms — aktuell bas-nivå
  private bassSlow = 0;          // EMA ~2.5s — baslinje
  private breakdownFrames = 0;   // antal frames bassFast legat lågt (i förhållande till baslinjen)
  private dropFrameCounter = 0;   // räknar varje processDrop-anrop (@100Hz)
  private dropLastFrameIdx = -100000; // refractory-räknare (frames @100Hz)
  private dropFlashUntil = 0;    // performance.now()-tidsstämpel då vit blixt slutar

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
  // Dirty-flag for calibration save — avoids unnecessary disk writes
  private _calDirty = false;

  // ── Record / Playback (lärda ljus-sekvenser) ──
  // Frame-tap: anropas i reaktiv tickInner med den färg+brightness som FAKTISKT
  // skickades till BLE. lightRecorder prenumererar och buffrar nedsamplat.
  private _frameTap: ((pct: number, r: number, g: number, b: number) => void) | null = null;
  // Analys-tap: anropas per FFT-frame (~100Hz) med RÅ band/flux FÖRE ljus-estetik.
  // lightRecorder buffrar detta som oförvrängd käll-ström för offline-render.
  private _analysisTap: ((bassRms: number, midHiRms: number, totalRms: number, flux: number) => void) | null = null;
  // Playback-state: när aktiv hoppar tickInner över den reaktiva pathen och
  // spelar upp en inspelad sekvens synkad mot Sonos-position.
  private _pbActive = false;
  private _pbTimes: Float64Array = new Float64Array(0);
  private _pbPct: Uint8Array = new Uint8Array(0);
  private _pbR: Uint8Array = new Uint8Array(0);
  private _pbG: Uint8Array = new Uint8Array(0);
  private _pbB: Uint8Array = new Uint8Array(0);
  private _pbCount = 0;
  // Frame-stegnings-cursor: senast skickade index. Stegar framåt en frame i taget
  // så VARJE lagrad frame skickas till BLE (ingen position-sampling som hoppar).
  private _pbCursor = -1;
  private _pbAnchorPosMs = 0;
  private _pbAnchorClock = 0;
  /** Manuell/auto sync-offset (ms): positivt = ljuset ligger FÖRE ljudet. */
  private _pbSyncMs = 0;
  /** Legacy lead-offset för äldre motor-auto-sync. Offline-playback använder i
   *  praktiken lightRecorder:s _pbSyncMs så stale persisted lead inte dubblar
   *  offseten. */
  private _pbLeadMs = (() => {
    const v = parseInt(getItem('playback-lead-ms') ?? '', 10);
    return Number.isFinite(v) ? v : 0;
  })();

  // ── Auto-sync ──
  // Mäter Sonos högtalar-latens automatiskt genom att korskorrelera live-mic-
  // energin mot RÅ-inspelningens pct-kurva (samma mic-pipeline → bäst matchning)
  // och glider _pbLeadMs mot bästa lag.
  private _autoSync = (getItem('playback-autosync') ?? 'true') !== 'false';
  private static readonly AS_N = 160;            // ~3.2 s historik @ 50 Hz
  private _asPos = new Float64Array(PiLightEngine.AS_N);  // Sonos-pos (utan lead)
  private _asEng = new Float64Array(PiLightEngine.AS_N);  // live mic-energi-proxy
  private _asCount = 0;
  private _asHead = 0;
  private _asLastEvalClock = 0;
  private _asPersistedLead = 0;
  private _asConfidence = 0;
  // RÅ-referens för korrelation (kan saknas → fall tillbaka till uppspelnings-pct).
  private _pbRefTimes: Float64Array = new Float64Array(0);
  private _pbRefPct: Uint8Array = new Uint8Array(0);
  private _pbRefCount = 0;
  // Warm-up: kör reaktivt (live mic) tills auto-sync låst, byt sen till uppspelning.
  private _pbWarmup = false;
  private _asLockStreak = 0;

  constructor(tickMs = 20) {
    this.tickMs = tickMs;
    this.cal = loadCalibration();
    this.onsetBuffer = new Float64Array(7);
    this.onsetSorted = new Float64Array(7);
    this.initOnsetBuffer(tickMs);
    this.tc = computeTickConstants(tickMs, this.cal);
    setTickHopMs(tickMs);
    setSlotLeaseMs(5); // floor: släpp fram alla frames ACL-gaten tillåter (user: skicka allt som inte är identiskt → backpressure ska komma från controller, inte cadence-cap)
    setMicSmoothing(this.cal.attackAlpha, this.cal.releaseAlpha);
  }

  getPalette(): [number, number, number][] { return this._palette; }
  setVolume(vol: number | undefined) { this.volume = vol; }
  getTickMs(): number { return this.tickMs; }

  setTickMs(ms: number) {
    this.tickMs = ms;
    this.initOnsetBuffer(ms);
    this.tc = computeTickConstants(ms, this.cal);
    setTickHopMs(ms);
    setSlotLeaseMs(5); // floor — se constructor
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

  isPlaybackActive(): boolean { return this._pbActive; }

  /** Läs/sätt lead-offset (ms) för inspelad uppspelning. Persistas. */
  getPlaybackLeadMs(): number { return this._pbLeadMs; }
  setPlaybackLeadMs(ms: number): void {
    this._pbLeadMs = Math.round(ms);
    this._asPersistedLead = this._pbLeadMs;
    setItem('playback-lead-ms', String(this._pbLeadMs));
  }

  /** Auto-sync på/av + status (uppmätt lead och korrelations-styrka). */
  isAutoSync(): boolean { return this._autoSync; }
  setAutoSync(on: boolean): void {
    this._autoSync = on;
    setItem('playback-autosync', String(on));
    if (on) { this._asCount = 0; this._asHead = 0; }
  }
  getAutoSyncStatus(): { enabled: boolean; leadMs: number; confidence: number; warmup: boolean } {
    return {
      enabled: this._autoSync,
      leadMs: this._pbLeadMs,
      confidence: Math.round(this._asConfidence * 100) / 100,
      warmup: this._pbWarmup,
    };
  }

  /** Aktivera playback av en inspelad sekvens.
   *  frames = uppspelnings-sekvensen (polerad). rawRef = rå-inspelning som
   *  korrelations-referens. warmup = kör reaktivt tills auto-sync låst.
   *  null = reaktiv mode. */
  setPlaybackSequence(_frames: number[][] | null, _rawRef: number[][] | null = null, _warmup = true): void {
    // Offline-playback borttaget (2026-06-02): allt körs reaktivt/realtime.
    // Behålls som no-op så ev. äldre anropare inte kraschar.
    this._pbActive = false;
    this._pbWarmup = false;
    this._pbCount = 0;
    this._pbRefCount = 0;
  }

  /** Ankra playback-position mot Sonos positionMs (interpoleras lokalt). */
  updatePlaybackPosition(positionMs: number): void {
    this._pbAnchorPosMs = positionMs;
    this._pbAnchorClock = performance.now();
    this._pbCursor = -1; // seek/re-ankring → snappa cursorn till nya positionen
  }

  /** Sätt sync-offset (ms): positivt = ljuset ligger före ljudet. */
  setPlaybackSyncMs(ms: number): void { this._pbSyncMs = Number.isFinite(ms) ? ms : 0; }

  /** Hitta index i en sekvens vars tMs ≤ posMs (närmast föregående). */
  private indexForPosIn(times: Float64Array, count: number, posMs: number): number {
    const hiIdx = count - 1;
    if (hiIdx < 0) return 0;
    if (posMs <= times[0]) return 0;
    if (posMs >= times[hiIdx]) return hiIdx;
    let lo = 0, hi = hiIdx, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= posMs) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx;
  }

  /** Index i uppspelnings-sekvensen (det som faktiskt skickas till BLE). */
  private indexForPos(posMs: number): number {
    return this.indexForPosIn(this._pbTimes, this._pbCount, posMs);
  }

  /** Live mic-energi-proxy [0..1] (samma mix som reaktiva pipen, pre-dynamics). */
  private liveEnergyProxy(): number {
    const bands = getLatestBands();
    if (!bands || !Number.isFinite(bands.totalRms)) return -1;
    const w = this.cal.bassWeight;
    return normalizeFixed(bands.bassRms) * w + normalizeFixed(bands.midHiRms) * (1 - w);
  }

  /** Samla ett auto-sync-sampel och utvärdera periodvis. */
  private autoSyncSample(rawPos: number): void {
    const eng = this.liveEnergyProxy();
    if (eng < 0) return;
    const cap = PiLightEngine.AS_N;
    this._asPos[this._asHead] = rawPos;
    this._asEng[this._asHead] = eng;
    this._asHead = (this._asHead + 1) % cap;
    if (this._asCount < cap) this._asCount++;
    const now = performance.now();
    if (now - this._asLastEvalClock >= 750 && this._asCount >= cap * 0.8) {
      this._asLastEvalClock = now;
      this.autoSyncEval();
    }
  }

  /** Korskorrelera live-energi mot RÅ-referensens pct över kandidat-latenser och
   *  glid _pbLeadMs mot bästa lag. D = högtalar-latens (ms) → lead = -D.
   *  Under warm-up: lås upp uppspelning först när korrelationen håller i sig. */
  private autoSyncEval(): void {
    const cap = PiLightEngine.AS_N, n = this._asCount;
    const refT = this._pbRefCount ? this._pbRefTimes : this._pbTimes;
    const refP = this._pbRefCount ? this._pbRefPct : this._pbPct;
    const refN = this._pbRefCount || this._pbCount;
    let bestD = 0, bestCorr = -2;
    for (let D = -500; D <= 500; D += 25) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let k = 0; k < n; k++) {
        const i = (this._asHead - 1 - k + cap * 2) % cap;
        const e = this._asEng[i];
        const p = refP[this.indexForPosIn(refT, refN, this._asPos[i] - D)] / 100;
        sx += e; sy += p; sxx += e * e; syy += p * p; sxy += e * p;
      }
      const cov = sxy - (sx * sy) / n;
      const vx = sxx - (sx * sx) / n;
      const vy = syy - (sy * sy) / n;
      const denom = Math.sqrt(vx * vy);
      const corr = denom > 1e-9 ? cov / denom : 0;
      if (corr > bestCorr) { bestCorr = corr; bestD = D; }
    }
    this._asConfidence = bestCorr;
    if (bestCorr < 0.35) { this._asLockStreak = 0; return; } // svag korrelation → behåll
    const targetLead = -bestD;
    if (this._pbWarmup) {
      // Hoppa direkt till uppmätt lag (ingen EMA-trög uppstart) och lås efter
      // två stabila mätningar i rad, byt sen från reaktivt → uppspelning.
      this._pbLeadMs = Math.max(-2000, Math.min(2000, targetLead));
      if (++this._asLockStreak >= 2) this._pbWarmup = false;
    } else {
      this._pbLeadMs = Math.max(-2000, Math.min(2000, Math.round(this._pbLeadMs + 0.3 * (targetLead - this._pbLeadMs))));
    }
    // SD-skonsam persistering: spara bara vid märkbar drift.
    if (Math.abs(this._pbLeadMs - this._asPersistedLead) >= 15) {
      this._asPersistedLead = this._pbLeadMs;
      setItem('playback-lead-ms', String(this._pbLeadMs));
    }
  }

  /** Spela upp sekvensen positionslåst mot Sonos-klockan.
   *  Viktigt: skicka aktuell frame direkt, inte "catch-up" genom gamla frames.
   *  Annars hamnar offline-ljuset efter vid BLE-busy/missade ticks och känns
   *  både ryckigt och ur synk. */
  private playbackTick(): void {
    const rawPos = this._pbAnchorPosMs + (performance.now() - this._pbAnchorClock);
    // Kontinuerlig engine-auto-sync är avsiktligt inte aktiv här. Offline-sync
    // ägs av lightRecorder (kort mic↔råsekvens-mätning före playback) och
    // appliceras via _pbSyncMs. Att samtidigt glida _pbLeadMs under playback kan
    // låsa på grannbeats och skapa drift.
    const target = this.indexForPos(rawPos + this._pbSyncMs);
    const idx = target;
    this._pbCursor = idx;

    const pct = this._pbPct[idx];
    const result = sendToBLE(this._pbR[idx], this._pbG[idx], this._pbB[idx], pct);
    if (result === 'sent') bleStatsState.tickOkCount++;
    this.lastSentPct = pct;
  }

  private initOnsetBuffer(tickMs: number): void {
    this.onsetSize = Math.max(3, ((175 / tickMs + 0.5) | 0));
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
  }

  /** Zero-alloc onset detection using precomputed constants.
   *  Triggers a strong, short pulse on each detected transient (kick/snare),
   *  with refractory period to avoid flutter on sustained loud passages. */
  private processOnset(flux: number): void {
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
    // Adaptiv suppression: när dynamicCenter > 0.5 (loud sustain) höj tröskeln upp till +75%.
    // Förhindrar att flux-jitter på "fulla" mixar lägger pulser ovanpå redan hög nivå.
    const dc = this.dynamicCenter;
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


    // Refractory gate: minimum gap mellan onsets, räknat i FFT-frames @ 100Hz (10ms/frame)
    const refractoryFrames = Math.max(1, Math.round(this.cal.onsetRefractoryMs / 10));
    this.onsetFrameCounter++;
    if (isCandidate && (this.onsetFrameCounter - this.onsetLastFrameIdx) >= refractoryFrames) {
      this.onsetTarget = 0.45; // strong pulse — clearly visible "in the beat"
      this.onsetLastFrameIdx = this.onsetFrameCounter;

      // ── Express path (2026-04-29): sub-frame BLE write på confirmed onset ──
      // Onset just bekräftad. Skicka aktuell färg + boostad brightness DIREKT
      // till BLE så lampan ser kicken på FFT-takt (~13ms total latens) i
      // stället för att vänta upp till tickMs på nästa tickInner.
      // Refractory-gaten ovan garanterar ≤1 express-write per onset → bounded.
      // Dependency: ACL-outstanding-gate (acl_max_pkt - margin) måste vara
      // aktiv i protocol.ts — annars riskerar express + tickInner att fylla
      // HCI-bufferten i samma tick-fönster.
      if (this._bleOwner === 'active' && this.lastSentPct >= 0) {
        const transientGain = this.cal.transientGain ?? 1.0;
        const boostPct = ((0.45 * transientGain * 100) | 0);
        const expressPct = Math.min(100, this.lastSentPct + boostPct);
        const result = sendToBLE(_finalColor[0], _finalColor[1], _finalColor[2], expressPct);
        if (result === 'sent') {
          // Uppdatera lastSentPct så tickInner-deadband inte sväljer den
          // naturliga down-stroke-droppen på nästa tick.
          this.lastSentPct = expressPct;
          bleStatsState.onsetExpressCount++;
        } else if (result === 'busy') {
          bleStatsState.onsetExpressBusyCount++;
        }
      }
    }

    // Fast rise using precomputed alpha, smooth decay using precomputed decay
    if (this.onsetBoost < this.onsetTarget) {
      this.onsetBoost += tc.onsetRiseAlphaFft * (this.onsetTarget - this.onsetBoost);
    } else {
      this.onsetBoost *= tc.onsetDecayFft;
    }
    this.onsetTarget *= tc.onsetDecayFft;

    if (this.onsetBoost < 0.001) { this.onsetBoost = 0; this.onsetTarget = 0; }
  }

  /**
   * Drop-detektor @100Hz på bas-energi. Drops är en lång-horisont-struktur:
   * breakdown/uppbyggnad (lugnt parti) → plötslig bas-explosion. Skiljer sig
   * från onset (70ms-transient) genom att kräva ett föregående nedbrutet parti.
   * Triggar en stor vit punch-blixt (dropFlashUntil) som overridas i tickInner.
   */
  private processDrop(bassRms: number): void {
    if (!this.cal.dropEnabled) return;
    this.dropFrameCounter++;

    // Tidsbaserade EMA:er @100Hz (dt=10ms): fast ~150ms, slow ~2.5s.
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

    // Spåra/erodera breakdown-minnet.
    if (this.bassFast < this.bassSlow * BREAKDOWN_RATIO) {
      if (this.breakdownFrames < 1000) this.breakdownFrames++;
    } else if (this.breakdownFrames > 0) {
      this.breakdownFrames -= 2; // erodera över ~1s när det blir högt igen
      if (this.breakdownFrames < 0) this.breakdownFrames = 0;
    }

    const isDrop =
      this.breakdownFrames >= MIN_BREAKDOWN_FRAMES &&
      this.bassFast >= ABS_BASS_FLOOR &&
      this.bassFast >= this.bassSlow * JUMP_FACTOR &&
      (this.dropFrameCounter - this.dropLastFrameIdx) >= REFRACTORY_FRAMES;

    if (isDrop) {
      this.dropLastFrameIdx = this.dropFrameCounter;
      this.breakdownFrames = 0;
      this.dropFlashUntil = performance.now() + (this.cal.dropFlashMs ?? 220);
      bleStatsState.dropCount++;
      // Express-write: skicka full vit punch direkt så blixten sitter i takt.
      if (this._bleOwner === 'active' && canWriteNow()) {
        const result = sendToBLE(255, 255, 255, 100);
        if (result === 'sent') this.lastSentPct = 100;
      }
    }
  }


  private forceIdleNow(): void {
    const idle = loadIdleColor();
    const r = idle[0] | 0, g = idle[1] | 0, b = idle[2] | 0;
    setIdleColor(r, g, b);
    // Reflektera idle-färgen i diagnostics så /api/ble/output visar rätt
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

    // 2. Vänta tills HCI-kön är tom så paketet faktiskt går iväg (max 500ms).
    const deadline = Date.now() + 500;
    while (isControllerDrainAttached() && getOutstandingPackets() > 0) {
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
      this._pbActive = false;  // playback hör till en spelande låt
      this._lastTickAtForFade = 0;
      this._lastSmoothAt = 0;
      this.stopLoop();
      if (this._bleOwner !== 'none') {
        this._bleOwner = 'idle';
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
    this._calDirty = true; // mark for next save cycle
    // Re-apply raw mode overrides if active
    if (this._rawMode) {
      this.cal.dynamicsEnabled = false;
      this.cal.transientGain = 0;
      this.cal.perceptualGamma = 0;
    }
    this.tc = computeTickConstants(this.tickMs, this.cal);
    setMicSmoothing(this.cal.attackAlpha, this.cal.releaseAlpha);
  }

  /**
   * Plugga in en profils kalibreringsvärden i pipelinen.
   * Skriver profilen till light-calibration-storage och kör reloadCalibration().
   * Så hela befintliga pipelinen (gain, bands, dynamics, gamma, punch, ...) följer
   * automatiskt aktiv profil utan att vi behöver duplicera fältmappning här.
   */
  setActiveProfile(profileCal: Partial<LightCalibration>): void {
    const current = loadCalibration();
    const merged = { ...current, ...profileCal };
    saveCalibration(merged);
    this.reloadCalibration();
  }

  /** Enable raw mode — disables all processors for gain calibration */
  setRawMode(on: boolean): void {
    if (on && !this._rawMode) {
      this._rawMode = true;
      this._savedCal = {
        dynamicsEnabled: this.cal.dynamicsEnabled,
        transientGain: this.cal.transientGain,
        perceptualGamma: this.cal.perceptualGamma,
      };
      this.cal.dynamicsEnabled = false;
      this.cal.transientGain = 0;
      this.cal.perceptualGamma = 0;
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
        const energyFloor = this.cal.onsetEnergyFloor ?? 0;
        const peakBand = bands ? Math.max(bands.bassRms, bands.midHiRms) : 0;
        const passesEnergyGate =
          energyFloor <= 0 ||
          (bands != null && Number.isFinite(peakBand) && peakBand >= energyFloor);
        if (passesEnergyGate) {
          // Kick/bas-only onset: använd bassFlux om beatSource='bass' (default),
          // annars full-spektrum-flux. Hi-hats/snare triggar då inte pulsen.
          const beatFlux = (this.cal.beatSource !== 'full' && bands)
            ? bands.bassFlux
            : flux;
          this.processOnset(beatFlux);
        }
        // Drop-detektor @100Hz på bas-energi (oberoende av onset/energy-gate).
        if (bands) this.processDrop(bands.bassRms);
        // Uppdatera dynamicCenter per FFT-frame (100Hz) istället för per tick
        // (50Hz) — center följer då 100% av musiken, inte varannan frame.
        if (this.tc.dynamicsEnabled && bands && Number.isFinite(bands.totalRms)) {
          const bN = normalizeFixed(bands.bassRms);
          const mN = normalizeFixed(bands.midHiRms);
          const raw = bN * 0.5 + mN * 0.5;
          this.dynamicCenter += this.tc.centerAlphaFft * (raw - this.dynamicCenter);
          if (this.dynamicCenter < 0.2) this.dynamicCenter = 0.2;
          else if (this.dynamicCenter > 0.7) this.dynamicCenter = 0.7;
        }
        // Analys-tap: rapportera RÅ band/flux (oförvrängd källa) @100Hz till recorder.
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
  // FFT fires ~93 times/sec (48000/512). Vi kör tickInner när tickMs har
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

    const now = performance.now();
    if (now >= this._nextTickDeadline) {
      // Grid-align: nästa deadline är tickMs efter den förra, inte efter now.
      this._nextTickDeadline += this.tickMs;
      if (now - this._nextTickDeadline > this.tickMs) {
        this._nextTickDeadline = now + this.tickMs;
      }

      // ── BLE-styrd pre-gate (2026-06-02) ──
      // BLE-out är den verkliga takt-styrningen. Om länken inte kan ta emot en
      // write just nu (lease-lock, pending write eller ACL-outstanding-tak) är
      // det meningslöst att räkna en hel tick (dynamics/gamma/fade/kalibrering)
      // — resultatet hade ändå dött som 'busy' i sendToBLE. Skippa FÖRE den
      // dyra beräkningen och spara CPU. Gäller bara under aktiv playback;
      // idle-pathen styrs av keep-alive, inte tickInner.
      if (this.playing && this._bleOwner === 'active' && !canWriteNow()) {
        bleStatsState.tickSkippedBleBusyCount++;
        return;
      }

      this._lastTickTime = now;
      this.tickInner();
    } else {
      // FFT kom för tidigt — släng den ur output-perspektiv. Nästa FFT
      // (~10.7ms senare) triggar tickInner direkt om tickMs då passerats.
      bleStatsState.fftDroppedCount++;
    }
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
    stopKeepAlive();
    onFFTReady(null); // unregister callback
    onFluxReady(null);
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    dlog('[Engine] Stopped');
  }

  /** Suspend engine output (for BLE tests etc.) — stops loop + keep-alive */
  suspend(): void {
    this.stopLoop();
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
    if (!Number.isFinite(this.dynamicCenter)) this.dynamicCenter = 0.5;
    if (!Number.isFinite(this.smoothed)) this.smoothed = 0;
    if (!Number.isFinite(this.onsetBoost)) { this.onsetBoost = 0; this.onsetTarget = 0; }
    if (!Number.isFinite(this.lastBrightness)) this.lastBrightness = 0;
    if (!Number.isFinite(this.lastSentPct)) this.lastSentPct = -1;
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
        tickEnergyFloor: this.cal.tickEnergyFloor ?? 0,
        onsetEnergyFloor: this.cal.onsetEnergyFloor ?? 0,
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

      // ── 1. Fast normalization (Sonos-vol-baserad mic-gain redan applicerad upstream) ──
      const bassNorm = normalizeFixed(bands.bassRms);
      const midHiNorm = normalizeFixed(bands.midHiRms);
      // (dynamicCenter spåras nu i onFluxReady @ 100Hz — inte här)

      // ── 3. Bas/Disk mix (asymmetrisk dämpning) ──
      // 0.5 = neutral (båda 100%). <0.5 dämpar bas, >0.5 dämpar disk. Sidan man drar mot stannar 100%.
      const w = cal.bassWeight;
      const bassGain  = w;       // monotonic crossfade: 0 = no bass, 1 = full bass
      const midHiGain = 1 - w;   // 0 = no treble, 1 = full treble
      let energyNorm = bassNorm * bassGain + midHiNorm * midHiGain;

      // ── 3.5. Tystnads-gate (2026-05-04) ──
      // Spegelbild av onsetEnergyFloor som gatear express-onset i onFluxReady.
      // När absolut mic-energi < tickEnergyFloor är det rumsbrus, inte musik.
      // Forcera energyNorm=0 + använd release så smoothed glidar mjukt ner mot
      // brightnessFloor utan att attackAlpha=1.0 snappar upp på brus-spikar.
      const tickFloor = cal.tickEnergyFloor ?? 0;
      const peakBand = Math.max(bands.bassRms, bands.midHiRms);
      const inSilence = tickFloor > 0 && peakBand < tickFloor;
      if (inSilence) energyNorm = 0;

      // ── 4. Release smoothing (enda smoothing — alsaMic levererar rå RMS) ──
      // Körs på tick-takt (50Hz) så filtret är synkat mot output-raten och
      // undviker alias-hack mellan FFT-takt (100Hz) och tick-takt.
      // Adaptive "punch on drop" borttagen 2026-05-04 — punch hör till
      // attack-pathen (attackAlpha=1.0), inte release. Användarens
      // releaseAlpha (softness-slider) ska vara enda kontrollen för fade-out.
      // Tidsbaserad alpha (2026-06-02): BLE-pre-gaten gör att ticks nu kommer
      // med varierande intervall (hoppade frames när BLE är busy). En precomputed
      // per-tickMs-alpha skulle då ge ojämn fade-takt. Härled alpha ur FAKTISK
      // elapsed med samma 1-(1-base)^(elapsed/125)-formel som computeTickConstants,
      // så ljusbilden blir identisk oavsett hur många frames som hoppats över.
      const _smoothElapsed = this._lastSmoothAt > 0
        ? Math.min(250, _tickStart - this._lastSmoothAt)
        : this.tickMs;
      this._lastSmoothAt = _tickStart;
      const _eRatio = _smoothElapsed / 125;
      let alpha: number;
      if (inSilence) {
        // Tystnad: dra mot 0 via release oavsett brus-spikar
        alpha = 1 - Math.pow(1 - this.cal.releaseAlpha, _eRatio);
      } else if (energyNorm > this.smoothed) {
        alpha = 1 - Math.pow(1 - this.cal.attackAlpha, _eRatio);
      } else {
        alpha = 1 - Math.pow(1 - this.cal.releaseAlpha, _eRatio);
      }
      this.smoothed = this.smoothed + alpha * (energyNorm - this.smoothed);
      energyNorm = this.smoothed;

      const preDynamics = energyNorm;

      // ── 5. Dynamics expansion ──
      // (dynamicCenter uppdateras i onFluxReady @ 100Hz — se start())
      if (tc.dynamicsEnabled) {
        energyNorm = applyDynamics(energyNorm, this.dynamicCenter, cal.dynamicDamping);
      }

      // ── 6. Transient boost (0 = av, 1.0 = default, 2.0 = överdrivet) ──
      const transientGain = tc.transientGain;
      const fluxBoost = (transientGain > 0 && !inSilence) ? this.onsetBoost * transientGain : 0;
      energyNorm = energyNorm + fluxBoost;
      if (energyNorm > 1) energyNorm = 1;
      if (inSilence) {
        // Bleed onsetBoost-state så gammal flux inte väcker upp på nästa frame
        this.onsetBoost *= 0.5;
        if (this.onsetBoost < 0.001) { this.onsetBoost = 0; this.onsetTarget = 0; }
      }

      // ── 6b. (Slew-rate limiter borttagen 2026-04-26) ──
      // Anti-alias-bufferten i alsaMic (~30ms rolling average) + EMA i tickInner
      // sköter all smoothing av rå brus. Slew-en bromsade bara snabba kicks utan
      // att tillföra något efter att aliaseringen försvann från källan.
      // cal.maxRisePerSec / cal.maxFallPerSec finns kvar i typen för bakåt-
      // kompatibilitet med sparade profiler men har ingen runtime-effekt längre.

      // ── 7. Floor + Perceptual curve ──
      const floor = tc.brightnessFloor;
      let pct = energyNorm * 100;
      if (pct < floor) pct = floor;

      // perceptualGamma: 0 = av (hoppa över helt), ≥1.0 = kör kurvan med angivet exponent
      const pGamma = tc.perceptualGamma;
      if (pGamma > 0 && pct > floor && pct < 100) {
        const norm = (pct - floor) / (100 - floor);
        pct = floor + (norm > 0.0001 ? Math.exp(pGamma * Math.log(norm)) : 0) * (100 - floor);
      }

      // Fast round + clamp
      pct = (pct + 0.5) | 0;
      if (pct > 100) pct = 100;
      if (pct < floor) pct = floor;

      // Auto-tune sampler: registrera RÅ mic-RMS (innan smoothing/dynamics) så
      // analysen kan separera tysta partier (rumsbrus) från musik-nivå.
      if (this.autoTuneActive) this.recordAutoTuneSample(bands.totalRms);

      // Warm-up auto-sync: medan lamporna körs reaktivt mäter vi lag mot RÅ-
      // referensen. autoSyncEval låser upp uppspelningen när korrelationen håller.
      if (this._pbActive && this._pbWarmup && this._autoSync) {
        this.autoSyncSample(this._pbAnchorPosMs + (performance.now() - this._pbAnchorClock));
      }


      // ── 7b. Anti-flicker perceptuell deadband (Weber-Fechner) ──
      // Ögat märker större relativ förändring vid låg ljusstyrka, mindre vid hög.
      // deadbandPct skalas: ~0.5×base vid pct=0, ~1.5×base vid pct=100.
      // Om |pct - lastSentPct| under tröskeln → behåll lastSentPct (eliminerar mikrojitter).
      // Stale-write-mekanismen i protocol.ts håller fortfarande BLE-länken vid liv.
      if (this.lastSentPct >= 0 && cal.flickerDeadband > 0) {
        const deadbandPct = cal.flickerDeadband * 100 * (0.5 + (pct / 100));
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
      const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;
      applyColorCalibrationFast(this.color[0], this.color[1], this.color[2], tc);

      // ── BLE output (synkron hard-fail) ──
      // sendToBLE returnerar direkt med WriteResult — engine räknar utfallet
      // per tick istället för att blockera på writeAsync.
      const writeResult: WriteResult = isPunch
        ? sendToBLE(255, 255, 255, pct)
        : sendToBLE(_finalColor[0], _finalColor[1], _finalColor[2], pct);
      switch (writeResult) {
        case 'sent':         bleStatsState.tickOkCount++; break;
        case 'busy':         bleStatsState.tickAbortBleBusyCount++; break;
        case 'no-change':    bleStatsState.tickAbortNoChangeCount++; break;
        case 'no-device':    bleStatsState.tickAbortNoDeviceCount++; break;
      }

      // ── Frame-tap: rapportera faktiskt skickad färg+brightness till recorder ──
      if (this._frameTap && writeResult === 'sent') {
        if (isPunch) this._frameTap(pct, 255, 255, 255);
        else this._frameTap(pct, _finalColor[0], _finalColor[1], _finalColor[2]);
      }

      // ── Diagnostics ──
      _diag.rawRms = bands.totalRms;
      _diag.bassRms = bands.bassRms;
      _diag.midHiRms = bands.midHiRms;
      _diag.bassNorm = bassNorm;
      _diag.midHiNorm = midHiNorm;
      _diag.preDynamics = preDynamics;
      _diag.energyNorm = energyNorm;
      _diag.dynamicCenter = this.dynamicCenter;
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
