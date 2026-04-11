/**
 * Noble-based BLE driver for a SINGLE BLEDOM LED strip on Raspberry Pi.
 * Supports scan → list → user-select → auto-reconnect flow.
 * Persists chosen device ID for automatic reconnection on restart.
 */

// @ts-ignore — noble types are approximate
import noble from '@abandonware/noble';
import { getItem, setItem } from './storage.js';

const SERVICE_UUID = 'fff0';
const CHAR_UUID = 'fff3';

export type DeviceMode = 'rgb' | 'brightness';

export interface PiCharacteristic {
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  _peripheral?: any;
  deviceName?: string;
  deviceId?: string;
}

/** A discovered but not-yet-connected device */
export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi: number;
}

// ── Single device state ──
let device: {
  peripheral: any;
  characteristic: PiCharacteristic;
  mode: DeviceMode;
  name: string;
  id: string;
} | null = null;

// ── Discovered devices from last scan ──
let lastScanResults: DiscoveredDevice[] = [];
let discoveredPeripherals = new Map<string, any>();

// ── Saved device ID + name (persisted) ──
let savedDeviceId: string | null = getItem('ble-device-id') ?? null;
let savedDeviceName: string | null = getItem('ble-device-name') ?? null;

// Pre-allocated write buffer (single, reused every tick — zero alloc)
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

// Pre-computed brightness LUT (101 entries for 0–100%) — eliminates Math.pow per tick
const brightnessLut = new Float64Array(101);
function rebuildBrightnessLut(): void {
  for (let i = 0; i <= 100; i++) {
    const norm = i / 100;
    brightnessLut[i] = norm <= 0 ? 0 : Math.pow(norm, dimmingGamma);
  }
}
rebuildBrightnessLut();

function getAdapterState(): string | undefined {
  const nobleWithState = noble as typeof noble & { state?: string; _state?: string };
  return nobleWithState.state ?? nobleWithState._state;
}

function brightnessToScale(brightness: number): number {
  const idx = brightness < 0 ? 0 : brightness > 100 ? 100 : (brightness + 0.5) | 0;
  return brightnessLut[idx];
}

// Dedup + non-reentrant guard
let lastR = -1, lastG = -1, lastB = -1, lastBr = -1;
let writeInFlight = false;
let lastWriteTime = 0;

// Stats
export const bleStats = {
  sentCount: 0,
  skipDeltaCount: 0,
  skipBusyCount: 0,
  
  writeLatMs: 0,
  writeLatAvgMs: 0,
  effectiveIntervalMs: 0,
};

// Keep-alive interval (prevents BLE supervision timeout when idle)
const KEEPALIVE_MS = 1000;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveFailCount = 0;

function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveFailCount = 0;
  keepAliveTimer = setInterval(async () => {
    if (!device) return;
    const elapsed = performance.now() - lastWriteTime;
    if (lastWriteTime > 0 && elapsed < KEEPALIVE_MS * 0.8) return; // recent write, skip
    // Re-send last known color to keep connection alive
    const buf = device.mode === 'brightness' ? brightBuf : writeBuf;
    try {
      await device.characteristic.writeAsync(buf, true);
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

/** Ultra-fast single-device BLE write */
export async function sendToBLE(r: number, g: number, b: number, brightness: number): Promise<void> {
  if (!device) return;

  const scale = brightnessToScale(brightness);
  const cr = (r * scale + 0.5) | 0;
  const cg = (g * scale + 0.5) | 0;
  const cb = (b * scale + 0.5) | 0;
  const cbr = (scale * 0xff + 0.5) | 0;

  if (writeInFlight) { bleStats.skipBusyCount++; return; }
  if (cr === lastR && cg === lastG && cb === lastB && cbr === lastBr) {
    bleStats.skipDeltaCount++;
    return;
  }

  writeInFlight = true;
  const now = performance.now();

  try {
    if (device.mode === 'brightness') {
      brightBuf[3] = cbr;
      await device.characteristic.writeAsync(brightBuf, true);
    } else {
      writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
      await device.characteristic.writeAsync(writeBuf, true);
    }

    lastR = cr; lastG = cg; lastB = cb; lastBr = cbr;
    bleStats.sentCount++;

    const elapsed = performance.now() - now;
    bleStats.writeLatMs = Math.round(elapsed * 10) / 10;
    bleStats.writeLatAvgMs = Math.round(
      (bleStats.writeLatAvgMs * 0.9 + elapsed * 0.1) * 10
    ) / 10;

    if (lastWriteTime > 0) {
      bleStats.effectiveIntervalMs = Math.round(now - lastWriteTime);
    }
    lastWriteTime = now;
  } catch {
    // fire-and-forget
  } finally {
    writeInFlight = false;
  }
}

export function getConnectedCount(): number {
  return device ? 1 : 0;
}

export function getConnectedNames(): string[] {
  return device ? [device.name] : [];
}

export function getConnectedDeviceId(): string | null {
  return device?.id ?? null;
}

export function getSavedDeviceId(): string | null {
  return savedDeviceId;
}

export function getSavedDeviceName(): string | null {
  return savedDeviceName;
}

export function getLastScanResults(): DiscoveredDevice[] {
  return lastScanResults;
}

export function isScanning(): boolean {
  return scanning;
}

/**
 * Scan for all BLEDOM devices and return the list.
 * Does NOT auto-connect — user picks from the list.
 */
let scanning = false;

export async function scanForDevices(timeoutMs = 10000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    console.log('[BLE] Scan already in progress');
    return lastScanResults;
  }
  scanning = true;
  lastScanResults = [];
  discoveredPeripherals.clear();

  try {
    return await new Promise((resolve) => {
      const onDiscover = (peripheral: any) => {
        const name = peripheral.advertisement?.localName ?? '';
        console.log(`[BLE] Saw: "${name || '(no name)'}" id=${peripheral.id} rssi=${peripheral.rssi}`);
        if (!/^(ELK-BLEDOM|BLEDOM|ELK|MELK)/i.test(name)) return;
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
        console.log(`[BLE] Scan complete — found ${lastScanResults.length} device(s)`);
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

  // Disconnect current if any
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    device = null;
    resetLastSent();
  }

  try {
    await connectPeripheral(peripheral);
    savedDeviceId = deviceId;
    savedDeviceName = peripheral.advertisement?.localName ?? deviceId;
    setItem('ble-device-id', deviceId);
    setItem('ble-device-name', savedDeviceName);
    console.log(`[BLE] Saved device: ${savedDeviceName} (${deviceId})`);
    return true;
  } catch (e: any) {
    console.error(`[BLE] Failed to connect to ${deviceId}: ${e.message}`);
    return false;
  }
}

/** Forget saved device and disconnect */
export async function forgetDevice(): Promise<void> {
  savedDeviceId = null;
  savedDeviceName = null;
  setItem('ble-device-id', '');
  setItem('ble-device-name', '');
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    device = null;
    resetLastSent();
  }
  console.log('[BLE] Device forgotten');
}

/**
 * Auto-connect to saved device if available.
 * Scans and connects only to the previously selected device.
 */
export async function autoConnectSaved(timeoutMs = 15000): Promise<number> {
  if (!savedDeviceId) {
    console.log('[BLE] No saved device — waiting for user selection');
    return 0;
  }
  if (device) return 1;
  if (scanning) return 0;

  scanning = true;
  console.log(`[BLE] Scanning for saved device: ${savedDeviceId}`);

  try {
    return await new Promise((resolve) => {
      let found: any = null;

      const onDiscover = (peripheral: any) => {
        if (found) return;
        if (peripheral.id === savedDeviceId) {
          const name = peripheral.advertisement?.localName ?? peripheral.id;
          console.log(`[BLE] Found saved device: ${name}`);
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
          console.error(`[BLE] Auto-connect failed: ${e.message}`);
          resolve(0);
        }
      };

      noble.on('discover', onDiscover);

      const timer = setTimeout(() => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        if (!found) {
          console.log('[BLE] Saved device not found within timeout');
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

// Legacy scanAndConnect — now delegates to autoConnectSaved
export async function scanAndConnect(timeoutMs = 15000): Promise<number> {
  return autoConnectSaved(timeoutMs);
}

async function connectPeripheral(peripheral: any): Promise<void> {
  const name = peripheral.advertisement?.localName ?? peripheral.id;
  const connectTime = performance.now();
  const STEP_TIMEOUT_MS = 8000;

  const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS)
      ),
    ]);

  await withTimeout(peripheral.connectAsync(), 'BLE connect');
  console.log(`[BLE] Connected to ${name}`);

  // Two-step discovery (more reliable than discoverSomeServicesAndCharacteristics — see noble#545)
  let characteristics: any[] = [];
  try {
    const services: any[] = await withTimeout(
      peripheral.discoverServicesAsync([SERVICE_UUID]),
      'Service discovery'
    );
    if (services?.length) {
      characteristics = await withTimeout(
        services[0].discoverCharacteristicsAsync([CHAR_UUID]),
        'Characteristic discovery'
      );
    }
  } catch (e: any) {
    // Fallback: try combined discovery
    console.warn(`[BLE] Two-step discovery failed (${e.message}), trying combined...`);
    const result = await withTimeout(
      peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [CHAR_UUID]),
      'Combined GATT discovery'
    );
    characteristics = (result as any).characteristics ?? [];
  }

  if (!characteristics?.length) {
    throw new Error(`No characteristic found on ${name}`);
  }

  const char = characteristics[0] as PiCharacteristic;
  char.deviceName = name;
  char.deviceId = peripheral.id;

  // Set hardware brightness to max
  await withTimeout(char.writeAsync(brightMaxBuf, true), 'Brightness write');

  // Request minimum connection interval (7.5ms = 6 units of 1.25ms)
  // This reduces BLE latency from ~30ms default to ~10ms per write.
  // BLEDOM controllers are always powered, so higher power draw is irrelevant.
  try {
    const hci = (noble as any)._bindings?._hci;
    const handle = peripheral._handle ?? peripheral.handle;
    if (hci && handle != null && typeof hci.writeLeConnectionUpdate === 'function') {
      // params: handle, minInterval, maxInterval, latency, supervisionTimeout (in 1.25ms/10ms units)
      // 6 = 7.5ms, 8 = 10ms, 0 = no slave latency, 200 = 2000ms supervision timeout
      hci.writeLeConnectionUpdate(handle, 6, 8, 0, 200);
      console.log(`[BLE] Requested connection interval 7.5–10ms for ${name}`);
    } else {
      console.log(`[BLE] Connection interval update not available (HCI access limited)`);
    }
  } catch (e: any) {
    console.warn(`[BLE] Failed to set connection interval: ${e.message}`);
  }

  device = { peripheral, characteristic: char, mode: 'rgb', name, id: peripheral.id };
  lastWriteTime = performance.now();
  startKeepAlive();

  // Auto-reconnect on disconnect (only if demand is active)
  peripheral.once('disconnect', (reason: any) => {
    const uptime = Math.round((performance.now() - connectTime) / 1000);
    // Quiet log: single line, no stats dump for short-lived connections
    if (uptime < 10) {
      console.log(`[BLE] ${name} dropped after ${uptime}s (reason ${reason ?? '?'})`);
    } else {
      console.log(`[BLE] ${name} disconnected after ${uptime}s — reason: ${reason ?? 'unknown'}, sent=${bleStats.sentCount}, avgLat=${bleStats.writeLatAvgMs}ms`);
    }
    stopKeepAlive();
    device = null;
    resetLastSent();
    if (_demandConnect) {
      reconnectWithBackoff(peripheral, name);
    }
  });

  console.log(`[BLE] ${name} ready`);
}

/** Reconnect with exponential backoff, then fall back to fresh scan */
async function reconnectWithBackoff(peripheral: any, name: string, attempt = 0): Promise<void> {
  const maxDirectAttempts = 3;
  const baseDelay = 300; // fast first retry

  if (device || !_demandConnect) return;

  if (attempt < maxDirectAttempts) {
    const delay = baseDelay * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
    if (device || !_demandConnect) return;

    try {
      await connectPeripheral(peripheral);
      return;
    } catch (e: any) {
      if (attempt === maxDirectAttempts - 1) {
        console.warn(`[BLE] ${name} — direct reconnect exhausted`);
      }
      return reconnectWithBackoff(peripheral, name, attempt + 1);
    }
  }

  // Phase 2: fresh scan
  if (!_demandConnect) return;
  try {
    await autoConnectSaved(10000);
  } catch {}
}

/** Raw color write — bypasses dedup and brightness scaling. For test tools only. */
export async function sendRawColor(r: number, g: number, b: number): Promise<void> {
  if (!device) return;
  resetLastSent();
  writeBuf[4] = r; writeBuf[5] = g; writeBuf[6] = b;
  try {
    await device.characteristic.writeAsync(writeBuf, true);
  } catch { /* fire-and-forget */ }
}

/** Disconnect and clean up */
export async function disconnect(): Promise<void> {
  stopKeepAlive();
  if (device) {
    try { await device.peripheral.disconnectAsync(); } catch {}
    device = null;
    resetLastSent();
    console.log('[BLE] Disconnected');
  }
}

// Legacy aliases for compatibility
export const disconnectAll = disconnect;
export function setExpectedDeviceCount(_n: number): void { /* no-op in single-device mode */ }

// ── Demand-based connection management ──
// When demand is true, we actively maintain a connection.
// When false, we let disconnects happen without reconnecting.
let _demandConnect = false;

/** Signal that BLE is needed (e.g. music started playing).
 *  Triggers connect if not already connected. */
export async function requestConnect(): Promise<void> {
  if (_demandConnect && device) return; // already connected + demanded
  _demandConnect = true;
  if (!device && savedDeviceId) {
    console.log('[BLE] Demand ON — connecting...');
    await autoConnectSaved(10000);
  }
}

/** Signal that BLE is no longer needed (e.g. music stopped).
 *  Keeps current connection but stops reconnecting on disconnect. */
export function releaseDemand(): void {
  if (!_demandConnect) return;
  _demandConnect = false;
  console.log('[BLE] Demand OFF — will not reconnect on next disconnect');
}

export function isDemandActive(): boolean {
  return _demandConnect;
}

/** Background reconnect loop — only reconnects when demand is active */
export function startReconnectLoop(intervalMs = 15000): NodeJS.Timeout {
  return setInterval(async () => {
    if (!device && savedDeviceId && _demandConnect) {
      await autoConnectSaved(10000);
    }
  }, intervalMs);
}
