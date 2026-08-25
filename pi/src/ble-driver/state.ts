/**
 * BLE-core-state för lampdrivern — connected device + stats + konstanter.
 *
 * (Subsystem-tracking + transition-logg är app-specifikt och ligger i
 * pi/src/ble/subsystem-state.ts, utanför den portabla drivern.)
 */

import { noble, hasNobleLoaded } from './noble-singleton.js';
import type { ConnectedDevice } from './types.js';
import { dlog } from './log.js';
export { hasNobleLoaded, noble };

export const SERVICE_UUID = 'fff0';
export const CHAR_UUID = 'fff3';

export const BLE_BUILD_TAG = '2026-05-03/process-exit-on-consecutive-failures';
dlog(`[BLE] build tag: ${BLE_BUILD_TAG}`);

// ── Connected device ──
let _device: ConnectedDevice | null = null;
export function getDevice(): ConnectedDevice | null { return _device; }
export function setDevice(d: ConnectedDevice | null): void { _device = d; }

// ── Stats (used by protocol.ts + /api/ble/output + /api/mic/level) ──
export const bleStats = {
  sentCount: 0,

  skipBusyCount: 0,           // total busy (lease ELLER controller-outstanding)
  skipInFlightCount: 0,       // legacy: writePending
  skipLeaseLockedCount: 0,    // busy pga tick-lease ej utgången
  skipControllerBusyCount: 0, // busy pga outstanding paket i HCI
  writeFailCount: 0,
  writeStallReleaseCount: 0,  // writeAsync hängde >150ms → sloten släpptes (icke-blockerande recovery)
  connIntervalReassertCount: 0, // antal gånger conn-interval tvingats om (hcitool lecup)
  controllerCompleteCount: 0, // antal gånger drain gått från >0 → 0
  controllerStuckCount: 0,    // drain-diagnostik fastnat längre än threshold
  controllerOutstandingCount: 0, // aktuellt antal outstanding paket i noble/HCI
  outstandingMaxObserved: 0,  // high-water mark sedan engine-start (post-deploy signal: nådde gaten taket?)
  outstandingAgeMs: 0,        // hur länge senaste observerade outstanding-paket varit ute
  // adaptiveReleaseAlphaMax borttagen 2026-05-04 — adaptive release-boost slopad
  slotLeaseMs: 0,             // mirror av aktuell setSlotLeaseMs() — synlig effektiv lease
  lastStuckReason: null as string | null,
  tickOkCount: 0,
  tickAbortNoMicCount: 0,
  tickAbortBleBusyCount: 0,
  tickAbortNoChangeCount: 0,
  tickAbortNoDeviceCount: 0,
  deadbandBlockedCount: 0,        // anti-flicker deadband held last value (no write generated)
  dropCount: 0,                   // antal detekterade drops (lång-horisont bas-explosion → vit punch)

  writeSyncMaxMs: 0,          // längsta SYNKRONA tid i native writeAsync (event-loop-blockering)
  writeSyncSlowCount: 0,      // antal writes där den synkrona delen tog >50ms

  writeLatMs: 0,
  writeLatAvgMs: 0,
  writeLatMaxMs: 0,

  disconnectCount: 0,
  lastDisconnectAt: null as string | null,

  requestedIntervalMs: '—' as string,
  intervalSource: 'unknown' as string,
};
