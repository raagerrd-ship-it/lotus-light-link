/**
 * BLE master switch — manuell enable/disable, persisterad över omstart.
 *
 * Tidigare: default OFF efter varje boot. Användaren fick alltid trycka på
 * BLE-radio-knappen efter en omstart, vilket var irriterande på Pi:n som
 * normalt ska köra autonomt.
 *
 * Nu: senaste enabled-state persisteras i storage (`ble-master-enabled`).
 * Vid boot:
 *   1. Vi laddar persisted state men håller `_enabled = false` tills noble
 *      faktiskt är poweredOn (annars triggar reconnect-loopen scan på en
 *      adapter som inte vaknat → wedged state).
 *   2. När noble fyrar `stateChange = poweredOn` ÄR det säkert att slå på
 *      master-switchen automatiskt om användaren tidigare hade den på.
 *   3. autoEnableIfPersisted() i index.ts gör steg 2 efter
 *      waitForFirstStateChange().
 */

import { logConnectionEvent } from './state.js';
import { getItem, setItem } from '../storage.js';

const STORAGE_KEY = 'ble-master-enabled';

let _enabled = false;

/** True om användaren senast hade BLE-radion PÅ före omstart. */
export function wasEnabledBeforeRestart(): boolean {
  return getItem(STORAGE_KEY) === 'true';
}

export function isBleEnabled(): boolean {
  return _enabled;
}

/**
 * @param value      ny state
 * @param persist    true (default) → spara i storage så det överlever
 *                   omstart. Sätt false vid auto-restore vid boot för att
 *                   undvika onödiga skrivningar.
 */
export function setBleEnabled(value: boolean, persist: boolean = true): void {
  if (_enabled === value) {
    if (persist) setItem(STORAGE_KEY, value ? 'true' : 'false');
    return;
  }
  _enabled = value;
  if (persist) setItem(STORAGE_KEY, value ? 'true' : 'false');
  logConnectionEvent({
    type: 'connect_start',
    detail: `BLE master switch → ${value ? 'ON' : 'OFF'}${persist ? '' : ' (auto-restore)'}`,
  });
  console.log(`[BLE] master switch: ${value ? 'ON' : 'OFF'}${persist ? '' : ' (auto-restore vid boot)'}`);
}
