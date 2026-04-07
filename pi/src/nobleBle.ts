/**
 * Noble-based BLE driver for a SINGLE BLEDOM LED strip on Raspberry Pi.
 * Optimized for minimum latency: no Map, no Promise.allSettled, direct write.
 * 
 * Single-device architecture — run multiple instances for multiple lights.
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

// ── Single device state ──
let device: {
  peripheral: any;
  characteristic: PiCharacteristic;
  mode: DeviceMode;
  name: string;
} | null = null;

// Pre-allocated write buffer (single, reused every tick — zero alloc)
const writeBuf = Buffer.from([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const brightBuf = Buffer.from([0x7e, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]);
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

/** Ultra-fast single-device BLE write — no Map, no array, no Promise.allSettled */
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
  lastR = cr; lastG = cg; lastB = cb; lastBr = cbr;

  // Write directly into pre-allocated buffer
  let buf: Buffer;
  if (device.mode === 'brightness') {
    brightBuf[3] = cbr;
    buf = brightBuf;
  } else {
    writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
    buf = writeBuf;
  }

  writeInFlight = true;
  const t0 = performance.now();
  try {
    await device.characteristic.writeAsync(buf, true);

    const now = performance.now();
    const lat = now - t0;
    bleStats.writeLatMs = Math.round(lat * 10) / 10;
    bleStats.writeLatAvgMs = Math.round((lat * 0.2 + bleStats.writeLatAvgMs * 0.8) * 10) / 10;
    if (lastWriteTime > 0) {
      bleStats.effectiveIntervalMs = Math.round(now - lastWriteTime);
    }
    lastWriteTime = now;
    bleStats.sentCount++;
  } catch {
    // Fire-and-forget — don't block pipeline
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

/**
 * Scan for and connect to the FIRST BLEDOM device found.
 * Single-device model — stops scanning after first match.
 */
let scanning = false;

export async function scanAndConnect(timeoutMs = 15000): Promise<number> {
  if (scanning) {
    console.log('[BLE] Scan already in progress, skipping');
    return 0;
  }
  if (device) {
    console.log('[BLE] Already connected, skipping scan');
    return 0;
  }
  scanning = true;

  try {
    return await new Promise((resolve) => {
      let found: any = null;

      const onDiscover = (peripheral: any) => {
        if (found) return; // only take the first
        const name = peripheral.advertisement?.localName ?? '';
        if (/^(ELK-BLEDOM|BLEDOM|ELK|MELK)/i.test(name)) {
          console.log(`[BLE] Found: ${name} (${peripheral.id})`);
          found = peripheral;
          // Stop scanning immediately — we only need one
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
          console.error(`[BLE] Connect failed: ${e.message}`);
          resolve(0);
        }
      };

      noble.on('discover', onDiscover);

      const timer = setTimeout(() => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync().catch(() => {});
        if (!found) {
          console.log('[BLE] Scan timeout — no device found');
          resolve(0);
        }
      }, timeoutMs);

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

  device = { peripheral, characteristic: char, mode: 'rgb', name };

  // Auto-reconnect on disconnect
  peripheral.once('disconnect', () => {
    console.log(`[BLE] ${name} disconnected — attempting reconnect`);
    device = null;
    resetLastSent();
    reconnectWithBackoff(peripheral, name);
  });

  console.log(`[BLE] ${name} ready (hw brightness max, single-device mode)`);
}

/** Reconnect with exponential backoff */
async function reconnectWithBackoff(peripheral: any, name: string, attempt = 0): Promise<void> {
  const maxAttempts = 5;
  const baseDelay = 2000;

  if (attempt >= maxAttempts) {
    console.log(`[BLE] ${name} — gave up after ${maxAttempts} attempts, will retry on next scan cycle`);
    return;
  }

  if (device) return; // already reconnected

  const delay = baseDelay * Math.pow(2, attempt);
  console.log(`[BLE] ${name} — reconnect attempt ${attempt + 1}/${maxAttempts} in ${delay}ms`);

  await new Promise(r => setTimeout(r, delay));

  if (device) return;

  try {
    await connectPeripheral(peripheral);
    console.log(`[BLE] ${name} — reconnected successfully`);
  } catch (e: any) {
    console.error(`[BLE] ${name} — reconnect attempt ${attempt + 1} failed: ${e.message}`);
    reconnectWithBackoff(peripheral, name, attempt + 1);
  }
}

/** Disconnect and clean up */
export async function disconnect(): Promise<void> {
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

/** Background reconnect loop — scans when disconnected */
export function startReconnectLoop(intervalMs = 30000): NodeJS.Timeout {
  return setInterval(async () => {
    if (!device) {
      console.log('[BLE] No device connected, scanning...');
      await scanAndConnect(10000);
    }
  }, intervalMs);
}
