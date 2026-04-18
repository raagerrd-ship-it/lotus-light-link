#!/usr/bin/env node
/**
 * Fristående BLE scan-helper.
 *
 * Importerar INTE noble — håller därmed inte HCI-socketen öppen.
 * Kör `hcitool lescan` mot hci0 och skriver JSON till stdout.
 *
 * Argument: [timeoutMs] [earlyExitPattern]
 *   timeoutMs        — max scan-tid i ms (default 4000)
 *   earlyExitPattern — regex (case-insensitive) som om matchad i namn
 *                       avbryter scan tidigt. Default: BLEDOM
 *
 * Stdout (sista raden): JSON {devices, rawLineCount, exitCode, stderr, durationMs}
 * Stderr: fri text för debug (ignoreras av föräldern).
 */

import { spawn } from 'node:child_process';

const timeoutMs = Math.max(500, parseInt(process.argv[2] ?? '4000', 10) || 4000);
const earlyPatternStr = process.argv[3] ?? 'BLEDOM';
const earlyPattern = earlyPatternStr ? new RegExp(earlyPatternStr, 'i') : null;

const MAC_LINE = /^([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i;

function emit(obj) {
  // Sista stdout-raden: JSON-resultatet.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const startedAt = Date.now();
const found = new Map();
let rawLineCount = 0;
let stderr = '';
let earlyExit = false;

let proc;
try {
  proc = spawn('hcitool', ['-i', 'hci0', 'lescan', '--duplicates'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  emit({
    devices: [],
    rawLineCount: 0,
    exitCode: null,
    startError: e?.message ?? String(e),
    stderr: '',
    durationMs: Date.now() - startedAt,
  });
  process.exit(0);
}

proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');

const killProc = () => {
  try { proc.kill('SIGINT'); } catch {}
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
};

proc.stdout.on('data', (chunk) => {
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
      if (!earlyExit && earlyPattern && rawName && earlyPattern.test(rawName)) {
        earlyExit = true;
        process.stderr.write(`[scan-helper] early-exit på ${rawName} (${mac})\n`);
        killProc();
      }
    }
  }
});

proc.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const killTimer = setTimeout(killProc, timeoutMs);

let settled = false;
const settle = (exitCode, startError = null) => {
  if (settled) return;
  settled = true;
  clearTimeout(killTimer);
  emit({
    devices: Array.from(found.values()),
    rawLineCount,
    exitCode,
    startError,
    stderr: stderr.trim(),
    durationMs: Date.now() - startedAt,
  });
  // Ge stdout en chans att flushas.
  setTimeout(() => process.exit(0), 50);
};

proc.once('exit', (code) => settle(code));
proc.once('error', (e) => settle(null, e?.message ?? String(e)));
