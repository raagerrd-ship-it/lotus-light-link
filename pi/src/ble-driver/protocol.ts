/**
 * BLE BLEDOM protocol: packet formats, write pipeline, keepalive, brightness.
 *
 * ASYNC 1-SLOT WRITER (2026-08-25):
 * sendToBLE() är SYNKRON och returnerar direkt efter att ha lagt senaste frame
 * i en 1-plats-slot (senaste vinner). En separat writer tömmer sloten när
 * lease + ACL-outstanding-gate är fria. BLE-stall droppar alltså frames utan
 * att engine-ticken/smoothing/beat kan frysa.
 *
 * Stuck-detektion behålls (>1000ms outstanding → räkna + warn, ingen force-disconnect).
 *
 * Conn-interval: 16 units = 20 ms (se forceConnInterval.ts — 7.5 ms hängde Pi:n).
 */

import { getDevice, bleStats } from './state.js';
import { getOutstandingPackets, isControllerDrainAttached } from './controllerDrain.js';
import { dlog } from "./log.js";

// Pre-allocated write buffers (zero alloc per tick)
export const writeBuf = Buffer.from([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
export const brightBuf = Buffer.from([0x7e, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]);
export const brightMaxBuf = Buffer.from([0x7e, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0xef]);

// ── BLEDOM power on/off ──
// Lampan har intern off-state (fjärr-OFF, intern timer, power-glitch)
// där LED-driver är släckt men BLE-radio fortfarande ACK:ar paket.
// Power-byten väcker LED-drivern. Verifierat live på BLEDOM01 2026-05-01.
export const powerOnBuf  = Buffer.from([0x7e, 0x04, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0xef]);
export const powerOffBuf = Buffer.from([0x7e, 0x04, 0x04, 0x00, 0xff, 0x00, 0x00, 0x00, 0xef]);

/** Skicka power on/off till lampan. Returnerar 'sent' | 'no-device' | 'error'. */
export async function sendPower(on: boolean): Promise<'sent' | 'no-device' | 'error'> {
  const device = getDevice();
  if (!device || !device.characteristic) return 'no-device';
  const buf = on ? powerOnBuf : powerOffBuf;
  try {
    await device.characteristic.writeAsync(buf, true);
    dlog(`[protocol] sendPower(${on}) sent`);
    return 'sent';
  } catch (e: any) {
    console.warn(`[protocol] sendPower(${on}) error: ${e?.message ?? e}`);
    return 'error';
  }
}

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
  | 'sent'         // frame accepterad/queued (faktisk write sker i async writer)
  | 'no-device';   // ingen ConnectedDevice

// ── Lease state ──
// Lease-tiden = engine.tickMs. Sätts via setSlotLeaseMs() från piEngine.
let slotLeaseMs = 25;
let slotLockedUntil = 0;
let writePending = false;
// När writePending sattes (stale-release efter WRITE_PENDING_TIMEOUT_MS = 150 ms).
// Om noble/HCI hänger settlar writeAsync aldrig.
// Stale-release gör BLE-stall icke-blockerande: writern kan droppa gamla frames
// och fortsätta med senaste utan att engine-ticken berörs.
// 2026-08-25: 1000ms → 150ms. En hängande write ska kosta EN frame, inte en
// sekund av frusen leverans (motorn tickar vidare, framen droppas).
let writePendingSince = 0;
const WRITE_PENDING_TIMEOUT_MS = 150;


// ── ACL-outstanding gate ──
// HCI på BCM43438 (Pi Zero 2W / Pi3) rapporterar acl_max_pkt=7. Om host
// skickar fler ACL-paket än så utan att vänta på Number_Of_Completed_Packets
// börjar kärnan tappa paket och logga warnings ("hci_send_acl ... no slot").
// Vi låser oss en marginal under taket (6) för att alltid lämna headroom.
// Override via env BLE_ACL_MAX_OUTSTANDING=N (1–7) för tuning utan rebuild.
const ACL_MAX_OUTSTANDING = (() => {
  const raw = parseInt(process.env.BLE_ACL_MAX_OUTSTANDING ?? '', 10);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 7) return raw;
  return 6;
})();

type QueuedFrame = { r: number; g: number; b: number; brightness: number };
let queuedFrame: QueuedFrame | null = null;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainImmediate: ReturnType<typeof setImmediate> | null = null;

let drainRunning = false;
let writeSeq = 0;

// När senaste accepterade write skickades till noble (för drain-diagnostik).
let lastSendStartedAt = 0;
const STUCK_THRESHOLD_MS = 1000;

// Diagnostisk latch: räknar stuck-events en gång per episod, men river inte länk.
let stuckRecoveryInFlight = false;

export function getSlotLeaseMs(): number { return slotLeaseMs; }
export function setSlotLeaseMs(ms: number): void {
  slotLeaseMs = Math.max(5, Math.min(500, ms | 0));
  bleStats.slotLeaseMs = slotLeaseMs;
}



let lastR = -1, lastG = -1, lastB = -1, lastBr = -1, lastPct = -1;
let lastWriteTime = 0;
let writeFailCount = 0;
let _writeLatAvgPrecise = 0;
const WRITE_FAIL_THRESHOLD = 5;
// Rate-limit för stuck-warn-loggen — annars kan en hängande drain-diagnostik
// spamma journald i timmar och äta diskutrymme på Pi:n.
let lastStuckWarnAt = 0;
const STUCK_WARN_INTERVAL_MS = 10_000;

export function resetLastSent(): void {
  lastR = lastG = lastB = lastBr = lastPct = -1;
  clearQueuedWrite();
  writePending = false;
  writeSeq++;
  slotLockedUntil = 0;
  lastSendStartedAt = 0;
  stuckRecoveryInFlight = false;
  lastWriteTime = 0;
  _writeLatAvgPrecise = 0;
  bleStats.controllerOutstandingCount = 0;
  bleStats.outstandingAgeMs = 0;
  bleStats.requestedIntervalMs = '—';
  bleStats.intervalSource = 'unknown';
}

function cancelDrain(): void {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  if (drainImmediate) {
    clearImmediate(drainImmediate);
    drainImmediate = null;
  }
}

/** Drop any not-yet-written active frame without touching an in-flight native write. */
export function clearQueuedWrite(): void {
  queuedFrame = null;
  cancelDrain();
}

export function hasQueuedWrite(): boolean { return queuedFrame != null; }

export function flushQueuedWriteNow(): void {
  cancelDrain();
  drainQueuedWrite();
}




/** Senast skickade RGB + brightness-scale (0–255). För UI-display (Output-färg). */
export function getLastSent(): { r: number; g: number; b: number; brightness: number; pct: number } | null {
  if (lastR < 0) return null;
  // pct = EXAKT det motorn kommenderade (0–100) — samma tal som UI-baren visar.
  // brightness är samma värde efter dimmings-gamma, i BLEDOM:s 0–255-skala.
  return { r: lastR, g: lastG, b: lastB, brightness: lastBr, pct: lastPct };
}

// ── Lease-gate + ACL-outstanding-gate (delas av sendToBLE + keep-alive) ──
//
// Returnerar 'ready' = sloten är fri, write tillåten
//            'busy'  = sloten är låst (lease, writePending, ELLER outstanding ≥ tak)
//
// outstanding ≥ ACL_MAX_OUTSTANDING ⇒ host väntar på Number_Of_Completed_Packets
// från controllern innan vi släpper fram nästa write. Detta är vad som hindrar
// kärnan från att logga dropped ACL-paket samt håller fade-smoothing-takten
// jämn (ingen spike av fördröjda färgändringar när controllern hunnit ikapp).
function leaseAndDrainState(now: number): 'ready' | 'busy' {
  const drainAttached = isControllerDrainAttached();
  const outstanding = drainAttached ? getOutstandingPackets() : 0;
  bleStats.controllerOutstandingCount = outstanding;
  if (outstanding > bleStats.outstandingMaxObserved) {
    bleStats.outstandingMaxObserved = outstanding;
  }

  if (outstanding > 0 && lastSendStartedAt > 0) {
    const ageMs = Math.round(now - lastSendStartedAt);
    bleStats.outstandingAgeMs = ageMs;
    if (ageMs >= STUCK_THRESHOLD_MS && !stuckRecoveryInFlight) {
      stuckRecoveryInFlight = true;
      bleStats.controllerStuckCount++;
      bleStats.lastStuckReason = `outstanding=${outstanding} age=${ageMs}ms`;
      if (now - lastStuckWarnAt >= STUCK_WARN_INTERVAL_MS) {
        console.warn(`[BLE] controller-drain stuck: ${bleStats.lastStuckReason}`);
        lastStuckWarnAt = now;
      }
    }
  } else {
    bleStats.outstandingAgeMs = 0;
    if (lastSendStartedAt > 0 && outstanding === 0) {
      bleStats.controllerCompleteCount++;
      lastSendStartedAt = 0;
    }
    if (outstanding === 0) {
      stuckRecoveryInFlight = false;
    }
  }

  if (writePending) {
    if (now - writePendingSince >= WRITE_PENDING_TIMEOUT_MS) {
      // Stall: släpp sloten så motorn kan fortsätta ticka (write:en får landa senare).
      writePending = false;
      bleStats.writeStallReleaseCount = (bleStats.writeStallReleaseCount ?? 0) + 1;
      if (now - lastStuckWarnAt >= STUCK_WARN_INTERVAL_MS) {
        console.warn(`[BLE] writeAsync stall >${WRITE_PENDING_TIMEOUT_MS}ms — släpper sloten (icke-blockerande recovery)`);
        lastStuckWarnAt = now;
      }
    } else {
      return 'busy';
    }
  }
  if (now < slotLockedUntil) return 'busy';
  // Hård host-side ACL-gate: aldrig fler än ACL_MAX_OUTSTANDING paket ute samtidigt.
  // Bara aktiv när drain faktiskt är attached — annars degraderar vi till lease-only
  // (säkrare än att aldrig skriva när noble-internalen flyttats i en framtida build).
  if (drainAttached && outstanding >= ACL_MAX_OUTSTANDING) return 'busy';
  return 'ready';
}

function recordQueuedDrop(now: number): void {
  bleStats.skipBusyCount++;
  if (writePending) {
    bleStats.skipInFlightCount++;
  } else if (now < slotLockedUntil) {
    bleStats.skipLeaseLockedCount++;
  } else if (isControllerDrainAttached() && getOutstandingPackets() >= ACL_MAX_OUTSTANDING) {
    bleStats.skipControllerBusyCount++;
  }
}

function nextDrainDelay(now: number): number {
  if (writePending) {
    const remaining = WRITE_PENDING_TIMEOUT_MS - (now - writePendingSince);
    return Math.max(1, Math.min(25, remaining));
  }
  if (now < slotLockedUntil) return Math.max(1, Math.min(25, slotLockedUntil - now));
  return 10;
}

function armDrain(delayMs = 0): void {
  if (drainTimer || drainImmediate) return;
  if (delayMs <= 0) {
    // setTimeout(...,0) klampas till 1 ms och kostar en timer-heap-insert per
    // frame (~50-66/s). setImmediate kör fortfarande off caller-stacken.
    drainImmediate = setImmediate(() => {
      drainImmediate = null;
      drainQueuedWrite();
    });
    return;
  }
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainQueuedWrite();
  }, delayMs);
}


function drainQueuedWrite(): void {
  if (drainRunning) return;
  const device = getDevice();
  if (!device || !queuedFrame) return;

  drainRunning = true;
  try {
    const now = performance.now();
    if (leaseAndDrainState(now) === 'busy') {
      armDrain(nextDrainDelay(now));
      return;
    }

    const frame = queuedFrame;
    queuedFrame = null;

    // BLEDOM RGB-mode: brightness-byten har ingen effekt i 0x03-packet — bara
    // RGB-värdena styr ljusstyrkan. Därför MÅSTE vi pre-skala RGB med brightness.
    const scale = brightnessToScale(frame.brightness);
    const cr = (frame.r * scale + 0.5) | 0;
    const cg = (frame.g * scale + 0.5) | 0;
    const cb = (frame.b * scale + 0.5) | 0;
    const cbr = (scale * 0xff + 0.5) | 0;

    const mode = device.mode ?? 'rgb';
    let buf: Buffer;
    if (mode === 'brightness') {
      brightBuf[3] = cbr;
      buf = brightBuf;
    } else {
      writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
      buf = writeBuf;
    }

    lastR = cr; lastG = cg; lastB = cb; lastBr = cbr;
    lastPct = frame.brightness < 0 ? 0 : frame.brightness > 100 ? 100 : frame.brightness;
    const writeStartedAt = now;
    writePending = true;
    writePendingSince = now;
    const seq = ++writeSeq;
    lastSendStartedAt = now;
    slotLockedUntil = now + slotLeaseMs;
    lastWriteTime = now;

    const _syncT0 = performance.now();
    let _writePromise: Promise<unknown>;
    try {
      _writePromise = device.characteristic.writeAsync(buf, true);
    } catch (e: any) {
      writePending = false;
      writeFailCount++;
      bleStats.writeFailCount++;
      console.warn(`[BLE] Write failed (${writeFailCount}x): ${e?.message ?? e}`);
      if (queuedFrame) armDrain(0);
      return;
    }
    const _syncMs = performance.now() - _syncT0;
    if (_syncMs > bleStats.writeSyncMaxMs) bleStats.writeSyncMaxMs = Math.round(_syncMs * 10) / 10;
    if (_syncMs >= 50) {
      bleStats.writeSyncSlowCount++;
      bleStats.lastStuckReason = `write-sync ${_syncMs.toFixed(1)}ms (blocking native call)`;
    }

    _writePromise
      .then(() => {
        const elapsed = performance.now() - writeStartedAt;
        bleStats.sentCount++;
        bleStats.writeLatMs = Math.round(elapsed * 10) / 10;
        _writeLatAvgPrecise = _writeLatAvgPrecise * 0.9 + elapsed * 0.1;
        bleStats.writeLatAvgMs = Math.round(_writeLatAvgPrecise * 10) / 10;
        if (elapsed > bleStats.writeLatMaxMs) bleStats.writeLatMaxMs = Math.round(elapsed * 10) / 10;
        if (writeFailCount > 0) dlog(`[BLE] Write recovered after ${writeFailCount} failures`);
        writeFailCount = 0;
      })
      .catch((e: any) => {
        writeFailCount++;
        bleStats.writeFailCount++;
        if (writeFailCount === 1 || writeFailCount === WRITE_FAIL_THRESHOLD) {
          console.warn(`[BLE] Write failed (${writeFailCount}x): ${e?.message ?? e}`);
        }
      })
      .finally(() => {
        if (seq === writeSeq) writePending = false;
        if (queuedFrame) armDrain(nextDrainDelay(performance.now()));
      });
  } finally {
    drainRunning = false;
  }
}

// ── Keepalive (idle-vägen) ──
const KEEPALIVE_MS = 200;
const KEEPALIVE_FAIL_THRESHOLD = 5;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveFailCount = 0;
let keepAliveSentCount = 0;



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

    // Keep-alive följer samma lease-gate som sendToBLE.
    if (leaseAndDrainState(now) === 'busy') return;

    const buf = device.mode === 'brightness' ? brightBuf : writeBuf;
    writePending = true;
    writePendingSince = now;
    const seq = ++writeSeq;
    lastSendStartedAt = now;
    slotLockedUntil = now + slotLeaseMs;
    lastWriteTime = now;

    device.characteristic.writeAsync(buf, true)
      .then(() => {
        keepAliveSentCount++;
        bleStats.sentCount++;
        if (keepAliveFailCount > 0) {
          dlog(`[BLE] Keep-alive recovered after ${keepAliveFailCount} failures`);
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
          import('./connect.js').then(({ forceCleanupStalePeripheral, scheduleAutoReconnect }) => {
            forceCleanupStalePeripheral('keep-alive-fail')
              .catch(() => {})
              .finally(() => { scheduleAutoReconnect(); });
          }).catch(() => {});
        }
      })
      .finally(() => {
        // Släpp ENDAST writePending. slotLockedUntil styr nästa write.
        if (seq === writeSeq) writePending = false;
      });
  }, KEEPALIVE_MS);
}

export function stopKeepAlive(): void {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

/**
  * SYNKRON BLE-submit — lägger senaste frame i 1-slot och returnerar direkt.
  * Den separata writern gör faktisk writeAsync när BLE-gaten är fri.
 */
export function sendToBLE(r: number, g: number, b: number, brightness: number): WriteResult {
  const device = getDevice();
  if (!device) return 'no-device';

  const now = performance.now();
  if (queuedFrame) recordQueuedDrop(now);
  queuedFrame = { r, g, b, brightness };
  armDrain(0);

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
  lastR = cr; lastG = cg; lastB = cb; lastBr = 0xff; lastPct = 100;
}

/**
 * Diagnostik för watchdogen: är en BLE-write hängande just nu, och hur gammal
 * är den? Används i frys-dumpen för att avgöra BLE kontra mic.
 */
export function getWriteDiag(): {
  writePending: boolean;
  pendingAgeMs: number;
  lastWriteAgeMs: number;
  slotLockedForMs: number;
} {
  const now = performance.now();
  return {
    writePending,
    pendingAgeMs: writePending && writePendingSince > 0 ? Math.round(now - writePendingSince) : 0,
    lastWriteAgeMs: lastWriteTime > 0 ? Math.round(now - lastWriteTime) : -1,
    slotLockedForMs: now < slotLockedUntil ? Math.round(slotLockedUntil - now) : 0,
  };
}
