/**
 * BLE scanning & connection.
 *
 * Scan:    bluetoothctl only — proven reliable, no noble involvement.
 * Connect: brief noble scan to discover peripheral, then GATT connect.
 * Send:    handled by protocol.ts (unchanged).
 *
 * Key constraint: noble and bluetoothctl cannot use the HCI socket simultaneously.
 * All noble operations explicitly stop bluetoothctl first, and vice versa.
 */

import { execFileSync } from 'child_process';
import { noble, getDevice, setDevice, getAdapterState, getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, setSavedDevice, setNobleHciReleased, logConnectionEvent } from './state.js';
import { connectPeripheral, incrementConsecutiveFailures, getConsecutiveFailures, resetHciAdapter } from './connection.js';
import { resetLastSent } from './protocol.js';
import type { DiscoveredDevice } from './types.js';

const HCI_RESET_THRESHOLD = 3;

function normalizeBleKey(value: string | null | undefined): string {
  return (value ?? '').replace(/:/g, '').toLowerCase();
}

/** Kill any bluetoothctl scan so noble can use HCI */
function stopBluetoothctl(): void {
  try {
    execFileSync('bash', ['-lc', 'bluetoothctl scan off >/dev/null 2>&1 || true'], { timeout: 2000, stdio: 'ignore' });
  } catch {}
}

/** Force noble to fully release HCI so bluetoothctl can use the adapter */
function stopNoble(): void {
  try { noble.stopScanning(); } catch {}
  try {
    const bindings = (noble as any)._bindings;
    if (bindings?._hci?.stop) {
      bindings._hci.stop();
      setNobleHciReleased(true);
      logConnectionEvent({ type: 'scan_start', detail: 'noble HCI released for bluetoothctl' });
    }
  } catch {}
}

// ── State ──
let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

// ─────────────────────────────────────────────────────────
// STEP 1: SCAN — pure bluetoothctl (proven working)
// ─────────────────────────────────────────────────────────

export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) return lastScanResults;
  scanning = true;
  lastScanResults = [];

  const scanSeconds = Math.max(2, Math.ceil(timeoutMs / 1000));
  logConnectionEvent({ type: 'scan_start', detail: `bluetoothctl scan, timeout=${scanSeconds}s` });

  stopNoble();

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
    output = typeof e?.stdout === 'string' ? e.stdout
      : Buffer.isBuffer(e?.stdout) ? e.stdout.toString('utf-8') : '';
  }

  const seen = new Map<string, DiscoveredDevice>();
  for (const line of (output || '').split('\n')) {
    const match = line.trim().match(/^Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+(.*)$/);
    if (!match) continue;
    const [, mac, rawName] = match;
    const id = mac.replace(/:/g, '').toLowerCase();
    const trimmedName = rawName.trim();
    const name = trimmedName.length === 0 || trimmedName.match(/^[0-9A-Fa-f]{2}(-[0-9A-Fa-f]{2}){5}$/)
      ? `Okänd enhet (${mac.toUpperCase()})`
      : trimmedName;
    if (!seen.has(id)) console.log(`[BLE] discovered: ${name} (${mac})`);
    seen.set(id, { id, name, rssi: -50 });
  }

  lastScanResults = Array.from(seen.values());
  scanning = false;
  logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s)` });
  return lastScanResults;
}

// ─────────────────────────────────────────────────────────
// STEP 2: CONNECT — noble scan → peripheral → GATT
// ─────────────────────────────────────────────────────────

/**
 * Find a device via a brief noble scan, then connect.
 * Noble must scan to populate its internal peripheral cache
 * before connectAsync/connectPeripheral will work.
 */
async function nobleConnect(targetId: string, name: string, timeoutMs = 5000): Promise<boolean> {
  const targetNorm = normalizeBleKey(targetId);

  stopBluetoothctl();
  await new Promise(r => setTimeout(r, 300));

  try {
    setNobleHciReleased(false);
    const bindings = (noble as any)._bindings;
    if (bindings?._hci?.start) {
      bindings._hci.start();
      logConnectionEvent({ type: 'connect_start', device: name, detail: 'noble HCI re-initialized' });
    }
  } catch {}
  await new Promise(r => setTimeout(r, 300));

  // Wait for adapter
  for (let i = 0; i < 10; i++) {
    if (getAdapterState() === 'poweredOn') break;
    if (i === 9) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: `Adapter not ready: ${getAdapterState()}` });
      return false;
    }
    await new Promise(r => setTimeout(r, 500));
  }

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

// ─────────────────────────────────────────────────────────
// PUBLIC API: selectDevice, forgetDevice, autoConnect
// ─────────────────────────────────────────────────────────

/**
 * User selected a device from scan results → save + connect.
 */
export async function selectDevice(deviceId: string): Promise<boolean> {
  const entry = lastScanResults.find(d => d.id === deviceId);
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
  if (scanning) return 0;

  const savedName = getSavedDeviceName() ?? savedId;

  // Force adapter up
  try {
    execFileSync('bash', ['-lc', 'rfkill unblock bluetooth >/dev/null 2>&1 || true; (command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1) || true'], { timeout: 4000, stdio: 'ignore' });
  } catch {}

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
export const tryDirectConnect = (id: string) => autoConnectSaved().then(r => r > 0);
