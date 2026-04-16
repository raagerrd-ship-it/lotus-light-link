/**
 * BLE scanning — noble's official async scan API.
 *
 * Isolated tests confirm noble.startScanningAsync resolves in <10ms when
 * waitForPoweredOnAsync is called first — even if our shim already reports
 * poweredOn. Noble's internal scan API requires its own stateChange event.
 */

import { noble, logConnectionEvent, getAdapterState, processHasBtCaps } from './state.js';
import type { DiscoveredDevice } from './types.js';

// ── Scan state ──
let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;
const SCAN_STEP_TIMEOUT_MS = 6000;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = SCAN_STEP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then((value) => {
      clearTimeout(timer);
      return value;
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

/**
 * Scan for BLE devices using noble's native async API.
 */
export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — scan already running' });
    return lastScanResults;
  }
  scanning = true;
  lastScanResults = [];

  const adapterState = getAdapterState();
  const hasCaps = processHasBtCaps();
  logConnectionEvent({ type: 'scan_start', detail: `noble scan, timeout=${timeoutMs}ms, adapter=${adapterState}, caps=${hasCaps}` });

  const seen = new Map<string, DiscoveredDevice>();
  let discoverCount = 0;

  const onDiscover = (peripheral: any) => {
    discoverCount++;
    const mac: string = peripheral.address ?? '';
    if (!mac || mac === 'unknown') return;
    const id = mac.replace(/:/g, '').toLowerCase();
    const rawName: string = peripheral.advertisement?.localName ?? '';
    const name = rawName.length > 0 ? rawName : `Okänd enhet (${mac.toUpperCase()})`;
    const rssi: number = peripheral.rssi ?? -100;

    if (!seen.has(id)) {
      logConnectionEvent({ type: 'scan_start', detail: `Found: ${name} (${mac}) rssi=${rssi}` });
    }
    seen.set(id, { id, name, rssi });
  };

  try {
    // ALWAYS call waitForPoweredOnAsync — noble's internal scan requires its own
    // stateChange event, not just our adapter-state shim. Isolated tests show scan
    // resolves in <10ms when this is called first.
    logConnectionEvent({ type: 'scan_start', detail: 'Calling waitForPoweredOnAsync(5000)...' });
    try {
      await withTimeout((noble as any).waitForPoweredOnAsync(5000), 'waitForPoweredOnAsync', 5500);
      logConnectionEvent({ type: 'scan_start', detail: 'Adapter ready via noble stateChange' });
    } catch (e: any) {
      logConnectionEvent({ type: 'scan_start', detail: `waitForPoweredOnAsync failed: ${e.message} — proceeding anyway` });
    }

    logConnectionEvent({ type: 'scan_start', detail: 'Starting scan (allowDuplicates=true)' });
    noble.on('discover', onDiscover);
    await withTimeout(noble.startScanningAsync([], true), 'startScanningAsync');

    await new Promise(r => setTimeout(r, timeoutMs));

    await withTimeout(noble.stopScanningAsync(), 'stopScanningAsync', 3000);
    logConnectionEvent({ type: 'scan_done', detail: `Stopped. Raw events=${discoverCount}, unique=${seen.size}` });
  } catch (e: any) {
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e.message}` });
    console.error(`[BLE] scan error: ${e.message}`);
    try { await withTimeout(noble.stopScanningAsync(), 'stopScanningAsync(cleanup)', 3000); } catch {}
  } finally {
    noble.removeListener('discover', onDiscover);
  }

  lastScanResults = Array.from(seen.values());
  scanning = false;

  if (lastScanResults.length === 0) {
    logConnectionEvent({ type: 'scan_done', detail: `0 devices — är BLEDOM på och i närheten? Adapter=${getAdapterState()}` });
  } else {
    logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) found` });
  }
  return lastScanResults;
}
