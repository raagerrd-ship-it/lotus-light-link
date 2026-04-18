/**
 * BLE scanning — ren noble.
 *
 * Förutsättning: BLE master switch är PÅ. Master-switchen (POST /api/ble/start)
 * är det ENDA stället som väcker adaptern. Scan rör inte HCI själv — om noble
 * inte är poweredOn här så är det användarens jobb att slå på radion eller
 * trycka "Återställ BLE-stack".
 */

import { noble, getAdapterState, logConnectionEvent, getNobleRawState, forceNoblePoweredOn } from './state.js';
import { isAdapterReadyForBleOps, isHci0Up } from './adapter.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { isBleEnabled } from './enabled.js';
import { hcitoolLescan, type HcitoolScanResult } from './hcitool-scan.js';

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

function peripheralToDevice(p: any): DiscoveredDevice | null {
  const id: string | undefined = p?.id ?? p?.uuid ?? p?.address?.replace(/:/g, '').toLowerCase();
  if (!id) return null;
  const adv = p?.advertisement ?? {};
  const rawName: string | undefined = adv?.localName ?? p?.name;
  const name = (rawName && String(rawName).trim()) || `(no-name) ${p?.address ?? id}`;
  const rssi = typeof p?.rssi === 'number' ? p.rssi : -100;
  return { id: String(id).toLowerCase(), name, rssi };
}

export async function scanForDevices(timeoutMs = 10000): Promise<DiscoveredDevice[]> {
  if (!isBleEnabled()) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — BLE master switch is OFF' });
    return lastScanResults;
  }
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
  let rawDiscoverCount = 0;
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

  const watchdog = setTimeout(() => {
    if (scanning) {
      scanning = false;
      scanMetrics.phase = 'idle';
      scanMetrics.active = false;
      scanMetrics.activeSince = null;
      scanMetrics.lastStoppedAt = new Date().toISOString();
      scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
      scanMetrics.lastRawDiscoverCount = rawDiscoverCount;
      scanMetrics.lastResultCount = found.size;
      scanMetrics.lastWatchdogAt = new Date().toISOString();
      logConnectionEvent({
        type: 'scan_done',
        detail: `Watchdog tvångsfrigjorde scan-flaggan efter ${timeoutMs + 5000}ms (noble hängde i start/stop)`,
      });
    }
  }, timeoutMs + 5000);
  const onDiscover = (p: any) => {
    rawDiscoverCount++;
    const dev = peripheralToDevice(p);
    if (!dev) return;
    dev.source = 'noble';
    const prev = found.get(dev.id);
    if (!prev) {
      const adv = p?.advertisement ?? {};
      const svcs = (adv?.serviceUuids ?? []).join(',') || 'none';
      logConnectionEvent({
        type: 'scan_start',
        detail: `Found: ${dev.name} (${p?.address ?? dev.id}) rssi=${dev.rssi} svcs=[${svcs}]`,
      });
    }
    discoveredPeripherals.set(dev.id, p);
    if (!prev) {
      found.set(dev.id, dev);
    } else {
      const merged: DiscoveredDevice = {
        ...prev,
        rssi: dev.rssi > prev.rssi ? dev.rssi : prev.rssi,
        name: prev.name.startsWith('(no-name)') && !dev.name.startsWith('(no-name)') ? dev.name : prev.name,
        source: prev.source === 'hcitool' || prev.source === 'both' ? 'both' : 'noble',
      };
      found.set(dev.id, merged);
    }
  };

  // Hybrid discovery: kick off hcitool lescan in parallel — noble's
  // startScanningAsync hangs on some Pis even when poweredOn, so this
  // gives us a fallback path that talks to HCI directly.
  let hcitoolPromise: Promise<HcitoolScanResult> | null = null;
  try {
    hcitoolPromise = hcitoolLescan(timeoutMs);
    logConnectionEvent({ type: 'scan_start', detail: `hcitool lescan started (parallel, timeout=${timeoutMs}ms)` });
  } catch (e: any) {
    logConnectionEvent({ type: 'scan_start', detail: `hcitool kick-off failed: ${e?.message ?? e}` });
  }

  const mergeHcitoolResults = (hres: HcitoolScanResult) => {
    for (const d of hres.devices) {
      const prev = found.get(d.id);
      if (!prev) {
        found.set(d.id, { ...d, source: 'hcitool' });
        logConnectionEvent({ type: 'scan_start', detail: `hcitool found: ${d.name} (${d.id})` });
      } else {
        found.set(d.id, {
          ...prev,
          name: prev.name.startsWith('(no-name)') && !d.name.startsWith('(no-name)') ? d.name : prev.name,
          source: prev.source === 'noble' ? 'both' : prev.source ?? 'hcitool',
        });
      }
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
  };

  try {
    logConnectionEvent({
      type: 'scan_start',
      detail: `noble scan, timeout=${timeoutMs}ms, adapter=${getAdapterState()}, raw=${getNobleRawState() ?? 'unknown'}`,
    });

    const ready = isAdapterReadyForBleOps()
      ? true
      : await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(isAdapterReadyForBleOps()), 1500);
          const onState = (s: string) => {
            if (s === 'poweredOn') {
              clearTimeout(t);
              try { (noble as any).removeListener?.('stateChange', onState); } catch {}
              resolve(true);
            }
          };
          try { (noble as any).on?.('stateChange', onState); } catch {}
        });

    if (!ready) {
      scanMetrics.phase = 'idle';
      scanMetrics.active = false;
      scanMetrics.activeSince = null;
      scanMetrics.lastStoppedAt = new Date().toISOString();
      scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
      scanMetrics.lastStartError = `Adapter not ready (raw=${getNobleRawState() ?? 'unknown'}, effective=${getAdapterState() ?? 'unknown'})`;
      logConnectionEvent({
        type: 'scan_done',
        detail: `Adaptern är inte redo (raw=${getNobleRawState() ?? 'unknown'}, effective=${getAdapterState() ?? 'unknown'}). Slå på BLE-radio i UI eller tryck "Återställ BLE-stack".`,
      });
      lastScanResults = [];
      return lastScanResults;
    }

    (noble as any).on('discover', onDiscover);

    const rawBeforeForce = getNobleRawState() ?? 'unknown';
    const hciUp = isHci0Up();
    const forced = forceNoblePoweredOn();
    logConnectionEvent({
      type: 'scan_start',
      detail: `forceNoblePoweredOn → ${forced ? 'OK' : 'FAILED'} (raw_before=${rawBeforeForce}, hci_up=${hciUp}, raw_after=${getNobleRawState() ?? 'unknown'})`,
    });

    try {
      await (noble as any).startScanningAsync([], true);
      scanMetrics.phase = 'scanning';
      scanMetrics.lastStartOkAt = new Date().toISOString();
    } catch (scanErr: any) {
      scanMetrics.lastStartError = scanErr?.message ?? String(scanErr);
      logConnectionEvent({
        type: 'scan_done',
        detail: `startScanning failed: "${scanErr?.message ?? scanErr}" — falling back to hcitool only (raw=${getNobleRawState() ?? 'unknown'})`,
      });
      // Fall through — hcitool is still running and may find devices.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

    scanMetrics.phase = 'stopping';
    try {
      await (noble as any).stopScanningAsync();
    } catch (stopErr: any) {
      scanMetrics.lastStopError = stopErr?.message ?? String(stopErr);
    }

    // Wait for hcitool (parallel) to finish — it has its own timeoutMs.
    if (hcitoolPromise) {
      try {
        const hres = await Promise.race([
          hcitoolPromise,
          new Promise<HcitoolScanResult>((resolve) =>
            setTimeout(() => resolve({ devices: [], rawLineCount: 0, exitCode: null, startError: 'await-timeout', stderr: '', durationMs: 0 }), 3000)
          ),
        ]);
        mergeHcitoolResults(hres);
      } catch (e: any) {
        scanMetrics.hcitool = { enabled: true, deviceCount: 0, rawLineCount: 0, exitCode: null, startError: e?.message ?? String(e), stderr: '', durationMs: 0 };
      }
    }

    lastScanResults = Array.from(found.values()).sort((a, b) => b.rssi - a.rssi);
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastRawDiscoverCount = rawDiscoverCount;
    scanMetrics.lastResultCount = lastScanResults.length;

    const nobleCount = lastScanResults.filter(d => d.source === 'noble' || d.source === 'both').length;
    const hcitoolCount = lastScanResults.filter(d => d.source === 'hcitool' || d.source === 'both').length;
    if (lastScanResults.length === 0) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `0 devices total — noble_raw=${rawDiscoverCount}, hcitool_raw=${scanMetrics.hcitool?.rawLineCount ?? 0}, hcitool_err="${scanMetrics.hcitool?.startError ?? 'none'}". Adapter=${getAdapterState()}`,
      });
    } else {
      logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) (noble=${nobleCount}, hcitool=${hcitoolCount}, noble_raw=${rawDiscoverCount})` });
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
    try { await (noble as any).stopScanningAsync(); } catch {}
    return lastScanResults;
  } finally {
    clearTimeout(watchdog);
    try { (noble as any).removeListener?.('discover', onDiscover); } catch {}
    try {
      await Promise.race([
        (noble as any).stopScanningAsync?.(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch (stopErr: any) {
      if (!scanMetrics.lastStopError) scanMetrics.lastStopError = stopErr?.message ?? String(stopErr);
    }
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    if (!scanMetrics.lastStoppedAt) scanMetrics.lastStoppedAt = new Date().toISOString();
    if (scanMetrics.lastDurationMs == null) scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastRawDiscoverCount = rawDiscoverCount;
    scanMetrics.lastResultCount = lastScanResults.length;
    scanning = false;
  }
}
