/**
 * BlueZ D-Bus BLE driver for a SINGLE BLEDOM LED strip on Raspberry Pi.
 * Uses system D-Bus → org.bluez instead of raw HCI, so it works in
 * sandboxed runtimes (NoNewPrivileges, dropped capabilities, etc.)
 * as long as the user is in the `bluetooth` group.
 *
 * Drop-in replacement for the former noble-based driver — same exports.
 */

import dbus from 'dbus-next';
import { getItem, setItem } from './storage.js';

const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const CHAR_UUID   = '0000fff3-0000-1000-8000-00805f9b34fb';
const BLUEZ       = 'org.bluez';
const ADAPTER_PATH = '/org/bluez/hci0';

export type DeviceMode = 'rgb' | 'brightness';

// Kept for type compatibility — now backed by D-Bus characteristic proxy
export interface PiCharacteristic {
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  _peripheral?: any;
  deviceName?: string;
  deviceId?: string;
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi: number;
}

// ── D-Bus bus instance (lazy-init) ──
let bus: dbus.MessageBus | null = null;

function getBus(): dbus.MessageBus {
  if (!bus) {
    bus = dbus.systemBus();
  }
  return bus;
}

// ── Single device state ──
let device: {
  deviceProxy: any;       // org.bluez.Device1 proxy
  charProxy: any;         // org.bluez.GattCharacteristic1 proxy
  mode: DeviceMode;
  name: string;
  id: string;             // MAC-based ID like AA:BB:CC:DD:EE:FF
  objectPath: string;     // /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF
} | null = null;

// ── Discovered devices from last scan ──
let lastScanResults: DiscoveredDevice[] = [];
let discoveredPaths = new Map<string, string>(); // id → object path

// ── Saved device ID + name (persisted) ──
let savedDeviceId: string | null = getItem('ble-device-id') ?? null;
let savedDeviceName: string | null = getItem('ble-device-name') ?? null;

// Pre-allocated write buffers
const writeBuf = Buffer.from([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const brightBuf = Buffer.from([0x7e, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]);
const brightMaxBuf = Buffer.from([0x7e, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0xef]);

// Dimming gamma
let dimmingGamma = 1.8;
export function setDimmingGamma(v: number) {
  dimmingGamma = Math.max(1.0, Math.min(3.0, v));
  rebuildBrightnessLut();
}
export function getDimmingGamma(): number { return dimmingGamma; }

const brightnessLut = new Float64Array(101);
function rebuildBrightnessLut(): void {
  for (let i = 0; i <= 100; i++) {
    const norm = i / 100;
    brightnessLut[i] = norm <= 0 ? 0 : Math.pow(norm, dimmingGamma);
  }
}
rebuildBrightnessLut();

// ── Adapter state via D-Bus ──
let _adapterState: string = 'unknown';

async function refreshAdapterState(): Promise<void> {
  try {
    const obj = await getBus().getProxyObject(BLUEZ, ADAPTER_PATH);
    const props = obj.getInterface('org.freedesktop.DBus.Properties');
    const powered: dbus.Variant = await props.Get('org.bluez.Adapter1', 'Powered');
    _adapterState = powered.value ? 'poweredOn' : 'poweredOff';
  } catch (e: any) {
    if (e.message?.includes('org.freedesktop.DBus.Error.AccessDenied') ||
        e.message?.includes('org.bluez.Error.NotReady')) {
      _adapterState = 'unauthorized';
    } else {
      _adapterState = 'unavailable';
    }
    console.warn(`[BLE] Adapter state check: ${_adapterState} (${e.message ?? e})`);
  }
}

// Run once at import to seed initial state (non-blocking)
refreshAdapterState().catch(() => {});

export function getAdapterState(): string | undefined {
  return _adapterState;
}

function brightnessToScale(brightness: number): number {
  const idx = brightness < 0 ? 0 : brightness > 100 ? 100 : (brightness + 0.5) | 0;
  return brightnessLut[idx];
}

// ── Write guards ──
let lastR = -1, lastG = -1, lastB = -1, lastBr = -1;
let writeInFlight = false;
let lastWriteTime = 0;
let writeFailCount = 0;
const WRITE_FAIL_THRESHOLD = 5;
const WRITE_TIMEOUT_MS = 500;

export const bleStats = {
  sentCount: 0,
  skipDeltaCount: 0,
  skipBusyCount: 0,
  writeFailCount: 0,
  writeLatMs: 0,
  writeLatAvgMs: 0,
  effectiveIntervalMs: 0,
};

// ── Keep-alive ──
const KEEPALIVE_MS = 1000;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveFailCount = 0;

function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveFailCount = 0;
  keepAliveTimer = setInterval(async () => {
    if (!device) return;
    const elapsed = performance.now() - lastWriteTime;
    if (lastWriteTime > 0 && elapsed < KEEPALIVE_MS * 0.8) return;
    const buf = device.mode === 'brightness' ? brightBuf : writeBuf;
    try {
      await writeCharValue(buf, true);
      lastWriteTime = performance.now();
      if (keepAliveFailCount > 0) {
        console.log(`[BLE] Keep-alive recovered after ${keepAliveFailCount} failures`);
        keepAliveFailCount = 0;
      }
    } catch (e: any) {
      keepAliveFailCount++;
      if (keepAliveFailCount <= 3 || keepAliveFailCount % 10 === 0) {
        console.warn(`[BLE] Keep-alive write failed (${keepAliveFailCount}x): ${e.message ?? e}`);
      }
    }
  }, KEEPALIVE_MS);
}

function stopKeepAlive(): void {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

export function resetLastSent(): void {
  lastR = lastG = lastB = lastBr = -1;
  writeInFlight = false;
  lastWriteTime = 0;
}

// ── D-Bus write helper ──
async function writeCharValue(data: Buffer, withoutResponse: boolean): Promise<void> {
  if (!device?.charProxy) throw new Error('No characteristic');
  const options: Record<string, dbus.Variant> = {};
  if (withoutResponse) {
    options['type'] = new dbus.Variant('s', 'command');
  }
  await device.charProxy.WriteValue(Array.from(data), options);
}

// ── Main write function ──
export async function sendToBLE(r: number, g: number, b: number, brightness: number): Promise<void> {
  if (!device) return;

  const scale = brightnessToScale(brightness);
  const cr = (r * scale + 0.5) | 0;
  const cg = (g * scale + 0.5) | 0;
  const cb = (b * scale + 0.5) | 0;
  const cbr = (scale * 0xff + 0.5) | 0;

  if (writeInFlight) {
    if (lastWriteTime > 0 && (performance.now() - lastWriteTime) > WRITE_TIMEOUT_MS) {
      console.warn('[BLE] Write timeout — forcing writeInFlight release');
      writeInFlight = false;
    } else {
      bleStats.skipBusyCount++;
      return;
    }
  }
  if (cr === lastR && cg === lastG && cb === lastB && cbr === lastBr) {
    bleStats.skipDeltaCount++;
    return;
  }

  writeInFlight = true;
  const now = performance.now();

  try {
    if (device.mode === 'brightness') {
      brightBuf[3] = cbr;
      await writeCharValue(brightBuf, true);
    } else {
      writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
      await writeCharValue(writeBuf, true);
    }

    lastR = cr; lastG = cg; lastB = cb; lastBr = cbr;
    bleStats.sentCount++;
    if (writeFailCount > 0) {
      console.log(`[BLE] Write recovered after ${writeFailCount} failures`);
    }
    writeFailCount = 0;

    const elapsed = performance.now() - now;
    bleStats.writeLatMs = Math.round(elapsed * 10) / 10;
    bleStats.writeLatAvgMs = Math.round(
      (bleStats.writeLatAvgMs * 0.9 + elapsed * 0.1) * 10
    ) / 10;

    if (lastWriteTime > 0) {
      bleStats.effectiveIntervalMs = Math.round(now - lastWriteTime);
    }
    lastWriteTime = now;
  } catch (e: any) {
    writeFailCount++;
    bleStats.writeFailCount++;
    if (writeFailCount === 1 || writeFailCount === WRITE_FAIL_THRESHOLD) {
      console.warn(`[BLE] Write failed (${writeFailCount}x): ${e.message ?? e}`);
    }
    if (writeFailCount >= WRITE_FAIL_THRESHOLD && device && _demandConnect) {
      console.warn('[BLE] Too many write failures — triggering proactive reconnect');
      const devPath = device.objectPath;
      const devName = device.name;
      stopKeepAlive();
      device = null;
      resetLastSent();
      try { await disconnectByPath(devPath); } catch {}
      reconnectWithBackoff(devPath, devName);
      return;
    }
  } finally {
    writeInFlight = false;
  }
}

export function getConnectedCount(): number { return device ? 1 : 0; }
export function getConnectedNames(): string[] { return device ? [device.name] : []; }
export function getConnectedDeviceId(): string | null { return device?.id ?? null; }
export function getSavedDeviceId(): string | null { return savedDeviceId; }
export function getSavedDeviceName(): string | null { return savedDeviceName; }
export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

// ── Scanning via BlueZ D-Bus ──
let scanning = false;

/** Convert MAC address to BlueZ object path */
function macToPath(mac: string): string {
  return `${ADAPTER_PATH}/dev_${mac.replace(/:/g, '_')}`;
}

/** Convert BlueZ object path to MAC address (our canonical ID) */
function pathToMac(path: string): string {
  const suffix = path.replace(`${ADAPTER_PATH}/dev_`, '');
  return suffix.replace(/_/g, ':');
}

export async function scanForDevices(timeoutMs = 10000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    console.log('[BLE] Scan already in progress');
    return lastScanResults;
  }
  scanning = true;
  lastScanResults = [];
  discoveredPaths.clear();

  try {
    await refreshAdapterState();
    if (_adapterState !== 'poweredOn') {
      console.warn(`[BLE] Adapter not ready: ${_adapterState}`);
      return lastScanResults;
    }

    const obj = await getBus().getProxyObject(BLUEZ, ADAPTER_PATH);
    const adapter = obj.getInterface('org.bluez.Adapter1');

    // Set discovery filter for BLE only
    try {
      await adapter.SetDiscoveryFilter({
        Transport: new dbus.Variant('s', 'le'),
      });
    } catch {}

    await adapter.StartDiscovery();
    console.log('[BLE] D-Bus discovery started');

    // Wait for discovery period
    await new Promise(r => setTimeout(r, timeoutMs));

    try { await adapter.StopDiscovery(); } catch {}

    // Enumerate discovered devices via ObjectManager
    const objManager = await getBus().getProxyObject(BLUEZ, '/');
    const manager = objManager.getInterface('org.freedesktop.DBus.ObjectManager');
    const objects: Record<string, any> = await manager.GetManagedObjects();

    for (const [path, interfaces] of Object.entries(objects)) {
      if (!path.startsWith(ADAPTER_PATH + '/dev_')) continue;
      const dev1 = interfaces['org.bluez.Device1'];
      if (!dev1) continue;

      const name: string = dev1.Name?.value ?? dev1.Alias?.value ?? '';
      if (!name) continue; // skip unnamed

      const mac = pathToMac(path);
      if (discoveredPaths.has(mac)) continue;

      const rssi: number = dev1.RSSI?.value ?? -100;
      discoveredPaths.set(mac, path);
      const entry: DiscoveredDevice = { id: mac, name, rssi };
      lastScanResults.push(entry);
      console.log(`[BLE] Discovered: ${name} (${mac}) RSSI: ${rssi}`);
    }

    console.log(`[BLE] Scan complete — found ${lastScanResults.length} device(s)`);
    return lastScanResults;
  } catch (e: any) {
    console.error(`[BLE] Scan error: ${e.message}`);
    return lastScanResults;
  } finally {
    scanning = false;
  }
}

// ── Connect ──

export async function selectDevice(deviceId: string): Promise<boolean> {
  let path = discoveredPaths.get(deviceId);
  if (!path) {
    // Try constructing from MAC
    path = macToPath(deviceId);
  }

  if (device) {
    try { await disconnectByPath(device.objectPath); } catch {}
    device = null;
    resetLastSent();
  }

  try {
    await connectByPath(path, deviceId);
    savedDeviceId = deviceId;
    savedDeviceName = device?.name ?? deviceId;
    setItem('ble-device-id', deviceId);
    setItem('ble-device-name', savedDeviceName!);
    console.log(`[BLE] Saved device: ${savedDeviceName} (${deviceId})`);
    return true;
  } catch (e: any) {
    console.error(`[BLE] Failed to connect to ${deviceId}: ${e.message}`);
    return false;
  }
}

export async function forgetDevice(): Promise<void> {
  savedDeviceId = null;
  savedDeviceName = null;
  setItem('ble-device-id', '');
  setItem('ble-device-name', '');
  if (device) {
    try { await disconnectByPath(device.objectPath); } catch {}
    device = null;
    resetLastSent();
  }
  console.log('[BLE] Device forgotten');
}

export async function autoConnectSaved(timeoutMs = 15000): Promise<number> {
  if (!savedDeviceId) {
    console.log('[BLE] No saved device — waiting for user selection');
    return 0;
  }
  if (device) return 1;
  if (scanning) return 0;

  scanning = true;
  console.log(`[BLE] Looking for saved device: ${savedDeviceId}`);

  try {
    await refreshAdapterState();
    if (_adapterState !== 'poweredOn') {
      console.warn(`[BLE] Adapter not ready: ${_adapterState}`);
      return 0;
    }

    const path = macToPath(savedDeviceId);

    // Start a brief discovery so BlueZ refreshes its device cache
    try {
      const obj = await getBus().getProxyObject(BLUEZ, ADAPTER_PATH);
      const adapter = obj.getInterface('org.bluez.Adapter1');
      try { await adapter.SetDiscoveryFilter({ Transport: new dbus.Variant('s', 'le') }); } catch {}
      await adapter.StartDiscovery();

      // Wait up to timeoutMs for the device to appear, checking every 500ms
      const deadline = Date.now() + timeoutMs;
      let found = false;
      while (Date.now() < deadline) {
        try {
          const devObj = await getBus().getProxyObject(BLUEZ, path);
          const devProps = devObj.getInterface('org.freedesktop.DBus.Properties');
          const nameVariant: dbus.Variant = await devProps.Get('org.bluez.Device1', 'Name').catch(() => new dbus.Variant('s', ''));
          if (nameVariant.value) { found = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }

      try { await adapter.StopDiscovery(); } catch {}

      if (!found) {
        console.log('[BLE] Saved device not found within timeout');
        return 0;
      }
    } catch (e: any) {
      console.warn(`[BLE] Discovery for saved device failed: ${e.message}`);
      // Still try to connect — device might already be cached in BlueZ
    }

    try {
      await connectByPath(path, savedDeviceId);
      return 1;
    } catch (e: any) {
      console.error(`[BLE] Auto-connect failed: ${e.message}`);
      return 0;
    }
  } finally {
    scanning = false;
  }
}

export async function scanAndConnect(timeoutMs = 15000): Promise<number> {
  return autoConnectSaved(timeoutMs);
}

// ── Core connect/disconnect via BlueZ D-Bus ──

async function connectByPath(path: string, id: string, _retryCount = 0): Promise<void> {
  const MAX_RETRIES = 3;
  const STEP_TIMEOUT_MS = 8000;
  const connectTime = performance.now();

  const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS)
      ),
    ]);

  // Get device proxy
  const devObj = await getBus().getProxyObject(BLUEZ, path);
  const dev1 = devObj.getInterface('org.bluez.Device1');
  const devProps = devObj.getInterface('org.freedesktop.DBus.Properties');

  // Read name
  let name = id;
  try {
    const nameV: dbus.Variant = await devProps.Get('org.bluez.Device1', 'Name');
    if (nameV.value) name = nameV.value as string;
  } catch {}

  // Connect
  const connectedV: dbus.Variant = await devProps.Get('org.bluez.Device1', 'Connected');
  if (!connectedV.value) {
    await withTimeout(dev1.Connect(), 'BLE connect');
  }
  console.log(`[BLE] Connected to ${name}`);

  // Wait for services to be resolved
  let resolved = false;
  const srvDeadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < srvDeadline) {
    try {
      const r: dbus.Variant = await devProps.Get('org.bluez.Device1', 'ServicesResolved');
      if (r.value) { resolved = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  if (!resolved) {
    try { await dev1.Disconnect(); } catch {}
    if (_retryCount < MAX_RETRIES) {
      const delay = 500 * (_retryCount + 1);
      console.warn(`[BLE] Services not resolved on ${name} — retry ${_retryCount + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return connectByPath(path, id, _retryCount + 1);
    }
    throw new Error(`Services not resolved on ${name} after ${MAX_RETRIES} retries`);
  }

  // Find the GATT characteristic via ObjectManager
  const objManager = await getBus().getProxyObject(BLUEZ, '/');
  const manager = objManager.getInterface('org.freedesktop.DBus.ObjectManager');
  const objects: Record<string, any> = await manager.GetManagedObjects();

  let charPath: string | null = null;
  for (const [objPath, ifaces] of Object.entries(objects)) {
    if (!objPath.startsWith(path + '/')) continue;
    const charIface = ifaces['org.bluez.GattCharacteristic1'];
    if (!charIface) continue;
    const uuid: string = charIface.UUID?.value ?? '';
    if (uuid.toLowerCase() === CHAR_UUID) {
      charPath = objPath;
      break;
    }
  }

  if (!charPath) {
    try { await dev1.Disconnect(); } catch {}
    if (_retryCount < MAX_RETRIES) {
      const delay = 500 * (_retryCount + 1);
      console.warn(`[BLE] No characteristic ${CHAR_UUID} on ${name} — retry ${_retryCount + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return connectByPath(path, id, _retryCount + 1);
    }
    throw new Error(`No characteristic found on ${name} after ${MAX_RETRIES} retries`);
  }

  // Get characteristic proxy
  const charObj = await getBus().getProxyObject(BLUEZ, charPath);
  const charProxy = charObj.getInterface('org.bluez.GattCharacteristic1');

  // Set hardware brightness to max
  try {
    await charProxy.WriteValue(Array.from(brightMaxBuf), { type: new dbus.Variant('s', 'command') });
  } catch (e: any) {
    console.warn(`[BLE] Brightness init write failed: ${e.message}`);
  }

  device = { deviceProxy: dev1, charProxy, mode: 'rgb', name, id, objectPath: path };
  lastWriteTime = performance.now();
  startKeepAlive();

  // Backfill saved name
  if (savedDeviceId === id && (!savedDeviceName || savedDeviceName === id)) {
    savedDeviceName = name;
    setItem('ble-device-name', name);
    console.log(`[BLE] Backfilled saved name: ${name}`);
  }

  // Watch for disconnect via PropertiesChanged
  try {
    devProps.on('PropertiesChanged', (iface: string, changed: Record<string, dbus.Variant>) => {
      if (iface !== 'org.bluez.Device1') return;
      if ('Connected' in changed && !changed.Connected.value) {
        const uptime = Math.round((performance.now() - connectTime) / 1000);
        if (uptime < 10) {
          console.log(`[BLE] ${name} dropped after ${uptime}s`);
        } else {
          console.log(`[BLE] ${name} disconnected after ${uptime}s — sent=${bleStats.sentCount}, avgLat=${bleStats.writeLatAvgMs}ms`);
        }
        stopKeepAlive();
        device = null;
        resetLastSent();
        if (_demandConnect) {
          reconnectWithBackoff(path, name);
        }
      }
    });
  } catch {}

  console.log(`[BLE] ${name} ready (BlueZ D-Bus)`);
}

async function disconnectByPath(path: string): Promise<void> {
  try {
    const devObj = await getBus().getProxyObject(BLUEZ, path);
    const dev1 = devObj.getInterface('org.bluez.Device1');
    await dev1.Disconnect();
  } catch {}
}

async function reconnectWithBackoff(path: string, name: string, attempt = 0): Promise<void> {
  const maxDirectAttempts = 3;
  const baseDelay = 200;

  if (device || !_demandConnect) return;

  const id = pathToMac(path);

  if (attempt < maxDirectAttempts) {
    const delay = baseDelay * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
    if (device || !_demandConnect) return;

    try {
      await connectByPath(path, id);
      return;
    } catch (e: any) {
      if (attempt === maxDirectAttempts - 1) {
        console.warn(`[BLE] ${name} — direct reconnect exhausted`);
      }
      return reconnectWithBackoff(path, name, attempt + 1);
    }
  }

  // Phase 2: fresh scan
  const scanRetries = 3;
  for (let i = 0; i < scanRetries; i++) {
    if (device || !_demandConnect) return;
    try {
      await autoConnectSaved(10000);
      if (device) return;
    } catch {}
    if (i < scanRetries - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!device) {
    console.warn(`[BLE] ${name} — all reconnect attempts failed, background loop will retry`);
  }
}

/** Raw color write — bypasses dedup and brightness scaling. For test tools only. */
export async function sendRawColor(r: number, g: number, b: number): Promise<void> {
  if (!device) return;
  resetLastSent();
  writeBuf[4] = r; writeBuf[5] = g; writeBuf[6] = b;
  try {
    await writeCharValue(writeBuf, true);
  } catch { /* fire-and-forget */ }
}

export async function disconnect(): Promise<void> {
  stopKeepAlive();
  if (device) {
    try { await disconnectByPath(device.objectPath); } catch {}
    device = null;
    resetLastSent();
    console.log('[BLE] Disconnected');
  }
}

export const disconnectAll = disconnect;
export function setExpectedDeviceCount(_n: number): void { /* no-op */ }

// ── Demand-based connection management ──
let _demandConnect = false;

export async function requestConnect(): Promise<void> {
  if (_demandConnect && device) return;
  _demandConnect = true;
  if (!device && savedDeviceId) {
    console.log('[BLE] Demand ON — connecting...');
    await autoConnectSaved(10000);
  }
}

export function releaseDemand(): void {
  if (!_demandConnect) return;
  _demandConnect = false;
  console.log('[BLE] Demand OFF — will not reconnect on next disconnect');
}

export function isDemandActive(): boolean {
  return _demandConnect;
}

export function startReconnectLoop(intervalMs = 15000): NodeJS.Timeout {
  return setInterval(async () => {
    if (!device && savedDeviceId && _demandConnect) {
      await autoConnectSaved(10000);
    }
  }, intervalMs);
}
