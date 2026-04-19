/**
 * BLE scanning — hcitool-only discovery.
 *
 * Noble's startScanningAsync hangs on Raspberry Pi (även när poweredOn rapporteras),
 * så vi använder hcitool lescan direkt mot HCI för discovery. Noble används bara
 * för connect/GATT efteråt. Innan hcitool startar släpper vi noble's HCI-binding
 * så hcitool får tillgång till sockeln.
 */

import { getAdapterState, logConnectionEvent, getNobleRawState, bumpWorkaround } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { hcitoolLescan } from './hcitool-scan.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

// Cache av peripheral-objekt indexerat på normaliserat id (lowercase, utan kolon).
const discoveredPeripherals = new Map<string, any>();

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
  /** Hybrid hcitool lescan stats from the most recent scan */
  hcitool: {
    enabled: boolean;
    deviceCount: number;
    rawLineCount: number;
    exitCode: number | null;
    startError: string | null;
    stderr: string;
    durationMs: number;
  } | null;
}

let _scanSeq = 0;
const scanMetrics: BleScanMetrics = {
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

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }
export function getScanMetrics(): BleScanMetrics { return { ...scanMetrics }; }
export function getDiscoveredPeripheral(id: string): any | undefined {
  return discoveredPeripherals.get(id.toLowerCase());
}




export async function scanForDevices(timeoutMs = 3000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — scan already running' });
    return lastScanResults;
  }
  if (isNobleScanActive()) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — noble scan-connect is active (would lock HCI)' });
    return lastScanResults;
  }

  scanning = true;
  discoveredPeripherals.clear();
  const found = new Map<string, DiscoveredDevice>();
  const scanStartedAt = Date.now();
  const scanId = ++_scanSeq;
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

  const watchdog = setTimeout(() => {
    if (scanning) {
      scanning = false;
      scanMetrics.phase = 'idle';
      scanMetrics.active = false;
      scanMetrics.activeSince = null;
      scanMetrics.lastStoppedAt = new Date().toISOString();
      scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
      scanMetrics.lastResultCount = found.size;
      scanMetrics.lastWatchdogAt = new Date().toISOString();
      logConnectionEvent({
        type: 'scan_done',
        detail: `Watchdog tvångsfrigjorde scan-flaggan efter ${timeoutMs + 5000}ms`,
      });
    }
  }, timeoutMs + 5000);

  try {
    logConnectionEvent({
      type: 'scan_start',
      detail: `hcitool-only discovery (parallel mode), timeout=${timeoutMs}ms, adapter=${getAdapterState()}, raw=${getNobleRawState() ?? 'unknown'}`,
    });

    // Steg 1: Bara säkerställ att adaptern är UP. Noble's HCI-binding rörs INTE
    // — hcitool's lescan kan köra parallellt med noble eftersom båda öppnar
    // separata raw HCI-socklar (kräver CAP_NET_RAW, vilket vi sätter på båda
    // i setup-lotus.sh). Att stoppa noble bröt mot hci-up-only-policyn och
    // gjorde att hcitool fick 0 devices (adaptern fastnade i mellanläge).
    try {
      const { runShellScript } = await import('./sysExec.js');
      runShellScript(
        'rfkill unblock bluetooth >/dev/null 2>&1 || true; ' +
        'hciconfig hci0 up >/dev/null 2>&1 || true',
        { timeoutMs: 3000 }
      );
      logConnectionEvent({ type: 'scan_start', detail: 'hci0 up (no down/reset, noble untouched)' });
    } catch (e: any) {
      logConnectionEvent({ type: 'scan_start', detail: `hci up warning: ${e?.message ?? e}` });
    }

    scanMetrics.phase = 'scanning';
    scanMetrics.lastStartOkAt = new Date().toISOString();

    // Steg 2: Kör scan-helper i en SUBPROCESS (utan noble).
    // Helpern öppnar en egen HCI raw socket parallellt med noble.
    const hres = await hcitoolLescan(timeoutMs);

    // Inget post-scan recovery behövs — noble's binding rördes aldrig.
    bumpWorkaround('post_scan_noble_untouched');

    // Merge results into found-map.
    for (const d of hres.devices) {
      found.set(d.id, { ...d, source: 'hcitool' });
    }
    scanMetrics.hcitool = {
      enabled: true,
      deviceCount: hres.devices.length,
      rawLineCount: hres.rawLineCount,
      exitCode: hres.exitCode,
      startError: hres.startError,
      stderr: hres.stderr.slice(0, 500),
      durationMs: hres.durationMs,
    };

    scanMetrics.phase = 'stopping';
    lastScanResults = Array.from(found.values()).sort((a, b) => b.rssi - a.rssi);
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastResultCount = lastScanResults.length;

    if (lastScanResults.length === 0) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `0 devices via hcitool — raw_lines=${hres.rawLineCount}, exit=${hres.exitCode}, stderr="${hres.stderr.slice(0, 200) || 'none'}", startErr="${hres.startError ?? 'none'}"`,
      });
    } else {
      logConnectionEvent({
        type: 'scan_done',
        detail: `${lastScanResults.length} device(s) via hcitool (raw_lines=${hres.rawLineCount})`,
      });
    }

    return lastScanResults;
  } catch (e: any) {
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastStartError = e?.message ?? String(e);
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e?.message ?? e}` });
    console.error(`[BLE] scan error: ${e?.message ?? e}`);
    return lastScanResults;
  } finally {
    clearTimeout(watchdog);
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    if (!scanMetrics.lastStoppedAt) scanMetrics.lastStoppedAt = new Date().toISOString();
    if (scanMetrics.lastDurationMs == null) scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastResultCount = lastScanResults.length;
    scanning = false;
  }
}
