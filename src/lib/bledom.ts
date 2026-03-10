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
  const server = await device.gatt!.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const characteristic = await service.getCharacteristic(CHAR_UUID);
  saveLastDevice(device);
  return { device, characteristic };
}

// Try reconnecting to a previously paired device without showing the chooser
export async function reconnectLastDevice(): Promise<BLEConnection | null> {
  const nav = navigator as any;
  if (!nav.bluetooth?.getDevices) return null;

  const lastDevice = getLastDevice();
  if (!lastDevice) return null;

  const devices = await nav.bluetooth.getDevices();
  const device = devices.find((d: any) => d.id === lastDevice.id);
  if (!device) return null;

  // Request the browser to watch for the device advertisement
  const abortController = new AbortController();
  
  return new Promise<BLEConnection | null>((resolve) => {
    const timeout = setTimeout(() => {
      abortController.abort();
      resolve(null);
    }, 5000);

    device.addEventListener('advertisementreceived', async () => {
      clearTimeout(timeout);
      try {
        const conn = await connectToDevice(device);
        resolve(conn);
      } catch {
        resolve(null);
      }
    }, { once: true });

    device.watchAdvertisements({ signal: abortController.signal }).catch(() => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
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

export async function sendColor(char: any, r: number, g: number, b: number) {
  // Protocol: 7E 07 05 03 RR GG BB 00 EF
  const data = new Uint8Array([0x7e, 0x07, 0x05, 0x03, r & 0xff, g & 0xff, b & 0xff, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

export async function sendBrightness(char: any, brightness: number) {
  // brightness: 0-100
  const val = Math.max(0, Math.min(100, Math.round(brightness)));
  const data = new Uint8Array([0x7e, 0x04, 0x01, val, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

export async function sendPower(char: any, on: boolean) {
  const cmd = on ? 0x23 : 0x24;
  const data = new Uint8Array([0x7e, 0x04, 0x04, cmd, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

// HSV to RGB conversion
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
