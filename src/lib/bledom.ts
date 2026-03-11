// BLEDOM BLE LED strip protocol

const SERVICE_UUID = 0xfff0;
const CHAR_UUID = 0xfff3;
const STORAGE_KEY = 'bledom-last-device';

export interface BLEConnection {
  device: any;
  characteristic: any;
}

export function saveLastDevice(device: any) {
  if (device?.id && device?.name) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: device.id, name: device.name }));
  }
}

export function getLastDevice(): { id: string; name: string } | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
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

// Auto-reconnect using getDevices() + watchAdvertisements() — no picker needed
export async function autoReconnect(): Promise<BLEConnection | null> {
  const nav = navigator as any;
  if (!nav.bluetooth?.getDevices) return null;

  try {
    const devices = await nav.bluetooth.getDevices();
    const saved = getLastDevice();
    const target = devices.find((d: any) => d.id === saved?.id) ?? devices[0];
    if (!target) return null;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        target.removeEventListener('advertisementreceived', onAdvert);
        resolve(null);
      }, 5000);

      const onAdvert = async () => {
        clearTimeout(timeout);
        target.removeEventListener('advertisementreceived', onAdvert);
        try {
          const conn = await connectToDevice(target);
          resolve(conn);
        } catch { resolve(null); }
      };

      target.addEventListener('advertisementreceived', onAdvert);
      target.watchAdvertisements({ signal: AbortSignal.timeout(5000) }).catch(() => {
        clearTimeout(timeout);
        resolve(null);
      });
    });
  } catch {
    return null;
  }
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

export async function sendColor(char: any, r: number, g: number, b: number) {
  _colorBuf[4] = r & 0xff;
  _colorBuf[5] = g & 0xff;
  _colorBuf[6] = b & 0xff;
  await char.writeValueWithoutResponse(_colorBuf);
}

export async function sendBrightness(char: any, brightness: number) {
  _brightBuf[3] = Math.max(0, Math.min(100, Math.round(brightness)));
  await char.writeValueWithoutResponse(_brightBuf);
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
