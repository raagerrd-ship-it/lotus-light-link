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
import { createSplitBuffers, type WorkerData } from './split.js';

/** Omstart av workern (2026-09-21 natt): backoff 1/2/5/5/5 s, hogst 5 omstarter per 10 min, sedan ges upp
 *  (snabba sidan fortsatter leverera ljus med senaste tillstandet i blocket; tempo/sektion fryser). */
export const WORKER_RESTART_BACKOFF_MS = [1000, 2000, 5000, 5000, 5000];
export const WORKER_RESTART_MAX = 5;
export const WORKER_RESTART_WINDOW_MS = 10 * 60_000;

/**
 * LOTUS_ANALYSER_SPLIT (2026-09-21, se split.ts):
 *   (tom)    en analysator i en trad — som forr.
 *   worker   snabba delen har, langsamma (tempo/gridfas/sektion) i en worker_threads-Worker pa egen karna.
 *   inline   bada i SAMMA trad, workern korrs synkront efter varje record — for korbanken: bevisar att den delade
 *            analysatorn ger identiskt resultat som den odelade (deterministiskt, virtuell klocka).
 *
 * Testkrokar pa den returnerade analysatorn (bara worker-laget): __worker (aktuell Worker), __stopWorker() (stanger
 * utan omstart), __workerRestarts (antal omstarter hittills).
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
    let stopped = false;
    const attempts: number[] = [];   // tidpunkter for omstarter inom fonstret
    const start = (resumeSeq: number, why: string) => {
      const data: WorkerData = { cfg: { ...cfg }, buffers, resumeSeq };
      const w = new Worker(new URL('./slowWorker.js', import.meta.url), { workerData: data });
      w.on('error', (e) => console.error('[analyser-split] worker FEL:', e?.message ?? e));
      w.on('exit', (code) => {
        if (stopped || code === 0) { console.log(`[analyser-split] worker stangd (kod ${code})`); return; }
        const now = Date.now();
        while (attempts.length && now - attempts[0] > WORKER_RESTART_WINDOW_MS) attempts.shift();
        if (attempts.length >= WORKER_RESTART_MAX) {
          console.error(`[analyser-split] worker dog (kod ${code}) — ${WORKER_RESTART_MAX} omstarter pa ${WORKER_RESTART_WINDOW_MS / 60000} min, ger upp: tempo/sektion fryser pa senaste tillstandet; starta om motorn`);
          return;
        }
        const delay = WORKER_RESTART_BACKOFF_MS[Math.min(attempts.length, WORKER_RESTART_BACKOFF_MS.length - 1)];
        attempts.push(now);
        const at = fast.fastReadSeq();
        console.warn(`[analyser-split] worker dog (kod ${code}) — omstart #${attempts.length} om ${delay} ms, aterupptar vid record ${at} (skrivet ${fast.fastWriteSeq()})`);
        const t = setTimeout(() => { if (stopped) return; fast.splitRestarts++; start(fast.fastReadSeq(), 'omstart'); }, delay);
        t.unref();
      });
      w.unref();
      (fast as any).__worker = w;
      console.log(`[analyser-split] langsam analysator i worker startad (tempo/gridfas/sektion) — ${why}, fran record ${resumeSeq}`);
    };
    (fast as any).__stopWorker = () => { stopped = true; (fast as any).__worker?.postMessage({ type: 'stop' }); };
    start(0, 'start');
  }).catch((e) => console.error('[analyser-split] kunde inte starta worker:', e?.message ?? e));
  return fast;
}
