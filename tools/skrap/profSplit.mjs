// Delar en .heapprofile i: banken (stack genom harness/), inspektor, och motorn; motorn per modul-kategori.
import fs from 'node:fs';
const [file, secs] = process.argv.slice(2); const S = Number(secs);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const cat = (u) => /audio-analyser\//.test(u) ? 'analysator (huvudtrad)' : /alsaMic/.test(u) ? 'alsaMic (ljudinfangning)' : /piEngine|heartbeat|songClock|songLock/.test(u) ? 'motorns tick/band' : /ble-driver\/protocol|raster|controllerDrain/.test(u) ? 'BLE-sandning (protocol/raster)' : /configServer/.test(u) ? 'status-API' : /sonosPoller|eventsource|undici/.test(u) ? 'sonos' : /tempoLookup|songStore/.test(u) ? 'tempocache' : /recorder/.test(u) ? 'inspelaren' : /runtimeHealth|index\.js|engineLifecycle|restartLog|debugLog/.test(u) ? 'ovrigt motor' : null;
const tot = new Map(); let all = 0;
(function w(n, c, h) {
  const u = n.callFrame.url || '';
  const isH = /\/harness\//.test(u) || /node:inspector/.test(u);
  const cu = cat(u);
  const hh = isH ? true : (cu ? false : h);   // djupaste ram som ar antingen banken eller projektet avgor
  const cc = isH ? null : (cu ?? c);
  if (n.selfSize) { all += n.selfSize; const k = hh ? '(banken/inspektorn)' : (cc ?? '(node utan projektram: timers m.m.)'); tot.set(k, (tot.get(k) || 0) + n.selfSize); }
  for (const x of n.children || []) w(x, cc, hh);
})(p.head, null, false);
const eng = all - (tot.get('(banken/inspektorn)') || 0);
console.log(`totalt ${(all / S / 1024).toFixed(0)} kB/s, motorn utan banken ${(eng / S / 1024).toFixed(0)} kB/s`);
for (const [k, v] of [...tot].sort((a, b) => b[1] - a[1])) console.log(`${(v / S / 1024).toFixed(1).padStart(8)} kB/s  ${k}`);
