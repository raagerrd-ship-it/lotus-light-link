/**
 * LightEngine — shared state type and factory.
 * All mutable engine state lives in this plain object so it can be
 * passed between lifecycle and tick-pipeline modules without `this`.
 */

import { getCalibration, type LightCalibration } from "./lightCalibration";
import { createAgcState, type AgcState, type AgcVolumeTable } from "./agc";
import { createPaletteState, type PaletteState } from "./paletteMixer";
import { createIdleState, type IdleState } from "./idleManager";
import { createOnsetState, type OnsetState } from "./onsetDetector";

export const DEFAULT_TICK_MS = 125;

export interface TickData {
  brightness: number;
  color: [number, number, number];
  baseColor: [number, number, number];
  bassLevel: number;
  midHiLevel: number;
  rawEnergyPct: number;
  isPunch: boolean;
  bleColorSource: 'normal' | 'idle';
  micRms: number;
  isPlaying: boolean;
  paletteIndex: number;
  /** Pipeline timing in ms */
  timings: { rmsMs: number; smoothMs: number; bleCallMs: number; totalTickMs: number };
}

export type TickCallback = (data: TickData) => void;

/** All mutable state that the engine carries between ticks. */
export interface EngineState {
  // Public-facing props (set by UI)
  color: [number, number, number];
  palette: [number, number, number][];
  paletteState: PaletteState;
  volume: number | undefined;
  playing: boolean;
  chars: Set<BluetoothRemoteGATTCharacteristic>;
  tickMs: number;

  // Audio nodes
  analyser: AnalyserNode | null;
  freqBuf: Float32Array<ArrayBuffer> | null;
  hiShelf: BiquadFilterNode | null;

  // Smoothing
  smoothed: number;
  smoothedBass: number;
  smoothedMidHi: number;
  dynamicCenter: number;
  extraSmoothPct: number;

  // AGC
  agc: AgcState;
  cal: LightCalibration;
  volumeTable: AgcVolumeTable;
  lastBucket: number;

  // Onset
  onset: OnsetState;

  // Idle
  idle: IdleState;

  // Misc
  lastBaseColor: [number, number, number];
  lastTickData: TickData | null;

  // Lifecycle handles
  worker: Worker | null;
  stream: MediaStream | null;
  audioCtx: AudioContext | null;
  agcSaveTimer: number;
  stopped: boolean;
  tickCallbacks: TickCallback[];
  idleCleanup: (() => void) | null;
  calCleanup: (() => void) | null;
}

/** Create a fresh engine state with sensible defaults. */
export function createEngineState(): EngineState {
  const cal = getCalibration();
  return {
    color: [255, 80, 0],
    palette: [],
    paletteState: createPaletteState(),
    volume: undefined,
    playing: true,
    chars: new Set(),
    tickMs: DEFAULT_TICK_MS,

    analyser: null,
    freqBuf: null,
    hiShelf: null,

    smoothed: 0,
    smoothedBass: 0,
    smoothedMidHi: 0,
    dynamicCenter: 0.5,
    extraSmoothPct: 0,

    agc: createAgcState(0.01),
    cal,
    volumeTable: { ...cal.agcVolumeTable },
    lastBucket: 0,

    onset: createOnsetState(),
    idle: createIdleState(),

    lastBaseColor: [0, 0, 0],
    lastTickData: null,

    worker: null,
    stream: null,
    audioCtx: null,
    agcSaveTimer: 0,
    stopped: false,
    tickCallbacks: [],
    idleCleanup: null,
    calCleanup: null,
  };
}

/** Guard against NaN/Infinity corrupting smoothing state. */
export function sanitizeState(s: EngineState): void {
  if (!Number.isFinite(s.smoothed)) s.smoothed = 0;
  if (!Number.isFinite(s.smoothedBass)) s.smoothedBass = 0;
  if (!Number.isFinite(s.smoothedMidHi)) s.smoothedMidHi = 0;
  if (!Number.isFinite(s.dynamicCenter)) s.dynamicCenter = 0.5;
  if (!Number.isFinite(s.extraSmoothPct)) s.extraSmoothPct = 0;
}

/** Reset state to factory defaults (for destroy). */
export function resetEngineState(s: EngineState): void {
  s.tickCallbacks = [];
  s.color = [255, 80, 0];
  s.palette = [];
  s.paletteState = createPaletteState();
  s.volume = undefined;
  s.playing = true;
  s.chars.clear();
  s.smoothed = 0;
  s.smoothedBass = 0;
  s.smoothedMidHi = 0;
  s.dynamicCenter = 0.5;
  s.extraSmoothPct = 0;
  s.onset = createOnsetState();
  s.agc = createAgcState(0.01);
  s.volumeTable = {};
  s.lastBaseColor = [0, 0, 0];
  s.lastBucket = 0;
  s.idle = createIdleState();
  s.lastTickData = null;
}
