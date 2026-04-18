/**
 * BLE heartbeat — löpande statusloggning så UI:t alltid har något att visa.
 *
 * Bakgrund: när noble fastnar i `unknown` händer det inget i eventloggen
 * efter "caps-check OK". Användaren ser en tom panel utan att veta om
 * processen lever, om noble försöker, eller om den gett upp.
 *
 * Heartbeaten loggar var 10:e sekund:
 *   - Adapter raw / effective state
 *   - Boot elapsed
 *   - Master switch (enabled + source)
 *   - Sparad enhet + connect-status
 *   - hciconfig kort sammanfattning (UP RUNNING / DOWN)
 *
 * Frekvensen sänks automatiskt när systemet är "stabilt + tyst" (noble
 * poweredOn + ansluten enhet) → 60s, för att inte spamma loggen.
 */

import { execSync } from 'child_process';
import {
  logConnectionEvent,
  getNobleRawState,
  getAdapterState,
  getBleBootStartedAt,
  hasNobleEverFiredStateChange,
  getDevice,
  getSavedDeviceId,
  getSavedDeviceName,
  isDemandActive,
} from './state.js';
import { isBleEnabled, getEnabledSource } from './enabled.js';
import { isScanning } from './scan.js';
import { isConnectInProgress } from './connect.js';

let _timer: ReturnType<typeof setInterval> | null = null;
let _tickCount = 0;

function hciSummary(): string {
  try {
    const out = execSync('hciconfig hci0 2>&1', { encoding: 'utf8', timeout: 1000 });
    if (/UP\s+RUNNING/.test(out)) return 'hci0:UP';
    if (/DOWN/.test(out)) return 'hci0:DOWN';
    return 'hci0:?';
  } catch {
    return 'hci0:err';
  }
}

function buildHeartbeat(): string {
  const raw = getNobleRawState() ?? 'unknown';
  const eff = getAdapterState() ?? 'unknown';
  const elapsed = Math.floor((Date.now() - getBleBootStartedAt()) / 1000);
  const everPow = hasNobleEverFiredStateChange();
  const enabled = isBleEnabled();
  const src = getEnabledSource();
  const dev = getDevice();
  const saved = getSavedDeviceId();
  const savedName = getSavedDeviceName();
  const connecting = isConnectInProgress();
  const scanning = isScanning();
  const demand = isDemandActive();
  const hci = hciSummary();

  const parts = [
    `t+${elapsed}s`,
    `noble:${raw}${raw !== eff ? `→${eff}` : ''}`,
    `${hci}`,
    `radio:${enabled ? `ON(${src})` : 'OFF'}`,
    everPow ? 'pow✓' : 'pow✗',
    saved ? `saved:${savedName ?? saved.slice(0, 8)}` : 'saved:none',
    dev ? 'connected:✓' : connecting ? 'connecting…' : scanning ? 'scanning…' : demand ? 'demand-pending' : 'idle',
  ];

  return parts.join(' | ');
}

/**
 * Dynamic interval — snabbt när något händer, långsamt när stabilt.
 *  - Tystläge (noble poweredOn + ansluten + radio på + 5+ ticks gått): 60s
 *  - Annars: 10s
 */
function nextInterval(): number {
  const stable =
    getNobleRawState() === 'poweredOn' &&
    !!getDevice() &&
    isBleEnabled() &&
    _tickCount > 5;
  return stable ? 60_000 : 10_000;
}

function tick(): void {
  _tickCount++;
  const msg = buildHeartbeat();
  // Console: alltid (för journalctl)
  console.log(`[BLE:hb] ${msg}`);
  // Eventlog ringbuffer: bara om något ändrats vs förra eller var 6:e tick
  // (annars fyller vi 50-event-bufferten på 10 minuter med samma rad).
  if (_tickCount === 1 || _tickCount % 6 === 0 || msg !== _lastLoggedMsg) {
    logConnectionEvent({ type: 'connect_start', detail: `hb: ${msg}` });
    _lastLoggedMsg = msg;
  }
  // Schemalägg nästa tick med dynamisk intervall
  if (_timer) clearTimeout(_timer as any);
  _timer = setTimeout(tick, nextInterval()) as any;
}

let _lastLoggedMsg = '';

export function startBleHeartbeat(): void {
  if (_timer) return;
  console.log('[BLE:hb] heartbeat-loop startad (10s/60s adaptiv)');
  // Första tick efter 2s så boot-loggen hinner färdigt först
  _timer = setTimeout(tick, 2000) as any;
}

export function stopBleHeartbeat(): void {
  if (_timer) { clearTimeout(_timer as any); _timer = null; }
}
