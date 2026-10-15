// BASKROPPSBÄNK (2026-10-15, LOTUS_BASS_BODY): kör lotus analysator (pi/dist) på långa inspelningar och jämför nivåns form (shape,
// steg 1 i piEngine-ticken) med dagens väg och med DMX:s basenergi (pi/dist/bassBody.js - samma kod som motorn kör).
//   DAGENS = live-kalibreringen 10-15 (GET /api/calibration): lightBassWeight 1 / lightHiWeight 0 -> wlevel = amp x min(1, basandel/0,5),
//            EMA ner 55 ms, dB-fönster 6 dB, ankare tau 120 s (upp x3, snabbt utanför fönstret / klippt > 10 s / första 20 s), offset 4.
//   BAS    = BassBodyWindow på frame.bodyDb.
// Båda: tystnadsgrind 0,025 och shapeSmooth upp 25 / ner 250 ms (live). Uttoning, tak och puls efter är lika för båda och tas inte med.
// Mått (efter 15 s uppvärmning): r mot baskroppen (bodyDb), rTryck = mot bastrycken (bodyDb minus 2 s-medel, båda sidor), rTrend = 2 s-medlen, r mot diskanten (treble+air dB), sving p90-p10, medel i high/low.
// amp = 130 ms-EMA av hop-RMS x G, G satt så filens median-amp = 0,15 (kalibrerad gain); high-shelf-filtret i alsaMic tas inte med.
//   node bassBodyBench.mjs <wav ...>
import { readFileSync } from 'node:fs'; import { join, dirname, basename } from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), dist = join(here, '..', '..', 'pi', 'dist');
const { createAnalyser } = await import(pathToFileURL(join(dist, 'audio-analyser', 'index.js')).href);
const { BassBodyWindow } = await import(pathToFileURL(join(dist, 'bassBody.js')).href);
const TICK = 20, HOP = 128;
const pear = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; } return sab / Math.sqrt(saa * sbb + 1e-12); };
const pct = (a, q) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(q * (b.length - 1))]; };
for (const path of process.argv.slice(2)) {
  const d = readFileSync(path); const rate = d.readUInt32LE(24), ch = d.readUInt16LE(22); let off = 12, dataOff = 44;
  while (off + 8 <= d.length) { const id = d.toString('ascii', off, off + 4), len = d.readUInt32LE(off + 4); if (id === 'data') { dataOff = off + 8; break; } off += 8 + len + (len & 1); }
  const n = Math.floor((d.length - dataOff) / 2 / ch);
  const an = createAnalyser({ sampleRate: rate, hopSize: HOP, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015 }); an.setGainLock?.(false);
  const buf = new Float32Array(HOP); const T = [];   // per tick: [t, rmsEma, lowFrac, bodyDb, trebDb, sec]
  let ema = 0, nextTick = 0, h = 0, f = null;
  for (let i = 0; i + HOP <= n; i += HOP, h++) {
    let s2 = 0; for (let k = 0; k < HOP; k++) { let s = 0; for (let c = 0; c < ch; c++) s += d.readInt16LE(dataOff + ((i + k) * ch + c) * 2); const v = s / ch / 32768; buf[k] = v; s2 += v * v; }
    const t = h * HOP / rate * 1000; an.setAudioClockMs?.(t); if (h === 0) an.setVirtualClock?.(0); else an.advanceVirtualClock?.(HOP / rate * 1000);
    f = an.process(buf); const r = Math.sqrt(s2 / HOP); ema = ema === 0 ? r : ema + (r - ema) * (1 - Math.exp(-(HOP / rate) / 0.13));
    if (t >= nextTick) { nextTick += TICK; const a = f.specAbs; const lo = a.sub + a.kick + a.bass, tot = lo + a.lowMid + a.mid + a.highMid + a.treble + a.air + 1e-9;
      T.push([t, ema, lo / tot, f.bodyDb ?? -90, 20 * Math.log10(a.treble + a.air + 1e-7), f.section ?? '']); }
  }
  const G = 0.15 / Math.max(1e-6, pct(T.map((x) => x[1]), 0.5));
  // DAGENS
  let wsm, wslow, fastUntil = 20000, clip = 0, lastShape = 0.5, smA, smB; const bb = new BassBodyWindow(); const A = [], B = [];
  const smooth = (prev, x) => prev === undefined ? x : prev + (x - prev) * (1 - Math.exp(-TICK / (x > prev ? 25 : 250)));
  // TVÅ VARV (live överlever ankaret och fönstret mellan låtar): första varvet värmer upp båda vägarna, bara andra varvet mäts.
  for (let pass = 0; pass < 2; pass++) for (const [t0, rms, lowFrac, bdb] of T) {
    const t = t0 + pass * 1e9;
    if (pass === 0 && lowFrac <= 0) continue;   // tomma rutor före första analysen sår inte ankaret
    const amp = Math.min(1, rms * G), silent = amp < 0.025;
    const wraw = amp * Math.min(1, lowFrac / 0.5);
    wsm = wsm === undefined ? wraw : wraw > wsm ? wraw : wsm + (wraw - wsm) * (1 - Math.exp(-TICK / 55));
    const wdb = 20 * Math.log10(Math.max(wsm, 1e-4));
    if (!silent) {
      const up = wslow !== undefined && wdb > wslow, far = wslow !== undefined && Math.abs(wdb - wslow) > 6;
      if (lastShape >= 0.98 || lastShape <= 0.02) { clip += TICK; if (clip > 10000) fastUntil = t + 5000; } else clip = 0;
      const tau = 120000, fast = far || t < fastUntil;
      wslow = wslow === undefined ? wdb : wslow + (1 - Math.exp(-TICK / (fast ? tau / 10 : up ? tau * 3 : tau))) * (wdb - wslow);
    }
    const anchor = (wslow ?? wdb) + 4; let sh = (wdb - (anchor - 6)) / 6; sh = sh < 0 ? 0 : sh > 1 ? 1 : sh; lastShape = sh; if (silent) sh = 0;
    let shB = bb.step(bdb, TICK, silent); if (silent) shB = 0;
    smA = smooth(smA, sh); smB = smooth(smB, shB); if (pass === 1) { A.push(smA); B.push(smB); }
  }
  const k0 = T.findIndex((x) => x[0] >= 15000), body = T.slice(k0).map((x) => x[3]), treb = T.slice(k0).map((x) => x[4]), sec = T.slice(k0).map((x) => x[5]);
  // bastrycken = baskroppen minus sitt eget 2 s-medel (100 ticks), trenden = 2 s-medlet
  const ma = (v, w) => { const o = new Array(v.length); let acc = 0; for (let i = 0; i < v.length; i++) { acc += v[i]; if (i >= w) acc -= v[i - w]; o[i] = acc / Math.min(i + 1, w); } return o; };
  const bodyMa = ma(body, 100), bodyFast = body.map((x, i) => x - bodyMa[i]);
  const row = (S) => { const s = S.slice(k0); const sMa = ma(s, 100); const m = (lab) => { const v = s.filter((_, i) => sec[i] === lab); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN; };
    return { rBas: pear(s, body), rTryck: pear(s.map((x, i) => x - sMa[i]), bodyFast), rTrend: pear(sMa, bodyMa), rDisk: pear(s, treb), sving: pct(s, 0.9) - pct(s, 0.1), tak: s.filter((x) => x >= 0.98).length / s.length, botten: s.filter((x) => x <= 0.02).length / s.length, high: m('high'), low: m('low'), medel: s.reduce((p, q) => p + q, 0) / s.length }; };
  console.log(JSON.stringify({ fil: basename(path), min: +(T.at(-1)[0] / 60000).toFixed(1), dagens: row(A), bas: row(B) }));
}
