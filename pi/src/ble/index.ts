/**
 * BLE module — public API re-exports.
 *
 * File structure:
 *   scan.ts      — bluetoothctl discovery → device list
 *   save.ts      — selectDevice, forgetDevice, savePeripheralMetadata
 *   connect.ts   — direct connect + GATT discovery + autoConnectSaved
 *   protocol.ts  — BLEDOM packet format, write pipeline, keep-alive
 *   reconnect.ts — reconnect loop, demand-based connection
 *   adapter.ts   — HCI socket arbitration (noble ↔ bluetoothctl)
 *   state.ts     — shared mutable state, stats, noble reference
 */

// Types
export type { DeviceMode, PiCharacteristic, DiscoveredDevice, BleConnectionEvent } from './types.js';

// State & adapter
export { bleStats, getAdapterState, isDemandActive, getConnectionLog } from './state.js';
export { getDevice, getSavedDeviceId, getSavedDeviceName } from './state.js';
export { getSavedDeviceAddress, getSavedAddressType, getSavedConnectable, getSavedServiceUuids, isNobleHciReleased, processHasBtCaps } from './state.js';

// Protocol (write pipeline)
export { sendToBLE, sendRawColor, resetLastSent, setDimmingGamma, getDimmingGamma } from './protocol.js';

// Connection (direct connect + GATT)
export { connectPeripheral, resetHciAdapter, autoConnectSaved } from './connect.js';

// Scanning (bluetoothctl discovery)
export { scanForDevices, getLastScanResults, isScanning } from './scan.js';

// Device persistence (save / forget)
export { selectDevice, forgetDevice } from './save.js';

// Reconnection & demand
export { requestConnect, releaseDemand, startReconnectLoop } from './reconnect.js';

// ── Convenience / legacy aliases ──
import { getDevice, setDevice } from './state.js';
import { stopKeepAlive, resetLastSent } from './protocol.js';
import { autoConnectSaved } from './connect.js';

export function getConnectedCount(): number {
  return getDevice() ? 1 : 0;
}

export function getConnectedNames(): string[] {
  const d = getDevice();
  return d ? [d.name] : [];
}

export function getConnectedDeviceId(): string | null {
  return getDevice()?.id ?? null;
}

export async function disconnect(): Promise<void> {
  stopKeepAlive();
  const d = getDevice();
  if (d) {
    try { await d.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
    console.log('[BLE] Disconnected');
  }
}

export const disconnectAll = disconnect;
export const scanAndConnect = autoConnectSaved;
export function setExpectedDeviceCount(_n: number): void { /* no-op */ }

// Adapter init runs automatically when adapter.ts is imported
import './adapter.js';
