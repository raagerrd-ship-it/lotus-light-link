/**
 * BLE-driver-lokal logger — håller drivern helt fristående (ingen import
 * utanför ble-driver/).
 *
 * Default-beteende speglar projektets debugLog.ts: tyst om inte LOTUS_DEBUG=1
 * (console.warn/error används direkt i koden och är alltid på). Ett annat
 * projekt kan injicera sin egen logger via setLogger().
 */

const ENABLED =
  process.env.LOTUS_DEBUG === '1' ||
  process.env.LOTUS_DEBUG === 'true';

let _override: ((...args: unknown[]) => void) | null = null;

/** Injicera valfri logger (annars env-gated console.log). */
export function setLogger(fn: ((...args: unknown[]) => void) | null): void {
  _override = fn;
}

export function dlog(...args: unknown[]): void {
  if (_override) _override(...args);
  else if (ENABLED) console.log(...args);
}
