/**
 * BLE BLEDOM protocol: packet formats, write pipeline, keepalive, brightness.
 */

import { getDevice, setDevice, bleStats, isDemandActive } from './state.js';
import { pipelineTiming } from '../pipelineTiming.js';

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

// ── Write state ──
const WRITE_FAIL_THRESHOLD = 5;
const WRITE_TIMEOUT_MS = 500;
let lastR = -1, lastG = -1, lastB = -1, lastBr = -1;
let writeInFlight = false;
let lastWriteTime = 0;
let writeFailCount = 0;

export function resetLastSent(): void {
  lastR = lastG = lastB = lastBr = -1;
  writeInFlight = false;
  lastWriteTime = 0;
  bleStats.requestedIntervalMs = '—';
  bleStats.actualIntervalMs = '—';
  bleStats.intervalSource = 'unknown';
}

export function getLastWriteTime(): number { return lastWriteTime; }
export function setLastWriteTime(t: number): void { lastWriteTime = t; }

// ── Keepalive ──
// 400ms is well under BLEDOM's empirical supervision timeout (~1.5–2s on
// Pi when "Connection interval update not available — HCI access limited").
// Previously 1000ms → reason=8 disconnects within 7s on idle links.
const KEEPALIVE_MS = 400;
const KEEPALIVE_FAIL_THRESHOLD = 5;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveFailCount = 0;
let keepAliveSentCount = 0;

export function getKeepAliveSentCount(): number { return keepAliveSentCount; }

export function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveFailCount = 0;
  keepAliveSentCount = 0;
  // Seed lastWriteTime so the first keep-alive fires on schedule rather
  // than skipping because (now - 0) is huge but elapsed-vs-threshold logic
  // sees a stale 0. Anchor writes already happened — count from now.
  lastWriteTime = performance.now();
  keepAliveTimer = setInterval(async () => {
    const device = getDevice();
    if (!device) return;
    const elapsed = performance.now() - lastWriteTime;
    if (elapsed < KEEPALIVE_MS * 0.8) return;
    const buf = device.mode === 'brightness' ? brightBuf : writeBuf;
    try {
      // Anchor write i connect-hardcoded/connect.ts bevisar att denna stack
      // faktiskt returnerar på `true`, medan `false` fastnar i timeout-loop.
      await device.characteristic.writeAsync(buf, true);
      lastWriteTime = performance.now();
      keepAliveSentCount++;
      if (keepAliveFailCount > 0) {
        console.log(`[BLE] Keep-alive recovered after ${keepAliveFailCount} failures`);
        keepAliveFailCount = 0;
      }
    } catch (e: any) {
      keepAliveFailCount++;
      if (keepAliveFailCount <= 3 || keepAliveFailCount % 10 === 0) {
        console.warn(`[BLE] Keep-alive write failed (${keepAliveFailCount}x): ${e.message ?? e}`);
      }
      // Proactive reconnect: too many keep-alive failures → device is dead
      if (keepAliveFailCount >= KEEPALIVE_FAIL_THRESHOLD && device && isDemandActive()) {
        console.warn('[BLE] Keep-alive threshold reached — triggering proactive reconnect');
        const periph = device.peripheral;
        const name = device.name;
        periph.removeAllListeners('disconnect');
        stopKeepAlive();
        setDevice(null);
        resetLastSent();
        try { await periph.disconnectAsync(); } catch {}
        if (_triggerReconnect) _triggerReconnect(periph, name);
      }
    }
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

/** Ultra-fast single-device BLE write with failure detection */
export async function sendToBLE(r: number, g: number, b: number, brightness: number): Promise<void> {
  const device = getDevice();
  if (!device) return;

  const scale = brightnessToScale(brightness);
  const cr = (r * scale + 0.5) | 0;
  const cg = (g * scale + 0.5) | 0;
  const cb = (b * scale + 0.5) | 0;
  const cbr = (scale * 0xff + 0.5) | 0;

  // Timeout guard
  if (writeInFlight) {
    if (lastWriteTime > 0 && (performance.now() - lastWriteTime) > WRITE_TIMEOUT_MS) {
      console.warn('[BLE] Write timeout — forcing writeInFlight release');
      writeInFlight = false;
    } else {
      bleStats.skipInFlightCount++;
      bleStats.skipBusyCount++;
      return;
    }
  }

  // Rate-limit: writeAsync(..., true) = withoutResponse returnerar direkt
  // utan att vänta på radio-ACK → ingen naturlig backpressure. Utan denna
  // gate bygger noble/HCI-buffern kö och lampan släpar 1-2s efter musiken.
  // 35ms = ~28 pkt/s tak, matchar BLEDOM:s reella throughput. Tick 40ms
  // har visat sig stabilt i fält — håll gaten precis under tick-min så
  // slidern (UI) är den verkliga begränsaren.
  const MIN_WRITE_INTERVAL_MS = 35;
  if (lastWriteTime > 0 && (performance.now() - lastWriteTime) < MIN_WRITE_INTERVAL_MS) {
    bleStats.skipRateLimitCount++;
    bleStats.skipBusyCount++;
    return;
  }

  // Delta-skip — kan stängas av via env BLE_NO_DELTA_SKIP=1 för throughput-test.
  if (!process.env.BLE_NO_DELTA_SKIP &&
      cr === lastR && cg === lastG && cb === lastB && cbr === lastBr) {
    bleStats.skipDeltaCount++;
    return;
  }

  writeInFlight = true;
  const now = performance.now();

  try {
    const mode = device?.mode ?? 'rgb';
    let buf: Buffer;
    if (mode === 'brightness') {
      brightBuf[3] = cbr;
      buf = brightBuf;
    } else {
      writeBuf[4] = cr; writeBuf[5] = cg; writeBuf[6] = cb;
      buf = writeBuf;
    }
    // Viktigt: på denna Pi/noble-stack hänger `writeAsync(..., false)` men
    // anchor write med `true` returnerar direkt och lampan håller länken.
    // Därför måste drift-writes använda samma flagga som anchor writen.
    await device.characteristic.writeAsync(buf, true);

    lastR = cr; lastG = cg; lastB = cb; lastBr = cbr;
    bleStats.sentCount++;
    if (writeFailCount > 0) {
      console.log(`[BLE] Write recovered after ${writeFailCount} failures`);
    }
    writeFailCount = 0;

    const elapsed = performance.now() - now;
    bleStats.writeLatMs = Math.round(elapsed * 10) / 10;
    bleStats.writeLatAvgMs = Math.round(
      (bleStats.writeLatAvgMs * 0.9 + elapsed * 0.1) * 10
    ) / 10;
    pipelineTiming.recordBleWrite(elapsed);

    if (lastWriteTime > 0) {
      bleStats.effectiveIntervalMs = Math.round(now - lastWriteTime);
    }
    lastWriteTime = now;

    // Estimate connection interval from write latency if HCI event wasn't available
    if (bleStats.intervalSource === 'estimated' && bleStats.sentCount > 50) {
      bleStats.actualIntervalMs = bleStats.writeLatAvgMs.toFixed(1) + ' (est)';
    }
  } catch (e: any) {
    writeFailCount++;
    bleStats.writeFailCount++;
    if (writeFailCount === 1 || writeFailCount === WRITE_FAIL_THRESHOLD) {
      console.warn(`[BLE] Write failed (${writeFailCount}x): ${e.message ?? e}`);
    }
    if (writeFailCount >= WRITE_FAIL_THRESHOLD && device && isDemandActive()) {
      console.warn('[BLE] Too many write failures — triggering proactive reconnect');
      const periph = device.peripheral;
      const name = device.name;
      periph.removeAllListeners('disconnect');
      stopKeepAlive();
      setDevice(null);
      resetLastSent();
      try { await periph.disconnectAsync(); } catch { }
      if (_triggerReconnect) _triggerReconnect(periph, name);
      return;
    }
  } finally {
    writeInFlight = false;
  }
}

/** Raw color write — bypasses dedup and brightness scaling. For test tools only. */
export async function sendRawColor(r: number, g: number, b: number): Promise<void> {
  const device = getDevice();
  if (!device) return;
  resetLastSent();
  writeBuf[4] = r; writeBuf[5] = g; writeBuf[6] = b;
  try {
    await device.characteristic.writeAsync(writeBuf, true);
  } catch { /* fire-and-forget */ }
}
