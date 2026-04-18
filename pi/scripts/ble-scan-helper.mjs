#!/usr/bin/env node
/**
 * Fristående BLE scan-helper.
 *
 * Importerar INTE noble — håller därmed inte HCI-socketen öppen.
 *
 * Strategi: prova flera scan-verktyg i ordning tills ett ger resultat:
 *   1. `btmgmt find -l`     — modern BlueZ mgmt-API, samarbetar med bluetoothd
 *   2. `bluetoothctl --timeout N scan le` — interaktiv CLI, använder dbus
 *   3. `hcitool -i hci0 lescan --duplicates` — legacy, kan failure på BlueZ 5.66+
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
// btmgmt-format: "hci0 dev_found: AA:BB:CC:DD:EE:FF type LE Public rssi -65 flags 0x0000"
const BTMGMT_LINE = /dev_found:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){5}).*?rssi\s+(-?\d+)/i;
const BTMGMT_NAME = /name\s+(.+)$/i;
// bluetoothctl: "[NEW] Device AA:BB:CC:DD:EE:FF NAME"
const BCTL_DEV = /Device\s+([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i;

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
let toolUsed = 'none';

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

/**
 * Run one scan tool. Returns when it exits, hits timeout, or early-exit triggers.
 */
async function runTool(cmd, args, parser) {
  let proc;
  try {
    proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { startError: e?.message ?? String(e), exitCode: null };
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
      try {
        if (parser(trimmed)) killProc(); // early exit
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

async function tryBtmgmt() {
  if (!which('btmgmt')) return false;
  toolUsed = 'btmgmt';
  process.stderr.write('[scan-helper] försöker btmgmt find -l\n');
  // -l = LE only. btmgmt find blockerar tills SIGINT eller timeout.
  await runTool('btmgmt', ['find', '-l'], (line) => {
    const m = line.match(BTMGMT_LINE);
    if (!m) return false;
    const mac = m[1].toUpperCase();
    const rssi = parseInt(m[2], 10);
    const nameMatch = line.match(BTMGMT_NAME);
    const name = nameMatch ? nameMatch[1].trim() : '';
    return recordDevice(mac, name, rssi);
  });
  return found.size > 0;
}

async function tryBluetoothctl() {
  if (!which('bluetoothctl')) return false;
  toolUsed = 'bluetoothctl';
  process.stderr.write('[scan-helper] försöker bluetoothctl --timeout scan le\n');
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  await runTool('bluetoothctl', ['--timeout', String(seconds), 'scan', 'le'], (line) => {
    const m = line.match(BCTL_DEV);
    if (!m) return false;
    const mac = m[1].toUpperCase();
    const name = (m[2] ?? '').trim();
    return recordDevice(mac, name);
  });
  return found.size > 0;
}

async function tryHcitool() {
  if (!which('hcitool')) return false;
  toolUsed = 'hcitool';
  process.stderr.write('[scan-helper] försöker hcitool -i hci0 lescan\n');
  await runTool('hcitool', ['-i', 'hci0', 'lescan', '--duplicates'], (line) => {
    const m = line.match(MAC_LINE);
    if (!m) return false;
    const mac = m[1].toUpperCase();
    const rawName = (m[2] ?? '').trim();
    return recordDevice(mac, rawName);
  });
  return found.size > 0;
}

// Försök verktygen i prioritetsordning. Stoppa så fort vi får träffar
// (eller efter alla har provats om inget gav resultat).
let firstError = null;
try {
  const ok = (await tryBtmgmt())
        || (await tryBluetoothctl())
        || (await tryHcitool());
  if (!ok && rawLineCount === 0) {
    firstError = `inget verktyg producerade scan-output (toolsTried inkluderar btmgmt/bluetoothctl/hcitool, sista=${toolUsed})`;
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
  tool: toolUsed,
  durationMs: Date.now() - startedAt,
});
setTimeout(() => process.exit(0), 50);
