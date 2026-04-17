/**
 * BLE scanning — pure noble discovery.
 *
 * Uses the official noble API end-to-end (matches the architecture described
 * in mem://pi/ble/hybrid-discovery-strategy). No external binaries, no HCI
 * contention with the connect path, ambient capabilities are sufficient.
 */

import { noble, getAdapterState, processHasBtCaps, logConnectionEvent } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

async function waitForPoweredOn(timeoutMs: number): Promise<boolean> {
  if (getAdapterState() === 'poweredOn') return true;
  try {
    await (noble as any).waitForPoweredOnAsync?.(timeoutMs);
  } catch {
    // fallthrough — re-check state
  }
  return getAdapterState() === 'poweredOn';
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
  lastScanResults = [];

  const seen = new Map<string, DiscoveredDevice>();
  let onDiscover: ((peripheral: any) => void) | null = null;

  try {
    const adapterState = getAdapterState();
    const hasCaps = processHasBtCaps();
    logConnectionEvent({
      type: 'scan_start',
      detail: `noble scan, timeout=${timeoutMs}ms, adapter=${adapterState}, caps=${hasCaps}`,
    });

    const ready = await waitForPoweredOn(3000);
    if (!ready) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `Adapter not poweredOn (state=${getAdapterState()}, caps=${hasCaps}) — aborting scan`,
      });
      return lastScanResults;
    }

    onDiscover = (peripheral: any) => {
      const id = String(peripheral.id ?? '').toLowerCase();
      if (!id) return;
      const mac = (peripheral.address && peripheral.address !== 'unknown')
        ? String(peripheral.address).toUpperCase()
        : id.match(/.{1,2}/g)?.join(':').toUpperCase() ?? id.toUpperCase();
      const advName = peripheral.advertisement?.localName?.trim();
      const name = advName && advName.length > 0 ? advName : `Okänd enhet (${mac})`;
      const rssi = typeof peripheral.rssi === 'number' ? peripheral.rssi : -100;

      if (!seen.has(id)) {
        logConnectionEvent({ type: 'scan_start', detail: `Found: ${name} (${mac}) rssi=${rssi}` });
      }
      seen.set(id, { id, name, rssi });
    };

    noble.on('discover', onDiscover);

    // Make sure no stale scan is running
    try { (noble as any).stopScanning?.(); } catch {}

    await (noble as any).startScanningAsync([], true);
    logConnectionEvent({ type: 'scan_start', detail: 'noble.startScanningAsync started' });

    await new Promise<void>(resolve => setTimeout(resolve, timeoutMs));

    try { await (noble as any).stopScanningAsync(); } catch {}

    lastScanResults = Array.from(seen.values());

    if (lastScanResults.length === 0) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `0 devices — är BLEDOM på och i närheten? Adapter=${getAdapterState()}`,
      });
    } else {
      logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) found via noble` });
    }

    return lastScanResults;
  } catch (e: any) {
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e.message}` });
    console.error(`[BLE] scan error: ${e.message}`);
    return lastScanResults;
  } finally {
    if (onDiscover) {
      try { noble.removeListener('discover', onDiscover); } catch {}
    }
    try { (noble as any).stopScanning?.(); } catch {}
    scanning = false;
  }
}
