/**
 * BLE scanning — ren noble.
 *
 * Förutsättning: node-binären har CAP_NET_RAW + CAP_NET_ADMIN via setcap
 * (sätts av setup-lotus.sh). Med korrekta caps fungerar noble pålitligt:
 * state → poweredOn, discover-events strömmar in. Ingen hcitool-fallback
 * behövs längre.
 *
 * Strategi:
 *  1. `ensureAdapterUp()` (rfkill unblock + hciconfig hci0 up — säkert).
 *  2. Vänta på poweredOn via stateChange-event (upp till 6s).
 *  3. `noble.startScanningAsync` → samla discover-events under timeout → stopScanningAsync.
 *
 * Vi cachear hela peripheral-objektet (inte bara id/name/rssi) så att
 * connect.ts kan använda samma peripheral direkt.
 */

import { noble, getAdapterState, logConnectionEvent, getNobleRawState } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { ensureAdapterUp } from './adapter.js';
import { isBleEnabled } from './enabled.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

// Cache av peripheral-objekt indexerat på normaliserat id (lowercase, utan kolon).
const discoveredPeripherals = new Map<string, any>();

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }
export function getDiscoveredPeripheral(id: string): any | undefined {
  return discoveredPeripherals.get(id.toLowerCase());
}

function peripheralToDevice(p: any): DiscoveredDevice | null {
  const id: string | undefined = p?.id ?? p?.uuid ?? p?.address?.replace(/:/g, '').toLowerCase();
  if (!id) return null;
  const adv = p?.advertisement ?? {};
  const rawName: string | undefined = adv?.localName ?? p?.name;
  const name = (rawName && String(rawName).trim()) || '';
  if (!name) return null;
  const rssi = typeof p?.rssi === 'number' ? p.rssi : -100;
  return { id: String(id).toLowerCase(), name, rssi };
}

async function waitForPoweredOn(timeoutMs: number): Promise<boolean> {
  if (getNobleRawState() === 'poweredOn') return true;
  return await new Promise<boolean>((resolve) => {
    const onState = (s: string) => {
      if (s === 'poweredOn') { cleanup(); resolve(true); }
    };
    const poll = setInterval(() => {
      if (getNobleRawState() === 'poweredOn') { cleanup(); resolve(true); }
    }, 200);
    const timer = setTimeout(() => { cleanup(); resolve(getNobleRawState() === 'poweredOn'); }, timeoutMs);
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      try { (noble as any).removeListener?.('stateChange', onState); } catch {}
    };
    try { (noble as any).on?.('stateChange', onState); } catch {}
  });
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
    logConnectionEvent({
      type: 'scan_start',
      detail: `noble scan, timeout=${timeoutMs}ms, adapter=${getAdapterState()}, raw=${getNobleRawState() ?? 'unknown'}`,
    });

    // Säker adapter-init (rfkill unblock + hciconfig hci0 up). Ingen hci.stop().
    try { await ensureAdapterUp(); } catch {}

    const ready = await waitForPoweredOn(6000);
    if (!ready) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `Raw noble inte poweredOn (raw=${getNobleRawState() ?? 'unknown'}, effective=${getAdapterState() ?? 'unknown'}) — kan inte scanna`,
      });
      lastScanResults = [];
      return lastScanResults;
    }

    (noble as any).on('discover', onDiscover);

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
        detail: `0 devices via noble — är BLEDOM på och i närheten? Adapter=${getAdapterState()}`,
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
