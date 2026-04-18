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

import { execFileSync } from 'child_process';

/**
 * Read `hciconfig hci0` (no root required) and return true if the adapter
 * reports UP RUNNING. Returns false on any error (command missing, adapter
 * not present, etc.) so callers fall through to "load noble anyway".
 */
export function isHci0Up(): boolean {
  try {
    const out = execFileSync('bash', ['-lc', 'hciconfig hci0 2>/dev/null || true'], {
      timeout: 2000,
      encoding: 'utf8',
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
