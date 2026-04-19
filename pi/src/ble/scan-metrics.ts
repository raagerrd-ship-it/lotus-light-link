/**
 * BLE scan metrics — single source of truth for scan-state observability.
 *
 * Konsumeras av configServer (/api/ble/diagnostics) och UI:t. Hålls separat
 * från själva scan-loopen så det är trivialt att läsa/uppdatera utan att
 * blanda in noble-detaljer.
 */

export interface BleScanMetrics {
  phase: 'idle' | 'starting' | 'scanning' | 'stopping';
  active: boolean;
  activeSince: string | null;
  lastScanId: number;
  lastStartedAt: string | null;
  lastStartOkAt: string | null;
  lastStoppedAt: string | null;
  lastDurationMs: number | null;
  lastRawDiscoverCount: number;
  lastResultCount: number;
  lastStartError: string | null;
  lastStopError: string | null;
  lastWatchdogAt: string | null;
  // Behålls för backward-compat med UI:t men sätts alltid till null nu.
  hcitool: null;
}

let _scanSeq = 0;

export const scanMetrics: BleScanMetrics = {
  phase: 'idle',
  active: false,
  activeSince: null,
  lastScanId: 0,
  lastStartedAt: null,
  lastStartOkAt: null,
  lastStoppedAt: null,
  lastDurationMs: null,
  lastRawDiscoverCount: 0,
  lastResultCount: 0,
  lastStartError: null,
  lastStopError: null,
  lastWatchdogAt: null,
  hcitool: null,
};

export function getScanMetrics(): BleScanMetrics {
  return { ...scanMetrics };
}

export function nextScanId(): number {
  return ++_scanSeq;
}

/** Återställ metrics i början av en ny scan-körning. */
export function resetMetricsForNewScan(scanStartedAt: number, scanId: number): void {
  scanMetrics.phase = 'starting';
  scanMetrics.active = true;
  scanMetrics.activeSince = new Date(scanStartedAt).toISOString();
  scanMetrics.lastScanId = scanId;
  scanMetrics.lastStartedAt = new Date(scanStartedAt).toISOString();
  scanMetrics.lastStartOkAt = null;
  scanMetrics.lastStoppedAt = null;
  scanMetrics.lastDurationMs = null;
  scanMetrics.lastRawDiscoverCount = 0;
  scanMetrics.lastResultCount = 0;
  scanMetrics.lastStartError = null;
  scanMetrics.lastStopError = null;
  scanMetrics.hcitool = null;
}

/** Markera scan som avslutad (success eller error). */
export function finalizeMetrics(scanStartedAt: number, resultCount: number): void {
  scanMetrics.phase = 'idle';
  scanMetrics.active = false;
  scanMetrics.activeSince = null;
  if (!scanMetrics.lastStoppedAt) scanMetrics.lastStoppedAt = new Date().toISOString();
  if (scanMetrics.lastDurationMs == null) scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
  scanMetrics.lastResultCount = resultCount;
}
