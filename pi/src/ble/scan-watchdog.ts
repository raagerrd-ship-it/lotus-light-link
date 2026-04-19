/**
 * BLE scan watchdog — frigör scan-flaggan om noble fastnar i
 * startScanningAsync/stopScanningAsync.
 *
 * Armas FÖRST efter att noble nått poweredOn — annars skulle väntan på
 * stateChange (upp till 10s) räknas in i watchdog-fönstret och tvångsstoppa
 * en scan som ännu inte börjat (bug 2026-04-19).
 */

import { logConnectionEvent } from './state.js';
import { scanMetrics } from './scan-metrics.js';

export interface ScanWatchdogHandle {
  cancel: () => void;
}

export interface ArmScanWatchdogOptions {
  timeoutMs: number;            // den faktiska scan-fönsterlängden
  scanStartedAt: number;        // Date.now() då scanForDevices anropades
  isScanning: () => boolean;    // läs scanning-flaggan
  releaseScanFlag: () => void;  // sätt scanning=false
  getFoundCount: () => number;  // antal unika devices hittills
}

/**
 * Armerar watchdog-timern. Returnerar handle med .cancel() för clearTimeout.
 * Triggers efter timeoutMs + 5000ms — ger noble 5s slack på själva scanen.
 */
export function armScanWatchdog(opts: ArmScanWatchdogOptions): ScanWatchdogHandle {
  const { timeoutMs, scanStartedAt, isScanning, releaseScanFlag, getFoundCount } = opts;
  const fireAfterMs = timeoutMs + 5000;

  const handle = setTimeout(() => {
    if (!isScanning()) return;
    releaseScanFlag();
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastResultCount = getFoundCount();
    scanMetrics.lastWatchdogAt = new Date().toISOString();
    logConnectionEvent({
      type: 'scan_done',
      detail: `Watchdog tvångsfrigjorde scan-flaggan efter ${fireAfterMs}ms`,
    });
  }, fireAfterMs);

  return { cancel: () => clearTimeout(handle) };
}
