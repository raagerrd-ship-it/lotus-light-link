/**
 * PARITETSBANK FOR DEN ENADE ANALYSATORN (2026-09-24). Kor SAMMA ljud hop for hop genom tva kompilerade
 * analysatorer (gammal = systemets analysator fore sammanslagningen, ny = den gemensamma filen med systemets
 * profil) och jamfor VARJE falt i varje Frame (plattat: spec/onset/drum/profile/specAbs) plus loggraderna
 * ([dropfire] m.fl.). Falt som bara finns i den nya ramen (nya utdata) ignoreras. Env ar densamma for bada
 * (rattarna lases vid modulladdning), sa en korning per env-variant.
 *
 *   node tools/analyserParity.mjs --old <gammal modul> --new <ny modul> --style lotus|dmx [--cfg <config.js>]
 *        [--secs 120] [--from 0] [--grid] [--hint-every 0] [--reset-every 0] [--split inline] [--max-report 5] <wav> ...
 *
 * --style lotus: platt konfig som alsaMic, setVirtualClock(0) + advanceVirtualClock, ljudklocka (som bench.mjs).
 * --style dmx:   motorns defaultConfig (--cfg), setGainLock(true, 1), setVirtualClock per hop (som dropBench.mjs).
 * --grid:        taktrastret matas tillbaka fran ramen (lotus: setBeatGrid; dmx: cfg.beat som index.ts).
 * --hint-every/--reset-every N: hintTrackChange()/resetTempo() var N:e sekund (latbyten).
 * --split inline: bada skapas via createAnalyser med <prefix>ANALYSER_SPLIT=inline (delad analysator i samma trad).
 * Utskrift: per fil antal hop, avvikande hop/falt, forsta avvikelser; sist en summering. Exit 1 vid avvikelse.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const OLD = opt('--old'), NEW = opt('--new'), STYLE = opt('--style', 'lotus'), CFG = opt('--cfg');
const SECS = Number(opt('--secs', 120)), FROM = Number(opt('--from', 0)), GRID = flag('--grid');
const HINT_EVERY = Number(opt('--hint-every', 0)), RESET_EVERY = Number(opt('--reset-every', 0)), SPLIT = opt('--split', '');
const MAXREP = Number(opt('--max-report', 5));
const valued = new Set(['--old', '--new', '--style', '--cfg', '--secs', '--from', '--hint-every', '--reset-every', '--split', '--max-report']);
const wavs = argv.filter((a, i) => a.endsWith('.wav') && !valued.has(argv[i - 1]));
if (!OLD || !NEW || !wavs.length) { console.error('ange --old, --new och minst en wav'); process.exit(2); }

if (SPLIT) { process.env.LOTUS_ANALYSER_SPLIT = SPLIT; process.env.DMX_ANALYSER_SPLIT = SPLIT; }
const modOld = await import(pathToFileURL(OLD).href);
const modNew = await import(pathToFileURL(NEW).href);
const defaultConfig = CFG ? (await import(pathToFileURL(CFG).href)).defaultConfig : null;

// Loggrader per sida (analysatorn loggar [dropfire] m.m. med console.log)
let side = null; const logs = { old: [], new: [] };
const origLog = console.log;
console.log = (...a) => { if (side) logs[side].push(a.join(' ')); else origLog(...a); };
const normLog = (s) => s.replace(/ edgeAgo -?[\d.]+ms/, '');

function readWav(path) {
  const b = readFileSync(path);
  const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  let off = 12, dataOff = 44, dataLen = b.length - 44;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = len > 0 ? Math.min(len, b.length - dataOff) : b.length - dataOff; break; }
    off += 8 + len + (len & 1);
  }
  if (bits !== 16) throw new Error('bara 16-bit PCM');
  const n = Math.floor(dataLen / 2 / ch); const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2); y[i] = s / ch / 32768; }
  return { y, rate };
}

function make(mod) {
  if (STYLE === 'dmx') {
    const cfg = JSON.parse(JSON.stringify(defaultConfig));
    const an = SPLIT ? mod.createAnalyser(cfg) : new mod.Analyser(cfg);
    an.setGainLock(true, 1);
    return { an, cfg };
  }
  const c = { sampleRate: 48000, hopSize: 128, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015, onsetEnhancements: false };
  const an = SPLIT ? mod.createAnalyser(c) : new mod.Analyser(c);
  an.setGainLock(false);
  return { an, cfg: null };
}

function flat(f, out, pre = '') {
  for (const k of Object.keys(f)) {
    const v = f[k];
    if (v && typeof v === 'object') flat(v, out, pre + k + '.');
    else out[pre + k] = v;
  }
  return out;
}
const same = (a, b) => a === b || (a !== a && b !== b);

let totalHops = 0, totalBad = 0, totalLogBad = 0;
for (const w of wavs) {
  const { y, rate } = readWav(w);
  const A = make(modOld), B = make(modNew);
  const HOP = 128; const buf = new Float32Array(HOP);
  const i0 = Math.floor(FROM * rate), i1 = Math.min(y.length, i0 + Math.floor(SECS * rate));
  let hops = 0, badHops = 0; const badFields = new Map(); const firsts = [];
  logs.old.length = 0; logs.new.length = 0;
  for (let i = i0; i + HOP <= i1; i += HOP, hops++) {
    buf.set(y.subarray(i, i + HOP));
    const ms = hops * HOP / rate * 1000;
    const tS = ms / 1000;
    const frames = [];
    for (const [name, X] of [['old', A], ['new', B]]) {
      side = name;
      if (STYLE === 'dmx') X.an.setVirtualClock(ms);
      else { X.an.setAudioClockMs(ms); if (hops === 0) X.an.setVirtualClock(0); else X.an.advanceVirtualClock(ms); }
      if (HINT_EVERY > 0 && hops > 0 && hops % Math.round(HINT_EVERY * rate / HOP) === 0) X.an.hintTrackChange(5000);
      if (RESET_EVERY > 0 && hops > 0 && hops % Math.round(RESET_EVERY * rate / HOP) === 0) X.an.resetTempo();
      const f = X.an.process(buf);
      if (GRID && f.bpm > 0) {
        if (STYLE === 'dmx') X.cfg.beat = { anchorMs: f.beatAnchorMs || ms, bpm: f.bpm, confidence: f.bpmConfidence };
        else if (f.beatAnchorMs > 0) X.an.setBeatGrid({ bpm: f.bpm, anchorMs: f.beatAnchorMs });
      }
      frames.push(flat(f, {}));
      side = null;
    }
    const [fo, fn] = frames; let bad = false;
    for (const k of Object.keys(fo)) {
      if (!same(fo[k], fn[k])) {
        bad = true; badFields.set(k, (badFields.get(k) || 0) + 1);
        if (firsts.length < MAXREP) firsts.push(`t=${tS.toFixed(3)} ${k}: gammal ${fo[k]} ny ${fn[k]}`);
      }
    }
    if (bad) badHops++;
  }
  const lo = logs.old.map(normLog), ln = logs.new.map(normLog);
  let logBad = 0; const nL = Math.max(lo.length, ln.length); const logFirst = [];
  for (let i = 0; i < nL; i++) if (lo[i] !== ln[i]) { logBad++; if (logFirst.length < 3) logFirst.push(`  logg ${i}: gammal "${lo[i] ?? '-'}"\n          ny     "${ln[i] ?? '-'}"`); }
  totalHops += hops; totalBad += badHops; totalLogBad += logBad;
  origLog(`${w.split(/[\\/]/).pop()}: ${hops} hop, avvikande hop ${badHops}, loggrader ${lo.length}/${ln.length} (avvikande ${logBad})` +
    (badFields.size ? `\n  falt: ${[...badFields.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => k + ' ' + n).join(', ')}\n  ${firsts.join('\n  ')}` : '') +
    (logFirst.length ? '\n' + logFirst.join('\n') : ''));
  A.an.__stopWorker?.(); B.an.__stopWorker?.();
}
origLog(`SUMMA ${STYLE}${SPLIT ? ' split=' + SPLIT : ''}${GRID ? ' grid' : ''}: ${wavs.length} filer, ${totalHops} hop, avvikande hop ${totalBad}, avvikande loggrader ${totalLogBad}`);
process.exit(totalBad || totalLogBad ? 1 : 0);
