/**
 * BLE scanning — noble-baserad scan-loop.
 *
 * Vi använder noble.startScanningAsync() direkt eftersom noble redan äger
 * mgmt-kanalen i denna process — ingen annan binär (btmgmt, hcitool) kan
 * scanna parallellt utan att få "0x0a Busy" eller "Operation not permitted".
 *
 * Sekvens (i ordning):
 *   1. Guards (redan scanning? scan-connect aktivt?)
 *   2. Init metrics + scanning=true
 *   3. Logga "Väntar på poweredOn"
 *   4. await noble.waitForPoweredOnAsync(10s)  ← INGEN watchdog än
 *   5. Logga "poweredOn OK — startScanningAsync …"
 *   6. Arma watchdog (timeoutMs + 5s)
 *   7. Registrera discover-listener
 *   8. await startScanningAsync → vänta timeoutMs → stopScanningAsync
 *   9. Logga scan_done, finally: cancel watchdog + remove listener
 *
 * Metrics: ./scan-metrics.ts
 * Watchdog: ./scan-watchdog.ts
 */

import {
  noble,
  getAdapterState,
  logConnectionEvent,
  getNobleRawState,
  hasNobleEverFiredStateChange,
  recordObservedNobleState,
} from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { scanMetrics, nextScanId, resetMetricsForNewScan, finalizeMetrics } from './scan-metrics.js';
import { armScanWatchdog, type ScanWatchdogHandle } from './scan-watchdog.js';
import { createDiscoverHandler } from './scan-discover.js';
import { processHasBtCaps } from './state.js';

export { getScanMetrics, type BleScanMetrics } from './scan-metrics.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;
const discoveredPeripherals = new Map<string, any>();

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }
export function getDiscoveredPeripheral(id: string): any | undefined {
  return discoveredPeripherals.get(id.toLowerCase());
}

export async function scanForDevices(timeoutMs = 4000): Promise<DiscoveredDevice[]> {
  // 1. Guards
  if (scanning) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — scan already running' });
    return lastScanResults;
  }
  if (isNobleScanActive()) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — noble scan-connect is active (would lock HCI)' });
    return lastScanResults;
  }

  // 2. Init
  scanning = true;
  discoveredPeripherals.clear();
  const found = new Map<string, DiscoveredDevice>();
  const scanStartedAt = Date.now();
  resetMetricsForNewScan(scanStartedAt, nextScanId());

  const n: any = noble;
  let onDiscover: ((p: any) => void) | null = null;
  let watchdog: ScanWatchdogHandle | null = null;

  try {
    // 3. Pre-wait log
    logConnectionEvent({
      type: 'scan_start',
      detail: `Väntar på poweredOn före scan (scan=${timeoutMs}ms, wait=10000ms), adapter=${getAdapterState()}, noble=${getNobleRawState() ?? 'unknown'}, everFired=${hasNobleEverFiredStateChange()}`,
    });

    // Säkerställ att noble inte håller en gammal scan-session öppen.
    try {
      if (typeof n.stopScanningAsync === 'function') await n.stopScanningAsync();
      else if (typeof n.stopScanning === 'function') n.stopScanning();
    } catch {}

    // 4. Vänta på riktig stateChange — ALDRIG mutera noble.state manuellt.
    // Se mem://pi/ble/never-force-mutate-noble-state.
    // Policy: INGEN auto-respawn (mem://pi/ble/manual-only-connection-policy).
    // Om noble's interna state-promise inte resolvar inom 10s men effektiv
    // adapter-state ÄR redo (caps OK + hci0 UP) så fortsätter vi ändå —
    // noble's HCI-binding fungerar i praktiken även när dess JS-state-flagga
    // ligger kvar på 'unknown' på Pi.
    if (typeof n.waitForPoweredOnAsync === 'function') {
      const beforeWait = { state: n.state, _state: n._state };
      try {
        const t0 = Date.now();
        await n.waitForPoweredOnAsync(10_000);
        const dt = Date.now() - t0;
        try { recordObservedNobleState('poweredOn'); } catch {}
        logConnectionEvent({
          type: 'scan_start',
          detail: `waitForPoweredOnAsync OK efter ${dt}ms (was state=${beforeWait.state}, _state=${beforeWait._state})`,
        });
      } catch (e: any) {
        const effectiveReady = getAdapterState() === 'poweredOn' && processHasBtCaps();
        if (effectiveReady) {
          logConnectionEvent({
            type: 'scan_start',
            detail: `waitForPoweredOnAsync timeout men effektiv adapter är redo (eff=poweredOn, caps OK, rå=${n.state ?? 'null'}) — fortsätter scan utan respawn`,
          });
          // Fortsätt — noble's HCI-binding fungerar trots wedged JS-state.
        } else {
          const msg = `BLE-motor ej redo: rå noble=${n.state ?? 'null'}, effektiv adapter=${getAdapterState() ?? 'unknown'}. Tryck "Återställ BLE-stack" i UI:t.`;
          logConnectionEvent({
            type: 'scan_start',
            detail: `waitForPoweredOnAsync FAIL utan effektiv readiness: ${e?.message ?? e} — ingen auto-respawn (manual-only-policy)`,
          });
          scanMetrics.lastStartError = msg;
          throw new Error(msg);
        }
      }
    }

    // 5. Scan-start log
    logConnectionEvent({
      type: 'scan_start',
      detail: `poweredOn OK — startScanningAsync ${timeoutMs}ms (allowDuplicates), adapter=${getAdapterState()}, noble=${getNobleRawState() ?? 'unknown'}, everFired=${hasNobleEverFiredStateChange()}`,
    });

    // 6. Arma watchdog NU (efter wait, så 10s wait inte räknas in i 9s-fönstret)
    watchdog = armScanWatchdog({
      timeoutMs,
      scanStartedAt,
      isScanning: () => scanning,
      releaseScanFlag: () => { scanning = false; },
      getFoundCount: () => found.size,
    });

    // 7. Discover listener
    onDiscover = createDiscoverHandler({ found, discoveredPeripherals });
    n.on('discover', onDiscover);

    // 8. Starta scan
    try {
      await n.startScanningAsync([], true);
      scanMetrics.phase = 'scanning';
      scanMetrics.lastStartOkAt = new Date().toISOString();
    } catch (e: any) {
      scanMetrics.lastStartError = e?.message ?? String(e);
      logConnectionEvent({
        type: 'scan_done',
        detail: `noble.startScanningAsync failed: ${e?.message ?? e}`,
      });
      throw e;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

    scanMetrics.phase = 'stopping';
    try {
      if (typeof n.stopScanningAsync === 'function') await n.stopScanningAsync();
      else if (typeof n.stopScanning === 'function') n.stopScanning();
    } catch (e: any) {
      scanMetrics.lastStopError = e?.message ?? String(e);
    }

    lastScanResults = Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;

    logConnectionEvent({
      type: 'scan_done',
      detail: `${lastScanResults.length} device(s) via noble (raw_discovers=${scanMetrics.lastRawDiscoverCount}, dur=${scanMetrics.lastDurationMs}ms)`,
    });

    return lastScanResults;
  } catch (e: any) {
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    if (!scanMetrics.lastStartError) scanMetrics.lastStartError = e?.message ?? String(e);
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e?.message ?? e}` });
    console.error(`[BLE] scan error: ${e?.message ?? e}`);
    return lastScanResults;
  } finally {
    if (watchdog) watchdog.cancel();
    if (onDiscover) {
      try { (noble as any).removeListener?.('discover', onDiscover); } catch {}
    }
    finalizeMetrics(scanStartedAt, lastScanResults.length);
    scanning = false;
  }
}
