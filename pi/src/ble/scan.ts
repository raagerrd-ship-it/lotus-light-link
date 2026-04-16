/**
 * BLE scanning — hybrid strategy.
 *
 * noble.startScanningAsync hangs on Raspberry Pi (timeout after 6s) even when
 * adapter is poweredOn and HCI works. We fall back to `hcitool lescan` which
 * is reliable on the Pi, then parse stdout for MAC + name.
 *
 * noble is still used for GATT connect/read/write — only discovery is shelled out.
 */

import { spawn } from 'child_process';
import { logConnectionEvent, getAdapterState, processHasBtCaps } from './state.js';
import type { DiscoveredDevice } from './types.js';

// ── Scan state ──
let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }

/**
 * Run `hcitool lescan` for `timeoutMs` and parse stdout.
 * Returns devices keyed by MAC; later lines with a real name overwrite "(unknown)".
 */
function hcitoolLescan(timeoutMs: number): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const seen = new Map<string, DiscoveredDevice>();
    const proc = spawn('hcitool', ['lescan', '--duplicates'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';

    const macRegex = /^([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+(.*)$/;

    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.trim().match(macRegex);
        if (!m) continue;
        const mac = m[1].toUpperCase();
        const rawName = m[2].trim();
        const id = mac.replace(/:/g, '').toLowerCase();
        const isUnknown = rawName === '(unknown)' || rawName.length === 0;
        const existing = seen.get(id);
        // Prefer entries with a real name
        if (!existing || (existing.name.startsWith('Okänd') && !isUnknown)) {
          const name = isUnknown ? `Okänd enhet (${mac})` : rawName;
          seen.set(id, { id, name, rssi: -100 });
          if (!existing) {
            logConnectionEvent({ type: 'scan_start', detail: `Found: ${name} (${mac})` });
          } else if (!isUnknown) {
            logConnectionEvent({ type: 'scan_start', detail: `Resolved name: ${name} (${mac})` });
          }
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    const cleanup = () => {
      try { proc.kill('SIGINT'); } catch {}
      // Force kill if it doesn't exit
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
    };

    const stopTimer = setTimeout(cleanup, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(stopTimer);
      logConnectionEvent({ type: 'scan_done', detail: `hcitool spawn error: ${err.message}` });
      resolve([]);
    });

    proc.on('close', (code) => {
      clearTimeout(stopTimer);
      if (stderrBuf && seen.size === 0) {
        logConnectionEvent({ type: 'scan_done', detail: `hcitool stderr: ${stderrBuf.trim().slice(0, 200)}` });
      }
      resolve(Array.from(seen.values()));
    });
  });
}

/**
 * Scan for BLE devices using hcitool lescan (noble's scan hangs on Pi).
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
  logConnectionEvent({ type: 'scan_start', detail: `hcitool scan, timeout=${timeoutMs}ms, adapter=${adapterState}, caps=${hasCaps}` });

  try {
    lastScanResults = await hcitoolLescan(timeoutMs);
    logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) found` });
  } catch (e: any) {
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e.message}` });
    console.error(`[BLE] scan error: ${e.message}`);
  } finally {
    scanning = false;
  }

  if (lastScanResults.length === 0) {
    logConnectionEvent({ type: 'scan_done', detail: `0 devices — är BLEDOM på och i närheten? Adapter=${getAdapterState()}` });
  }
  return lastScanResults;
}
