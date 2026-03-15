// BLEDOM BLE LED strip protocol

const SERVICE_UUID = 0xfff0;
const CHAR_UUID = 0xfff3;
const STORAGE_KEY = 'bledom-last-device';

type LastDevice = { id: string; name: string };

export interface BLEConnection {
  device: any;
  characteristic: any;
  charProperties?: { write: boolean; writeWithoutResponse: boolean; read: boolean; notify: boolean };
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
  const props = characteristic.properties;
  const charProperties = {
    write: !!props?.write,
    writeWithoutResponse: !!props?.writeWithoutResponse,
    read: !!props?.read,
    notify: !!props?.notify,
  };
  console.log('[BLE] characteristic properties:', charProperties);
  saveLastDevice(device);
  return { device, characteristic, charProperties };
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

// Pre-allocated buffers
const _colorBuf = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
// Hardware brightness = 100% (0x64) — sent periodically to prevent hardware dimming
const _brightMaxBuf = new Uint8Array([0x7e, 0x04, 0x01, 0x64, 0x00, 0x00, 0x00, 0x00, 0xef]);
const BRIGHT_REFRESH_INTERVAL = 50; // send brightness=100% every N writes

// --- BLE write state (tick-worker drives timing) ---

let _char: any = null;
let _pendingColor: [number, number, number] | null = null;
let _lastSentColor: [number, number, number] = [-1, -1, -1];
let _lastBright = 0;
let _writing = false;
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
  peakWriteMs: number;
  queueAgeMs: number;
  errorCount: number;
  errorsPerSec: number;
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
let _pipelinePeakMs = 0;
let _pipelinePeakResetTime = performance.now();

export function setPipelineTimings(t: PipelineTimings) {
  _pipelineTimings = t;
  const now = performance.now();
  if (now - _pipelinePeakResetTime > 5000) {
    _pipelinePeakMs = 0;
    _pipelinePeakResetTime = now;
  }
  if (t.totalTickMs > _pipelinePeakMs) _pipelinePeakMs = t.totalTickMs;
}
export function getPipelineTimings(): PipelineTimings { return _pipelineTimings; }
export function getPipelinePeakMs(): number { return _pipelinePeakMs; }

let _writeCount = 0;
let _dropCount = 0;
let _statsStart = performance.now();
let _lastActualWriteMs = 0;
let _lastTickToWriteMs = 0;

let _errorCount = 0;
let _errorCountWindow = 0;
let _errorWindowStart = performance.now();
let _lastError = '';
let _backoffUntil = 0;

// Peak tracking (rolling 5s window)
let _peakWriteMs = 0;
let _peakWriteResetTime = performance.now();

export function getLastTickToWriteMs(): number { return _lastTickToWriteMs; }

export function getBleWriteStats(): BleWriteStats {
  const now = performance.now();
  const elapsed = (now - _statsStart) / 1000;
  const wps = elapsed > 0 ? _writeCount / elapsed : 0;
  const dps = elapsed > 0 ? _dropCount / elapsed : 0;

  const errElapsed = (now - _errorWindowStart) / 1000;
  const eps = errElapsed > 0 ? _errorCountWindow / errElapsed : 0;

  if (elapsed > 2) {
    _writeCount = 0;
    _dropCount = 0;
    _statsStart = now;
  }
  if (errElapsed > 2) {
    _errorCountWindow = 0;
    _errorWindowStart = now;
  }
  if (now - _peakWriteResetTime > 5000) {
    _peakWriteMs = 0;
    _peakWriteResetTime = now;
  }
  return {
    writesPerSec: Math.round(wps),
    droppedPerSec: Math.round(dps),
    lastWriteMs: Math.round(_lastActualWriteMs),
    peakWriteMs: Math.round(_peakWriteMs),
    queueAgeMs: Math.round(_lastTickToWriteMs),
    errorCount: _errorCount,
    errorsPerSec: Math.round(eps),
    lastError: _lastError,
  };
}

async function _flush() {
  if (_writing || !_char || !_pendingColor) return;
  if (performance.now() < _backoffUntil) return;

  _writing = true;
  const writeStart = performance.now();
  _lastWriteTime = writeStart;

  try {
    const r = _pendingColor[0] & 0xff;
    const g = _pendingColor[1] & 0xff;
    const b = _pendingColor[2] & 0xff;
    _pendingColor = null;

    _colorBuf[4] = r;
    _colorBuf[5] = g;
    _colorBuf[6] = b;

    await _char.writeValueWithoutResponse(_colorBuf);
    _lastSentColor = [r, g, b];
    _writeCount++;

    // Periodically force hardware brightness to 100%
    if (_writeCount % BRIGHT_REFRESH_INTERVAL === 0) {
      await _char.writeValueWithoutResponse(_brightMaxBuf);
    }
    _lastActualWriteMs = performance.now() - writeStart;
    if (_lastActualWriteMs > _peakWriteMs) _peakWriteMs = _lastActualWriteMs;

    if (_onWriteCallback) {
      _onWriteCallback(_lastBright, r, g, b);
    }

    // Don't re-flush recursively — let the next tick drive writes
    // to prevent OS buffer bloat with writeValueWithoutResponse
  } catch (e: any) {
    _errorCount++;
    _errorCountWindow++;
    _lastError = e?.message || 'GATT write failed';
    _backoffUntil = performance.now() + 100;
    console.warn('[BLE] write error (backoff 100ms):', _lastError);
  }

  _writing = false;
}

export function setActiveChar(char: any) {
  _char = char;
  _lastSentColor = [-1, -1, -1];
  _errorCount = 0;
  _errorCountWindow = 0;
  _errorWindowStart = performance.now();
  _lastError = '';
  _backoffUntil = 0;
}

/** Clear active char on disconnect to prevent stale GATT writes */
export function clearActiveChar() {
  _char = null;
  _pendingColor = null;
}

/** Single unified BLE command — always sets color + brightness atomically.
 *  Pre-multiplies RGB by brightness to avoid BLEDOM's poor color rendering
 *  at low hardware brightness levels. Sends brightness=100% to BLEDOM. */
export function sendToBLE(r: number, g: number, b: number, brightness: number) {
  const scale = Math.max(0, Math.min(100, brightness)) / 100;
  _pendingColor = [
    Math.round(r * scale),
    Math.round(g * scale),
    Math.round(b * scale),
  ];
  _lastBright = brightness;
  if (!_writing) { _flush(); }
  _lastTickToWriteMs = 0;
  return Promise.resolve();
}

export async function sendPower(char: any, on: boolean) {
  const cmd = on ? 0x23 : 0x24;
  const data = new Uint8Array([0x7e, 0x04, 0x04, cmd, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

