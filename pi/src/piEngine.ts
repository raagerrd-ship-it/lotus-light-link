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

import { getLatestBands, resetFluxState, onFFTReady, type BandResult } from './alsaMic.js';
import { sendToBLE, bleStats, getDimmingGamma } from './nobleBle.js';
import { getItem, setItem } from './storage.js';

// ── Inline engine math (avoid complex path aliasing to browser engine) ──

// --- AGC ---
const AGC_FLOOR = 0.002;
const AGC_MAX_DECAY_PER_SEC = 0.99840;
const AGC_QUIET_DECAY_MEDIUM_PER_SEC = 0.98410;
const AGC_QUIET_DECAY_FAST_PER_SEC = 0.92274;
const QUIET_THRESHOLD_RATIO = 0.10;
const QUIET_MS_MEDIUM = 2000;
const QUIET_MS_FAST = 5000;
const BUCKET_SIZE = 5;

interface AgcState {
  max: number; min: number;
  bassMax: number; bassMin: number;
  midHiMax: number; midHiMin: number;
  quietTicks: number;
}

type AgcVolumeTable = Record<number, number>;

function createAgcState(initialMax = 0.01): AgcState {
  return { max: Math.max(initialMax, 0.01), min: 0, bassMax: 0.01, bassMin: 0, midHiMax: 0.01, midHiMin: 0, quietTicks: 0 };
}

function volumeToBucket(volume: number | undefined): number {
  if (volume == null || volume <= 0) return 0;
  return (Math.min(100, volume) / BUCKET_SIZE) | 0;
}

function updateVolumeTable(table: AgcVolumeTable, bucket: number, value: number): void {
  if (value > (table[bucket] ?? 0)) table[bucket] = value;
}

function getFloorForVolume(table: AgcVolumeTable, bucket: number): number {
  if (table[bucket] != null) return table[bucket];
  let nearestBucket: number | null = null, nearestDist = Infinity;
  const keys = Object.keys(table);
  for (let i = 0, len = keys.length; i < len; i++) {
    const b = Number(keys[i]), dist = Math.abs(b - bucket);
    if (dist < nearestDist) { nearestDist = dist; nearestBucket = b; }
  }
  if (nearestBucket == null) return 0.01;
  const nearestVol = (nearestBucket * BUCKET_SIZE) || 1;
  const currentVol = (bucket * BUCKET_SIZE) || 1;
  return Math.max(AGC_FLOOR, table[nearestBucket] * (currentVol / nearestVol));
}

/** AGC update using precomputed decay constants — no Math.pow */
function updateRunningMaxFast(state: AgcState, smoothed: number, bassRms: number, midHiRms: number, tc: TickConstants): void {
  const isQuiet = smoothed < state.max * QUIET_THRESHOLD_RATIO;
  if (isQuiet) state.quietTicks++; else state.quietTicks = 0;
  const decay = state.quietTicks >= tc.quietFastTicks ? tc.agcDecayFast
    : state.quietTicks >= tc.quietMediumTicks ? tc.agcDecayMedium : tc.agcDecayNormal;
  if (smoothed > state.max) state.max = smoothed; else state.max = Math.max(AGC_FLOOR, state.max * decay);
  if (bassRms > state.bassMax) state.bassMax = bassRms; else state.bassMax = Math.max(AGC_FLOOR, state.bassMax * decay);
  if (bassRms < state.bassMin || state.bassMin === 0) state.bassMin = bassRms;
  if (midHiRms > state.midHiMax) state.midHiMax = midHiRms; else state.midHiMax = Math.max(AGC_FLOOR, state.midHiMax * decay);
  if (midHiRms < state.midHiMin || state.midHiMin === 0) state.midHiMin = midHiRms;
}

function normalizeBand(value: number, state: AgcState, band: 'bass' | 'midHi'): number {
  const max = band === 'bass' ? state.bassMax : state.midHiMax;
  const min = band === 'bass' ? state.bassMin : state.midHiMin;
  const range = Math.max(AGC_FLOOR, max - min);
  const n = (value - min) / range;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// --- Precomputed tick constants ---
interface TickConstants {
  attackAlpha: number;
  releaseAlpha: number;
  onsetDecay: number;
  onsetRiseAlpha: number;
  agcDecayNormal: number;
  agcDecayMedium: number;
  agcDecayFast: number;
  quietMediumTicks: number;
  quietFastTicks: number;
  centerAlpha: number;
  extraSmoothAlpha: number;
  paletteTimedSpeed: number;
  gammaIsUnity: boolean;
  dimmingGamma: number;
}

function computeTickConstants(tickMs: number, cal: LightCalibration): TickConstants {
  const ratio = tickMs / 125;
  const secRatio = tickMs / 1000;

  const sm = cal.smoothing ?? 0;
  let extraSmoothAlpha = 0;
  if (sm > 0) {
    const alphaRef = Math.exp(-sm * 0.04);
    extraSmoothAlpha = Math.pow(alphaRef, ratio);
  }

  return {
    attackAlpha: 1 - Math.pow(1 - cal.attackAlpha, ratio),
    releaseAlpha: 1 - Math.pow(1 - cal.releaseAlpha, ratio),
    onsetDecay: Math.pow(0.10, secRatio),
    onsetRiseAlpha: 1 - Math.pow(0.15, ratio),
    agcDecayNormal: Math.pow(AGC_MAX_DECAY_PER_SEC, secRatio),
    agcDecayMedium: Math.pow(AGC_QUIET_DECAY_MEDIUM_PER_SEC, secRatio),
    agcDecayFast: Math.pow(AGC_QUIET_DECAY_FAST_PER_SEC, secRatio),
    quietMediumTicks: (QUIET_MS_MEDIUM / tickMs + 0.5) | 0,
    quietFastTicks: (QUIET_MS_FAST / tickMs + 0.5) | 0,
    centerAlpha: 1 - Math.pow(1 - 0.008, ratio),
    extraSmoothAlpha,
    paletteTimedSpeed: Math.max(1, ((cal.paletteRotationSpeed ?? 8) * (125 / tickMs) + 0.5) | 0),
    gammaIsUnity: cal.gammaR === 1.0 && cal.gammaG === 1.0 && cal.gammaB === 1.0,
    dimmingGamma: getDimmingGamma(),
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
export type PaletteMode = 'off' | 'timed' | 'bass' | 'energy' | 'blend';

interface LightCalibration {
  gammaR: number; gammaG: number; gammaB: number;
  offsetR: number; offsetG: number; offsetB: number;
  attackAlpha: number; releaseAlpha: number;
  dynamicDamping: number; bassWeight: number;
  hiShelfGainDb: number;
  punchWhiteThreshold: number;
  smoothing: number; brightnessFloor: number;
  transientBoost: boolean;
  perceptualCurve: boolean;
  paletteMode: PaletteMode;
  paletteRotationSpeed: number;
  agcVolumeTable: AgcVolumeTable;
  [key: string]: any;
}

const DEFAULT_CAL: LightCalibration = {
  gammaR: 1.0, gammaG: 1.0, gammaB: 1.0,
  offsetR: 0, offsetG: 0, offsetB: 0,
  attackAlpha: 1.0, releaseAlpha: 0.025, dynamicDamping: -1.0,
  bassWeight: 0.7, hiShelfGainDb: 6,
  punchWhiteThreshold: 100,
  smoothing: 0, brightnessFloor: 0,
  transientBoost: true,
  perceptualCurve: false,
  paletteMode: 'off', paletteRotationSpeed: 8,
  agcVolumeTable: {},
};

function loadCalibration(): LightCalibration {
  try {
    const raw = getItem('light-calibration');
    if (raw) return { ...DEFAULT_CAL, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_CAL };
}

function saveCalibration(cal: LightCalibration): void {
  setItem('light-calibration', JSON.stringify(cal));
}

function loadIdleColor(): [number, number, number] {
  try {
    const raw = getItem('idle-color');
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length === 3) return p as [number, number, number]; }
  } catch {}
  return [255, 60, 0];
}

/** Fast color calibration — skips gamma when unity */
function applyColorCalibrationFast(r: number, g: number, b: number, cal: LightCalibration, gammaIsUnity: boolean): void {
  if (gammaIsUnity) {
    _finalColor[0] = Math.max(0, Math.min(255, (r + cal.offsetR + 0.5) | 0));
    _finalColor[1] = Math.max(0, Math.min(255, (g + cal.offsetG + 0.5) | 0));
    _finalColor[2] = Math.max(0, Math.min(255, (b + cal.offsetB + 0.5) | 0));
  } else {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    _finalColor[0] = Math.max(0, Math.min(255, (Math.pow(rn < 0 ? 0 : rn > 1 ? 1 : rn, cal.gammaR) * 255 + cal.offsetR + 0.5) | 0));
    _finalColor[1] = Math.max(0, Math.min(255, (Math.pow(gn < 0 ? 0 : gn > 1 ? 1 : gn, cal.gammaG) * 255 + cal.offsetG + 0.5) | 0));
    _finalColor[2] = Math.max(0, Math.min(255, (Math.pow(bn < 0 ? 0 : bn > 1 ? 1 : bn, cal.gammaB) * 255 + cal.offsetB + 0.5) | 0));
  }
}

// Reusable static arrays — zero-alloc
const _finalColor: [number, number, number] = [0, 0, 0];
const _blendColor: [number, number, number] = [0, 0, 0];

// Reusable TickData — mutated in place
const _tickData: TickData = {
  brightness: 0,
  color: [0, 0, 0],
  bassLevel: 0,
  midHiLevel: 0,
  isPlaying: false,
  tickMs: 0,
  paletteIndex: 0,
};

// ── Engine ──

export interface TickData {
  brightness: number;
  color: [number, number, number];
  bassLevel: number;
  midHiLevel: number;
  isPlaying: boolean;
  tickMs: number;
  paletteIndex: number;
}

export type TickCallback = (data: TickData) => void;

export class PiLightEngine {
  private color: [number, number, number] = [255, 80, 0];
  private volume: number | undefined;
  private playing = false;
  private tickMs: number;

  private smoothed = 0;
  private smoothedBass = 0;
  private smoothedMidHi = 0;
  private dynamicCenter = 0.5;
  private extraSmoothPct = 0;

  // Onset detection state — zero-alloc insertion-sort median
  private onsetBuffer: Float64Array;
  private onsetSorted: Float64Array;
  private onsetPos = 0;
  private onsetSize = 0;
  private onsetPrevFlux = 0;
  private onsetBoost = 0;
  private onsetTarget = 0;

  private agc: AgcState;
  private cal: LightCalibration;
  private volumeTable: AgcVolumeTable;
  private lastBucket = 0;

  // Precomputed tick constants — refreshed only when tickMs or cal changes
  private tc!: TickConstants;

  private _running = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private callbacks: TickCallback[] = [];

  // Palette state
  private _palette: [number, number, number][] = [];
  private _paletteIndex = 0;
  private _paletteTickCounter = 0;
  private _bassWasHigh = false;

  constructor(tickMs = 30) {
    this.tickMs = tickMs;
    this.cal = loadCalibration();
    this.volumeTable = { ...this.cal.agcVolumeTable };
    this.agc = createAgcState(0.01);
    this.onsetBuffer = new Float64Array(7);
    this.onsetSorted = new Float64Array(7);
    this.initOnsetBuffer(tickMs);
    this.tc = computeTickConstants(tickMs, this.cal);
  }

  onTick(cb: TickCallback): () => void {
    this.callbacks.push(cb);
    return () => { this.callbacks = this.callbacks.filter(c => c !== cb); };
  }

  setColor(rgb: [number, number, number]) { this.color = rgb; }
  setPalette(palette: [number, number, number][]) { this._palette = palette; this._paletteIndex = 0; }
  getPalette(): [number, number, number][] { return this._palette; }
  setVolume(vol: number | undefined) { this.volume = vol; }
  getTickMs(): number { return this.tickMs; }

  setTickMs(ms: number) {
    this.tickMs = ms;
    this.initOnsetBuffer(ms);
    this.tc = computeTickConstants(ms, this.cal);
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
  }

  /** Zero-alloc onset detection using precomputed constants */
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
    const threshold = med * 1.5 + 0.005;
    const isOnset = flux > threshold && flux >= this.onsetPrevFlux;
    this.onsetPrevFlux = flux;

    if (isOnset) this.onsetTarget = 0.22;

    // Fast rise using precomputed alpha, smooth decay using precomputed decay
    if (this.onsetBoost < this.onsetTarget) {
      this.onsetBoost += tc.onsetRiseAlpha * (this.onsetTarget - this.onsetBoost);
    } else {
      this.onsetBoost *= tc.onsetDecay;
    }
    this.onsetTarget *= tc.onsetDecay;

    if (this.onsetBoost < 0.001) { this.onsetBoost = 0; this.onsetTarget = 0; }
  }

  setPlaying(playing: boolean): void {
    const wasPlaying = this.playing;
    this.playing = playing;

    if (!playing && wasPlaying) {
      this.stopLoop();
      const idle = loadIdleColor();
      applyColorCalibrationFast(idle[0], idle[1], idle[2], this.cal, this.tc.gammaIsUnity);
      sendToBLE(_finalColor[0], _finalColor[1], _finalColor[2], 100);
      console.log('[Engine] → idle mode (loop stopped)');
    } else if (playing && !wasPlaying) {
      this.startLoop();
      console.log('[Engine] → active mode (loop started)');
    }
  }

  reloadCalibration(): void {
    this.cal = loadCalibration();
    this.tc = computeTickConstants(this.tickMs, this.cal);
  }

  /** Initialize engine — call once at boot. Loop only starts when setPlaying(true). */
  start(): void {
    if (this._running) return;

    const bucket = volumeToBucket(this.volume);
    const floor = getFloorForVolume(this.volumeTable, bucket);
    this.agc = createAgcState(floor);
    this.lastBucket = bucket;
    this._running = true;

    // Register for FFT-driven ticks (event-driven, not polling)
    onFFTReady((bands) => this.onFFTFrame(bands));

    this.saveTimer = setInterval(() => {
      const updated = { ...this.cal, agcVolumeTable: { ...this.volumeTable } };
      this.cal = updated;
      saveCalibration(updated);
    }, 10_000);

    console.log(`[Engine] Initialized (${this.tickMs}ms min interval = ${(1000 / this.tickMs + 0.5) | 0} Hz max, event-driven, waiting for playback)`);
  }

  // ── Event-driven tick scheduling ──
  // FFT fires ~86 times/sec (44100/512). We only process if tickMs has elapsed.
  private _lastTickTime = 0;
  private _pendingTimeout: ReturnType<typeof setTimeout> | null = null;
  private _loopActive = false;

  /** Called by ALSA FFT callback — runs in the audio data handler context */
  private onFFTFrame(_bands: BandResult): void {
    if (!this._loopActive) return;

    const now = performance.now();
    const elapsed = now - this._lastTickTime;

    if (elapsed >= this.tickMs) {
      // Enough time passed — process immediately (zero latency)
      this._lastTickTime = now;
      if (this._pendingTimeout) { clearTimeout(this._pendingTimeout); this._pendingTimeout = null; }
      this.tickInner();
    } else if (!this._pendingTimeout) {
      // FFT arrived too early — schedule for remaining time
      const remaining = this.tickMs - elapsed;
      this._pendingTimeout = setTimeout(() => {
        this._pendingTimeout = null;
        this._lastTickTime = performance.now();
        this.tickInner();
      }, remaining);
    }
    // If _pendingTimeout already set, skip (tick is already scheduled)
  }

  private startLoop(): void {
    if (this._loopActive) return;
    this._loopActive = true;
    this._lastTickTime = performance.now();
  }

  private stopLoop(): void {
    this._loopActive = false;
    if (this._pendingTimeout) { clearTimeout(this._pendingTimeout); this._pendingTimeout = null; }
  }

  stop(): void {
    this._running = false;
    this.stopLoop();
    onFFTReady(null); // unregister callback
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    console.log('[Engine] Stopped');
  }

  /** Restart tick scheduling — preserves all smoothing/AGC state */
  restartTimer(): void {
    this.stopLoop();
    if (this.playing) this.startLoop();
    console.log(`[Engine] Timer restarted (${this.tickMs}ms min interval = ${(1000 / this.tickMs + 0.5) | 0} Hz max, ${this.playing ? 'active' : 'idle'})`);
  }

  /** Guard against NaN/Infinity corrupting smoothing state */
  private sanitizeState(): void {
    if (!Number.isFinite(this.smoothed)) this.smoothed = 0;
    if (!Number.isFinite(this.smoothedBass)) this.smoothedBass = 0;
    if (!Number.isFinite(this.smoothedMidHi)) this.smoothedMidHi = 0;
    if (!Number.isFinite(this.dynamicCenter)) this.dynamicCenter = 0.5;
    if (!Number.isFinite(this.extraSmoothPct)) this.extraSmoothPct = 0;
    if (!Number.isFinite(this.onsetBoost)) { this.onsetBoost = 0; this.onsetTarget = 0; }
  }

  /** Hot path — zero-allocation, precomputed constants, event-driven from FFT */
  tickInner(): void {
    try {
      const cal = this.cal;
      const tc = this.tc;
      const bands = getLatestBands();

      // ── Smoothing (precomputed alphas) ──
      const atkAlpha = bands.totalRms > this.smoothed ? tc.attackAlpha : tc.releaseAlpha;
      this.smoothed += atkAlpha * (bands.totalRms - this.smoothed);

      // ── Volume bucket & AGC ──
      const bucket = volumeToBucket(this.volume);
      if (bucket !== this.lastBucket) {
        const floor = getFloorForVolume(this.volumeTable, bucket);
        if (floor > this.agc.max) this.agc.max = floor;
        this.lastBucket = bucket;
      }
      updateRunningMaxFast(this.agc, this.smoothed, bands.bassRms, bands.midHiRms, tc);
      updateVolumeTable(this.volumeTable, bucket, this.smoothed);

      // ── Normalize bands ──
      const rawBassNorm = normalizeBand(bands.bassRms, this.agc, 'bass');
      const rawMidHiNorm = normalizeBand(bands.midHiRms, this.agc, 'midHi');
      const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;

      // ── Per-band smoothing (precomputed alphas) ──
      const bassAlpha = rawBassNorm > this.smoothedBass ? tc.attackAlpha : tc.releaseAlpha;
      this.smoothedBass += bassAlpha * (rawBassNorm - this.smoothedBass);
      const midHiAlpha = rawMidHiNorm > this.smoothedMidHi ? tc.attackAlpha : tc.releaseAlpha;
      this.smoothedMidHi += midHiAlpha * (rawMidHiNorm - this.smoothedMidHi);

      // ── Onset detection (precomputed constants) ──
      this.processOnset(bands.flux);
      const fluxBoost = (cal.transientBoost !== false) ? this.onsetBoost : 0;

      // ── Brightness ──
      let energyNorm = this.smoothedBass * cal.bassWeight + this.smoothedMidHi * (1 - cal.bassWeight);
      energyNorm = energyNorm + fluxBoost;
      if (energyNorm > 1) energyNorm = 1;

      // Dynamic center (precomputed alpha)
      this.dynamicCenter += (energyNorm - this.dynamicCenter) * tc.centerAlpha;
      energyNorm = applyDynamics(energyNorm, this.dynamicCenter, cal.dynamicDamping);

      const floor = cal.brightnessFloor ?? 0;
      let pct = energyNorm * 100;
      if (pct < floor) pct = floor;

      // Perceptual curve (use BLE brightness LUT gamma value — no Math.pow)
      if (cal.perceptualCurve && pct > floor && pct < 100) {
        const norm = (pct - floor) / (100 - floor);
        // Fast exp-log pow: exp(gamma * ln(norm))
        pct = floor + (norm > 0.0001 ? Math.exp(tc.dimmingGamma * Math.log(norm)) : 0) * (100 - floor);
      }

      // Extra smoothing (precomputed alpha)
      const sm = cal.smoothing ?? 0;
      if (sm > 0) {
        this.extraSmoothPct += (1 - tc.extraSmoothAlpha) * (pct - this.extraSmoothPct);
        pct = this.extraSmoothPct;
      }

      // Fast round + clamp
      pct = (pct + 0.5) | 0;
      if (pct > 100) pct = 100;
      if (pct < floor) pct = floor;

      // ── Palette mode (precomputed speed) ──
      const pm = cal.paletteMode ?? 'off';
      if (pm !== 'off' && this._palette.length > 1) {
        const pLen = this._palette.length;

        if (pm === 'timed') {
          this._paletteTickCounter++;
          if (this._paletteTickCounter >= tc.paletteTimedSpeed) {
            this._paletteTickCounter = 0;
            this._paletteIndex = (this._paletteIndex + 1) % pLen;
          }
          this.color = this._palette[this._paletteIndex];

        } else if (pm === 'bass') {
          const isHigh = this.smoothedBass > 0.45;
          if (isHigh && !this._bassWasHigh) {
            this._paletteIndex = (this._paletteIndex + 1) % pLen;
          }
          this._bassWasHigh = isHigh;
          this.color = this._palette[this._paletteIndex];

        } else if (pm === 'energy') {
          const idx = Math.min(pLen - 1, (rawEnergy * pLen) | 0);
          this.color = this._palette[idx];

        } else if (pm === 'blend') {
          const ce = rawEnergy < 0 ? 0 : rawEnergy > 1 ? 1 : rawEnergy;
          const pos = ce * (pLen - 1);
          const lo = pos | 0;
          const hi = lo + 1 < pLen ? lo + 1 : pLen - 1;
          const t = pos - lo;
          const cLo = this._palette[lo], cHi = this._palette[hi];
          _blendColor[0] = (cLo[0] + (cHi[0] - cLo[0]) * t + 0.5) | 0;
          _blendColor[1] = (cLo[1] + (cHi[1] - cLo[1]) * t + 0.5) | 0;
          _blendColor[2] = (cLo[2] + (cHi[2] - cLo[2]) * t + 0.5) | 0;
          this.color = _blendColor;
        }
      }

      // ── Color calibration (fast path skips gamma when unity) ──
      const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;
      applyColorCalibrationFast(this.color[0], this.color[1], this.color[2], cal, tc.gammaIsUnity);

      // ── BLE output ──
      if (isPunch) sendToBLE(255, 255, 255, pct);
      else sendToBLE(_finalColor[0], _finalColor[1], _finalColor[2], pct);

      // ── Emit (reuse static TickData) ──
      const td = _tickData;
      td.brightness = pct;
      td.color[0] = _finalColor[0]; td.color[1] = _finalColor[1]; td.color[2] = _finalColor[2];
      td.bassLevel = bands.bassRms;
      td.midHiLevel = bands.midHiRms;
      td.isPlaying = true;
      td.tickMs = this.tickMs;
      td.paletteIndex = this._paletteIndex;
      const cbs = this.callbacks;
      for (let i = 0, len = cbs.length; i < len; i++) cbs[i](td);
    } catch (e) {
      console.error('[Engine] tick error (recovering):', e);
      this.sanitizeState();
    }
  }
}
