/**
 * Idle state management — extracted from LightEngine.
 * Handles transition to/from idle color when playback stops.
 */

import { sendToBLE } from "./bledom";
import { applyColorCalibration, getIdleColor, type LightCalibration } from "./lightCalibration";
import type { TickData, TickCallback } from "./lightEngine";

export interface IdleState {
  idleSent: boolean;
  idleColor: [number, number, number];
}

export function createIdleState(): IdleState {
  return {
    idleSent: false,
    idleColor: getIdleColor(),
  };
}

/** Send idle color to BLE and emit idle tick. Returns updated idleSent. */
export function sendIdleIfNeeded(
  idle: IdleState,
  cal: LightCalibration,
  hasChars: boolean,
  emit: (data: TickData) => void,
): boolean {
  if (idle.idleSent) return true;
  if (!hasChars) {
    // Still emit for UI even without BLE
    emit(createIdleTick(idle.idleColor));
    return true;
  }

  const calibrated = applyColorCalibration(...idle.idleColor, cal);
  sendToBLE(calibrated[0], calibrated[1], calibrated[2], 100);
  emit(createIdleTick(idle.idleColor));
  return true;
}

function createIdleTick(color: [number, number, number]): TickData {
  return {
    brightness: 100,
    color,
    baseColor: color,
    bassLevel: 0,
    midHiLevel: 0,
    rawEnergyPct: 0,
    isPunch: false,
    bleColorSource: 'idle',
    micRms: 0,
    isPlaying: false,
    paletteIndex: 0,
    timings: { rmsMs: 0, smoothMs: 0, bleCallMs: 0, totalTickMs: 0 },
  };
}

/** Set up event listeners for idle color changes. Returns cleanup function. */
export function listenIdleColorChanges(idle: IdleState): () => void {
  const handler = () => {
    idle.idleColor = getIdleColor();
    idle.idleSent = false;
  };
  window.addEventListener('idle-color-changed', handler);
  return () => window.removeEventListener('idle-color-changed', handler);
}
