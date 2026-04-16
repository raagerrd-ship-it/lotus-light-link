/**
 * BLE scanning — noble's official async scan API.
 *
 * Uses noble.startScanningAsync / stopScanningAsync with 'discover' events.
 * No shell exec, no ANSI parsing, no HCI socket juggling.
 */

import { noble, logConnectionEvent, getAdapterState, processHasBtCaps } from './state.js';
import type { DiscoveredDevice } from './types.js';

// ── Scan state ──
let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;
const SCAN_STEP_TIMEOUT_MS = 6000;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

/**
 * Scan for BLE devices using noble's native async API.
 * Returns discovered devices with name and RSSI.
 */
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
 * Returns discovered devices with name and RSSI.
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
    if (!mac || mac === 'unknown') {
      logConnectionEvent({ type: 'scan_start', detail: `Ignored peripheral: no MAC (uuid=${peripheral.uuid ?? '?'})` });
      return;
    }
    const id = mac.replace(/:/g, '').toLowerCase();
    const rawName: string = peripheral.advertisement?.localName ?? '';
    const name = rawName.length > 0
      ? rawName
      : `Okänd enhet (${mac.toUpperCase()})`;
    const rssi: number = peripheral.rssi ?? -100;

    if (!seen.has(id)) {
      logConnectionEvent({ type: 'scan_start', detail: `Found: ${name} (${mac}) rssi=${rssi}` });
    }
    seen.set(id, { id, name, rssi });
  };

  try {
    logConnectionEvent({ type: 'scan_start', detail: 'Waiting for adapter poweredOn...' });
    await (noble as any).waitForPoweredOnAsync(5000);
    logConnectionEvent({ type: 'scan_start', detail: `Adapter ready, starting scan (allowDuplicates=true)` });

    noble.on('discover', onDiscover);
    await noble.startScanningAsync([], true);

    await new Promise(r => setTimeout(r, timeoutMs));

    await noble.stopScanningAsync();
    logConnectionEvent({ type: 'scan_done', detail: `Stopped. Raw events=${discoverCount}, unique=${seen.size}` });
  } catch (e: any) {
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e.message}` });
    console.error(`[BLE] scan error: ${e.message}`);
    try { await noble.stopScanningAsync(); } catch {}
  } finally {
    noble.removeListener('discover', onDiscover);
  }

  lastScanResults = Array.from(seen.values());
  scanning = false;

  if (lastScanResults.length === 0) {
    logConnectionEvent({ type: 'scan_done', detail: `0 devices — tips: är BLEDOM på och i närheten? Adapter=${getAdapterState()}` });
  } else {
    logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) found` });
  }
  return lastScanResults;
}
