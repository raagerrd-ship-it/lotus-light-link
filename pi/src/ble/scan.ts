/**
 * BLE scanning: device discovery, selection, persistence.
 */

import { noble, getDevice, setDevice, getAdapterState, getSavedDeviceId, getSavedDeviceName, setSavedDevice, logConnectionEvent } from './state.js';
import { connectPeripheral, incrementConsecutiveFailures, getConsecutiveFailures, resetHciAdapter } from './connection.js';
import { resetLastSent } from './protocol.js';
import type { DiscoveredDevice } from './types.js';

const HCI_RESET_THRESHOLD = 3;

// ── Discovered devices from last scan ──
let lastScanResults: DiscoveredDevice[] = [];
let discoveredPeripherals = new Map<string, any>();
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

/**
 * Scan for all BLE devices and return the list.
 * Does NOT auto-connect — user picks from the list.
 */
export async function scanForDevices(timeoutMs = 10000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    console.log('[BLE] Scan already in progress');
    return lastScanResults;
  }
  scanning = true;
  lastScanResults = [];
  discoveredPeripherals.clear();
  logConnectionEvent({ type: 'scan_start', detail: `timeout=${timeoutMs}ms` });

  try {
    return await new Promise((resolve) => {
      const onDiscover = (peripheral: any) => {
        const name = peripheral.advertisement?.localName ?? '';
        if (!name) return;
        const id = peripheral.id;
        if (discoveredPeripherals.has(id)) return;

        discoveredPeripherals.set(id, peripheral);
        const entry: DiscoveredDevice = { id, name, rssi: peripheral.rssi ?? -100 };
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

      const startScan = () => {
        noble.startScanningAsync([], false).catch(() => {});
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
    const name = peripheral.advertisement?.localName ?? deviceId;
    setSavedDevice(deviceId, name);
    console.log(`[BLE] Saved device: ${name} (${deviceId})`);
    return true;
  } catch (e: any) {
    console.error(`[BLE] Failed to connect to ${deviceId}: ${e.message}`);
    return false;
  }
}

/** Forget saved device and disconnect */
export async function forgetDevice(): Promise<void> {
  setSavedDevice(null, null);
  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }
  console.log('[BLE] Device forgotten');
}

/**
 * Auto-connect to saved device if available.
 * Scans and connects only to the previously selected device.
 */
export async function autoConnectSaved(timeoutMs = 15000): Promise<number> {
  const savedId = getSavedDeviceId();
  if (!savedId) {
    console.log('[BLE] No saved device — waiting for user selection');
    return 0;
  }
  if (getDevice()) return 1;
  if (scanning) return 0;

  scanning = true;
  logConnectionEvent({ type: 'scan_start', device: getSavedDeviceName() ?? savedId, detail: `auto-connect scan, timeout=${timeoutMs}ms` });

  try {
    return await new Promise((resolve) => {
      let found: any = null;

      const onDiscover = (peripheral: any) => {
        if (found) return;
        if (peripheral.id === savedId) {
          const name = peripheral.advertisement?.localName ?? peripheral.id;
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
          logConnectionEvent({ type: 'connect_fail', device: found.advertisement?.localName ?? savedId, detail: `Auto-connect failed: ${e.message} [fail#${fails}]` });
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

      if (getAdapterState() === 'poweredOn') {
        noble.startScanningAsync([], false).catch(() => {});
      } else {
        noble.once('stateChange', (state: string) => {
          if (state === 'poweredOn') {
            noble.startScanningAsync([], false).catch(() => {});
          }
        });
      }
    });
  } finally {
    scanning = false;
  }
}
