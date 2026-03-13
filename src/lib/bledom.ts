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

// Auto-reconnect: retry loop — keeps trying until connected or unmounted
// Returns a promise that resolves when connected, or null if aborted via signal
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

      // Try direct GATT first
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

// Pre-allocated buffers to avoid GC in hot loops
const _colorBuf = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const _brightBuf = new Uint8Array([0x7e, 0x04, 0x01, 0, 0x01, 0xff, 0x00, 0x00, 0xef]);

// --- Frame scheduler: max 1 BLE write per MIN_INTERVAL_MS ---
const BLE_INTERVAL_KEY = 'ble-min-interval-ms';
const BLE_MIN_FLOOR = 50; // 20 slots/sec max
let _minIntervalMs = (() => {
  try {
    const v = localStorage.getItem(BLE_INTERVAL_KEY);
    const parsed = v ? parseInt(v, 10) : BLE_MIN_FLOOR;
    const result = Math.max(BLE_MIN_FLOOR, isNaN(parsed) ? BLE_MIN_FLOOR : parsed);
    console.log(`[BLE] interval from storage: ${v}, using: ${result}ms`);
    return result;
  } catch { return BLE_MIN_FLOOR; }
})();

export function getBleMinInterval(): number { return _minIntervalMs; }
export function setBleMinInterval(ms: number) {
  // Floor at 50ms (20 cmd/s max) regardless of calibration result
  _minIntervalMs = Math.max(50, Math.min(200, Math.round(ms)));
  try { localStorage.setItem(BLE_INTERVAL_KEY, String(_minIntervalMs)); } catch {}
}

let _char: any = null;
let _pendingBright: number | null = null;
let _pendingColor: [number, number, number] | null = null;
let _lastSentBright = -1;
let _lastSentColor: [number, number, number] = [-1, -1, -1];
let _writing = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _lastWriteTime = 0;
let _onWriteCallback: ((bright: number, r: number, g: number, b: number) => void) | null = null;

/** Register callback invoked after each actual BLE write with the sent values */
export function onBleWrite(cb: ((bright: number, r: number, g: number, b: number) => void) | null) {
  _onWriteCallback = cb;
}

// Debug stats
export interface BleWriteStats {
  writesPerSec: number;
  droppedPerSec: number;
  lastWriteMs: number;
  queueAgeMs: number;
  errorCount: number;
  lastError: string;
}

// Pipeline step timings (set externally by MicPanel tick loop)
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
let _dropCount = 0;
let _statsStart = performance.now();
let _lastActualWriteMs = 0;
let _lastTickToWriteMs = 0;
let _dirtyWhileWriting = false;
let _errorCount = 0;
let _lastError = '';

export function getLastTickToWriteMs(): number { return _lastTickToWriteMs; }

export function getBleWriteStats(): BleWriteStats {
  const elapsed = (performance.now() - _statsStart) / 1000;
  const wps = elapsed > 0 ? _writeCount / elapsed : 0;
  const dps = elapsed > 0 ? _dropCount / elapsed : 0;
  if (elapsed > 2) {
    _writeCount = 0;
    _dropCount = 0;
    _statsStart = performance.now();
  }
  return {
    writesPerSec: Math.round(wps),
    droppedPerSec: Math.round(dps),
    lastWriteMs: Math.round(_lastActualWriteMs),
    queueAgeMs: Math.round(_lastTickToWriteMs),
    errorCount: _errorCount,
    lastError: _lastError,
  };
}

async function _flush() {
  if (_writing || !_char) return;

  const now = performance.now();
  const elapsed = now - _lastWriteTime;
  if (elapsed < _minIntervalMs) {
    if (!_timer) {
      _timer = setTimeout(() => { _timer = null; _flush(); }, _minIntervalMs - elapsed);
    }
    return;
  }

  let writeBright = false;
  let writeColor = false;

  if (_pendingBright != null && _pendingBright !== _lastSentBright) {
    writeBright = true;
  }

  // Always send color — prevents drift, tick loop sets it every tick
  if (_pendingColor) {
    writeColor = true;
  }

  if (!writeBright && !writeColor) {
    _pendingBright = null;
    return;
  }

  _writing = true;
  _dirtyWhileWriting = false;
  const writeStart = performance.now();
  _lastWriteTime = writeStart;

  try {
    // Color → 1ms → brightness (matches calibration protocol)
    if (writeColor && _pendingColor) {
      _colorBuf[4] = _pendingColor[0] & 0xff;
      _colorBuf[5] = _pendingColor[1] & 0xff;
      _colorBuf[6] = _pendingColor[2] & 0xff;
      await _char.writeValueWithoutResponse(_colorBuf);
      _lastSentColor = [..._pendingColor];
      _pendingColor = null;
      if (writeBright) await new Promise(r => setTimeout(r, 1));
    }

    if (writeBright && _pendingBright != null) {
      _brightBuf[3] = Math.max(0, Math.min(100, Math.round(_pendingBright)));
      await _char.writeValueWithoutResponse(_brightBuf);
      _lastSentBright = _pendingBright;
      _pendingBright = null;
    }

    _writeCount++; // Count per slot, not per GATT write
    _lastActualWriteMs = performance.now() - writeStart;

    // Notify listener with actually-sent values
    if (_onWriteCallback) {
      _onWriteCallback(_lastSentBright, _lastSentColor[0], _lastSentColor[1], _lastSentColor[2]);
    }
  } catch (e: any) {
    _errorCount++;
    _lastError = e?.message || 'GATT write failed';
    console.warn('[BLE] write error:', _lastError);
  }

  _writing = false;

  // If new data arrived while we were writing, flush again after interval
  if (_dirtyWhileWriting || _pendingBright != null || _pendingColor) {
    _dirtyWhileWriting = false;
    if (!_timer) {
      const sinceWrite = performance.now() - _lastWriteTime;
      const delay = Math.max(0, _minIntervalMs - sinceWrite);
      _timer = setTimeout(() => { _timer = null; _flush(); }, delay);
    }
  }
}

export function setActiveChar(char: any) {
  _char = char;
  _lastSentBright = -1;
  _lastSentColor = [-1, -1, -1];
}

export function sendColor(_char_unused: any, r: number, g: number, b: number) {
  _pendingColor = [r, g, b];
  if (_writing) { _dirtyWhileWriting = true; } else { _flush(); }
  _lastTickToWriteMs = 0; // reset; will be measured by caller if needed
  return Promise.resolve();
}

export function sendBrightness(_char_unused: any, brightness: number) {
  _pendingBright = brightness;
  if (_writing) { _dirtyWhileWriting = true; } else { _flush(); }
  return Promise.resolve();
}

export async function sendPower(char: any, on: boolean) {
  const cmd = on ? 0x23 : 0x24;
  const data = new Uint8Array([0x7e, 0x04, 0x04, cmd, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

// --- Utility ---
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;

  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}
