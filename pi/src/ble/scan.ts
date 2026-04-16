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

  // Restart bluetoothd to ensure it owns the adapter (noble may have locked it)
  try {
    execFileSync('systemctl', ['restart', 'bluetooth'], { timeout: 5000, stdio: 'ignore' });
    // Wait for daemon to be ready
    execFileSync('bash', ['-c', 'sleep 1'], { timeout: 3000 });
  } catch (e: any) {
    console.warn('[BLE] Failed to restart bluetooth service:', e.message);
  }

  // Run scan and capture output directly (bluetoothctl devices doesn't show discovered devices)
  const scanCmd = `bluetoothctl --timeout ${scanSeconds} scan le 2>&1`;
  const execTimeoutMs = (scanSeconds * 1000) + 5000;

  let scanOutput = '';
  try {
    scanOutput = execFileSync('bash', ['-lc', scanCmd], {
      timeout: execTimeoutMs,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    scanOutput = typeof e?.stdout === 'string' ? e.stdout
      : Buffer.isBuffer(e?.stdout) ? e.stdout.toString('utf-8') : '';
  }

  // Strip ANSI escape codes (bluetoothctl embeds color codes)
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const cleanOutput = stripAnsi(scanOutput || '');

  // Parse [NEW] Device lines from scan output (these are the actual discoveries)
  const seen = new Map<string, DiscoveredDevice>();
  for (const line of cleanOutput.split('\n')) {
    // Match: [NEW] Device XX:XX:XX:XX:XX:XX Name
    const match = line.match(/\[NEW\]\s+Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+(.*)/);
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

  // Also try to extract RSSI from [CHG] lines
  for (const line of (scanOutput || '').split('\n')) {
    const rssiMatch = line.match(/\[CHG\]\s+Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+RSSI:\s+\S+\s+\((-?\d+)\)/);
    if (!rssiMatch) continue;
    const id = rssiMatch[1].replace(/:/g, '').toLowerCase();
    const rssi = parseInt(rssiMatch[2], 10);
    const existing = seen.get(id);
    if (existing) existing.rssi = rssi;
  }

  lastScanResults = Array.from(seen.values());
  scanning = false;
  logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s)` });
  return lastScanResults;
}
