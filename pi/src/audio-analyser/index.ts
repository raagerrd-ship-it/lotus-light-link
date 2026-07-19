/**
 * Portable audio analyser — public API.
 *
 * Usage:
 *   import { createAnalyser } from './audio-analyser';
 *   const a = createAnalyser({ sampleRate: 48000, hopSize: 480 });
 *   // per hop of mono Float32 samples:
 *   const frame = a.process(samples);
 *   // frame.level, frame.kick, frame.bpm, frame.dropCount, frame.spec.*, frame.onset.*, ...
 *
 * See README.md and INTEGRATION.md for details.
 */

export { Analyser } from './analyser.js';
export type { AnalyserConfig, Frame, Spectrum, BeatGrid } from './analyser.js';

import { Analyser, type AnalyserConfig } from './analyser.js';
export function createAnalyser(cfg: AnalyserConfig): Analyser {
  return new Analyser(cfg);
}
