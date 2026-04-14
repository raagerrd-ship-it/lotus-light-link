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

// Protocol (write pipeline)
export { sendToBLE, sendRawColor, resetLastSent, setDimmingGamma, getDimmingGamma } from './protocol.js';

// Connection
export { connectPeripheral, resetHciAdapter } from './connection.js';

// Scanning
export { scanForDevices, selectDevice, forgetDevice, autoConnectSaved, getLastScanResults, isScanning } from './scan.js';

// Reconnection & demand
export { requestConnect, releaseDemand, startReconnectLoop } from './reconnect.js';

// ── Convenience / legacy aliases ──
import { getDevice, setDevice } from './state.js';
import { stopKeepAlive, resetLastSent } from './protocol.js';
import { autoConnectSaved } from './scan.js';

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

// ── Startup diagnostics ──
import { getAdapterState, noble, logConnectionEvent } from './state.js';

const initState = getAdapterState();
if (initState === 'unauthorized') {
  console.error('[BLE] Adapter state: unauthorized — PCC-tjänsten saknar AmbientCapabilities (CAP_NET_RAW + CAP_NET_ADMIN).');
} else if (initState === 'poweredOff') {
  console.warn('[BLE] Adapter state: poweredOff — Bluetooth är avstängt eller rfkill-blockerat.');
} else if (initState === 'poweredOn') {
  console.log('[BLE] Adapter state: poweredOn ✓');
} else {
  console.log(`[BLE] Adapter state at init: ${initState ?? 'unknown'} — waiting for stateChange event`);
  noble.once('stateChange', (state: string) => {
    logConnectionEvent({ type: 'connect_start', detail: `Adapter state changed: ${state}` });
  });
}
