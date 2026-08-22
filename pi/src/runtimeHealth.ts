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

/** Anropas en gång per engine-tick med aktuell tickMs. */
export function noteTick(nowMs: number, tickMs: number): void {
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

