/**
 * BLE scanning: device discovery via bluetoothctl + noble, GATT connection via noble.
 *
 * bluetoothctl discovers devices (reliable stdout parsing).
 * noble runs in parallel to capture addressType and peripheral metadata for reconnection.
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

/**
 * Run a short noble scan after bluetoothctl has finished so the two tools do not
 * compete for the same HCI socket. This captures reconnect metadata only.
 */
function nobleScanForMetadata(timeoutMs = 2500): Promise<Map<string, { peripheral: any; addressType: string; connectable: boolean; serviceUuids: string[] }>> {
  const results = new Map<string, { peripheral: any; addressType: string; connectable: boolean; serviceUuids: string[] }>();

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let adapterTimer: ReturnType<typeof setTimeout> | null = null;

    const onDiscover = (peripheral: any) => {
      const keys = new Set([
        normalizeBleKey(peripheral.id),
        normalizeBleKey(peripheral.address),
        normalizeBleKey(peripheral.uuid),
      ].filter(Boolean));

      const entry = {
        peripheral,
        addressType: peripheral.addressType ?? 'unknown',
        connectable: peripheral.connectable !== false,
        serviceUuids: peripheral.advertisement?.serviceUuids ?? [],
      };

      for (const key of keys) {
        results.set(key, entry);
      }
    };

    const cleanup = () => {
      try { noble.stopScanning(); } catch {}
      noble.removeListener('discover', onDiscover);
      if (adapterTimer) clearTimeout(adapterTimer);
      if (timer) clearTimeout(timer);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(results);
    };

    const startScan = () => {
      noble.on('discover', onDiscover);
      try {
        noble.startScanning([], true);
        logConnectionEvent({ type: 'scan_start', detail: `noble metadata scan starting (${timeoutMs}ms)` });
        timer = setTimeout(finish, timeoutMs);
      } catch (e: any) {
        logConnectionEvent({ type: 'scan_done', detail: `noble metadata scan skipped: ${e.message}` });
        finish();
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
      logConnectionEvent({ type: 'scan_done', detail: `noble metadata scan skipped: adapter=${getAdapterState() ?? 'unknown'}` });
      finish();
    }, 3000);
  });
}

function mergeDiscoveryMetadata(devices: DiscoveredDevice[], nobleMeta: Map<string, { peripheral: any; addressType: string; connectable: boolean; serviceUuids: string[] }>): void {
  for (const device of devices) {
    const meta = nobleMeta.get(device.id);
    if (!meta) continue;
    logConnectionEvent({ type: 'scan_done', detail: `${device.name}: addressType=${meta.addressType}, connectable=${meta.connectable}` });
  }
}

/**
 * Scan for all BLE devices using bluetoothctl first, then a short noble pass for
 * metadata capture. Running them sequentially avoids HCI contention on Raspberry Pi.
 */
export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) return lastScanResults;
  scanning = true;
  lastScanResults = [];
  discoveredMeta.clear();
  logConnectionEvent({ type: 'scan_start', detail: `hybrid scan, timeout=${timeoutMs}ms` });

  try {
    const btDevices = await bluetoothctlScan(timeoutMs);
    lastScanResults = btDevices;

    if (btDevices.length === 0) {
      logConnectionEvent({ type: 'scan_done', detail: 'bluetoothctl found 0 devices — skipping noble metadata scan' });
      return btDevices;
    }

    const nobleMeta = await nobleScanForMetadata(Math.min(2500, timeoutMs));
    discoveredMeta = nobleMeta;
    mergeDiscoveryMetadata(btDevices, nobleMeta);

    logConnectionEvent({ type: 'scan_done', detail: `found ${btDevices.length} device(s), ${nobleMeta.size} metadata key(s)` });
    return btDevices;
  } finally {
    scanning = false;
  }
}

/**
 * Connect to a specific device by ID (from scan results).
 * Saves full discovery metadata for reconnection without re-scanning.
 */
export async function selectDevice(deviceId: string): Promise<boolean> {
  const entry = lastScanResults.find(d => d.id === deviceId);
  if (!entry) {
    console.error(`[BLE] Device ${deviceId} not in scan results`);
    return false;
  }

  const mac = deviceId.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
  const meta = discoveredMeta.get(deviceId);

  // Save with full metadata for reconnection
  setSavedDevice(deviceId, entry.name, mac, {
    addressType: meta?.addressType ?? null,
    connectable: meta?.connectable ?? null,
    serviceUuids: meta?.serviceUuids ?? null,
  });
  console.log(`[BLE] Saved device: ${entry.name} (${mac}) addressType=${meta?.addressType ?? 'unknown'}`);

  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }

  // If we have a noble peripheral from the scan, connect directly via it
  if (meta?.peripheral) {
    try {
      logConnectionEvent({ type: 'connect_start', detail: `selectDevice: using cached noble peripheral` });
      await connectPeripheral(meta.peripheral, 0, true);
      return true;
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', detail: `Cached peripheral connect failed: ${e.message}` });
    }
  }

  // Fallback to direct connect
  try {
    const ok = await tryDirectConnect(deviceId);
    if (ok) return true;
    logConnectionEvent({ type: 'connect_fail', detail: `selectDevice failed for ${deviceId}` });
    return false;
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
 * Connect directly by MAC address using saved metadata — NO scanning.
 * Uses saved addressType to create a proper noble peripheral.
 */
export async function tryDirectConnect(savedId: string): Promise<boolean> {
  const savedAddress = getSavedDeviceAddress();
  const savedName = getSavedDeviceName() ?? savedId;
  const savedAddressType = getSavedAddressType() ?? 'random';

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

  const macLower = savedAddress.toLowerCase();

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      logConnectionEvent({ type: 'connect_start', device: savedName, detail: `Retry ${attempt + 1}` });
      await new Promise(r => setTimeout(r, 500));
    }

    // Try connectAsync with address (noble @stoprocent supports MAC address + addressType)
    for (const target of [macLower, normalizeBleKey(savedId)]) {
      logConnectionEvent({ type: 'connect_start', device: savedName, detail: `noble.connectAsync(${target}, addressType=${savedAddressType}) attempt ${attempt + 1}` });

      try {
        const peripheral = await Promise.race<any>([
          (noble as any).connectAsync(target, { addressType: savedAddressType }),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`connectAsync timeout`)), 5000)),
        ]);

        if (peripheral) {
          logConnectionEvent({ type: 'connect_ok', device: savedName, detail: `Direct connect OK via ${target} (addressType=${savedAddressType})` });
          await connectPeripheral(peripheral, 0, true);
          return true;
        }
      } catch (e: any) {
        logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Failed ${target}: ${e.message}` });
      }
    }
  }

  return false;
}

/**
 * Auto-connect to saved device — direct MAC connect only, no scanning.
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
