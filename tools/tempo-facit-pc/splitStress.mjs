// STRESSTEST for den delade analysatorn (2026-09-21 natt, se pi/src/audio-analyser/split.ts).
//   node splitStress.mjs            (SPLIT_DIR = katalog med wav, STRESS_S = 60, CRASH_AT_S = 30, DIST = pi/dist)
// A) worker-laget i realtidstakt STRESS_S s med GC-press pa huvudtraden (50 MB var 2:a s) och en avsiktlig worker-
//    krasch vid CRASH_AT_S (postMessage {type:'crash'}, bara med LOTUS_SPLIT_TEST_CRASH=1): inga tappade records fore
//    kraschen, snabba sidan levererar tempo ur senaste tillstandet under gluggen, tempot ar tillbaka inom 5 s.
// B) flaggforlust vid tapp (in-process, ingen worker): workern ligger > RING_N-8 records efter, F_SIL10 lag i ett
//    overskrivet record -> tempot maste vara 0 efteråt (gamla koden aterstallde det ur tillstandsblocket).
// C) seq-wrap: bada sidor startar vid 2^31-300 records, 1 000 records till -> alla behandlade (gamla koden stannade).
// D) 'stop' till workern: loopen ar synkron, receiveMessageOnPort kravs (gamla koden: workern levde vidare).
// DIST=<katalog> pekar pa en annan dist/audio-analyser (t.ex. baslinjen) for fore/efter-bevis.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
process.env.LOTUS_SECTION ??= '1'; process.env.LOTUS_GRID_PHASE ??= '1'; process.env.LOTUS_SPLIT_TEST_CRASH = '1';
const here = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.DIST || join(here, '..', '..', 'pi', 'dist', 'audio-analyser');
const CORPUS = process.env.SPLIT_DIR || join(here, 'corpus');
const STRESS_S = Number(process.env.STRESS_S ?? 60), CRASH_AT_S = Number(process.env.CRASH_AT_S ?? 30);
const { createAnalyser, Analyser } = await import(pathToFileURL(join(DIST, 'index.js')).href);
const split = await import(pathToFileURL(join(DIST, 'split.js')).href);
const HOP = 128, RATE = 48000;
const CFG = { sampleRate: RATE, hopSize: HOP, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015 };
const results = []; const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };

function readWav(path, maxS = 120) {
  const b = readFileSync(path); const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24);
  let off = 12, dataOff = 44, dataLen = b.length - 44;
  while (off + 8 <= b.length) { const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4); if (id === 'data') { dataOff = off + 8; dataLen = len === 0 ? b.length - dataOff : Math.min(len, b.length - dataOff); break; } off += 8 + len + (len & 1); }
  let n = Math.floor(dataLen / 2 / ch); if (maxS > 0) n = Math.min(n, Math.floor(maxS * rate)); const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2); y[i] = s / ch / 32768; }
  return { y, rate };
}
const files = readdirSync(CORPUS).filter((f) => f.endsWith('.wav'));
const pick = files.find((f) => /pop_ladan|megamix/.test(f)) ?? files[0];
const { y } = readWav(join(CORPUS, pick), STRESS_S + 5);
console.log(`korpus ${pick} (${(y.length / RATE).toFixed(0)} s), dist ${DIST}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hopBuf = new Float32Array(HOP);
/** Mata h:te hoppet ur y (loopar filen). */
function feedHop(an, h, vclock) { const i = (h * HOP) % (y.length - HOP); hopBuf.set(y.subarray(i, i + HOP)); an.setAudioClockMs(h * HOP / RATE * 1000); if (vclock) { if (h === 0) an.setVirtualClock(0); else an.advanceVirtualClock(h * HOP / RATE * 1000); } return an.process(hopBuf); }

// ── A) realtid, GC-press, krasch ────────────────────────────────────────────────────────────────
async function testRealtime() {
  process.env.LOTUS_ANALYSER_SPLIT = 'worker';
  const an = createAnalyser(CFG); an.setGainLock(false);
  await sleep(300);   // workern startar via dynamisk import
  const t0 = performance.now(); let h = 0, crashed = false, crashAtMs = 0, backAtMs = 0, restartsSeen = 0, sawZeroAfterCrash = false;
  let gapFramesWithBpm = 0, gapFrames = 0, maxTick = 0, lastTick = t0, gcRounds = 0, skippedBefore = 0, lagMaxBefore = 0, statsBefore = null;
  let junk = null; let lastGc = t0; let bpmBeforeCrash = 0, firstLockMs = -1;
  await new Promise((res) => {
    const iv = setInterval(() => {
      const now = performance.now(); if (now - lastTick > maxTick) maxTick = now - lastTick; lastTick = now;
      const want = Math.floor((now - t0) / 1000 * RATE / HOP);
      let f = null; while (h < want) { f = feedHop(an, h, false); h++; }
      const st = an.getSplitStats();
      if (f && f.bpm > 0 && firstLockMs < 0) firstLockMs = now - t0;
      if (!crashed && now - t0 >= CRASH_AT_S * 1000) {
        crashed = true; crashAtMs = now - t0; statsBefore = { ...st }; skippedBefore = st.skipped; lagMaxBefore = st.lagMaxMs; bpmBeforeCrash = f?.bpm ?? 0;
        an.__worker?.postMessage({ type: 'crash' }); console.log(`  krasch skickad vid ${(crashAtMs / 1000).toFixed(1)} s, bpm ${bpmBeforeCrash}, stats ${JSON.stringify(st)}`);
      }
      if (crashed && backAtMs === 0 && f) {
        // Gluggen: fran kraschen tills en OMSTARTAD worker har hunnit ikapp (behind < 30 records); dessforinnan ar
        // tillstandsblocket den doda workerns (eller den nya ar mitt i backloggen).
        const frozen = !(st.restarts >= 1 && st.behind < 30);
        if (frozen) { gapFrames++; if (f.bpm > 0) gapFramesWithBpm++; }
        else { if (f.bpm === 0) sawZeroAfterCrash = true; if (f.bpm > 0) { backAtMs = now - t0; console.log(`  tempo tillbaka ${(backAtMs / 1000).toFixed(2)} s (${((backAtMs - crashAtMs) / 1000).toFixed(2)} s efter kraschen, frusen glugg ${gapFrames} frames), bpm ${f.bpm}, stats ${JSON.stringify(st)}`); } }
      }
      if (now - lastGc >= 2000) { lastGc = now; junk = new Float64Array(50 * 1024 * 1024 / 8); junk[junk.length - 1] = h; junk = null; gcRounds++; }
      if (now - t0 > STRESS_S * 1000) { clearInterval(iv); res(); }
    }, 5);
  });
  const st = an.getSplitStats();
  console.log(`  slut: ${h} hop pa ${STRESS_S} s, forsta las ${(firstLockMs / 1000).toFixed(2)} s, GC-rundor ${gcRounds}, storsta tick-glugg ${maxTick.toFixed(0)} ms, stats ${JSON.stringify(st)}`);
  ok('A1 inga tappade records fore kraschen', skippedBefore === 0, `skipped ${skippedBefore}, lagMax ${lagMaxBefore} ms, behind ${statsBefore?.behind}`);
  ok('A2 snabba sidan levererar senaste tempot under gluggen', gapFrames > 0 && gapFramesWithBpm === gapFrames && bpmBeforeCrash > 0, `${gapFramesWithBpm}/${gapFrames} frames med bpm>0 medan blocket var fruset (nya workern borjade pa 0: ${sawZeroAfterCrash})`);
  ok('A3 workern omstartad', (st?.restarts ?? 0) >= 1, `restarts ${st?.restarts}`);
  ok('A4 tempot tillbaka inom 5 s', backAtMs > 0 && backAtMs - crashAtMs <= 5000, backAtMs > 0 ? `${((backAtMs - crashAtMs) / 1000).toFixed(2)} s` : 'aldrig');
  ok('A5 inga tappade records efter omstarten heller', (st?.skipped ?? 1) === 0, `skipped ${st?.skipped}, lagMax ${st?.lagMaxMs} ms (ny worker), lostFlags ${st?.lostFlags}`);
  an.__stopWorker ? an.__stopWorker() : an.__worker?.postMessage({ type: 'stop' });
  await sleep(300);
}

// ── B) flaggforlust vid tapp ────────────────────────────────────────────────────────────────────
function pair(resumeSeq) {
  const buffers = split.createSplitBuffers();
  const fast = new Analyser({ ...CFG, role: 'fast', split: buffers, resumeSeq }); const slow = new Analyser({ ...CFG, role: 'slow', split: buffers, resumeSeq });
  if (resumeSeq) { fast.recSeq = resumeSeq; slow.recSeq = resumeSeq; }   // aven gamla koden (privat falt = vanlig egenskap)
  fast.setGainLock(false); fast.setInlinePeer(slow); return { fast, slow, buffers };
}
function testFlagLoss() {
  const { fast, slow, buffers } = pair(0);
  let h = 0, f = null;
  for (; h < 20 * RATE / HOP; h++) f = feedHop(fast, h, true);
  const locked = f.bpm; if (!(locked > 0)) { ok('B0 las fore tapp', false, 'inget tempo pa 20 s'); return; }
  fast.setInlinePeer(null);                                   // workern "hanger"
  const zero = new Float32Array(HOP); const hEnd = h + Math.round(22 * RATE / HOP);   // 22 s tystnad: F_SIL10 vid 10,35 s, overskrivet efter +10,24 s
  for (; h < hEnd; h++) { fast.setAudioClockMs(h * HOP / RATE * 1000); fast.advanceVirtualClock(h * HOP / RATE * 1000); f = fast.process(zero); }
  const bpmFastLocal = f.bpm;                                 // snabba sidan har nollat lokalt (barrieren haller)
  slow.drainRecords();                                        // workern vaknar: ringen overskriven, F_SIL10-recordet borta
  const stateBpm = new Float64Array(buffers.state)[split.S_BPM];   // vad workern publicerar = vad snabba sidan far nar musiken kommer igen
  fast.setAudioClockMs(h * HOP / RATE * 1000); fast.advanceVirtualClock(h * HOP / RATE * 1000); f = fast.process(zero);   // pullSlowState
  const st = fast.getSplitStats();
  ok('B1 flaggan F_SIL10 lag i ett overskrivet record', st.skipped > 0 && bpmFastLocal === 0, `skipped ${st.skipped}, snabba sidan lokalt ${bpmFastLocal}, last ${locked}`);
  ok('B2 workern slappte tempot efter tappet (flaggan aterskapad ur raknarna)', stateBpm === 0, `S_BPM ${stateBpm} (lostFlags ${st.lostFlags ?? 'n/a'}); snabba sidan efter pull ${f.bpm} (i tystnad nollar den om sjalv varje hop — masken som dolde felet)`);
}

// ── C) seq-wrap ─────────────────────────────────────────────────────────────────────────────────
function testWrap() {
  const start = 2 ** 31 - 300;
  const { fast, slow } = pair(start);
  let f = null; const hops = Math.round(10 * RATE / HOP);
  for (let h = 0; h < hops; h++) f = feedHop(fast, h, true);
  const st = fast.getSplitStats(); const written = fast.recSeq - start;
  ok('C1 alla records behandlade over 2^31-gransen', st.processed === written && st.skipped === 0 && written >= 990, `skrivna ${written}, behandlade ${st.processed}, skipped ${st.skipped}, bpm ${f.bpm}`);
  if (split.seqDelta) {
    const a = split.seqDelta((2 ** 31 + 5) | 0, 2 ** 31 - 3), b = split.seqDelta((2 ** 32 + 7) | 0, 2 ** 32 - 1);
    ok('C2 seqDelta wrap-sakert', a === 8 && b === 8, `${a} ${b}`);
  }
  if (split.packFlagCounts) {
    const before = split.packFlagCounts([1, 0, 3, 0, 127, 0, 0]), after = split.packFlagCounts([1, 2, 3, 1, 128, 1, 0]);
    const lost = split.lostFlags(before, after, split.F_HINT | split.F_VCLOCK_SET);
    ok('C3 lostFlags ur packade raknare', lost === (split.F_SIL10 | split.F_RESET_BAR), `lost ${lost} (vantat ${split.F_SIL10 | split.F_RESET_BAR}; hint/vclock ar recordets egna, sil10 ×2, resetBar 127→0 mod 128)`);
  }
}

// ── E) seqlock-paritet efter krasch mitt i stateWrite ───────────────────────────────────────────
function testSeqlockParity() {
  const buffers = split.createSplitBuffers(); new Int32Array(buffers.ctrl)[split.C_STATE_SEQ] = 7;   // forra workern dog mitt i en skrivning
  const fast = new Analyser({ ...CFG, role: 'fast', split: buffers }); const slow = new Analyser({ ...CFG, role: 'slow', split: buffers });
  fast.setGainLock(false); fast.setInlinePeer(slow);
  for (let h = 0; h < 5 * RATE / HOP; h++) feedHop(fast, h, true);
  const st = fast.getSplitStats();
  ok('E1 snabba sidan laser tillstandet efter udda seqlock', st.processed > 0, `processed ${st.processed} (0 = varje stateRead misslyckas for alltid)`);
}

// ── D) stop-meddelandet nar fram ────────────────────────────────────────────────────────────────
async function testStop() {
  process.env.LOTUS_ANALYSER_SPLIT = 'worker';
  const an = createAnalyser(CFG); await sleep(300);
  let exited = null; an.__worker?.on('exit', (c) => { exited = c; });
  for (let h = 0; h < 100; h++) feedHop(an, h, false);
  an.__stopWorker ? an.__stopWorker() : an.__worker?.postMessage({ type: 'stop' });
  await sleep(1500);
  ok('D1 workern stangs pa stop inom 1,5 s', exited === 0, `exit ${exited}`);
  if (exited === null) await an.__worker?.terminate();
}

if (process.env.ONLY_RT !== '1') { testFlagLoss(); testWrap(); testSeqlockParity(); await testStop(); }
if (process.env.SKIP_RT !== '1') await testRealtime();
const fails = results.filter((r) => !r.pass).length;
console.log(`\nSUMMA ${results.length - fails}/${results.length} godkanda`);
process.exit(fails ? 1 : 0);
