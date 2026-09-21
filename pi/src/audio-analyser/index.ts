/**
 * Portable audio analyser — public API.
 *
 * Usage:
 *   import { createAnalyser } from './audio-analyser';
 *   const a = createAnalyser({ sampleRate: 48000, hopSize: 128 });
 *   // per hop of mono Float32 samples:
 *   const frame = a.process(samples);
 *   // frame.level, frame.kick, frame.bpm, frame.dropCount, frame.spec.*, frame.onset.*, ...
 *
 * See README.md and INTEGRATION.md for details.
 */

export { Analyser } from './analyser.js';
export type { AnalyserConfig, Frame, Spectrum, BeatGrid } from './analyser.js';

import { Analyser, type AnalyserConfig } from './analyser.js';
import { createSplitBuffers } from './split.js';

/**
 * LOTUS_ANALYSER_SPLIT (2026-09-21, se split.ts):
 *   (tom)    en analysator i en trad — som forr.
 *   worker   snabba delen har, langsamma (tempo/gridfas/sektion) i en worker_threads-Worker pa egen karna.
 *   inline   bada i SAMMA trad, workern korrs synkront efter varje record — for korbanken: bevisar att den delade
 *            analysatorn ger identiskt resultat som den odelade (deterministiskt, virtuell klocka).
 */
export function createAnalyser(cfg: AnalyserConfig): Analyser {
  const mode = typeof process !== 'undefined' ? process.env?.LOTUS_ANALYSER_SPLIT : undefined;
  if (mode !== 'worker' && mode !== 'inline') return new Analyser(cfg);
  const buffers = createSplitBuffers();
  const fast = new Analyser({ ...cfg, role: 'fast', split: buffers });
  if (mode === 'inline') { fast.setInlinePeer(new Analyser({ ...cfg, role: 'slow', split: buffers })); return fast; }
  // Worker: SAB:arna delas via workerData (structured clone delar SharedArrayBuffer). Bara rena varden i cfg.
  // Importen ar dynamisk sa modulen fortfarande laddar i miljoer utan worker_threads (webblasare/bank).
  import('node:worker_threads').then(({ Worker }) => {
    const w = new Worker(new URL('./slowWorker.js', import.meta.url), { workerData: { cfg: { ...cfg }, buffers } });
    w.on('error', (e) => console.error('[analyser-split] worker FEL:', e?.message ?? e));
    w.on('exit', (code) => console.warn(`[analyser-split] worker avslutad (kod ${code}) — tempo/sektion fryser; starta om motorn`));
    w.unref();
    (fast as any).__worker = w;
    console.log('[analyser-split] langsam analysator i worker startad (tempo/gridfas/sektion)');
  }).catch((e) => console.error('[analyser-split] kunde inte starta worker:', e?.message ?? e));
  return fast;
}
