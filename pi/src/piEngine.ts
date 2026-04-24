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

import { getLatestBands, resetFluxState, onFFTReady, onFluxReady, setTickHopMs, setMicSmoothing } from './alsaMic.js';
import { sendToBLE, setIdleColor, getDimmingGamma, setSlotLeaseMs, startKeepAlive, stopKeepAlive } from './ble/protocol.js';
import type { WriteResult } from './ble/protocol.js';
import { bleStats as bleStatsState } from './ble/state.js';
import { getItem, setItem } from './storage.js';

// ── Inline engine math (avoid complex path aliasing to browser engine) ──

// AGC borttaget 2026-04-20: Sonos-volym → mic-gain-kalibrering (auto-gain)
// hanterar nu nivåskalningen. Ingen behov av en till normaliseringsloop.
// Bands från ALSA är redan rätt-skalade när de når engine.

const RAW_SCALE = 5; // Fast skalning från RMS (~0–0.2 normalt) till 0–1-domän
function normalizeFixed(value: number): number {
  const n = value * RAW_SCALE;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}


// --- Precomputed tick constants ---
interface TickConstants {
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
}

function computeTickConstants(tickMs: number, cal: LightCalibration): TickConstants {
  const ratio = tickMs / 125;
  const secRatio = tickMs / 1000;
  const fftMs = 10; // HOP_SIZE=480 @ 48kHz → 100Hz FFT-takt
  const fftRatio = fftMs / 125;
  const fftSecRatio = fftMs / 1000;


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
    gammaIsUnity: cal.gammaR === 1.0 && cal.gammaG === 1.0 && cal.gammaB === 1.0,
    dimmingGamma: getDimmingGamma(),
    brightnessFloor: cal.brightnessFloor ?? 0,
    transientGain: cal.transientGain ?? 1.0,
    perceptualGamma: cal.perceptualGamma ?? 0,
    dynamicsEnabled: cal.dynamicsEnabled !== false,
  };
}

// --- Dynamics (zero-alloc, no Math.pow/Math.sign) ---
function applyDynamics(energyNorm: number, center: number, dynamicDamping: number): number {
  let result = energyNorm;
  if (dynamicDamping > 0) {
    const amount = dynamicDamping < 2 ? dynamicDamping * 0.5 : 1;
    const exponent = 1 / (1 + amount * 4);
    const range = result >= center ? (1 - center) || 0.5 : center || 0.5;
    const normalized = (result - center) / range;
    // Fast pow approximation: exp(exponent * ln(|x|)) via Math.exp/Math.log
    const absN = normalized < 0 ? -normalized : normalized;
    const powered = absN > 0.0001 ? Math.pow(absN, exponent) : 0;
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

interface LightCalibration {
  gammaR: number; gammaG: number; gammaB: number;
  offsetR: number; offsetG: number; offsetB: number;
  attackAlpha: number; releaseAlpha: number;
  dynamicDamping: number; bassWeight: number;
  hiShelfGainDb: number;
  punchWhiteThreshold: number;
  brightnessFloor: number;
  /** 0 = av (ingen vit-rensning, gammalt blekt beteende), 1.0 = full vit-rensning (rena mättade färger) */
  saturation: number;
  /** 0 = av (ingen boost), 1.0 = nuvarande default, upp till ~2.0 = överdrivna transienter */
  transientGain: number;
  /** 0 = av (linjärt, kurvan hoppas helt över), 1.0 = linjärt via math, 1.8 = tidigare default, upp till 3.0 = kraftig mörkkomprimering */
  perceptualGamma: number;
  dynamicsEnabled: boolean;
  /** Onset-tröskel: flux > median * onsetThreshold + 0.008 (1.3 = känslig, 2.5 = strikt). UI-default 1.8. */
  onsetThreshold: number;
  /** Minsta gap mellan onsets i ms — räknas om till frames @ 100Hz FFT-takt. UI-default 110ms. */
  onsetRefractoryMs: number;
  [key: string]: any;
}

const DEFAULT_CAL: LightCalibration = {
  gammaR: 1.0, gammaG: 1.0, gammaB: 1.0,
  offsetR: 0, offsetG: 0, offsetB: 0,
  attackAlpha: 1.0, releaseAlpha: 0.15, dynamicDamping: 0.8,
  bassWeight: 0.7, hiShelfGainDb: 6,
  punchWhiteThreshold: 100,
  brightnessFloor: 0,
  saturation: 1.0,
  transientGain: 1.0,
  perceptualGamma: 0,
  dynamicsEnabled: true,
  onsetThreshold: 1.8,
  onsetRefractoryMs: 110,
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

/** Fast color calibration — white-cleansing (saturation), then offset/gamma */
function applyColorCalibrationFast(r: number, g: number, b: number, cal: LightCalibration, gammaIsUnity: boolean): void {
  // ── Saturation / vit-rensning ──
  // Drar bort min-kanalen (vit-andelen) och boostar tillbaka peak,
  // så hue bevaras men blå/grön spill försvinner i mättade färger.
  let rIn = r, gIn = g, bIn = b;
  const sat = cal.saturation;
  if (sat > 0) {
    const m = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (m > 0) {
      const peak = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const r2 = r - m, g2 = g - m, b2 = b - m;
      const peak2 = r2 > g2 ? (r2 > b2 ? r2 : b2) : (g2 > b2 ? g2 : b2);
      if (peak2 > 0) {
        const boost = peak / peak2;
        const rC = r2 * boost, gC = g2 * boost, bC = b2 * boost;
        // Blend mellan original (sat=0) och vit-rensad (sat=1)
        const inv = 1 - sat;
        rIn = r * inv + rC * sat;
        gIn = g * inv + gC * sat;
        bIn = b * inv + bC * sat;
      }
    }
  }

  if (gammaIsUnity) {
    _finalColor[0] = Math.max(0, Math.min(255, (rIn + cal.offsetR + 0.5) | 0));
    _finalColor[1] = Math.max(0, Math.min(255, (gIn + cal.offsetG + 0.5) | 0));
    _finalColor[2] = Math.max(0, Math.min(255, (bIn + cal.offsetB + 0.5) | 0));
  } else {
    const rn = rIn / 255, gn = gIn / 255, bn = bIn / 255;
    _finalColor[0] = Math.max(0, Math.min(255, (Math.pow(rn < 0 ? 0 : rn > 1 ? 1 : rn, cal.gammaR) * 255 + cal.offsetR + 0.5) | 0));
    _finalColor[1] = Math.max(0, Math.min(255, (Math.pow(gn < 0 ? 0 : gn > 1 ? 1 : gn, cal.gammaG) * 255 + cal.offsetG + 0.5) | 0));
    _finalColor[2] = Math.max(0, Math.min(255, (Math.pow(bn < 0 ? 0 : bn > 1 ? 1 : bn, cal.gammaB) * 255 + cal.offsetB + 0.5) | 0));
  }
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
}

const _diag: DiagSnapshot = {
  rawRms: 0, bassRms: 0, midHiRms: 0,
  bassNorm: 0, midHiNorm: 0,
  preDynamics: 0, energyNorm: 0, dynamicCenter: 0, onsetBoost: 0,
  brightnessPct: 0, bleScaleRaw: 0,
  finalR: 0, finalG: 0, finalB: 0,
  tickCount: 0, lastTickUs: 0,
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

  constructor(tickMs = 20) {
    this.tickMs = tickMs;
    this.cal = loadCalibration();
    this.onsetBuffer = new Float64Array(7);
    this.onsetSorted = new Float64Array(7);
    this.initOnsetBuffer(tickMs);
    this.tc = computeTickConstants(tickMs, this.cal);
    setTickHopMs(tickMs);
    setSlotLeaseMs(tickMs); // 1 tick = 1 BLE-paket (strict lease-slot)
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
    setSlotLeaseMs(ms); // 1 tick = 1 BLE-paket — lease följer tick
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
    const threshold = med * this.cal.onsetThreshold + 0.008;
    const isCandidate = flux > threshold && flux >= this.onsetPrevFlux;
    this.onsetPrevFlux = flux;

    // Refractory gate: minimum gap mellan onsets, räknat i FFT-frames @ 100Hz (10ms/frame)
    const refractoryFrames = Math.max(1, Math.round(this.cal.onsetRefractoryMs / 10));
    this.onsetFrameCounter++;
    if (isCandidate && (this.onsetFrameCounter - this.onsetLastFrameIdx) >= refractoryFrames) {
      this.onsetTarget = 0.45; // strong pulse — clearly visible "in the beat"
      this.onsetLastFrameIdx = this.onsetFrameCounter;
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

  /** Anropas av connect-hardcoded EFTER lyckad anchor write.
   *  Keep-alive kör BARA i idle-mode. Under playing räcker FFT-write-kedjan
   *  (med min 5 pkt/s garanti via stale-write-force i protocol.ts) för att
   *  hålla länken vid liv. Det hindrar att keep-alive bygger kö parallellt
   *  med active path. */
  onBleConnected(): void {
    if (this._bleOwner !== 'none') return;
    this._bleOwner = this.playing ? 'active' : 'idle';
    if (!this.playing) {
      this.forceIdleNow();
      startKeepAlive();
      console.log(`[Engine] BLE connected → idle mode (keep-alive PÅ)`);
    } else {
      // Ren start: rensa onset så första riktiga beat ger en tydlig
      // puls istället för att blandas med stale state från senaste sessionen.
      this.onsetBoost = 0;
      this.onsetTarget = 0;
      this.smoothed = 0;
      this._lastTickAtForFade = 0;  // första fade efter play ska börja från noll-elapsed
      stopKeepAlive();
      console.log(`[Engine] BLE connected → active mode (keep-alive AV — FFT-writes håller länken)`);
    }
  }

  /** Anropas av connect-hardcoded vid disconnect (peripheral.disconnect-event). */
  onBleDisconnected(): void {
    if (this._bleOwner === 'none') return;
    this._bleOwner = 'none';
    stopKeepAlive();
    console.log('[Engine] BLE disconnected → owner=none, keep-alive STOPPAD');
  }

  setPlaying(playing: boolean): void {
    const wasPlaying = this.playing;
    this.playing = playing;
    if (playing === wasPlaying) return;

    if (!playing) {
      // active → idle: reset onset + force idle-färg, starta keep-alive.
      this.onsetBoost = 0;
      this.onsetTarget = 0;
      this.smoothed = 0;
      this._lastTickAtForFade = 0;
      this.stopLoop();
      if (this._bleOwner !== 'none') {
        this._bleOwner = 'idle';
        this.forceIdleNow();
        startKeepAlive();
        console.log('[Engine] → idle mode (owner=idle, keep-alive PÅ)');
      } else {
        console.log('[Engine] → idle mode (BLE ej ansluten)');
      }
    } else {
      // idle → active: stoppa keep-alive (FFT-writes tar över), starta loop.
      // Keep-alive får ALDRIG köra parallellt med active path — det skulle
      // bygga kö i HCI-lagret.
      this.startLoop();
      if (this._bleOwner !== 'none') {
        this._bleOwner = 'active';
        stopKeepAlive();
        console.log('[Engine] → active mode (owner=active, keep-alive AV, FFT-writes håller länken)');
      } else {
        console.log('[Engine] → active mode (BLE ej ansluten, loop startad men inga writes)');
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
      console.log('[Engine] Raw mode ON — all processors disabled');
    } else if (!on && this._rawMode) {
      this._rawMode = false;
      if (this._savedCal) {
        Object.assign(this.cal, this._savedCal);
        this._savedCal = null;
      }
      this.tc = computeTickConstants(this.tickMs, this.cal);
      console.log('[Engine] Raw mode OFF — processors restored');
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
        this.processOnset(flux);
        // Uppdatera dynamicCenter per FFT-frame (100Hz) istället för per tick
        // (50Hz) — center följer då 100% av musiken, inte varannan frame.
        if (this.tc.dynamicsEnabled) {
          const bands = getLatestBands();
          if (bands && Number.isFinite(bands.totalRms)) {
            const bN = normalizeFixed(bands.bassRms);
            const mN = normalizeFixed(bands.midHiRms);
            const raw = bN * 0.5 + mN * 0.5;
            this.dynamicCenter += this.tc.centerAlphaFft * (raw - this.dynamicCenter);
            if (this.dynamicCenter < 0.2) this.dynamicCenter = 0.2;
            else if (this.dynamicCenter > 0.7) this.dynamicCenter = 0.7;
          }
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

    console.log(`[Engine] Initialized (${this.tickMs}ms, loop always active, idle heartbeat until playback)`);
  }

  // ── Event-driven tick scheduling ──
  // FFT fires ~93 times/sec (48000/512). Vi kör tickInner när tickMs har
  // förflutit — ALLTID med den färska FFT-framen i handen. Tidigare schemalades
  // en setTimeout för "remaining ms" när FFT kom för tidigt, vilket innebar
  // att tickInner körde mot en GAMMAL getLatestBands() (upp till tickMs sen).
  // Det gav smygande audio-latens utan att synas i pkt/s. Borttaget.
  private _lastTickTime = 0;
  private _lastTickAtForFade = 0;
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
    console.log('[Engine] Stopped');
  }

  /** Suspend engine output (for BLE tests etc.) — stops loop + keep-alive */
  suspend(): void {
    this.stopLoop();
    stopKeepAlive();
    console.log('[Engine] Suspended (BLE test mode)');
  }

  /** Resume engine output after suspend */
  resume(): void {
    this.startLoop();
    if (!this.playing && this._bleOwner !== 'none') {
      this._bleOwner = 'idle';
      this.forceIdleNow();
      startKeepAlive();
    }
    console.log(`[Engine] Resumed (${this.playing ? 'active' : 'idle'})`);
  }

  /** Restart tick scheduling — preserves all smoothing state */
  restartTimer(): void {
    this.stopLoop();
    if (this.playing) this.startLoop();
    console.log(`[Engine] Timer restarted (${this.tickMs}ms min interval = ${(1000 / this.tickMs + 0.5) | 0} Hz max, ${this.playing ? 'active' : 'idle'})`);
  }

  /** Guard against NaN/Infinity corrupting smoothing state */
  private sanitizeState(): void {
    if (!Number.isFinite(this.dynamicCenter)) this.dynamicCenter = 0.5;
    
    if (!Number.isFinite(this.onsetBoost)) { this.onsetBoost = 0; this.onsetTarget = 0; }
  }

  getDiagnostics(): DiagSnapshot { return _diag; }
  getCalibration(): LightCalibration { return this.cal; }

  /** Hot path — zero-allocation, precomputed constants, event-driven from FFT */
  tickInner(): void {
    // Skip processing när engine inte spelar ELLER när vi inte är BLE-active-owner.
    // Sista guard mot sen FFT-frame som anländer efter setPlaying(false) → annars
    // kan en mic-write krocka med keep-alive som just tagit över.
    if (!this.playing || this._bleOwner !== 'active') return;
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
      const bassGain  = w <= 0.5 ? w * 2 : 1;
      const midHiGain = w >= 0.5 ? (1 - w) * 2 : 1;
      let energyNorm = bassNorm * bassGain + midHiNorm * midHiGain;

      // ── 4. Release smoothing (enda smoothing — alsaMic levererar rå RMS) ──
      // Körs på tick-takt (50Hz) så filtret är synkat mot output-raten och
      // undviker alias-hack mellan FFT-takt (100Hz) och tick-takt.
      const alpha = energyNorm > this.smoothed ? tc.attackAlpha : tc.releaseAlpha;
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
      const fluxBoost = transientGain > 0 ? this.onsetBoost * transientGain : 0;
      energyNorm = energyNorm + fluxBoost;
      if (energyNorm > 1) energyNorm = 1;

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
      applyColorCalibrationFast(this.color[0], this.color[1], this.color[2], cal, tc.gammaIsUnity);

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
