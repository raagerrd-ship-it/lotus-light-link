/**
 * BLE device persistence — save, select, and forget devices.
 *
 * Handles the user-facing device selection flow:
 * 1. User scans (scan.ts) → picks a device from the list
 * 2. selectDevice() saves basic info + triggers a noble connect to get metadata
 * 3. Future reconnects use saved metadata for direct connect (connect.ts)
 */

import { getDevice, setDevice, getSavedDeviceId, setSavedDevice, logConnectionEvent } from './state.js';
import { resetLastSent, stopKeepAlive } from './protocol.js';
import { getLastScanResults } from './scan.js';
import { nobleConnect } from './connect.js';

/**
 * Extract and persist metadata from a noble peripheral object.
 * Called after a successful noble scan or connect to save addressType etc.
 */
export function savePeripheralMetadata(peripheral: any, id: string, name: string, mac: string): void {
  setSavedDevice(id, name, mac, {
    addressType: peripheral.addressType ?? null,
    connectable: peripheral.connectable ?? null,
    serviceUuids: peripheral.advertisement?.serviceUuids ?? null,
  });
  console.log(`[BLE] Saved device metadata: ${name} (${mac}), addressType=${peripheral.addressType}, connectable=${peripheral.connectable}`);
}

/**
 * User selected a device from scan results → save + connect.
 * This triggers a brief noble scan to discover the peripheral and extract
 * addressType/connectable metadata needed for future direct connects.
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

  // hcitool-only devices have no noble peripheral cached, so nobleConnect
  // would fail with "could not find peripheral". Auto-route through the
  // manual save flow instead — direct-connect will look up the peripheral
  // on first connect attempt using the saved MAC.
  if (entry.source === 'hcitool') {
    logConnectionEvent({
      type: 'connect_start',
      device: entry.name,
      detail: `hcitool-only device — auto-routing via save-manual (${mac})`,
    });
    return saveManualDevice(mac, entry.name);
  }

  // Save basic info first — nobleConnect will update with peripheral metadata
  setSavedDevice(deviceId, entry.name, mac);
  console.log(`[BLE] Saved device: ${entry.name} (${mac})`);

  return nobleConnect(deviceId, entry.name, 5000);
}

/**
 * Save a device manually by MAC address (no scan required).
 * Useful when noble scan is unreliable but the user knows the address.
 * Skips the metadata-discovery connect — connect.ts will fall back to
 * peripheral lookup on first connect attempt.
 */
export async function saveManualDevice(address: string, name: string): Promise<boolean> {
  // Normalize both colon and colonless formats to uppercase MAC
  const hex = address.trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) {
    console.error(`[BLE] Invalid MAC address: ${address}`);
    return false;
  }
  const mac = hex.match(/.{1,2}/g)?.join(':') ?? '';
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
    console.error(`[BLE] Invalid MAC address after normalization: ${address}`);
    return false;
  }
  // noble's id format = MAC without colons, lowercase
  const id = mac.replace(/:/g, '').toLowerCase();
  const cleanName = name.trim() || 'BLE Device';

  // Disconnect current if any
  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }

  // Save with sane BLEDOM defaults so direct-connect can try immediately
  setSavedDevice(id, cleanName, mac, {
    addressType: 'public',
    connectable: true,
    serviceUuids: ['fff0'],
  });
  console.log(`[BLE] Manually saved device: ${cleanName} (${mac})`);
  logConnectionEvent({ type: 'connect_ok', device: cleanName, detail: `Manually saved (${mac})` });

  // Don't auto-connect — return immediately so the API responds fast.
  // The engine's reconnect loop picks it up on next demand cycle, or the
  // user can call /api/ble/connect explicitly.
  return true;
}

/** Forget saved device + disconnect, but keep noble's HCI socket so the
 *  next scan/parning is instant. The user can manually reset HCI from the
 *  diagnostics panel if noble ever wedges. */
export async function forgetDevice(): Promise<void> {
  setSavedDevice(null, null, null);
  const device = getDevice();
  if (device) {
    stopKeepAlive();
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }
  logConnectionEvent({ type: 'disconnect', detail: 'Device forgotten by user — noble kept live' });
  console.log('[BLE] Device forgotten (noble HCI kept live)');
}
