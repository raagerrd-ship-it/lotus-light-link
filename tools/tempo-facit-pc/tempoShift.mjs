// TEMPOVAXLING INOM LAT (2026-10-09). Matar DMX-nattagentens syntetiska facit (12 klipp, +8/+12/+15 % vid t_s,
// dmx-control/pi-dmx/engine/tools/tempo-facit/manifest.tsv) genom den KOMPILERADE delade analysatorn hop for hop
// (som bench.mjs: virtuell klocka + ljudklocka, BENCH_GRID-aterkoppling) och mater analysatorns las (f.bpm, 4 Hz):
//   fore  = median [t_s-8, t_s)      efter = median [t_s+10, slut)
//   traff = laset inom 3 % av 'till' (vikt till [80,160)) senast t_s+10 OCH stannar dar klippet ut; omlas = den tiden - t_s
// Negativ kontroll (--neg): frozen6-klippen dar DMX-motorns las hoppar oktav (bpm_end/bpm_start > 1,4 eller < 0,72):
//   falska = lasbyten > 5 % efter 10 s uppvarmning (glid inom 5 % raknas inte), oktav = byten med kvot > 1,4 eller < 0,72.
// Pi:ns flaggor (prefix LOTUS_) sats om de saknas; lagg till t.ex. LOTUS_TEMPO_SHIFT=1 i env for opt-in.
//   node tempoShift.mjs [--analyser <index.js>] [--neg] [--facit <dir>] [--frozen <dir>] [--v]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PI = { TEMPO_EVIDENCE: '1', TEMPO_ENV_S: '10', TEMPO_UP43: '1', TEMPO_FIVE4: '1', KICK_NOGATE: '1', KICK_COOLDOWN: '100', GRID_PHASE: '1', SECTION: '1', SECTION_ON_HINT: '1' };
for (const [k, v] of Object.entries(PI)) process.env['LOTUS_' + k] ??= v;
const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ANALYSER = arg('--analyser', join(here, '..', '..', 'pi', 'dist', 'audio-analyser', 'index.js'));
const DMX = 'C:/Users/richa/Desktop/Claude/dmx-control/pi-dmx/engine/tools';
const FACIT = arg('--facit', join(DMX, 'tempo-facit')), FROZEN = arg('--frozen', join(DMX, 'frozen6'));
const V = process.argv.includes('--v');
const { createAnalyser } = await import(pathToFileURL(ANALYSER).href);

function readWav(path) {
  const b = readFileSync(path); const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24);
  let off = 12, dataOff = 44, dataLen = b.length - 44;
  while (off + 8 <= b.length) { const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4); if (id === 'data') { dataOff = off + 8; dataLen = len === 0 ? b.length - dataOff : Math.min(len, b.length - dataOff); break; } off += 8 + len + (len & 1); }
  const n = Math.floor(dataLen / 2 / ch); const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2); y[i] = s / ch / 32768; }
  return { y, rate };
}
function run(path) {
  const { y, rate } = readWav(path); const HOP = 128;
  const an = createAnalyser({ sampleRate: rate, hopSize: HOP, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015, onsetEnhancements: false });
  an.setGainLock?.(false);
  const buf = new Float32Array(HOP); const tr = []; let h = 0;
  for (let i = 0; i + HOP <= y.length; i += HOP) {
    buf.set(y.subarray(i, i + HOP));
    an.setAudioClockMs?.(h * HOP / rate * 1000);
    if (h === 0) an.setVirtualClock?.(0); else an.advanceVirtualClock?.(h * HOP / rate * 1000);
    const f = an.process(buf); h++;
    if (f && f.bpm > 0 && f.beatAnchorMs > 0) an.setBeatGrid?.({ bpm: f.bpm, anchorMs: f.beatAnchorMs });
    if (h % 94 === 0) tr.push([h * HOP / rate, f?.bpm || 0, an.rawBpmLast || 0, an.tempoShifts || 0]);   // ~4 Hz
  }
  return tr;
}
const fold = (b) => { while (b >= 160) b /= 2; while (b < 80) b *= 2; return b; };
const med = (a) => { const s = a.filter((x) => x > 0).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
const tsv = (p) => { const [hd, ...r] = readFileSync(p, 'utf-8').trim().split(/\r?\n/).map((l) => l.split('\t')); return r.map((x) => Object.fromEntries(hd.map((k, i) => [k, x[i]]))); };

const pos = tsv(join(FACIT, 'manifest.tsv'));
let hits = 0; const relock = []; const out = [];
for (const r of pos) {
  const ts = Number(r.t_s); const [fr, to] = r['fran->till'].split('->').map(Number); const toF = fold(to), frF = fold(fr);
  const tr = run(join(FACIT, r.fil)); const end = tr[tr.length - 1][0];
  const pre = med(tr.filter(([t]) => t >= ts - 8 && t < ts).map((x) => x[1]));
  const post = med(tr.filter(([t]) => t >= ts + 10).map((x) => x[1]));
  const ok = (b) => Math.abs(b / toF - 1) <= 0.03;
  // forsta tidpunkt efter t_s varifran laset ar inom 3 % resten av klippet
  let tHit = null; for (let i = tr.length - 1; i >= 0 && tr[i][0] >= ts; i--) { if (ok(tr[i][1])) tHit = tr[i][0]; else break; }
  const hit = tHit !== null && tHit - ts <= 10;
  if (hit) { hits++; relock.push(tHit - ts); }
  out.push(`${r.fil.slice(0, 34).padEnd(35)} ${String(fr).padStart(3)}->${String(to).padEnd(4)} fore ${pre.toFixed(0).padStart(3)} (${Math.abs(pre / frF - 1) <= 0.03 ? 'ratt' : 'FEL '}) efter ${post.toFixed(0).padStart(3)}  ${hit ? 'TRAFF' : 'miss '} ${tHit !== null ? `omlas ${(tHit - ts).toFixed(1)} s` : ''}`);
  if (V) out.push('   ' + tr.filter(([t]) => t >= ts - 2 && t <= end).filter((_, i) => i % 4 === 0).map(([t, b, rw]) => `${t.toFixed(0)}:${b}/${rw.toFixed(0)}`).join(' '));
}
console.log(out.join('\n'));
relock.sort((a, b) => a - b);
console.log(`POS: traff ${hits}/${pos.length}, omlas median ${relock.length ? relock[relock.length >> 1].toFixed(1) : '-'} s [${relock.map((x) => x.toFixed(1)).join(' ')}]`);
if (process.argv.includes('--neg')) {
  const neg = tsv(join(FROZEN, 'manifest.tsv')).filter((r) => { const q = Number(r.bpm_end) / Number(r.bpm_start); return Number(r.bpm_start) > 0 && (q > 1.4 || q < 0.72); });
  let fals = 0, oct = 0, clipsF = 0; const lines = [];
  for (const r of neg) {
    const tr = run(join(FROZEN, r.file)); let held = 0, nf = 0, no = 0; const ev = [];
    let lastSh = 0; for (const [t, b, , sh] of tr) {
      if (!b) continue; if (!held || t < 10) { held = b; lastSh = sh; continue; }
      const q = b / held; if (Math.abs(q - 1) > 0.05) { nf++; if (q > 1.4 || q < 0.72) no++; ev.push(`${t.toFixed(0)}s ${held}->${b}${sh > lastSh ? " (SHIFT)" : ""}`); held = b; }
      else held = b;   // glid
      lastSh = sh;
    }
    fals += nf; oct += no; if (nf) clipsF++;
    lines.push(`${r.file.slice(0, 40).padEnd(41)} byten ${nf} oktav ${no} shift ${tr[tr.length - 1][3]} ${ev.join(', ')}`);
  }
  if (V) console.log(lines.join('\n'));
  console.log(`NEG: ${neg.length} klipp, falska byten ${fals} (i ${clipsF} klipp), varav oktav ${oct}`);
}
