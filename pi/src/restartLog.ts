/**
 * Restart-log: ringbuffer på disk över varför processen startat om.
 *
 * Syfte: ge synlighet i HUR OFTA och VARFÖR motorn dör så vi kan tunea
 * (t.ex. höja/sänka CONSECUTIVE_FAIL_LIMIT) istället för att gissa.
 *
 * Plats: <DATA_DIR>/restart-log.json (samma data-dir som profiler/kalibrering).
 * Format: { entries: RestartEntry[] } — ringbuffer, max 50 senaste.
 *
 * Workflow:
 *  - Vid boot anropar index.ts noteBootStart() → markerar "vi har startat".
 *    Om föregående session inte hann kalla markGracefulShutdown() så loggas
 *    en `unknown-systemd-restart` med uptime från previous-session-marker.
 *  - Vid lyckad BLE-connect (eller annan "vi var igång") → markSessionAlive()
 *    så vi kan beräkna uptime-before-crash om vi senare dör.
 *  - Vid känd crash-orsak → recordRestart({ reason, detail })
 *  - Vid graceful UI-shutdown → markGracefulShutdown() → nästa boot loggar inget.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './storage.js';

export type RestartReason =
  | 'ble-consecutive-failures'   // CONSECUTIVE_FAIL_LIMIT nått → process.exit(0)
  | 'uncaught-exception'         // process.on('uncaughtException')
  | 'unhandled-rejection'        // process.on('unhandledRejection')
  | 'unknown-systemd-restart'    // föregående process dog utan att vi hann logga
  | 'manual-start-all'           // användaren tryckte Starta allt / Starta om
  | 'alsa-watchdog-stuck'        // ALSA-watchdog: FFT-loop frusen → exit(1)
  | 'playback-watchdog-stuck';   // Playback-watchdog: tickOk frusen efter soft recovery → exit(1)

export interface RestartEntry {
  ts: string;                  // ISO timestamp för restart-eventet
  reason: RestartReason;
  detail: string | null;       // fritextkontext (felmeddelande, räknare etc)
  uptimeBeforeMs: number | null; // hur länge förra sessionen levde innan death
  memoryBeforeMb: number | null; // RSS strax innan exit (om vi hann mäta)
}

const LOG_FILE = join(DATA_DIR, 'restart-log.json');
const SESSION_MARKER = join(DATA_DIR, '.lotus-session-alive');
const MAX_ENTRIES = 50;

interface RestartLogFile {
  entries: RestartEntry[];
}

function loadLog(): RestartLogFile {
  try {
    if (!existsSync(LOG_FILE)) return { entries: [] };
    const raw = readFileSync(LOG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) return { entries: parsed.entries };
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function saveLog(log: RestartLogFile): void {
  try {
    // Trimma till MAX_ENTRIES (nyaste först)
    const trimmed = log.entries.slice(-MAX_ENTRIES);
    writeFileSync(LOG_FILE, JSON.stringify({ entries: trimmed }, null, 2), 'utf-8');
  } catch (e: any) {
    console.warn('[restart-log] kunde inte skriva log:', e?.message ?? e);
  }
}

/**
 * Skriv en restart-entry till loggen. Trimmar till MAX_ENTRIES.
 */
export function recordRestart(reason: RestartReason, detail: string | null = null): void {
  try {
    const memMb = (() => {
      try { return Math.round(process.memoryUsage().rss / 1024 / 1024); }
      catch { return null; }
    })();
    const uptimeBeforeMs = (() => {
      try {
        if (!existsSync(SESSION_MARKER)) return null;
        const startedAt = parseInt(readFileSync(SESSION_MARKER, 'utf-8'), 10);
        if (!Number.isFinite(startedAt)) return null;
        return Date.now() - startedAt;
      } catch { return null; }
    })();
    const entry: RestartEntry = {
      ts: new Date().toISOString(),
      reason,
      detail: detail ? String(detail).slice(0, 500) : null,
      uptimeBeforeMs,
      memoryBeforeMb: memMb,
    };
    const log = loadLog();
    log.entries.push(entry);
    saveLog(log);
    console.warn(`[restart-log] ${reason}${detail ? `: ${String(detail).slice(0, 200)}` : ''} (uptime=${uptimeBeforeMs}ms, rss=${memMb}MB)`);
  } catch (e: any) {
    console.warn('[restart-log] recordRestart fel:', e?.message ?? e);
  }
}

/**
 * Anropas vid boot. Om SESSION_MARKER finns → föregående session dog utan
 * graceful shutdown och utan att hinna logga reason. Logga som unknown.
 * Skriver sedan ny marker för aktuell session.
 */
export function noteBootStart(): void {
  try {
    if (existsSync(SESSION_MARKER)) {
      // Föregående session lämnade kvar markern → ofrivillig död.
      // Kontrollera om någon annan reason redan loggats för denna restart-cykel
      // (recordRestart från crash-handler eller BLE-fail) inom senaste 5s.
      const log = loadLog();
      const last = log.entries[log.entries.length - 1];
      const lastTs = last ? new Date(last.ts).getTime() : 0;
      const recent = Date.now() - lastTs < 5000;
      if (!recent) {
        // Ingen tidigare reason i loggen → okänd död (OOM-kill, segfault, kill -9 etc)
        recordRestart('unknown-systemd-restart', 'Inget reason loggat — möjligen OOM-kill eller segfault');
      }
    }
    // Skriv ny session-marker
    writeFileSync(SESSION_MARKER, String(Date.now()), 'utf-8');
  } catch (e: any) {
    console.warn('[restart-log] noteBootStart fel:', e?.message ?? e);
  }
}

/**
 * Markera att vi har en aktiv session — uppdatera marker så uptimeBeforeMs blir korrekt
 * vid eventuell crash. Anropas vid lyckad BLE-connect.
 */
export function markSessionAlive(): void {
  try {
    if (!existsSync(SESSION_MARKER)) {
      writeFileSync(SESSION_MARKER, String(Date.now()), 'utf-8');
    }
  } catch {}
}

/**
 * Anropas av graceful shutdown (SIGINT/SIGTERM via UI). Tar bort markern så
 * nästa boot inte loggar en falsk "unknown-systemd-restart".
 */
export function markGracefulShutdown(): void {
  try {
    if (existsSync(SESSION_MARKER)) unlinkSync(SESSION_MARKER);
  } catch {}
}

/**
 * Returnerar senaste 50 restarts (nyaste sist) för /api/status och UI.
 */
export function getRestartHistory(): RestartEntry[] {
  return loadLog().entries;
}

/**
 * Rensa hela loggen — exporterad för framtida UI-knapp eller manuell test.
 */
export function clearRestartHistory(): void {
  try { writeFileSync(LOG_FILE, JSON.stringify({ entries: [] }, null, 2), 'utf-8'); } catch {}
}
