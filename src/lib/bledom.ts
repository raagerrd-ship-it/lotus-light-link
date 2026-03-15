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

// --- BLE write state (tick-worker drives timing at 25ms/40fps) ---

let _char: any = null;
let _pendingBright: number | null = null;
let _pendingColor: [number, number, number] | null = null;
let _lastSentBright = -1;
let _lastSentColor: [number, number, number] = [-1, -1, -1];
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

  const writeColor = !!_pendingColor;
  const writeBright = _pendingBright != null;

  if (!writeColor && !writeBright) return;

  _writing = true;
  const writeStart = performance.now();
  _lastWriteTime = writeStart;

  try {
    let sentR = _lastSentColor[0], sentG = _lastSentColor[1], sentB = _lastSentColor[2];
    let sentBright = _lastSentBright;

    if (writeColor && _pendingColor) {
      sentR = _pendingColor[0] & 0xff;
      sentG = _pendingColor[1] & 0xff;
      sentB = _pendingColor[2] & 0xff;
      // BLEDOM ELK protocol: byte order is R, G, B
      _colorBuf[4] = sentR;
      _colorBuf[5] = sentG;
      _colorBuf[6] = sentB;
      await _char.writeValueWithoutResponse(_colorBuf);
      _lastSentColor = [sentR, sentG, sentB];
      _pendingColor = null;
      // 1ms delay between color and brightness — BLEDOM needs this to parse correctly
      if (writeBright && _pendingBright != null) {
        await new Promise(r => setTimeout(r, 1));
      }
    }
    if (writeBright && _pendingBright != null) {
      sentBright = Math.max(0, Math.min(100, Math.round(_pendingBright)));
      _brightBuf[3] = sentBright;
      await _char.writeValueWithoutResponse(_brightBuf);
      _lastSentBright = sentBright;
      _pendingBright = null;
    }

    _writeCount++;
    _lastActualWriteMs = performance.now() - writeStart;

    if (_onWriteCallback) {
      _onWriteCallback(sentBright, sentR, sentG, sentB);
    }
  } catch (e: any) {
    _errorCount++;
    _lastError = e?.message || 'GATT write failed';
    console.warn('[BLE] write error:', _lastError);
  }

  _writing = false;
}

export function setActiveChar(char: any) {
  _char = char;
  _lastSentBright = -1;
  _lastSentColor = [-1, -1, -1];
}

/** Clear active char on disconnect to prevent stale GATT writes */
export function clearActiveChar() {
  _char = null;
  _pendingBright = null;
  _pendingColor = null;
}

/** Single unified BLE command — always sets color + brightness atomically.
 *  Pre-multiplies RGB by brightness to avoid BLEDOM's poor color rendering
 *  at low hardware brightness levels. Sends brightness=100% to BLEDOM. */
export function sendToBLE(_char_unused: any, r: number, g: number, b: number, brightness: number) {
  const scale = Math.max(0, Math.min(100, brightness)) / 100;
  _pendingColor = [
    Math.round(r * scale),
    Math.round(g * scale),
    Math.round(b * scale),
  ];
  _pendingBright = null; // Skip brightness packet — pre-multiplied RGB handles dimming
  // Fire callback with original (pre-multiply) values for debug display
  if (_onWriteCallback) {
    _onWriteCallback(brightness, r, g, b);
  }
  if (!_writing) { _flush(); }
  _lastTickToWriteMs = 0;
  return Promise.resolve();
}

export async function sendPower(char: any, on: boolean) {
  const cmd = on ? 0x23 : 0x24;
  const data = new Uint8Array([0x7e, 0x04, 0x04, cmd, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

