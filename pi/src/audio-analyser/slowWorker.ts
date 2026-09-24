/**
 * Den LANGSAMMA analysatortraden (se split.ts). Startas av createAnalyser() nar
 * <prefix>ANALYSER_SPLIT=worker: samma Analyser-klass, roll 'slow', matad ur SAB-ringen.
 * Loopen blockerar i Atomics.wait tills den snabba traden skrivit ett record (10 ms-takt),
 * dranerar allt som ligger, publicerar tillstandet och somnar igen. Ingen event-loop-
 * korning behovs; workern har egen V8-heap, sa dess GC ror aldrig ljusvagen.
 *
 * MEDDELANDEN: loopen ar synkron och kor ALDRIG event-loopen, sa `parentPort.on('message')`
 * fyrar aldrig. Porten lases i stallet synkront med receiveMessageOnPort() varje varv (100/s).
 *
 * OMSTART: dor traden (kastat fel, OOM) startar createAnalyser en ny med SAMMA buffertar och
 * resumeSeq = senast lasta record, sa den fortsatter i sekvensen (backloggen klipps till
 * RING_N-RING_MARGIN i drainRecords). `crash` finns bara bakom <prefix>SPLIT_TEST_CRASH=1.
 */
import { workerData, parentPort, receiveMessageOnPort } from 'node:worker_threads';
import { Analyser, type AnalyserConfig } from './analyser.js';
import { PROFILE } from './analyserProfile.js';
import { C_WRITE, C_WAITING, seqLow, type WorkerData, type WorkerMsg } from './split.js';

const { cfg, buffers, resumeSeq } = workerData as WorkerData & { cfg: AnalyserConfig };
const ctrl = new Int32Array(buffers.ctrl);
const an = new Analyser(cfg, { role: 'slow', split: buffers, resumeSeq });
const TEST_CRASH = process.env[PROFILE.envPrefix + 'SPLIT_TEST_CRASH'] === '1';
let stop = false;

function pollMessages(): void {
  if (!parentPort) return;
  for (;;) {
    const m = receiveMessageOnPort(parentPort);
    if (!m) return;
    const msg = m.message as WorkerMsg;
    if (msg?.type === 'stop') stop = true;
    else if (msg?.type === 'crash' && TEST_CRASH) throw new Error('SPLIT_TEST_CRASH: avsiktlig worker-krasch (stresstest)');
  }
}

// Sov aldrig langre an 200 ms sa ett 'stop' hinner fram; i drift vacks vi var 10 ms av notify.
// DEKKER-VAKNING: C_WAITING satts FORE wait-jamforelsen (mot skrivarens store->load): antingen ser skrivaren
// flaggan och notify:ar, eller sa ser wait ett nytt C_WRITE och returnerar direkt.
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
