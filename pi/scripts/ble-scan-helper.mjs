#!/usr/bin/env node
/**
 * Minimal BLE scan-helper.
 *
 * Använder `btmgmt find` (mgmt-API, HCI_CHANNEL_CONTROL) i stället för
 * `hcitool lescan` (HCI_CHANNEL_RAW). Mgmt-kanalen krockar INTE med noble,
 * som redan håller raw-socketen öppen i engine-processen.
 *
 * btmgmt avslutas inte själv — vi SIGKILL:ar den efter timeoutMs.
 * Exit-koden blir då typiskt 137 (SIGKILL) eller 124 om kerneln rapporterar
 * timeout — båda är OK och ska inte tolkas som fel.
 */

import { spawn } from 'node:child_process';

const timeoutMs = Math.max(500, parseInt(process.argv[2] ?? '3000', 10) || 3000);

// Exempel-rader vi parsar (LC_ALL=C):
//   hci0 dev_found: 48:48:48:C6:FF:68 type LE Random rssi -57 flags 0x0004
//   AD flags 0x00
//   eir_len 38
//   name P mesh
const DEV_FOUND = /dev_found:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s+type\s+\S+(?:\s+\S+)?\s+rssi\s+(-?\d+)/i;
const NAME_LINE = /^name\s+(.+)$/i;

const startedAt = Date.now();
const found = new Map();
let rawLineCount = 0;
let stderr = '';
let lastMac = null;

function recordDevice(mac, rssi) {
  const id = mac.replace(/:/g, '').toLowerCase();
  const prev = found.get(id);
  if (!prev) {
    found.set(id, { id, name: `(no-name) ${mac}`, rssi });
  } else if (Number.isFinite(rssi) && rssi > prev.rssi) {
    prev.rssi = rssi;
  }
  lastMac = id;
}

function setName(rawName) {
  if (!lastMac) return;
  const dev = found.get(lastMac);
  if (!dev) return;
  const clean = rawName?.trim();
  if (!clean) return;
  if (dev.name.startsWith('(no-name)') || dev.name === '(unknown)') {
    dev.name = clean;
  }
}

let proc;
try {
  proc = spawn('btmgmt', ['find'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
} catch (e) {
  process.stdout.write(JSON.stringify({
    devices: [],
    rawLineCount: 0,
    exitCode: null,
    startError: e?.message ?? String(e),
    stderr: '',
    tool: 'btmgmt',
    durationMs: 0,
  }) + '\n');
  process.exit(0);
}

proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');

let stdoutBuf = '';
proc.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    rawLineCount++;
    const m = line.match(DEV_FOUND);
    if (m) {
      const rssi = parseInt(m[2], 10);
      recordDevice(m[1].toUpperCase(), Number.isFinite(rssi) ? rssi : -100);
      continue;
    }
    const n = line.match(NAME_LINE);
    if (n) setName(n[1]);
  }
});
proc.stderr.on('data', (c) => { stderr += c; });

// btmgmt find avslutas inte själv — kill direkt efter timeout.
const killTimer = setTimeout(() => {
  try { proc.kill('SIGKILL'); } catch {}
}, timeoutMs);

const exitCode = await new Promise((resolve) => {
  proc.once('exit', (code) => { clearTimeout(killTimer); resolve(code); });
  proc.once('error', () => { clearTimeout(killTimer); resolve(null); });
});

process.stdout.write(JSON.stringify({
  devices: Array.from(found.values()),
  rawLineCount,
  exitCode,
  startError: null,
  stderr: stderr.trim(),
  tool: 'btmgmt',
  durationMs: Date.now() - startedAt,
}) + '\n');

setTimeout(() => process.exit(0), 50);
