/**
 * BLE scanning — noble-baserad scan.
 *
 * Vi använder noble.startScanningAsync() direkt eftersom noble redan äger
 * mgmt-kanalen i denna process — ingen annan binär (btmgmt, hcitool) kan
 * scanna parallellt utan att få "0x0a Busy" eller "Operation not permitted".
 *
 * Bevis (2026-04-19): manuell test `sudo timeout 4 btmgmt find` medan engine
 * kör → "Unable to start discovery. status 0x0a (Busy)". Slutsats: noble
 * måste vara den som scannar i denna process.
 */

import { noble, getAdapterState, logConnectionEvent, getNobleRawState, hasNobleEverFiredStateChange, recordObservedNobleState } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

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
  // Behålls för backward-compat med UI:t men sätts alltid till null nu.
  hcitool: null;
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

export async function scanForDevices(timeoutMs = 4000): Promise<DiscoveredDevice[]> {
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

  const n: any = noble;
  let onDiscover: ((p: any) => void) | null = null;

  // Watchdog deklareras här men startas EFTER waitForPoweredOnAsync — annars
  // skulle den (felaktigt) trigga mitt under en legitim 10s-wait på poweredOn.
  // Efter wait återstår bara scan + stop, så timeoutMs + 5000 räcker som tak.
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const armWatchdog = () => {
    watchdog = setTimeout(() => {
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
          detail: `Watchdog tvångsfrigjorde scan-flaggan efter ${timeoutMs + 5000}ms (efter wait)`,
        });
      }
    }, timeoutMs + 5000);
  };

  try {
    logConnectionEvent({
      type: 'scan_start',
      detail: `noble.startScanningAsync ${timeoutMs}ms (allowDuplicates), adapter=${getAdapterState()}, noble=${getNobleRawState() ?? 'unknown'}, everFired=${hasNobleEverFiredStateChange()}`,
    });

    // Säkerställ att noble inte håller en gammal scan-session öppen.
    try {
      if (typeof n.stopScanningAsync === 'function') await n.stopScanningAsync();
      else if (typeof n.stopScanning === 'function') n.stopScanning();
    } catch {}

    // Vänta på riktig stateChange — ALDRIG mutera noble.state manuellt.
    // Se mem://pi/ble/never-force-mutate-noble-state: mutation byter bara
    // strängvärdet utan att noble's HCI-init körs klart, vilket ger
    // 0 discover-events (bevisat 2026-04-18 via SSH-test).
    if (typeof n.waitForPoweredOnAsync === 'function') {
      const beforeWait = { state: n.state, _state: n._state };
      try {
        const t0 = Date.now();
        await n.waitForPoweredOnAsync(10_000);
        const dt = Date.now() - t0;
        // Markera observation så early-listener-missen inte ljuger i UI:t
        try { recordObservedNobleState('poweredOn'); } catch {}
        logConnectionEvent({
          type: 'scan_start',
          detail: `waitForPoweredOnAsync OK efter ${dt}ms (was state=${beforeWait.state}, _state=${beforeWait._state})`,
        });
      } catch (e: any) {
        logConnectionEvent({
          type: 'scan_start',
          detail: `waitForPoweredOnAsync FAIL: ${e?.message ?? e} (state=${n.state}, _state=${n._state}) — avbryter scan`,
        });
        throw new Error(`noble inte poweredOn inom 10s: ${e?.message ?? e}`);
      }
    }

    // Nu — och bara nu — armerar vi watchdog för själva scan-fasen.
    armWatchdog();

    onDiscover = (peripheral: any) => {
      try {
        const idRaw: string = peripheral?.id ?? peripheral?.uuid ?? peripheral?.address ?? '';
        if (!idRaw) return;
        const id = String(idRaw).replace(/:/g, '').toLowerCase();
        scanMetrics.lastRawDiscoverCount++;

        const adv = peripheral?.advertisement ?? {};
        const rawName: string =
          adv.localName ||
          peripheral?.name ||
          (adv.manufacturerData ? `(mfg) ${peripheral?.address ?? id}` : '') ||
          `(no-name) ${peripheral?.address ?? id}`;
        const rssi = typeof peripheral?.rssi === 'number' ? peripheral.rssi : -100;

        discoveredPeripherals.set(id, peripheral);

        const prev = found.get(id);
        if (!prev) {
          found.set(id, { id, name: String(rawName).trim() || `(no-name) ${id}`, rssi, source: 'noble' });
        } else {
          if (rssi > prev.rssi) prev.rssi = rssi;
          if (prev.name.startsWith('(no-name)') && rawName && !rawName.startsWith('(no-name)')) {
            prev.name = String(rawName).trim();
          }
        }
      } catch (e: any) {
        console.error('[BLE:scan] discover handler error:', e?.message ?? e);
      }
    };

    n.on('discover', onDiscover);

    // Starta scanning. Tomma services + allowDuplicates=true → vi får alla
    // BLE-enheter och uppdaterad RSSI per advert.
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

    // Vänta klart timeoutMs.
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

    // Stoppa scan.
    scanMetrics.phase = 'stopping';
    try {
      if (typeof n.stopScanningAsync === 'function') await n.stopScanningAsync();
      else if (typeof n.stopScanning === 'function') n.stopScanning();
    } catch (e: any) {
      scanMetrics.lastStopError = e?.message ?? String(e);
    }

    lastScanResults = Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastResultCount = lastScanResults.length;

    logConnectionEvent({
      type: 'scan_done',
      detail: `${lastScanResults.length} device(s) via noble (raw_discovers=${scanMetrics.lastRawDiscoverCount}, dur=${scanMetrics.lastDurationMs}ms)`,
    });

    return lastScanResults;
  } catch (e: any) {
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    if (!scanMetrics.lastStartError) scanMetrics.lastStartError = e?.message ?? String(e);
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e?.message ?? e}` });
    console.error(`[BLE] scan error: ${e?.message ?? e}`);
    return lastScanResults;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (onDiscover) {
      try { (noble as any).removeListener?.('discover', onDiscover); } catch {}
    }
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    if (!scanMetrics.lastStoppedAt) scanMetrics.lastStoppedAt = new Date().toISOString();
    if (scanMetrics.lastDurationMs == null) scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastResultCount = lastScanResults.length;
    scanning = false;
  }
}
