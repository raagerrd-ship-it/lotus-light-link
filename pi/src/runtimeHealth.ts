/**
 * runtimeHealth.ts — mätvärden för live-trimning på en dedikerad Pi Zero 2W.
 *
 * Tre siffror som avslöjar om motorn börjar tappa realtid INNAN ljuset känns
 * segt (CPU-% räcker inte — ALSA kappar buffern tyst):
 *   loopLagMs  — hur mycket en 1s-timer kommer försent (event-loop-blockering)
 *   tickJitter — avvikelse mellan verkliga tick-intervall och tickMs
 *   fftFps     — faktiska FFT-frames/s från ALSA (förväntat 80 @ HOP=600)
 *
 * Ingen egen timer: sample() anropas från den gemensamma 1 Hz-schedulern.
 */

let loopLagEMA = 0;
let loopLagMax = 0;
let lastSampleAt = 0;

let tickJitterEMA = 0;
let tickJitterMax = 0;
let lastTickAt = 0;

let fftFps = 0;
let lastFftCount = 0;

let overrunTotal = 0;
let lastOverrunTotal = 0;
let overrunPerMin = 0;

let lateTickTotal = 0;

// Monoton tick-räknare — watchdogen använder den för att skilja "motorn tickar
// men BLE levererar inte" från "motorn tickar inte alls".
let engineTickTotal = 0;

// ── Native-anrop-instrumentering (2026-08-25) ──
// Tick-frysningar (playback-watchdog-stuck) misstänktes komma från ett
// blockerande native-anrop (BLE-write eller ALSA-callback). Vi tidsstämplar
// varje sådant anrop och behåller peak + senaste långsamma anrop med kontext.
let maxNativeCallMs = 0;
let lastSlowNativeCall: { op: string; ms: number; atIso: string } | null = null;
let slowNativeCallTotal = 0;
let lastSlowLogAt = 0;
const SLOW_NATIVE_MS = 200;
const SLOW_LOG_INTERVAL_MS = 10_000;

/** Anropas efter varje native-anrop (mic-callback, BLE-write) med dess varaktighet. */
export function noteNativeCall(op: string, ms: number, context?: string): void {
  if (ms > maxNativeCallMs) maxNativeCallMs = ms;
  if (ms >= SLOW_NATIVE_MS) {
    slowNativeCallTotal++;
    lastSlowNativeCall = { op, ms: Math.round(ms), atIso: new Date().toISOString() };
    const now = performance.now();
    if (now - lastSlowLogAt >= SLOW_LOG_INTERVAL_MS) {
      lastSlowLogAt = now;
      console.warn(`[Health] slow native call: ${op} ${ms.toFixed(1)}ms${context ? ` (${context})` : ''}`);
    }
  }
}

/** Anropas en gång per engine-tick med aktuell tickMs. */
export function noteTick(nowMs: number, tickMs: number): void {
  engineTickTotal++;
  if (lastTickAt > 0) {
    const dt = nowMs - lastTickAt;
    const jitter = Math.abs(dt - tickMs);
    tickJitterEMA += (jitter - tickJitterEMA) * 0.05;
    if (jitter > tickJitterMax) tickJitterMax = jitter;
    // Tick som kom mer än en halv tick sent = ljuset hann inte uppdateras i tid.
    if (dt > tickMs * 1.5) lateTickTotal++;
  }
  lastTickAt = nowMs;
}

/** Monoton räknare över körda engine-ticks (watchdog-diagnos). */
export function getEngineTickTotal(): number { return engineTickTotal; }

/** Millisekunder sedan senaste engine-tick (watchdog-diagnos). */
export function msSinceLastTick(): number {
  return lastTickAt > 0 ? performance.now() - lastTickAt : -1;
}

/** Anropas vid varje ALSA buffer overrun (tappade samples). */
export function noteOverrun(): void {
  overrunTotal++;
}

/** Anropas ~1 Hz. fftCount = monoton FFT-frame-räknare från alsaMic. */
export function sample(fftCount: number): void {
  const now = performance.now();
  if (lastSampleAt > 0) {
    const dt = now - lastSampleAt;
    const lag = Math.max(0, dt - 1000);
    loopLagEMA += (lag - loopLagEMA) * 0.2;
    if (lag > loopLagMax) loopLagMax = lag;
    fftFps = ((fftCount - lastFftCount) * 1000) / dt;
    overrunPerMin = ((overrunTotal - lastOverrunTotal) * 60000) / dt;
  }
  lastSampleAt = now;
  lastFftCount = fftCount;
  lastOverrunTotal = overrunTotal;
}

/** Läsning nollställer max-värdena (peak sedan förra läsningen). */
export function getRuntimeHealth(): {
  loopLagMsEMA: number; loopLagMsMax: number;
  tickJitterMsEMA: number; tickJitterMsMax: number;
  fftFps: number;
  overrunTotal: number; overrunPerMin: number;
  lateTickTotal: number;
} {
  const out = {
    loopLagMsEMA: loopLagEMA,
    loopLagMsMax: loopLagMax,
    tickJitterMsEMA: tickJitterEMA,
    tickJitterMsMax: tickJitterMax,
    fftFps,
    overrunTotal,
    overrunPerMin,
    lateTickTotal,
  };
  loopLagMax = 0;
  tickJitterMax = 0;
  return out;
}

