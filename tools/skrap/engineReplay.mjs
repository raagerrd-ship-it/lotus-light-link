// DETERMINISTISK MOTORREPLAY (skrapbanken 09-30): alsaMic + analysatorn (split=inline) + PiLightEngine pa VIRTUELL klocka.
// Ljudet matas som 256-ramarsperioder (S32 stereo, som ALSA) och tickInner() kors pa radions raster (17,5 ms) - samma
// ordning som syncTick pa Pi:n, men utan timers. Utdata per tick: ljusstyrka, farg och motorns diagnostikfalt;
// var 50:e tick en hash over ALLA numeriska/booleska falt i motorn (fullt tillstand). Tva korningar pa samma dist
// ger identisk fil; en andring i koden ska ge identisk fil mot baslinjen.
//   node engineReplay.mjs <dist> <ut.tsv> [--secs 600] [--profile N]   (--profile: ingen inspelning, samplad allokering N s efter uppvarmning)
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const DIST = argv[0], OUT = argv[1];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SECS = Number(opt('--secs', 600)), PROF = Number(opt('--profile', 0)), WARM = Number(opt('--warm', 120));
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// --- miljo som pa Pi:n (drop-ins), men analysatorn inline (deterministisk) ---
const ENV = `LOTUS_ANALYSER_SPLIT=inline LOTUS_SECTION_REPEAT=117 LOTUS_SECTION_W_HIGH=1.0 LOTUS_BAND_EVERY_HOPS=3 LOTUS_BLE_INTERVAL_UNITS=14 LOTUS_DROP_CALM_GATE=1 DROP_CALM_INTRO_STRICT=1 DROP_QUALITY_DB=6.5 BODY_RISE_DB=17 DROP_ARM_MS=300 DROP_RISE_MIN=1 BODY_FAST_S=0.06 DROP_RISE_LOW_DB=12 LOTUS_GRID_PHASE_OFFSET_MS=15 LOTUS_PLL_RING=0 LOTUS_SECTION_CAPTURE_S=0 LOTUS_SECTION_CAPTURE_MAX=200 LOTUS_SECTION_EARLY_S=45 LOTUS_SECTION_ON_HINT=1 LOTUS_TEMPO_UP43=1 LOTUS_TEMPO_EVIDENCE=1 LOTUS_TEMPO_ENV_S=10 LOTUS_KICK_NOGATE=1 LOTUS_KICK_COOLDOWN=100 LOTUS_GRID_PHASE=1 LOTUS_PHASE_FOLLOW=1 LOTUS_SECTION=1 LOTUS_TICK_SYNC=1 LOTUS_TICK_SYNC_GUARD_MS=4 BLE_ACL_MAX_OUTSTANDING=2 LOTUS_PULSE_PREDICT=1 NODE_ENV=production`;
for (const kv of ENV.split(' ')) { const [k, v] = kv.split('='); process.env[k] = v; }
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lotus-replay-'));
const PIDATA = process.env.PIDATA || path.join(here, '..', 'pidata-orig');   // kopia av Pi:ns DATA_DIR-json (kalibrering, mic-state, tempo-cache)
for (const f of fs.readdirSync(PIDATA)) fs.copyFileSync(path.join(PIDATA, f), path.join(data, f));
process.env.PCC_DATA_DIR = data; process.env.PCC_CONFIG_DIR = data; process.env.HOME = data;

// --- virtuell klocka ---
const EPOCH = 1_790_000_000_000;
let vnow = EPOCH;
Date.now = () => Math.floor(vnow);
const perf = globalThis.performance;
perf.now = () => vnow - EPOCH + 1000;

if (!process.env.NOHOOKS) register('./hooksManual.mjs', import.meta.url);
const mic = await import(pathToFileURL(DIST + '/alsaMic.js').href);
const E = await import(pathToFileURL(DIST + '/piEngine.js').href);
const logs = [];
console.log = (...a) => { logs.push(a.join(' ')); }; console.warn = console.log; console.error = console.log;

mic.startMic();
const cap = globalThis.__cap; const feed = cap.listeners('audio')[0];
const eng = new E.PiLightEngine(18);
eng.start();
mic.setGainLearnGate(true, false); mic.setMicPlaybackGate(true); mic.setAutoGainFromVolume(12);
eng.setVolume(12);
eng.setPlaying(true);
eng.onBleConnected();

const PL = JSON.parse(fs.readFileSync(process.env.PLAYLIST || path.join(here, 'playlist.json'), 'utf8'));   // [{wav, artist, title, seconds}]
const PALS = [[[255, 151, 0], [255, 0, 0], [232, 78, 59], [255, 151, 0]], [[184, 152, 0], [184, 178, 134], [184, 152, 0], [184, 152, 0]], [[255, 0, 64], [255, 131, 0], [255, 0, 0], [255, 0, 64]], [[79, 139, 166], [235, 160, 93], [198, 139, 96], [79, 139, 166]]];
const wavs = PL.map((s) => { const b = fs.readFileSync(s.wav); let off = 12, d = 44; while (off + 8 <= b.length) { const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4); if (id === 'data') { d = off + 8; break; } off += 8 + len + (len & 1); } return new Int16Array(b.buffer.slice(b.byteOffset + d, b.byteOffset + b.length - ((b.length - d) & 1))); });

const REC = !PROF;
const out = REC ? fs.openSync(OUT, 'w') : null;
let lines = [];
const td = { v: null };
eng.callbacks.push((d) => { td.v = d; });
// fullt tillstand: alla numeriska/booleska falt (aven i nastlade typade arrayer) -> FNV-1a over float64-bitar
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
function stateHash(o) {
  let h = 2166136261 >>> 0;
  const mix = (x) => { h ^= x; h = Math.imul(h, 16777619) >>> 0; };
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    if (typeof v === 'number') { f64[0] = v; mix(u32[0]); mix(u32[1]); }
    else if (typeof v === 'boolean') mix(v ? 1 : 2);
    else if (v === undefined) mix(3); else if (v === null) mix(4);
    else if (ArrayBuffer.isView(v) && v.length < 4096) { for (let i = 0; i < v.length; i++) { f64[0] = v[i]; mix(u32[0]); mix(u32[1]); } }
    else if (Array.isArray(v) && v.length < 4096) { mix(v.length); for (const x of v) if (typeof x === 'number') { f64[0] = x; mix(u32[0]); mix(u32[1]); } }
  }
  return h.toString(16);
}

const SR = 48000, PERIOD = 256, PMS = PERIOD / SR * 1000, TICK = 14 * 1.25;
let song = -1, songPos = 0, nextTick = vnow + TICK, nextPos = vnow + 1000, ticks = 0, t = 0;
const buf = Buffer.alloc(PERIOD * 8);   // en ateranvand buffert: bankens egen allokering ska inte synas
let session = null, profT0 = 0;
async function startProf() {
  const inspector = await import('node:inspector');
  session = new inspector.Session(); session.connect();
  const post = (m, p) => new Promise((r, j) => session.post(m, p ?? {}, (e, x) => e ? j(e) : r(x)));
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  return post;
}
let post = null, profStartVs = WARM, profTicks0 = 0;
const totalPeriods = Math.floor(SECS * 1000 / PMS);
for (let p = 0; p < totalPeriods; p++) {
  if (PROF && !post && t >= profStartVs * 1000) { post = await startProf(); profTicks0 = ticks; profT0 = t; }
  if (PROF && post && t >= (profStartVs + PROF) * 1000) break;
  // latbyte (150 s per lat)
  const si = Math.floor(t / 150000) % PL.length;
  if (si !== song) {
    song = si; songPos = 0; const s = PL[si];
    eng.setPalette([]); eng.setColor(PALS[si % 4][0]); eng.setPalette(PALS[si % 4]);
    eng.notifyTrackChange(s.artist, s.title); mic.hintAnalyserTrackChange?.(5000);
  }
  const w = wavs[song];
  for (let k = 0; k < PERIOD; k++) { const idx = songPos + k; const v = idx < w.length ? w[idx] * 65536 : 0; buf.writeInt32LE(v, k * 8); buf.writeInt32LE(v, k * 8 + 4); }
  songPos += PERIOD;
  vnow += PMS; t += PMS;
  feed(buf);
  while (vnow >= nextTick) {
    eng.tickInner(); ticks++;
    if (process.env.OPTSTAT && ticks % 500 === 0) { globalThis.__os ??= new Function('f', 'return %GetOptimizationStatus(f)'); const st = globalThis.__os(E.PiLightEngine.prototype.tickInner); const st2 = globalThis.__os(globalThis.__onAudio ?? feed); process.stdout.write(`opt t=${(t/1000).toFixed(0)} tickInner=${st.toString(2)} onAudio=${st2.toString(2)}
`); }
    if (REC && td.v) {
      const d = eng.getDiagnostics();
      lines.push(`${ticks}\t${td.v.brightness}\t${td.v.color[0]}\t${td.v.color[1]}\t${td.v.color[2]}\t${d.energyForm}\t${d.shape}\t${d.onsetBoost}\t${d.ampEnv}\t${d.wdbSlow}\t${d.wdb}` + (ticks % 50 === 0 ? `\t${stateHash(eng)}` : ''));
      if (lines.length >= 5000) { fs.writeSync(out, lines.join('\n') + '\n'); lines = []; }
    }
    nextTick += TICK;
  }
  if (vnow >= nextPos) { nextPos += 1000; eng.onSonosPosition(songPos / SR * 1000 | 0); }
}
if (process.env.DEBUGPRINT) { const dp = new Function('o', '%DebugPrint(o)'); dp(eng); const m = await import(pathToFileURL(DIST + '/piEngine.js').href); dp(m.getDiag ? m.getDiag() : eng.getDiagnostics()); }
if (REC) { fs.writeSync(out, lines.join('\n') + '\n'); fs.writeSync(out, logs.map((l) => '#LOG ' + l.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'TS')).join('\n') + '\n'); fs.closeSync(out); }
if (post) {
  const { profile } = await post('HeapProfiler.stopSampling');
  const secs = (t - profT0) / 1000, nt = ticks - profTicks0;
  fs.writeFileSync(OUT, JSON.stringify(profile));
  process.stdout.write(`profil ${secs.toFixed(0)} s virtuell tid, ${nt} tick -> ${OUT}\n`);
}
process.stdout.write(`klart: ${ticks} tick, ${(t / 1000).toFixed(0)} s\n`);
process.exit(0);
