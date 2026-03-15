// BLEDOM BLE LED strip protocol

const SERVICE_UUID = 0xfff0;
const CHAR_UUID = 0xfff3;
const STORAGE_KEY = 'bledom-last-device';

type LastDevice = { id: string; name: string };

export interface BLEConnection {
  device: any;
  characteristic: any;
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
  return { device, characteristic };
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

export async function connectBLEDOM(scanAll = false): Promise<BLEConnection> {
  const nav = navigator as any;

  const options = scanAll
    ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
    : {
        filters: [
          { namePrefix: 'ELK-BLEDOM' },
          { namePrefix: 'BLEDOM' },
          { namePrefix: 'ELK' },
          { namePrefix: 'MELK' },
          { services: [SERVICE_UUID] },
        ],
        optionalServices: [SERVICE_UUID],
      };

  const device = await nav.bluetooth.requestDevice(options);
  return connectToDevice(device);
}

// Pre-allocated color buffer — single 9-byte packet per tick
const _colorBuf = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
// Hardware brightness = max (0xFF)
const _brightMaxBuf = new Uint8Array([0x7e, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0xef]);

// --- BLE write state (tick-worker drives timing) ---

let _char: any = null;
let _pendingColor: [number, number, number] | null = null;
let _writing = false;
let _onWriteCallback: ((bright: number, r: number, g: number, b: number) => void) | null = null;

/** Register callback invoked after each actual BLE write with the sent values */
export function onBleWrite(cb: ((bright: number, r: number, g: number, b: number) => void) | null) {
  _onWriteCallback = cb;
}

// --- Stats (used by CalibrationOverlay PipelineStats) ---

export interface BleWriteStats {
  writesPerSec: number;
  lastWriteMs: number;
}

export interface PipelineTimings {
  rmsMs: number;
  smoothMs: number;
  bleCallMs: number;
  totalTickMs: number;
}
let _pipelineTimings: PipelineTimings = { rmsMs: 0, smoothMs: 0, bleCallMs: 0, totalTickMs: 0 };

export function setPipelineTimings(t: PipelineTimings) { _pipelineTimings = t; }
export function getPipelineTimings(): PipelineTimings { return _pipelineTimings; }

let _writeCount = 0;
let _statsStart = performance.now();
let _lastWriteMs = 0;
let _lastBright = 0;

let _backoffUntil = 0;

export function getBleWriteStats(): BleWriteStats {
  const now = performance.now();
  const elapsed = (now - _statsStart) / 1000;
  const wps = elapsed > 0 ? _writeCount / elapsed : 0;

  if (elapsed > 2) {
    _writeCount = 0;
    _statsStart = now;
  }
  return {
    writesPerSec: Math.round(wps),
    lastWriteMs: Math.round(_lastWriteMs),
  };
}

async function _flush() {
  if (_writing || !_char || !_pendingColor) return;
  if (performance.now() < _backoffUntil) return;

  _writing = true;
  const t0 = performance.now();

  try {
    const [r, g, b] = _pendingColor;
    _pendingColor = null;

    _colorBuf[4] = r;
    _colorBuf[5] = g;
    _colorBuf[6] = b;

    await _char.writeValueWithoutResponse(_colorBuf);
    _writeCount++;
    _lastWriteMs = performance.now() - t0;

    _onWriteCallback?.(_lastBright, r, g, b);
  } catch (e: any) {
    _errorCount++;
    _backoffUntil = performance.now() + 100;
    console.warn('[BLE] write error (backoff 100ms):', e?.message);
  }

  _writing = false;
}

export function setActiveChar(char: any) {
  _char = char;
  _errorCount = 0;
  _backoffUntil = 0;
}

/** Clear active char on disconnect to prevent stale GATT writes */
export function clearActiveChar() {
  _char = null;
  _pendingColor = null;
}

/** Single unified BLE command — pre-multiplies RGB by brightness.
 *  Sends one 9-byte color packet. Hardware brightness is locked to 100%. */
export function sendToBLE(r: number, g: number, b: number, brightness: number) {
  const scale = Math.max(0, Math.min(100, brightness)) / 100;
  _pendingColor = [
    Math.round(r * scale),
    Math.round(g * scale),
    Math.round(b * scale),
  ];
  _lastBright = brightness;
  if (!_writing) _flush();
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
