/**
 * BLE reconnection: backoff strategy, demand-based reconnection loop.
 *
 * STABILITY: Always uses autoConnectSaved() for reconnection — never reuses
 * stale peripheral objects which may be invalid after disconnect.
 */

import { getDevice, isDemandActive, setDemand, getSavedDeviceId, logConnectionEvent } from './state.js';
import { setReconnectHandler, autoConnectSaved, isConnectInProgress, waitForConnectIdle } from './connect.js';
import { setReconnectTrigger } from './protocol.js';

/** Reconnect with exponential backoff using fresh connections only */
async function reconnectWithBackoff(_peripheral: any, name: string, attempt = 0): Promise<void> {
  const maxAttempts = 5;
  const baseDelay = 300;

  if (getDevice() || !isDemandActive()) return;

  if (attempt >= maxAttempts) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: 'All reconnect attempts failed — background loop will retry' });
    return;
  }

  const delay = baseDelay * Math.pow(2, attempt);
  logConnectionEvent({ type: 'reconnect_start', device: name, detail: `Attempt ${attempt + 1}/${maxAttempts} in ${delay}ms` });
  await new Promise(r => setTimeout(r, delay));

  if (getDevice() || !isDemandActive()) return;

  // Avoid wasting our first attempt on a "skip duplicate" if a connect
  // (e.g. user-triggered) is already running. Wait it out first.
  if (isConnectInProgress()) {
    logConnectionEvent({ type: 'reconnect_start', device: name, detail: 'Waiting for in-flight connect to settle' });
    await waitForConnectIdle(12_000);
    if (getDevice() || !isDemandActive()) return;
  }

  try {
    await autoConnectSaved(10000);
    if (getDevice()) return;
  } catch {}

  return reconnectWithBackoff(_peripheral, name, attempt + 1);
}

// Wire up cross-module callbacks (breaks circular dependency)
setReconnectHandler(reconnectWithBackoff);
setReconnectTrigger(reconnectWithBackoff);

/** Signal that BLE is needed (e.g. music started playing) */
export async function requestConnect(): Promise<void> {
  if (isDemandActive() && getDevice()) return;
  setDemand(true);
  if (!getDevice() && getSavedDeviceId()) {
    console.log('[BLE] Demand ON — connecting...');
    await autoConnectSaved(10000);
  }
}

/** Signal that BLE is no longer needed */
export function releaseDemand(): void {
  if (!isDemandActive()) return;
  setDemand(false);
  console.log('[BLE] Demand OFF — will not reconnect on next disconnect');
}

/** Background reconnect loop — only reconnects when demand is active */
export function startReconnectLoop(intervalMs = 15000): NodeJS.Timeout {
  return setInterval(async () => {
    if (!getDevice() && getSavedDeviceId() && isDemandActive()) {
      await autoConnectSaved(10000);
    }
  }, intervalMs);
}
