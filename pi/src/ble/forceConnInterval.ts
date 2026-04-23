/**
 * Force LE connection interval via `hcitool lecup`.
 *
 * Bakgrund: noble's interna HCI-väg för att begära nytt connection interval
 * (se mem://pi/ble/connection-optimization) slår inte alltid igenom — vi har
 * bevisat i fält att lampan default:ar till ~50ms (=20 pps tak) tills man
 * manuellt kör:
 *
 *   sudo hcitool lecup --handle <H> --min 6 --max 6 --latency 0 --timeout 100
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
 *   min=max=6  →  6 × 1.25ms = 7.5ms connection interval
 *   latency=0  →  ingen slave latency (lampan ska svara på varje interval)
 *   timeout=100 → 100 × 10ms = 1s supervision timeout
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
  const min = opts.min ?? 6;             // 7.5 ms
  const max = opts.max ?? 6;             // 7.5 ms
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
