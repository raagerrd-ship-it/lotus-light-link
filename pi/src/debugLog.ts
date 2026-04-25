/**
 * Debug-loggning styrd av env-variabel LOTUS_DEBUG.
 *
 * Filosofi:
 *   - console.error → ALLTID på (riktiga fel måste synas i journald)
 *   - console.warn  → ALLTID på (men sparsamt — användaren har rate-limit på dem)
 *   - console.log   → endast om LOTUS_DEBUG=1 (eller "true")
 *
 * Hot paths (FFT-tick, BLE-write, ALSA-callback) får ALDRIG anropa console.log
 * direkt — använd dlog() istället så att produktion blir helt tyst per default.
 */

const ENABLED =
  process.env.LOTUS_DEBUG === '1' ||
  process.env.LOTUS_DEBUG === 'true';

export const DEBUG_ENABLED = ENABLED;

export function dlog(...args: unknown[]): void {
  if (ENABLED) console.log(...args);
}

/** Engångs-banner vid boot så vi vet vilket läge engine kör i. */
export function logDebugBanner(): void {
  if (ENABLED) {
    console.log('[debug] LOTUS_DEBUG=1 → verbose loggning AKTIV');
  } else {
    console.log('[debug] LOTUS_DEBUG ej satt → tyst läge (endast warn/error)');
  }
}
