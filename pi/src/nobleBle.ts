/**
 * Noble-based BLE driver for BLEDOM LED strips on Raspberry Pi.
 * Replaces Web Bluetooth API.
 */

// @ts-ignore — noble types are approximate
import noble from '@abandonware/noble';

const SERVICE_UUID = 'fff0';
const CHAR_UUID = 'fff3';

export type DeviceMode = 'rgb' | 'brightness';

export interface PiCharacteristic {
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  _peripheral?: any;
  deviceName?: string;
  deviceId?: string;
}

interface ConnectedDevice {
  peripheral: any;
  characteristic: PiCharacteristic;
  mode: DeviceMode;
  name: string;
  // Pre-allocated write buffers per device (zero-alloc hot path)
  colorBuf: Buffer;
  brightBuf: Buffer;
}

const connectedDevices = new Map<string, ConnectedDevice>();

// Pre-allocated buffers (same protocol as browser)
const colorBuf = Buffer.from([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const brightOnlyBuf = Buffer.from([0x7e, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]);
const brightMaxBuf = Buffer.from([0x7e, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0xef]);

// Dimming gamma
let dimmingGamma = 1.8;
export function setDimmingGamma(v: number) { dimmingGamma = Math.max(1.0, Math.min(3.0, v)); }
export function getDimmingGamma(): number { return dimmingGamma; }

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

export function resetLastSent(): void {
  lastR = lastG = lastB = lastBr = -1;
  writeInFlight = false;
  lastWriteTime = 0;
}

export async function sendToBLE(r: number, g: number, b: number, brightness: number): Promise<void> {
  if (connectedDevices.size === 0) return;

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
  lastR = cr; lastG = cg; lastB = cb; lastBr = cbr;

  colorBuf[4] = cr;
  colorBuf[5] = cg;
  colorBuf[6] = cb;
  brightOnlyBuf[3] = cbr;

  writeInFlight = true;
  const t0 = performance.now();
  try {
    const promises: Promise<void>[] = [];
    for (const [, dev] of connectedDevices) {
      // Write directly into pre-allocated per-device buffers (zero-alloc)
      const buf = dev.mode === 'brightness' ? dev.brightBuf : dev.colorBuf;
      if (dev.mode !== 'brightness') {
        buf[4] = cr; buf[5] = cg; buf[6] = cb;
      } else {
        buf[3] = cbr;
      }
      promises.push(dev.characteristic.writeAsync(buf, true).catch(() => {}));
    }
    await Promise.allSettled(promises);

    const now = performance.now();
    const lat = now - t0;
    bleStats.writeLatMs = Math.round(lat * 10) / 10;
    bleStats.writeLatAvgMs = Math.round((lat * 0.2 + bleStats.writeLatAvgMs * 0.8) * 10) / 10;
    if (lastWriteTime > 0) {
      bleStats.effectiveIntervalMs = Math.round(now - lastWriteTime);
    }
    lastWriteTime = now;
    bleStats.sentCount++;
  } finally {
    writeInFlight = false;
  }
}

export function getConnectedCount(): number {
  return connectedDevices.size;
}

export function getConnectedNames(): string[] {
  return Array.from(connectedDevices.values()).map(d => d.name);
}

/**
 * Scan for and connect to BLEDOM devices.
 * Connects to all found devices matching name pattern.
 */
let scanning = false;

export async function scanAndConnect(timeoutMs = 15000): Promise<number> {
  if (scanning) {
    console.log('[BLE] Scan already in progress, skipping');
    return 0;
  }
  scanning = true;

  try {
    return await new Promise((resolve) => {
      const found: any[] = [];

      const onDiscover = (peripheral: any) => {
        const name = peripheral.advertisement?.localName ?? '';
        // Skip already-connected devices
        if (connectedDevices.has(peripheral.id)) return;
        if (/^(ELK-BLEDOM|BLEDOM|ELK|MELK)/i.test(name)) {
          console.log(`[BLE] Found: ${name} (${peripheral.id})`);
          found.push(peripheral);
        }
      };

      noble.on('discover', onDiscover);

      const finish = async () => {
        noble.removeListener('discover', onDiscover);
        try { await noble.stopScanningAsync(); } catch {}

        let connected = 0;
        for (const p of found) {
          // Double-check not connected during scan
          if (connectedDevices.has(p.id)) continue;
          try {
            await connectPeripheral(p);
            connected++;
          } catch (e: any) {
            console.error(`[BLE] Connect failed for ${p.advertisement?.localName}: ${e.message}`);
          }
        }
        resolve(connected);
      };

      setTimeout(finish, timeoutMs);

      if (noble.state === 'poweredOn') {
        noble.startScanningAsync([SERVICE_UUID], false).catch(() => {});
      } else {
        noble.once('stateChange', (state: string) => {
          if (state === 'poweredOn') {
            noble.startScanningAsync([SERVICE_UUID], false).catch(() => {});
          }
        });
      }
    });
  } finally {
    scanning = false;
  }
}

async function connectPeripheral(peripheral: any): Promise<void> {
  const name = peripheral.advertisement?.localName ?? peripheral.id;

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

  connectedDevices.set(peripheral.id, {
    peripheral,
    characteristic: char,
    mode: 'rgb',
    name,
    // Pre-allocate per-device buffers (cloned from templates)
    colorBuf: Buffer.from(colorBuf),
    brightBuf: Buffer.from(brightOnlyBuf),
  });

  // Auto-reconnect on disconnect — immediate retry with backoff
  peripheral.once('disconnect', () => {
    console.log(`[BLE] ${name} disconnected — attempting immediate reconnect`);
    connectedDevices.delete(peripheral.id);
    reconnectWithBackoff(peripheral, name);
  });

  console.log(`[BLE] ${name} ready (hw brightness max)`);
}


/** Reconnect a specific peripheral with exponential backoff */
async function reconnectWithBackoff(peripheral: any, name: string, attempt = 0): Promise<void> {
  const maxAttempts = 5;
  const baseDelay = 2000; // 2s, 4s, 8s, 16s, 32s

  if (attempt >= maxAttempts) {
    console.log(`[BLE] ${name} — gave up after ${maxAttempts} attempts, will retry on next scan cycle`);
    return;
  }

  // Skip if already reconnected (e.g. by scan loop)
  if (connectedDevices.has(peripheral.id)) return;

  const delay = baseDelay * Math.pow(2, attempt);
  console.log(`[BLE] ${name} — reconnect attempt ${attempt + 1}/${maxAttempts} in ${delay}ms`);

  await new Promise(r => setTimeout(r, delay));

  // Check again after waiting
  if (connectedDevices.has(peripheral.id)) return;

  try {
    await connectPeripheral(peripheral);
    console.log(`[BLE] ${name} — reconnected successfully`);
    if (connectedDevices.size > expectedDeviceCount) {
      expectedDeviceCount = connectedDevices.size;
    }
  } catch (e: any) {
    console.error(`[BLE] ${name} — reconnect attempt ${attempt + 1} failed: ${e.message}`);
    reconnectWithBackoff(peripheral, name, attempt + 1);
  }
}

/**
 * Disconnect all and clean up.
 */
export async function disconnectAll(): Promise<void> {
  for (const [id, dev] of connectedDevices) {
    try {
      await dev.peripheral.disconnectAsync();
    } catch {}
    connectedDevices.delete(id);
  }
  console.log('[BLE] All devices disconnected');
}

/**
 * Background reconnect loop — scans periodically for lost devices.
 * Also rescans when some devices have disconnected (partial loss).
 */
let expectedDeviceCount = 0;

export function setExpectedDeviceCount(n: number): void {
  expectedDeviceCount = n;
}

export function startReconnectLoop(intervalMs = 30000): NodeJS.Timeout {
  return setInterval(async () => {
    const current = connectedDevices.size;
    const shouldScan = current === 0 || (expectedDeviceCount > 0 && current < expectedDeviceCount);
    if (shouldScan) {
      console.log(`[BLE] ${current}/${expectedDeviceCount || '?'} devices connected, scanning...`);
      const n = await scanAndConnect(10000);
      if (n > 0) {
        console.log(`[BLE] Reconnected ${n} device(s) (total: ${connectedDevices.size})`);
        // Update expected count if we found more than before
        if (connectedDevices.size > expectedDeviceCount) {
          expectedDeviceCount = connectedDevices.size;
        }
      }
    }
  }, intervalMs);
}
