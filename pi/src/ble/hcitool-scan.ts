/**
 * Hybrid discovery via `hcitool lescan`.
 *
 * noble's startScanningAsync sometimes hangs forever on Raspberry Pi even when
 * the adapter reports poweredOn. As a fallback we spawn `hcitool lescan` in
 * parallel and parse its line-based output ("MAC  NAME"). This bypasses noble
 * entirely for discovery — peripherals found via hcitool can later be connected
 * with the manual MAC flow.
 *
 * Requires `hcitool` to be installed and the process to have CAP_NET_RAW
 * (already granted via systemd AmbientCapabilities).
 */

import { spawn, type ChildProcess } from 'child_process';
import { logConnectionEvent } from './state.js';
import type { DiscoveredDevice } from './types.js';

export interface HcitoolScanResult {
  devices: DiscoveredDevice[];
  rawLineCount: number;
  exitCode: number | null;
  startError: string | null;
  stderr: string;
  durationMs: number;
}

const MAC_LINE = /^([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i;

export async function hcitoolLescan(timeoutMs: number, earlyExitOnPattern?: RegExp): Promise<HcitoolScanResult> {
  const startedAt = Date.now();
  const found = new Map<string, DiscoveredDevice>();
  let rawLineCount = 0;
  let stderr = '';
  let proc: ChildProcess | null = null;
  let startError: string | null = null;
  let earlyExit = false;

  try {
    proc = spawn('hcitool', ['-i', 'hci0', 'lescan', '--duplicates'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    startError = e?.message ?? String(e);
    logConnectionEvent({ type: 'scan_start', detail: `hcitool spawn failed: ${startError}` });
    return { devices: [], rawLineCount: 0, exitCode: null, startError, stderr: '', durationMs: 0 };
  }

  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');

  const killProc = () => {
    try { proc?.kill('SIGINT'); } catch {}
    setTimeout(() => { try { proc?.kill('SIGKILL'); } catch {} }, 500);
  };

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
      const name = rawName && rawName !== '(unknown)' ? rawName : `(no-name) ${mac}`;
      const prev = found.get(id);
      if (!prev || (rawName && rawName !== '(unknown)' && prev.name.startsWith('(no-name)'))) {
        found.set(id, { id, name, rssi: -100 });
        // Early-exit om vi hittar en intressant enhet (t.ex. BLEDOM).
        if (!earlyExit && earlyExitOnPattern && rawName && earlyExitOnPattern.test(rawName)) {
          earlyExit = true;
          logConnectionEvent({ type: 'scan_start', detail: `hcitool early-exit: hittade ${rawName} (${mac}) — stoppar scan` });
          killProc();
        }
      }
    }
  });

  proc.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const killTimer = setTimeout(killProc, timeoutMs);
    proc!.once('exit', (code) => {
      clearTimeout(killTimer);
      settle(code);
    });
    proc!.once('error', (e: any) => {
      clearTimeout(killTimer);
      startError = e?.message ?? String(e);
      settle(null);
    });
  });

  const durationMs = Date.now() - startedAt;
  const devices = Array.from(found.values());

  if (devices.length === 0 && stderr) {
    logConnectionEvent({
      type: 'scan_done',
      detail: `hcitool: 0 devices, stderr="${stderr.trim().slice(0, 160)}"`,
    });
  } else if (devices.length > 0) {
    logConnectionEvent({
      type: 'scan_done',
      detail: `hcitool: ${devices.length} device(s) found (raw_lines=${rawLineCount})`,
    });
  } else {
    logConnectionEvent({
      type: 'scan_done',
      detail: `hcitool: 0 devices, raw_lines=${rawLineCount}, exit=${exitCode}`,
    });
  }

  return { devices, rawLineCount, exitCode, startError, stderr: stderr.trim(), durationMs };
}
