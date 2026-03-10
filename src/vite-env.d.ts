/// <reference types="vite/client" />

// Web Bluetooth API type declarations
interface BluetoothRemoteGATTCharacteristic {
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  writeValue(value: BufferSource): Promise<void>;
  readValue(): Promise<DataView>;
  uuid: string;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(characteristic: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
  uuid: string;
}

interface BluetoothRemoteGATTServer {
  connect(): Promise<BluetoothRemoteGATTServer>;
  getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>;
  connected: boolean;
}

interface BluetoothDevice extends EventTarget {
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
  id: string;
}

interface RequestDeviceOptions {
  filters?: Array<{ namePrefix?: string; name?: string; services?: Array<string | number> }>;
  optionalServices?: Array<string | number>;
  acceptAllDevices?: boolean;
}

interface Bluetooth {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Navigator {
  bluetooth: Bluetooth;
}
