/**
 * BLE scanning: device discovery via hcitool, GATT connection via noble.
 *
 * noble's own LE scanning often fails on Pi due to HCI socket contention.
 * hcitool lescan uses legacy HCI commands that coexist with noble's socket,
 * so we use it for discovery and noble only for GATT connect.
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { noble, getDevice, setDevice, getAdapterState, getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, setSavedDevice, logConnectionEvent } from './state.js';
import { connectPeripheral, incrementConsecutiveFailures, getConsecutiveFailures, resetHciAdapter } from './connection.js';
import { resetLastSent } from './protocol.js';
import type { DiscoveredDevice } from './types.js';

const HCI_RESET_THRESHOLD = 3;
const STOP_SCAN_TIMEOUT_MS = 1500;

async function stopNobleScanningSafely(timeoutMs = STOP_SCAN_TIMEOUT_MS): Promise<void> {
  try {
    await Promise.race([
      noble.stopScanningAsync(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`stopScanningAsync timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  } catch (e: any) {
    logConnectionEvent({ type: 'scan_start', detail: `noble stopScanningAsync fastnade, fallback används: ${e.message}` });
    try { noble.stopScanning(); } catch {}
  }
}

// ── hcitool-based discovery ──

/**
 * Run `hcitool lescan` for the given duration and parse discovered devices.
 * Returns a list of unique devices with MAC-derived IDs (noble-compatible).
 */
function hcitoolScan(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  const seen = new Map<string, DiscoveredDevice>();

  logConnectionEvent({ type: 'scan_start', detail: `hcitool scan starting (timeout=${timeoutMs}ms)` });

  // Stop noble scanning so it doesn't hold the HCI socket
  try { noble.stopScanning(); } catch {}

  // Reset adapter, then scan to tempfile so output survives SIGTERM
  const scanSeconds = Math.max(2, Math.ceil(timeoutMs / 1000));
  const tmpFile = '/tmp/ble_scan_out.txt';
  // hcitool lescan writes to stderr on some systems — capture both streams
  const cmd = `sudo hciconfig hci0 reset && sleep 0.5 && sudo timeout ${scanSeconds} hcitool lescan --duplicates > ${tmpFile} 2>&1; true`;
  const execTimeoutMs = (scanSeconds * 1000) + 5000; // margin for reset + sleep

  try {
    logConnectionEvent({ type: 'scan_start', detail: `Running: ${cmd}` });
    execSync(cmd, {
      timeout: execTimeoutMs,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    // Read captured output from tempfile
    let output = '';
    try { output = readFileSync(tmpFile, 'utf-8'); } catch {}
    try { unlinkSync(tmpFile); } catch {}

    const lines = output.split('\n');
    logConnectionEvent({ type: 'scan_start', detail: `hcitool raw output: ${lines.length} lines, ${output.length} bytes` });
    for (const line of lines) {
      const match = line.trim().match(/^([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+(.*)$/);
      if (!match) continue;
      const [, mac, rawName] = match;
      const id = mac.replace(/:/g, '').toLowerCase();
      const name = rawName.trim() === '(unknown)' || rawName.trim().length === 0
        ? `Okänd enhet (${mac.toUpperCase()})`
        : rawName.trim();
      if (!seen.has(id)) {
        logConnectionEvent({ type: 'scan_start', detail: `discovered: ${name} (${mac})` });
        console.log(`[BLE] hcitool discovered: ${name} (${mac})`);
      }
      seen.set(id, { id, name, rssi: -50 });
    }

    logConnectionEvent({ type: 'scan_done', detail: `hcitool done — ${seen.size} unique device(s)` });
  } catch (e: any) {
    logConnectionEvent({ type: 'connect_fail', detail: `hcitool exec failed: ${e.message?.slice(0, 120)}` });
    console.error(`[BLE] hcitool exec failed: ${e.message}`);
    // Try to kill any leftover hcitool process
    try { execSync('sudo killall -9 hcitool', { timeout: 2000 }); } catch {}
  }

  const devices = Array.from(seen.values());
  console.log(`[BLE] hcitool scan done — ${devices.length} device(s)`);
  return Promise.resolve(devices);
}

/**
 * Use noble to find a specific peripheral by ID (MAC-based).
 * Short targeted scan — we already know the device is nearby from hcitool.
 */
function nobleFind(targetId: string, timeoutMs = 5000): Promise<any | null> {
  return new Promise((resolve) => {
    if (getAdapterState() !== 'poweredOn') {
      console.warn('[BLE] nobleFind: adapter not poweredOn');
      resolve(null);
      return;
    }

    // Check noble's cache first
    const cached = (noble as any)._peripherals?.[targetId];
    if (cached) {
      console.log(`[BLE] nobleFind: found ${targetId} in noble cache`);
      resolve(cached);
      return;
    }

    let found = false;

    const onDiscover = (peripheral: any) => {
      if (found) return;
      if (peripheral.id === targetId) {
        found = true;
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        clearTimeout(timer);
        console.log(`[BLE] nobleFind: found ${targetId} via scan`);
        resolve(peripheral);
      }
    };

    noble.on('discover', onDiscover);
    noble.startScanningAsync([], true).catch(() => {});

    const timer = setTimeout(() => {
      noble.removeListener('discover', onDiscover);
      noble.stopScanningAsync().catch(() => {});
      if (!found) {
        console.warn(`[BLE] nobleFind: ${targetId} not found within ${timeoutMs}ms`);
        resolve(null);
      }
    }, timeoutMs);
  });
}

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


export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

/**
 * Scan for all BLE devices using hcitool and return the list.
 * Does NOT auto-connect — user picks from the list, then selectDevice() handles GATT.
 */
export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    return lastScanResults;
  }
  scanning = true;
  lastScanResults = [];
  discoveredPeripherals.clear();
  logConnectionEvent({ type: 'scan_start', detail: `hcitool scan, timeout=${timeoutMs}ms` });

  // Stop any noble scan so hcitool can use the adapter
  await stopNobleScanningSafely();

  try {
    const devices = await hcitoolScan(timeoutMs);
    lastScanResults = devices;
    logConnectionEvent({ type: 'scan_done', detail: `found ${devices.length} device(s) via hcitool` });
    return devices;
  } finally {
    scanning = false;
  }
}

/**
 * Connect to a specific device by ID (from scan results).
 * Saves the ID for auto-reconnect on restart.
 */
export async function selectDevice(deviceId: string): Promise<boolean> {
  const entry = lastScanResults.find(d => d.id === deviceId);
  if (!entry) {
    console.error(`[BLE] Device ${deviceId} not in hcitool scan results`);
    return false;
  }

  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }

  try {
    // Get noble peripheral object via quick targeted scan
    const peripheral = await nobleFind(deviceId, 5000);
    if (!peripheral) {
      console.error(`[BLE] Could not find ${deviceId} via noble for GATT connect`);
      return false;
    }

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
export async function tryDirectConnect(savedId: string): Promise<boolean> {
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

  // Quick targeted scan via noble — 3 seconds
  logConnectionEvent({ type: 'scan_start', device: savedName, detail: 'Quick noble targeted scan (3s)' });
  const peripheral = await nobleFind(savedId, 3000);
  if (peripheral) {
    try {
      await connectPeripheral(peripheral);
      return true;
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Quick scan connect failed: ${e.message}` });
      return false;
    }
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

  // Auto-connect uses noble only (no hcitool) to avoid blocking manual scans
  const savedName = getSavedDeviceName() ?? savedId;
  logConnectionEvent({ type: 'scan_start', device: savedName, detail: 'auto-connect noble scan' });

  const peripheral = await nobleFind(savedId, Math.min(timeoutMs, 5000));
  if (!peripheral) {
    logConnectionEvent({ type: 'scan_done', device: savedName, detail: 'Not found via noble' });
    return 0;
  }

  try {
    await connectPeripheral(peripheral);
    return 1;
  } catch (e: any) {
    incrementConsecutiveFailures();
    const fails = getConsecutiveFailures();
    logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Auto-connect failed: ${e.message} [fail#${fails}]` });
    if (fails >= HCI_RESET_THRESHOLD) {
      await resetHciAdapter();
    }
    return 0;
  }
}
