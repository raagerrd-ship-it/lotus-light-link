/**
 * BLE device discovery & selection — noble-based targeted scan + GATT connect.
 *
 * Uses a brief noble scan to find a specific peripheral by ID,
 * then hands off to connection.ts for GATT setup.
 */

import { noble, getDevice, setDevice, getSavedDeviceId, getSavedDeviceName, setSavedDevice, logConnectionEvent } from './state.js';
import { connectPeripheral, incrementConsecutiveFailures, getConsecutiveFailures, resetHciAdapter } from './connection.js';
import { resetLastSent } from './protocol.js';
import { stopNoble, restartNobleHci, waitForAdapter, ensureAdapterUp, normalizeBleKey } from './adapter.js';
import { getLastScanResults, isScanning } from './scan.js';

const HCI_RESET_THRESHOLD = 3;

/**
 * Find a device via a brief noble scan, then connect.
 * Noble must scan to populate its internal peripheral cache
 * before connectAsync/connectPeripheral will work.
 */
export async function nobleConnect(targetId: string, name: string, timeoutMs = 5000): Promise<boolean> {
  const targetNorm = normalizeBleKey(targetId);

  // Switch HCI from bluetoothctl → noble
  await restartNobleHci(name);

  // Wait for adapter
  if (!await waitForAdapter(name)) return false;

  // Noble scan to discover the specific peripheral
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
      noble.startScanning([], true); // allow duplicates for faster discovery
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

  // Connect via the discovered peripheral (GATT discovery etc.)
  try {
    logConnectionEvent({ type: 'connect_start', device: name, detail: `Connecting (addressType=${peripheral.addressType})` });
    await connectPeripheral(peripheral, 0, false);
    return true;
  } catch (e: any) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `GATT connect failed: ${e.message}` });
    return false;
  }
}

/**
 * User selected a device from scan results → save + connect.
 */
export async function selectDevice(deviceId: string): Promise<boolean> {
  const entry = getLastScanResults().find(d => d.id === deviceId);
  if (!entry) {
    console.error(`[BLE] Device ${deviceId} not in scan results`);
    return false;
  }

  const mac = deviceId.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();

  // Save for auto-reconnect
  setSavedDevice(deviceId, entry.name, mac);
  console.log(`[BLE] Saved device: ${entry.name} (${mac})`);

  // Disconnect current if any
  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }

  // Connect via noble
  return nobleConnect(deviceId, entry.name, 5000);
}

/** Forget saved device and disconnect */
export async function forgetDevice(): Promise<void> {
  setSavedDevice(null, null, null);
  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }
  console.log('[BLE] Device forgotten');
}

/**
 * Auto-connect to saved device on startup / reconnect loop.
 * Uses noble scan → connect (no bluetoothctl scan needed).
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

  // Force adapter up
  ensureAdapterUp();

  const ok = await nobleConnect(savedId, savedName, Math.min(timeoutMs, 6000));
  if (ok) return 1;

  incrementConsecutiveFailures();
  const fails = getConsecutiveFailures();
  logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Auto-connect failed [fail#${fails}]` });
  if (fails >= HCI_RESET_THRESHOLD) {
    await resetHciAdapter();
  }
  return 0;
}

// Legacy aliases
export const tryDirectConnect = (_id: string) => autoConnectSaved().then(r => r > 0);
