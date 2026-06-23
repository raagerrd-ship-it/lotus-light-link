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
 * Aktivt försök ta upp hci0 INNAN noble laddas. Kör rfkill unblock + hciconfig
 * hci0 up (idempotent, icke-destruktivt). Får ALDRIG köra `down` eller `reset`
 * — det är fortfarande policy att engine inte tar ner adaptern (mem://pi/ble/
 * hci-up-only-policy).
 *
 * Använder execSync med PATH-safe env (inte bash -lc — tom PATH under systemd
 * user-service). Returnerar true om adaptern är UP RUNNING efteråt.
 */
export function bringHci0Up(): boolean {
  const env = {
    ...process.env,
    PATH: process.env.PATH ? `${process.env.PATH}:${SAFE_PATH}` : SAFE_PATH,
    LC_ALL: 'C',
  };
  // 1. unblock rfkill (idempotent)
  try { execSync('rfkill unblock bluetooth', { timeout: 2000, env }); } catch {}
  // 2. hciconfig hci0 up (idempotent — returnerar 0 även om redan up)
  try { execSync('hciconfig hci0 up', { timeout: 3000, env }); } catch {}
  // 3. unblock igen ifall hciconfig up triggade en ny rfkill-state
  try { execSync('rfkill unblock bluetooth', { timeout: 2000, env }); } catch {}
  return isHci0Up();
}

/**
 * Poll `hciconfig hci0` until it reports UP RUNNING or `timeoutMs` elapses.
 * Försöker AKTIVT ta upp hci0 var ~2:a sek om den är nere — passiv väntan
 * räcker inte under user-service där PCC's ExecStartPre kanske inte kört.
 */
export async function waitForHci0Up(timeoutMs = 10000, intervalMs = 500): Promise<boolean> {
  const start = Date.now();
  let lastBringUp = 0;
  while (Date.now() - start < timeoutMs) {
    if (isHci0Up()) return true;
    // Försök aktivt ta upp adaptern var 2:a sek (idempotent)
    if (Date.now() - lastBringUp > 2000) {
      lastBringUp = Date.now();
      if (bringHci0Up()) return true;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return isHci0Up();
}
