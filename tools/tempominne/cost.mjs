// TEMPO-MINNET: cachens egen levande heap och sparningens/API:ts kostnad, gammal mot ny TempoCache.
//   node --expose-gc --max-old-space-size=144 --min-semi-space-size=4 --max-semi-space-size=4 cost.mjs <dist> <tempo-cache.json>
// Heap: heapUsed efter 2x gc() med cachen laddad minus utan (samma process, samma moduler laddade).
// Sparning: gammal = JSON.stringify(hela kartan) (det saveNow gor), ny = journalraden for en typisk andring.
// API: gammal = JSON.stringify(list()) (res.json), ny = listFull() + JSON.stringify.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [DIST, SRC] = process.argv.slice(2);
const M = await import(pathToFileURL(path.resolve(DIST, 'tempoLookup.js')).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempominne-cost-'));
fs.copyFileSync(SRC, dir + '/tempo-cache.json');
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const t = (f, n = 20) => { f(); const a = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - a) / n; };
const h0 = heap();
const tc = new M.TempoCache(dir + '/tempo-cache.json'); tc.load();
const h1 = heap();
const isNew = typeof tc.listFull === 'function';
const src = JSON.parse(fs.readFileSync(SRC, 'utf8')); const k = Object.keys(src).find((x) => src[x].pc && src[x].learn);
const facit = { bpm: 120, rawBpm: 120, source: 'pc:beatthis', pcConf: 0.7, candidates: src[k].candidates, at: 1, artist: 'a', title: 't', pc: src[k].pc, pcAt: 1 };
let saveMs, saveBytes, apiMs, apiBytes;
if (!isNew) {
  const map = tc.map;   // privat i TS, synlig i JS
  saveMs = t(() => JSON.stringify(map)); saveBytes = JSON.stringify(map).length;
  apiMs = t(() => JSON.stringify(tc.list())); apiBytes = JSON.stringify(tc.list()).length;
} else {
  const line = (op) => JSON.stringify(op).length + 1;
  saveMs = t(() => JSON.stringify({ o: 'up', k, a: 'a', t: 't', p: facit }), 200);
  saveBytes = `facit ${line({ o: 'up', k, a: 'a', t: 't', p: facit })} B, learn ${line({ o: 'up', k, a: 'a', t: 't', p: { learn: src[k].learn, learnAt: 1, verdictEnd: 'ok' } })} B, dom ${line({ o: 'upd', k, p: { verdict: 'ok', analyserBpm: 120, ratio: 1, verdictAt: 1 } })} B`;
  let s = ''; const a = performance.now(); for (let i = 0; i < 10; i++) s = JSON.stringify(await tc.listFull()); apiMs = (performance.now() - a) / 10; apiBytes = s.length;
}
console.log(JSON.stringify({ dist: DIST, poster: tc.size, cacheHeapMB: +((h1 - h0) / 1048576).toFixed(2), saveMs: +saveMs.toFixed(3), saveBytes, apiMs: +apiMs.toFixed(1), apiBytes }));
