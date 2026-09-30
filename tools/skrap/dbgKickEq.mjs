// dbgKick per hop: gammal (nytt objekt/hop) mot ny (ateranvant objekt) - alla falt lika i varje hop.
import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const [O, N, W] = process.argv.slice(2);
const A = await import(pathToFileURL(O).href), B = await import(pathToFileURL(N).href);
console.log = () => {};
const b = fs.readFileSync(W); const n = (b.length - 44) >> 1; const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = b.readInt16LE(44 + 2 * i) / 32768;
const c = { sampleRate: 48000, hopSize: 128, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015, onsetEnhancements: false };
const a = new A.Analyser(c), bb = new B.Analyser(c); a.setGainLock(false); bb.setGainLock(false);
const buf = new Float32Array(128); let bad = 0, hops = 0; const K = ['flux','thresh','med','mad','energy','gain','rms','env','locked'];
for (let i = 0; i + 128 <= n; i += 128, hops++) { buf.set(y.subarray(i, i + 128)); const ms = hops * 128 / 48; for (const x of [a, bb]) { x.setAudioClockMs(ms); if (hops === 0) x.setVirtualClock(0); else x.advanceVirtualClock(ms); x.process(buf); }
  for (const k of K) if (!Object.is(a.dbgKick?.[k], bb.dbgKick?.[k])) { bad++; break; } }
process.stdout.write(`dbgKick: ${hops} hop, avvikande ${bad}\n`);
