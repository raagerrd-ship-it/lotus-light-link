/** Den LANGSAMMA analysatortraden (se split.ts). Anteckningar (kommentarerna som stod i koden): docs/analysator/slowWorker.md */
import { workerData, parentPort, receiveMessageOnPort } from 'node:worker_threads';
import { Analyser, hopFeedFactory, type AnalyserConfig } from './analyser.js';
import { PROFILE } from './analyserProfile.js';
import { C_WRITE, C_WAITING, C_WAITING_B, C_WAKE, C_HOP_WRITE, seqLow, HopLaneSlow, type HopFeed, type WorkerData, type WorkerMsg } from './split.js';

const { cfg, buffers, resumeSeq, sync, part = 'all' } = workerData as WorkerData & { cfg: AnalyserConfig };   // TVÅ TRÅDAR
const ctrl = new Int32Array(buffers.ctrl);
const an = part === 'lane' ? null : new Analyser(cfg, { role: 'slow', split: buffers, resumeSeq, sync });
const wantLane = !!buffers.hop && part !== 'slow';
const feedMk = hopFeedFactory();   // analysatorns klocka
if (wantLane && !feedMk) throw new Error('analyser-split: taktvagen utan klocka i profilen (BEAT_FEED)');
const lane = wantLane && feedMk ? new HopLaneSlow(buffers, feedMk(), sync === true) : null;
if (lane && an) an.bigYield = () => { lane.drain(); };   // en tråd
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

const idleSlow = (): boolean => !an || (seqLow(an.slowReadSeq()) === Atomics.load(ctrl, C_WRITE) && an.bigIdle());   // Sov aldrig langre an 200 ms sa ett 'stop' hinner fram
const idleLane = (): boolean => !lane || seqLow(lane.readSeq()) === Atomics.load(ctrl, C_HOP_WRITE);
const WAIT_FLAG = part === 'slow' ? C_WAITING_B : C_WAITING;
while (!stop) {
  const k = Atomics.load(ctrl, C_WAKE);
  if (idleSlow() && idleLane()) {
    Atomics.store(ctrl, WAIT_FLAG, 1);
    Atomics.wait(ctrl, C_WAKE, k, 200);
    Atomics.store(ctrl, WAIT_FLAG, 0);
    pollMessages();
    continue;
  }
  lane?.drain();
  an?.drainRecords();
  pollMessages();
}
