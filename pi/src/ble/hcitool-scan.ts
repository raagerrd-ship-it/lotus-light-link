/**
 * Wrapper runt fristående hcitool-scan-helper.
 * Separat process undviker HCI-konflikten vi såg när hcitool kördes inline
 * i samma Node-process som noble.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { logConnectionEvent } from './state.js';
import type { DiscoveredDevice } from './types.js';

export interface HcitoolScanResult {
  devices: DiscoveredDevice[];
  rawLineCount: number;
  exitCode: number | null;
  startError: string | null;
  stderr: string;
  durationMs: number;
  tool: 'hcitool' | 'btmgmt';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveHelperPath(): string {
  const candidates = [
    resolve(__dirname, '../../scripts/ble-scan-helper.mjs'),
    resolve(__dirname, '../../../scripts/ble-scan-helper.mjs'),
    resolve(process.cwd(), 'pi/scripts/ble-scan-helper.mjs'),
    resolve(process.cwd(), 'scripts/ble-scan-helper.mjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

export async function hcitoolLescan(timeoutMs: number): Promise<HcitoolScanResult> {
  const startedAt = Date.now();
  const helperPath = resolveHelperPath();

  if (!existsSync(helperPath)) {
    const err = `scan-helper saknas på disk: ${helperPath}`;
    logConnectionEvent({ type: 'scan_start', detail: err });
    return { devices: [], rawLineCount: 0, exitCode: null, startError: err, stderr: '', durationMs: 0, tool: 'hcitool' };
  }

  let proc;
  try {
    proc = spawn(process.execPath, [helperPath, String(timeoutMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    const err = e?.message ?? String(e);
    return { devices: [], rawLineCount: 0, exitCode: null, startError: err, stderr: '', durationMs: 0, tool: 'hcitool' };
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (c: string) => { stdoutBuf += c; });
  proc.stderr?.on('data', (c: string) => { stderrBuf += c; });

  const hardKillMs = timeoutMs + 3000;
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGINT'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
  }, hardKillMs);

  const exitCode = await new Promise<number | null>((resolveExit) => {
    proc.once('exit', (code) => { clearTimeout(killTimer); resolveExit(code); });
    proc.once('error', () => { clearTimeout(killTimer); resolveExit(null); });
  });

  const durationMs = Date.now() - startedAt;
  const lines = stdoutBuf.split('\n').map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];

  if (!lastLine) {
    return {
      devices: [],
      rawLineCount: 0,
      exitCode,
      startError: 'scan-helper gav inget JSON-svar',
      stderr: stderrBuf.trim(),
      durationMs,
      tool: 'hcitool',
    };
  }

  try {
    const parsed = JSON.parse(lastLine);
    return {
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      rawLineCount: parsed.rawLineCount ?? 0,
      exitCode,
      startError: parsed.startError ?? null,
      stderr: (parsed.stderr ?? stderrBuf).trim(),
      durationMs,
      tool: 'hcitool',
    };
  } catch (e: any) {
    return {
      devices: [],
      rawLineCount: 0,
      exitCode,
      startError: `scan-helper JSON-parse fel: ${e?.message ?? e}`,
      stderr: stderrBuf.trim(),
      durationMs,
      tool: 'hcitool',
    };
  }
}
