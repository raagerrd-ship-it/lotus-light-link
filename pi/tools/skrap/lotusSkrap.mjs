// Lotus-analysatorn (pi/dist/audio-analyser, lotus-profilen) i virtuell klocka på en inspelning: skräp per funktion i STABILT läge
// (V8 samplande heap-profilerare inkl. bortstädat, från --fran S s ljud) + en hash av rutorna (bevis för identiskt resultat).
//   node [--import <v8Tiering.js>] tools/skrap/lotusSkrap.mjs <wav> [sek] [--fran S]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Session } from "node:inspector";
const args = process.argv.slice(2);
const opt = (k, dflt) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : dflt; };
const { createAnalyser } = await import(new URL((process.env.LDIST ?? "../../dist") + "/audio-analyser/index.js", import.meta.url).href);
const wav = args[0], SEK = Number(args[1] ?? 600), FRAN = Number(opt("--fran", 300));
const d = readFileSync(wav), n = Math.min((d.length - 44) >> 1, SEK * 48000);
const an = createAnalyser({ sampleRate: 48000, hopSize: 128 });
const buf = new Float32Array(128), EPOCH = 1700000000000, h = createHash("md5"), row = new Float64Array(8);
const ses = new Session(); ses.connect(); let started = false;
const log = console.log; console.log = () => {};
for (let off = 0; off + 128 <= n; off += 128) {
  for (let i = 0; i < 128; i++) buf[i] = d.readInt16LE(44 + (off + i) * 2) / 32768;
  const ms = EPOCH + off / 48; an.setVirtualClock?.(off / 48); Date.now = () => ms; performance.now = () => off / 48;
  if (!started && off / 48000 >= FRAN) { started = true; ses.post("HeapProfiler.enable"); ses.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
  const f = an.process(buf);
  row[0] = f.level; row[1] = f.intensity; row[2] = f.bpm; row[3] = f.kick ? 1 : 0; row[4] = f.beatPhaseMs; row[5] = f.dropCount; row[6] = f.bodyDb ?? 0; row[7] = f.sectionIndex ?? 0;
  h.update(Buffer.from(row.buffer));
}
ses.post("HeapProfiler.stopSampling", (e, r) => {
  const tot = new Map(); let all = 0;
  const walk = (nd) => { const k = (nd.callFrame.url.split("/").pop() || "(native)") + ":" + (nd.callFrame.functionName || "(anon)"); tot.set(k, (tot.get(k) ?? 0) + nd.selfSize); if (nd.callFrame.url.includes("audio-analyser")) all += nd.selfSize; nd.children.forEach(walk); };
  walk(r.profile.head); const secs = n / 48000 - FRAN;
  log(`analysatorn ${(all / 1024 / secs).toFixed(1)} kB/s   ram-hash ${h.digest("hex")}`);
  for (const [k, v] of [...tot].filter(([k]) => k.startsWith("analyser.js")).sort((a, b) => b[1] - a[1]).slice(0, 8)) log((v / 1024 / secs).toFixed(1).padStart(8) + " kB/s  " + k);
});
