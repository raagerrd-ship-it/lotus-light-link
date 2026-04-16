/**
 * BLE scanning — Raspberry Pi hybrid discovery using hcitool.
 *
 * noble's scan state can remain `unknown` on Pi even when the process has the
 * right capabilities. For discovery we therefore use hcitool output and keep
 * noble only for direct GATT connects.
 */

import { execFileSync } from 'child_process';
import { logConnectionEvent, getAdapterState, processHasBtCaps } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

function parseHcitoolScan(raw: string): DiscoveredDevice[] {
  const seen = new Map<string, DiscoveredDevice>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^LE Scan/i.test(trimmed) || /^Set scan /i.test(trimmed)) continue;

    const match = trimmed.match(/^([0-9A-Fa-f:]{17})(?:\s+(.*))?$/);
    if (!match) continue;

    const mac = match[1].toLowerCase();
    const id = mac.replace(/:/g, '');
    const rawName = match[2]?.trim() ?? '';
    const name = rawName.length > 0 ? rawName : `Okänd enhet (${mac.toUpperCase()})`;

    if (!seen.has(id)) {
      logConnectionEvent({ type: 'scan_start', detail: `Found: ${name} (${mac}) via hcitool` });
    }

    seen.set(id, {
      id,
      name,
      rssi: -100,
    });
  }

  return Array.from(seen.values());
}

function scanWithHcitool(timeoutMs: number): DiscoveredDevice[] {
  const seconds = Math.max(2, Math.ceil(timeoutMs / 1000));
  const tmpFile = `/tmp/lotus-hcitool-scan-${process.pid}.txt`;
  const command = [
    'rfkill unblock bluetooth >/dev/null 2>&1 || true',
    '(command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 reset >/dev/null 2>&1) || true',
    `rm -f "${tmpFile}"`,
    `timeout ${seconds} hcitool lescan --duplicates > "${tmpFile}" 2>&1 || true`,
    `cat "${tmpFile}" 2>/dev/null || true`,
    `rm -f "${tmpFile}"`,
  ].join('; ');

  const raw = execFileSync('bash', ['-lc', command], {
    encoding: 'utf8',
    timeout: timeoutMs + 4000,
  });

  if (/hcitool: command not found/i.test(raw)) {
    throw new Error('hcitool is not installed on this Pi');
  }

  return parseHcitoolScan(raw);
}

export async function scanForDevices(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — scan already running' });
    return lastScanResults;
  }
  // Avoid HCI contention: if noble is currently scanning for a connect target,
  // hcitool will fail to open the socket and leave HCI in a bad state.
  if (isNobleScanActive()) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — noble scan-connect is active (would lock HCI)' });
    return lastScanResults;
  }

  scanning = true;
  lastScanResults = [];

  try {
    const adapterState = getAdapterState();
    const hasCaps = processHasBtCaps();
    logConnectionEvent({ type: 'scan_start', detail: `hybrid scan, timeout=${timeoutMs}ms, adapter=${adapterState}, caps=${hasCaps}` });
    logConnectionEvent({ type: 'scan_start', detail: 'Starting hcitool lescan --duplicates' });

    lastScanResults = scanWithHcitool(timeoutMs);

    if (lastScanResults.length === 0) {
      logConnectionEvent({ type: 'scan_done', detail: `0 devices — är BLEDOM på och i närheten? Adapter=${getAdapterState()}` });
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
    scanning = false;
  }
}
