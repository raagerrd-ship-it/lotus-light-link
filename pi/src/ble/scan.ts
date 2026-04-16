/**
 * BLE scanning — noble's official async scan API.
 *
 * Uses noble.startScanningAsync / stopScanningAsync with 'discover' events.
 * No shell exec, no ANSI parsing, no HCI socket juggling.
 */

import { noble, logConnectionEvent } from './state.js';
import type { DiscoveredDevice } from './types.js';

// ── Scan state ──
let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

/**
 * Scan for BLE devices using noble's native async API.
 * Returns discovered devices with name and RSSI.
 */
export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) return lastScanResults;
  scanning = true;
  lastScanResults = [];

  logConnectionEvent({ type: 'scan_start', detail: `noble scan, timeout=${timeoutMs}ms` });

  const seen = new Map<string, DiscoveredDevice>();

  const onDiscover = (peripheral: any) => {
    const mac: string = peripheral.address ?? '';
    if (!mac || mac === 'unknown') return;
    const id = mac.replace(/:/g, '').toLowerCase();
    const rawName: string = peripheral.advertisement?.localName ?? '';
    const name = rawName.length > 0
      ? rawName
      : `Okänd enhet (${mac.toUpperCase()})`;
    const rssi: number = peripheral.rssi ?? -100;

    if (!seen.has(id)) {
      console.log(`[BLE] discovered: ${name} (${mac}) rssi=${rssi}`);
    }
    // Update RSSI on duplicates (allow duplicates = true)
    seen.set(id, { id, name, rssi });
  };

  try {
    // Wait for adapter to be ready
    const state = (noble as any).state ?? (noble as any)._state;
    if (state !== 'poweredOn') {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Adapter not ready')), 5000);
        const check = (s: string) => {
          if (s === 'poweredOn') { clearTimeout(timeout); resolve(); }
        };
        if (((noble as any).state ?? (noble as any)._state) === 'poweredOn') {
          clearTimeout(timeout);
          resolve();
        } else {
          noble.once('stateChange', check);
        }
      });
    }

    noble.on('discover', onDiscover);
    await noble.startScanningAsync([], true); // all services, allow duplicates

    // Collect discoveries for timeoutMs
    await new Promise(r => setTimeout(r, timeoutMs));

    await noble.stopScanningAsync();
  } catch (e: any) {
    console.error(`[BLE] scan error: ${e.message}`);
    try { await noble.stopScanningAsync(); } catch {}
  } finally {
    noble.removeListener('discover', onDiscover);
  }

  lastScanResults = Array.from(seen.values());
  scanning = false;
  logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s)` });
  return lastScanResults;
}
