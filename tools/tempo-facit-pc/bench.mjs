// Korbank for analysatorns tempoval (2026-09-19). Matar den KOMPILERADE analysatorn (samma kod som Pi:n
// kor) hop for hop med korpusens 48 kHz-snuttar och jamfor dess tempo med facit:
//   corpus/<id>.wav + .json   (PC-facit: result.bpm)          -> klass lika/dubbla/halva/3-2/4-3/annat
//   corpus-synth/<bpm>_*.wav  (kant tempo i filnamnet)
// Matt: analysatorns median-bpm over de sista 20 s (10 s uppvarmning), klassad mot facit.
//   node bench.mjs [--analyser ../../pi/dist/audio-analyser/index.js] [--dir corpus] [--synth corpus-synth]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ANALYSER = arg('--analyser', join(here, '..', '..', 'pi', 'dist', 'audio-analyser', 'index.js'));
const DIR = arg('--dir', join(here, 'corpus'));
const SYNTH = arg('--synth', join(here, 'corpus-synth'));
const { createAnalyser } = await import(pathToFileURL(ANALYSER).href);

function readWav(path) {
  const b = readFileSync(path);
  const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  let off = 12; let dataOff = 44, dataLen = b.length - 44;
  while (off + 8 <= b.length) {                       // hitta data-chunken (RIFF kan ha LIST m.m.)
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, b.length - dataOff); break; }
    off += 8 + len + (len & 1);
  }
  if (bits !== 16) throw new Error('bara 16-bit PCM');
  const n = Math.floor(dataLen / 2 / ch); const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2); y[i] = s / ch / 32768; }
  return { y, rate };
}

function classify(facit, an) {
  if (!facit || !an) return ['okänd', 0];
  const r = facit / an;
  for (const [x, lab] of [[1, 'lika'], [2, 'dubbla'], [0.5, 'halva'], [1.5, '3/2'], [2 / 3, '2/3'], [4 / 3, '4/3'], [0.75, '3/4']])
    if (Math.abs(r / x - 1) < 0.05) return [lab, r];
  return ['annat', r];
}

function runOne(y, rate) {
  const HOP = 128;
  const an = createAnalyser({ sampleRate: rate, hopSize: HOP, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015, onsetEnhancements: process.env.BENCH_ENH === '1' });   // standard AV = som Pi:n; BENCH_ENH=1 = 09-07-mergens onset-DSP (12/64 mot 30/64)
  an.setGainLock?.(false);
  const buf = new Float32Array(HOP); const bpms = []; const confs = []; const raws = []; const kicks = []; const grids = []; const sections = []; const preds = []; let lastSec = ''; let repeats = 0; let lastPhaseMs = 0; let lastKick = 0; let hopCount = 0; const warm = Math.floor(10 * rate / HOP);
  const dbg = process.env.BENCH_DEBUG && runOne.name && runOne.current && runOne.current.includes(process.env.BENCH_DEBUG);
  for (let i = 0; i + HOP <= y.length; i += HOP) {
    buf.set(y.subarray(i, i + HOP));
    an.setAudioClockMs?.(hopCount * HOP / rate * 1000);
    if (hopCount === 0) an.setVirtualClock?.(0); else an.advanceVirtualClock?.(hopCount * HOP / rate * 1000);   // setVirtualClock EN gang (lagesbyte nollar ankare), sedan bara advance
    const f = an.process(buf); hopCount++;
    if (process.env.BENCH_GRID === '1' && f && f.bpm > 0 && f.beatAnchorMs > 0) an.setBeatGrid?.({ bpm: f.bpm, anchorMs: f.beatAnchorMs });   // som motorn: analysatorn grindar kickar mot gridet
    if (f && f.kickAtMs > 0 && f.kickAtMs !== lastKick) { lastKick = f.kickAtMs; kicks.push((f.kickAtMs > 1e11 ? f.kickAtMs - 1700000000000 : f.kickAtMs) / 1000); }   // virtuell epok (1,7e12) bort -> sekunder fran start   // analysatorns kickar (virtuell klocka = sekunder fran start)
    if (hopCount > warm && hopCount % 38 === 0 && f && f.bpm > 0) { bpms.push(f.bpm); confs.push(f.bpmConfidence ?? 0); if (an.rawBpmLast > 0) raws.push(an.rawBpmLast); }   // ~10 Hz
    if (f && f.section && f.section !== lastSec) { lastSec = f.section; sections.push([+(hopCount * HOP / rate).toFixed(1), f.section]); }
    if (f && f.expectHighInMs > 0 && hopCount % 38 === 0) preds.push([hopCount * HOP / rate, hopCount * HOP / rate + f.expectHighInMs / 1000]);   // forutsagelse (~10 Hz): [nar, forutsedd high]
    if (f && f.repeatSim >= 0.92 && hopCount % 375 === 0) repeats++;
    if (hopCount > warm && f && f.bpm > 0 && f.beatPhaseMs > 0 && f.beatPhaseMs !== lastPhaseMs) { lastPhaseMs = f.beatPhaseMs; grids.push({ t: hopCount * HOP / rate, bpm: f.bpm, anchor: (f.beatPhaseMs > 1e11 ? f.beatPhaseMs - 1700000000000 : f.beatPhaseMs) / 1000, conf: f.beatPhaseConf ?? 1 }); }   // analysatorns GRIDFAS (LOTUS_GRID_PHASE=1; s fran start) per hop - beatAnchorMs ar bara senaste kicken
    if (dbg && hopCount % (375 * 5) === 0 && an.dbgPhase) { const d = an.dbgPhase; console.log(`  t=${(hopCount * HOP / rate).toFixed(0)}s GRIDFAS conf ${d.conf.toFixed(2)} bas on/anti ${d.bassOn.toFixed(2)}/${d.bassAnti.toFixed(2)} hel on/anti ${d.fullOn.toFixed(2)}/${d.fullAnti.toFixed(2)} fas ${d.bestPh}/${d.nPh} vantande ${d.pending} beatPhaseMs ${f.beatPhaseMs > 0 ? ((f.beatPhaseMs - 1700000000000) / 1000).toFixed(3) : 0}`); }
    if (dbg && hopCount % (375 * 5) === 0) console.log(`  t=${(hopCount * HOP / rate).toFixed(0)}s lockad ${f.bpm} ra ${an.rawBpmLast?.toFixed(1)} argmax-lag ${an.dbgBestLag} (${an.dbgBestLag ? (6000 / an.dbgBestLag).toFixed(1) : '-'} BPM, tg ${an.dbgTgAt?.(an.dbgBestLag)?.toFixed(3)}) fonster ${an.dbgLagMin}-${an.dbgLagMax} tg@37 ${an.dbgTgAt?.(37)?.toFixed(3)} tg@38 ${an.dbgTgAt?.(38)?.toFixed(3)} vinnare ${an.evidenceScore?.toFixed(2)} las ${an.evidenceLockScore?.toFixed(2)} roster ${an.evidRelockVotes} omlas ${an.evidenceRelocks} kandidater ${JSON.stringify(an.debugCandidates?.().map((c) => [c.bpm, +c.tg.toFixed(3), +c.score.toFixed(2), +c.half.toFixed(2)]))}`);
  }
  runOne.lastAnalyser = an;
  const s = [...bpms].sort((a, b) => a - b);
  const med = s.length ? s[s.length >> 1] : 0;
  const rs = [...raws].sort((a, b) => a - b); const rawMed = rs.length ? rs[rs.length >> 1] : 0;
  const q = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
  return { med, rawMed, kicks, grids, sections, preds, repeats, min: s[0] ?? 0, max: s[s.length - 1] ?? 0, q25: q(0.25), q75: q(0.75), conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0, n: bpms.length };
}

const rows = [];
if (existsSync(DIR)) for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json') && (!process.env.BENCH_FILTER || f.includes(process.env.BENCH_FILTER)))) {   // BENCH_FILTER=_smu9 -> bara langfangsterna
  const meta = JSON.parse(readFileSync(join(DIR, f), 'utf8')); const wav = join(DIR, f.replace(/\.json$/, '.wav'));
  if (!existsSync(wav)) continue;
  if (meta.result?.method === 'brus' || (meta.result?.quality && meta.result.quality.ok === false)) continue;   // brus-snuttar (kvalitetsgrinden) ar inget facit
  let facit = meta.result?.bpm || 0;
  const hasSections = !!(meta.result?.analysis?.sections?.segments?.length);
  if (!facit && !hasSections) continue;                                   // langfangst med sektionsfacit far vara med utan tempofacit (osakert = bpm 0)
  if (facit) { while (facit >= 160) facit /= 2; while (facit < 80) facit *= 2; }     // ANALYSATORNS vikning [80,160) (BPM_MIN/MAX): facit 160-180 halveras - lampan pulserar pa halva takten dar med avsikt (09-20: 7 'dubbla' var bara vikningen)
  const { y, rate } = readWav(wav); runOne.current = f; const r = runOne(y, rate);
  const [cls, ratio] = classify(facit, r.med);
  const pcOn = (meta.result?.analysis?.onset?.timesS) || [];
  if (process.env.BENCH_DEBUG && f.includes(process.env.BENCH_DEBUG) && r.sections.length) console.log(`  sektioner: ${r.sections.map(([t, l]) => `${t}s ${l}`).join(' -> ')} | upprepningar ${r.repeats}`);
  if (process.env.BENCH_DEBUG && f.includes(process.env.BENCH_DEBUG)) console.log(`  kick-debug: analysator-kickar ${r.kicks.length} (forsta ${r.kicks[0]?.toFixed(2)}, sista ${r.kicks[r.kicks.length-1]?.toFixed(2)}) | PC-onsets ${pcOn.length} (forsta ${pcOn[0]}, sista ${pcOn[pcOn.length-1]})`);
  let kickP = null, kickR = null, kickBias = null;
  if (pcOn.length >= 5 && r.kicks.length >= 3) {
    const near = (ts, grid) => ts.map((x) => { let best = Infinity; for (const g of grid) { const d = x - g; if (Math.abs(d) < Math.abs(best)) best = d; } return best; });
    const dk = near(r.kicks, pcOn), dp = near(pcOn, r.kicks);
    const hit = dk.filter((d) => Math.abs(d) <= 0.05);
    kickP = hit.length / dk.length; kickR = dp.filter((d) => Math.abs(d) <= 0.05).length / dp.length;
    kickBias = hit.length ? hit.sort((a, b) => a - b)[hit.length >> 1] * 1000 : null;
  }
  const pcBeats = meta.result?.beatsS || [];
  // FASMATT (09-20): PC:ns slag (stelt grid) mot analysatorns egna grid vid samma tidpunkt - bara nar analysatorns bpm = PC:ns
  // slagperiod (samma oktav). on-beat = |fel| < slag/4. Live-korpusen visade 9/39 latar i MOTFAS (lampan pa off-beaten) och
  // helbandsonseten bekraftade PC-fasen; har mats analysatorns grid (det som matar motorns PLL) direkt.
  const phaseVs = (beats) => {                                            // analysatorns gridfas mot en slaglista (samma oktav)
    if (!(beats.length >= 8 && r.grids.length >= 20)) return [null, 0];
    const iv = beats.slice(1).map((x, i) => x - beats[i]).sort((a, b) => a - b); const per = iv[iv.length >> 1];
    let hit = 0, n = 0, gi = 0;
    for (const b of beats) {
      if (b < 10) continue;
      while (gi + 1 < r.grids.length && r.grids[gi + 1].t <= b) gi++;
      const g = r.grids[gi]; const gp = 60 / g.bpm;
      if (Math.abs(gp / per - 1) >= 0.04) continue;                       // annan oktav/tempo - fasen saknar mening
      const k = Math.round((b - g.anchor) / gp); const off = b - (g.anchor + k * gp);
      n++; if (Math.abs(off) < per / 4) hit++;
    }
    return n >= 8 ? [hit / n, n] : [null, 0];
  };
  const [phaseOn, phaseN] = phaseVs(pcBeats);
  // SEKTIONSFACIT (09-20): langfangst med all-in-one-segment -> andel sekunder dar analysatorns 'high' == facit 'chorus',
  // samt hur stor andel av facit-refrangerna analysatorn markerar som 'high' (recall) och hur mycket 'high' som ar utanfor (falsk).
  let secAgree = null, secRecall = null, secFalse = null, secBound = null, predHit = null, predTot = null, predLead = null, predFalse = null;
  // SEKTIONSFACIT = molnets granser + energirang per segment (section_facit.py -> sections.derived: tier high/mid/low/intro).
  // Matt: high==high-andel per sekund, refrang-recall (facit-high med analysator-high), falsk-high (analysator-high utanfor
  // facit-high), gransfel: andel av analysatorns byten som ligger inom +-3 s fran nagon facitgrans.
  const segs = meta.result?.analysis?.sections?.derived || [];
  if (segs.length >= 2 && r.sections && r.sections.length >= 1 && y.length / rate > 60) {
    const total = Math.floor(y.length / rate); let agree = 0, chorusS = 0, chorusHit = 0, highS = 0, highOut = 0;
    const labAt = (t) => { let l = r.sections[0][1]; for (const [ts, ll] of r.sections) { if (ts <= t) l = ll; else break; } return l; };
    for (let t = 10; t < total; t++) {
      const seg = segs.find((g) => g.start <= t && t < g.end); if (!seg) continue;
      const isChorus = seg.tier === 'high'; const isHigh = labAt(t) === 'high';
      if (isChorus === isHigh) agree++;
      if (isChorus) { chorusS++; if (isHigh) chorusHit++; }
      if (isHigh) { highS++; if (!isChorus) highOut++; }
    }
    const n = Math.max(1, total - 10); secAgree = agree / n; secRecall = chorusS ? chorusHit / chorusS : null; secFalse = highS ? highOut / highS : null;
    const bounds = segs.slice(1).map((g) => g.start); const changes = r.sections.slice(1).map(([ts]) => ts).filter((ts) => ts >= 10);
    if (changes.length) secBound = changes.filter((ts) => bounds.some((bd) => Math.abs(bd - ts) <= 3)).length / changes.length;
    // FORUTSAGELSE (09-21): facitets high-starter (tier high efter icke-high, >= 20 s) - traff om nagon forutsagelse gjord 1-12 s
    // fore starten pekade inom +-2 s; lead = tidigast traffande forutsagelse. Falsk = forutsedd tidpunkt > 4 s fran alla high-starter.
    const highStarts = segs.filter((g, i) => g.tier === 'high' && i > 0 && segs[i - 1].tier !== 'high' && g.start >= 20).map((g) => g.start);
    if (highStarts.length && r.preds) {
      predTot = highStarts.length; predHit = 0; const leads = [];
      for (const hs of highStarts) { const hits = r.preds.filter(([tp, at]) => tp >= hs - 12 && tp <= hs - 1 && Math.abs(at - hs) <= 2); if (hits.length) { predHit++; leads.push(hs - hits[0][0]); } }
      leads.sort((a, b) => a - b); predLead = leads.length ? leads[leads.length >> 1] : null;
      const uniq = [...new Set(r.preds.map(([, at]) => Math.round(at)))]; predFalse = uniq.filter((at) => !highStarts.some((hs) => Math.abs(at - hs) <= 4)).length / Math.max(1, y.length / rate / 60);
    }
  }
  if (process.env.BENCH_DEBUG === 'sec' && segs.length >= 2) {   // per-lat sektionsdiagnostik + dump av blocksardragen (LOTUS_SECTION_DUMP=1) for offline-simulering
    console.log(`  SEC ${f.slice(0, 36).padEnd(38)} agree ${secAgree?.toFixed(2)} recall ${secRecall?.toFixed(2)} falsk ${secFalse?.toFixed(2)} grans ${secBound?.toFixed(2)} byten ${r.sections.length - 1} | ${r.sections.map(([t, l]) => `${t}${l[0]}`).join(' ')}`);
    if (runOne.lastAnalyser?.secDump) { const { writeFileSync, mkdirSync } = await import('node:fs'); const dd = process.env.BENCH_DUMP_DIR || 'secdump'; mkdirSync(dd, { recursive: true }); writeFileSync(join(dd, f), JSON.stringify({ segs, lenS: y.length / rate, blocks: runOne.lastAnalyser.secDump, sections: r.sections })); }
  }
  const a1Beats = meta.allin1?.beatsS || [];                              // all-in-one (ML-slagfoljare via Replicate) som tredje referens
  const [phaseA1] = phaseVs(a1Beats);
  const btBeats = meta.beatthis?.beatsS || [];                            // Beat This! (lokal ML-slagfoljare, beatthis_facit.py)
  const [phaseBt] = phaseVs(btBeats);
  // FOLJAR-EMULERING (09-20): motorns gridfas-foljare (piEngine LOTUS_PHASE_FOLLOW) korts pa analysatorns fasmatningar
  // (4 Hz) och de resulterande PULSERNA mats mot Beat This!-slagen (stelt grid): on-beat-andel + IQR. Live 12:42-14:50
  // (Melody: pulserna hoppade +-50 %, IQR 139 ms) visade att foljaren forstor fasen nar matningen flimrar.
  const followerRun = (p) => {
    if (btBeats.length < 8 || r.grids.length < 20) return null;
    const iv = btBeats.slice(1).map((x, i) => x - btBeats[i]).sort((a, b) => a - b); const per = iv[iv.length >> 1];
    const k = btBeats.map((_, i) => i); const n = k.length; const sx = k.reduce((a, c) => a + c, 0), sy = btBeats.reduce((a, c) => a + c, 0), sxx = k.reduce((a, c) => a + c * c, 0), sxy = k.reduce((a, c, i) => a + c * btBeats[i], 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), c0 = (sy - slope * sx) / n;
    let anchor = -1, bpm = 0, flipVotes = 0, lastT = 0; const pulses = [];
    for (const g of r.grids) {
      const gp = 60 / g.bpm;
      if (Math.abs(gp / slope - 1) >= 0.04) { anchor = -1; continue; }             // annan oktav/tempo: fasen saknar mening
      if (anchor < 0 || bpm !== g.bpm) { anchor = g.anchor; bpm = g.bpm; lastT = g.t; flipVotes = 0; continue; }
      const ph = (((g.anchor - anchor) % gp) + gp) % gp / gp; const err = ph < 0.5 ? ph : ph - 1;
      if (p.mode === 'raw') { anchor = g.anchor; }
      else if (Math.abs(err) > 0.35) { if (g.conf >= p.flipConf && ++flipVotes >= p.flipVotes) { anchor += err * gp; flipVotes = 0; } }
      else { flipVotes = 0; if (g.conf >= p.holdConf) anchor += err * gp * (g.conf >= 1.3 ? p.kHi : p.kLo); }
      // pulser mellan lastT och g.t ur aktuellt anker
      let kk = Math.ceil((lastT - anchor) / gp); for (let t = anchor + kk * gp; t < g.t; t += gp) pulses.push(t);
      lastT = g.t;
    }
    if (pulses.length < 8) return null;
    const grid = []; for (let i = -2; i < n + 3; i++) grid.push(c0 + slope * i);
    const offs = pulses.filter((t) => t > 10).map((t) => { let best = Infinity; for (const gg of grid) { const d = t - gg; if (Math.abs(d) < Math.abs(best)) best = d; } return best; });
    const on = offs.filter((d) => Math.abs(d) < per / 4).map((d) => d * 1000).sort((a, b) => a - b);
    return { share: offs.length ? on.length / offs.length : null, iqr: on.length >= 4 ? on[Math.floor(on.length * 0.75)] - on[Math.floor(on.length * 0.25)] : null, med: on.length >= 4 ? on[on.length >> 1] : null, n: offs.length };
  };
  const FOLLOWERS = { raw: { mode: 'raw' }, f1: { mode: 'f', kHi: 0.3, kLo: 0.15, holdConf: 0, flipConf: 1.3, flipVotes: 2 }, f2: { mode: 'f', kHi: 0.2, kLo: 0.05, holdConf: 1.15, flipConf: 1.5, flipVotes: 3 }, f3: { mode: 'f', kHi: 0.15, kLo: 0, holdConf: 1.3, flipConf: 1.6, flipVotes: 4 } };
  const follow = {}; for (const [name, p] of Object.entries(FOLLOWERS)) follow[name] = followerRun(p);
  let pcVsA1 = null;                                                      // PC-facit-slagen mot allin1-slagen (samma oktav): vem har fasen?
  if (a1Beats.length >= 8 && pcBeats.length >= 8) {
    const ivp = pcBeats.slice(1).map((x, i) => x - pcBeats[i]).sort((a, b) => a - b); const pp = ivp[ivp.length >> 1];
    const iva = a1Beats.slice(1).map((x, i) => x - a1Beats[i]).sort((a, b) => a - b); const pa = iva[iva.length >> 1];
    if (Math.abs(pp / pa - 1) < 0.04) { let hit = 0, n = 0; for (const b of a1Beats) { if (b < 1) continue; let best = Infinity; for (const p of pcBeats) { const d = Math.abs(p - b); if (d < best) best = d; } n++; if (best < pp / 4) hit++; } pcVsA1 = n ? hit / n : null; }
  }
  let beatR = null;   // ON-BEAT-RECALL: andel PC-slag (i valt tempo) som fick en analysator-kick inom +-60 ms
  if (pcBeats.length >= 8 && r.kicks.length >= 3) {
    let hitB = 0; for (const g of pcBeats) { let best = Infinity; for (const k of r.kicks) { const d = Math.abs(k - g); if (d < best) best = d; } if (best <= 0.06) hitB++; }
    beatR = hitB / pcBeats.length;
  }
  rows.push({ set: 'korpus', secLenS: y.length / rate, follow, secAgree, secRecall, secFalse, secBound, predHit, predTot, predLead, predFalse, phaseOn, phaseN, phaseA1, phaseBt, pcVsA1, beatR, kickP, kickR, kickBias, nKick: r.kicks.length, nOn: pcOn.length, name: `${meta.row?.artist ?? ''} – ${meta.row?.title ?? basename(f)}`.slice(0, 40), facit, ...r, cls, ratio });
}
if (existsSync(SYNTH)) for (const f of readdirSync(SYNTH).filter((f) => f.endsWith('.wav'))) {
  const facit = parseFloat(f); if (!facit) continue;
  const { y, rate } = readWav(join(SYNTH, f)); runOne.current = f; const r = runOne(y, rate);
  const [cls, ratio] = classify(facit, r.med);
  rows.push({ set: 'synt', name: f.replace(/\.wav$/, ''), facit, ...r, cls, ratio });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('set', 7) + pad('lat', 42) + pad('facit', 8) + pad('analys', 8) + pad('ra-med', 8) + pad('spann', 12) + pad('conf', 6) + pad('klass', 8) + 'kvot');
for (const r of rows) console.log(pad(r.set, 7) + pad(r.name, 42) + pad(r.facit.toFixed(1), 8) + pad(r.med.toFixed(1), 8) + pad(r.rawMed.toFixed(1), 8) + pad(`${r.min.toFixed(0)}–${r.max.toFixed(0)}`, 12) + pad(r.conf.toFixed(2), 6) + pad(r.cls, 8) + pad(r.ratio.toFixed(2), 6) + (typeof r.phaseOn === 'number' ? ` fas ${r.phaseOn.toFixed(2)}` : '') + (typeof r.phaseA1 === 'number' ? ` a1 ${r.phaseA1.toFixed(2)}` : '') + (typeof r.phaseBt === 'number' ? ` bt ${r.phaseBt.toFixed(2)}` : '') + (typeof r.pcVsA1 === 'number' ? ` pc~a1 ${r.pcVsA1.toFixed(2)}` : ''));
for (const set of ['korpus', 'synt']) {
  const rs = rows.filter((r) => r.set === set); if (!rs.length) continue;
  const ok = rs.filter((r) => r.cls === 'lika').length;
  const kr = rs.filter((r) => typeof r.kickR === 'number'); const medk = (k) => kr.length ? [...kr].map((r) => r[k]).sort((a, b) => a - b)[kr.length >> 1] : null;
  if (kr.length) console.log(`${set} kick: recall ${medk('kickR')?.toFixed(2)} precision ${medk('kickP')?.toFixed(2)} bias ${medk('kickBias')?.toFixed(0)} ms (n=${kr.length} latar med PC-onsets)`);
  const br = rs.filter((r) => typeof r.beatR === 'number'); if (br.length) console.log(`${set} on-beat-recall: ${[...br].map((r) => r.beatR).sort((a, b) => a - b)[br.length >> 1].toFixed(2)} (median, n=${br.length} latar med PC-slag)`);
  const pr = rs.filter((r) => typeof r.phaseOn === 'number');
  if (pr.length) console.log(`${set} fas: on-beat-andel median ${[...pr].map((r) => r.phaseOn).sort((a, b) => a - b)[pr.length >> 1].toFixed(2)}, motfas (<=0,2) ${pr.filter((r) => r.phaseOn <= 0.2).length}, i fas (>=0,8) ${pr.filter((r) => r.phaseOn >= 0.8).length} (n=${pr.length} latar i samma oktav)`);
  const pa = rs.filter((r) => typeof r.phaseA1 === 'number');
  if (pa.length) console.log(`${set} fas mot allin1: on-beat-andel median ${[...pa].map((r) => r.phaseA1).sort((a, b) => a - b)[pa.length >> 1].toFixed(2)}, motfas ${pa.filter((r) => r.phaseA1 <= 0.2).length}, i fas ${pa.filter((r) => r.phaseA1 >= 0.8).length} (n=${pa.length})`);
  const pb = rs.filter((r) => typeof r.phaseBt === 'number');
  if (pb.length) console.log(`${set} fas mot Beat This!: on-beat-andel median ${[...pb].map((r) => r.phaseBt).sort((a, b) => a - b)[pb.length >> 1].toFixed(2)}, motfas ${pb.filter((r) => r.phaseBt <= 0.2).length}, i fas ${pb.filter((r) => r.phaseBt >= 0.8).length}, mellan ${pb.filter((r) => r.phaseBt > 0.2 && r.phaseBt < 0.8).length} (n=${pb.length})`);
  for (const name of ['raw', 'f1', 'f2', 'f3']) {
    const fr = rs.filter((r) => r.follow && r.follow[name] && typeof r.follow[name].share === 'number');
    if (!fr.length) continue;
    const sh = fr.map((r) => r.follow[name].share).sort((a, b) => a - b); const iq = fr.filter((r) => r.follow[name].iqr !== null).map((r) => r.follow[name].iqr).sort((a, b) => a - b);
    const md = fr.filter((r) => r.follow[name].med !== null).map((r) => r.follow[name].med); const mdS = [...md].sort((a, b) => a - b); const absS = md.map(Math.abs).sort((a, b) => a - b);
    console.log(`${set} foljare ${name}: puls on-beat median ${sh[sh.length >> 1].toFixed(2)}, i fas (>=0,8) ${sh.filter((v) => v >= 0.8).length}, motfas (<=0,2) ${sh.filter((v) => v <= 0.2).length}, IQR median ${iq.length ? iq[iq.length >> 1].toFixed(0) : '-'} ms, offset median ${mdS.length ? mdS[mdS.length >> 1].toFixed(0) : '-'} ms, |offset| median ${absS.length ? absS[absS.length >> 1].toFixed(0) : '-'} ms, andel |offset| <= 30 ms ${md.length ? (md.filter((v) => Math.abs(v) <= 30).length / md.length).toFixed(2) : '-'} (n=${fr.length})`);
  }
  const sf = rs.filter((r) => typeof r.secAgree === 'number');
  if (sf.length) console.log(`${set} sektionsfacit (langfangster n=${sf.length}): gransfel-traff median ${[...sf].filter((r) => r.secBound !== null).map((r) => r.secBound).sort((a, b) => a - b)[sf.filter((r) => r.secBound !== null).length >> 1]?.toFixed(2)}, high==high andel median ${[...sf].map((r) => r.secAgree).sort((a, b) => a - b)[sf.length >> 1].toFixed(2)}, refrang-recall median ${[...sf].filter((r) => r.secRecall !== null).map((r) => r.secRecall).sort((a, b) => a - b)[sf.filter((r) => r.secRecall !== null).length >> 1]?.toFixed(2)}, falsk-high median ${[...sf].filter((r) => r.secFalse !== null).map((r) => r.secFalse).sort((a, b) => a - b)[sf.filter((r) => r.secFalse !== null).length >> 1]?.toFixed(2)}`);
  const prd = rs.filter((r) => r.predTot); if (prd.length) { const h = prd.reduce((a, r) => a + r.predHit, 0), t = prd.reduce((a, r) => a + r.predTot, 0); const leads = prd.map((r) => r.predLead).filter((x) => x !== null).sort((a, b) => a - b); const fl = prd.map((r) => r.predFalse).sort((a, b) => a - b);
    console.log(`${set} forutsagelse (langfangster n=${prd.length}): refrangstart forutsedd ${h}/${t} (${(100 * h / Math.max(1, t)).toFixed(0)} %), lead median ${leads.length ? leads[leads.length >> 1].toFixed(1) : '-'} s, falska/min median ${fl.length ? fl[fl.length >> 1].toFixed(1) : '-'}`); }
  const sec = rs.filter((r) => r.sections && r.sections.length);
  if (sec.length && sec.some((r) => r.sections.length > 1)) { const cnt = {}; let hi = 0, rep = 0; for (const r of sec) { for (const [, l] of r.sections) cnt[l] = (cnt[l] || 0) + 1; if (r.sections.some(([, l]) => l === 'high')) hi++; if (r.repeats > 0) rep++; }
    const durs = []; for (const r of sec) for (let i = 1; i < r.sections.length; i++) durs.push(r.sections[i][0] - r.sections[i - 1][0]); durs.sort((a, b) => a - b);
    const longs = sec.filter((r) => r.secLenS >= 90); const lb = longs.map((r) => (r.sections.length - 1) / (r.secLenS / 60)).sort((a, b) => a - b);
    console.log(`${set} sektioner: byten per lat median ${[...sec].map((r) => r.sections.length - 1).sort((a, b) => a - b)[sec.length >> 1]}, sektionslangd median ${durs.length ? durs[durs.length >> 1].toFixed(1) : '-'} s, langfangster (>=90 s) byten/min median ${lb.length ? lb[lb.length >> 1].toFixed(1) : '-'} (n=${longs.length}), latar med 'high' ${hi}/${sec.length}, med upprepning ${rep}, etiketter ${JSON.stringify(cnt)}`); }
  const pv = rs.filter((r) => typeof r.pcVsA1 === 'number');
  if (pv.length) console.log(`${set} PC-facit mot allin1 (fas): on-beat-andel median ${[...pv].map((r) => r.pcVsA1).sort((a, b) => a - b)[pv.length >> 1].toFixed(2)}, motfas ${pv.filter((r) => r.pcVsA1 <= 0.2).length}, i fas ${pv.filter((r) => r.pcVsA1 >= 0.8).length} (n=${pv.length})`);
  const cls = {}; for (const r of rs) cls[r.cls] = (cls[r.cls] || 0) + 1;
  console.log(`${set}: ${ok}/${rs.length} ratt (lika)  klasser ${JSON.stringify(cls)}  spann-median ${[...rs].map((r) => r.max - r.min).sort((a, b) => a - b)[rs.length >> 1]?.toFixed(0)} BPM`);
}
