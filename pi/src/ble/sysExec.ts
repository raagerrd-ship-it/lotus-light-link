/**
 * System command execution helpers — PATH-safe under systemd user-service.
 *
 * Bakgrund: `bash -lc 'cmd'` startar bash som **login shell** vilket läser
 * `/etc/profile` + `~/.bash_profile`. Under systemd user-service är dessa
 * ofta tomma/saknar `/usr/sbin` (där rfkill/hciconfig bor) → kommandona
 * hittas inte → tomma resultat → våra checks ljuger.
 *
 * Bevis (2026-04-18): `isHci0Up()` med `bash -lc 'hciconfig hci0'` returnerade
 * konstant false trots att adaptern var UP RUNNING. Heartbeat med direkt
 * `execSync('hciconfig hci0 2>&1')` fick rätt svar samtidigt.
 *
 * Regel:
 * - Enkla read-only kommandon → `runShellRead('cmd args')`
 * - Multi-step skript med pipes/||/sequencing → `runShellScript('cmd1; cmd2; ...')`
 * - BÅDA garanterar PATH=/usr/sbin:/usr/bin:/sbin:/bin
 *
 * Memory: mem://pi/ble/no-bash-lc-for-system-tools
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Garanterad env för system-CLI: PATH innehåller alltid /usr/sbin etc. */
function safeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: process.env.PATH ? `${process.env.PATH}:${SAFE_PATH}` : SAFE_PATH,
    LC_ALL: 'C',
    LANG: 'C',
  };
}

export interface RunOptions {
  timeoutMs?: number;
  /** Behåll stdout (default true). Sätt false för fire-and-forget mutationer. */
  capture?: boolean;
}

/**
 * Kör ett enkelt kommando och returnera stdout (+ stderr merged via 2>&1).
 * För read-only checks som `hciconfig hci0`, `rfkill list bluetooth`, etc.
 *
 * Returnerar tom sträng vid fel — caller får göra regex/parse på resultatet.
 */
export function runShellRead(command: string, opts: RunOptions = {}): string {
  const { timeoutMs = 1500 } = opts;
  try {
    const out = execSync(`${command} 2>&1`, {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: safeEnv(),
    } as ExecSyncOptionsWithStringEncoding);
    return out ?? '';
  } catch {
    return '';
  }
}

/**
 * Kör ett multi-step shell-skript (med ;, ||, &&, pipes) under `bash -c`
 * (INTE `-l` — vi vill inte ha login-shell). PATH garanteras via env.
 *
 * För mutationer som rfkill+hciconfig-sekvenser. Returnerar true om bash
 * exit-code är 0, false annars. stdio är default 'ignore' för att undvika
 * loggar — caller kan sätta capture=true för debug.
 */
export function runShellScript(script: string, opts: RunOptions = {}): boolean {
  const { timeoutMs = 5000, capture = false } = opts;
  try {
    execSync(`bash -c ${shellQuote(script)}`, {
      timeout: timeoutMs,
      env: safeEnv(),
      stdio: capture ? 'pipe' : 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Single-quote escape för bash -c "..."-argument */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
