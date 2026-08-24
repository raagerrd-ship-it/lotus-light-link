/**
 * Force LE connection interval via `hcitool lecup`.
 *
 * Bakgrund: noble's interna HCI-väg för att begära nytt connection interval
 * (se mem://pi/ble/connection-optimization) slår inte alltid igenom — vi har
 * bevisat i fält att lampan default:ar till ~50ms (=20 pps tak) tills man
 * manuellt kör:
 *
 *   sudo hcitool lecup --handle <H> --min 16 --max 16 --latency 0 --timeout 100
 *
 * Direkt efter det manuella anropet → 50 pps utan kö (bevisat med bench).
 *
 * Den här modulen kör samma kommando automatiskt 500ms efter lyckad GATT-
 * connect + drain-attach. Failure är icke-fatal: om hcitool saknas, om
 * controllern säger nej, eller om handle är ogiltig → vi loggar och fortsätter.
 * Bench-resultatet (`connInterval` i UI) avslöjar då att fallback inte slog
 * igenom och vi har spårbarhet via journalctl-alternativet (systemctl status).
 *
 * Targetvärden (BLE spec):
 *   min=max=16 →  16 × 1.25ms = 20ms connection interval
 *   latency=0  →  ingen slave latency (lampan ska svara på varje interval)
 *   timeout=100 → 100 × 10ms = 1s supervision timeout
 *
 * RATIONALE för 20ms (2026-04-25): Pi Zero 2W hängde sig efter ~22h drift med
 * 7.5ms interval. BCM43436 delar radio mellan WiFi+BT — 133 BLE-events/s gav
 * konstant interrupt-tryck. 20ms halverar BT-load (~50 events/s) utan att
 * äventyra single-slot-kontraktet (tickMs=20ms = exakt 1 BLE-slot per tick).
 * Worst-case latens: 20ms (under flicker-fusion-threshold).
 */

import { spawn } from 'node:child_process';

export interface ForceConnIntervalResult {
  ok: boolean;
  handle: number;
  exitCode: number | null;
  stderr: string;
  durationMs: number;
}

export function forceConnInterval(
  handle: number,
  opts: { min?: number; max?: number; latency?: number; timeoutUnits?: number; cmdTimeoutMs?: number } = {}
): Promise<ForceConnIntervalResult> {
  const min = opts.min ?? 12;            // 15 ms (12 × 1.25ms) — verifierat manuellt på Pi:n
  const max = opts.max ?? 12;            // 15 ms
  const latency = opts.latency ?? 0;
  const supTo = opts.timeoutUnits ?? 100; // 1 s
  const cmdTimeoutMs = opts.cmdTimeoutMs ?? 3000;

  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [
      'lecup',
      '--handle', String(handle),
      '--min', String(min),
      '--max', String(max),
      '--latency', String(latency),
      '--timeout', String(supTo),
    ];
    let proc;
    try {
      proc = spawn('hcitool', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ ok: false, handle, exitCode: null, stderr: `spawn failed: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      return;
    }

    let stderr = '';
    proc.stderr?.on('data', (b) => { stderr += b.toString(); });

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, cmdTimeoutMs);

    proc.on('exit', (code) => {
      clearTimeout(killTimer);
      resolve({
        ok: code === 0,
        handle,
        exitCode: code,
        stderr: stderr.trim(),
        durationMs: Date.now() - t0,
      });
    });
    proc.on('error', (e) => {
      clearTimeout(killTimer);
      resolve({ ok: false, handle, exitCode: null, stderr: `error: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
    });
  });
}


// ── Robust apply + persistent re-assert ────────────────────────────────────
// hcitool exit 0 betyder bara att kommandot skickades — controllern kan ändå
// ligga kvar på default-interval (skurvis leverans → hackigt ljus). Därför:
//   1. Försök upp till 3 gånger med backoff direkt efter connect.
//   2. Re-assert var 60:e sekund så länge länken lever (interval kan tappas
//      vid en LE-connection-update från lampan eller efter en reconnect).
//   3. Verifiera mot FAKTISK sändningstakt (writeLatMax/outstanding) via
//      bleStats — loggas så vi ser om det slog igenom, inte bara exitkoden.
let reassertTimer: ReturnType<typeof setInterval> | null = null;

export async function applyConnInterval(
  getHandle: () => number | null,
  bleStats: { requestedIntervalMs: string; intervalSource: string; connIntervalReassertCount: number; outstandingAgeMs: number },
  log: (msg: string) => void,
): Promise<void> {
  const targetUnits = 12;                 // 15 ms
  const targetMs = (targetUnits * 1.25).toFixed(2);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const handle = getHandle();
    if (handle == null) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    const r = await forceConnInterval(handle, { min: targetUnits, max: targetUnits });
    if (r.ok) {
      bleStats.requestedIntervalMs = targetMs;
      bleStats.intervalSource = 'hcitool';
      log(`[forceConnInterval] OK handle=${handle} → ${targetMs}ms (försök ${attempt}, ${r.durationMs}ms)`);
      startConnIntervalReassert(getHandle, bleStats, log);
      return;
    }
    log(`[forceConnInterval] FAIL handle=${handle} exit=${r.exitCode} stderr="${r.stderr}" (försök ${attempt})`);
    await new Promise((res) => setTimeout(res, 800 * attempt));
  }
  bleStats.intervalSource = 'default (lecup misslyckades)';
  log('[forceConnInterval] gav upp efter 3 försök — länken kör på default interval (hackigt ljus förväntas)');
}

// BLEDOM förhandlar tillbaka till högt interval (~200ms) efter en stund →
// re-forcera var 25:e sekund och VERIFIERA mot faktisk leveranstid
// (outstandingAgeMs): >60ms betyder att intervallet tappats → forcera direkt igen.
const REASSERT_MS = 25_000;
const AGE_ALARM_MS = 60;

function startConnIntervalReassert(
  getHandle: () => number | null,
  bleStats: { connIntervalReassertCount: number; outstandingAgeMs: number; intervalSource: string },
  log: (msg: string) => void,
): void {
  stopConnIntervalReassert();
  reassertTimer = setInterval(() => {
    const handle = getHandle();
    if (handle == null) { stopConnIntervalReassert(); return; }
    const ageBefore = bleStats.outstandingAgeMs;
    void forceConnInterval(handle, { min: 12, max: 12 }).then((r) => {
      bleStats.connIntervalReassertCount++;
      if (!r.ok) {
        log(`[forceConnInterval] re-assert FAIL exit=${r.exitCode} stderr="${r.stderr}"`);
        return;
      }
      if (ageBefore >= AGE_ALARM_MS) {
        bleStats.intervalSource = 'hcitool (re-forcerad efter drift)';
        log(`[forceConnInterval] re-assert: outstandingAgeMs=${ageBefore}ms före → intervallet hade tappats, forcerat om`);
      }
    });
  }, REASSERT_MS);
}


export function stopConnIntervalReassert(): void {
  if (reassertTimer) { clearInterval(reassertTimer); reassertTimer = null; }
}
