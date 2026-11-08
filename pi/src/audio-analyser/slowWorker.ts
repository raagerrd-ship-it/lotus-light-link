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
 *
 * TAKTVAGEN (split.ts, bara med profilens BEAT_FEED 'slow' = buffers.hop finns): samma trad kor aven systemets taktmatning
 * pa hop-recorden. Da vantar loopen pa C_WAKE (env- och hop-record) i stallet for C_WRITE.
 */
import { workerData, parentPort, receiveMessageOnPort } from 'node:worker_threads';
import { Analyser, type AnalyserConfig } from './analyser.js';
import { PROFILE } from './analyserProfile.js';
import { C_WRITE, C_WAITING, C_WAITING_B, C_WAKE, C_HOP_WRITE, seqLow, HopLaneSlow, type HopFeed, type WorkerData, type WorkerMsg } from './split.js';

// TVÅ TRÅDAR (a3, stora vägen): part 'lane' = bara taktvägen (systemets taktmatning, det motorn läser varje hop) - den väntar
// aldrig bakom en 2048-FFT eller ett computeBpm; part 'slow' = analysatorns långsamma sida (env-recorden + stora vägens hop-record).
// part 'all' (osatt) = båda i samma tråd som förr (utan stora vägen, t.ex. lotus).
const { cfg, buffers, resumeSeq, sync, part = 'all' } = workerData as WorkerData & { cfg: AnalyserConfig };
const ctrl = new Int32Array(buffers.ctrl);
const an = part === 'lane' ? null : new Analyser(cfg, { role: 'slow', split: buffers, resumeSeq, sync });
const P = PROFILE as { slowHopFeed?: () => HopFeed; slowHopFeedModule?: string };
const wantLane = !!buffers.hop && part !== 'slow';
if (wantLane && !P.slowHopFeed && P.slowHopFeedModule) {   // systemets taktmatning laddas bara med taktvagen (modulen registrerar fabriken)
  const log = console.log, info = console.info;
  await import(new URL(P.slowHopFeedModule, import.meta.url).href);
  console.log = log; console.info = info;   // modulen far inte andra trådens loggning (DMX beatFeed.ts drar in quiet.ts)
}
const feedMk = P.slowHopFeed;
if (wantLane && !feedMk) throw new Error('analyser-split: taktvagen utan slowHopFeed i profilen');
const lane = wantLane && feedMk ? new HopLaneSlow(buffers, feedMk(), sync === true) : null;
if (lane && an) an.bigYield = () => { lane.drain(); };   // en tråd: taktvägen mellan varje env-/hop-record (Analyser.bigYield)
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

// Sov aldrig langre an 200 ms sa ett 'stop' hinner fram; i drift vacks vi av notify.
// DEKKER-VAKNING: vantflaggan satts FORE wait-jamforelsen (mot skrivarens store->load): antingen ser skrivaren
// flaggan och notify:ar, eller sa ser wait ett nytt C_WAKE och returnerar direkt.
// C_WAKE okas av varje env-, hop- och stor-record; lases FORE tomhetskollen, sa ett record som skrivs efter kollen
// andrar ordet och wait returnerar direkt. Varje tråd har egen väntflagga (lane: C_WAITING, slow: C_WAITING_B); skrivaren
// väcker alla väntare på C_WAKE med ett anrop.
const idleSlow = (): boolean => !an || (seqLow(an.slowReadSeq()) === Atomics.load(ctrl, C_WRITE) && (!an.bigOn || an.bigIdle()));
const idleLane = (): boolean => !lane || seqLow(lane.readSeq()) === Atomics.load(ctrl, C_HOP_WRITE);
const WAIT_FLAG = part === 'slow' ? C_WAITING_B : C_WAITING;
if (lane || an?.bigOn) while (!stop) {
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
while (!stop && an) {
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
