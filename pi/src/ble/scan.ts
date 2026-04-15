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

/**
 * Use noble to find a specific peripheral by ID (MAC-based).
 * Short targeted scan — we already know the device is nearby from hcitool.
 */
function normalizeBleKey(value: string | null | undefined): string {
  return (value ?? '').replace(/:/g, '').toLowerCase();
}

function nobleFind(targetId: string, timeoutMs = 5000): Promise<any | null> {
  return new Promise((resolve) => {
    const normalizedTarget = normalizeBleKey(targetId);

    if (getAdapterState() !== 'poweredOn') {
      console.warn('[BLE] nobleFind: adapter not poweredOn');
      resolve(null);
      return;
    }

    const cached = Object.values((noble as any)._peripherals ?? {}).find((peripheral: any) => {
      return normalizeBleKey(peripheral?.id) === normalizedTarget
        || normalizeBleKey(peripheral?.address) === normalizedTarget;
    });
    if (cached) {
      console.log(`[BLE] nobleFind: found ${targetId} in noble cache`);
      resolve(cached);
      return;
    }

    let found = false;

    const onDiscover = (peripheral: any) => {
      if (found) return;
      const peripheralId = normalizeBleKey(peripheral?.id);
      const peripheralAddress = normalizeBleKey(peripheral?.address);
      if (peripheralId === normalizedTarget || peripheralAddress === normalizedTarget) {
        found = true;
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        clearTimeout(timer);
        console.log(`[BLE] nobleFind: found ${targetId} via scan`);
        resolve(peripheral);
      }
    };

    try {
      execFileSync('bash', ['-lc', 'bluetoothctl scan off >/dev/null 2>&1 || true'], { timeout: 2000, stdio: 'ignore' });
    } catch {}

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
  if (getAdapterState() !== 'poweredOn') return false;

  const savedAddress = getSavedDeviceAddress();
  const savedName = getSavedDeviceName() ?? savedId;
  const uuid = normalizeBleKey(savedId);

  // 1. Check noble cache first
  const cachedPeripheral = (noble as any)._peripherals?.[uuid];
  if (cachedPeripheral) {
    logConnectionEvent({ type: 'connect_start', device: savedName, detail: 'Direct connect (cached peripheral)' });
    try {
      await connectPeripheral(cachedPeripheral);
      return true;
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Cached connect failed: ${e.message}` });
    }
  }

  // 2. Inject peripheral into noble from known MAC and connect directly
  if (savedAddress) {
    const addressRaw = savedAddress.toLowerCase();
    logConnectionEvent({ type: 'connect_start', device: savedName, detail: `Injecting ${savedAddress} into noble — direct connect (no scan)` });

    try {
      // Ensure bluetoothctl isn't holding the adapter
      try {
        execFileSync('bash', ['-lc', 'bluetoothctl scan off >/dev/null 2>&1 || true'], { timeout: 2000, stdio: 'ignore' });
      } catch {}

      // Emit discover to populate noble's internal Peripheral object
      const bindings = (noble as any)._bindings;
      if (bindings && typeof bindings.emit === 'function') {
        // Noble expects: uuid, address, addressType, connectable, advertisement, rssi
        const advertisement = {
          localName: savedName,
          txPowerLevel: undefined,
          manufacturerData: undefined,
          serviceData: [],
          serviceUuids: [SERVICE_UUID],
          solicitationServiceUuids: [],
        };
        bindings.emit('discover', uuid, addressRaw, 'public', true, advertisement, -50);
        // Small delay to let noble process the event and create the Peripheral
        await new Promise(r => setTimeout(r, 50));
      }

      const peripheral = (noble as any)._peripherals?.[uuid];
      if (peripheral) {
        logConnectionEvent({ type: 'connect_start', device: savedName, detail: `Peripheral injected OK, connecting...` });
        await connectPeripheral(peripheral);
        return true;
      } else {
        logConnectionEvent({ type: 'connect_fail', device: savedName, detail: 'Peripheral not created after inject' });
      }
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Direct inject connect failed: ${e.message}` });
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
