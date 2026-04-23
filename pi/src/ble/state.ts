/**
 * BLE shared state — slim variant for the hardcoded-only flow.
 *
 * Allt scan/select/forget/demand/watchdog-state är borta. UI använder
 * bara /api/ble/engine/start, /api/ble/connect, /api/ble/disconnect,
 * /api/ble/state.
 */

import { noble, hasNobleLoaded } from './noble-singleton.js';
import type { ConnectedDevice, BleConnectionEvent } from './types.js';
export { hasNobleLoaded, noble };

export const SERVICE_UUID = 'fff0';
export const CHAR_UUID = 'fff3';
const MAX_EVENTS = 200;

export const BLE_BUILD_TAG = '2026-04-23/drain-live-read';
console.log(`[BLE] build tag: ${BLE_BUILD_TAG}`);

// ── Subsystem state (mic + sonos + engine — bleEngine borttaget) ──
export type SubsystemId = 'mic' | 'sonos' | 'engine';
export type SubsystemStatus = 'idle' | 'starting' | 'ready' | 'error';
export interface SubsystemState {
  status: SubsystemStatus;
  startedAt: number | null;
  readyAt: number | null;
  durationMs: number | null;
  error: string | null;
}
const _subsystems: Record<SubsystemId, SubsystemState> = {
  mic:    { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null },
  sonos:  { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null },
  engine: { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null },
};
export function getSubsystemState(id: SubsystemId): SubsystemState { return { ..._subsystems[id] }; }
export function getAllSubsystemStates(): Record<SubsystemId, SubsystemState> {
  return {
    mic:    { ..._subsystems.mic },
    sonos:  { ..._subsystems.sonos },
    engine: { ..._subsystems.engine },
  };
}
export function markSubsystemStarting(id: SubsystemId): void {
  _subsystems[id] = { status: 'starting', startedAt: Date.now(), readyAt: null, durationMs: null, error: null };
  console.log(`[Subsystem] ${id} → starting`);
}
export function markSubsystemReady(id: SubsystemId): void {
  const s = _subsystems[id];
  const startedAt = s.startedAt ?? Date.now();
  const readyAt = Date.now();
  _subsystems[id] = { status: 'ready', startedAt, readyAt, durationMs: readyAt - startedAt, error: null };
  console.log(`[Subsystem] ${id} → ready (${_subsystems[id].durationMs}ms)`);
}
export function markSubsystemError(id: SubsystemId, error: string): void {
  const s = _subsystems[id];
  const startedAt = s.startedAt ?? Date.now();
  _subsystems[id] = { status: 'error', startedAt, readyAt: null, durationMs: Date.now() - startedAt, error };
  console.error(`[Subsystem] ${id} → error: ${error}`);
}
export function resetSubsystem(id: SubsystemId): void {
  _subsystems[id] = { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null };
}

// ── Connected device ──
let _device: ConnectedDevice | null = null;
export function getDevice(): ConnectedDevice | null { return _device; }
export function setDevice(d: ConnectedDevice | null): void { _device = d; }

// Legacy demand-flag — alltid false i hardcoded-flödet (protocol.ts har en
// proaktiv reconnect-gren bakom denna flagga som aldrig ska triggas nu).
export function isDemandActive(): boolean { return false; }

// ── Stats (used by protocol.ts + /api/ble/output + /api/mic/level) ──
export const bleStats = {
  sentCount: 0,
  skipDeltaCount: 0,
  skipBusyCount: 0,           // total busy (lease ELLER controller-outstanding)
  skipInFlightCount: 0,       // legacy: writePending
  skipLeaseLockedCount: 0,    // busy pga tick-lease ej utgången
  skipControllerBusyCount: 0, // busy pga outstanding paket i HCI
  skipRateLimitCount: 0,
  fftDroppedCount: 0,
  writeFailCount: 0,
  writeStuckCount: 0,
  controllerCompleteCount: 0, // antal gånger drain gått från >0 → 0
  controllerStuckCount: 0,    // drain-diagnostik fastnat längre än threshold
  controllerOutstandingCount: 0, // aktuellt antal outstanding paket i noble/HCI
  outstandingAgeMs: 0,        // hur länge senaste observerade outstanding-paket varit ute
  lastStuckReason: null as string | null,
  tickOkCount: 0,
  tickAbortNoMicCount: 0,
  tickAbortBleBusyCount: 0,
  tickAbortBleRateLimitCount: 0,
  tickAbortNoChangeCount: 0,
  tickAbortNoDeviceCount: 0,

  writeLatMs: 0,
  writeLatAvgMs: 0,
  writeLatMaxMs: 0,
  effectiveIntervalMs: 0,

  disconnectCount: 0,
  reconnectCount: 0,
  lastDisconnectReason: null as string | null,
  lastDisconnectAt: null as string | null,

  requestedIntervalMs: '—' as string,
  actualIntervalMs: '—' as string,
  intervalSource: 'unknown' as string,
};

// ── Connection event log (kvar för disconnect-spårning) ──
const _connectionLog: BleConnectionEvent[] = [];
export function logConnectionEvent(event: Omit<BleConnectionEvent, 'timestamp'>): void {
  const entry: BleConnectionEvent = { ...event, timestamp: new Date().toISOString() };
  _connectionLog.push(entry);
  while (_connectionLog.length > MAX_EVENTS) _connectionLog.shift();
  const detail = entry.detail ? ` — ${entry.detail}` : '';
  const dur = entry.durationMs != null ? ` (${entry.durationMs}ms)` : '';
  const dev = entry.device ? ` [${entry.device}]` : '';
  console.log(`[BLE:${entry.type}]${dev}${detail}${dur}`);
}
