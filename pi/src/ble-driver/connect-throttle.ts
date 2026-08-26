/**
 * Anti-churn-spärr för connect-försök (FIX 5).
 *
 * Billiga ELK-BLEDOM-lampor hänger sin firmware vid snabb connect/disconnect-
 * churn (t.ex. en deploy-svit där motorn startas om 4-5 ggr på en timme).
 * Vi persisterar connect-ATTEMPT-tidsstämplar på tmpfs så en FRESH process vet
 * att förra instansen precis rörde lampan.
 *
 * tmpfs → ingen SD-slitage, överlever process-restart men inte Pi-reboot
 * (en reboot är inte churn).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = '/tmp/lotus-ble-connect-at';
const RING_MAX = 8;

/** Churn-fönster: fler än CHURN_LIMIT försök inom CHURN_WINDOW_MS = churn. */
const CHURN_WINDOW_MS = 30_000;
const CHURN_LIMIT = 5;
/** Extra paus när churn upptäckts. */
const CHURN_PAUSE_MS = 15_000;

let _churnHook: ((info: { attempts: number; pauseMs: number }) => void) | null = null;

/** App-sidan kan logga churn-guard i restart-loggen utan att drivern importerar den. */
export function setChurnHook(fn: ((info: { attempts: number; pauseMs: number }) => void) | null): void {
  _churnHook = fn;
}

function readRing(): number[] {
  try {
    const raw = readFileSync(FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((n) => typeof n === 'number');
    if (typeof parsed === 'number') return [parsed];
    return [];
  } catch {
    return [];
  }
}

function writeRing(ring: number[]): void {
  try { writeFileSync(FILE, JSON.stringify(ring.slice(-RING_MAX)), 'utf8'); } catch {}
}

/** Registrera ett connect-FÖRSÖK (kallas vid starten av connectHardcoded). */
export function noteConnectAttempt(): void {
  const ring = readRing();
  ring.push(Date.now());
  writeRing(ring);
}

/** Tidsstämpel för senaste connect-försök (även från en tidigare process). */
export function getLastConnectAttemptAt(): number {
  const ring = readRing();
  return ring.length ? ring[ring.length - 1] : 0;
}

/**
 * Hur länge vi bör vänta innan nästa connect-försök: cooldown sedan förra
 * försöket + eventuell churn-paus. 0 = kör direkt.
 */
export function getConnectWaitMs(cooldownMs: number): number {
  const ring = readRing();
  if (!ring.length) return 0;
  const now = Date.now();
  const elapsed = now - ring[ring.length - 1];
  let wait = elapsed >= 0 && elapsed < cooldownMs ? cooldownMs - elapsed : 0;

  const recent = ring.filter((t) => now - t < CHURN_WINDOW_MS).length;
  if (recent > CHURN_LIMIT) {
    wait = Math.max(wait, CHURN_PAUSE_MS);
    try { _churnHook?.({ attempts: recent, pauseMs: wait }); } catch {}
    console.warn(`[ble-churn-guard] ${recent} connect-försök på ${CHURN_WINDOW_MS / 1000}s — pausar ${wait}ms`);
  }
  return wait;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Vänta ut cooldown (cross-restart) innan ett connect-försök. */
export async function waitForConnectCooldown(cooldownMs = 4000): Promise<void> {
  const wait = getConnectWaitMs(cooldownMs);
  if (wait > 0) {
    console.log(`[ble-cooldown] senaste connect-försök var nyligen — väntar ${wait}ms innan connect`);
    await sleep(wait);
  }
}
