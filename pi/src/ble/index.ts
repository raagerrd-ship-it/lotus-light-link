/**
 * BLE module — public API re-exports.
 *
 * File structure:
 *   scan.ts      — noble async scan → device list
 *   save.ts      — selectDevice, forgetDevice, savePeripheralMetadata
 *   connect.ts   — direct connect + GATT discovery + autoConnectSaved
 *   protocol.ts  — BLEDOM packet format, write pipeline, keep-alive
 *   reconnect.ts — reconnect loop, demand-based connection
 *   adapter.ts   — adapter init, HCI helpers
 *   state.ts     — shared mutable state, stats, noble reference
 */

// Types
export type { DeviceMode, PiCharacteristic, DiscoveredDevice, BleConnectionEvent } from './types.js';

// State & adapter
export { bleStats, getAdapterState, isDemandActive, getConnectionLog } from './state.js';
export { getDevice, getSavedDeviceId, getSavedDeviceName } from './state.js';
export { getSavedDeviceAddress, getSavedAddressType, getSavedConnectable, getSavedServiceUuids, processHasBtCaps } from './state.js';
export { BLE_BUILD_TAG } from './state.js';
export { noble } from './state.js';

// Protocol (write pipeline)
export { sendToBLE, sendRawColor, resetLastSent, setDimmingGamma, getDimmingGamma } from './protocol.js';

// Connection (direct connect + GATT)
export { connectPeripheral, resetHciAdapter, autoConnectSaved, isConnectInProgress, waitForConnectIdle } from './connect.js';

// Scanning (noble async discovery)
export { scanForDevices, getLastScanResults, isScanning } from './scan.js';

// Device persistence (save / forget)
export { selectDevice, forgetDevice, saveManualDevice } from './save.js';

// Reconnection & demand
export { requestConnect, releaseDemand, startReconnectLoop } from './reconnect.js';

// ── Convenience / legacy aliases ──
import { getDevice, setDevice, isDemandActive } from './state.js';
import { stopKeepAlive, resetLastSent } from './protocol.js';
import { autoConnectSaved, resetHciAdapter } from './connect.js';

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

/**
 * Disconnect current BLE device.
 * @param releaseHci  When true (default for manual disconnects without demand),
 *                    also frees the HCI socket so the adapter is clean.
 *                    When false (engine still wants the device), keep noble's
 *                    socket so reconnect can fire immediately.
 */
export async function disconnect(releaseHci?: boolean): Promise<void> {
  stopKeepAlive();
  const d = getDevice();
  if (d) {
    try { await d.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
    console.log('[BLE] Disconnected');
  }
  // Default: släpp HCI om det inte finns aktiv demand (motorn vill inte ha enheten)
  const shouldRelease = releaseHci ?? !isDemandActive();
  if (shouldRelease) {
    try { await resetHciAdapter(); } catch {}
    console.log('[BLE] HCI socket released');
  }
}

export const disconnectAll = disconnect;
export const scanAndConnect = autoConnectSaved;
export function setExpectedDeviceCount(_n: number): void { /* no-op */ }

// Adapter init runs automatically when adapter.ts is imported
import './adapter.js';
