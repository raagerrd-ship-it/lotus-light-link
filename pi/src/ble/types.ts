/**
 * BLE shared types and interfaces.
 */

export type DeviceMode = 'rgb' | 'brightness';

export interface PiCharacteristic {
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  _peripheral?: any;
  deviceName?: string;
  deviceId?: string;
}

/** A discovered but not-yet-connected device */
export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi: number;
  /** Where the device was first observed: noble, hcitool, or both */
  source?: 'noble' | 'hcitool' | 'both';
}

/** Connected device state */
export interface ConnectedDevice {
  peripheral: any;
  characteristic: PiCharacteristic;
  mode: DeviceMode;
  name: string;
  id: string;
}
