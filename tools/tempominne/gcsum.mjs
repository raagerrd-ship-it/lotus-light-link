// TEMPO-MINNET: sammanfatta --trace-gc + motorns [gc]/[raster]-rader ur skrapbankens engine.log.
//   node gcsum.mjs <engine.log> [skippa forsta S sekunder=180]
// Huvudisolatet = isolatet med storst heap efter Mark-Compact (analysatorns worker ar ~5 MB).
import fs from 'node:fs';
const [LOG, SKIP = '180'] = process.argv.slice(2);
const L = fs.readFileSync(LOG, 'utf8').split('\n');
const mc = []; // {iso, t, after, pause, incr}
for (const l of L) {
  const m = l.match(/^\[\d+:([0-9A-F]+)\]\s+(\d+) ms: Mark-Compact(?: \(reduce\))? [\d.]+ \([\d.]+\) -> ([\d.]+) \([\d.]+\) MB, pooled: [\d.]+ MB, ([\d.]+) \/ [\d.]+ ms\s+\(\+ ([\d.]+) ms in/);
  if (m && !l.includes('testing')) mc.push({ iso: m[1], t: +m[2] / 1000, after: +m[3], pause: +m[4], incr: +m[5] });
}
const byIso = {}; for (const x of mc) (byIso[x.iso] ??= []).push(x);
const main = Object.values(byIso).sort((a, b) => Math.max(...b.map((x) => x.after)) - Math.max(...a.map((x) => x.after)))[0] || [];
const w = main.filter((x) => x.t >= +SKIP);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const iv = w.slice(1).map((x, i) => x.t - w[i].t);
let tEnd = 0; for (const l of L) { const m = l.match(/^\[\d+:[0-9A-F]+\]\s+(\d+) ms: /); if (m && !l.includes('testing')) tEnd = Math.max(tEnd, +m[1] / 1000); }
// motorns egna rader har ISO-tid: hoppa over de forsta SKIP sekunderna efter forsta tidsstampeln
const ts = (l) => { const m = l.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) /); return m ? Date.parse(m[1]) / 1000 : null; };
const t0 = ts(L.find((l) => ts(l) !== null) || '') ?? 0;
L.splice(0, L.length, ...L.filter((l) => { const t = ts(l); return t === null || t - t0 >= +SKIP; }));
const eng = L.filter((l) => l.includes('[gc] paus')).map((l) => +l.match(/paus (\d+) ms/)[1]);
const sums = L.filter((l) => l.includes('[gc] 10 s:')).map((l) => { const m = l.match(/(\d+) pauser, summa (\d+) ms, max (\d+) ms, >=20 ms: (\d+)/); return m ? { n: +m[1], sum: +m[2], max: +m[3], big: +m[4] } : null; }).filter(Boolean);
const rast = L.filter((l) => l.includes('[raster]')).map((l) => { const m = l.match(/jitter ([\d.]+) ms.*sena (\d+) \(max ([\d.]+) ms\)/); return m ? { jit: +m[1], late: +m[2], max: +m[3] } : null; }).filter(Boolean);
const synk = L.filter((l) => l.includes('[synk] sen tick')).map((l) => +l.match(/sen tick (\d+) ms/)[1]);
const live = (L.find((l) => l.startsWith('LIVEHEAP')) || '').replace('LIVEHEAP ', '');
console.log(JSON.stringify({
  log: LOG, fonsterS: +(tEnd - +SKIP).toFixed(0),
  markCompact: { n: w.length, perMin: +(w.length / ((tEnd - +SKIP) / 60)).toFixed(2), medianIntervallS: iv.length ? +med(iv).toFixed(0) : null,
    pausMsMedian: med(w.map((x) => x.pause)), pausMsMax: Math.max(...w.map((x) => x.pause), 0), inkrMsMedian: med(w.map((x) => x.incr)),
    heapEfterMB: { median: med(w.map((x) => x.after)), min: Math.min(...w.map((x) => x.after)), max: Math.max(...w.map((x) => x.after)) } },
  motorGc: { pauser20ms: eng.length, maxMs: Math.max(...eng, 0), summa10sMedian: med(sums.map((s) => s.sum)) },
  raster: { rader: rast.length, jitterMedian: med(rast.map((r) => r.jit)), senaSumma: rast.reduce((a, r) => a + r.late, 0), senaMax: Math.max(...rast.map((r) => r.max), 0) },
  senTick: { n: synk.length, over100ms: synk.filter((x) => x >= 100).length, maxMs: Math.max(...synk, 0) },
  liveHeapEfterRunEnd: live,
}));
