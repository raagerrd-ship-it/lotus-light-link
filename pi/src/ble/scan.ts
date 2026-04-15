/**
 * BLE scanning: device discovery via bluetoothctl, GATT connection via noble.
 *
 * bluetoothctl discovers devices (reliable stdout parsing).
 * noble is used only for GATT connect — it needs its own brief scan to populate
 * internal peripheral state before connectAsync works.
 */

import { execFileSync } from 'child_process';
import { noble, getDevice, setDevice, getAdapterState, getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, getSavedAddressType, setSavedDevice, logConnectionEvent } from './state.js';
import { connectPeripheral, incrementConsecutiveFailures, getConsecutiveFailures, resetHciAdapter } from './connection.js';
import { resetLastSent } from './protocol.js';
import type { DiscoveredDevice } from './types.js';

const HCI_RESET_THRESHOLD = 3;

// ── bluetoothctl-based discovery ──

function bluetoothctlScan(timeoutMs = 2000): Promise<DiscoveredDevice[]> {
  const seen = new Map<string, DiscoveredDevice>();
  const scanSeconds = Math.max(2, Math.ceil(timeoutMs / 1000));

  logConnectionEvent({ type: 'scan_start', detail: `bluetoothctl scan starting (timeout=${scanSeconds}s)` });
  try { noble.stopScanning(); } catch {}

  const cmd = `bluetoothctl --timeout ${scanSeconds} scan le >/dev/null 2>&1; bluetoothctl devices`;
  const execTimeoutMs = (scanSeconds * 1000) + 3000;

  let output = '';
  try {
    output = execFileSync('bash', ['-lc', cmd], {
      timeout: execTimeoutMs,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    output = typeof e?.stdout === 'string' ? e.stdout : Buffer.isBuffer(e?.stdout) ? e.stdout.toString('utf-8') : '';
  }

  const lines = (output || '').split('\n');
  for (const line of lines) {
    const match = line.trim().match(/^Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+(.*)$/);
    if (!match) continue;
    const [, mac, rawName] = match;
    const id = mac.replace(/:/g, '').toLowerCase();
    const trimmedName = rawName.trim();
    const name = trimmedName.length === 0 || trimmedName.match(/^[0-9A-Fa-f]{2}(-[0-9A-Fa-f]{2}){5}$/)
      ? `Okänd enhet (${mac.toUpperCase()})`
      : trimmedName;
    if (!seen.has(id)) {
      console.log(`[BLE] discovered: ${name} (${mac})`);
    }
    seen.set(id, { id, name, rssi: -50 });
  }

  logConnectionEvent({ type: 'scan_done', detail: `bluetoothctl done — ${seen.size} unique device(s)` });
  return Promise.resolve(Array.from(seen.values()));
}

function normalizeBleKey(value: string | null | undefined): string {
  return (value ?? '').replace(/:/g, '').toLowerCase();
}

/**
 * Do a brief noble BLE scan to find a specific device's peripheral object.
 * Noble needs this internal state before connectAsync will work.
 * Returns the peripheral if found, null otherwise.
 */
function nobleDiscoverPeripheral(targetId: string, timeoutMs = 3000): Promise<{ peripheral: any; addressType: string; connectable: boolean; serviceUuids: string[] } | null> {
  const targetNorm = normalizeBleKey(targetId);

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      try { noble.stopScanning(); } catch {}
      noble.removeListener('discover', onDiscover);
      if (timer) clearTimeout(timer);
      if (adapterTimer) clearTimeout(adapterTimer);
      resolve(result);
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let adapterTimer: ReturnType<typeof setTimeout> | null = null;

    const onDiscover = (peripheral: any) => {
      const keys = [
        normalizeBleKey(peripheral.id),
        normalizeBleKey(peripheral.address),
        normalizeBleKey(peripheral.uuid),
      ];

      if (!keys.includes(targetNorm)) return;

      const meta = {
        peripheral,
        addressType: peripheral.addressType ?? 'unknown',
        connectable: peripheral.connectable !== false,
        serviceUuids: peripheral.advertisement?.serviceUuids ?? [],
      };

      logConnectionEvent({ type: 'scan_done', detail: `noble found target: addressType=${meta.addressType}, connectable=${meta.connectable}` });
      finish(meta);
    };

    const startScan = () => {
      noble.on('discover', onDiscover);
      try {
        noble.startScanning([], true);
        logConnectionEvent({ type: 'scan_start', detail: `noble targeted scan for ${targetNorm} (${timeoutMs}ms)` });
        timer = setTimeout(() => {
          logConnectionEvent({ type: 'scan_done', detail: `noble targeted scan timeout — device not found` });
          finish(null);
        }, timeoutMs);
      } catch (e: any) {
        logConnectionEvent({ type: 'scan_done', detail: `noble scan failed: ${e.message}` });
        finish(null);
      }
    };

    if (getAdapterState() === 'poweredOn') {
      startScan();
      return;
    }

    const onState = (state: string) => {
      if (state !== 'poweredOn') return;
      noble.removeListener('stateChange', onState);
      if (adapterTimer) clearTimeout(adapterTimer);
      startScan();
    };

    noble.on('stateChange', onState);
    adapterTimer = setTimeout(() => {
      noble.removeListener('stateChange', onState);
      logConnectionEvent({ type: 'scan_done', detail: `noble scan skipped: adapter=${getAdapterState() ?? 'unknown'}` });
      finish(null);
    }, 3000);
  });
}

// ── Discovered devices from last scan ──
let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

/**
 * Scan for all BLE devices using bluetoothctl only.
 * Does NOT auto-connect — user picks from the list, then selectDevice() handles GATT.
 */
export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) return lastScanResults;
  scanning = true;
  lastScanResults = [];
  logConnectionEvent({ type: 'scan_start', detail: `bluetoothctl scan, timeout=${timeoutMs}ms` });

  try {
    const devices = await bluetoothctlScan(timeoutMs);
    lastScanResults = devices;
    logConnectionEvent({ type: 'scan_done', detail: `found ${devices.length} device(s)` });
    return devices;
  } finally {
    scanning = false;
  }
}

/**
 * Connect to a specific device by ID (from scan results).
 * Does a brief noble scan to discover the peripheral (needed for GATT),
 * then saves metadata for future reconnection.
 */
export async function selectDevice(deviceId: string): Promise<boolean> {
  const entry = lastScanResults.find(d => d.id === deviceId);
  if (!entry) {
    console.error(`[BLE] Device ${deviceId} not in scan results`);
    return false;
  }

  const mac = deviceId.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();

  // Disconnect existing device
  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }

  // Brief noble scan to find the peripheral object with addressType
  logConnectionEvent({ type: 'connect_start', detail: `selectDevice: noble scan for ${entry.name} (${mac})` });
  const meta = await nobleDiscoverPeripheral(deviceId, 4000);

  // Save with metadata (even if noble didn't find it, save what we have)
  setSavedDevice(deviceId, entry.name, mac, {
    addressType: meta?.addressType ?? null,
    connectable: meta?.connectable ?? null,
    serviceUuids: meta?.serviceUuids ?? null,
  });
  console.log(`[BLE] Saved device: ${entry.name} (${mac}) addressType=${meta?.addressType ?? 'unknown'}`);

  // Connect via the discovered noble peripheral
  if (meta?.peripheral) {
    try {
      logConnectionEvent({ type: 'connect_start', detail: `selectDevice: connecting via noble peripheral` });
      await connectPeripheral(meta.peripheral, 0, true);
      return true;
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', detail: `Noble peripheral connect failed: ${e.message}` });
    }
  }

  // Fallback: try direct connect (will also do a noble scan)
  logConnectionEvent({ type: 'connect_start', detail: `selectDevice: fallback to tryDirectConnect` });
  try {
    const ok = await tryDirectConnect(deviceId);
    if (ok) return true;
  } catch (e: any) {
    console.error(`[BLE] Failed to connect to ${deviceId}: ${e.message}`);
  }

  logConnectionEvent({ type: 'connect_fail', detail: `selectDevice failed for ${deviceId}` });
  return false;
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
 * Connect directly to a saved device — does a brief noble scan to find the
 * peripheral, then connects. No bluetoothctl scan needed.
 */
export async function tryDirectConnect(savedId: string): Promise<boolean> {
  const savedAddress = getSavedDeviceAddress();
  const savedName = getSavedDeviceName() ?? savedId;

  if (!savedAddress) {
    logConnectionEvent({ type: 'connect_fail', device: savedName, detail: 'No saved MAC address' });
    return false;
  }

  // Force adapter up
  try {
    execFileSync('bash', ['-lc', 'rfkill unblock bluetooth >/dev/null 2>&1 || true; (command -v btmgmt >/dev/null 2>&1 && btmgmt power on >/dev/null 2>&1) || true; (command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1) || true'], { timeout: 4000, stdio: 'ignore' });
  } catch {}

  // Wait for poweredOn
  for (let i = 0; i < 12; i++) {
    if (getAdapterState() === 'poweredOn') break;
    if (i === 11) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Adapter not ready: ${getAdapterState() ?? 'unknown'}` });
      return false;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Stop any lingering bluetoothctl scans
  try {
    execFileSync('bash', ['-lc', 'bluetoothctl scan off >/dev/null 2>&1 || true'], { timeout: 2000, stdio: 'ignore' });
  } catch {}

  // Noble needs its own scan to populate internal peripheral state
  logConnectionEvent({ type: 'connect_start', device: savedName, detail: `noble scan for ${savedId}` });
  const meta = await nobleDiscoverPeripheral(savedId, 4000);

  if (meta?.peripheral) {
    try {
      logConnectionEvent({ type: 'connect_start', device: savedName, detail: `Connecting via noble peripheral (addressType=${meta.addressType})` });
      await connectPeripheral(meta.peripheral, 0, true);
      return true;
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Noble connect failed: ${e.message}` });
    }
  } else {
    logConnectionEvent({ type: 'connect_fail', device: savedName, detail: 'Device not found in noble scan' });
  }

  return false;
}

/**
 * Auto-connect to saved device — brief noble scan then connect.
 */
export async function autoConnectSaved(timeoutMs = 15000): Promise<number> {
  const savedId = getSavedDeviceId();
  if (!savedId) {
    console.log('[BLE] No saved device — waiting for user selection');
    return 0;
  }
  if (getDevice()) return 1;
  if (scanning) return 0;

  const ok = await tryDirectConnect(savedId);
  if (ok) return 1;

  const savedName = getSavedDeviceName() ?? savedId;
  incrementConsecutiveFailures();
  const fails = getConsecutiveFailures();
  logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Auto-connect failed [fail#${fails}]` });
  if (fails >= HCI_RESET_THRESHOLD) {
    await resetHciAdapter();
  }
  return 0;
}
