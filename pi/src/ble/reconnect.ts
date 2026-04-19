/**
 * BLE connection — MANUAL ONLY mode.
 *
 * Vi separerar engine från BLE-anslutning helt: motorn kör alltid, men
 * lampan ansluts ENDAST när användaren trycker "Anslut" i UI:t (eller
 * gör en kort save-preview). Ingen demand-baserad auto-reconnect, ingen
 * bakgrundsloop, ingen exponential backoff.
 *
 * Det här filen behåller export-namnen så resten av koden inte behöver
 * ändras — men `requestConnect()` blir en explicit single-shot-anslutning
 * och `releaseDemand()` / `startReconnectLoop()` blir no-ops.
 */

import { isDemandActive, setDemand, getSavedDeviceId, getDevice, logConnectionEvent } from './state.js';
import { setReconnectHandler, autoConnectSaved } from './connect.js';
import { setReconnectTrigger } from './protocol.js';

// Disable automatic reconnect på disconnect-event. Disconnect-handlern i
// connect.ts kollar `isDemandActive()` innan den anropar reconnect-fn —
// men vi sätter ändå handlern till en no-op för att vara säkra.
setReconnectHandler(() => {
  /* manual-only: no auto-reconnect */
});
setReconnectTrigger(() => {
  /* manual-only: no auto-reconnect via protocol-write failure */
});

/**
 * Explicit, user-triggered single connect attempt.
 * Triggas från `/api/ble/connect` när användaren klickar Anslut.
 * Ingen retry, ingen bakgrundsloop — om det failar får användaren trycka igen.
 */
export async function requestConnect(): Promise<void> {
  if (getDevice()) return; // redan ansluten
  if (!getSavedDeviceId()) {
    logConnectionEvent({ type: 'connect_fail', detail: 'requestConnect: ingen sparad enhet' });
    return;
  }
  setDemand(true); // för UI-visning ("connecting…")
  try {
    console.log('[BLE] Manual connect requested by user');
    await autoConnectSaved(10000);
  } finally {
    // Om connect failade vill vi inte att UI:t ska visa "demand-pending" för evigt.
    if (!getDevice()) setDemand(false);
  }
}

/**
 * User-triggered disconnect: släpp demand-flaggan så UI:t inte visar
 * "connecting…". Faktisk disconnect sker via `disconnect()` i nobleBle.
 */
export function releaseDemand(): void {
  if (!isDemandActive()) return;
  setDemand(false);
  console.log('[BLE] Demand released (manual mode)');
}

/**
 * No-op i manual-mode. Vi exporterar funktionen för bakåtkompatibilitet
 * med index.ts/configServer.ts som tidigare importerade den. Returnerar
 * en interval som inte gör något så `clearInterval()` fortfarande funkar.
 */
export function startReconnectLoop(_baseIntervalMs = 15000): NodeJS.Timeout {
  return setInterval(() => { /* no-op: manual-only mode */ }, 60_000);
}
