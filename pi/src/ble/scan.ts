/**
 * BLE scanning — ren noble.
 *
 * Använder noble.startScanningAsync/stopScanningAsync. Ingen hcitool, ingen
 * shell-exec. Noble äger HCI-socketen genom hela scan+connect-flödet.
 *
 * VIKTIGT: Vi cachear hela peripheral-objektet (inte bara id/name/rssi) så att
 * connect.ts kan använda samma peripheral direkt — exakt som den gamla
 * fungerande monoliten. noble.connectAsync(address) är opålitlig på Pi, men
 * peripheral.connectAsync() från ett scan-resultat är robust.
 */

import { noble, getAdapterState, processHasBtCaps, logConnectionEvent } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { ensureAdapterUp, restartNobleHci } from './adapter.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

// Cache av peripheral-objekt indexerat på normaliserat id (MAC utan kolon, lowercase).
// Connect-flödet hämtar peripheral härifrån istället för att starta egen scan.
const discoveredPeripherals = new Map<string, any>();

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }
export function getDiscoveredPeripheral(id: string): any | undefined {
  return discoveredPeripherals.get(id.toLowerCase());
}

function getRawNobleState(): string | undefined {
  const n = noble as typeof noble & {
    state?: string;
    _state?: string;
    adapterState?: string;
    _adapterState?: string;
  };
  return n.state ?? n._state ?? n.adapterState ?? n._adapterState;
}

function peripheralToDevice(p: any): DiscoveredDevice | null {
  const id: string | undefined = p?.id ?? p?.uuid ?? p?.address?.replace(/:/g, '').toLowerCase();
  if (!id) return null;
  const adv = p?.advertisement ?? {};
  const rawName: string | undefined = adv?.localName ?? p?.name;
  // Filtrera bort enheter helt utan namn (matchar gamla monoliten — minskar brus)
  const name = (rawName && String(rawName).trim()) || '';
  if (!name) return null;
  const rssi = typeof p?.rssi === 'number' ? p.rssi : -100;
  return { id: String(id).toLowerCase(), name, rssi };
}

async function waitForScanReady(timeoutMs: number): Promise<boolean> {
  if (getRawNobleState() === 'poweredOn') return true;
  return await new Promise<boolean>((resolve) => {
    const onState = (s: string) => {
      if (s === 'poweredOn') { cleanup(); resolve(true); }
    };
    const poll = setInterval(() => {
      if (getRawNobleState() === 'poweredOn') { cleanup(); resolve(true); }
    }, 200);
    const timer = setTimeout(() => {
      cleanup();
      resolve(getRawNobleState() === 'poweredOn');
    }, timeoutMs);
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      try { (noble as any).removeListener?.('stateChange', onState); } catch {}
    };
    try { (noble as any).on?.('stateChange', onState); } catch {}
  });
}

export async function scanForDevices(timeoutMs = 10000): Promise<DiscoveredDevice[]> {
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

  const onDiscover = (p: any) => {
    const dev = peripheralToDevice(p);
    if (!dev) return;
    const prev = found.get(dev.id);
    if (!prev) {
      logConnectionEvent({ type: 'scan_start', detail: `Found: ${dev.name} (${p?.address ?? dev.id}) rssi=${dev.rssi}` });
    }
    discoveredPeripherals.set(dev.id, p);
    if (!prev || dev.rssi > prev.rssi) found.set(dev.id, dev);
  };

  try {
    const adapterState = getAdapterState();
    const rawStateBefore = getRawNobleState() ?? 'unknown';
    const hasCaps = processHasBtCaps();
    logConnectionEvent({
      type: 'scan_start',
      detail: `noble scan, timeout=${timeoutMs}ms, adapter=${adapterState}, raw=${rawStateBefore}, caps=${hasCaps}`,
    });

    try { await ensureAdapterUp(); } catch {}

    let ready = await waitForScanReady(6000);
    if (!ready) {
      logConnectionEvent({
        type: 'scan_start',
        detail: `Raw noble state still ${getRawNobleState() ?? 'unknown'} after warmup — refreshing noble HCI before scan`,
      });
      try { await restartNobleHci('scan'); } catch {}
      ready = await waitForScanReady(3000);
    }

    if (!ready) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `Cannot start noble scan: raw=${getRawNobleState() ?? 'unknown'}, effective=${getAdapterState() ?? 'unknown'} (startScanningAsync requires raw poweredOn)`,
      });
      lastScanResults = [];
      return lastScanResults;
    }

    (noble as any).on('discover', onDiscover);
    await (noble as any).startScanningAsync([], true);
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    try { await (noble as any).stopScanningAsync(); } catch {}

    lastScanResults = Array.from(found.values()).sort((a, b) => b.rssi - a.rssi);

    if (lastScanResults.length === 0) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `0 devices via noble — BLEDOM kanske inte annonserar just nu? raw=${getRawNobleState() ?? 'unknown'}, effective=${getAdapterState() ?? 'unknown'}`,
      });
    } else {
      logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) found via noble` });
    }

    return lastScanResults;
  } catch (e: any) {
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e?.message ?? e}` });
    console.error(`[BLE] scan error: ${e?.message ?? e}`);
    try { await (noble as any).stopScanningAsync(); } catch {}
    return lastScanResults;
  } finally {
    try { (noble as any).removeListener?.('discover', onDiscover); } catch {}
    scanning = false;
  }
}
