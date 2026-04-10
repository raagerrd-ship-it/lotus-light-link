/**
 * LightEngine — tick pipeline (pure computation + BLE output).
 * Zero-allocation hot path: reuses objects, uses precomputed constants.
 * All Math.pow calls are eliminated — values cached in TickConstants.
 */

import { sendToBLE } from "./bledom";
import { applyColorCalibrationFast } from "./lightCalibration";
import { computeBands, resetFluxState } from "./audioAnalysis";
import { updateRunningMaxFast, volumeToBucket, updateVolumeTable, getFloorForVolume, normalizeBand, createAgcState } from "./agc";
import { smoothFast, computeBrightnessPctFast, extraSmoothFast } from "./brightnessEngine";
import { advancePaletteFast } from "./paletteMixer";
import { sendIdleIfNeeded } from "./idleManager";
import { createOnsetState, detectOnsetFast, getOnsetBoost, resizeOnsetBuffer } from "./onsetDetector";
import { sanitizeState, refreshTickConstants, type EngineState, type TickData, type TickCallback } from "./lightEngineState";

// Reusable TickData object — mutated in place every tick (zero-alloc)
const _tickData: TickData = {
  brightness: 0,
  color: [0, 0, 0],
  baseColor: [0, 0, 0],
  bassLevel: 0,
  midHiLevel: 0,
  rawEnergyPct: 0,
  isPunch: false,
  bleColorSource: 'normal',
  micRms: 0,
  isPlaying: false,
  paletteIndex: 0,
  timings: { rmsMs: 0, smoothMs: 0, bleCallMs: 0, totalTickMs: 0 },
};

/** Run one tick of the audio→light pipeline. */
export function runTick(s: EngineState): void {
  try {
    tickInner(s);
  } catch (e) {
    console.error('[LightEngine] tick error (recovering):', e);
    sanitizeState(s);
  }
}

/** Emit tick data to all registered callbacks. */
export function emitTick(s: EngineState, data: TickData): void {
  const cbs = s.tickCallbacks;
  for (let i = 0, len = cbs.length; i < len; i++) cbs[i](data);
}

/** Reset smoothing state (e.g. on manual recalibration). AGC table persists. */
export function resetSmoothing(s: EngineState): void {
  s.smoothed = 0;
  s.smoothedBass = 0;
  s.smoothedMidHi = 0;
  s.dynamicCenter = 0.5;
  s.extraSmoothPct = 0;
  s.onset = createOnsetState(s.tickMs);
  resetFluxState();
  const bucket = volumeToBucket(s.volume);
  const floor = getFloorForVolume(s.volumeTable, bucket);
  s.agc = createAgcState(floor);
  s.lastBucket = bucket;
  refreshTickConstants(s);
}

/** Resize onset buffer when tick rate changes. */
export { resizeOnsetBuffer };

// ── Internal ──

function tickInner(s: EngineState): void {
  if (s.stopped) return;

  // ── Idle mode ──
  if (!s.playing) {
    if (!s.idle.idleSent) {
      s.idle.idleSent = sendIdleIfNeeded(s.idle, s.cal, s.chars.size > 0, d => emitTick(s, d));
    }
    s.worker?.postMessage('stop');
    return;
  }
  s.idle.idleSent = false;

  const an = s.analyser;
  if (!an || !s.freqBuf) return;

  const tickStart = performance.now();
  const cal = s.cal;
  const agc = s.agc;
  const tc = s.tc;

  // ── FFT ──
  const bands = computeBands(an, s.freqBuf);

  // ── Smoothing (precomputed alphas — no Math.pow) ──
  const atkAlpha = bands.totalRms > s.smoothed ? tc.attackAlpha : tc.releaseAlpha;
  s.smoothed = s.smoothed + atkAlpha * (bands.totalRms - s.smoothed);

  // ── Volume bucket & AGC update ──
  const bucket = volumeToBucket(s.volume);
  if (bucket !== s.lastBucket) {
    const floor = getFloorForVolume(s.volumeTable, bucket);
    if (floor > agc.max) agc.max = floor;
    s.lastBucket = bucket;
  }
  updateRunningMaxFast(agc, s.smoothed, bands.bassRms, bands.midHiRms, tc);
  updateVolumeTable(s.volumeTable, bucket, s.smoothed);

  // Normalize bands
  const rawBassNorm = normalizeBand(bands.bassRms, agc, 'bass');
  const rawMidHiNorm = normalizeBand(bands.midHiRms, agc, 'midHi');
  const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;

  // ── Per-band smoothing (inlined — no function call overhead) ──
  const bassAlpha = rawBassNorm > s.smoothedBass ? tc.attackAlpha : tc.releaseAlpha;
  s.smoothedBass = s.smoothedBass + bassAlpha * (rawBassNorm - s.smoothedBass);
  const midHiAlpha = rawMidHiNorm > s.smoothedMidHi ? tc.attackAlpha : tc.releaseAlpha;
  s.smoothedMidHi = s.smoothedMidHi + midHiAlpha * (rawMidHiNorm - s.smoothedMidHi);

  // ── Onset detection (precomputed constants) ──
  detectOnsetFast(s.onset, bands.flux, tc);
  const fluxBoost = (cal.transientBoost !== false) ? getOnsetBoost(s.onset) : 0;

  // ── Brightness (precomputed centerAlpha) ──
  let { pct, newCenter } = computeBrightnessPctFast(
    s.smoothedBass, s.smoothedMidHi,
    100, s.dynamicCenter, cal, fluxBoost, tc,
  );
  s.dynamicCenter = newCenter;

  // ── Extra smoothing (precomputed alpha) ──
  const sm = cal.smoothing ?? 0;
  if (sm > 0) {
    s.extraSmoothPct = s.extraSmoothPct + (1 - tc.extraSmoothAlpha) * (pct - s.extraSmoothPct);
    pct = s.extraSmoothPct;
  }
  pct = (pct + 0.5) | 0; // fast round

  // ── Palette mode (precomputed speed) ──
  const pm = cal.paletteMode ?? 'off';
  const paletteResult = advancePaletteFast(
    s.palette, s.paletteState, pm, tc.paletteTimedSpeed,
    s.smoothedBass, rawEnergy,
  );
  if (paletteResult) {
    s.color = paletteResult.color;
    s.paletteState = paletteResult.state;
  }

  // ── Resolve colors ──
  const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;
  const finalColor = applyColorCalibrationFast(s.color[0], s.color[1], s.color[2], cal, tc.gammaIsUnity);
  const bleSentR = finalColor[0], bleSentG = finalColor[1], bleSentB = finalColor[2];
  s.lastBaseColor[0] = bleSentR;
  s.lastBaseColor[1] = bleSentG;
  s.lastBaseColor[2] = bleSentB;

  // ── BLE output ──
  if (s.chars.size > 0) {
    if (isPunch) sendToBLE(255, 255, 255, pct);
    else sendToBLE(bleSentR, bleSentG, bleSentB, pct);
  }
  const tickEnd = performance.now();

  // ── Emit tick data (reuse object) ──
  const td = _tickData;
  td.brightness = pct;
  td.color[0] = bleSentR; td.color[1] = bleSentG; td.color[2] = bleSentB;
  td.baseColor[0] = bleSentR; td.baseColor[1] = bleSentG; td.baseColor[2] = bleSentB;
  td.bassLevel = bands.bassRms;
  td.midHiLevel = bands.midHiRms;
  td.rawEnergyPct = (rawEnergy * 100 + 0.5) | 0;
  td.isPunch = isPunch;
  td.bleColorSource = 'normal';
  td.micRms = s.smoothed;
  td.isPlaying = s.playing;
  td.paletteIndex = s.paletteState.index;
  td.timings.totalTickMs = tickEnd - tickStart;
  td.timings.rmsMs = 0;
  td.timings.smoothMs = 0;
  td.timings.bleCallMs = 0;

  s.lastTickData = td;
  emitTick(s, td);
}
