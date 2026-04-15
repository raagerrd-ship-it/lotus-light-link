/**
 * BLE connection: GATT discovery, connection-interval optimization, disconnect handling.
 */

import { noble, getDevice, setDevice, bleStats, isDemandActive, getSavedDeviceId, getSavedDeviceName, setSavedDevice, logConnectionEvent, SERVICE_UUID, CHAR_UUID } from './state.js';
import { brightMaxBuf, startKeepAlive, stopKeepAlive, resetLastSent } from './protocol.js';
import type { PiCharacteristic } from './types.js';

// HCI reset tracking
let consecutiveConnectFailures = 0;
const HCI_RESET_THRESHOLD = 3;

export function getConsecutiveFailures(): number { return consecutiveConnectFailures; }
export function resetConsecutiveFailures(): void { consecutiveConnectFailures = 0; }
export function incrementConsecutiveFailures(): void { consecutiveConnectFailures++; }

export async function resetHciAdapter(): Promise<void> {
  logConnectionEvent({ type: 'hci_reset', detail: 'Initiating Bluetooth power cycle' });
  try {
    const { exec } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      exec('bluetoothctl power off && sleep 1 && bluetoothctl power on', { timeout: 10000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    bleStats.lastDisconnectReason = 'bt_power_cycle';
    logConnectionEvent({ type: 'hci_reset', detail: 'Power cycle complete ✓' });
    await new Promise(r => setTimeout(r, 2000));
  } catch (e: any) {
    logConnectionEvent({ type: 'hci_reset', detail: `Power cycle FAILED: ${e.message}` });
  }
}

const STEP_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS)
    ),
  ]);
}

// Forward declaration — set by reconnect module
let _reconnectWithBackoff: ((peripheral: any, name: string) => void) | null = null;
export function setReconnectHandler(fn: (peripheral: any, name: string) => void): void {
  _reconnectWithBackoff = fn;
}

/**
 * Connect to a peripheral, discover GATT, set up disconnect handler.
 * Includes detailed diagnostics logging at each step.
 */
export async function connectPeripheral(peripheral: any, _retryCount = 0, skipL2cap = false): Promise<void> {
  const MAX_DISCOVERY_RETRIES = 3;
  const name = peripheral.advertisement?.localName ?? peripheral.id;
  const connectStart = performance.now();
  let connectDuration = 0;

  logConnectionEvent({ type: 'connect_start', device: name, detail: `attempt ${_retryCount + 1}${skipL2cap ? ' (already connected)' : ''}` });

  // Step 1: Connect (skip if noble.connectAsync already established L2CAP)
  if (!skipL2cap) {
    try {
      await withTimeout(peripheral.connectAsync(), 'BLE connect');
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: `Connect failed: ${e.message}`, durationMs: Math.round(performance.now() - connectStart) });
      throw e;
    }
  }
  connectDuration = Math.round(performance.now() - connectStart);
  logConnectionEvent({ type: 'connect_ok', device: name, detail: skipL2cap ? 'L2CAP already up' : 'L2CAP connected', durationMs: connectDuration });

  // Step 2: GATT discovery
  const gattStart = performance.now();
  let characteristics: any[] = [];
  try {
    logConnectionEvent({ type: 'gatt_discovery', device: name, detail: 'Two-step: discovering services...' });
    const services: any[] = await withTimeout(
      peripheral.discoverServicesAsync([SERVICE_UUID]),
      'Service discovery'
    );
    if (services?.length) {
      logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `Found ${services.length} service(s), discovering characteristics...` });
      characteristics = await withTimeout(
        services[0].discoverCharacteristicsAsync([CHAR_UUID]),
        'Characteristic discovery'
      );
    } else {
      logConnectionEvent({ type: 'gatt_discovery', device: name, detail: 'No matching services found' });
    }
  } catch (e: any) {
    logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `Two-step failed (${e.message}), trying combined...` });
    const result = await withTimeout(
      peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [CHAR_UUID]),
      'Combined GATT discovery'
    );
    characteristics = (result as any).characteristics ?? [];
  }

  const gattDuration = Math.round(performance.now() - gattStart);

  if (!characteristics?.length) {
    try { await peripheral.disconnectAsync(); } catch {}
    if (_retryCount < MAX_DISCOVERY_RETRIES) {
      const delay = 500 * (_retryCount + 1);
      logConnectionEvent({ type: 'gatt_retry', device: name, detail: `No characteristic — retry ${_retryCount + 1}/${MAX_DISCOVERY_RETRIES} in ${delay}ms`, durationMs: gattDuration });
      await new Promise(r => setTimeout(r, delay));
      return connectPeripheral(peripheral, _retryCount + 1);
    }
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `No characteristic after ${MAX_DISCOVERY_RETRIES} retries`, durationMs: gattDuration });
    throw new Error(`No characteristic found on ${name} after ${MAX_DISCOVERY_RETRIES} retries`);
  }

  logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `GATT OK — ${characteristics.length} characteristic(s)`, durationMs: gattDuration });

  const char = characteristics[0] as PiCharacteristic;
  char.deviceName = name;
  char.deviceId = peripheral.id;

  // Step 3: Set hardware brightness to max
  await withTimeout(char.writeAsync(brightMaxBuf, true), 'Brightness write');

  // Step 4: Request minimum connection interval
  requestConnectionInterval(peripheral, name);

  // Step 5: Activate device
  setDevice({ peripheral, characteristic: char, mode: 'rgb', name, id: peripheral.id });
  consecutiveConnectFailures = 0;
  startKeepAlive();

  // Backfill saved name if missing
  if (getSavedDeviceId() === peripheral.id && (!getSavedDeviceName() || getSavedDeviceName() === peripheral.id)) {
    setSavedDevice(peripheral.id, name);
    console.log(`[BLE] Backfilled saved name: ${name}`);
  }

  // Step 6: Disconnect handler
  peripheral.once('disconnect', (reason: any) => {
    const uptime = Math.round((performance.now() - connectStart) / 1000);
    bleStats.disconnectCount++;
    bleStats.lastDisconnectReason = String(reason ?? 'unknown');
    bleStats.lastDisconnectAt = new Date().toISOString();

    logConnectionEvent({
      type: 'disconnect',
      device: name,
      detail: `reason=${reason ?? 'unknown'}, uptime=${uptime}s, sent=${bleStats.sentCount}, avgLat=${bleStats.writeLatAvgMs}ms`,
    });

    stopKeepAlive();
    setDevice(null);
    resetLastSent();

    if (isDemandActive()) {
      bleStats.reconnectCount++;
      logConnectionEvent({ type: 'reconnect_start', device: name, detail: `rc#${bleStats.reconnectCount}` });
      if (_reconnectWithBackoff) _reconnectWithBackoff(peripheral, name);
    }
  });

  const totalDuration = Math.round(performance.now() - connectStart);
  logConnectionEvent({ type: 'connect_ok', device: name, detail: `Fully ready (connect=${connectDuration}ms, gatt=${gattDuration}ms)`, durationMs: totalDuration });
}

function requestConnectionInterval(peripheral: any, name: string): void {
  try {
    const hci = (noble as any)._bindings?._hci;
    const handle = peripheral._handle ?? peripheral.handle;
    if (hci && handle != null && typeof hci.writeLeConnectionUpdate === 'function') {
      hci.writeLeConnectionUpdate(handle, 6, 8, 0, 200);
      bleStats.requestedIntervalMs = '7.5–10';
      console.log(`[BLE] Requested connection interval 7.5–10ms for ${name}`);

      if (typeof hci.on === 'function') {
        const onLeConnUpdateComplete = (status: number, connHandle: number, interval: number, latency: number, supervisionTimeout: number) => {
          if (connHandle !== handle) return;
          const actualMs = (interval * 1.25).toFixed(1);
          bleStats.actualIntervalMs = actualMs;
          bleStats.intervalSource = 'hci_event';
          console.log(`[BLE] Connection interval accepted: ${actualMs}ms (latency=${latency}, timeout=${supervisionTimeout * 10}ms)`);
          hci.removeListener('leConnUpdateComplete', onLeConnUpdateComplete);
        };
        hci.on('leConnUpdateComplete', onLeConnUpdateComplete);
        setTimeout(() => {
          hci.removeListener('leConnUpdateComplete', onLeConnUpdateComplete);
          if (bleStats.intervalSource === 'unknown') {
            bleStats.intervalSource = 'estimated';
          }
        }, 3000);
      }
    } else {
      bleStats.requestedIntervalMs = 'n/a (no HCI)';
      console.log(`[BLE] Connection interval update not available (HCI access limited)`);
    }
  } catch (e: any) {
    bleStats.requestedIntervalMs = 'error';
    console.warn(`[BLE] Failed to set connection interval: ${e.message}`);
  }
}
