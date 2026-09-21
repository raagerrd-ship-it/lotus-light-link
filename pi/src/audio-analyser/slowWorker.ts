/**
 * Den LÅNGSAMMA analysatortråden (se split.ts). Startas av createAnalyser() när
 * LOTUS_ANALYSER_SPLIT=worker: samma Analyser-klass, roll 'slow', matad ur SAB-ringen.
 * Loopen blockerar i Atomics.wait tills den snabba tråden skrivit ett record (10 ms-takt),
 * dränerar allt som ligger, publicerar tillståndet och somnar igen. Ingen event-loop-
 * körning behövs; workern har egen V8-heap, så dess GC rör aldrig ljusvägen.
 *
 * MEDDELANDEN (2026-09-21 natt): loopen är synkron och kör ALDRIG event-loopen, så
 * `parentPort.on('message')` fyrade aldrig — 'stop' var dött (bevisat i splitStress.mjs:
 * workern levde 2 s efter stop med gamla koden). Nu läses porten synkront med
 * receiveMessageOnPort() varje varv (100/s, mikrosekunder).
 *
 * OMSTART: dör tråden (kastat fel, OOM) startar index.ts en ny med SAMMA buffertar och
 * resumeSeq = senast lästa record, så den fortsätter i sekvensen (backloggen klipps till
 * RING_N-RING_MARGIN i drainRecords). `crash` finns bara bakom LOTUS_SPLIT_TEST_CRASH=1.
 */
import { workerData, parentPort, receiveMessageOnPort } from 'node:worker_threads';
import { Analyser, type AnalyserConfig } from './analyser.js';
import { C_WRITE, C_WAITING, seqLow, type WorkerData, type WorkerMsg } from './split.js';

const { cfg, buffers, resumeSeq } = workerData as WorkerData & { cfg: AnalyserConfig };
const ctrl = new Int32Array(buffers.ctrl);
const an = new Analyser({ ...cfg, role: 'slow', split: buffers, resumeSeq });
const TEST_CRASH = process.env.LOTUS_SPLIT_TEST_CRASH === '1';
let stop = false;

function pollMessages(): void {
  if (!parentPort) return;
  for (;;) {
    const m = receiveMessageOnPort(parentPort);
    if (!m) return;
    const msg = m.message as WorkerMsg;
    if (msg?.type === 'stop') stop = true;
    else if (msg?.type === 'crash' && TEST_CRASH) throw new Error('LOTUS_SPLIT_TEST_CRASH: avsiktlig worker-krasch (stresstest)');
  }
}

// Sov aldrig längre än 200 ms så ett 'stop' hinner fram; i drift väcks vi var 10 ms av notify.
// C_WAITING sätts FÖRE wait-jämförelsen (Dekker mot skrivarens store→load): antingen ser skrivaren flaggan och
// notify:ar, eller så ser wait ett nytt C_WRITE och returnerar direkt. Skrivaren slipper notify:a 100/s i onödan.
while (!stop) {
  const w = Atomics.load(ctrl, C_WRITE);
  if (seqLow(an.slowReadSeq()) === w) {
    Atomics.store(ctrl, C_WAITING, 1);
    Atomics.wait(ctrl, C_WRITE, w, 200);
    Atomics.store(ctrl, C_WAITING, 0);
    pollMessages();
    continue;
  }
  an.drainRecords();
  pollMessages();
}
