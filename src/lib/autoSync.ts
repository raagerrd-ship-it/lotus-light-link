/**
 * Auto-sync: minimal stub after removing curve-based sync.
 * Keeps the exported API so other code doesn't break,
 * but drift is always 0 (mic mode only).
 */

export interface AutoSyncState {
  driftMs: number;
  correlations: number;
  confidence: number;
}

export function resetAutoSync() {}

export function getAutoSyncState(): AutoSyncState {
  return { driftMs: 0, correlations: 0, confidence: 0 };
}

export function getAutoSyncDriftMs(): number {
  return 0;
}

export function setAutoSyncPaused(_paused: boolean) {}

export function tickAutoSync() {}
