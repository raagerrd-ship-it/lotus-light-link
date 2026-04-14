/**
 * BLE scanning: device discovery, selection, persistence.
 */

import { noble, getDevice, setDevice, getAdapterState, getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, setSavedDevice, logConnectionEvent } from './state.js';
import { connectPeripheral, incrementConsecutiveFailures, getConsecutiveFailures, resetHciAdapter } from './connection.js';
import { resetLastSent } from './protocol.js';
import type { DiscoveredDevice } from './types.js';

const HCI_RESET_THRESHOLD = 3;

function getPeripheralName(peripheral: any): string {
  const advertisedName = peripheral.advertisement?.localName?.trim();
  if (advertisedName) return advertisedName;

  if (peripheral.id === getSavedDeviceId()) {
    const savedName = getSavedDeviceName();
    if (savedName) return savedName;
  }

  const address = typeof peripheral.address === 'string' && peripheral.address !== 'unknown'
    ? peripheral.address.toUpperCase()
    : peripheral.id;

  return `Okänd enhet (${address})`;
}

function getPeripheralAddress(peripheral: any): string | null {
  if (typeof peripheral.address === 'string' && peripheral.address !== 'unknown') {
    return peripheral.address.toUpperCase();
  }
  // On Linux, noble id IS the MAC without colons
  if (typeof peripheral.id === 'string' && peripheral.id.length === 12) {
    return peripheral.id.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
  }
  return null;
}

// ── Discovered devices from last scan ──
let lastScanResults: DiscoveredDevice[] = [];
let discoveredPeripherals = new Map<string, any>();
let scanning = false;
let scanAbort: (() => void) | null = null;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

/**
 * Scan for all BLE devices and return the list.
 * Does NOT auto-connect — user picks from the list.
 */
export async function scanForDevices(timeoutMs = 10000): Promise<DiscoveredDevice[]> {
  // Abort any in-progress auto-connect scan so manual scan takes priority
  if (scanning && scanAbort) {
    console.log('[BLE] Aborting previous scan for manual scan');
    scanAbort();
    // Small delay for noble to settle
    await new Promise(r => setTimeout(r, 200));
  }
  if (scanning) {
    console.log('[BLE] Scan still in progress after abort attempt');
    return lastScanResults;
  }
  scanning = true;
  lastScanResults = [];
  discoveredPeripherals.clear();
  logConnectionEvent({ type: 'scan_start', detail: `timeout=${timeoutMs}ms` });

  try {
    return await new Promise((resolve) => {
      const onDiscover = (peripheral: any) => {
        const id = peripheral.id;
        const name = getPeripheralName(peripheral);
        const existingIndex = lastScanResults.findIndex((device) => device.id === id);

        discoveredPeripherals.set(id, peripheral);
        const entry: DiscoveredDevice = { id, name, rssi: peripheral.rssi ?? -100 };

        if (existingIndex >= 0) {
          lastScanResults[existingIndex] = entry;
          return;
        }

        lastScanResults.push(entry);
        console.log(`[BLE] Discovered: ${name} (${id}) RSSI: ${entry.rssi}`);
      };

      noble.on('discover', onDiscover);

      const timer = setTimeout(() => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        logConnectionEvent({ type: 'scan_done', detail: `found ${lastScanResults.length} device(s)` });
        resolve(lastScanResults);
      }, timeoutMs);

      scanAbort = () => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        clearTimeout(timer);
        resolve(lastScanResults);
      };

      const startScan = () => {
        noble.startScanningAsync([], true).catch(() => {});
      };

      if (getAdapterState() === 'poweredOn') {
        startScan();
      } else {
        noble.once('stateChange', (state: string) => {
          if (state === 'poweredOn') startScan();
        });
      }
    });
  } finally {
    scanning = false;
    scanAbort = null;
  }
}

/**
 * Connect to a specific device by ID (from scan results).
 * Saves the ID for auto-reconnect on restart.
 */
export async function selectDevice(deviceId: string): Promise<boolean> {
  const peripheral = discoveredPeripherals.get(deviceId);
  if (!peripheral) {
    console.error(`[BLE] Device ${deviceId} not in scan results`);
    return false;
  }

  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }

  try {
    await connectPeripheral(peripheral);
    const name = getPeripheralName(peripheral);
    const address = getPeripheralAddress(peripheral);
    setSavedDevice(deviceId, name, address);
    console.log(`[BLE] Saved device: ${name} (${deviceId})`);
    return true;
  } catch (e: any) {
    console.error(`[BLE] Failed to connect to ${deviceId}: ${e.message}`);
    return false;
  }
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
 * Try to connect directly by address without scanning.
 * Noble on Linux can re-create a peripheral from a cached address.
 * Returns true if connected successfully.
 */
async function tryDirectConnect(savedId: string): Promise<boolean> {
  if (getAdapterState() !== 'poweredOn') return false;

  const savedAddress = getSavedDeviceAddress();
  const savedName = getSavedDeviceName() ?? savedId;

  // Check if noble has the peripheral cached from a previous session
  const bindings = (noble as any)._bindings;
  const cachedPeripheral = (noble as any)._peripherals?.[savedId];

  if (cachedPeripheral) {
    logConnectionEvent({ type: 'connect_start', device: savedName, detail: 'Direct connect (cached peripheral)' });
    try {
      await connectPeripheral(cachedPeripheral);
      return true;
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Direct connect failed: ${e.message}` });
      return false;
    }
  }

  // Try to create peripheral from known address via HCI bindings
  if (savedAddress && bindings && typeof bindings.connectKnownDevice === 'function') {
    logConnectionEvent({ type: 'connect_start', device: savedName, detail: `Direct connect by address ${savedAddress}` });
    try {
      const peripheral = await bindings.connectKnownDevice(savedAddress);
      if (peripheral) {
        await connectPeripheral(peripheral);
        return true;
      }
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Direct address connect failed: ${e.message}` });
    }
  }

  // Quick targeted scan — only 3 seconds instead of full timeout
  if (getAdapterState() === 'poweredOn') {
    logConnectionEvent({ type: 'scan_start', device: savedName, detail: 'Quick targeted scan (3s)' });
    return new Promise((resolve) => {
      let found = false;

      const onDiscover = (peripheral: any) => {
        if (found) return;
        if (peripheral.id === savedId) {
          found = true;
          noble.stopScanningAsync().catch(() => {});
          noble.removeListener('discover', onDiscover);
          clearTimeout(quickTimer);
          connectPeripheral(peripheral)
            .then(() => resolve(true))
            .catch(() => resolve(false));
        }
      };

      noble.on('discover', onDiscover);
      noble.startScanningAsync([], true).catch(() => {});

      const quickTimer = setTimeout(() => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        if (!found) {
          logConnectionEvent({ type: 'scan_done', device: savedName, detail: 'Quick scan — not found' });
          resolve(false);
        }
      }, 3000);
    });
  }

  return false;
}

/**
 * Auto-connect to saved device if available.
 * Tries direct connect first (no scan), falls back to scan.
 */
export async function autoConnectSaved(timeoutMs = 15000): Promise<number> {
  const savedId = getSavedDeviceId();
  if (!savedId) {
    console.log('[BLE] No saved device — waiting for user selection');
    return 0;
  }
  if (getDevice()) return 1;
  if (scanning) return 0;

  // Try direct connect first (skip scan entirely)
  const directResult = await tryDirectConnect(savedId);
  if (directResult) return 1;
  if (getDevice()) return 1;

  scanning = true;
  logConnectionEvent({ type: 'scan_start', device: getSavedDeviceName() ?? savedId, detail: `auto-connect scan, timeout=${timeoutMs}ms` });

  try {
    return await new Promise((resolve) => {
      let found: any = null;

      const onDiscover = (peripheral: any) => {
        if (found) return;
        if (peripheral.id === savedId) {
          const name = getPeripheralName(peripheral);
          logConnectionEvent({ type: 'scan_done', device: name, detail: 'Saved device found' });
          found = peripheral;
          noble.stopScanningAsync().catch(() => {});
          noble.removeListener('discover', onDiscover);
          clearTimeout(timer);
          finishConnect();
        }
      };

      const finishConnect = async () => {
        if (!found) { resolve(0); return; }
        try {
          await connectPeripheral(found);
          resolve(1);
        } catch (e: any) {
          incrementConsecutiveFailures();
          const fails = getConsecutiveFailures();
          logConnectionEvent({ type: 'connect_fail', device: getPeripheralName(found), detail: `Auto-connect failed: ${e.message} [fail#${fails}]` });
          if (fails >= HCI_RESET_THRESHOLD) {
            await resetHciAdapter();
          }
          resolve(0);
        }
      };

      noble.on('discover', onDiscover);

      const timer = setTimeout(() => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        if (!found) {
          logConnectionEvent({ type: 'scan_done', detail: `Saved device not found within ${timeoutMs}ms` });
          resolve(0);
        }
      }, timeoutMs);

      scanAbort = () => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        clearTimeout(timer);
        if (!found) resolve(0);
      };

      if (getAdapterState() === 'poweredOn') {
        noble.startScanningAsync([], true).catch(() => {});
      } else {
        noble.once('stateChange', (state: string) => {
          if (state === 'poweredOn') {
            noble.startScanningAsync([], true).catch(() => {});
          }
        });
      }
    });
  } finally {
    scanning = false;
    scanAbort = null;
  }
}
