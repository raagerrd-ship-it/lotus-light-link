/**
 * seqRender — offline-renderare som mappar inspelade FFT-analys-frames (100Hz)
 * till ljus-frames [tMs, pct, r, g, b] med EXAKT samma band→ljus-matte som
 * enginens reaktiva tick. Skillnaden mot live: ingen rate-limit, ingen
 * "no-change"-gallring och full 100Hz-upplösning — så vi kan finslipa hårdare
 * i efterhand utan att Pi Zero 2W behöver räkna det i realtid.
 *
 * Analys-frame (oskalad): [tMs, bassRms, midHiRms, totalRms, flux, r, g, b]
 * där r/g/b är den (redan kalibrerade) palette-färgen enginen skickade.
 */

import {
  normalizeFixed,
  computeTickConstants,
  applyDynamics,
  type LightCalibration,
} from './piEngine.js';

export type AnalysisFrame = number[]; // [tMs, bass, midHi, total, flux, r, g, b]
type LightFrame = number[];           // [tMs, pct, r, g, b]

const FRAME_MS = 10; // HOP_SIZE=480 @ 48kHz → 100Hz FFT-takt

export function renderLightFromAnalysis(
  frames: AnalysisFrame[],
  cal: LightCalibration,
): LightFrame[] {
  const n = frames.length;
  if (n === 0) return [];

  // tickMs=10 → attack/release-alfor skalas till 100Hz. FFT-baserade alfor
  // (onset/center) är redan beräknade för 100Hz i computeTickConstants.
  const tc = computeTickConstants(FRAME_MS, cal);

  // ── Onset-state (replikerar engine.processOnset @100Hz, utan express-path) ──
  const onsetSize = Math.max(3, Math.round(175 / FRAME_MS));
  const buf = new Float64Array(onsetSize);
  const srt = new Float64Array(onsetSize);
  let onsetPos = 0, onsetPrevFlux = 0, onsetBoost = 0, onsetTarget = 0;
  let onsetFrame = 0, onsetLast = -1_000_000;
  const refractoryFrames = Math.max(1, Math.round(cal.onsetRefractoryMs / FRAME_MS));

  let smoothed = 0;
  let dynamicCenter = 0.5;
  let lastSentPct = -1;

  const w = cal.bassWeight;
  const bassGain = w, midHiGain = 1 - w;
  const energyFloor = cal.onsetEnergyFloor ?? 0;
  const tickFloor = cal.tickEnergyFloor ?? 0;
  const transientGain = tc.transientGain;
  const floor = tc.brightnessFloor;
  const pGamma = tc.perceptualGamma;

  const out: LightFrame[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const fr = frames[i];
    const tMs = fr[0], bassRms = fr[1], midHiRms = fr[2], totalRms = fr[3], flux = fr[4];
    const r = fr[5] ?? 255, g = fr[6] ?? 255, b = fr[7] ?? 255;

    const peakBand = Math.max(bassRms, midHiRms);
    const passesEnergyGate =
      energyFloor <= 0 || (Number.isFinite(peakBand) && peakBand >= energyFloor);

    // ── dynamicCenter @100Hz (energy-gated) ──
    if (tc.dynamicsEnabled && Number.isFinite(totalRms) && passesEnergyGate) {
      const bN = normalizeFixed(bassRms);
      const mN = normalizeFixed(midHiRms);
      const raw = bN * 0.5 + mN * 0.5;
      dynamicCenter += tc.centerAlphaFft * (raw - dynamicCenter);
      if (dynamicCenter < 0.2) dynamicCenter = 0.2;
      else if (dynamicCenter > 0.7) dynamicCenter = 0.7;
    }

    // ── Onset @100Hz ──
    onsetFrame++;
    if (passesEnergyGate) {
      buf[onsetPos] = flux;
      onsetPos = (onsetPos + 1) % onsetSize;
      for (let k = 0; k < onsetSize; k++) srt[k] = buf[k];
      for (let k = 1; k < onsetSize; k++) {
        const v = srt[k]; let j = k - 1;
        while (j >= 0 && srt[j] > v) { srt[j + 1] = srt[j]; j--; }
        srt[j + 1] = v;
      }
      const midI = onsetSize >> 1;
      const med = (onsetSize & 1) ? srt[midI] : (srt[midI - 1] + srt[midI]) * 0.5;
      const suppression = dynamicCenter > 0.5 ? 1 + (dynamicCenter - 0.5) * 1.5 : 1;
      const threshold = med * cal.onsetThreshold * suppression + 0.008;
      const isCandidate = flux > threshold && flux >= onsetPrevFlux;
      onsetPrevFlux = flux;
      if (isCandidate && (onsetFrame - onsetLast) >= refractoryFrames) {
        onsetTarget = 0.45;
        onsetLast = onsetFrame;
      }
    }
    if (onsetBoost < onsetTarget) {
      onsetBoost += tc.onsetRiseAlphaFft * (onsetTarget - onsetBoost);
    } else {
      onsetBoost *= tc.onsetDecayFft;
    }
    onsetTarget *= tc.onsetDecayFft;
    if (onsetBoost < 0.001) { onsetBoost = 0; onsetTarget = 0; }

    // ── Energi-mix + smoothing + dynamics + transient (samma som tickInner) ──
    const bassNorm = normalizeFixed(bassRms);
    const midHiNorm = normalizeFixed(midHiRms);
    let energyNorm = bassNorm * bassGain + midHiNorm * midHiGain;

    const inSilence = tickFloor > 0 && peakBand < tickFloor;
    if (inSilence) energyNorm = 0;

    const alpha = inSilence
      ? tc.releaseAlpha
      : (energyNorm > smoothed ? tc.attackAlpha : tc.releaseAlpha);
    smoothed = smoothed + alpha * (energyNorm - smoothed);
    energyNorm = smoothed;

    if (tc.dynamicsEnabled) {
      energyNorm = applyDynamics(energyNorm, dynamicCenter, cal.dynamicDamping);
    }

    const fluxBoost = (transientGain > 0 && !inSilence) ? onsetBoost * transientGain : 0;
    energyNorm += fluxBoost;
    if (energyNorm > 1) energyNorm = 1;
    if (inSilence) {
      onsetBoost *= 0.5;
      if (onsetBoost < 0.001) { onsetBoost = 0; onsetTarget = 0; }
    }

    // ── Floor + perceptual curve ──
    let pct = energyNorm * 100;
    if (pct < floor) pct = floor;
    if (pGamma > 0 && pct > floor && pct < 100) {
      const norm = (pct - floor) / (100 - floor);
      pct = floor + (norm > 0.0001 ? Math.exp(pGamma * Math.log(norm)) : 0) * (100 - floor);
    }
    pct = (pct + 0.5) | 0;
    if (pct > 100) pct = 100;
    if (pct < floor) pct = floor;

    // ── Anti-flicker deadband (samma Weber-Fechner-skala som live) ──
    if (lastSentPct >= 0 && cal.flickerDeadband > 0) {
      const deadbandPct = cal.flickerDeadband * 100 * (0.5 + pct / 100);
      if (Math.abs(pct - lastSentPct) < deadbandPct) pct = lastSentPct;
    }
    lastSentPct = pct;

    const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;
    out[i] = isPunch
      ? [tMs | 0, pct, 255, 255, 255]
      : [tMs | 0, pct, r | 0, g | 0, b | 0];
  }

  return out;
}
