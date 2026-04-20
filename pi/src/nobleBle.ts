/**
 * Backward-compat shim. Legacy scan/select/forget/reconnect/watchdog är
 * borta; det enda riktiga BLE-flödet är connect-hardcoded + engine-start-minimal.
 * De gamla namnen exporteras här som no-ops så configServer.ts kompilerar
 * utan att vi behöver riva alla legacy-endpoints i samma loop.
 */

export {
  bleStats, BLE_BUILD_TAG, noble, hasNobleLoaded,
  setDimmingGamma, getDimmingGamma, sendRawColor,
  getMinWriteIntervalMs, setMinWriteIntervalMs,
  getDevice, isDemandActive, logConnectionEvent,
  getSubsystemState, getAllSubsystemStates,
} from './ble/index.js';

import { getDevice as _getDevice, bleStats as _bleStats } from './ble/index.js';
import { disconnectHardcoded, getHardcodedConnected, HARDCODED_DEVICE } from './ble/index.js';

// ── Legacy no-op exports — alla endpoints som använde dem är dead i UI:t ──
export function getConnectedCount(): number {
  return getHardcodedConnected().connected ? 1 : 0;
}
export function getConnectedNames(): string[] {
  const c = getHardcodedConnected();
  return c.connected ? [c.name] : [];
}
export function getConnectedDeviceId(): string | null {
  return getHardcodedConnected().connected ? HARDCODED_DEVICE.mac.replace(/:/g, '').toLowerCase() : null;
}
export async function scanForDevices(_timeoutMs?: number) { return []; }
export async function selectDevice(_id: string): Promise<boolean> { return false; }
export async function forgetDevice(): Promise<void> { /* no-op */ }
export async function saveManualDevice(_addr: string, _name: string): Promise<boolean> { return false; }
export function getLastScanResults() { return []; }
export function getSavedDeviceId(): string | null { return null; }
export function getSavedDeviceName(): string | null { return null; }
export function getSavedDeviceAddress(): string | null { return null; }
export function getSavedAddressType(): string | null { return null; }
export function getSavedConnectable(): boolean | null { return null; }
export function getSavedServiceUuids(): string[] | null { return null; }
export function isScanning(): boolean { return false; }
export async function requestConnect(): Promise<void> { /* legacy no-op — använd /api/ble/connect */ }
export function releaseDemand(): void { /* no-op */ }
export function getAdapterState(): string | undefined { return getHardcodedConnected().connected ? 'poweredOn' : undefined; }
export function getConnectionLog() { return []; }
export function processHasBtCaps(): boolean { return true; }
export function isConnectInProgress(): boolean { return false; }
export async function resetHciAdapter(): Promise<void> { /* no-op — bluetoothd äger hci0 */ }
export async function disconnect(_releaseHci?: boolean): Promise<void> {
  await disconnectHardcoded();
}
export async function disconnectAll(_releaseHci?: boolean): Promise<void> {
  await disconnectHardcoded();
}
export async function autoConnectSaved(_timeoutMs?: number): Promise<number> { return 0; }
export async function waitForFirstStateChange(_ms?: number): Promise<string> { return 'unknown'; }
export function getBleBootStartedAt(): number { return Date.now(); }
export function getFirstStateChangeAt(): number | null { return null; }
export function hasNobleEverFiredStateChange(): boolean { return false; }
export function getScanMetrics() {
  return {
    phase: 'idle' as const, active: false, activeSince: null,
    lastScanId: 0, lastStartedAt: null, lastStartOkAt: null, lastStoppedAt: null,
    lastDurationMs: null, lastRawDiscoverCount: 0, lastResultCount: 0,
    lastStartError: null, lastStopError: null, lastWatchdogAt: null, hcitool: null,
  };
}
export function getBootPhase(): string { return 'ready'; }
export async function ensureAdapterUp(): Promise<boolean> { return true; }
export const workaroundCounters = { lastInvocationAt: {} as Record<string, string> };
export function bumpWorkaround(_k: string): void { /* no-op */ }
export function getHciProbeSnapshot() { return null; }
export function getForceMutationSnapshot() { return null; }
export function getWatchdogGiveUpReason(): string | null { return null; }
