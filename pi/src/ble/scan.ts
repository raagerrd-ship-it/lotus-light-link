/**
 * BLE scanning — pure bluetoothctl discovery.
 *
 * This module only handles device discovery via bluetoothctl.
 * Connection is handled by discover.ts.
 */

import { execFileSync } from 'child_process';
import { logConnectionEvent } from './state.js';
import { stopNoble } from './adapter.js';
import type { DiscoveredDevice } from './types.js';

// ── Scan state ──
let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

/**
 * Scan for BLE devices using bluetoothctl.
 * Releases noble's HCI socket first to avoid contention.
 */
export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) return lastScanResults;
  scanning = true;
  lastScanResults = [];

  const scanSeconds = Math.max(2, Math.ceil(timeoutMs / 1000));
  logConnectionEvent({ type: 'scan_start', detail: `bluetoothctl scan, timeout=${scanSeconds}s` });

  // Release HCI from noble before bluetoothctl uses it
  stopNoble();

  const cmd = `bluetoothctl --timeout ${scanSeconds} scan le >/dev/null 2>&1; bluetoothctl devices`;
  const execTimeoutMs = (scanSeconds * 1000) + 3000;

  let output = '';
  try {
    output = execFileSync('bash', ['-lc', cmd], {
      timeout: execTimeoutMs,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    output = typeof e?.stdout === 'string' ? e.stdout
      : Buffer.isBuffer(e?.stdout) ? e.stdout.toString('utf-8') : '';
  }

  const seen = new Map<string, DiscoveredDevice>();
  for (const line of (output || '').split('\n')) {
    const match = line.trim().match(/^Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+(.*)$/);
    if (!match) continue;
    const [, mac, rawName] = match;
    const id = mac.replace(/:/g, '').toLowerCase();
    const trimmedName = rawName.trim();
    const name = trimmedName.length === 0 || trimmedName.match(/^[0-9A-Fa-f]{2}(-[0-9A-Fa-f]{2}){5}$/)
      ? `Okänd enhet (${mac.toUpperCase()})`
      : trimmedName;
    if (!seen.has(id)) console.log(`[BLE] discovered: ${name} (${mac})`);
    seen.set(id, { id, name, rssi: -50 });
  }

  lastScanResults = Array.from(seen.values());
  scanning = false;
  logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s)` });
  return lastScanResults;
}
