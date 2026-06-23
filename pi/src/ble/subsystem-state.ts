/**
 * Subsystem-state-tracking (mic + sonos + engine) + transition-logg.
 *
 * App-specifikt (inte BLE-styrning) — flyttat ut ur den portabla
 * ble-driver/state.ts. Loggar varje state-byte med tid + ev. error så vi kan
 * se exakt vilket subsystem som föll bort utan journalctl.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dlog } from '../debugLog.js';
import { DATA_DIR } from '../storage.js';

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
