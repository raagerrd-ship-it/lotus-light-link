/**
 * Hybrid discovery via fristående `hcitool lescan` i en SUBPROCESS.
 *
 * Noble håller HCI-socketen i huvudprocessen, vilket gör att hcitool i samma
 * process får "Set scan parameters failed: I/O error". Lösningen: spawn:a en
 * fristående Node-helper (`pi/scripts/ble-scan-helper.mjs`) som INTE importerar
 * noble — då släpps inte socketen från noble, men helpern kan inte heller
 * konkurrera med någon noble-binding eftersom den inte har en. Innan vi spawnar
 * stoppar vi noble's HCI-binding via `hci.stop()` så hcitool får exklusiv
 * tillgång till adaptern. Efter scan startar vi noble igen via `restartNobleHci`.
 *
 * Helpern returnerar JSON via stdout med devices, raw-linjer, exit-kod osv.
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
  /** Vilket scan-verktyg som faktiskt användes (btmgmt/bluetoothctl/hcitool/none) */
  tool?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Hitta scan-helper. dist/ble/hcitool-scan.js → ../../scripts/ble-scan-helper.mjs */
function resolveHelperPath(): string {
  const candidates = [
    resolve(__dirname, '../../scripts/ble-scan-helper.mjs'),       // från dist/ble
    resolve(__dirname, '../../../scripts/ble-scan-helper.mjs'),    // fallback
    resolve(process.cwd(), 'pi/scripts/ble-scan-helper.mjs'),      // dev
    resolve(process.cwd(), 'scripts/ble-scan-helper.mjs'),         // pi-cwd
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]; // bästa gissning för fel-rapport
}

export async function hcitoolLescan(timeoutMs: number, earlyExitOnPattern?: RegExp): Promise<HcitoolScanResult> {
  const startedAt = Date.now();
  const helperPath = resolveHelperPath();

  if (!existsSync(helperPath)) {
    const err = `scan-helper saknas på disk: ${helperPath}`;
    logConnectionEvent({ type: 'scan_start', detail: err });
    return { devices: [], rawLineCount: 0, exitCode: null, startError: err, stderr: '', durationMs: 0 };
  }

  const earlyArg = earlyExitOnPattern ? earlyExitOnPattern.source : '';
  const args = [helperPath, String(timeoutMs), earlyArg];

  let proc;
  try {
    proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    const err = e?.message ?? String(e);
    logConnectionEvent({ type: 'scan_start', detail: `scan-helper spawn failed: ${err}` });
    return { devices: [], rawLineCount: 0, exitCode: null, startError: err, stderr: '', durationMs: 0 };
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (c: string) => { stdoutBuf += c; });
  proc.stderr?.on('data', (c: string) => { stderrBuf += c; });

  // Hård timeout: helpern ska vara klar inom timeoutMs + 3s buffert.
  const hardKillMs = timeoutMs + 3000;
  let killed = false;
  const killTimer = setTimeout(() => {
    killed = true;
    try { proc.kill('SIGINT'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
  }, hardKillMs);

  const exitCode = await new Promise<number | null>((resolveExit) => {
    proc.once('exit', (code) => { clearTimeout(killTimer); resolveExit(code); });
    proc.once('error', () => { clearTimeout(killTimer); resolveExit(null); });
  });

  const durationMs = Date.now() - startedAt;

  // Plocka sista non-empty raden i stdout — det är JSON-payloaden.
  const lines = stdoutBuf.split('\n').map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];

  if (!lastLine) {
    const err = killed ? 'scan-helper hard-killed (timeout)' : 'scan-helper gav inget JSON-svar';
    logConnectionEvent({ type: 'scan_done', detail: `${err} stderr="${stderrBuf.trim().slice(0, 200)}"` });
    return { devices: [], rawLineCount: 0, exitCode, startError: err, stderr: stderrBuf.trim(), durationMs };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(lastLine);
  } catch (e: any) {
    const err = `scan-helper JSON-parse fel: ${e?.message ?? e}`;
    logConnectionEvent({ type: 'scan_done', detail: `${err} payload="${lastLine.slice(0, 160)}"` });
    return { devices: [], rawLineCount: 0, exitCode, startError: err, stderr: stderrBuf.trim(), durationMs };
  }

  const devices: DiscoveredDevice[] = Array.isArray(parsed.devices) ? parsed.devices : [];
  const rawLineCount: number = parsed.rawLineCount ?? 0;
  const helperStderr: string = parsed.stderr ?? '';
  const startError: string | null = parsed.startError ?? null;

  if (devices.length === 0) {
    logConnectionEvent({
      type: 'scan_done',
      detail: `scan-helper: 0 devices, raw_lines=${rawLineCount}, exit=${exitCode}, stderr="${helperStderr.slice(0, 160) || stderrBuf.slice(0, 160)}"`,
    });
  } else {
    logConnectionEvent({
      type: 'scan_done',
      detail: `scan-helper: ${devices.length} device(s) (raw_lines=${rawLineCount}, dur=${durationMs}ms)`,
    });
  }

  return {
    devices,
    rawLineCount,
    exitCode,
    startError,
    stderr: helperStderr || stderrBuf.trim(),
    durationMs,
  };
}
