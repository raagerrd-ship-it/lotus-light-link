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
export { workaroundCounters } from './state.js';
export { waitForFirstStateChange, getBleBootStartedAt, getFirstStateChangeAt, hasNobleEverFiredStateChange } from './state.js';
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

// Master switch
export { isBleEnabled, setBleEnabled, wasEnabledBeforeRestart, getEnabledSource, getEnabledChangedAt } from './enabled.js';
export type { EnabledSource } from './enabled.js';

// Adapter wake-up (used by master switch ON)
export { ensureAdapterUp, waitForNoblePoweredOn } from './adapter.js';

// Heartbeat — löpande statusloggning
export { startBleHeartbeat, stopBleHeartbeat } from './heartbeat.js';

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
 * @param releaseHci  When true, also reset the HCI adapter (manual recovery
 *                    from a wedged noble state). Default: false — noble keeps
 *                    its HCI socket so the next scan/connect is instant.
 */
export async function disconnect(releaseHci: boolean = false): Promise<void> {
  stopKeepAlive();
  const d = getDevice();
  if (d) {
    try { await d.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
    console.log('[BLE] Disconnected');
  }
  if (releaseHci) {
    try { await resetHciAdapter(); } catch {}
    console.log('[BLE] HCI socket released (manual)');
  }
}

export const disconnectAll = disconnect;
export const scanAndConnect = autoConnectSaved;
export function setExpectedDeviceCount(_n: number): void { /* no-op */ }

// Adapter init runs automatically when adapter.ts is imported
import './adapter.js';
