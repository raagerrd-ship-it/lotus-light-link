/**
 * Portable audio analyser — public API (lotus).
 *
 * Usage:
 *   import { createAnalyser } from './audio-analyser';
 *   const a = createAnalyser({ sampleRate: 48000, hopSize: 128 });
 *   // per hop of mono Float32 samples:
 *   const frame = a.process(samples);
 *   // frame.level, frame.kick, frame.bpm, frame.dropCount, frame.spec.*, frame.onset.*, ...
 *
 * Analysatorn (analyser.ts, split.ts, slowWorker.ts, tempoTracker.ts) ar GEMENSAM med pi-dmx - samma byte i
 * bada repona. Systemets egna standardvarden ligger i analyserProfile.ts. createAnalyser (med
 * LOTUS_ANALYSER_SPLIT = worker | inline) bor i analyser.ts. See README.md and INTEGRATION.md for details.
 */

export { Analyser, createAnalyser, WORKER_RESTART_BACKOFF_MS, WORKER_RESTART_MAX, WORKER_RESTART_WINDOW_MS } from './analyser.js';
export type { AnalyserConfig, Frame, Spectrum, BeatGrid } from './analyser.js';
