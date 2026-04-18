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

  // Hård watchdog: garantera att `scanning`-flaggan släpps även om
  // stopScanningAsync() eller startScanningAsync() hänger oändligt.
  // Annars fastnar UI:t i "🔵 Söker" för evigt eftersom /api/diag
  // returnerar scanning=true.
  const watchdog = setTimeout(() => {
    if (scanning) {
      scanning = false;
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
    if (!prev || dev.rssi > prev.rssi) found.set(dev.id, dev);
  };

  try {
    logConnectionEvent({
      type: 'scan_start',
      detail: `noble scan, timeout=${timeoutMs}ms, adapter=${getAdapterState()}, raw=${getNobleRawState() ?? 'unknown'}`,
    });

    // Master-switchen ska redan ha väckt adaptern. Acceptera caps-aware
    // effective state om noble raw fastnat i `unknown` (vanligt på Pi Zero 2W).
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
      logConnectionEvent({
        type: 'scan_done',
        detail: `Adaptern är inte redo (raw=${getNobleRawState() ?? 'unknown'}, effective=${getAdapterState() ?? 'unknown'}). Slå på BLE-radio i UI eller tryck "Återställ BLE-stack".`,
      });
      lastScanResults = [];
      return lastScanResults;
    }

    (noble as any).on('discover', onDiscover);

    // Noble's startScanningAsync har en INTERN guard som kastar
    // "Could not start scanning, state is unknown" innan den ens rör HCI.
    // Vår caps-aware effective state hjälper inte mot den. Tvinga noble's
    // interna state till poweredOn ALLTID precis innan vi startar scan.
    // Idempotent + cheap — `forceNoblePoweredOn` skippar internt om raw redan
    // är poweredOn (bumpar då bara `_skippedHealthy`-counter). Vi loggar
    // ovillkorligt så vi alltid ser om grenen körs i eventloggen.
    const rawBeforeForce = getNobleRawState() ?? 'unknown';
    const hciUp = isHci0Up();
    const forced = forceNoblePoweredOn();
    logConnectionEvent({
      type: 'scan_start',
      detail: `forceNoblePoweredOn → ${forced ? 'OK' : 'FAILED'} (raw_before=${rawBeforeForce}, hci_up=${hciUp}, raw_after=${getNobleRawState() ?? 'unknown'})`,
    });

    try {
      await (noble as any).startScanningAsync([], true);
    } catch (scanErr: any) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `startScanning failed: "${scanErr?.message ?? scanErr}" (raw=${getNobleRawState() ?? 'unknown'})`,
      });
      lastScanResults = [];
      return lastScanResults;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

    try { await (noble as any).stopScanningAsync(); } catch {}

    lastScanResults = Array.from(found.values()).sort((a, b) => b.rssi - a.rssi);

    if (lastScanResults.length === 0) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `0 devices via noble — raw_discover_events=${rawDiscoverCount}. ${rawDiscoverCount === 0 ? 'INGA events alls från noble — HCI scan startar inte (kolla hcitool lescan manuellt)' : 'Events kom in men filtrerades bort'}. Adapter=${getAdapterState()}`,
      });
    } else {
      logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) found via noble (raw_events=${rawDiscoverCount})` });
    }

    return lastScanResults;
  } catch (e: any) {
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e?.message ?? e}` });
    console.error(`[BLE] scan error: ${e?.message ?? e}`);
    try { await (noble as any).stopScanningAsync(); } catch {}
    return lastScanResults;
  } finally {
    clearTimeout(watchdog);
    try { (noble as any).removeListener?.('discover', onDiscover); } catch {}
    // stopScanning med egen 2s timeout så finally aldrig hänger
    try {
      await Promise.race([
        (noble as any).stopScanningAsync?.(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {}
    scanning = false;
  }
}
