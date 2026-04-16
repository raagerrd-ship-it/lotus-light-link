/**
 * BLE connection — all connection logic in one place.
 *
 * Three connection paths, all ending in the same GATT discovery:
 * 1. nobleDirectConnect() — uses saved metadata to skip scanning (primary)
 * 2. nobleConnect() — brief noble scan to find peripheral (first-time / fallback)
 * 3. connectPeripheral() — L2CAP + GATT discovery (shared by both paths above)
 *
 * Also handles: HCI reset, connection interval optimization, disconnect handler.
 */

import {
  noble, getDevice, setDevice, bleStats, isDemandActive,
  getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress,
  getSavedAddressType, getSavedConnectable, getSavedServiceUuids,
  setSavedDevice, logConnectionEvent, SERVICE_UUID, CHAR_UUID,
} from './state.js';
import { brightMaxBuf, startKeepAlive, stopKeepAlive, resetLastSent } from './protocol.js';
import { stopNoble, restartNobleHci, waitForAdapter, ensureAdapterUp, normalizeBleKey } from './adapter.js';
import { isScanning } from './scan.js';
import { savePeripheralMetadata } from './save.js';
import type { PiCharacteristic } from './types.js';

// ── HCI reset tracking ──
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

// ── Timeout helper ──
const STEP_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(v => { clearTimeout(timer); return v; }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
    }),
  ]);
}

// ── Reconnect handler (set by reconnect.ts to break circular dep) ──
let _reconnectWithBackoff: ((peripheral: any, name: string) => void) | null = null;
export function setReconnectHandler(fn: (peripheral: any, name: string) => void): void {
  _reconnectWithBackoff = fn;
}

// ═══════════════════════════════════════════════════════════════════
//  GATT discovery — shared by both direct and scan-based connect
// ═══════════════════════════════════════════════════════════════════

/**
 * Connect to a peripheral, discover GATT services/characteristics,
 * set connection interval, and wire up disconnect handler.
 */
export async function connectPeripheral(peripheral: any, _retryCount = 0, skipL2cap = false): Promise<void> {
  const MAX_DISCOVERY_RETRIES = 3;
  const name = peripheral.advertisement?.localName ?? peripheral.id;
  const connectStart = performance.now();
  let connectDuration = 0;

  logConnectionEvent({ type: 'connect_start', device: name, detail: `attempt ${_retryCount + 1}${skipL2cap ? ' (already connected)' : ''}` });

  // Step 1: L2CAP connect
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

  // Step 5: Register disconnect handler BEFORE activating device (prevents race condition)
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

  // Step 6: Activate device (safe — disconnect handler already registered)
  setDevice({ peripheral, characteristic: char, mode: 'rgb', name, id: peripheral.id });
  consecutiveConnectFailures = 0;
  startKeepAlive();

  // Backfill saved name if missing
  if (getSavedDeviceId() === peripheral.id && (!getSavedDeviceName() || getSavedDeviceName() === peripheral.id)) {
    setSavedDevice(peripheral.id, name);
    console.log(`[BLE] Backfilled saved name: ${name}`);
  }

  const totalDuration = Math.round(performance.now() - connectStart);
  logConnectionEvent({ type: 'connect_ok', device: name, detail: `Fully ready (connect=${connectDuration}ms, gatt=${gattDuration}ms)`, durationMs: totalDuration });
}

// ═══════════════════════════════════════════════════════════════════
//  Direct connect — primary path using saved metadata (no scan)
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a peripheral from saved metadata without scanning.
 * Uses noble's internal API to construct a peripheral object, then
 * proceeds to GATT discovery via connectPeripheral().
 */
export async function nobleDirectConnect(name: string, timeoutMs = 5000): Promise<boolean> {
  const savedId = getSavedDeviceId();
  const savedAddress = getSavedDeviceAddress();
  const savedAddressType = getSavedAddressType();

  if (!savedId || !savedAddress || !savedAddressType) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Direct connect: missing saved metadata (address/addressType)' });
    return false;
  }

  // Only restart noble HCI if adapter is not already ready
  const { getAdapterState } = await import('./state.js');
  if (getAdapterState() !== 'poweredOn') {
    await restartNobleHci(name);
  }
  if (!await waitForAdapter(name)) return false;

  logConnectionEvent({ type: 'connect_start', device: name, detail: `Direct connect: ${savedAddress} (${savedAddressType})` });

  try {
    const bindings = (noble as any)._bindings;
    if (!bindings) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Direct connect: no noble bindings' });
      return false;
    }

    const normalizedId = normalizeBleKey(savedId);
    const macFormatted = savedAddress.toLowerCase();

    // Check if already cached from a previous session
    let peripheral: any = (noble as any)._peripherals?.[normalizedId] ?? (noble as any)._peripherals?.[macFormatted];
    if (peripheral) {
      logConnectionEvent({ type: 'connect_start', device: name, detail: 'Using cached peripheral from noble' });
    }

    // Construct via bindings if not cached
    if (!peripheral && bindings._peripherals) {
      try {
        if (typeof bindings.connect === 'function') {
          const fakeAdvertisement = {
            localName: name,
            serviceUuids: getSavedServiceUuids() ?? [],
          };
          const uuid = normalizedId;
          if (!(noble as any)._peripherals) (noble as any)._peripherals = {};
          if (!(noble as any)._peripherals[uuid]) {
            const connectable = getSavedConnectable() ?? true;
            bindings.emit?.('discover', uuid, macFormatted, savedAddressType, connectable, fakeAdvertisement, -50);
            await new Promise(r => setTimeout(r, 100));
            peripheral = (noble as any)._peripherals?.[uuid];
          }
        }
      } catch (e: any) {
        logConnectionEvent({ type: 'connect_fail', device: name, detail: `Failed to construct peripheral: ${e.message}` });
      }
    }

    if (!peripheral) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Direct connect: could not create peripheral object' });
      return false;
    }

    logConnectionEvent({ type: 'connect_start', device: name, detail: `Direct connecting (addressType=${peripheral.addressType})` });
    await connectPeripheral(peripheral, 0, false);
    return true;
  } catch (e: any) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `Direct connect failed: ${e.message}` });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Noble scan connect — first-time selection (needs peripheral object)
// ═══════════════════════════════════════════════════════════════════

/**
 * Brief noble scan to find a specific peripheral, then GATT connect.
 * Used by selectDevice() when the user picks a device for the first time —
 * we need noble to discover the peripheral to get addressType metadata.
 */
export async function nobleConnect(targetId: string, name: string, timeoutMs = 5000): Promise<boolean> {
  const targetNorm = normalizeBleKey(targetId);

  await restartNobleHci(name);
  if (!await waitForAdapter(name)) return false;

  logConnectionEvent({ type: 'scan_start', device: name, detail: `noble scan for ${targetNorm} (${timeoutMs}ms)` });

  const peripheral = await new Promise<any>((resolve) => {
    let found = false;
    const timer = setTimeout(() => {
      if (!found) {
        stopNoble();
        noble.removeAllListeners('discover');
        resolve(null);
      }
    }, timeoutMs);

    const onDiscover = (p: any) => {
      const keys = [
        normalizeBleKey(p.id),
        normalizeBleKey(p.address),
        normalizeBleKey(p.uuid),
      ];
      if (!keys.includes(targetNorm)) return;

      found = true;
      clearTimeout(timer);
      stopNoble();
      noble.removeAllListeners('discover');
      logConnectionEvent({ type: 'scan_done', device: name, detail: `Found! addressType=${p.addressType}, connectable=${p.connectable}` });
      resolve(p);
    };

    noble.on('discover', onDiscover);
    try {
      noble.startScanning([], true);
    } catch (e: any) {
      clearTimeout(timer);
      noble.removeAllListeners('discover');
      logConnectionEvent({ type: 'connect_fail', device: name, detail: `noble.startScanning failed: ${e.message}` });
      resolve(null);
    }
  });

  if (!peripheral) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Not found in noble scan' });
    return false;
  }

  // Save metadata with fresh info from the scan (addressType, connectable)
  const savedId = getSavedDeviceId();
  if (savedId && normalizeBleKey(savedId) === targetNorm) {
    const mac = getSavedDeviceAddress() ?? targetId.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
    savePeripheralMetadata(peripheral, savedId, name, mac);
  }

  try {
    logConnectionEvent({ type: 'connect_start', device: name, detail: `Connecting (addressType=${peripheral.addressType})` });
    await connectPeripheral(peripheral, 0, false);
    return true;
  } catch (e: any) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `GATT connect failed: ${e.message}` });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Auto-connect — called on startup and by reconnect loop
// ═══════════════════════════════════════════════════════════════════

/**
 * Auto-connect to saved device.
 * Requires saved metadata (addressType) from a previous selectDevice().
 * If metadata is missing, returns 0 — user must scan and select a device.
 */
export async function autoConnectSaved(timeoutMs = 15000): Promise<number> {
  const savedId = getSavedDeviceId();
  if (!savedId) {
    console.log('[BLE] No saved device — waiting for user selection');
    return 0;
  }
  if (getDevice()) return 1;
  if (isScanning()) return 0;

  const savedName = getSavedDeviceName() ?? savedId;
  const savedAddressType = getSavedAddressType();

  if (!savedAddressType) {
    console.log('[BLE] Saved device missing addressType — clearing saved device, user must scan and select');
    logConnectionEvent({ type: 'connect_fail', device: savedName, detail: 'Missing addressType metadata — forgetting device' });
    setSavedDevice(null, null, null);
    return 0;
  }

  ensureAdapterUp();

  logConnectionEvent({ type: 'connect_start', device: savedName, detail: 'Direct connect (no scan)' });
  const ok = await nobleDirectConnect(savedName, Math.min(timeoutMs, 6000));
  if (ok) return 1;

  incrementConsecutiveFailures();
  const fails = getConsecutiveFailures();
  logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Enheten är ev. avstängd eller utom räckhåll [fail#${fails}]` });
  if (fails >= HCI_RESET_THRESHOLD) {
    await resetHciAdapter();
    resetConsecutiveFailures();
  }
  return 0;
}

// Legacy alias
export const tryDirectConnect = (_id: string) => autoConnectSaved().then(r => r > 0);

// ═══════════════════════════════════════════════════════════════════
//  Connection interval optimization
// ═══════════════════════════════════════════════════════════════════

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
