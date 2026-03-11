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

// Try reconnecting to a previously paired device without showing the chooser
export async function reconnectLastDevice(): Promise<BLEConnection | null> {
  const nav = navigator as any;
  const lastDevice = getLastDevice();
  if (!lastDevice || !nav.bluetooth) return null;

  // Fast path: getDevices (desktop/newer Chrome)
  if (nav.bluetooth.getDevices) {
    const devices = await nav.bluetooth.getDevices();
    const device = devices.find((d: any) => d.id === lastDevice.id)
      ?? devices.find((d: any) => d.name === lastDevice.name);

    if (device?.gatt) {
      // Strategy 1: direct connect
      try {
        const conn = await Promise.race([
          connectToDevice(device),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]);
        return conn;
      } catch {}

      // Strategy 2: wait for advertisement then connect
      if (device.watchAdvertisements) {
        const abortController = new AbortController();
        try {
          const conn = await Promise.race([
            new Promise<BLEConnection>((resolve, reject) => {
              device.addEventListener('advertisementreceived', async () => {
                try { resolve(await connectToDevice(device)); }
                catch (e) { reject(e); }
              }, { once: true });
              device.watchAdvertisements({ signal: abortController.signal }).catch(reject);
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
          ]);
          return conn;
        } catch {} finally {
          abortController.abort();
        }
      }
    }
  }

  // Fallback path: platforms without getDevices (or when stored device not found)
  // Opens chooser filtered to likely BLEDOM devices.
  try {
    return await connectBLEDOM(false);
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

// --- Effects ---
export const EFFECTS = {
  jump_rgb: 0x87,
  jump_rgbycmw: 0x88,
  crossfade_red: 0x8b,
  crossfade_green: 0x8c,
  crossfade_blue: 0x8d,
  crossfade_yellow: 0x8e,
  crossfade_cyan: 0x8f,
  crossfade_magenta: 0x90,
  crossfade_white: 0x91,
  crossfade_rg: 0x92,
  crossfade_rb: 0x93,
  crossfade_gb: 0x94,
  crossfade_rgb: 0x89,
  crossfade_rgbycmw: 0x8a,
  blink_red: 0x96,
  blink_green: 0x97,
  blink_blue: 0x98,
  blink_yellow: 0x99,
  blink_cyan: 0x9a,
  blink_magenta: 0x9b,
  blink_white: 0x9c,
  blink_rgbycmw: 0x95,
} as const;

export type EffectKey = keyof typeof EFFECTS;

export const EFFECT_LABELS: Record<EffectKey, string> = {
  jump_rgb: "Jump RGB",
  jump_rgbycmw: "Jump Regnbåge",
  crossfade_red: "Tona Röd",
  crossfade_green: "Tona Grön",
  crossfade_blue: "Tona Blå",
  crossfade_yellow: "Tona Gul",
  crossfade_cyan: "Tona Cyan",
  crossfade_magenta: "Tona Magenta",
  crossfade_white: "Tona Vit",
  crossfade_rg: "Tona Röd↔Grön",
  crossfade_rb: "Tona Röd↔Blå",
  crossfade_gb: "Tona Grön↔Blå",
  crossfade_rgb: "Tona RGB",
  crossfade_rgbycmw: "Tona Regnbåge",
  blink_red: "Blinka Röd",
  blink_green: "Blinka Grön",
  blink_blue: "Blinka Blå",
  blink_yellow: "Blinka Gul",
  blink_cyan: "Blinka Cyan",
  blink_magenta: "Blinka Magenta",
  blink_white: "Blinka Vit",
  blink_rgbycmw: "Blinka Regnbåge",
};

export async function sendEffect(char: any, effect: number) {
  const data = new Uint8Array([0x7e, 0x05, 0x03, effect, 0x03, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

export async function sendEffectSpeed(char: any, speed: number) {
  // speed: 0 (fast) to 100 (slow) – we invert so 0=slow, 100=fast for UX
  const val = Math.max(0, Math.min(100, 100 - Math.round(speed)));
  const data = new Uint8Array([0x7e, 0x04, 0x02, val, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

// --- Color Temperature ---
export async function sendColorTemp(char: any, warmth: number) {
  // warmth: 0 (cool/blue) to 100 (warm/yellow)
  const warm = Math.max(0, Math.min(100, Math.round(warmth)));
  const cool = 100 - warm;
  const data = new Uint8Array([0x7e, 0x07, 0x05, 0x02, warm, cool, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

// --- Mic/Sound reactive ---
export async function sendMicMode(char: any, on: boolean) {
  const val = on ? 0x01 : 0x00;
  const data = new Uint8Array([0x7e, 0x04, 0x07, val, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

export const MIC_EQ_MODES = {
  classic: 0x00,
  soft: 0x01,
  dynamic: 0x02,
  disco: 0x03,
} as const;

export type MicEqKey = keyof typeof MIC_EQ_MODES;

export const MIC_EQ_LABELS: Record<MicEqKey, string> = {
  classic: "Klassisk",
  soft: "Mjuk",
  dynamic: "Dynamisk",
  disco: "Disco",
};

export async function sendMicEq(char: any, eq: number) {
  const data = new Uint8Array([0x7e, 0x05, 0x08, eq, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

// --- Schedule ---
export const WEEKDAYS = {
  monday: 0x02,
  tuesday: 0x04,
  wednesday: 0x08,
  thursday: 0x10,
  friday: 0x20,
  saturday: 0x40,
  sunday: 0x80,
} as const;

export async function sendScheduleOn(char: any, hour: number, minute: number, dayMask: number, enabled: boolean) {
  const en = enabled ? 0x01 : 0x00;
  const data = new Uint8Array([0x7e, 0x06, 0x05, hour & 0xff, minute & 0xff, dayMask & 0xff, en, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

export async function sendScheduleOff(char: any, hour: number, minute: number, dayMask: number, enabled: boolean) {
  const en = enabled ? 0x01 : 0x00;
  const data = new Uint8Array([0x7e, 0x06, 0x06, hour & 0xff, minute & 0xff, dayMask & 0xff, en, 0x00, 0xef]);
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
