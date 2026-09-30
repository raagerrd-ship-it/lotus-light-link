// Isolerad matning av alsaMic.onAudioData: N callbacks med korpusljud, samplad allokering per agare.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import inspector from 'node:inspector';
register('./hooksManual.mjs', import.meta.url);
const DIST = process.argv[2]; const N = Number(process.argv[3] || 60000);
process.env.LOTUS_ANALYSER_SPLIT = process.env.LOTUS_ANALYSER_SPLIT ?? 'inline';
const mic = await import(pathToFileURL(DIST + '/alsaMic.js').href);
console.log = () => {};
mic.startMic();
const cap = globalThis.__cap; const fn = cap.listeners('audio')[0];
const pl = JSON.parse(fs.readFileSync(new URL('./playlist.json', import.meta.url), 'utf8'));
const wav = fs.readFileSync(pl[0].wav); const nS = (wav.length - 44) >> 1;
let pos = 0;
const run = (n) => { for (let k = 0; k < n; k++) { const b = Buffer.allocUnsafeSlow(2048); for (let i = 0; i < 256; i++) { const v = wav.readInt16LE(44 + 2 * ((pos + i) % nS)) * 65536; b.writeInt32LE(v, i * 8); b.writeInt32LE(v, i * 8 + 4); } pos += 256; fn(b); } };
run(N);   // uppvarmning
const s = new inspector.Session(); s.connect();
const post = (m, p) => new Promise((r, j) => s.post(m, p ?? {}, (e, x) => e ? j(e) : r(x)));
await post('HeapProfiler.enable');
await post('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
run(N);
const { profile } = await post('HeapProfiler.stopSampling');
const m = new Map(); let tot = 0;
(function w(n, own) { const c = n.callFrame; const o = /dist\//.test(c.url) ? `${c.functionName}:${c.url.split('/').pop()}` : own; if (n.selfSize) { tot += n.selfSize; const k = (o ?? '-') + ' | ' + (c.functionName || '(anon)') + ':' + (c.url.split('/').pop() || '?'); m.set(k, (m.get(k) || 0) + n.selfSize); } (n.children || []).forEach((x) => w(x, o)); })(profile.head, null);
process.stdout.write(`TOTAL ${(tot / N).toFixed(0)} B/callback\n`);
for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 25)) process.stdout.write(`${(v / N).toFixed(1).padStart(8)} B/cb  ${k}\n`);
process.exit(0);
