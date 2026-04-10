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

// ── Saved device ID (persisted) ──
let savedDeviceId: string | null = getItem('ble-device-id') ?? null;

// Pre-allocated write buffer (single, reused every tick — zero alloc)
const writeBuf = Buffer.from([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const brightBuf = Buffer.from([0x7e, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]);
const brightMaxBuf = Buffer.from([0x7e, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0xef]);

// Dimming gamma
let dimmingGamma = 1.8;
export function setDimmingGamma(v: number) { dimmingGamma = Math.max(1.0, Math.min(3.0, v)); }
export function getDimmingGamma(): number { return dimmingGamma; }


function getAdapterState(): string | undefined {
  const nobleWithState = noble as typeof noble & { state?: string; _state?: string };
  return nobleWithState.state ?? nobleWithState._state;
}

function brightnessToScale(brightness: number): number {
  const norm = Math.max(0, Math.min(100, brightness)) / 100;
  return norm <= 0 ? 0 : Math.pow(norm, dimmingGamma);
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
const KEEPALIVE_MS = 2000;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (!device) return;
    const elapsed = performance.now() - lastWriteTime;
    if (lastWriteTime > 0 && elapsed < KEEPALIVE_MS) return; // recent write, skip
    // Re-send last known color to keep connection alive
    const buf = device.mode === 'brightness' ? brightBuf : writeBuf;
    device.characteristic.writeAsync(buf, true).catch(() => {});
    lastWriteTime = performance.now();
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
  const cr = Math.round(r * scale);
  const cg = Math.round(g * scale);
  const cb = Math.round(b * scale);
  const cbr = Math.round(scale * 0xff);

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
    setItem('ble-device-id', deviceId);
    console.log(`[BLE] Saved device: ${deviceId}`);
    return true;
  } catch (e: any) {
    console.error(`[BLE] Failed to connect to ${deviceId}: ${e.message}`);
    return false;
  }
}

/** Forget saved device and disconnect */
export async function forgetDevice(): Promise<void> {
  savedDeviceId = null;
  setItem('ble-device-id', '');
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

  await peripheral.connectAsync();
  console.log(`[BLE] Connected to ${name}`);

  const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
    [SERVICE_UUID], [CHAR_UUID]
  );

  if (!characteristics?.length) {
    throw new Error(`No characteristic found on ${name}`);
  }

  const char = characteristics[0] as PiCharacteristic;
  char.deviceName = name;
  char.deviceId = peripheral.id;

  // Set hardware brightness to max
  await char.writeAsync(brightMaxBuf, true);

  device = { peripheral, characteristic: char, mode: 'rgb', name, id: peripheral.id };
  lastWriteTime = performance.now(); // count the brightMax write
  startKeepAlive();

  // Auto-reconnect on disconnect
  peripheral.once('disconnect', (reason: any) => {
    const uptime = Math.round((performance.now() - connectTime) / 1000);
    console.log(`[BLE] ${name} disconnected after ${uptime}s — reason: ${reason ?? 'unknown'}`);
    console.log(`[BLE] Stats at disconnect: sent=${bleStats.sentCount}, skipBusy=${bleStats.skipBusyCount}, skipDelta=${bleStats.skipDeltaCount}, avgLat=${bleStats.writeLatAvgMs}ms`);
    stopKeepAlive();
    device = null;
    resetLastSent();
    reconnectWithBackoff(peripheral, name);
  });

  console.log(`[BLE] ${name} ready (hw brightness max, single-device mode)`);
}

/** Reconnect with exponential backoff, then fall back to fresh scan */
async function reconnectWithBackoff(peripheral: any, name: string, attempt = 0): Promise<void> {
  const maxDirectAttempts = 3;
  const baseDelay = 1000;

  if (device) return;

  // Phase 1: Try direct reconnect to same peripheral (fast)
  if (attempt < maxDirectAttempts) {
    const delay = baseDelay * Math.pow(2, attempt);
    console.log(`[BLE] ${name} — direct reconnect ${attempt + 1}/${maxDirectAttempts} in ${delay}ms`);
    await new Promise(r => setTimeout(r, delay));
    if (device) return;

    try {
      await connectPeripheral(peripheral);
      console.log(`[BLE] ${name} — reconnected successfully (direct)`);
      return;
    } catch (e: any) {
      console.error(`[BLE] ${name} — direct reconnect ${attempt + 1} failed: ${e.message}`);
      return reconnectWithBackoff(peripheral, name, attempt + 1);
    }
  }

  // Phase 2: Direct attempts exhausted — do a fresh BLE scan
  console.log(`[BLE] ${name} — direct reconnect exhausted, trying fresh scan...`);
  try {
    const found = await autoConnectSaved(15000);
    if (found > 0) {
      console.log(`[BLE] ${name} — reconnected via fresh scan`);
    } else {
      console.log(`[BLE] ${name} — fresh scan found nothing, will retry on next loop`);
    }
  } catch (e: any) {
    console.error(`[BLE] ${name} — fresh scan failed: ${e.message}`);
  }
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
    console.log('[BLE] Device disconnected');
  }
}

// Legacy aliases for compatibility
export const disconnectAll = disconnect;
export function setExpectedDeviceCount(_n: number): void { /* no-op in single-device mode */ }

/** Background reconnect loop — tries to connect to saved device when disconnected */
export function startReconnectLoop(intervalMs = 15000): NodeJS.Timeout {
  return setInterval(async () => {
    if (!device && savedDeviceId) {
      console.log('[BLE] No device connected, scanning for saved device...');
      await autoConnectSaved(10000);
    }
  }, intervalMs);
}
