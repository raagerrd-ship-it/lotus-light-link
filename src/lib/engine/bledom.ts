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

const _chars = new Set<any>();

/** @deprecated Use addActiveChar/removeActiveChar instead */
export function setActiveChar(char: any) {
  _chars.add(char);
}

export function addActiveChar(char: any) {
  _chars.add(char);
}

export function removeActiveChar(char: any) {
  _chars.delete(char);
}

/** Clear all active chars (e.g. full reset) */
export function clearActiveChar() {
  _chars.clear();
}

/** Clear all active chars */
export function clearAllChars() {
  _chars.clear();
}

export function getActiveCharCount(): number {
  return _chars.size;
}

/** Single unified BLE command — pre-multiplies RGB by brightness.
 *  Sends one 9-byte color packet to ALL connected devices. Hardware brightness is locked to 100%. */
export async function sendToBLE(r: number, g: number, b: number, brightness: number) {
  if (_chars.size === 0) return;
  const scale = Math.max(0, Math.min(100, brightness)) / 100;
  _colorBuf[4] = Math.round(r * scale);
  _colorBuf[5] = Math.round(g * scale);
  _colorBuf[6] = Math.round(b * scale);

  const writes = Array.from(_chars).map(char =>
    char.writeValueWithoutResponse(_colorBuf).catch((e: any) => {
      console.warn('[BLE] write error:', e?.message);
    })
  );
  await Promise.allSettled(writes);
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
