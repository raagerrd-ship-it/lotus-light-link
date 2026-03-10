// BLEDOM BLE LED strip protocol

const SERVICE_UUID = 0xfff0;
const CHAR_UUID = 0xfff3;

export interface BLEConnection {
  device: any;
  characteristic: any;
}

export async function connectBLEDOM(): Promise<BLEConnection> {
  const nav = navigator as any;
  const device = await nav.bluetooth.requestDevice({
    filters: [{ namePrefix: 'ELK-BLEDOM' }],
    optionalServices: [SERVICE_UUID],
  });

  const server = await device.gatt!.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const characteristic = await service.getCharacteristic(CHAR_UUID);

  return { device, characteristic };
}

export async function sendColor(char: any, r: number, g: number, b: number) {
  // Protocol: 7E 07 05 03 RR GG BB 00 EF
  const data = new Uint8Array([0x7e, 0x07, 0x05, 0x03, r & 0xff, g & 0xff, b & 0xff, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

export async function sendBrightness(char: BluetoothRemoteGATTCharacteristic, brightness: number) {
  // brightness: 0-100
  const val = Math.max(0, Math.min(100, Math.round(brightness)));
  const data = new Uint8Array([0x7e, 0x04, 0x01, val, 0x01, 0xff, 0x00, 0x00, 0xef]);
  await char.writeValueWithoutResponse(data);
}

export async function sendPower(char: BluetoothRemoteGATTCharacteristic, on: boolean) {
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
