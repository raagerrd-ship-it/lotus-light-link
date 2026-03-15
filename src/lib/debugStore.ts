// Debug data store — plain JS object, mutated directly, no React
// DebugOverlay polls this at 5Hz via setInterval + direct DOM updates

import type { BleReconnectStatus } from "@/lib/bledom";

export interface DebugData {
  // Device
  bleConnected: boolean;
  bleDeviceName: string | null;
  bleReconnectStatus: BleReconnectStatus | null;
  // Input
  smoothedRtt: number;
  sonosVolume: number | null;
  gainMode: 'agc' | 'vol' | 'manual';
  liveBpm: number | null;
  micRms: number;
  bassLevel: number;
  midHiLevel: number;
  isPlayingState: boolean;
  // Process
  energy: number | null;
  loudness: string | null;
  maxBrightness: number;
  dynamicDamping: number;
  dropActive: boolean;
  // BLE Output
  bleSentColor: [number, number, number] | null;
  bleSentBright: number | null;
  bleColorSource: 'idle' | 'normal' | 'white' | null;
  bleBaseColor: [number, number, number] | null;
}

export const debugData: DebugData = {
  bleConnected: false,
  bleDeviceName: null,
  bleReconnectStatus: null,
  smoothedRtt: 0,
  sonosVolume: null,
  gainMode: 'manual',
  liveBpm: null,
  micRms: 0,
  bassLevel: 0,
  midHiLevel: 0,
  isPlayingState: true,
  energy: null,
  loudness: null,
  maxBrightness: 100,
  dynamicDamping: 0,
  dropActive: false,
  bleSentColor: null,
  bleSentBright: null,
  bleColorSource: null,
  bleBaseColor: null,
};
