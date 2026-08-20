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

/** Anropas en gång per engine-tick med aktuell tickMs. */
export function noteTick(nowMs: number, tickMs: number): void {
  if (lastTickAt > 0) {
    const jitter = Math.abs(nowMs - lastTickAt - tickMs);
    tickJitterEMA += (jitter - tickJitterEMA) * 0.05;
    if (jitter > tickJitterMax) tickJitterMax = jitter;
  }
  lastTickAt = nowMs;
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
  }
  lastSampleAt = now;
  lastFftCount = fftCount;
}

/** Läsning nollställer max-värdena (peak sedan förra läsningen). */
export function getRuntimeHealth(): {
  loopLagMsEMA: number; loopLagMsMax: number;
  tickJitterMsEMA: number; tickJitterMsMax: number;
  fftFps: number;
} {
  const out = {
    loopLagMsEMA: loopLagEMA,
    loopLagMsMax: loopLagMax,
    tickJitterMsEMA: tickJitterEMA,
    tickJitterMsMax: tickJitterMax,
    fftFps,
  };
  loopLagMax = 0;
  tickJitterMax = 0;
  return out;
}
