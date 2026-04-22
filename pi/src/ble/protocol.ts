/**
 * BLE BLEDOM protocol: packet formats, write pipeline, keepalive, brightness.
 *
 * SYNKRON HARD-FAIL-PIPELINE:
 * sendToBLE() är SYNKRON och returnerar WriteResult direkt. Den awaitar
 * aldrig characteristic.writeAsync — det görs fire-and-forget med en
 * single-slot promise (writeSlot). Engine.tickInner kan därför aldrig
 * blockeras av BLE-stacken; om sloten är upptagen får ticken returvärdet
 * 'busy' och kan räkna det som en abort istället för att vänta.
 *
 * En 500ms watchdog (writeSlotWatchdog) tvångs-släpper sloten om noble
 * skulle hänga utan att resolvar — annars dör all output för evigt.
 */

import { getDevice, setDevice, bleStats, isDemandActive } from './state.js';

// Pre-allocated write buffers (zero alloc per tick)
export const writeBuf = Buffer.from([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
export const brightBuf = Buffer.from([0x7e, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]);
export const brightMaxBuf = Buffer.from([0x7e, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0xef]);

// ── Dimming gamma ──
let dimmingGamma = 1.8;
export function setDimmingGamma(v: number) {
  dimmingGamma = Math.max(1.0, Math.min(3.0, v));
  rebuildBrightnessLut();
}
export function getDimmingGamma(): number { return dimmingGamma; }

// Pre-computed brightness LUT (101 entries for 0–100%)
const brightnessLut = new Float64Array(101);
function rebuildBrightnessLut(): void {
  for (let i = 0; i <= 100; i++) {
    const norm = i / 100;
    brightnessLut[i] = norm <= 0 ? 0 : Math.pow(norm, dimmingGamma);
  }
}
rebuildBrightnessLut();

function brightnessToScale(brightness: number): number {
  const idx = brightness < 0 ? 0 : brightness > 100 ? 100 : (brightness + 0.5) | 0;
  return brightnessLut[idx];
}

// ── Write result type — synkron rapport till engine ──
export type WriteResult =
  | 'sent'         // write fire-and-forgot → till noble
  | 'busy'         // BLE-slot upptagen (föregående writeAsync ej resolvad)
  | 'rate-limited' // < 35ms sedan senaste write
  | 'no-change'    // delta-skip (samma färg+brightness)
  | 'no-device';   // ingen ConnectedDevice

// ── Write state ──
const WRITE_SLOT_TIMEOUT_MS = 500;
// LEGACY: rate-limit-gaten är borta. Single-slot hard-fail (writeSlot)
// tillsammans med engine.tickMs är hela backpressure-kontraktet.
// Funktionerna behålls som no-op för att inte bryta /api/ble/rate-limit.
export function getMinWriteIntervalMs(): number { return 0; }
export function setMinWriteIntervalMs(_ms: number): void { /* no-op */ }
let lastR = -1, lastG = -1, lastB = -1, lastBr = -1;
let writeSlot: Promise<void> | null = null;
let writeSlotWatchdog: ReturnType<typeof setTimeout> | null = null;
let lastWriteTime = 0;
let writeFailCount = 0;
const WRITE_FAIL_THRESHOLD = 5;
// Rate-limit för stuck-warn-loggen — annars kan en hängande writeAsync
// spamma journald var 500ms i timmar och äta diskutrymme på Pi:n.
let lastStuckWarnAt = 0;
const STUCK_WARN_INTERVAL_MS = 10_000;

export function resetLastSent(): void {
  lastR = lastG = lastB = lastBr = -1;
  if (writeSlotWatchdog) { clearTimeout(writeSlotWatchdog); writeSlotWatchdog = null; }
  writeSlot = null;
  lastWriteTime = 0;
  bleStats.requestedIntervalMs = '—';
  bleStats.actualIntervalMs = '—';
  bleStats.intervalSource = 'unknown';
}

export function getLastWriteTime(): number { return lastWriteTime; }
export function setLastWriteTime(t: number): void { lastWriteTime = t; }

// ── Keepalive (idle-vägen) ──
// 200ms = enda idle-vägen. Bär BÅDE BLE-länken (förhindrar reason=8) OCH
// idle-färgen (writeBuf är redan synkat via setIdleColor). Engine startar
// keep-alive vid BLE-connect + setPlaying(false), stoppar vid setPlaying(true)
// + onBleDisconnected. Aldrig parallellt med sendToBLE.
const KEEPALIVE_MS = 200;
const KEEPALIVE_FAIL_THRESHOLD = 5;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveFailCount = 0;
let keepAliveSentCount = 0;

export function getKeepAliveSentCount(): number { return keepAliveSentCount; }

export function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveFailCount = 0;
  keepAliveSentCount = 0;
  lastWriteTime = performance.now();
  keepAliveTimer = setInterval(() => {
    const device = getDevice();
    if (!device) return;
    const elapsed = performance.now() - lastWriteTime;
    if (elapsed < KEEPALIVE_MS * 0.8) return;

    // KONTRAKT: bara EN aktiv BLE-write i taget. Om writeSlot är upptagen
    // eller någon annan write skedde nyss räcker den för att hålla länken
    // vid liv — keep-alive hoppar över denna runda. Detta hindrar parallella
    // writes som annars skulle bygga noble-kö och ge osynk mitt i låten.
    if (writeSlot) return;

    const buf = device.mode === 'brightness' ? brightBuf : writeBuf;
    const startedAt = performance.now();
    lastWriteTime = startedAt;

    // Fire-and-forget genom samma single-slot-mekanism som sendToBLE.
    const p: Promise<void> = device.characteristic.writeAsync(buf, true)
      .then(() => {
        keepAliveSentCount++;
        // Räkna keep-alive-writes mot bleStats.sentCount så /api/ble/output
        // visar pkt/s för BÅDA vägarna (mic-driven OCH idle keep-alive).
        // Annars dyker keep-alive-paketen upp som "tysta" — UI:t visar 0 pkt/s
        // trots att lampan får ~2.5 paket/s i idle.
        bleStats.sentCount++;
        if (keepAliveFailCount > 0) {
          console.log(`[BLE] Keep-alive recovered after ${keepAliveFailCount} failures`);
          keepAliveFailCount = 0;
        }
      })
      .catch((e: any) => {
        keepAliveFailCount++;
        if (keepAliveFailCount <= 3 || keepAliveFailCount % 10 === 0) {
          console.warn(`[BLE] Keep-alive write failed (${keepAliveFailCount}x): ${e?.message ?? e}`);
        }
        if (keepAliveFailCount >= KEEPALIVE_FAIL_THRESHOLD && getDevice()) {
          // BLEDOM supervision timeout (reason=8) triggar inte alltid
          // peripheral.once('disconnect') i tid — keep-alive failar 5x
          // innan eventet hinner fyra. Markera länken död + STARTA
          // auto-reconnect-loop direkt så användaren slipper trycka Anslut.
          console.warn(`[BLE] keep-alive failed ${keepAliveFailCount}x — link lost, marking disconnected + scheduling auto-reconnect`);
          stopKeepAlive();
          import('./connect-hardcoded.js').then(({ forceCleanupStalePeripheral, scheduleAutoReconnect }) => {
            forceCleanupStalePeripheral('keep-alive-fail')
              .catch(() => {})
              .finally(() => {
                // scheduleAutoReconnect aktiverar _autoReconnectEnabled internt
                // om vi någon gång har varit anslutna (bleStats.disconnectCount>0).
                scheduleAutoReconnect();
              });
          }).catch(() => {});

          // Bevara legacy demand-baserad reconnect om någon framtida konsument vill ha den
          if (isDemandActive()) {
            const dev = getDevice();
            if (dev) {
              const periph = dev.peripheral;
              const name = dev.name;
              periph.removeAllListeners('disconnect');
              setDevice(null);
              resetLastSent();
              Promise.resolve(periph.disconnectAsync?.()).catch(() => {}).finally(() => {
                if (_triggerReconnect) _triggerReconnect(periph, name);
              });
            }
          }
        }
      })
      .finally(() => {
        if (writeSlot === p) {
          writeSlot = null;
          if (writeSlotWatchdog) { clearTimeout(writeSlotWatchdog); writeSlotWatchdog = null; }
        }
      });

    writeSlot = p;
    if (writeSlotWatchdog) clearTimeout(writeSlotWatchdog);
    writeSlotWatchdog = setTimeout(() => {
      if (writeSlot === p) {
        bleStats.writeStuckCount++;
        writeSlot = null;
        writeSlotWatchdog = null;
      }
    }, WRITE_SLOT_TIMEOUT_MS);
  }, KEEPALIVE_MS);
}

export function stopKeepAlive(): void {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// Forward declaration — set by reconnect module to break circular dep
let _triggerReconnect: ((peripheral: any, name: string) => void) | null = null;
export function setReconnectTrigger(fn: (peripheral: any, name: string) => void): void {
  _triggerReconnect = fn;
}

/**
 * SYNKRON BLE-write — hard-fail om sloten är upptagen.
 * Returnerar WriteResult direkt; engine kan räkna utfallet utan await.
 * writeAsync triggas fire-and-forget; resultatet rapporteras via .then/.catch.
 */
export function sendToBLE(r: number, g: number, b: number, brightness: number): WriteResult {
  const device = getDevice();
  if (!device) return 'no-device';

  // Steg 1: BLE-slot ledig? (Single-slot hard-fail = vårt enda backpressure-skydd.
  // Ingen separat rate-limit — engine.tickMs styr maxtakten in, slot-checken
  // fångar om noble fortfarande håller på med förra writen.)
  if (writeSlot) {
    bleStats.skipInFlightCount++;
    bleStats.skipBusyCount++;
    return 'busy';
  }

  const now = performance.now();

  // Steg 3: Brightness-skala + delta-check
  const scale = brightnessToScale(brightness);
  const cr = (r * scale + 0.5) | 0;
  const cg = (g * scale + 0.5) | 0;
  const cb = (b * scale + 0.5) | 0;
  const cbr = (scale * 0xff + 0.5) | 0;

  // Stale-write force: vid tyst musik (R=G=B=0 över flera ticks) skulle
  // delta-skip annars stoppa ALLA writes — och eftersom keep-alive är
  // stoppad i active mode tappar BLEDOM länken på ~7s (reason=8 supervision
  // timeout). Tröskeln 400ms = samma som keep-alive-intervallet, säkert
  // under BLEDOM-timeouten även med jitter. När tröskeln passeras skippar
  // vi delta-checken och skickar samma färg igen som "soft keep-alive".
  const STALE_WRITE_MS = 400;
  const isStale = (now - lastWriteTime) >= STALE_WRITE_MS;
  if (!process.env.BLE_NO_DELTA_SKIP && !isStale &&
      cr === lastR && cg === lastG && cb === lastB && cbr === lastBr) {
    bleStats.skipDeltaCount++;
    return 'no-change';
  }

  // Steg 4: Bygg buffer + fire-and-forget write
  const mode = device.mode ?? 'rgb';
  let buf: Buffer;
  if (mode === 'brightness') {
    brightBuf[3] = cbr;
    buf = brightBuf;
  } else {
    writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
    buf = writeBuf;
  }

  // Markera slot UPPTAGEN innan vi triggar write — fönstret mellan här
  // och .then() är där alla efterföljande ticks ser 'busy'.
  const writeStartedAt = now;
  lastR = cr; lastG = cg; lastB = cb; lastBr = cbr;
  // Reservera lastWriteTime direkt så rate-limit-gaten räknar från start,
  // inte från resolve — annars kan en långsam write låta nästa tick smita
  // förbi gaten direkt efter resolve.
  lastWriteTime = now;

  const writePromise = device.characteristic.writeAsync(buf, true)
    .then(() => {
      const elapsed = performance.now() - writeStartedAt;
      bleStats.sentCount++;
      bleStats.writeLatMs = Math.round(elapsed * 10) / 10;
      bleStats.writeLatAvgMs = Math.round(
        (bleStats.writeLatAvgMs * 0.9 + elapsed * 0.1) * 10
      ) / 10;
      if (elapsed > bleStats.writeLatMaxMs) bleStats.writeLatMaxMs = Math.round(elapsed * 10) / 10;
      if (lastWriteTime > 0) bleStats.effectiveIntervalMs = Math.round(writeStartedAt - (lastWriteTime - (writeStartedAt - now)));
      if (writeFailCount > 0) console.log(`[BLE] Write recovered after ${writeFailCount} failures`);
      writeFailCount = 0;
      if (bleStats.intervalSource === 'estimated' && bleStats.sentCount > 50) {
        bleStats.actualIntervalMs = bleStats.writeLatAvgMs.toFixed(1) + ' (est)';
      }
    })
    .catch((e: any) => {
      writeFailCount++;
      bleStats.writeFailCount++;
      if (writeFailCount === 1 || writeFailCount === WRITE_FAIL_THRESHOLD) {
        console.warn(`[BLE] Write failed (${writeFailCount}x): ${e?.message ?? e}`);
      }
      if (writeFailCount >= WRITE_FAIL_THRESHOLD && getDevice() && isDemandActive()) {
        console.warn('[BLE] Too many write failures — triggering proactive reconnect');
        const dev = getDevice()!;
        const periph = dev.peripheral;
        const name = dev.name;
        periph.removeAllListeners('disconnect');
        stopKeepAlive();
        setDevice(null);
        resetLastSent();
        Promise.resolve(periph.disconnectAsync?.()).catch(() => {}).finally(() => {
          if (_triggerReconnect) _triggerReconnect(periph, name);
        });
      }
    })
    .finally(() => {
      // Släpp sloten — men bara om denna write fortfarande äger den
      // (watchdogen kan ha tvångs-släppt och en annan write tagit över)
      if (writeSlot === writePromise) {
        writeSlot = null;
        if (writeSlotWatchdog) { clearTimeout(writeSlotWatchdog); writeSlotWatchdog = null; }
      }
    });

  writeSlot = writePromise;

  // Watchdog — om writeAsync hänger >500ms släpp sloten ändå så engine
  // inte fastnar permanent i 'busy'. Räkna stuck-count som signal.
  if (writeSlotWatchdog) clearTimeout(writeSlotWatchdog);
  writeSlotWatchdog = setTimeout(() => {
    if (writeSlot === writePromise) {
      bleStats.writeStuckCount++;
      const now = performance.now();
      if (now - lastStuckWarnAt >= STUCK_WARN_INTERVAL_MS) {
        console.warn(`[BLE] writeAsync stuck >500ms — force-releasing slot (stuckCount=${bleStats.writeStuckCount})`);
        lastStuckWarnAt = now;
      }
      writeSlot = null;
      writeSlotWatchdog = null;
    }
  }, WRITE_SLOT_TIMEOUT_MS);

  return 'sent';
}

/**
 * Synkron idle-färg-uppdate — uppdaterar bara writeBuf + dedup-state.
 * INGEN write triggas här. Keep-alive-loopen (200ms) bär färgen vid nästa tick.
 *
 * Detta är hela "idle-vägen" från engines synvinkel: sätt färgen → keep-alive
 * skickar den. EN ägare i taget (idle keep-alive ELLER active sendToBLE,
 * aldrig båda). Owner-switch sker i piEngine.ts.
 */
export function setIdleColor(r: number, g: number, b: number): void {
  const cr = Math.max(0, Math.min(255, r | 0));
  const cg = Math.max(0, Math.min(255, g | 0));
  const cb = Math.max(0, Math.min(255, b | 0));
  writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
  brightBuf[3] = 0xff;
  lastR = cr; lastG = cg; lastB = cb; lastBr = 0xff;
}
