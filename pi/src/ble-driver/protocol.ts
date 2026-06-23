/**
 * BLE BLEDOM protocol: packet formats, write pipeline, keepalive, brightness.
 *
 * LEASE + ACL-OUTSTANDING GATE (2026-04-28):
 * sendToBLE() är SYNKRON och returnerar WriteResult direkt. Den awaitar
 * aldrig characteristic.writeAsync — det görs fire-and-forget. Backpressure
 * baseras på TVÅ saker:
 *   1. tick-lease: slotLockedUntil = now + slotLeaseMs (cadence-cap)
 *   2. ACL-outstanding: blockerar när host-räkningen av outstanding ACL-paket
 *      når ACL_MAX_OUTSTANDING (default 6, en marginal under HCI:s acl_max_pkt=7).
 *      Annars riskerar vi att fylla kärnans HCI-kö och få "ACL packet for
 *      unknown handle"/dropped-paket-loggar i dmesg samt fade-smoothing-glapp
 *      när controllern inte hinner sända i takt.
 *
 * Stuck-detektion behålls (>1000ms outstanding → räkna + warn, ingen force-disconnect).
 */

import { getDevice, setDevice, bleStats, isDemandActive } from './state.js';
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
  | 'sent'         // write fire-and-forgot → till noble
  | 'busy'         // slot låst (lease ej utgången ELLER pending writeAsync)
  | 'no-change'    // delta-skip (samma färg+brightness)
  | 'no-device';   // ingen ConnectedDevice

// ── Lease state ──
// Lease-tiden = engine.tickMs. Sätts via setSlotLeaseMs() från piEngine.
let slotLeaseMs = 25;
let slotLockedUntil = 0;
let writePending = false;


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



let lastR = -1, lastG = -1, lastB = -1, lastBr = -1;
let lastWriteTime = 0;
let writeFailCount = 0;
let _writeLatAvgPrecise = 0;
const WRITE_FAIL_THRESHOLD = 5;
// Rate-limit för stuck-warn-loggen — annars kan en hängande drain-diagnostik
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
  _writeLatAvgPrecise = 0;
  bleStats.controllerOutstandingCount = 0;
  bleStats.outstandingAgeMs = 0;
  bleStats.requestedIntervalMs = '—';
  bleStats.actualIntervalMs = '—';
  bleStats.intervalSource = 'unknown';
}



/** Senast skickade RGB + brightness-scale (0–255). För UI-display (Output-färg). */
export function getLastSent(): { r: number; g: number; b: number; brightness: number } | null {
  if (lastR < 0) return null;
  return { r: lastR, g: lastG, b: lastB, brightness: lastBr };
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

  if (writePending)          return 'busy';
  if (now < slotLockedUntil) return 'busy';
  // Hård host-side ACL-gate: aldrig fler än ACL_MAX_OUTSTANDING paket ute samtidigt.
  // Bara aktiv när drain faktiskt är attached — annars degraderar vi till lease-only
  // (säkrare än att aldrig skriva när noble-internalen flyttats i en framtida build).
  if (drainAttached && outstanding >= ACL_MAX_OUTSTANDING) return 'busy';
  return 'ready';
}

/**
 * BILLIG, BIVERKNINGSFRI readiness-check (2026-06-02).
 * Speglar leaseAndDrainState()'s 'ready'-villkor UTAN att mutera stats eller
 * trigga stuck-recovery. Används av engine.onFFTFrame som pre-gate så att den
 * dyra tickInner-beräkningen hoppas över när BLE ändå inte kan ta emot writen
 * (lease-lock, pending write, eller ACL-outstanding-tak). BLE-out blir därmed
 * den faktiska takt-styrningen — ingen CPU bränns på frames som dör som 'busy'.
 */
export function canWriteNow(): boolean {
  if (!getDevice()) return false;
  if (writePending) return false;
  if (performance.now() < slotLockedUntil) return false;
  const drainAttached = isControllerDrainAttached();
  if (drainAttached && getOutstandingPackets() >= ACL_MAX_OUTSTANDING) return false;
  return true;
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
        // Släpp ENDAST writePending. slotLockedUntil styr nästa write.
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
 * SYNKRON BLE-write — lease- + ACL-outstanding-gate.
 * Returnerar WriteResult direkt; engine kan räkna utan await. writeAsync
 * triggas fire-and-forget; resultatet rapporteras via .then/.catch.
 */
export function sendToBLE(r: number, g: number, b: number, brightness: number): WriteResult {
  const device = getDevice();
  if (!device) return 'no-device';

  const now = performance.now();

  // ── Gate: lease + writePending + ACL-outstanding ──
  if (leaseAndDrainState(now) === 'busy') {
    bleStats.skipBusyCount++;
    if (writePending) {
      bleStats.skipInFlightCount++;
    } else if (now < slotLockedUntil) {
      bleStats.skipLeaseLockedCount++;
    } else {
      // Inte lease, inte writePending → måste vara ACL-gate.
      bleStats.skipControllerBusyCount++;
    }
    return 'busy';
  }

  // BLEDOM RGB-mode: brightness-byten har ingen effekt i 0x03-packet — bara
  // RGB-värdena styr ljusstyrkan. Därför MÅSTE vi pre-skala RGB med brightness.
  // (Tidigare försök att skicka mättat RGB gav konstant max ljusstyrka → vitt.)
  // Perceptual gamma-LUT är aktiv via brightnessToScale().
  const scale = brightnessToScale(brightness);
  const cr = (r * scale + 0.5) | 0;
  const cg = (g * scale + 0.5) | 0;
  const cb = (b * scale + 0.5) | 0;
  const cbr = (scale * 0xff + 0.5) | 0;

  // Delta-skip borttaget (2026-06): varje write som passerar lease/ACL-gaten
  // skickas, även identiska färger. ACL-outstanding-gaten + tickMs styr takten.



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
      _writeLatAvgPrecise = _writeLatAvgPrecise * 0.9 + elapsed * 0.1;
      bleStats.writeLatAvgMs = Math.round(_writeLatAvgPrecise * 10) / 10;
      if (elapsed > bleStats.writeLatMaxMs) bleStats.writeLatMaxMs = Math.round(elapsed * 10) / 10;
      if (writeFailCount > 0) dlog(`[BLE] Write recovered after ${writeFailCount} failures`);
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
      // Släpp ENDAST writePending. slotLockedUntil styr när nästa write får ske.
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
