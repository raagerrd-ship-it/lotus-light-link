/**
 * BLE master switch — manual enable/disable.
 *
 * Default: OFF after every boot. The user explicitly turns BLE on from the
 * mobile UI (POST /api/ble/start). Until then, no scan, no auto-connect,
 * no demand-driven reconnects fire — noble stays dormant and the HCI
 * adapter is never touched.
 *
 * This mirrors what the working isolated noble one-liner does: load the
 * library, then wait for an explicit signal from the user before doing
 * anything that could race noble's startup state machine.
 */

import { logConnectionEvent } from './state.js';

let _enabled = false;

export function isBleEnabled(): boolean {
  return _enabled;
}

export function setBleEnabled(value: boolean): void {
  if (_enabled === value) return;
  _enabled = value;
  logConnectionEvent({
    type: 'connect_start',
    detail: `BLE master switch → ${value ? 'ON' : 'OFF'}`,
  });
  console.log(`[BLE] master switch: ${value ? 'ON' : 'OFF'}`);
}
