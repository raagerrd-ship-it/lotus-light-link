/**
 * BLE shared state — slim variant for the hardcoded-only flow.
 *
 * Allt scan/select/forget/demand/watchdog-state är borta. UI använder
 * bara /api/ble/engine/start, /api/ble/connect, /api/ble/disconnect,
 * /api/ble/state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noble, hasNobleLoaded } from './noble-singleton.js';
import type { ConnectedDevice } from './types.js';
import { dlog } from "../debugLog.js";
import { DATA_DIR } from '../storage.js';
export { hasNobleLoaded, noble };

export const SERVICE_UUID = 'fff0';
export const CHAR_UUID = 'fff3';

export const BLE_BUILD_TAG = '2026-05-03/process-exit-on-consecutive-failures';
dlog(`[BLE] build tag: ${BLE_BUILD_TAG}`);

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
// ── Subsystem transition log (ringbuffer för diagnostik) ──
// Loggar varje state-byte (idle/starting/ready/error) med tid + ev. error.
// Syfte: när användaren tvingas trycka "Starta allt" igen kan vi se EXAKT
// vilket subsystem som föll bort och varför, utan att behöva journalctl.
export interface SubsystemTransition {
  ts: string;            // ISO-timestamp
  id: SubsystemId;
  from: SubsystemStatus;
  to: SubsystemStatus;
  error: string | null;  // bara satt vid → 'error'
  uptimeMs: number | null; // hur länge subsystemet varit 'ready' innan fall
}
const _transitions: SubsystemTransition[] = [];
const MAX_TRANSITIONS = 50;
const TRANSITION_LOG_FILE = join(DATA_DIR, 'subsystem-transitions.json');

function _loadTransitionsFromDisk(): void {
  try {
    if (!existsSync(TRANSITION_LOG_FILE)) return;
    const parsed = JSON.parse(readFileSync(TRANSITION_LOG_FILE, 'utf-8'));
    if (Array.isArray(parsed?.entries)) {
      _transitions.splice(0, _transitions.length, ...parsed.entries.slice(-MAX_TRANSITIONS));
    }
  } catch (e: any) {
    console.warn(`[Subsystem] kunde inte läsa transition-logg: ${e?.message ?? e}`);
  }
}

function _saveTransitionsToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TRANSITION_LOG_FILE, JSON.stringify({ entries: _transitions.slice(-MAX_TRANSITIONS) }, null, 2), 'utf-8');
  } catch (e: any) {
    console.warn(`[Subsystem] kunde inte skriva transition-logg: ${e?.message ?? e}`);
  }
}

_loadTransitionsFromDisk();

function _logTransition(id: SubsystemId, from: SubsystemStatus, to: SubsystemStatus, error: string | null, uptimeMs: number | null): void {
  _transitions.push({
    ts: new Date().toISOString(),
    id,
    from,
    to,
    error: error ? error.slice(0, 300) : null,
    uptimeMs,
  });
  if (_transitions.length > MAX_TRANSITIONS) _transitions.splice(0, _transitions.length - MAX_TRANSITIONS);
  _saveTransitionsToDisk();
}

export function getSubsystemTransitions(): SubsystemTransition[] {
  return _transitions.slice();
}

export function markSubsystemStarting(id: SubsystemId): void {
  const prev = _subsystems[id].status;
  _subsystems[id] = { status: 'starting', startedAt: Date.now(), readyAt: null, durationMs: null, error: null };
  _logTransition(id, prev, 'starting', null, null);
  dlog(`[Subsystem] ${id} ${prev} → starting`);
}
export function markSubsystemReady(id: SubsystemId): void {
  const s = _subsystems[id];
  const prev = s.status;
  const startedAt = s.startedAt ?? Date.now();
  const readyAt = Date.now();
  _subsystems[id] = { status: 'ready', startedAt, readyAt, durationMs: readyAt - startedAt, error: null };
  _logTransition(id, prev, 'ready', null, null);
  dlog(`[Subsystem] ${id} ${prev} → ready (${_subsystems[id].durationMs}ms)`);
}
export function markSubsystemError(id: SubsystemId, error: string): void {
  const s = _subsystems[id];
  const prev = s.status;
  const startedAt = s.startedAt ?? Date.now();
  // Om vi var 'ready' → räkna uptime från readyAt så vi ser hur länge det höll
  const uptimeMs = s.readyAt ? Date.now() - s.readyAt : null;
  _subsystems[id] = { status: 'error', startedAt, readyAt: null, durationMs: Date.now() - startedAt, error };
  _logTransition(id, prev, 'error', error, uptimeMs);
  console.error(`[Subsystem] ${id} ${prev} → error${uptimeMs != null ? ` (efter ${Math.round(uptimeMs/1000)}s ready)` : ''}: ${error}`);
}
export function resetSubsystem(id: SubsystemId): void {
  const prev = _subsystems[id].status;
  const uptimeMs = _subsystems[id].readyAt ? Date.now() - _subsystems[id].readyAt! : null;
  _subsystems[id] = { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null };
  if (prev !== 'idle') {
    _logTransition(id, prev, 'idle', null, uptimeMs);
    console.warn(`[Subsystem] ${id} ${prev} → idle (reset)${uptimeMs != null ? ` efter ${Math.round(uptimeMs/1000)}s` : ''}`);
  }
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
  outstandingMaxObserved: 0,  // high-water mark sedan engine-start (post-deploy signal: nådde gaten taket?)
  outstandingAgeMs: 0,        // hur länge senaste observerade outstanding-paket varit ute
  // adaptiveReleaseAlphaMax borttagen 2026-05-04 — adaptive release-boost slopad
  slotLeaseMs: 0,              // mirror av aktuell setSlotLeaseMs() — synlig effektiv lease
  lastStuckReason: null as string | null,
  tickOkCount: 0,
  tickAbortNoMicCount: 0,
  tickAbortBleBusyCount: 0,
  tickAbortBleRateLimitCount: 0,
  tickAbortNoChangeCount: 0,
  tickAbortNoDeviceCount: 0,
  deadbandBlockedCount: 0,        // anti-flicker deadband held last value (no write generated)
  tickSkippedBleBusyCount: 0,     // pre-gate: tick hoppades över FÖRE beräkning pga BLE busy (sparad CPU)
  dropCount: 0,                   // antal detekterade drops (lång-horisont bas-explosion → vit punch)

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

