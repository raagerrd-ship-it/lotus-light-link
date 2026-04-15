/**
 * BLE scanning: device discovery via bluetoothctl, GATT connection via noble.
 *
 * bluetoothctl writes to stdout (unlike hcitool which writes to TTY),
 * making it reliable for programmatic use. noble is used only for GATT connect.
 */

import { execFileSync } from 'child_process';
import { noble, getDevice, setDevice, getAdapterState, getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, setSavedDevice, logConnectionEvent } from './state.js';
import { connectPeripheral, incrementConsecutiveFailures, getConsecutiveFailures, resetHciAdapter } from './connection.js';
import { resetLastSent } from './protocol.js';
import type { DiscoveredDevice } from './types.js';

const HCI_RESET_THRESHOLD = 3;

// ── bluetoothctl-based discovery ──

/**
 * Run `bluetoothctl scan le` for the given duration, then list discovered devices.
 * bluetoothctl writes to stdout reliably (unlike hcitool which writes to TTY).
 */
function bluetoothctlScan(timeoutMs = 2000): Promise<DiscoveredDevice[]> {
  const seen = new Map<string, DiscoveredDevice>();
  const scanSeconds = Math.max(2, Math.ceil(timeoutMs / 1000));

  logConnectionEvent({ type: 'scan_start', detail: `bluetoothctl scan starting (timeout=${scanSeconds}s)` });

  // Stop noble scanning so it doesn't hold the HCI socket
  try { noble.stopScanning(); } catch {}

  // Run LE scan then list discovered devices.
  // Avoid sudo here: the engine runs as a user service and non-interactive sudo can fail silently.
  const cmd = `bluetoothctl --timeout ${scanSeconds} scan le >/dev/null 2>&1; bluetoothctl devices`;
  const execTimeoutMs = (scanSeconds * 1000) + 3000;

  let output = '';
  try {
    logConnectionEvent({ type: 'scan_start', detail: `Running: ${cmd}` });
    output = execFileSync('bash', ['-lc', cmd], {
      timeout: execTimeoutMs,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    output = typeof e?.stdout === 'string'
      ? e.stdout
      : Buffer.isBuffer(e?.stdout)
        ? e.stdout.toString('utf-8')
        : '';
    const stderr = typeof e?.stderr === 'string'
      ? e.stderr
      : Buffer.isBuffer(e?.stderr)
        ? e.stderr.toString('utf-8')
        : '';
    const stderrPreview = stderr.trim().replace(/\s+/g, ' ').slice(0, 120);
    logConnectionEvent({ type: 'connect_fail', detail: `bluetoothctl exitade med felkod, stdout=${output.length}b stderr=${stderr.length}b${stderrPreview ? ` — ${stderrPreview}` : ''}` });
    if (stderr) {
      console.error(`[BLE] bluetoothctl stderr: ${stderr}`);
    }
  }

  const lines = (output || '').split('\n');
  logConnectionEvent({ type: 'scan_start', detail: `bluetoothctl output: ${lines.length} lines` });
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
      logConnectionEvent({ type: 'scan_start', detail: `discovered: ${name} [${mac}]` });
      console.log(`[BLE] discovered: ${name} (${mac})`);
    }
    seen.set(id, { id, name, rssi: -50 });
  }

  logConnectionEvent({ type: 'scan_done', detail: `bluetoothctl done — ${seen.size} unique device(s)` });

  const devices = Array.from(seen.values());
  console.log(`[BLE] scan done — ${devices.length} device(s)`);
  return Promise.resolve(devices);
}


function normalizeBleKey(value: string | null | undefined): string {
  return (value ?? '').replace(/:/g, '').toLowerCase();
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
  logConnectionEvent({ type: 'scan_start', detail: `bluetoothctl scan, timeout=${timeoutMs}ms` });

  try {
    const devices = await bluetoothctlScan(timeoutMs);
    lastScanResults = devices;
    logConnectionEvent({ type: 'scan_done', detail: `found ${devices.length} device(s) via bluetoothctl` });
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
    console.error(`[BLE] Device ${deviceId} not in scan results`);
    return false;
  }

  // Save immediately so auto-reconnect knows which device to target
  const mac = deviceId.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
  setSavedDevice(deviceId, entry.name, mac);
  console.log(`[BLE] Saved device: ${entry.name} (${mac})`);

  const device = getDevice();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
  }

  try {
    logConnectionEvent({ type: 'connect_start', detail: `selectDevice: direct connect for ${deviceId}, adapter=${getAdapterState()}` });

    const ok = await tryDirectConnect(deviceId);
    if (ok) {
      return true;
    }

    const reason = getAdapterState() !== 'poweredOn'
      ? `adapter state: ${getAdapterState()}`
      : 'not found in noble cache/direct-address/scan';
    logConnectionEvent({ type: 'connect_fail', detail: `selectDevice failed: ${reason}` });
    console.error(`[BLE] Could not connect ${deviceId} — ${reason}`);
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
 * Connect directly by MAC address — NO scanning.
 * On Linux, noble uses HCI bindings where the peripheral UUID is the MAC
 * without colons, lowercase. We inject a peripheral into noble's internal
 * state and call connect directly.
 */
export async function tryDirectConnect(savedId: string): Promise<boolean> {
  const adapterState = getAdapterState();
  if (adapterState !== 'poweredOn') {
    logConnectionEvent({ type: 'connect_fail', device: getSavedDeviceName() ?? savedId, detail: `Adapter not ready: ${adapterState ?? 'unknown'}` });
    return false;
  }
  const savedAddress = getSavedDeviceAddress();
  const savedName = getSavedDeviceName() ?? savedId;

  if (!savedAddress) {
    logConnectionEvent({ type: 'connect_fail', device: savedName, detail: 'No saved MAC address' });
    return false;
  }

  // Ensure bluetoothctl isn't holding the HCI socket
  try {
    execFileSync('bash', ['-lc', 'bluetoothctl scan off >/dev/null 2>&1 || true'], { timeout: 2000, stdio: 'ignore' });
  } catch {}

  // @stoprocent/noble supports direct connect by address — no scan needed
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      logConnectionEvent({ type: 'connect_start', device: savedName, detail: `Retry ${attempt + 1} after 500ms` });
      await new Promise(r => setTimeout(r, 500));
    }

    logConnectionEvent({ type: 'connect_start', device: savedName, detail: `noble.connectAsync(${savedAddress}) attempt ${attempt + 1}` });

    try {
      const peripheral = await (noble as any).connectAsync(savedAddress);
      if (peripheral) {
        logConnectionEvent({ type: 'connect_ok', device: savedName, detail: 'Direct connect OK — starting GATT' });
        await connectPeripheral(peripheral);
        return true;
      }
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Direct connect failed (attempt ${attempt + 1}): ${e.message}` });
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

  // Direct connect failed — don't scan, just report failure
  const savedName = getSavedDeviceName() ?? savedId;
  incrementConsecutiveFailures();
  const fails = getConsecutiveFailures();
  logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Auto-connect failed (no scan) [fail#${fails}]` });
  if (fails >= HCI_RESET_THRESHOLD) {
    await resetHciAdapter();
  }
  return 0;
}
