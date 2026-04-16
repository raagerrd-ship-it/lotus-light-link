/**
 * BLE module — public API re-exports.
 * Drop-in replacement for the old monolithic nobleBle.ts.
 *
 * Import order matters: reconnect.ts must load after connection.ts and protocol.ts
 * to wire up cross-module callbacks.
 */

// Types
export type { DeviceMode, PiCharacteristic, DiscoveredDevice, BleConnectionEvent } from './types.js';

// State & adapter
export { bleStats, getAdapterState, isDemandActive, getConnectionLog } from './state.js';
export { getDevice, getSavedDeviceId, getSavedDeviceName } from './state.js';
export { getSavedDeviceAddress } from './state.js';

// Protocol (write pipeline)
export { sendToBLE, sendRawColor, resetLastSent, setDimmingGamma, getDimmingGamma } from './protocol.js';

// Connection
export { connectPeripheral, resetHciAdapter } from './connection.js';

// Scanning (bluetoothctl discovery)
export { scanForDevices, getLastScanResults, isScanning } from './scan.js';

// Device selection & noble-based connect
export { selectDevice, forgetDevice, autoConnectSaved } from './discover.js';

// Reconnection & demand
export { requestConnect, releaseDemand, startReconnectLoop } from './reconnect.js';

// ── Convenience / legacy aliases ──
import { getDevice, setDevice } from './state.js';
import { stopKeepAlive, resetLastSent } from './protocol.js';
import { autoConnectSaved } from './discover.js';

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
