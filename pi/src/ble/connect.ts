/**
 * BLE connection — all connection logic in one place.
 *
 * Two connection paths, both ending in the same GATT discovery:
 * 1. nobleDirectConnect() — uses noble.connectAsync(address) to connect without scanning (primary)
 * 2. nobleConnect() — brief noble scan to find peripheral (first-time / fallback)
 *
 * connectPeripheral() handles GATT discovery, connection interval, and disconnect handler.
 * GATT handles are cached after first discovery — reconnects use writeHandleAsync to skip discovery.
 */

import {
  noble, getDevice, setDevice, bleStats, isDemandActive,
  getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress,
  getSavedAddressType, getSavedConnectable, getSavedServiceUuids,
  getSavedServiceHandle, getSavedCharHandle, setSavedGattHandles,
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
let activeConnectPromise: Promise<void> | null = null;

export function getConsecutiveFailures(): number { return consecutiveConnectFailures; }
export function resetConsecutiveFailures(): void { consecutiveConnectFailures = 0; }
export function incrementConsecutiveFailures(): void { consecutiveConnectFailures++; }

async function withConnectLock<T>(deviceName: string | undefined, successResult: () => T, fn: () => Promise<T>): Promise<T> {
  while (activeConnectPromise) {
    logConnectionEvent({ type: 'connect_start', device: deviceName, detail: 'Connect already in progress — waiting' });
    await activeConnectPromise.catch(() => undefined);
    if (getDevice()) return successResult();
  }

  let release!: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeConnectPromise = lock;

  try {
    return await fn();
  } finally {
    if (activeConnectPromise === lock) activeConnectPromise = null;
    release();
  }
}

export async function resetHciAdapter(): Promise<void> {
  logConnectionEvent({ type: 'hci_reset', detail: 'hciconfig hci0 reset (sandbox-friendly)' });
  try {
    const { execFileSync } = await import('child_process');
    execFileSync('bash', ['-lc', 'rfkill unblock bluetooth >/dev/null 2>&1 || true; (command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 down >/dev/null 2>&1; command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1; command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 reset >/dev/null 2>&1) || true'], { timeout: 6000, stdio: 'ignore' });
    bleStats.lastDisconnectReason = 'hci_reset';
    logConnectionEvent({ type: 'hci_reset', detail: 'hciconfig reset complete ✓' });
    await new Promise(r => setTimeout(r, 1000));
  } catch (e: any) {
    logConnectionEvent({ type: 'hci_reset', detail: `hciconfig reset failed: ${e.message}` });
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
 * Create a handle-based characteristic wrapper that writes directly
 * via peripheral.writeHandleAsync, bypassing GATT discovery entirely.
 */
function createCachedCharacteristic(peripheral: any, charHandle: number, name: string): PiCharacteristic {
  return {
    writeAsync: (data: Buffer, withoutResponse: boolean) =>
      peripheral.writeHandleAsync(charHandle, data, withoutResponse),
    deviceName: name,
    deviceId: peripheral.id,
  } as PiCharacteristic;
}

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

  // Step 2: GATT — try cached handle-based write first (skips discovery entirely)
  const gattStart = performance.now();
  let char: PiCharacteristic | null = null;
  const cachedCharHandle = getSavedCharHandle();

  if (cachedCharHandle != null) {
    try {
      logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `Trying cached writeHandle (char=${cachedCharHandle})` });
      const cachedChar = createCachedCharacteristic(peripheral, cachedCharHandle, name);
      // Validate the handle by writing brightness max
      await withTimeout(cachedChar.writeAsync(brightMaxBuf, true), 'Cached handle write');
      char = cachedChar;
      logConnectionEvent({ type: 'gatt_discovery', device: name, detail: 'Cached handle OK — skipped GATT discovery', durationMs: Math.round(performance.now() - gattStart) });
    } catch (e: any) {
      logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `Cached handle failed (${e.message}), falling back to full discovery` });
      char = null;
    }
  }

  // Full GATT discovery if cache miss or not available
  if (!char) {
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
      ) as any[];
      characteristics = result?.[1] ?? [];
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

    // Cache GATT handles for future reconnects
    const foundChar = characteristics[0];
    const sHandle = foundChar.startHandle ?? foundChar._handle ?? null;
    const cHandle = foundChar.valueHandle ?? foundChar._valueHandle ?? null;
    if (sHandle != null || cHandle != null) {
      setSavedGattHandles(sHandle, cHandle);
      logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `Cached GATT handles (svc=${sHandle}, char=${cHandle})` });
    }

    logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `GATT OK — ${characteristics.length} characteristic(s)`, durationMs: gattDuration });

    char = characteristics[0] as PiCharacteristic;
    char.deviceName = name;
    char.deviceId = peripheral.id;

    // Write brightness max (not done via cache path)
    await withTimeout(char.writeAsync(brightMaxBuf, true), 'Brightness write');
  }

  // Step 3: Request minimum connection interval
  requestConnectionInterval(peripheral, name);

  // Step 4: Register disconnect handler BEFORE activating device (prevents race condition)
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

  // Step 5: Activate device (safe — disconnect handler already registered)
  setDevice({ peripheral, characteristic: char, mode: 'rgb', name, id: peripheral.id });
  consecutiveConnectFailures = 0;
  startKeepAlive();

  // Backfill saved name if missing
  if (getSavedDeviceId() === peripheral.id && (!getSavedDeviceName() || getSavedDeviceName() === peripheral.id)) {
    setSavedDevice(peripheral.id, name);
    console.log(`[BLE] Backfilled saved name: ${name}`);
  }

  const totalDuration = Math.round(performance.now() - connectStart);
  logConnectionEvent({ type: 'connect_ok', device: name, detail: `Fully ready (connect=${connectDuration}ms, gatt=${Math.round(performance.now() - gattStart)}ms)`, durationMs: totalDuration });
}

// ═══════════════════════════════════════════════════════════════════
//  Direct connect — primary path using noble.connectAsync(address)
// ═══════════════════════════════════════════════════════════════════

/**
 * Connect directly to a saved device using noble.connectAsync(address).
 * Uses the official API — no internal bindings manipulation needed.
 * The peripheral is returned already connected; we skip L2CAP in connectPeripheral.
 */
export async function nobleDirectConnect(name: string, timeoutMs = 5000): Promise<boolean> {
  const savedAddress = getSavedDeviceAddress();
  const savedAddressType = getSavedAddressType();

  if (!savedAddress || !savedAddressType) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Direct connect: missing saved address/addressType' });
    return false;
  }

  // Only restart noble HCI if adapter is not already ready
  const { getAdapterState } = await import('./state.js');
  if (getAdapterState() !== 'poweredOn') {
    await restartNobleHci(name);
  }
  if (!await waitForAdapter(name)) return false;

  // Keep MAC with colons — noble expects aa:bb:cc:dd:ee:ff format
  const macFormatted = savedAddress.toLowerCase();
  logConnectionEvent({ type: 'connect_start', device: name, detail: `Direct connect via noble.connectAsync(${macFormatted})` });

  try {
    // Official API: returns a connected peripheral object
    // Pass connection interval params directly for fastest possible link
    const peripheral = await (noble as any).connectAsync(macFormatted, {
      addressType: savedAddressType,
      minInterval: 6,   // 7.5ms
      maxInterval: 8,   // 10ms
      timeout: timeoutMs,
    });

    if (!peripheral) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: 'noble.connectAsync returned null' });
      return false;
    }

    bleStats.requestedIntervalMs = '7.5–10';
    logConnectionEvent({ type: 'connect_ok', device: name, detail: `noble.connectAsync OK (addressType=${peripheral.addressType ?? savedAddressType})` });

    // Peripheral is already connected — skip L2CAP step
    await connectPeripheral(peripheral, 0, true);
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
 * Connect directly to a selected device without relying on noble scanning.
 * On Raspberry Pi, noble discovery can stay stuck in `unknown` even when
 * direct connect works, so first-pairing uses the scanned MAC address.
 */
export async function nobleConnect(targetId: string, name: string, timeoutMs = 5000): Promise<boolean> {
  return withConnectLock(name, () => true, async () => {
    const targetNorm = normalizeBleKey(targetId);
    const mac = targetNorm.replace(/(.{2})(?=.)/g, '$1:').toLowerCase();
    const savedAddressType = getSavedAddressType() ?? undefined;

    const { getAdapterState } = await import('./state.js');
    if (getAdapterState() !== 'poweredOn') {
      await restartNobleHci(name);
    }
    if (!await waitForAdapter(name)) return false;

    logConnectionEvent({
      type: 'connect_start',
      device: name,
      detail: `Direct first-pair connect via noble.connectAsync(${mac})${savedAddressType ? ` addressType=${savedAddressType}` : ''}`,
    });

    try {
      const peripheral = await (noble as any).connectAsync(mac, {
        ...(savedAddressType ? { addressType: savedAddressType } : {}),
        minInterval: 6,
        maxInterval: 8,
        timeout: timeoutMs,
      });

      if (!peripheral) {
        logConnectionEvent({ type: 'connect_fail', device: name, detail: 'noble.connectAsync returned null' });
        return false;
      }

      const savedId = getSavedDeviceId();
      if (savedId && normalizeBleKey(savedId) === targetNorm) {
        savePeripheralMetadata(peripheral, savedId, name, mac.toUpperCase());
      }

      logConnectionEvent({
        type: 'connect_ok',
        device: name,
        detail: `Direct pair connect OK (addressType=${peripheral.addressType ?? savedAddressType ?? 'unknown'})`,
      });

      await connectPeripheral(peripheral, 0, true);
      return true;
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: `Direct pair connect failed: ${e.message}` });
      return false;
    }
  });
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

  return withConnectLock(savedName, () => 1, async () => {
    if (getDevice()) return 1;

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
  });
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
