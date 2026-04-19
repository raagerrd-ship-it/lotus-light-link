/**
 * In-memory ringbuffer för engine-start-loggar.
 *
 * Speglar formatet i pi/scripts/noble-scan-isolated.mjs:
 *   "+  217ms 2. Imported. typeof noble.startScanningAsync = function"
 *
 * UI:t pollar /api/ble/engine/logs?since=<seq> och får alla nya rader så
 * de kan strömmas i realtid utan SSH.
 */

export interface LogEntry {
  seq: number;
  t: number;        // ms sedan startMark
  ts: number;       // wall clock ms (Date.now())
  level: 'log' | 'warn' | 'error';
  text: string;
}

const MAX_ENTRIES = 500;
let entries: LogEntry[] = [];
let nextSeq = 1;
let startMark = Date.now();
let capturing = false;

const original = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function fmt(args: unknown[]): string {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ?? a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function push(level: LogEntry['level'], args: unknown[]) {
  const now = Date.now();
  entries.push({
    seq: nextSeq++,
    t: now - startMark,
    ts: now,
    level,
    text: fmt(args),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Aktivera global console-fångst (idempotent). */
export function installLogCapture(): void {
  if (capturing) return;
  capturing = true;
  console.log = (...a: unknown[]) => { push('log', a); original.log(...a); };
  console.warn = (...a: unknown[]) => { push('warn', a); original.warn(...a); };
  console.error = (...a: unknown[]) => { push('error', a); original.error(...a); };
}

/** Nollställ buffer + tidsmarkör — anropas i början av "Starta motor". */
export function resetEngineLogs(): void {
  entries = [];
  nextSeq = 1;
  startMark = Date.now();
}

/** Hämta alla entries med seq > since. */
export function getEngineLogsSince(since: number): { entries: LogEntry[]; nextSince: number } {
  const out = since > 0 ? entries.filter(e => e.seq > since) : entries.slice();
  const nextSince = out.length ? out[out.length - 1].seq : Math.max(since, entries.length ? entries[entries.length - 1].seq : 0);
  return { entries: out, nextSince };
}
