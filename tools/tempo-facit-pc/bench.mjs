// Korbank for analysatorns tempoval (2026-09-19). Matar den KOMPILERADE analysatorn (samma kod som Pi:n
// kor) hop for hop med korpusens 48 kHz-snuttar och jamfor dess tempo med facit:
//   corpus/<id>.wav + .json   (PC-facit: result.bpm)          -> klass lika/dubbla/halva/3-2/4-3/annat
//   corpus-synth/<bpm>_*.wav  (kant tempo i filnamnet)
// Matt: analysatorns median-bpm over de sista 20 s (10 s uppvarmning), klassad mot facit.
//   node bench.mjs [--analyser ../../pi/dist/audio-analyser/index.js] [--dir corpus] [--synth corpus-synth]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ANALYSER = arg('--analyser', join(here, '..', '..', 'pi', 'dist', 'audio-analyser', 'index.js'));
const DIR = arg('--dir', join(here, 'corpus'));
const SYNTH = arg('--synth', join(here, 'corpus-synth'));
const { createAnalyser } = await import(pathToFileURL(ANALYSER).href);

function readWav(path) {
  const b = readFileSync(path);
  const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  let off = 12; let dataOff = 44, dataLen = b.length - 44;
  while (off + 8 <= b.length) {                       // hitta data-chunken (RIFF kan ha LIST m.m.)
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, b.length - dataOff); break; }
    off += 8 + len + (len & 1);
  }
  if (bits !== 16) throw new Error('bara 16-bit PCM');
  const n = Math.floor(dataLen / 2 / ch); const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2); y[i] = s / ch / 32768; }
  return { y, rate };
}

function classify(facit, an) {
  if (!facit || !an) return ['okänd', 0];
  const r = facit / an;
  for (const [x, lab] of [[1, 'lika'], [2, 'dubbla'], [0.5, 'halva'], [1.5, '3/2'], [2 / 3, '2/3'], [4 / 3, '4/3'], [0.75, '3/4']])
    if (Math.abs(r / x - 1) < 0.05) return [lab, r];
  return ['annat', r];
}

function runOne(y, rate) {
  const HOP = 128;
  const an = createAnalyser({ sampleRate: rate, hopSize: HOP, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015, onsetEnhancements: process.env.BENCH_ENH === '1' });   // standard AV = som Pi:n; BENCH_ENH=1 = 09-07-mergens onset-DSP (12/64 mot 30/64)
  an.setGainLock?.(false);
  const buf = new Float32Array(HOP); const bpms = []; const confs = []; const raws = []; const kicks = []; let lastKick = 0; let hopCount = 0; const warm = Math.floor(10 * rate / HOP);
  const dbg = process.env.BENCH_DEBUG && runOne.name && runOne.current && runOne.current.includes(process.env.BENCH_DEBUG);
  for (let i = 0; i + HOP <= y.length; i += HOP) {
    buf.set(y.subarray(i, i + HOP));
    an.setAudioClockMs?.(hopCount * HOP / rate * 1000);
    an.setVirtualClock?.(hopCount * HOP / rate * 1000);   // all tidsstyrd logik (roster, commit, konfidens) foljer LJUDET, inte vaggklockan
    const f = an.process(buf); hopCount++;
    if (f && f.kickAtMs > 0 && f.kickAtMs !== lastKick) { lastKick = f.kickAtMs; kicks.push(f.kickAtMs / 1000); }   // analysatorns kickar (virtuell klocka = sekunder fran start)
    if (hopCount > warm && hopCount % 38 === 0 && f && f.bpm > 0) { bpms.push(f.bpm); confs.push(f.bpmConfidence ?? 0); if (an.rawBpmLast > 0) raws.push(an.rawBpmLast); }   // ~10 Hz
    if (dbg && hopCount % (375 * 5) === 0) console.log(`  t=${(hopCount * HOP / rate).toFixed(0)}s lockad ${f.bpm} ra ${an.rawBpmLast?.toFixed(1)} argmax-lag ${an.dbgBestLag} (${an.dbgBestLag ? (6000 / an.dbgBestLag).toFixed(1) : '-'} BPM, tg ${an.dbgTgAt?.(an.dbgBestLag)?.toFixed(3)}) fonster ${an.dbgLagMin}-${an.dbgLagMax} tg@37 ${an.dbgTgAt?.(37)?.toFixed(3)} tg@38 ${an.dbgTgAt?.(38)?.toFixed(3)} vinnare ${an.evidenceScore?.toFixed(2)} las ${an.evidenceLockScore?.toFixed(2)} roster ${an.evidRelockVotes} omlas ${an.evidenceRelocks} kandidater ${JSON.stringify(an.debugCandidates?.().map((c) => [c.bpm, +c.tg.toFixed(3), +c.score.toFixed(2), +c.half.toFixed(2)]))}`);
  }
  const s = [...bpms].sort((a, b) => a - b);
  const med = s.length ? s[s.length >> 1] : 0;
  const rs = [...raws].sort((a, b) => a - b); const rawMed = rs.length ? rs[rs.length >> 1] : 0;
  const q = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
  return { med, rawMed, kicks, min: s[0] ?? 0, max: s[s.length - 1] ?? 0, q25: q(0.25), q75: q(0.75), conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0, n: bpms.length };
}

const rows = [];
if (existsSync(DIR)) for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const meta = JSON.parse(readFileSync(join(DIR, f), 'utf8')); const wav = join(DIR, f.replace(/\.json$/, '.wav'));
  if (!existsSync(wav)) continue;
  let facit = meta.result?.bpm || 0; if (!facit) continue;
  while (facit > 180) facit /= 2; while (facit < 70) facit *= 2;      // samma vikning som Pi:n (PC:ns egen oktav ar inte facit)
  const { y, rate } = readWav(wav); runOne.current = f; const r = runOne(y, rate);
  const [cls, ratio] = classify(facit, r.med);
  const pcOn = (meta.result?.analysis?.onset?.timesS) || [];
  let kickP = null, kickR = null, kickBias = null;
  if (pcOn.length >= 5 && r.kicks.length >= 3) {
    const near = (ts, grid) => ts.map((x) => { let best = Infinity; for (const g of grid) { const d = x - g; if (Math.abs(d) < Math.abs(best)) best = d; } return best; });
    const dk = near(r.kicks, pcOn), dp = near(pcOn, r.kicks);
    const hit = dk.filter((d) => Math.abs(d) <= 0.05);
    kickP = hit.length / dk.length; kickR = dp.filter((d) => Math.abs(d) <= 0.05).length / dp.length;
    kickBias = hit.length ? hit.sort((a, b) => a - b)[hit.length >> 1] * 1000 : null;
  }
  rows.push({ set: 'korpus', kickP, kickR, kickBias, nKick: r.kicks.length, nOn: pcOn.length, name: `${meta.row?.artist ?? ''} – ${meta.row?.title ?? basename(f)}`.slice(0, 40), facit, ...r, cls, ratio });
}
if (existsSync(SYNTH)) for (const f of readdirSync(SYNTH).filter((f) => f.endsWith('.wav'))) {
  const facit = parseFloat(f); if (!facit) continue;
  const { y, rate } = readWav(join(SYNTH, f)); runOne.current = f; const r = runOne(y, rate);
  const [cls, ratio] = classify(facit, r.med);
  rows.push({ set: 'synt', name: f.replace(/\.wav$/, ''), facit, ...r, cls, ratio });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('set', 7) + pad('lat', 42) + pad('facit', 8) + pad('analys', 8) + pad('ra-med', 8) + pad('spann', 12) + pad('conf', 6) + pad('klass', 8) + 'kvot');
for (const r of rows) console.log(pad(r.set, 7) + pad(r.name, 42) + pad(r.facit.toFixed(1), 8) + pad(r.med.toFixed(1), 8) + pad(r.rawMed.toFixed(1), 8) + pad(`${r.min.toFixed(0)}–${r.max.toFixed(0)}`, 12) + pad(r.conf.toFixed(2), 6) + pad(r.cls, 8) + r.ratio.toFixed(2));
for (const set of ['korpus', 'synt']) {
  const rs = rows.filter((r) => r.set === set); if (!rs.length) continue;
  const ok = rs.filter((r) => r.cls === 'lika').length;
  const kr = rs.filter((r) => typeof r.kickR === 'number'); const medk = (k) => kr.length ? [...kr].map((r) => r[k]).sort((a, b) => a - b)[kr.length >> 1] : null;
  if (kr.length) console.log(`${set} kick: recall ${medk('kickR')?.toFixed(2)} precision ${medk('kickP')?.toFixed(2)} bias ${medk('kickBias')?.toFixed(0)} ms (n=${kr.length} latar med PC-onsets)`);
  const cls = {}; for (const r of rs) cls[r.cls] = (cls[r.cls] || 0) + 1;
  console.log(`${set}: ${ok}/${rs.length} ratt (lika)  klasser ${JSON.stringify(cls)}  spann-median ${[...rs].map((r) => r.max - r.min).sort((a, b) => a - b)[rs.length >> 1]?.toFixed(0)} BPM`);
}
