/**
 * BLE scanning — ren noble.
 *
 * Använder noble.startScanningAsync/stopScanningAsync. Ingen hcitool, ingen
 * shell-exec. Noble äger HCI-socketen genom hela scan+connect-flödet.
 */

import { noble, getAdapterState, processHasBtCaps, logConnectionEvent } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { ensureAdapterUp } from './adapter.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

function peripheralToDevice(p: any): DiscoveredDevice | null {
  const id: string | undefined = p?.id ?? p?.uuid ?? p?.address?.replace(/:/g, '').toLowerCase();
  if (!id) return null;
  const mac: string = (p?.address ?? '').toUpperCase();
  const adv = p?.advertisement ?? {};
  const rawName: string | undefined = adv?.localName ?? p?.name;
  const name = (rawName && String(rawName).trim()) || (mac ? `Okänd enhet (${mac})` : `Okänd enhet (${id})`);
  const rssi = typeof p?.rssi === 'number' ? p.rssi : -100;
  return { id: String(id).toLowerCase(), name, rssi };
}

async function waitForPoweredOn(timeoutMs: number): Promise<boolean> {
  if (getAdapterState() === 'poweredOn') return true;
  return await new Promise<boolean>((resolve) => {
    const onState = (s: string) => {
      if (s === 'poweredOn') { cleanup(); resolve(true); }
    };
    const poll = setInterval(() => {
      if (getAdapterState() === 'poweredOn') { cleanup(); resolve(true); }
    }, 200);
    const timer = setTimeout(() => { cleanup(); resolve(getAdapterState() === 'poweredOn'); }, timeoutMs);
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      try { (noble as any).removeListener?.('stateChange', onState); } catch {}
    };
    try { (noble as any).on?.('stateChange', onState); } catch {}
  });
}

export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — scan already running' });
    return lastScanResults;
  }
  if (isNobleScanActive()) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — noble scan-connect is active (would lock HCI)' });
    return lastScanResults;
  }

  scanning = true;
  const found = new Map<string, DiscoveredDevice>();

  const onDiscover = (p: any) => {
    const dev = peripheralToDevice(p);
    if (!dev) return;
    const prev = found.get(dev.id);
    if (!prev) {
      logConnectionEvent({ type: 'scan_start', detail: `Found: ${dev.name} (${p?.address ?? dev.id}) rssi=${dev.rssi}` });
    }
    // keep best (highest) rssi
    if (!prev || dev.rssi > prev.rssi) found.set(dev.id, dev);
  };

  try {
    const adapterState = getAdapterState();
    const hasCaps = processHasBtCaps();
    logConnectionEvent({
      type: 'scan_start',
      detail: `noble scan, timeout=${timeoutMs}ms, adapter=${adapterState}, caps=${hasCaps}`,
    });

    try { await ensureAdapterUp(); } catch {}

    const ready = await waitForPoweredOn(2500);
    if (!ready) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `Adapter inte poweredOn (state=${getAdapterState()}) — kan inte scanna med noble`,
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
