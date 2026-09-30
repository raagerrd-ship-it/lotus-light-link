// Sammanfattar en .heapprofile (HeapProfiler.startSampling med skrap inraknat) till byte/s per stalle.
//   node profTop.mjs <fil.heapprofile> <sekunder> [--top 30] [--json ut.json]
// "agare" = djupaste ramen i projektets dist/ (sa JSON.stringify, Array.map m.m. raknas pa den som anropar dem).
// Per modul = agarens fil. Allt utan projektram = "(node/harness)".
import fs from 'node:fs';
const [file, secsArg] = process.argv.slice(2);
const SECS = Number(secsArg);
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TOP = Number(opt('--top', 30));
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const RX = /\/pi\/(dist|_var\/[^/]+)\//; const isProj = (u) => RX.test(u || ''); const rel = (u) => u.split(RX).pop();
const short = (cf) => `${cf.functionName || '(anon)'} ${rel(cf.url || '').split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
const own = new Map(), mod = new Map(), leaf = new Map(); let total = 0;
function walk(node, owner) {
  const cf = node.callFrame;
  const o = isProj(cf.url) ? node : owner;
  if (node.selfSize) {
    total += node.selfSize;
    const k = o ? short(o.callFrame) : '(node/harness)';
    own.set(k, (own.get(k) || 0) + node.selfSize);
    const m = o ? rel(o.callFrame.url) : (cf.url ? cf.url.split('/').slice(-1)[0] : '(native)');
    mod.set(m, (mod.get(m) || 0) + node.selfSize);
    const lk = short(cf) + (o && o !== node ? `  <- ${short(o.callFrame)}` : '');
    leaf.set(lk, (leaf.get(lk) || 0) + node.selfSize);
  }
  for (const c of node.children || []) walk(c, o);
}
walk(prof.head, null);
const kbs = (b) => (b / SECS / 1024).toFixed(1);
const out = { totalKBs: +kbs(total), owners: [], modules: [], leaves: [] };
console.log(`TOTALT ${kbs(total)} kB/s (${(total / 1048576).toFixed(1)} MB pa ${SECS} s)`);
console.log(`\n-- per modul (agarens fil) --`);
for (const [k, v] of [...mod].sort((a, b) => b[1] - a[1]).slice(0, 25)) { console.log(`${kbs(v).padStart(8)} kB/s ${(100 * v / total).toFixed(1).padStart(5)} %  ${k}`); out.modules.push([k, +kbs(v)]); }
console.log(`\n-- per agare (djupaste projektram) --`);
for (const [k, v] of [...own].sort((a, b) => b[1] - a[1]).slice(0, TOP)) { console.log(`${kbs(v).padStart(8)} kB/s ${(100 * v / total).toFixed(1).padStart(5)} %  ${k}`); out.owners.push([k, +kbs(v)]); }
console.log(`\n-- per allokerande ram (<- agare) --`);
for (const [k, v] of [...leaf].sort((a, b) => b[1] - a[1]).slice(0, TOP)) { console.log(`${kbs(v).padStart(8)} kB/s ${(100 * v / total).toFixed(1).padStart(5)} %  ${k}`); out.leaves.push([k, +kbs(v)]); }
const j = opt('--json', null); if (j) fs.writeFileSync(j, JSON.stringify(out, null, 1));
