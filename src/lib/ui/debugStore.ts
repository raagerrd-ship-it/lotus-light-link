// Debug data store — plain JS object, mutated directly, no React
// DebugOverlay polls this at 5Hz via setInterval + direct DOM updates

import type { BleReconnectStatus } from "@/lib/engine/bledom";

export interface DebugData {
  // Device
  bleConnected: boolean;
  bleDeviceName: string | null;
  bleReconnectStatus: BleReconnectStatus | null;
  // Input
  smoothedRtt: number;
  sonosVolume: number | null;
  gainMode: 'agc' | 'vol' | 'manual';
  micRms: number;
  bassLevel: number;
  midHiLevel: number;
  isPlayingState: boolean;
  sonosPlaybackState: string | null;
  // Process
  dynamicDamping: number;
  // BLE Output
  bleSentColor: [number, number, number] | null;
  bleSentBright: number | null;
  bleColorSource: 'idle' | 'normal' | null;
  bleBaseColor: [number, number, number] | null;
  // BLE dedup/throttle counters
  bleSentCount: number;
  bleSkipDeltaCount: number;
  bleSkipThrottleCount: number;
  bleSkipBusyCount: number;
  bleWriteLatMs: number;
  bleWriteLatAvgMs: number;
  tickMs: number;
}

export const debugData: DebugData = {
  bleConnected: false,
  bleDeviceName: null,
  bleReconnectStatus: null,
  smoothedRtt: 0,
  sonosVolume: null,
  gainMode: 'manual',
  micRms: 0,
  bassLevel: 0,
  midHiLevel: 0,
  isPlayingState: true,
  sonosPlaybackState: null,
  dynamicDamping: 0,
  bleSentColor: null,
  bleSentBright: null,
  bleColorSource: null,
  bleBaseColor: null,
  bleSentCount: 0,
  bleSkipDeltaCount: 0,
  bleSkipThrottleCount: 0,
  bleSkipBusyCount: 0,
  bleWriteLatMs: 0,
  bleWriteLatAvgMs: 0,
  tickMs: 125,
};
