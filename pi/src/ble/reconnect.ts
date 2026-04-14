/**
 * BLE reconnection: backoff strategy, demand-based reconnection loop.
 */

import { getDevice, isDemandActive, setDemand, getSavedDeviceId, logConnectionEvent } from './state.js';
import { connectPeripheral, setReconnectHandler } from './connection.js';
import { setReconnectTrigger } from './protocol.js';
import { autoConnectSaved } from './scan.js';

/** Reconnect with exponential backoff, then fall back to fresh scan with retries */
async function reconnectWithBackoff(peripheral: any, name: string, attempt = 0): Promise<void> {
  const maxDirectAttempts = 3;
  const baseDelay = 200;

  if (getDevice() || !isDemandActive()) return;

  if (attempt < maxDirectAttempts) {
    const delay = baseDelay * Math.pow(2, attempt);
    logConnectionEvent({ type: 'reconnect_start', device: name, detail: `Direct retry ${attempt + 1}/${maxDirectAttempts} in ${delay}ms` });
    await new Promise(r => setTimeout(r, delay));
    if (getDevice() || !isDemandActive()) return;

    try {
      await connectPeripheral(peripheral);
      return;
    } catch (e: any) {
      if (attempt === maxDirectAttempts - 1) {
        logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Direct reconnect exhausted — switching to scan' });
      }
      return reconnectWithBackoff(peripheral, name, attempt + 1);
    }
  }

  // Phase 2: fresh scan with retries
  const scanRetries = 3;
  for (let i = 0; i < scanRetries; i++) {
    if (getDevice() || !isDemandActive()) return;
    logConnectionEvent({ type: 'reconnect_start', device: name, detail: `Scan retry ${i + 1}/${scanRetries}` });
    try {
      await autoConnectSaved(10000);
      if (getDevice()) return;
    } catch {}
    if (i < scanRetries - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!getDevice()) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: 'All reconnect attempts failed — background loop will retry' });
  }
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
