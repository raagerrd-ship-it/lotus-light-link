/**
 * BLE scanning — hybrid discovery via hcitool temp-file capture.
 *
 * Noble remains the GATT/connect transport, but Raspberry Pi discovery is more
 * reliable through `hcitool lescan` as documented in project memory.
 */

import { execFileSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { getAdapterState, processHasBtCaps, logConnectionEvent } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { ensureAdapterUp } from './adapter.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

function parseHcitoolScan(raw: string): DiscoveredDevice[] {
  const seen = new Map<string, DiscoveredDevice>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'LE Scan ...') continue;
    if (/^Set scan parameters failed/i.test(trimmed)) continue;
    if (/^Could not start scanning/i.test(trimmed)) continue;
    if (/^Interrupted system call/i.test(trimmed)) continue;

    const match = trimmed.match(/^([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i);
    if (!match) continue;

    const mac = match[1].toUpperCase();
    const id = mac.replace(/:/g, '').toLowerCase();
    const rawName = (match[2] ?? '').trim();
    const name = rawName && rawName !== '(unknown)' ? rawName : `Okänd enhet (${mac})`;

    if (!seen.has(id)) {
      logConnectionEvent({ type: 'scan_start', detail: `Found: ${name} (${mac}) via hcitool` });
    }
    seen.set(id, { id, name, rssi: -100 });
  }

  return Array.from(seen.values());
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

  const tmpPath = `/tmp/lotus-ble-scan-${process.pid}-${Date.now()}.txt`;

  try {
    const adapterState = getAdapterState();
    const hasCaps = processHasBtCaps();
    logConnectionEvent({
      type: 'scan_start',
      detail: `hcitool scan, timeout=${timeoutMs}ms, adapter=${adapterState}, caps=${hasCaps}`,
    });

    try { await ensureAdapterUp(); } catch {}

    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    execFileSync('bash', ['-lc',
      `rfkill unblock bluetooth >/dev/null 2>&1 || true; ` +
      `((command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1) || true); ` +
      `timeout ${timeoutSeconds}s hcitool lescan --duplicates > '${tmpPath}' 2>&1 || true; ` +
      `pkill -f "hcitool lescan" >/dev/null 2>&1 || true`
    ], { timeout: timeoutMs + 4000, stdio: 'ignore' });

    const raw = readFileSync(tmpPath, 'utf8');
    lastScanResults = parseHcitoolScan(raw);

    if (lastScanResults.length === 0) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `0 devices via hcitool — är BLEDOM på och i närheten? Adapter=${getAdapterState()}`,
      });
    } else {
      logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) found via hcitool` });
    }

    return lastScanResults;
  } catch (e: any) {
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e.message}` });
    console.error(`[BLE] scan error: ${e.message}`);
    return lastScanResults;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
    scanning = false;
  }
}
