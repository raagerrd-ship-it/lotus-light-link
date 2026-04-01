// BLEDOM BLE LED strip protocol
import { debugData } from '@/lib/ui/debugStore';

const SERVICE_UUID = 0xfff0;
const CHAR_UUID = 0xfff3;
const STORAGE_KEY = 'bledom-last-device';

type LastDevice = { id: string; name: string };

export type DeviceMode = 'rgb' | 'brightness';

export interface BLEConnection {
  device: any;
  characteristic: any;
  mode: DeviceMode;
}

const DEVICE_MODE_KEY = 'bledom-device-modes';

function loadDeviceModes(): Record<string, DeviceMode> {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_MODE_KEY) || '{}');
  } catch { return {}; }
}

function saveDeviceMode(deviceId: string, mode: DeviceMode) {
  const modes = loadDeviceModes();
  modes[deviceId] = mode;
  localStorage.setItem(DEVICE_MODE_KEY, JSON.stringify(modes));
}

export function getSavedDeviceMode(deviceId: string): DeviceMode {
  return loadDeviceModes()[deviceId] || 'rgb';
}

export function setDeviceMode(deviceId: string, mode: DeviceMode) {
  saveDeviceMode(deviceId, mode);
}

export function saveLastDevice(device: any) {
  if (device?.id) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ id: device.id, name: device.name || 'Senast ansluten' })
    );
  }
}

export function getLastDevice(): LastDevice | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed?.id) return null;
    return { id: parsed.id, name: parsed.name || 'Senast ansluten' };
  } catch {
    return null;
  }
}

async function connectToDevice(device: any): Promise<BLEConnection> {
  if (!device?.gatt) throw new Error('Device saknar GATT');
  const server = device.gatt.connected
    ? device.gatt
    : await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const characteristic = await service.getCharacteristic(CHAR_UUID);
  saveLastDevice(device);
  resetLastSent();
  return { device, characteristic, mode: getSavedDeviceMode(device?.id) };
}

async function connectAfterAdvertisement(device: any, timeoutMs = 20000): Promise<BLEConnection | null> {
  if (!device?.watchAdvertisements) return null;

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;

    const settle = (result: BLEConnection | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      device.removeEventListener('advertisementreceived', onAdvert);
      resolve(result);
    };

    const onAdvert = async () => {
      try {
        settle(await connectToDevice(device));
      } catch {
        settle(null);
      }
    };

    timeout = setTimeout(() => settle(null), timeoutMs);
    device.addEventListener('advertisementreceived', onAdvert);
    device.watchAdvertisements({ signal: AbortSignal.timeout(timeoutMs) }).catch(() => settle(null));
  });
}

// Auto-reconnect status for UI feedback
export interface BleReconnectStatus {
  attempt: number;
  maxAttempts: number;
  phase: 'getDevices' | 'directGatt' | 'advScan' | 'waiting' | 'done' | 'failed';
  targetName?: string;
  error?: string;
}

export async function autoReconnect(signal?: AbortSignal, onStatus?: (s: BleReconnectStatus) => void): Promise<BLEConnection | null> {
  const nav = navigator as any;
  if (!nav.bluetooth?.getDevices) return null;

  const MAX_ATTEMPTS = 100;
  const RETRY_DELAY = 1000;

  const report = (s: BleReconnectStatus) => { onStatus?.(s); };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) { console.log('[BLE] auto-reconnect aborted'); return null; }

    try {
      report({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, phase: 'getDevices' });
      const devices = await nav.bluetooth.getDevices();
      console.log(`[BLE] attempt ${attempt + 1}, paired devices: ${devices.length}`, devices.map((d: any) => d.name || d.id));
      if (!devices.length) {
        report({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, phase: 'failed', error: 'Inga ihopparade enheter' });
        return null;
      }

      const saved = getLastDevice();
      const namedMatch = devices.find(
        (d: any) => typeof d.name === 'string' && /^(ELK-BLEDOM|BLEDOM|ELK|MELK)/i.test(d.name)
      );
      const target = devices.find((d: any) => d.id === saved?.id) ?? namedMatch ?? devices[0];
      if (!target) return null;
      const targetName = target.name || target.id;

      try {
        report({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, phase: 'directGatt', targetName });
        console.log(`[BLE] trying direct GATT to ${targetName}...`);
        const conn = await connectToDevice(target);
        report({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, phase: 'done', targetName });
        return conn;
      } catch (e: any) {
        console.log(`[BLE] direct GATT failed: ${e.message}, trying advertisements...`);
        report({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, phase: 'advScan', targetName, error: e.message });
        const conn = await connectAfterAdvertisement(target, 20000);
        if (conn) {
          report({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, phase: 'done', targetName });
          return conn;
        }
        console.log('[BLE] advertisement scan timed out, retrying...');
      }
    } catch (e: any) {
      console.log(`[BLE] attempt ${attempt + 1} error: ${e.message}`);
      report({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, phase: 'failed', error: e.message });
    }

    report({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, phase: 'waiting' });
    if (signal?.aborted) return null;
    await new Promise((r) => setTimeout(r, RETRY_DELAY));
  }

  return null;
}

export async function connectBLEDOM(): Promise<BLEConnection> {
  const nav = navigator as any;

  const options: any = { acceptAllDevices: true, optionalServices: [SERVICE_UUID] };

  const device = await nav.bluetooth.requestDevice(options);
  return connectToDevice(device);
}

// Pre-allocated color buffer — single 9-byte packet per tick
const _colorBuf = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
// Hardware brightness = max (0xFF)
const _brightMaxBuf = new Uint8Array([0x7e, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0xef]);
const DIMMING_GAMMA_KEY = 'dimming-gamma';
const DEFAULT_DIMMING_GAMMA = 1.8;

let _dimmingGamma = DEFAULT_DIMMING_GAMMA;

// Load on init
try {
  const stored = localStorage.getItem(DIMMING_GAMMA_KEY);
  if (stored) _dimmingGamma = Math.max(1.0, Math.min(3.0, Number(stored)));
} catch {}

export function getDimmingGamma(): number { return _dimmingGamma; }
export function setDimmingGamma(v: number) {
  _dimmingGamma = Math.max(1.0, Math.min(3.0, v));
  localStorage.setItem(DIMMING_GAMMA_KEY, String(_dimmingGamma));
}
export { DEFAULT_DIMMING_GAMMA };

function brightnessToScale(brightness: number): number {
  const normalized = Math.max(0, Math.min(100, brightness)) / 100;
  return normalized <= 0 ? 0 : Math.pow(normalized, _dimmingGamma);
}

// --- BLE write state (tick-worker drives timing) ---

const _charModes = new Map<any, DeviceMode>();

/** @deprecated Use addActiveChar/removeActiveChar instead */
export function setActiveChar(char: any, mode: DeviceMode = 'rgb') {
  _charModes.set(char, mode);
}

export function addActiveChar(char: any, mode: DeviceMode = 'rgb') {
  _charModes.set(char, mode);
}

export function removeActiveChar(char: any) {
  _charModes.delete(char);
}

export function updateCharMode(char: any, mode: DeviceMode) {
  if (_charModes.has(char)) _charModes.set(char, mode);
}

/** Clear all active chars (e.g. full reset) */
export function clearActiveChar() {
  _charModes.clear();
}

/** Clear all active chars */
export function clearAllChars() {
  _charModes.clear();
}

export function getActiveCharCount(): number {
  return _charModes.size;
}

// Brightness-only buffer: white light at variable brightness
const _brightOnlyBuf = new Uint8Array([0x7e, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]);

// Deduplication state — skip identical BLE writes
let _lastR = -1, _lastG = -1, _lastB = -1, _lastBr = -1;

// Throttle state — prevent writes faster than tick interval
let _lastWriteTime = 0;
let _minWriteIntervalMs = 125;

/** Update the BLE write throttle interval (should match tickMs) */
export function setBleThrottleMs(ms: number) {
  _minWriteIntervalMs = Math.max(20, ms);
}

/** Reset dedup/throttle state so the next command is always sent (call on reconnect) */
export function resetLastSent() {
  _lastR = _lastG = _lastB = _lastBr = -1;
  _lastWriteTime = 0;
}

/** Single unified BLE command — pre-multiplies RGB by brightness.
 *  Sends packets to ALL connected devices. RGB devices get color, brightness-only get dimming.
 *  Skips sending if the computed bytes are identical to the previous call. */
export async function sendToBLE(r: number, g: number, b: number, brightness: number) {
  if (_charModes.size === 0) return;
  const scale = brightnessToScale(brightness);
  const cr = Math.round(r * scale);
  const cg = Math.round(g * scale);
  const cb = Math.round(b * scale);
  const cbr = Math.round(scale * 0xff);

  const maxDelta = Math.max(Math.abs(cr - _lastR), Math.abs(cg - _lastG), Math.abs(cb - _lastB), Math.abs(cbr - _lastBr));
  if (maxDelta < 8) { debugData.bleSkipDeltaCount++; return; }

  // Throttle: don't write faster than the tick interval
  const now = performance.now();
  if (now - _lastWriteTime < _minWriteIntervalMs) { debugData.bleSkipThrottleCount++; return; }
  _lastWriteTime = now;

  _lastR = cr; _lastG = cg; _lastB = cb; _lastBr = cbr;

  _colorBuf[4] = cr;
  _colorBuf[5] = cg;
  _colorBuf[6] = cb;
  _brightOnlyBuf[3] = cbr;

  const writes = Array.from(_charModes.entries()).map(([char, mode]) => {
    const buf = mode === 'brightness' ? _brightOnlyBuf : _colorBuf;
    return char.writeValueWithoutResponse(buf).catch((e: any) => {
      console.warn('[BLE] write error:', e?.message);
    });
  });
  await Promise.allSettled(writes);
  debugData.bleSentCount++;
}

export async function sendPower(char: any, on: boolean) {
  const cmd = on ? 0x23 : 0x24;
  const data = new Uint8Array([0x7e, 0x04, 0x04, cmd, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

/** Force hardware brightness to 100% — call at connect to ensure pre-multiplication works */
export async function sendHardwareBrightness(char: any) {
  await char.writeValueWithoutResponse(_brightMaxBuf);
}
