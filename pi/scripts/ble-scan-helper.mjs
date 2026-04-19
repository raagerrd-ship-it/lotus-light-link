#!/usr/bin/env node
/**
 * Fristående BLE scan-helper.
 *
 * Importerar INTE noble — håller därmed inte HCI-socketen öppen.
 *
 * Strategi: kör ENBART `hcitool -i hci0 lescan --duplicates`.
 * - btmgmt failar med "Busy" när bluetoothd är aktiv (vilket den alltid är).
 * - bluetoothctl behöver dbus-session och är opålitlig.
 * - hcitool har CAP_NET_RAW satt via setup-lotus.sh och fungerar utan sudo.
 *
 * Argument: [timeoutMs] [earlyExitPattern]
 *
 * Stdout (sista raden): JSON {devices, rawLineCount, exitCode, stderr, durationMs, tool}
 */

import { spawn, spawnSync } from 'node:child_process';

const timeoutMs = Math.max(500, parseInt(process.argv[2] ?? '4000', 10) || 4000);
const earlyPatternStr = process.argv[3] ?? 'BLEDOM';
const earlyPattern = earlyPatternStr ? new RegExp(earlyPatternStr, 'i') : null;

const MAC_LINE = /^([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const startedAt = Date.now();
const found = new Map();
let rawLineCount = 0;
let stderr = '';
let earlyExit = false;

function recordDevice(mac, rawName, rssi = -100) {
  const id = mac.replace(/:/g, '').toLowerCase();
  const name = rawName && rawName !== '(unknown)' && rawName.trim()
    ? rawName.trim()
    : `(no-name) ${mac}`;
  const prev = found.get(id);
  if (!prev || (rawName && rawName !== '(unknown)' && prev.name.startsWith('(no-name)'))) {
    found.set(id, { id, name, rssi: rssi ?? -100 });
    if (!earlyExit && earlyPattern && rawName && earlyPattern.test(rawName)) {
      earlyExit = true;
      process.stderr.write(`[scan-helper] early-exit på ${rawName} (${mac})\n`);
      return true;
    }
  }
  return false;
}

async function runHcitool() {
  const bin = which('hcitool');
  if (!bin) {
    return { exitCode: null, startError: 'hcitool saknas i PATH' };
  }
  process.stderr.write('[scan-helper] kör hcitool -i hci0 lescan --duplicates\n');

  let proc;
  try {
    proc = spawn('hcitool', ['-i', 'hci0', 'lescan', '--duplicates'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { exitCode: null, startError: e?.message ?? String(e) };
  }
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  let killed = false;
  const killProc = () => {
    killed = true;
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
      const rawName = (m[2] ?? '').trim();
      try {
        if (recordDevice(mac, rawName)) killProc();
      } catch {}
    }
  });
  proc.stderr.on('data', (c) => { stderr += c; });

  const timer = setTimeout(killProc, timeoutMs);

  const exitCode = await new Promise((resolve) => {
    proc.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    proc.once('error', () => { clearTimeout(timer); resolve(null); });
  });

  return { exitCode, killed, startError: null };
}

let firstError = null;
try {
  const result = await runHcitool();
  if (result.startError) firstError = result.startError;
  else if (found.size === 0 && rawLineCount === 0) {
    firstError = `hcitool gav ingen output (exit=${result.exitCode}, killed=${result.killed})`;
  }
} catch (e) {
  firstError = e?.message ?? String(e);
}

emit({
  devices: Array.from(found.values()),
  rawLineCount,
  exitCode: 0,
  startError: firstError,
  stderr: stderr.trim(),
  tool: 'hcitool',
  durationMs: Date.now() - startedAt,
});
setTimeout(() => process.exit(0), 50);
