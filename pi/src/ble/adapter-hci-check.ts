/**
 * Standalone hci0 readiness check — does NOT import noble.
 *
 * This file exists so index.ts can poll the Bluetooth adapter at boot time
 * BEFORE loading any module that depends on `@stoprocent/noble`. Noble runs
 * its HCI bindings init synchronously on first require(); if hci0 is DOWN
 * at that exact moment it caches `poweredOff` for the lifetime of the
 * process and never recovers — even after PCC's ExecStartPre hooks bring
 * the adapter up.
 *
 * Keep this module dependency-free (just node:child_process). The richer
 * adapter helpers in ./adapter.ts pull in noble via ./state.ts and must
 * NOT be imported until the adapter is confirmed up.
 */

import { execSync } from 'child_process';

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Read `hciconfig hci0` (no root required) and return true if the adapter
 * reports UP RUNNING. Returns false on any error (command missing, adapter
 * not present, etc.) so callers fall through to "load noble anyway".
 *
 * Använder execSync direkt med PATH-safe env — INTE bash -lc (login-shell
 * får tom PATH under systemd user-service, hciconfig hittas inte).
 * Memory: mem://pi/ble/no-bash-lc-for-system-tools
 *
 * Notera: detta är en stand-alone kopia av isHci0Up som inte importerar
 * något annat (måste vara dependency-free, se topp-kommentar). Den kan
 * därför inte använda ./sysExec.js.
 */
export function isHci0Up(): boolean {
  try {
    const out = execSync('hciconfig hci0 2>&1', {
      timeout: 1500,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: process.env.PATH ? `${process.env.PATH}:${SAFE_PATH}` : SAFE_PATH,
        LC_ALL: 'C',
      },
    }) as string;
    return /UP\s+RUNNING/.test(out);
  } catch {
    return false;
  }
}

/**
 * Poll `hciconfig hci0` until it reports UP RUNNING or `timeoutMs` elapses.
 * Read-only — does not toggle the adapter. PCC (root service) is responsible
 * for `rfkill unblock bluetooth` + `hciconfig hci0 up` via ExecStartPre.
 */
export async function waitForHci0Up(timeoutMs = 10000, intervalMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isHci0Up()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return isHci0Up();
}
