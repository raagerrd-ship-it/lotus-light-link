/**
 * PiLightEngine — headless audio→light pipeline for Raspberry Pi.
 * Reimplements LightEngine using ALSA mic + noble BLE.
 * Core math (AGC, brightness, smoothing) imported from shared engine.
 */

import { getLatestBands, resetFluxState } from './alsaMic.js';
import { sendToBLE, bleStats, getDimmingGamma } from './nobleBle.js';
import { getItem, setItem } from './storage.js';

// ── Inline engine math (avoid complex path aliasing to browser engine) ──
// These are copied from the browser engine's pure-math modules.
// On update, sync from src/lib/engine/*.ts

// --- AGC ---
const AGC_FLOOR = 0.002;
// Per-second decay rates (tick-rate independent)
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
  return Math.floor(Math.min(100, volume) / BUCKET_SIZE);
}

function updateVolumeTable(table: AgcVolumeTable, bucket: number, value: number): void {
  if (value > (table[bucket] ?? 0)) table[bucket] = value;
}

function getFloorForVolume(table: AgcVolumeTable, bucket: number): number {
  if (table[bucket] != null) return table[bucket];
  let nearestBucket: number | null = null, nearestDist = Infinity;
  for (const key of Object.keys(table)) {
    const b = Number(key), dist = Math.abs(b - bucket);
    if (dist < nearestDist) { nearestDist = dist; nearestBucket = b; }
  }
  if (nearestBucket == null) return 0.01;
  const nearestVol = (nearestBucket * BUCKET_SIZE) || 1;
  const currentVol = (bucket * BUCKET_SIZE) || 1;
  return Math.max(AGC_FLOOR, table[nearestBucket] * (currentVol / nearestVol));
}

function updateRunningMax(state: AgcState, smoothed: number, bassRms: number, midHiRms: number, tickMs: number): void {
  const isQuiet = smoothed < state.max * QUIET_THRESHOLD_RATIO;
  if (isQuiet) state.quietTicks++; else state.quietTicks = 0;
  const quietMedium = Math.round(QUIET_MS_MEDIUM / tickMs);
  const quietFast = Math.round(QUIET_MS_FAST / tickMs);
  const decayPerSec = state.quietTicks >= quietFast ? AGC_QUIET_DECAY_FAST_PER_SEC
    : state.quietTicks >= quietMedium ? AGC_QUIET_DECAY_MEDIUM_PER_SEC : AGC_MAX_DECAY_PER_SEC;
  const decay = Math.pow(decayPerSec, tickMs / 1000);
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
  return Math.min(1, Math.max(0, (value - min) / range));
}

// --- Smoothing & brightness ---
/** Tick-rate normalized smoothing.  Alpha values are calibrated for 125ms reference tick.
 *  At faster tick rates, alpha is reduced proportionally to maintain the same time-constant. */
function smooth(prev: number, raw: number, attackAlpha: number, releaseAlpha: number, tickMs: number = 125): number {
  const base = raw > prev ? attackAlpha : releaseAlpha;
  // Convert per-tick alpha to per-second rate, then back to current tickMs
  // alpha_normalized = 1 - (1 - alpha)^(tickMs/125)
  const alpha = 1 - Math.pow(1 - base, tickMs / 125);
  return prev + alpha * (raw - prev);
}

function extraSmooth(prev: number, newVal: number, smoothing: number, tickMs: number = 125): number {
  if (smoothing <= 0) return newVal;
  const alphaRef = Math.exp(-smoothing * 0.04);
  const alpha = Math.pow(alphaRef, tickMs / 125);
  return prev + (1 - alpha) * (newVal - prev);
}

function applyDynamics(energyNorm: number, center: number, dynamicDamping: number): number {
  let result = energyNorm;
  if (dynamicDamping > 0) {
    const amount = Math.min(1, dynamicDamping / 2);
    const exponent = 1 / (1 + amount * 4);
    const range = result >= center ? (1 - center) || 0.5 : center || 0.5;
    const normalized = (result - center) / range;
    const expanded = Math.sign(normalized) * Math.pow(Math.abs(normalized), exponent);
    const gain = 1 + amount * 0.5;
    result = center + expanded * range * gain;
    const ceiling = 1 + amount * 0.4;
    if (result > ceiling) result = ceiling + (result - ceiling) * 0.2;
  } else if (dynamicDamping < 0) {
    const amount = Math.min(1, Math.abs(dynamicDamping) / 3);
    const compression = 1 / (1 + amount * 4);
    result = center + (result - center) * compression;
  }
  return Math.max(0, result);
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

function applyColorCalibration(r: number, g: number, b: number, cal: LightCalibration): [number, number, number] {
  const apply = (val: number, gamma: number, offset: number) => {
    const norm = Math.max(0, Math.min(1, val / 255));
    return Math.max(0, Math.min(255, Math.round(Math.pow(norm, gamma) * 255 + offset)));
  };
  return [apply(r, cal.gammaR, cal.offsetR), apply(g, cal.gammaG, cal.offsetG), apply(b, cal.gammaB, cal.offsetB)];
}

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
  private playing = true;
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
  private onsetTarget = 0;  // shaped envelope target for rounded spikes
  private agc: AgcState;
  private cal: LightCalibration;
  private volumeTable: AgcVolumeTable;
  private lastBucket = 0;
  private idleSent = false;

  // Pre-computed tick-rate constants (avoid recomputing every tick)
  private _tickDecay = 0;        // onset boost decay per tick
  private _centerAlpha = 0;      // dynamic center tracking alpha
  private _smoothAttack = 0;     // pre-computed smoothing alphas
  private _smoothRelease = 0;


  private _running = false;
  private _immediate: NodeJS.Immediate | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private callbacks: TickCallback[] = [];

  constructor(tickMs = 30) {
    this.tickMs = tickMs;
    this.cal = loadCalibration();
    this.volumeTable = { ...this.cal.agcVolumeTable };
    this.agc = createAgcState(0.01);
    this.onsetBuffer = new Float64Array(7);
    this.onsetSorted = new Float64Array(7);
    this.initOnsetBuffer(tickMs);
    this.precomputeConstants();
  }

  onTick(cb: TickCallback): () => void {
    this.callbacks.push(cb);
    return () => { this.callbacks = this.callbacks.filter(c => c !== cb); };
  }

  setColor(rgb: [number, number, number]) { this.color = rgb; }
  setPalette(palette: [number, number, number][]) { this._palette = palette; this._paletteIndex = 0; }
  getPalette(): [number, number, number][] { return this._palette; }
  private _palette: [number, number, number][] = [];
  private _paletteIndex = 0;
  private _paletteTickCounter = 0;
  private _bassWasHigh = false;
  setVolume(vol: number | undefined) { this.volume = vol; }
  getTickMs(): number { return this.tickMs; }
  setTickMs(ms: number) { this.tickMs = ms; this.initOnsetBuffer(ms); this.precomputeConstants(); }

  /** Pre-compute tick-rate dependent constants once instead of every tick */
  private precomputeConstants(): void {
    const t = this.tickMs;
    const cal = this.cal;
    // Onset decay: 0.10^(tickMs/1000) = e^(ln(0.10)*tickMs/1000)
    this._tickDecay = Math.pow(0.10, t / 1000);
    // Dynamic center alpha
    this._centerAlpha = 1 - Math.pow(1 - 0.008, t / 125);
    // Smoothing alphas for attack/release
    this._smoothAttack = 1 - Math.pow(1 - cal.attackAlpha, t / 125);
    this._smoothRelease = 1 - Math.pow(1 - cal.releaseAlpha, t / 125);
  }

  private initOnsetBuffer(tickMs: number): void {
    this.onsetSize = Math.max(3, Math.round(175 / tickMs));
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
  }

  /** Zero-alloc onset detection with shaped spike envelope:
   *  - Fast 2-tick rise to round the peak (not instant step)
   *  - Smooth exponential decay for natural fade-out */
  private processOnset(flux: number): boolean {
    this.onsetBuffer[this.onsetPos] = flux;
    this.onsetPos = (this.onsetPos + 1) % this.onsetSize;

    // Copy to sorted buffer and insertion-sort in-place (N≤7, ~20 comparisons max)
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

    // Shaped envelope: target jumps on onset, boost chases target with fast rise alpha
    // then target decays smoothly → gives rounded peak + smooth fade
    if (isOnset) this.onsetTarget = 0.22;

    // Fast rise (~2 ticks to peak), smooth decay
    const riseAlpha = 1 - Math.pow(0.15, this.tickMs / 125);  // fast: ~85% per tick @125ms
    if (this.onsetBoost < this.onsetTarget) {
      this.onsetBoost += riseAlpha * (this.onsetTarget - this.onsetBoost);
    } else {
      this.onsetBoost *= this._tickDecay;
    }
    // Decay the target itself for rounded top
    this.onsetTarget *= this._tickDecay;

    if (this.onsetBoost < 0.001) { this.onsetBoost = 0; this.onsetTarget = 0; }
    return isOnset;
  }

  setPlaying(playing: boolean): void {
    const wasPlaying = this.playing;
    this.playing = playing;

    if (!playing && wasPlaying) {
      const idle = loadIdleColor();
      const calibrated = applyColorCalibration(idle[0], idle[1], idle[2], this.cal);
      sendToBLE(calibrated[0], calibrated[1], calibrated[2], 100);
      this.idleSent = true;
      console.log('[Engine] → idle mode');
    } else if (playing && !wasPlaying) {
      this.idleSent = false;
      console.log('[Engine] → active mode');
    }
  }

  reloadCalibration(): void {
    this.cal = loadCalibration();
    this.precomputeConstants();
  }


  start(): void {
    if (this._running) return;

    const bucket = volumeToBucket(this.volume);
    const floor = getFloorForVolume(this.volumeTable, bucket);
    this.agc = createAgcState(floor);
    this.lastBucket = bucket;
    this._running = true;

    this.startLoop();

    this.saveTimer = setInterval(() => {
      const updated = { ...this.cal, agcVolumeTable: { ...this.volumeTable } };
      this.cal = updated;
      saveCalibration(updated);
    }, 10_000);

    console.log(`[Engine] Started (${this.tickMs}ms tick = ${Math.round(1000 / this.tickMs)} Hz, hrtime loop)`);
  }

  private startLoop(): void {
    const tickNs = BigInt(this.tickMs) * 1_000_000n;
    let nextTick = process.hrtime.bigint() + tickNs;

    const loop = () => {
      if (!this._running) return;

      const now = process.hrtime.bigint();
      if (now >= nextTick) {
        this.tick();
        nextTick = now + tickNs;
      }

      this._immediate = setImmediate(loop);
    };

    this._immediate = setImmediate(loop);
  }

  stop(): void {
    this._running = false;
    if (this._immediate) { clearImmediate(this._immediate); this._immediate = null; }
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    console.log('[Engine] Stopped');
  }

  /** Restart tick timer only — preserves all smoothing/AGC state */
  restartTimer(): void {
    this.stop();
    this._running = true;
    this.startLoop();
    this.saveTimer = setInterval(() => {
      const updated = { ...this.cal, agcVolumeTable: { ...this.volumeTable } };
      this.cal = updated;
      saveCalibration(updated);
    }, 10_000);
    console.log(`[Engine] Timer restarted (${this.tickMs}ms tick = ${Math.round(1000 / this.tickMs)} Hz)`);
  }

  private tick(): void {
    if (!this.playing) {
      if (!this.idleSent) {
        const idle = loadIdleColor();
        const calibrated = applyColorCalibration(idle[0], idle[1], idle[2], this.cal);
        sendToBLE(calibrated[0], calibrated[1], calibrated[2], 100);
        this.idleSent = true;
      }
      return;
    }
    this.idleSent = false;

    const cal = this.cal;
    const bands = getLatestBands();

    // Smoothing — use pre-computed alphas (avoid Math.pow per tick)
    const sa = this._smoothAttack, sr = this._smoothRelease;
    this.smoothed += (bands.totalRms > this.smoothed ? sa : sr) * (bands.totalRms - this.smoothed);

    // Volume bucket
    const bucket = volumeToBucket(this.volume);
    if (bucket !== this.lastBucket) {
      const floor = getFloorForVolume(this.volumeTable, bucket);
      if (floor > this.agc.max) this.agc.max = floor;
      this.lastBucket = bucket;
    }

    updateRunningMax(this.agc, this.smoothed, bands.bassRms, bands.midHiRms, this.tickMs);
    updateVolumeTable(this.volumeTable, bucket, this.smoothed);

    const rawBassNorm = normalizeBand(bands.bassRms, this.agc, 'bass');
    const rawMidHiNorm = normalizeBand(bands.midHiRms, this.agc, 'midHi');
    // Raw energy for palette modes — matches browser (50/50 weight, pre-smooth, pre-dynamics)
    const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;

    // Inline smoothing with pre-computed alphas
    this.smoothedBass += (rawBassNorm > this.smoothedBass ? sa : sr) * (rawBassNorm - this.smoothedBass);
    this.smoothedMidHi += (rawMidHiNorm > this.smoothedMidHi ? sa : sr) * (rawMidHiNorm - this.smoothedMidHi);

    // Onset detection (peak-picking on spectral flux)
    this.processOnset(bands.flux);
    const fluxBoost = (cal.transientBoost !== false) ? this.onsetBoost : 0;

    // Brightness
    let energyNorm = this.smoothedBass * cal.bassWeight + this.smoothedMidHi * (1 - cal.bassWeight);
    energyNorm = Math.min(1, energyNorm + fluxBoost);
    // Use pre-computed center alpha
    this.dynamicCenter += (energyNorm - this.dynamicCenter) * this._centerAlpha;
    energyNorm = applyDynamics(energyNorm, this.dynamicCenter, cal.dynamicDamping);

    const floor = cal.brightnessFloor ?? 0;
    let pct = Math.max(floor, energyNorm * 100);

    // Perceptual brightness curve (matches browser engine)
    if (cal.perceptualCurve) {
      if (pct > floor && pct < 100) {
        const norm = (pct - floor) / (100 - floor);
        const gamma = getDimmingGamma();
        pct = floor + Math.pow(norm, gamma) * (100 - floor);
      }
    }

    const sm = cal.smoothing ?? 0;
    if (sm > 0) {
      this.extraSmoothPct = extraSmooth(this.extraSmoothPct, pct, sm, this.tickMs);
      pct = this.extraSmoothPct;
    }
    // Clamp to 0-100 for BLE, then round
    pct = Math.round(Math.min(100, Math.max(floor, pct)));

    // ── Palette mode ──
    const pm = cal.paletteMode ?? 'off';
    if (pm !== 'off' && this._palette.length > 1) {
      const pLen = this._palette.length;

      if (pm === 'timed') {
        this._paletteTickCounter++;
        // Normalize speed for tick rate: speed is calibrated for 125ms ticks
        const speed = Math.max(1, Math.round((cal.paletteRotationSpeed ?? 8) * (125 / this.tickMs)));
        if (this._paletteTickCounter >= speed) {
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
        const idx = Math.min(pLen - 1, Math.floor(rawEnergy * pLen));
        this.color = this._palette[idx];

      } else if (pm === 'blend') {
        const clampedEnergy = Math.min(1, Math.max(0, rawEnergy));
        const pos = clampedEnergy * (pLen - 1);
        const lo = Math.floor(pos);
        const hi = Math.min(pLen - 1, lo + 1);
        const t = pos - lo;
        const cLo = this._palette[lo], cHi = this._palette[hi];
        this.color = [
          Math.round(cLo[0] + (cHi[0] - cLo[0]) * t),
          Math.round(cLo[1] + (cHi[1] - cLo[1]) * t),
          Math.round(cLo[2] + (cHi[2] - cLo[2]) * t),
        ];
      }
    }

    // Color
    const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;
    const finalColor = applyColorCalibration(this.color[0], this.color[1], this.color[2], cal);

    // BLE output
    if (isPunch) sendToBLE(255, 255, 255, pct);
    else sendToBLE(finalColor[0], finalColor[1], finalColor[2], pct);

    // Emit
    const data: TickData = {
      brightness: pct,
      color: finalColor,
      bassLevel: bands.bassRms,
      midHiLevel: bands.midHiRms,
      isPlaying: true,
      tickMs: this.tickMs,
      paletteIndex: this._paletteIndex,
    };
    for (const cb of this.callbacks) cb(data);
  }
}
