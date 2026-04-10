/**
 * LightEngine — tick pipeline (pure computation + BLE output).
 * No lifecycle, no DOM listeners — just the per-tick processing.
 */

import { sendToBLE } from "./bledom";
import { applyColorCalibration } from "./lightCalibration";
import { computeBands, resetFluxState } from "./audioAnalysis";
import { updateRunningMax, volumeToBucket, updateVolumeTable, getFloorForVolume, normalizeBand, createAgcState } from "./agc";
import { smooth, computeBrightnessPct, extraSmooth } from "./brightnessEngine";
import { advancePalette } from "./paletteMixer";
import { sendIdleIfNeeded } from "./idleManager";
import { createOnsetState, detectOnset, getOnsetBoost, resizeOnsetBuffer } from "./onsetDetector";
import { sanitizeState, type EngineState, type TickData, type TickCallback } from "./lightEngineState";

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
  for (const cb of s.tickCallbacks) cb(data);
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

  // ── FFT ──
  const bands = computeBands(an, s.freqBuf);
  const rmsEnd = performance.now();

  // ── Smoothing ──
  s.smoothed = smooth(s.smoothed, bands.totalRms, cal.attackAlpha, cal.releaseAlpha, s.tickMs);

  // ── Volume bucket & AGC update ──
  const bucket = volumeToBucket(s.volume);
  if (bucket !== s.lastBucket) {
    const floor = getFloorForVolume(s.volumeTable, bucket);
    if (floor > agc.max) agc.max = floor;
    s.lastBucket = bucket;
  }
  updateRunningMax(agc, s.smoothed, bands.bassRms, bands.midHiRms, s.tickMs);
  updateVolumeTable(s.volumeTable, bucket, s.smoothed);

  // Normalize bands
  const rawBassNorm = normalizeBand(bands.bassRms, agc, 'bass');
  const rawMidHiNorm = normalizeBand(bands.midHiRms, agc, 'midHi');
  const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;
  const rawEnergyPct = Math.round(rawEnergy * 100);

  // ── Per-band smoothing ──
  s.smoothedBass = smooth(s.smoothedBass, rawBassNorm, cal.attackAlpha, cal.releaseAlpha, s.tickMs);
  s.smoothedMidHi = smooth(s.smoothedMidHi, rawMidHiNorm, cal.attackAlpha, cal.releaseAlpha, s.tickMs);

  // ── Onset detection ──
  detectOnset(s.onset, bands.flux, s.tickMs);
  const fluxBoost = (cal.transientBoost !== false) ? getOnsetBoost(s.onset) : 0;

  // ── Brightness ──
  let { pct, newCenter } = computeBrightnessPct(
    s.smoothedBass, s.smoothedMidHi,
    100, s.dynamicCenter, cal,
    fluxBoost, s.tickMs,
  );
  s.dynamicCenter = newCenter;

  // ── Extra smoothing ──
  const sm = cal.smoothing ?? 0;
  if (sm > 0) {
    s.extraSmoothPct = extraSmooth(s.extraSmoothPct, pct, sm, s.tickMs);
    pct = s.extraSmoothPct;
  }
  pct = Math.round(pct);

  // ── Palette mode ──
  const pm = cal.paletteMode ?? 'off';
  const paletteResult = advancePalette(
    s.palette, s.paletteState, pm, cal,
    s.smoothedBass, rawEnergy, s.tickMs,
  );
  if (paletteResult) {
    s.color = paletteResult.color;
    s.paletteState = paletteResult.state;
  }

  // ── Resolve colors ──
  const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;
  const finalColor = applyColorCalibration(...s.color, cal);
  const bleSentR = finalColor[0], bleSentG = finalColor[1], bleSentB = finalColor[2];
  s.lastBaseColor = [bleSentR, bleSentG, bleSentB];

  // ── BLE output ──
  const smoothEnd = performance.now();
  if (s.chars.size > 0) {
    if (isPunch) sendToBLE(255, 255, 255, pct);
    else sendToBLE(bleSentR, bleSentG, bleSentB, pct);
  }
  const bleEnd = performance.now();

  // ── Emit tick data ──
  const tickData: TickData = {
    brightness: pct,
    color: [bleSentR, bleSentG, bleSentB],
    baseColor: s.lastBaseColor,
    bassLevel: bands.bassRms,
    midHiLevel: bands.midHiRms,
    rawEnergyPct,
    isPunch,
    bleColorSource: 'normal',
    micRms: s.smoothed,
    isPlaying: s.playing,
    paletteIndex: s.paletteState.index,
    timings: {
      rmsMs: rmsEnd - tickStart,
      smoothMs: smoothEnd - rmsEnd,
      bleCallMs: bleEnd - smoothEnd,
      totalTickMs: bleEnd - tickStart,
    },
  };
  s.lastTickData = tickData;
  emitTick(s, tickData);
}
