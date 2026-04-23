/**
 * BLE BLEDOM protocol: packet formats, write pipeline, keepalive, brightness.
 *
 * LEASE + CONTROLLER-DRAIN (2026-04-23):
 * sendToBLE() är SYNKRON och returnerar WriteResult direkt. Den awaitar
 * aldrig characteristic.writeAsync — det görs fire-and-forget. Backpressure
 * baseras på TVÅ separata gates:
 *   1. tick-lease  : slotLockedUntil = now + slotLeaseMs (cadence-cap)
 *   2. controller-drain : antal outstanding ACL-paket i noble's HCI-lager
 *
 * Promise-resolution ger INTE drain-signal — `writeAsync(..., true)` resolvar
 * när noble accepterar paketet i sin egen kö, INTE när controller faktiskt
 * sänt det över radio. Drain räknas via noble._aclConnections[handle].pending
 * + _aclQueue (se controllerDrain.ts).
 *
 * Kontrakt: 1 tick = max 1 BLE-write, max 1 outstanding paket i kedjan.
 * Om outstanding fastnar > STUCK_THRESHOLD_MS → trigga reconnect.
 * INGEN force-release — kö kan ALDRIG byggas tyst.
 */

import { getDevice, setDevice, bleStats, isDemandActive } from './state.js';
import { getOutstandingPackets, isControllerDrainAttached } from './controllerDrain.js';

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
  | 'busy'         // slot låst (lease ej utgången ELLER pending writeAsync)
  | 'no-change'    // delta-skip (samma färg+brightness)
  | 'no-device';   // ingen ConnectedDevice

// ── Lease + controller-drain state ──
// Lease-tiden = engine.tickMs. Sätts via setSlotLeaseMs() från piEngine.
// Drain räknas från noble._aclConnections[handle].pending + _aclQueue
// (se controllerDrain.ts). När outstanding > 0 är kedjan inte tom.
let slotLeaseMs = 25;
let slotLockedUntil = 0;
let writePending = false;

// När senaste accepterade write skickades till noble (för outstanding-age).
// Nollas så fort vi sett drain gå till 0 (controller har sänt klart allt).
let lastSendStartedAt = 0;
const STUCK_THRESHOLD_MS = 1000;

// Stuck-recovery: efter STUCK_THRESHOLD_MS av outstanding>0 utan drain
// triggas EN gång per stuck-event ett disconnect/reconnect-cykel. Flaggan
// hindrar att vi spammar reconnect medan länken redan rivs.
let stuckRecoveryInFlight = false;

export function getSlotLeaseMs(): number { return slotLeaseMs; }
export function setSlotLeaseMs(ms: number): void {
  slotLeaseMs = Math.max(5, Math.min(500, ms | 0));
}

// Legacy aliases — vissa callsites och API:er använder fortfarande
// minWriteIntervalMs-namnet. Mappa till lease-slot.
export function getMinWriteIntervalMs(): number { return slotLeaseMs; }
export function setMinWriteIntervalMs(ms: number): void { setSlotLeaseMs(ms); }

let lastR = -1, lastG = -1, lastB = -1, lastBr = -1;
let lastWriteTime = 0;
let writeFailCount = 0;
const WRITE_FAIL_THRESHOLD = 5;
// Rate-limit för stuck-warn-loggen — annars kan en hängande writeAsync
// spamma journald i timmar och äta diskutrymme på Pi:n.
let lastStuckWarnAt = 0;
const STUCK_WARN_INTERVAL_MS = 10_000;

export function resetLastSent(): void {
  lastR = lastG = lastB = lastBr = -1;
  writePending = false;
  slotLockedUntil = 0;
  lastSendStartedAt = 0;
  stuckRecoveryInFlight = false;
  lastWriteTime = 0;
  bleStats.outstandingAgeMs = 0;
  bleStats.requestedIntervalMs = '—';
  bleStats.actualIntervalMs = '—';
  bleStats.intervalSource = 'unknown';
}

export function getLastWriteTime(): number { return lastWriteTime; }
export function setLastWriteTime(t: number): void { lastWriteTime = t; }

// ── Outstanding-tracking + stuck-recovery (delas av sendToBLE + keep-alive) ──
//
// Returnerar 'ready'  = sloten är fri, write tillåten
//            'busy'   = sloten är låst (lease, writePending eller outstanding)
// Vid stuck (outstanding > 0 i > STUCK_THRESHOLD_MS) triggas EN reconnect-cykel.
// Sloten "force-releasas" ALDRIG — frames droppas hellre än att kö byggs.
function leaseAndDrainState(now: number): { gate: 'ready' | 'busy'; outstanding: number } {
  const outstanding = isControllerDrainAttached() ? getOutstandingPackets() : 0;

  // Uppdatera ålder för synlighet i diagnostik
  if (outstanding > 0 && lastSendStartedAt > 0) {
    bleStats.outstandingAgeMs = Math.round(now - lastSendStartedAt);
  } else {
    bleStats.outstandingAgeMs = 0;
    if (lastSendStartedAt > 0 && outstanding === 0) {
      bleStats.controllerCompleteCount++;
      lastSendStartedAt = 0;
    }
  }

  // Stuck → trigga disconnect/reconnect en gång. Sloten förblir låst.
  if (outstanding > 0 && lastSendStartedAt > 0 &&
      (now - lastSendStartedAt) >= STUCK_THRESHOLD_MS &&
      !stuckRecoveryInFlight) {
    stuckRecoveryInFlight = true;
    bleStats.controllerStuckCount++;
    bleStats.lastStuckReason = `outstanding=${outstanding} age=${Math.round(now - lastSendStartedAt)}ms`;
    if (now - lastStuckWarnAt >= STUCK_WARN_INTERVAL_MS) {
      console.warn(`[BLE] controller-drain STUCK: ${bleStats.lastStuckReason} — riv länken + reconnect`);
      lastStuckWarnAt = now;
    }
    const dev = getDevice();
    if (dev) {
      const periph = dev.peripheral;
      const name = dev.name;
      try { periph.removeAllListeners?.('disconnect'); } catch {}
      stopKeepAlive();
      setDevice(null);
      resetLastSent();
      stuckRecoveryInFlight = false; // resetLastSent nollar redan, men explicit
      Promise.resolve(periph.disconnectAsync?.()).catch(() => {}).finally(() => {
        import('./connect-hardcoded.js').then(({ scheduleAutoReconnect }) => {
          scheduleAutoReconnect();
        }).catch(() => {});
      });
    }
    return { gate: 'busy', outstanding };
  }

  if (writePending)             return { gate: 'busy', outstanding };
  if (now < slotLockedUntil)    return { gate: 'busy', outstanding };
  if (outstanding > 0)          return { gate: 'busy', outstanding };
  return { gate: 'ready', outstanding };
}

// ── Keepalive (idle-vägen) ──
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
    const now = performance.now();
    const elapsed = now - lastWriteTime;
    if (elapsed < KEEPALIVE_MS * 0.8) return;

    // STRICT SINGLE-SLOT: keep-alive följer EXAKT samma gate som sendToBLE.
    // Active path har företräde — om sloten är låst, en write hänger eller
    // outstanding > 0 hoppar keep-alive över denna runda.
    const { gate } = leaseAndDrainState(now);
    if (gate === 'busy') return;

    const buf = device.mode === 'brightness' ? brightBuf : writeBuf;
    writePending = true;
    lastSendStartedAt = now;
    slotLockedUntil = now + slotLeaseMs;
    lastWriteTime = now;

    device.characteristic.writeAsync(buf, true)
      .then(() => {
        keepAliveSentCount++;
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
          console.warn(`[BLE] keep-alive failed ${keepAliveFailCount}x — link lost, marking disconnected + scheduling auto-reconnect`);
          stopKeepAlive();
          import('./connect-hardcoded.js').then(({ forceCleanupStalePeripheral, scheduleAutoReconnect }) => {
            forceCleanupStalePeripheral('keep-alive-fail')
              .catch(() => {})
              .finally(() => { scheduleAutoReconnect(); });
          }).catch(() => {});

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
        // Släpp ENDAST writePending. slotLockedUntil + outstanding-räkning
        // styr när NÄSTA write får ske.
        writePending = false;
      });
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
 * SYNKRON BLE-write — lease + controller-drain gate, hard-fail om något i
 * kedjan är upptaget. Returnerar WriteResult direkt; engine kan räkna utan
 * await. writeAsync triggas fire-and-forget; resultatet rapporteras via
 * .then/.catch.
 *
 * Kontrakt: 1 tick = max 1 write, max 1 outstanding ACL-paket i HCI-lagret.
 * Sloten "force-releasas" ALDRIG. Om outstanding fastnar > STUCK_THRESHOLD_MS
 * triggas disconnect/reconnect (i leaseAndDrainState) — kö kan ALDRIG byggas.
 */
export function sendToBLE(r: number, g: number, b: number, brightness: number): WriteResult {
  const device = getDevice();
  if (!device) return 'no-device';

  const now = performance.now();

  // ── Gate: lease + controller-drain (delas med keep-alive) ──
  const { gate, outstanding } = leaseAndDrainState(now);
  if (gate === 'busy') {
    bleStats.skipBusyCount++;
    if (writePending) bleStats.skipInFlightCount++;
    if (now < slotLockedUntil) bleStats.skipLeaseLockedCount++;
    if (outstanding > 0) bleStats.skipControllerBusyCount++;
    return 'busy';
  }

  // Brightness-skala + delta-check
  const scale = brightnessToScale(brightness);
  const cr = (r * scale + 0.5) | 0;
  const cg = (g * scale + 0.5) | 0;
  const cb = (b * scale + 0.5) | 0;
  const cbr = (scale * 0xff + 0.5) | 0;

  // Stale-write force: vid tyst musik (R=G=B=0) skulle delta-skip annars
  // stoppa ALLA writes; keep-alive är inte garanterad i active mode.
  const STALE_WRITE_MS = 400;
  const isStale = (now - lastWriteTime) >= STALE_WRITE_MS;
  if (!process.env.BLE_NO_DELTA_SKIP && !isStale &&
      cr === lastR && cg === lastG && cb === lastB && cbr === lastBr) {
    bleStats.skipDeltaCount++;
    return 'no-change';
  }

  // Bygg buffer + fire-and-forget write
  const mode = device.mode ?? 'rgb';
  let buf: Buffer;
  if (mode === 'brightness') {
    brightBuf[3] = cbr;
    buf = brightBuf;
  } else {
    writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
    buf = writeBuf;
  }

  // ── LÅS SLOTEN ──
  // slotLockedUntil hindrar nästa tick även om writeAsync resolvar på <1ms.
  // lastSendStartedAt driver outstanding-age + stuck-detektion.
  lastR = cr; lastG = cg; lastB = cb; lastBr = cbr;
  const writeStartedAt = now;
  writePending = true;
  lastSendStartedAt = now;
  slotLockedUntil = now + slotLeaseMs;
  lastWriteTime = now;

  device.characteristic.writeAsync(buf, true)
    .then(() => {
      const elapsed = performance.now() - writeStartedAt;
      bleStats.sentCount++;
      bleStats.writeLatMs = Math.round(elapsed * 10) / 10;
      bleStats.writeLatAvgMs = Math.round(
        (bleStats.writeLatAvgMs * 0.9 + elapsed * 0.1) * 10
      ) / 10;
      if (elapsed > bleStats.writeLatMaxMs) bleStats.writeLatMaxMs = Math.round(elapsed * 10) / 10;
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
      // Släpp ENDAST writePending. slotLockedUntil + outstanding-räkning
      // styr när NÄSTA write får ske — promise-resolve är INTE drain-signal.
      writePending = false;
    });

  return 'sent';
}

/**
 * Synkron idle-färg-uppdate — uppdaterar bara writeBuf + dedup-state.
 * INGEN write triggas här. Keep-alive-loopen (200ms) bär färgen vid nästa tick.
 */
export function setIdleColor(r: number, g: number, b: number): void {
  const cr = Math.max(0, Math.min(255, r | 0));
  const cg = Math.max(0, Math.min(255, g | 0));
  const cb = Math.max(0, Math.min(255, b | 0));
  writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
  brightBuf[3] = 0xff;
  lastR = cr; lastG = cg; lastB = cb; lastBr = 0xff;
}
