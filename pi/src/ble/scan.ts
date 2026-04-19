/**
 * BLE scanning — kör `hcitool -i hci0 lescan --duplicates` direkt från engine.
 *
 * Inga subprocess-helpers, ingen JSON-roundtrip, ingen noble-stop. hcitool och
 * noble öppnar separata raw HCI-socklar (båda har CAP_NET_RAW via setup-lotus.sh)
 * och kan köra parallellt utan konflikt.
 */

import { spawn } from 'child_process';
import { getAdapterState, logConnectionEvent, getNobleRawState } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

// Cache av peripheral-objekt indexerat på normaliserat id (lowercase, utan kolon).
// Behålls för API-kompabilitet med connect.ts; hcitool fyller den inte.
const discoveredPeripherals = new Map<string, any>();

const MAC_LINE = /^([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i;

export interface BleScanMetrics {
  phase: 'idle' | 'scanning';
  active: boolean;
  activeSince: string | null;
  lastScanId: number;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  lastDurationMs: number | null;
  lastRawLineCount: number;
  lastResultCount: number;
  lastExitCode: number | null;
  lastStartError: string | null;
  lastStderr: string;
}

let _scanSeq = 0;
const scanMetrics: BleScanMetrics = {
  phase: 'idle',
  active: false,
  activeSince: null,
  lastScanId: 0,
  lastStartedAt: null,
  lastStoppedAt: null,
  lastDurationMs: null,
  lastRawLineCount: 0,
  lastResultCount: 0,
  lastExitCode: null,
  lastStartError: null,
  lastStderr: '',
};

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }
export function getScanMetrics(): BleScanMetrics { return { ...scanMetrics }; }
export function getDiscoveredPeripheral(id: string): any | undefined {
  return discoveredPeripherals.get(id.toLowerCase());
}

export async function scanForDevices(timeoutMs = 3000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — scan already running' });
    return lastScanResults;
  }
  if (isNobleScanActive()) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — noble scan-connect is active (would lock HCI)' });
    return lastScanResults;
  }

  scanning = true;
  discoveredPeripherals.clear();
  const found = new Map<string, DiscoveredDevice>();
  const scanStartedAt = Date.now();
  const scanId = ++_scanSeq;
  scanMetrics.phase = 'scanning';
  scanMetrics.active = true;
  scanMetrics.activeSince = new Date(scanStartedAt).toISOString();
  scanMetrics.lastScanId = scanId;
  scanMetrics.lastStartedAt = new Date(scanStartedAt).toISOString();
  scanMetrics.lastStoppedAt = null;
  scanMetrics.lastDurationMs = null;
  scanMetrics.lastRawLineCount = 0;
  scanMetrics.lastResultCount = 0;
  scanMetrics.lastExitCode = null;
  scanMetrics.lastStartError = null;
  scanMetrics.lastStderr = '';

  let rawLineCount = 0;
  let stderrBuf = '';
  let exitCode: number | null = null;
  let startError: string | null = null;

  logConnectionEvent({
    type: 'scan_start',
    detail: `hcitool lescan ${timeoutMs}ms (parallel mode), adapter=${getAdapterState()}, noble=${getNobleRawState() ?? 'unknown'}`,
  });

  try {
    let proc;
    try {
      proc = spawn('hcitool', ['-i', 'hci0', 'lescan', '--duplicates'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      startError = e?.message ?? String(e);
      throw e;
    }

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');

    proc.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        rawLineCount++;
        const m = trimmed.match(MAC_LINE);
        if (!m) continue;
        const mac = m[1].toUpperCase();
        const id = mac.replace(/:/g, '').toLowerCase();
        const rawName = (m[2] ?? '').trim();
        const cleanName = rawName && rawName !== '(unknown)' ? rawName : null;
        const prev = found.get(id);
        if (!prev) {
          found.set(id, {
            id,
            name: cleanName ?? `(no-name) ${mac}`,
            rssi: -100,
            source: 'hcitool',
          });
        } else if (cleanName && prev.name.startsWith('(no-name)')) {
          prev.name = cleanName;
        }
      }
    });
    proc.stderr?.on('data', (c: string) => { stderrBuf += c; });

    // SIGINT efter timeout, SIGKILL som hård fallback.
    const killTimer = setTimeout(() => {
      try { proc!.kill('SIGINT'); } catch {}
      setTimeout(() => { try { proc!.kill('SIGKILL'); } catch {} }, 500);
    }, timeoutMs);

    exitCode = await new Promise<number | null>((resolve) => {
      proc!.once('exit', (code) => { clearTimeout(killTimer); resolve(code); });
      proc!.once('error', (err) => {
        clearTimeout(killTimer);
        startError = err?.message ?? String(err);
        resolve(null);
      });
    });

    lastScanResults = Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));

    logConnectionEvent({
      type: 'scan_done',
      detail: lastScanResults.length === 0
        ? `0 devices — raw_lines=${rawLineCount}, exit=${exitCode}, stderr="${stderrBuf.trim().slice(0, 200) || 'none'}"`
        : `${lastScanResults.length} device(s) (raw_lines=${rawLineCount}, dur=${Date.now() - scanStartedAt}ms)`,
    });

    return lastScanResults;
  } catch (e: any) {
    if (!startError) startError = e?.message ?? String(e);
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${startError}` });
    console.error(`[BLE] scan error: ${startError}`);
    return lastScanResults;
  } finally {
    scanMetrics.phase = 'idle';
    scanMetrics.active = false;
    scanMetrics.activeSince = null;
    scanMetrics.lastStoppedAt = new Date().toISOString();
    scanMetrics.lastDurationMs = Date.now() - scanStartedAt;
    scanMetrics.lastRawLineCount = rawLineCount;
    scanMetrics.lastResultCount = lastScanResults.length;
    scanMetrics.lastExitCode = exitCode;
    scanMetrics.lastStartError = startError;
    scanMetrics.lastStderr = stderrBuf.trim().slice(0, 500);
    scanning = false;
  }
}
