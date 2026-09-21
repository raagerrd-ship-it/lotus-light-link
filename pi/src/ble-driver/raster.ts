/**
 * BLE-rastret (2026-09-21): radions anslutningshändelser som motorns klocka.
 *
 * Kedjan har tre klockor som aldrig bundits ihop: mikrofonens 48 kHz (hop 2,67 ms,
 * band-ram var BAND_EVERY_HOPS:e hop), radions anslutningsintervall (LOTUS_BLE_INTERVAL_UNITS
 * × 1,25 ms, ankare satt av kärnan vid uppkoppling) och lampan. En ram som räknas på
 * ljudklockan ligger sedan och väntar 0–intervall på nästa radiohändelse — i snitt ett
 * halvt intervall gammal när den lämnar Pi:n, och eftersom 24 och 17,5 ms inte går jämnt
 * upp vaggar väntetiden i ett 168 ms-mönster. "Beräkning som är gammal när den används."
 *
 * Kärnan exponerar inte ankaret, men kontrollern kvitterar varje sänt paket med
 * HCI Number_Of_Completed_Packets (0x13) exakt på sitt raster. Vi lyssnar på nobles
 * råa HCI-socket, tidsstämplar kvittona för vår handle och håller en period-/fasmodell
 * (PLL mot rastret, som taktklockan mot musiken — kristallerna driver några ppm).
 *
 * Alltid PÅ som mätare (write→kvitto-latens, periodjitter) så före/efter kan jämföras;
 * motorn lägger sin tick i fas bara med LOTUS_TICK_SYNC=1 (piEngine).
 */

import { getNoble } from './noble-singleton.js';
import { getAttachedHandle } from './controllerDrain.js';

const HCI_EVENT_PKT = 0x04;
const EVT_NUMBER_OF_COMPLETED_PACKETS = 0x13;

const UNITS = Math.max(6, Math.min(3200, Number(process.env.LOTUS_BLE_INTERVAL_UNITS) || 12));
/** Nominell period ur konfigurerat intervall — startvärde och reserv när inga kvitton kommit. */
export const NOMINAL_PERIOD_MS = UNITS * 1.25;

let _socket: any = null;
let _listener: ((data: Buffer) => void) | null = null;

// Fas-/periodmodell
let _period = NOMINAL_PERIOD_MS;
let _lastEventAt = 0;        // performance.now() för senaste kvitto
let _events = 0;
let _resid2 = 0;             // EMA av residual² (jitter)
let _residN = 0;

// write→kvitto (hur länge paketet låg i kontrollern innan radiohändelsen)
let _pendingWriteAt = 0;
const _w2n = new Float32Array(512);
let _w2nIdx = 0, _w2nN = 0;

function onData(data: Buffer): void {
  try {
    if (data.length < 8 || data[0] !== HCI_EVENT_PKT || data[1] !== EVT_NUMBER_OF_COMPLETED_PACKETS) return;
    const handle = getAttachedHandle();
    if (handle == null) return;
    const handles = data[3];
    for (let h = 0; h < handles; h++) {
      if (data.readUInt16LE(4 + h * 4) !== handle) continue;
      noteEvent(performance.now());
      return;
    }
  } catch { /* mätaren får aldrig falla länken */ }
}

function noteEvent(t: number): void {
  _events++;
  if (_lastEventAt > 0) {
    const dt = t - _lastEventAt;
    const k = Math.round(dt / _period);
    if (k >= 1 && k <= 8) {
      const per = dt / k;
      const resid = per - _period;
      if (Math.abs(resid) < 0.25 * _period) {
        _period += 0.05 * resid;                 // långsam periodföljning
        _resid2 = _residN < 20 ? (_resid2 * _residN + resid * resid) / (_residN + 1) : _resid2 * 0.98 + resid * resid * 0.02;
        _residN++;
      }
    }
  }
  _lastEventAt = t;
  if (_pendingWriteAt > 0) {
    _w2n[_w2nIdx] = t - _pendingWriteAt; _w2nIdx = (_w2nIdx + 1) % _w2n.length; _w2nN++;
    _pendingWriteAt = 0;
  }
}

/** Anropas av protokollet direkt efter writeAsync (ljus-skrivningar, inte keep-alive). */
export function rasterNoteWrite(t: number): void {
  _pendingWriteAt = t;
}

export function attachRaster(): void {
  detachRaster();
  try {
    const n: any = getNoble();
    const sock = n?._bindings?._hci?._socket;
    if (!sock || typeof sock.on !== 'function') { console.warn('[raster] ingen HCI-socket i noble — rastret degraderar till nominell period'); return; }
    _listener = onData;
    sock.on('data', _listener);
    _socket = sock;
    _lastEventAt = 0; _events = 0; _resid2 = 0; _residN = 0; _period = NOMINAL_PERIOD_MS; _pendingWriteAt = 0; _w2nN = 0; _w2nIdx = 0;
  } catch (e: any) {
    console.warn(`[raster] attach FEL: ${e?.message ?? e}`);
  }
}

export function detachRaster(): void {
  if (_socket && _listener) { try { _socket.removeListener('data', _listener); } catch { /* */ } }
  _socket = null; _listener = null; _lastEventAt = 0; _pendingWriteAt = 0;
}

export function isRasterLocked(now = performance.now()): boolean {
  return _lastEventAt > 0 && now - _lastEventAt < 500 && _residN >= 8;
}

export function getRasterPeriodMs(): number { return _period; }

/**
 * Nästa förutsagda radiohändelse ≥ now + guardMs. Utan lås: fritt löpande nominell
 * period från senaste kända punkt (eller now) — motorn tickar då ändå jämnt.
 */
export function nextRasterEventAt(now: number, guardMs: number): number {
  const base = _lastEventAt > 0 ? _lastEventAt : now;
  const per = _period;
  const k = Math.max(1, Math.ceil((now + guardMs - base) / per));
  return base + k * per;
}

export function getRasterStats(): { locked: boolean; periodMs: number; jitterMs: number; events: number; ageMs: number; w2n: { n: number; p50Ms: number; p90Ms: number; maxMs: number } } {
  const now = performance.now();
  const n = Math.min(_w2nN, _w2n.length);
  const v: number[] = [];
  for (let i = 0; i < n; i++) v.push(_w2n[i]);
  v.sort((a, b) => a - b);
  const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0);
  return {
    locked: isRasterLocked(now),
    periodMs: +_period.toFixed(3),
    jitterMs: +Math.sqrt(_resid2).toFixed(3),
    events: _events,
    ageMs: _lastEventAt > 0 ? Math.round(now - _lastEventAt) : -1,
    w2n: { n: v.length, p50Ms: +q(0.5).toFixed(2), p90Ms: +q(0.9).toFixed(2), maxMs: +(v.length ? v[v.length - 1] : 0).toFixed(2) },
  };
}

/** Nollställ write→kvitto-fönstret (för mätning per period). */
export function resetRasterWindow(): void { _w2nN = 0; _w2nIdx = 0; }
