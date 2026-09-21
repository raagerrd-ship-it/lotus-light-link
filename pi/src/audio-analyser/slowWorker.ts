/**
 * Den LÅNGSAMMA analysatortråden (se split.ts). Startas av createAnalyser() när
 * LOTUS_ANALYSER_SPLIT=worker: samma Analyser-klass, roll 'slow', matad ur SAB-ringen.
 * Loopen blockerar i Atomics.wait tills den snabba tråden skrivit ett record (10 ms-takt),
 * dränerar allt som ligger, publicerar tillståndet och somnar igen. Ingen event-loop-
 * körning behövs; workern har egen V8-heap, så dess GC rör aldrig ljusvägen.
 */
import { workerData, parentPort } from 'node:worker_threads';
import { Analyser, type AnalyserConfig } from './analyser.js';
import { C_WRITE, type SplitBuffers } from './split.js';

const { cfg, buffers } = workerData as { cfg: AnalyserConfig; buffers: SplitBuffers };
const ctrl = new Int32Array(buffers.ctrl);
const an = new Analyser({ ...cfg, role: 'slow', split: buffers });
let stop = false;
parentPort?.on('message', (m: any) => { if (m?.type === 'stop') stop = true; });

// Sov aldrig längre än 200 ms så ett 'stop' hinner fram; i drift väcks vi var 10 ms av notify.
while (!stop) {
  const w = Atomics.load(ctrl, C_WRITE);
  if (an.slowReadSeq() === w) { Atomics.wait(ctrl, C_WRITE, w, 200); continue; }
  an.drainRecords();
}
