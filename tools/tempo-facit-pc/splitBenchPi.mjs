// KOSTNADSMATNING pa Pi:n (Zero 2 W) for den delade analysatorn (2026-09-21): samma 30 s-snutt korrs
// (A) odelat i en trad och (B) med workern, i REALTIDSTAKT (375 hop/s), och process()-kostnaden i
// huvudtraden mats per hop (medel/p99/max) + workerns egen statistik. Kor pa Pi:n:
//   cd /opt/lotus-light/pi && LOTUS_SECTION=1 LOTUS_GRID_PHASE=1 node /tmp/splitBenchPi.mjs /tmp/snutt.wav
import { readFileSync } from 'node:fs';
const { createAnalyser } = await import('/opt/lotus-light/pi/dist/audio-analyser/index.js');
const path = process.argv[2];
const b = readFileSync(path); const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24);
let off = 12, dataOff = 44, dataLen = b.length - 44;
while (off + 8 <= b.length) { const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4); if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, b.length - dataOff); break; } off += 8 + len + (len & 1); }
const n = Math.floor(dataLen / 2 / ch); const y = new Float32Array(n);
for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2); y[i] = s / ch / 32768; }
const HOP = 128; const SECS = Number(process.env.BENCH_SECS || 25);

async function run(mode) {
  process.env.LOTUS_ANALYSER_SPLIT = mode;
  const an = createAnalyser({ sampleRate: rate, hopSize: HOP, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015 }); an.setGainLock(false);
  await new Promise((r) => setTimeout(r, 300));           // workern hinner starta
  const buf = new Float32Array(HOP); let h = 0; const t0 = performance.now(); const cost = []; let bpm = 0, sec = '';
  let loopMax = 0, loopLast = performance.now();
  await new Promise((res) => {
    const iv = setInterval(() => {
      const now = performance.now(); const gap = now - loopLast - 5; if (gap > loopMax) loopMax = gap; loopLast = now;
      const want = Math.floor((now - t0) / 1000 * rate / HOP);
      while (h < want && (h + 1) * HOP <= y.length) {
        buf.set(y.subarray(h * HOP, (h + 1) * HOP)); an.setAudioClockMs(h * HOP / rate * 1000);
        const a = performance.now(); const f = an.process(buf); cost.push(performance.now() - a); bpm = f.bpm; sec = f.section; h++;
      }
      if (now - t0 > SECS * 1000 || (h + 1) * HOP > y.length) { clearInterval(iv); res(); }
    }, 5);
  });
  cost.sort((a, b) => a - b); const q = (p) => cost[Math.min(cost.length - 1, Math.floor(p * cost.length))];
  const mean = cost.reduce((a, b) => a + b, 0) / cost.length;
  console.log(`${(mode || 'odelad').padEnd(7)} ${h} hop/${SECS} s  process() medel ${(mean * 1000).toFixed(0)} µs  p50 ${(q(0.5) * 1000).toFixed(0)}  p99 ${(q(0.99) * 1000).toFixed(0)}  max ${(cost[cost.length - 1] * 1000).toFixed(0)} µs  | >2.67 ms: ${cost.filter((c) => c > 2.67).length}  | timerlagg max ${loopMax.toFixed(0)} ms  | bpm ${bpm} sektion ${sec}` +
    (mode === 'worker' ? `  | worker ${JSON.stringify(an.getSplitStats())}` : ''));
  an.__worker?.postMessage({ type: 'stop' });
}
await run('');
await run('worker');
