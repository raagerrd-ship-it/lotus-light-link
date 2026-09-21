// IDENTITETSBEVIS for den delade analysatorn (2026-09-21, se pi/src/audio-analyser/split.ts).
// Kor samma korpus-snuttar genom (A) en odelad analysator och (B) snabb+langsam i inline-lage (workern kors
// synkront efter varje record) med identisk matning (sampelklocka + virtuell klocka som bench.mjs), och jamfor
// per hop: bpm, konfidens, gridfas, sektion, tier, upprepning. Tempo/gridfas ska vara BIT-identiska; sektionen
// far skilja nagra hop vid blockgranser (blocksummorna levereras per env-sampel, inte per hop).
//   node splitProof.mjs [--n 12] [--worker]     (--worker: aven en krasch-/lagg-rokning av riktiga workern)
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
process.env.LOTUS_SECTION ??= '1'; process.env.LOTUS_GRID_PHASE ??= '1';
const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('--n', 12)); const WORKER = process.argv.includes('--worker');
const { createAnalyser } = await import(pathToFileURL(join(here, '..', '..', 'pi', 'dist', 'audio-analyser', 'index.js')).href);

function readWav(path) {
  const b = readFileSync(path); const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24);
  let off = 12, dataOff = 44, dataLen = b.length - 44;
  while (off + 8 <= b.length) { const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4); if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, b.length - dataOff); break; } off += 8 + len + (len & 1); }
  const n = Math.floor(dataLen / 2 / ch); const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2); y[i] = s / ch / 32768; }
  return { y, rate };
}
const HOP = 128;
function run(y, rate, mode) {
  process.env.LOTUS_ANALYSER_SPLIT = mode;
  const an = createAnalyser({ sampleRate: rate, hopSize: HOP, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015 });
  an.setGainLock(false);
  const buf = new Float32Array(HOP); const out = []; let h = 0;
  for (let i = 0; i + HOP <= y.length; i += HOP) {
    buf.set(y.subarray(i, i + HOP));
    an.setAudioClockMs(h * HOP / rate * 1000);
    if (h === 0) an.setVirtualClock(0); else an.advanceVirtualClock(h * HOP / rate * 1000);
    const f = an.process(buf); h++;
    out.push([f.bpm, f.bpmConfidence, f.beatPhaseMs, f.beatPhaseConf, f.section, f.sectionTier, f.repeatSim, f.expectHighInMs, f.levelVsHighDb]);
  }
  return { out, an };
}
const files = readdirSync(join(here, 'corpus')).filter((f) => f.endsWith('.wav')).slice(0, N);
let totHops = 0, tempoDiff = 0, phaseDiff = 0, secDiff = 0, tierDiff = 0, repDiff = 0; const perFile = [];
for (const f of files) {
  const { y, rate } = readWav(join(here, 'corpus', f));
  const A = run(y, rate, '').out, B = run(y, rate, 'inline').out;
  let td = 0, pd = 0, sd = 0, tr = 0, rd = 0, firstT = -1;
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = B[i];
    if (a[0] !== b[0] || a[1] !== b[1]) { td++; if (firstT < 0) firstT = i * HOP / rate; }
    if (a[2] !== b[2] || a[3] !== b[3]) pd++;
    if (a[4] !== b[4]) sd++; if (a[5] !== b[5]) tr++; if (a[6] !== b[6] || a[7] !== b[7] || a[8] !== b[8]) rd++;
  }
  totHops += A.length; tempoDiff += td; phaseDiff += pd; secDiff += sd; tierDiff += tr; repDiff += rd;
  perFile.push(`${f.slice(0, 34).padEnd(34)} hop ${A.length}  tempo≠ ${td}${firstT >= 0 ? ` (forsta ${firstT.toFixed(1)} s)` : ''}  fas≠ ${pd}  sektion≠ ${sd}  tier≠ ${tr}  rep≠ ${rd}`);
}
console.log(perFile.join('\n'));
console.log(`\nSUMMA ${files.length} filer, ${totHops} hop: tempo/konf olika ${tempoDiff} (${(100 * tempoDiff / totHops).toFixed(3)} %), gridfas olika ${phaseDiff}, sektion olika ${secDiff} (${(100 * secDiff / totHops).toFixed(3)} %), tier ${tierDiff}, upprepning ${repDiff}`);

if (WORKER) {
  // Rokning av riktiga workern: mata i realtidstakt 15 s, se att tempot kommer och att workern haller jamna steg.
  const { y, rate } = readWav(join(here, 'corpus', files[0]));
  process.env.LOTUS_ANALYSER_SPLIT = 'worker';
  const an = createAnalyser({ sampleRate: rate, hopSize: HOP, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015 }); an.setGainLock(false);
  const buf = new Float32Array(HOP); let h = 0; const t0 = performance.now(); let lastBpm = 0;
  await new Promise((res) => {
    const iv = setInterval(() => {
      const want = Math.floor((performance.now() - t0) / 1000 * rate / HOP);
      while (h < want && (h + 1) * HOP <= y.length) { buf.set(y.subarray(h * HOP, (h + 1) * HOP)); an.setAudioClockMs(h * HOP / rate * 1000); lastBpm = an.process(buf).bpm; h++; }
      if (performance.now() - t0 > 15000 || (h + 1) * HOP > y.length) { clearInterval(iv); res(); }
    }, 5);
  });
  console.log(`\nWORKER-ROKNING ${files[0]}: ${h} hop pa 15 s, bpm ${lastBpm}, stats ${JSON.stringify(an.getSplitStats())}`);
  an.__worker?.postMessage({ type: 'stop' });
}
