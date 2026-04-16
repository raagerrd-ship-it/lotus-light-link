/**
 * BLE device discovery & selection — noble-based targeted scan + GATT connect.
 *
 * Supports two connection paths:
 * 1. Direct connect — uses saved metadata (addressType etc.) to skip scanning
 * 2. Scan connect — brief noble scan to find peripheral, then GATT connect
 */

import { noble, getDevice, setDevice, getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, getSavedAddressType, getSavedConnectable, getSavedServiceUuids, setSavedDevice, logConnectionEvent } from './state.js';
import { connectPeripheral, incrementConsecutiveFailures, getConsecutiveFailures, resetHciAdapter } from './connection.js';
import { resetLastSent } from './protocol.js';
import { stopNoble, restartNobleHci, waitForAdapter, ensureAdapterUp, normalizeBleKey } from './adapter.js';
import { getLastScanResults, isScanning } from './scan.js';

const HCI_RESET_THRESHOLD = 3;

/**
 * Extract and persist metadata from a noble peripheral object.
 */
function savePeripheralMetadata(peripheral: any, id: string, name: string, mac: string): void {
  setSavedDevice(id, name, mac, {
    addressType: peripheral.addressType ?? null,
    connectable: peripheral.connectable ?? null,
    serviceUuids: peripheral.advertisement?.serviceUuids ?? null,
  });
  console.log(`[BLE] Saved device metadata: ${name} (${mac}), addressType=${peripheral.addressType}, connectable=${peripheral.connectable}`);
}

/**
 * Direct connect — create a peripheral from saved metadata without scanning.
 * Uses noble's internal API to construct a peripheral object.
 * Returns false if metadata is missing or connection fails.
 */
export async function nobleDirectConnect(name: string, timeoutMs = 5000): Promise<boolean> {
  const savedId = getSavedDeviceId();
  const savedAddress = getSavedDeviceAddress();
  const savedAddressType = getSavedAddressType();

  if (!savedId || !savedAddress || !savedAddressType) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Direct connect: missing saved metadata (address/addressType)' });
    return false;
  }

  // Switch HCI from bluetoothctl → noble
  await restartNobleHci(name);
  if (!await waitForAdapter(name)) return false;

  logConnectionEvent({ type: 'connect_start', device: name, detail: `Direct connect: ${savedAddress} (${savedAddressType})` });

  try {
    const bindings = (noble as any)._bindings;
    if (!bindings) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Direct connect: no noble bindings' });
      return false;
    }

    // Create a peripheral object in noble's cache without scanning.
    // noble.connect() internally needs the peripheral in its _peripherals map.
    const normalizedId = normalizeBleKey(savedId);
    const macFormatted = savedAddress.toLowerCase();

    // Construct peripheral via noble's internal factory
    let peripheral: any = null;

    // Method 1: Use noble._peripherals if already cached (from a previous scan in this session)
    const cached = (noble as any)._peripherals?.[normalizedId] ?? (noble as any)._peripherals?.[macFormatted];
    if (cached) {
      peripheral = cached;
      logConnectionEvent({ type: 'connect_start', device: name, detail: 'Using cached peripheral from noble' });
    }

    // Method 2: Construct via bindings (noble-winrt / noble-mac / hci)
    if (!peripheral && bindings._peripherals) {
      // For HCI bindings, we can insert a minimal peripheral entry
      // and let noble.connect populate the rest
      try {
        // noble's Peripheral constructor is accessible via the noble module
        const Peripheral = peripheral?.constructor ?? (noble as any)._peripherals?.constructor;

        // Alternative: use noble.connectAsync with address directly (noble >= 1.9)
        // This is the most reliable approach for @stoprocent/noble
        if (typeof bindings.connect === 'function') {
          // Manually add to noble's peripheral map so connectAsync works
          const fakeAdvertisement = {
            localName: name,
            serviceUuids: getSavedServiceUuids() ?? [],
          };

          // @stoprocent/noble supports direct peripheral creation
          const uuid = normalizedId;
          if (!(noble as any)._peripherals) (noble as any)._peripherals = {};
          if (!(noble as any)._peripherals[uuid]) {
            // Emit a synthetic 'discover' to let noble register the peripheral
            const connectable = getSavedConnectable() ?? true;
            // noble.on('discover') creates the Peripheral internally
            // We need to trigger the internal path
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

    // Connect via GATT
    logConnectionEvent({ type: 'connect_start', device: name, detail: `Direct connecting (addressType=${peripheral.addressType})` });
    await connectPeripheral(peripheral, 0, false);
    return true;
  } catch (e: any) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `Direct connect failed: ${e.message}` });
    return false;
  }
}

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

  // Update saved metadata with fresh info from the scan
  const savedId = getSavedDeviceId();
  if (savedId && normalizeBleKey(savedId) === targetNorm) {
    const mac = getSavedDeviceAddress() ?? targetId.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
    savePeripheralMetadata(peripheral, savedId, name, mac);
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

  // Disconnect current if any
  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }

  // Connect via noble — nobleConnect will scan briefly and save metadata
  // First save basic info so nobleConnect can update it with peripheral metadata
  setSavedDevice(deviceId, entry.name, mac);
  console.log(`[BLE] Saved device: ${entry.name} (${mac})`);

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

  // Force adapter up
  ensureAdapterUp();

  // Direct connect using saved metadata (no scan)
  logConnectionEvent({ type: 'connect_start', device: savedName, detail: 'Direct connect (no scan)' });
  const ok = await nobleDirectConnect(savedName, Math.min(timeoutMs, 6000));
  if (ok) return 1;

  incrementConsecutiveFailures();
  const fails = getConsecutiveFailures();
  logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Direct connect failed [fail#${fails}]` });
  if (fails >= HCI_RESET_THRESHOLD) {
    await resetHciAdapter();
  }
  return 0;
}

// Legacy aliases
export const tryDirectConnect = (_id: string) => autoConnectSaved().then(r => r > 0);
