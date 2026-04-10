// Automatic Gain Control — volume→max lookup table, no learn/lock phases

import type { TickConstants } from "./tickConstants";

export const AGC_FLOOR = 0.002;

// Per-second decay rates (tick-rate independent).
const AGC_MAX_DECAY_PER_SEC = 0.99840;
const AGC_QUIET_DECAY_MEDIUM_PER_SEC = 0.98410;
const AGC_QUIET_DECAY_FAST_PER_SEC = 0.92274;
const QUIET_THRESHOLD_RATIO = 0.10;
/** Time-based quiet thresholds (ms) — converted to ticks dynamically */
export const QUIET_MS_MEDIUM = 2000;
export const QUIET_MS_FAST = 5000;

/** Convert ms-based quiet thresholds to tick counts */
export function quietTickThresholds(tickMs: number): { medium: number; fast: number } {
  return {
    medium: Math.round(QUIET_MS_MEDIUM / tickMs),
    fast: Math.round(QUIET_MS_FAST / tickMs),
  };
}
export const BUCKET_SIZE = 5;

export type AgcVolumeTable = Record<number, number>;

export interface AgcState {
  max: number;
  min: number;
  bassMax: number;
  bassMin: number;
  midHiMax: number;
  midHiMin: number;
  /** Consecutive quiet ticks counter for accelerated decay */
  quietTicks: number;
}

export function createAgcState(initialMax = 0.01): AgcState {
  return {
    max: initialMax > 0 ? initialMax : 0.01,
    min: 0,
    bassMax: 0.01,
    bassMin: 0,
    midHiMax: 0.01,
    midHiMin: 0,
    quietTicks: 0,
  };
}

/** Convert a volume (0–100) to its bucket index */
export function volumeToBucket(volume: number | undefined): number {
  if (volume == null || volume <= 0) return 0;
  return Math.floor(Math.min(100, volume) / BUCKET_SIZE);
}

/** Update the volume table with a new observed peak for the given bucket */
export function updateVolumeTable(table: AgcVolumeTable, bucket: number, value: number): void {
  if (value > (table[bucket] ?? 0)) {
    table[bucket] = value;
  }
}

/** Get the historical floor for a volume bucket. Interpolates from nearest known if bucket is empty. */
export function getFloorForVolume(table: AgcVolumeTable, bucket: number): number {
  if (table[bucket] != null) return table[bucket];

  let nearestBucket: number | null = null;
  let nearestDist = Infinity;
  for (const key of Object.keys(table)) {
    const b = Number(key);
    const dist = Math.abs(b - bucket);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestBucket = b;
    }
  }

  if (nearestBucket == null) return 0.01;

  const nearestVol = (nearestBucket * BUCKET_SIZE) || 1;
  const currentVol = (bucket * BUCKET_SIZE) || 1;
  return Math.max(AGC_FLOOR, table[nearestBucket] * (currentVol / nearestVol));
}

/** Original updateRunningMax — kept for standalone/test use. */
export function updateRunningMax(
  state: AgcState,
  smoothed: number,
  bassRms: number,
  midHiRms: number,
  tickMs: number = 125,
): void {
  const isQuiet = smoothed < state.max * QUIET_THRESHOLD_RATIO;
  if (isQuiet) state.quietTicks++;
  else state.quietTicks = 0;

  const { medium, fast } = quietTickThresholds(tickMs);
  const decayPerSec = state.quietTicks >= fast
    ? AGC_QUIET_DECAY_FAST_PER_SEC
    : state.quietTicks >= medium
      ? AGC_QUIET_DECAY_MEDIUM_PER_SEC
      : AGC_MAX_DECAY_PER_SEC;
  const decay = Math.pow(decayPerSec, tickMs / 1000);

  applyDecay(state, smoothed, bassRms, midHiRms, decay);
}

/** Fast version using precomputed decay rates — zero Math.pow. */
export function updateRunningMaxFast(
  state: AgcState,
  smoothed: number,
  bassRms: number,
  midHiRms: number,
  tc: TickConstants,
): void {
  const isQuiet = smoothed < state.max * QUIET_THRESHOLD_RATIO;
  if (isQuiet) state.quietTicks++;
  else state.quietTicks = 0;

  const decay = state.quietTicks >= tc.quietFastTicks
    ? tc.agcDecayFast
    : state.quietTicks >= tc.quietMediumTicks
      ? tc.agcDecayMedium
      : tc.agcDecayNormal;

  applyDecay(state, smoothed, bassRms, midHiRms, decay);
}

/** Shared decay logic */
function applyDecay(state: AgcState, smoothed: number, bassRms: number, midHiRms: number, decay: number): void {
  if (smoothed > state.max) state.max = smoothed;
  else state.max = Math.max(AGC_FLOOR, state.max * decay);

  if (bassRms > state.bassMax) state.bassMax = bassRms;
  else state.bassMax = Math.max(AGC_FLOOR, state.bassMax * decay);

  if (bassRms < state.bassMin || state.bassMin === 0) state.bassMin = bassRms;

  if (midHiRms > state.midHiMax) state.midHiMax = midHiRms;
  else state.midHiMax = Math.max(AGC_FLOOR, state.midHiMax * decay);

  if (midHiRms < state.midHiMin || state.midHiMin === 0) state.midHiMin = midHiRms;
}

/** Rescale all AGC levels proportionally (e.g. after volume change) */
export function rescaleAgc(state: AgcState, ratio: number): void {
  state.max = Math.max(AGC_FLOOR, state.max * ratio);
  state.min = Math.max(0, state.min * ratio);
  state.bassMax = Math.max(AGC_FLOOR, state.bassMax * ratio);
  state.bassMin = Math.max(0, state.bassMin * ratio);
  state.midHiMax = Math.max(AGC_FLOOR, state.midHiMax * ratio);
  state.midHiMin = Math.max(0, state.midHiMin * ratio);
}

/** Normalize a value using global AGC range */
export function normalizeValue(value: number, state: AgcState): number {
  const range = Math.max(AGC_FLOOR, state.max - state.min);
  return Math.min(1, Math.max(0, (value - state.min) / range));
}

/** Normalize a band value using its learned peak range */
export function normalizeBand(value: number, state: AgcState, band: 'bass' | 'midHi'): number {
  const max = band === 'bass' ? state.bassMax : state.midHiMax;
  const min = band === 'bass' ? state.bassMin : state.midHiMin;
  const range = Math.max(AGC_FLOOR, max - min);
  return Math.min(1, Math.max(0, (value - min) / range));
}

/** Create an empty volume table */
export function createVolumeTable(): AgcVolumeTable {
  return {};
}

/** Migrate old agcMax/agcVolume to a volume table entry */
export function migrateToVolumeTable(
  oldMax: number,
  oldVolume: number | null,
): AgcVolumeTable {
  const table: AgcVolumeTable = {};
  if (oldMax > AGC_FLOOR && oldVolume != null && oldVolume > 0) {
    const bucket = volumeToBucket(oldVolume);
    table[bucket] = oldMax;
  }
  return table;
}
