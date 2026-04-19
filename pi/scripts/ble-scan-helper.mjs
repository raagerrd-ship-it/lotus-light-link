#!/usr/bin/env node
/**
 * BLE scan-helper — så enkelt det går.
 *
 * Kör `hcitool -i hci0 lescan --duplicates` i exakt timeoutMs ms,
 * samlar alla unika MAC-adresser och deras namn, returnerar JSON.
 *
 * Inga early-exit, inga fallback-verktyg, ingen noble-import.
 *
 * Argument: [timeoutMs]   (default 3000)
 *
 * Stdout (sista raden): JSON {devices, rawLineCount, exitCode, stderr, durationMs, tool}
 */

import { spawn } from 'node:child_process';

const timeoutMs = Math.max(500, parseInt(process.argv[2] ?? '3000', 10) || 3000);
const MAC_LINE = /^([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i;

const startedAt = Date.now();
const found = new Map(); // id (lowercase, no colons) -> { id, name, rssi }
let rawLineCount = 0;
let stderr = '';

function recordDevice(mac, rawName) {
  const id = mac.replace(/:/g, '').toLowerCase();
  const cleanName = rawName && rawName !== '(unknown)' && rawName.trim()
    ? rawName.trim()
    : null;
  const prev = found.get(id);
  if (!prev) {
    found.set(id, { id, name: cleanName ?? `(no-name) ${mac}`, rssi: -100 });
  } else if (cleanName && prev.name.startsWith('(no-name)')) {
    // Uppgradera till riktigt namn när det dyker upp
    prev.name = cleanName;
  }
}

process.stderr.write(`[scan-helper] hcitool -i hci0 lescan --duplicates (${timeoutMs}ms)\n`);

let proc;
try {
  proc = spawn('hcitool', ['-i', 'hci0', 'lescan', '--duplicates'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  process.stdout.write(JSON.stringify({
    devices: [], rawLineCount: 0, exitCode: null,
    startError: e?.message ?? String(e),
    stderr: '', tool: 'hcitool', durationMs: 0,
  }) + '\n');
  process.exit(0);
}

proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');

proc.stdout.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rawLineCount++;
    const m = trimmed.match(MAC_LINE);
    if (!m) continue;
    recordDevice(m[1].toUpperCase(), (m[2] ?? '').trim());
  }
});
proc.stderr.on('data', (c) => { stderr += c; });

// Låt hcitool köra hela timeouten, sen SIGINT (graceful) → SIGKILL fallback.
const killTimer = setTimeout(() => {
  try { proc.kill('SIGINT'); } catch {}
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
}, timeoutMs);

const exitCode = await new Promise((resolve) => {
  proc.once('exit', (code) => { clearTimeout(killTimer); resolve(code); });
  proc.once('error', () => { clearTimeout(killTimer); resolve(null); });
});

process.stdout.write(JSON.stringify({
  devices: Array.from(found.values()),
  rawLineCount,
  exitCode: exitCode ?? 0,
  startError: null,
  stderr: stderr.trim(),
  tool: 'hcitool',
  durationMs: Date.now() - startedAt,
}) + '\n');

setTimeout(() => process.exit(0), 50);
