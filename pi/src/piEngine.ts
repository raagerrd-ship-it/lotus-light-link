/**
 * PiLightEngine — headless audio→light pipeline for Raspberry Pi.
 * Reimplements LightEngine using ALSA mic + noble BLE.
 * Core math (AGC, brightness, smoothing) imported from shared engine.
 */

import { getLatestBands, resetFluxState, setHiShelfGain } from './alsaMic.js';
import { sendToBLE, bleStats } from './nobleBle.js';
import { getItem, setItem } from './storage.js';

// ── Inline engine math (avoid complex path aliasing to browser engine) ──
// These are copied from the browser engine's pure-math modules.
// On update, sync from src/lib/engine/*.ts

// --- AGC ---
const AGC_FLOOR = 0.002;
const AGC_MAX_DECAY = 0.9998;
const AGC_QUIET_DECAY_MEDIUM = 0.998;
const AGC_QUIET_DECAY_FAST = 0.99;
const QUIET_THRESHOLD_RATIO = 0.10;
const QUIET_TICKS_MEDIUM = 16;
const QUIET_TICKS_FAST = 40;
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

function updateRunningMax(state: AgcState, smoothed: number, bassRms: number, midHiRms: number): void {
  const isQuiet = smoothed < state.max * QUIET_THRESHOLD_RATIO;
  if (isQuiet) state.quietTicks++; else state.quietTicks = 0;
  const decay = state.quietTicks >= QUIET_TICKS_FAST ? AGC_QUIET_DECAY_FAST
    : state.quietTicks >= QUIET_TICKS_MEDIUM ? AGC_QUIET_DECAY_MEDIUM : AGC_MAX_DECAY;
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
function smooth(prev: number, raw: number, attackAlpha: number, releaseAlpha: number): number {
  const alpha = raw > prev ? attackAlpha : releaseAlpha;
  return prev + alpha * (raw - prev);
}

function extraSmooth(prev: number, newVal: number, smoothing: number): number {
  if (smoothing <= 0) return newVal;
  const alpha = Math.exp(-smoothing * 0.04);
  return prev + alpha * (newVal - prev);
}

function applyDynamics(energyNorm: number, center: number, dynamicDamping: number): number {
  let result = energyNorm;
  if (dynamicDamping > 0) {
    const amount = Math.min(1, dynamicDamping / 2);
    const exponent = 1 / (1 + amount * 4);
    const range = result >= center ? (1 - center) || 0.5 : center || 0.5;
    const normalized = (result - center) / range;
    const expanded = Math.sign(normalized) * Math.pow(Math.abs(normalized), exponent);
    const softLimit = 1.2 + amount * 0.8;
    const softened = Math.tanh(expanded * softLimit) / Math.tanh(softLimit);
    result = center + softened * range;
  } else if (dynamicDamping < 0) {
    const amount = Math.min(1, Math.abs(dynamicDamping) / 3);
    const compression = 1 / (1 + amount * 4);
    result = center + (result - center) * compression;
  }
  return Math.max(0, Math.min(1, result));
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
  isPlaying: boolean;
  tickMs: number;
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
  private smoothedFlux = 0;
  private fluxMax = 0.001;
  private agc: AgcState;
  private cal: LightCalibration;
  private volumeTable: AgcVolumeTable;
  private lastBucket = 0;
  private idleSent = false;

  private timer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private callbacks: TickCallback[] = [];

  constructor(tickMs = 30) {
    this.tickMs = tickMs;
    this.cal = loadCalibration();
    this.volumeTable = { ...this.cal.agcVolumeTable };
    this.agc = createAgcState(0.01);
    setHiShelfGain(this.cal.hiShelfGainDb);
  }

  onTick(cb: TickCallback): () => void {
    this.callbacks.push(cb);
    return () => { this.callbacks = this.callbacks.filter(c => c !== cb); };
  }

  setColor(rgb: [number, number, number]) { this.color = rgb; }
  setPalette(palette: [number, number, number][]) { this._palette = palette; this._paletteIndex = 0; }
  private _palette: [number, number, number][] = [];
  private _paletteIndex = 0;
  private _paletteTickCounter = 0;
  private _bassWasHigh = false;
  setVolume(vol: number | undefined) { this.volume = vol; }
  setTickMs(ms: number) { this.tickMs = ms; }

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
    setHiShelfGain(this.cal.hiShelfGainDb);
  }

  start(): void {
    if (this.timer) return;

    const bucket = volumeToBucket(this.volume);
    const floor = getFloorForVolume(this.volumeTable, bucket);
    this.agc = createAgcState(floor);
    this.lastBucket = bucket;

    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.saveTimer = setInterval(() => {
      const updated = { ...this.cal, agcVolumeTable: { ...this.volumeTable } };
      this.cal = updated;
      saveCalibration(updated);
    }, 10_000);

    console.log(`[Engine] Started (${this.tickMs}ms tick = ${Math.round(1000 / this.tickMs)} Hz)`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    console.log('[Engine] Stopped');
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

    // Smoothing
    this.smoothed = smooth(this.smoothed, bands.totalRms, cal.attackAlpha, cal.releaseAlpha);

    // Volume bucket
    const bucket = volumeToBucket(this.volume);
    if (bucket !== this.lastBucket) {
      const floor = getFloorForVolume(this.volumeTable, bucket);
      if (floor > this.agc.max) this.agc.max = floor;
      this.lastBucket = bucket;
    }

    updateRunningMax(this.agc, this.smoothed, bands.bassRms, bands.midHiRms);
    updateVolumeTable(this.volumeTable, bucket, this.smoothed);

    const rawBassNorm = normalizeBand(bands.bassRms, this.agc, 'bass');
    const rawMidHiNorm = normalizeBand(bands.midHiRms, this.agc, 'midHi');

    this.smoothedBass = smooth(this.smoothedBass, rawBassNorm, cal.attackAlpha, cal.releaseAlpha);
    this.smoothedMidHi = smooth(this.smoothedMidHi, rawMidHiNorm, cal.attackAlpha, cal.releaseAlpha);

    // Spectral flux
    if (bands.flux > this.fluxMax) this.fluxMax = bands.flux;
    else this.fluxMax *= 0.999;
    const fluxNorm = Math.min(1, bands.flux / Math.max(this.fluxMax, 0.0001));
    this.smoothedFlux = smooth(this.smoothedFlux, fluxNorm, 0.5, 0.1);
    const fluxBoost = cal.transientBoost ? this.smoothedFlux * 0.15 : 0;

    // Brightness
    let energyNorm = this.smoothedBass * cal.bassWeight + this.smoothedMidHi * (1 - cal.bassWeight);
    energyNorm = Math.min(1, energyNorm + fluxBoost);
    this.dynamicCenter += (energyNorm - this.dynamicCenter) * 0.008;
    energyNorm = applyDynamics(energyNorm, this.dynamicCenter, cal.dynamicDamping);

    const floor = cal.brightnessFloor ?? 0;
    let pct = Math.max(floor, energyNorm * 100);

    const sm = cal.smoothing ?? 0;
    if (sm > 0) {
      this.extraSmoothPct = extraSmooth(this.extraSmoothPct, pct, sm);
      pct = this.extraSmoothPct;
    }
    pct = Math.round(pct);

    // ── Palette mode ──
    const pm = cal.paletteMode ?? 'off';
    if (pm !== 'off' && this._palette.length > 1) {
      const pLen = this._palette.length;

      if (pm === 'timed') {
        this._paletteTickCounter++;
        const speed = Math.max(1, cal.paletteRotationSpeed ?? 8);
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
        const idx = Math.min(pLen - 1, Math.floor(energyNorm * pLen));
        this.color = this._palette[idx];

      } else if (pm === 'blend') {
        const pos = energyNorm * (pLen - 1);
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
