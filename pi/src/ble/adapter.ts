/**
 * BLE adapter management — HCI socket arbitration between noble and bluetoothctl.
 *
 * Key constraint: noble and bluetoothctl cannot use the HCI socket simultaneously.
 * This module provides helpers to switch between the two cleanly.
 */

import { execFileSync } from 'child_process';
import { noble, getAdapterState, setNobleHciReleased, logConnectionEvent } from './state.js';

/** Kill any bluetoothctl scan so noble can use HCI */
export function stopBluetoothctl(): void {
  try {
    execFileSync('bash', ['-lc', 'bluetoothctl scan off >/dev/null 2>&1 || true'], { timeout: 2000, stdio: 'ignore' });
  } catch {}
}

/** Force noble to fully release HCI so bluetoothctl can use the adapter */
export function stopNoble(): void {
  try { noble.stopScanning(); } catch {}
  try {
    const bindings = (noble as any)._bindings;
    if (bindings?._hci?.stop) {
      bindings._hci.stop();
      setNobleHciReleased(true);
      logConnectionEvent({ type: 'scan_start', detail: 'noble HCI released for bluetoothctl' });
    }
  } catch {}
}

/** Re-initialize noble's HCI binding after it was stopped for bluetoothctl */
export async function restartNobleHci(deviceName?: string): Promise<void> {
  stopBluetoothctl();
  await new Promise(r => setTimeout(r, 300));

  try {
    setNobleHciReleased(false);
    const bindings = (noble as any)._bindings;
    if (bindings?._hci?.start) {
      bindings._hci.start();
      logConnectionEvent({ type: 'connect_start', device: deviceName, detail: 'noble HCI re-initialized' });
    }
  } catch {}
  await new Promise(r => setTimeout(r, 300));
}

/** Wait for adapter to reach poweredOn state (up to ~5s) */
export async function waitForAdapter(deviceName?: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    if (getAdapterState() === 'poweredOn') return true;
    if (i === 9) {
      logConnectionEvent({ type: 'connect_fail', device: deviceName, detail: `Adapter not ready: ${getAdapterState()}` });
      return false;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/** Force Bluetooth adapter up via rfkill/hciconfig (for auto-reconnect) */
export function ensureAdapterUp(): void {
  try {
    execFileSync('bash', ['-lc', 'rfkill unblock bluetooth >/dev/null 2>&1 || true; (command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1) || true'], { timeout: 4000, stdio: 'ignore' });
  } catch {}
}

/** Normalize a BLE identifier (MAC, UUID, id) to lowercase hex without colons */
export function normalizeBleKey(value: string | null | undefined): string {
  return (value ?? '').replace(/:/g, '').toLowerCase();
}
