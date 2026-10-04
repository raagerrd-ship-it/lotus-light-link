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

import { shRun } from './shHelper.js';

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Read `hciconfig hci0` (no root required) and resolve true if the adapter
 * reports UP RUNNING. Resolves false on any error (command missing, adapter
 * not present, etc.) so callers fall through to "load noble anyway".
 *
 * PATH-safe (SAFE_PATH tillagd) — INTE bash -lc (login-shell far tom PATH under
 * systemd user-service, hciconfig hittas inte). Memory: mem://pi/ble/no-bash-lc-for-system-tools
 *
 * 2026-10-04: via sh-hjalparen (shHelper.ts, bara node:child_process - fortfarande noble-fri) i stallet for
 * execSync, som forkade motorn och holl huvudtraden tills hciconfig var klar (del av stallarna 0,5-0,8 s vid
 * sessionsstart). Samma kommando och tolkning; asynkron.
 */
export async function isHci0Up(): Promise<boolean> {
  const { code, out } = await shRun(`env PATH="$PATH:${SAFE_PATH}" LC_ALL=C hciconfig hci0`, 1500);
  return code === 0 && /UP\s+RUNNING/.test(out);
}
