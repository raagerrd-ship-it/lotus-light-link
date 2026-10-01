// TEMPO-MINNET: ekvivalensbevis gammal TempoCache (allt i minnet) mot ny (karna i minnet + ogonblicksbild/journal pa disk).
// Samma slumpade foljd av operationer - i samma form som index.ts (resolveTempo/verdict/learn/secAt) och configServer
// (PC-facit, dropdom) anropar dem - pa en kopia av Pi:ns tempo-cache.json, med omstarter emellan. Jamfor efter varje fas:
//   - API-svaret byte for byte: JSON.stringify(gammal.list()) === JSON.stringify(await ny.listFull())
//   - get(k) for alla nycklar (karnfalten), hasPc mot gammal row.pc, octaveStat mot gamla oktavstatistiken.
//   node equiv.mjs <gammal dist> <ny dist> <tempo-cache.json> [antal ops per fas=400] [faser=6] [seed=1]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [OLD, NEW, SRC, NOPS = '400', NPH = '6', SEED = '1'] = process.argv.slice(2);
const O = await import(pathToFileURL(path.resolve(OLD, 'tempoLookup.js')).href);
const N = await import(pathToFileURL(path.resolve(NEW, 'tempoLookup.js')).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempominne-'));
fs.mkdirSync(dir + '/o'); fs.mkdirSync(dir + '/n');
fs.copyFileSync(SRC, dir + '/o/tempo-cache.json'); fs.copyFileSync(SRC, dir + '/n/tempo-cache.json');
let seed = Number(SEED); const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const pool = Object.values(src); const pcs = pool.filter((e) => e.pc).map((e) => e.pc); const learns = pool.filter((e) => e.learn).map((e) => e.learn);
const cands = pool.filter((e) => e.candidates).map((e) => e.candidates); const drops = pool.flatMap((e) => e.dropEvents || []);
let keys = Object.keys(src); let now = 1_790_000_000_000; Date.now = () => now;
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
let o = new O.TempoCache(dir + '/o/tempo-cache.json'); o.load();
let n = new N.TempoCache(dir + '/n/tempo-cache.json'); n.load();
const HEAVY = ['pc', 'candidates', 'dropEvents', 'learn'];
const coreOf = (e) => { if (!e) return e; const c = {}; for (const f in e) if (!HEAVY.includes(f)) c[f] = e[f]; return c; };
function oldOctave(tc) {
  const rows = tc.list().filter((r) => r.bpm > 0 && r.learn && (r.learn.octave2x ?? 0) > 0.5 && typeof r.learn.facitRatioEnd === 'number');
  return { hit: rows.filter((r) => Math.abs(r.learn.facitRatioEnd / 2 - 1) < 0.05).length, n: rows.length };
}
let fails = 0;
async function compare(tag) {
  const a = JSON.stringify(o.list()), b = JSON.stringify(await n.listFull());
  const allKeys = new Set([...o.list().map((r) => r.key)]);
  let getDiff = 0, pcDiff = 0;
  for (const k of allKeys) {
    if (JSON.stringify(coreOf(o.get(k))) !== JSON.stringify(coreOf(n.get(k)))) { getDiff++; if (process.env.DBG && getDiff === 1) console.log(`  get ${k}\n   o ${JSON.stringify(coreOf(o.get(k)))}\n   n ${JSON.stringify(coreOf(n.get(k)))}`); }
    const orow = o.get(k); if (!!(orow && orow.bpm > 0 && orow.pc) !== !!(n.get(k) && n.get(k).bpm > 0 && n.hasPc(k))) pcDiff++;
  }
  const oo = oldOctave(o), no = n.octaveStat();
  const ok = a === b && getDiff === 0 && pcDiff === 0 && oo.hit === no.hit && oo.n === no.n && o.size === n.size;
  if (!ok) fails++;
  console.log(`${tag}: API ${a === b ? 'IDENTISK' : 'SKILJER'} (${a.length} B), get-diff ${getDiff}, hasPc-diff ${pcDiff}, oktav ${oo.hit}/${oo.n} vs ${no.hit}/${no.n}, poster ${o.size}/${n.size}, journal ${n.journalBytes()} B`);
  if (a !== b) { let i = 0; while (a[i] === b[i]) i++; console.log('  forsta skillnad @' + i + '\n  gammal: ' + a.slice(i - 80, i + 80) + '\n  ny:     ' + b.slice(i - 80, i + 80)); }
}
function step() {
  now += Math.floor(rnd() * 60000);
  const r = rnd(); const newKey = rnd() < 0.15; const k = newKey ? `artist${Math.floor(rnd() * 1e6)}|titel${Math.floor(rnd() * 1e6)}` : pick(keys);
  if (newKey) keys.push(k);
  const a = 'A ' + k.split('|')[0], t = 'T ' + k.split('|')[1];
  const both = (f) => { f(o); f(n); };
  const same = (m, x) => { o[m](...x.map((v) => v)); n[m](...x.map((v) => (v && typeof v === 'object' ? clone(v) : v))); };   // samma varden till bada (ny far en kopia)
  if (r < 0.15) {            // resolveTempo: set (aven med undefined-falt, som ett Deezer-miss)
    const hit = rnd() < 0.5 ? { bpm: 100 + Math.floor(rnd() * 60), rawBpm: 128, genre: rnd() < 0.5 ? 'Pop' : undefined, source: 'deezer', matchArtist: a, matchTitle: t, score: 0.9 } : null;
    const e = { bpm: hit?.bpm || 0, rawBpm: hit?.rawBpm, genre: hit?.genre, source: hit?.source || 'ingen', matchArtist: hit?.matchArtist, matchTitle: hit?.matchTitle, score: hit?.score, at: Date.now(), artist: a, title: t };
    o.set(k, e); n.set(k, { ...e });   // spread behaller undefined-falten
  } else if (r < 0.3) {      // setMetaVerdictSaver
    const ratio = rnd() < 0.2 ? undefined : Math.round(rnd() * 200) / 100;
    const pv = { verdict: pick(['ok', 'avvisat', 'ok-fantom']), analyserBpm: 90 + Math.floor(rnd() * 60), ratio, verdictAt: Date.now() };
    o.update(k, pv); n.update(k, { ...pv });
  } else if (r < 0.5) {      // learn-saver (upsert med learn + ev. verdictEnd/hints)
    const l = { ...clone(pick(learns)), octave2x: rnd() < 0.4 ? 1 : 0 }; if (rnd() < 0.6) l.facitRatioEnd = pick([2, 1, 0.5, 1.98, 2.3]);
    const patch = { learn: l, learnAt: Date.now(), ...(rnd() < 0.5 ? { verdictEnd: pick(['ok', 'ok-oktav-2', 'avvisat']) } : {}), ...(rnd() < 0.2 ? { octaveHint: 2, hintCount: 1, tempoHint: { ratio: 2, anBpm: 64.5, count: 1 } } : {}) };
    same('upsert', [k, a, t, patch]);
  } else if (r < 0.6) {      // inspelaren markSection
    both((c) => c.update(k, { secAt: Date.now() }));
  } else if (r < 0.8) {      // PC-facit (tempo), aven utan candidates (undefined) och utan analys
    const bpm = 70 + rnd() * 120; const analysis = rnd() < 0.8 ? clone(pick(pcs)) : undefined; const cand = rnd() < 0.7 ? clone(pick(cands)) : undefined;
    const mk = () => ({ bpm: O.foldCatalogBpm(bpm), rawBpm: bpm, source: 'pc:beatthis', pcConf: Math.round(rnd() * 100) / 100, candidates: Array.isArray(cand) ? clone(cand).slice(0, 5) : undefined, at: Date.now(), artist: a, title: t, ...(analysis ? { pc: clone(analysis), pcAt: Date.now() } : {}) });
    const pm = mk(); o.upsert(k, a, t, pm); n.upsert(k, a, t, { ...pm });   // spread: candidates: undefined foljer med
  } else if (r < 0.85) {     // PC-facit utan tempo
    const analysis = rnd() < 0.5 ? clone(pick(pcs)) : undefined;
    const p0 = { bpm: 0, source: 'pc:ingen', at: Date.now(), artist: a, title: t, ...(analysis ? { pc: analysis, pcAt: Date.now() } : {}) }; o.upsert(k, a, t, p0); n.upsert(k, a, t, { ...p0 });
  } else {                   // dropdom: gammal = configServers list().find + upsert, ny = appendDropEvent
    const d = clone(pick(drops)); const ev = () => ({ at: Date.now(), id: k + '#d' + Math.floor(rnd() * 3), ...(d ?? {}), phase: d?.phase ?? null });
    const e1 = ev(); const e2 = clone(e1);
    const row = o.list().find((x) => x.key === k); const prev = Array.isArray(row?.dropEvents) ? row.dropEvents.slice(-19) : [];
    o.upsert(k, a, t, { dropEvents: [...prev, e1] });
    n.appendDropEvent(k, a, t, e2);
  }
}
// en post med manga dropEvents (20-taket) ska finnas
for (let i = 0; i < 25; i++) { now += 1000; const k = keys[3]; const ev = { at: Date.now(), id: k + '#d', gain: i }; const row = o.list().find((x) => x.key === k); const prev = Array.isArray(row?.dropEvents) ? row.dropEvents.slice(-19) : []; o.upsert(k, 'a', 't', { dropEvents: [...prev, ev] }); n.appendDropEvent(k, 'a', 't', { ...ev }); }
await compare('start + 25 dropdomar');
for (let ph = 1; ph <= Number(NPH); ph++) {
  for (let i = 0; i < Number(NOPS); i++) step();
  await compare(`fas ${ph} (${NOPS} ops)`);
  if (ph % 2 === 0) {   // omstart: gammal sparar synkront och laddar; ny laddar (bakar in journalen)
    o.flushSync(); o = new O.TempoCache(dir + '/o/tempo-cache.json'); o.load();
    await n.drain(); n = new N.TempoCache(dir + '/n/tempo-cache.json'); n.load();
    await compare(`  efter omstart ${ph / 2}`);
  }
}
// ogonblicksbilden ska vara exakt den gamla filen efter omstart (bakat-in format = gammalt format)
o.flushSync(); await n.drain(); const nn = new N.TempoCache(dir + '/n/tempo-cache.json'); nn.load();
const fo = fs.readFileSync(dir + '/o/tempo-cache.json', 'utf8'), fn = fs.readFileSync(dir + '/n/tempo-cache.json', 'utf8');
console.log(`tempo-cache.json efter sista omstart: ${fo === fn ? 'IDENTISK' : 'SKILJER'} (${fo.length} / ${fn.length} B), backup ${fs.existsSync(dir + '/n/tempo-cache.json.bak-tempominne') ? 'finns' : 'SAKNAS'}`);
if (fo !== fn) fails++;
// avbruten inbakning: (a) efter steg 2 (.tmp = full bild, journalen -> .baked), (b) efter steg 3 (bara .baked kvar)
n = nn;
for (const crash of ['a', 'b']) {
  for (let i = 0; i < 200; i++) step();
  o.flushSync(); await n.drain();
  const full = fs.readFileSync(dir + '/o/tempo-cache.json', 'utf8'), P = dir + '/n/tempo-cache.json', J = dir + '/n/tempo-cache.journal.jsonl';
  if (crash === 'a') { fs.writeFileSync(P + '.tmp', full); fs.renameSync(J, J + '.baked'); } else { fs.writeFileSync(P, full); fs.renameSync(J, J + '.baked'); }
  n = new N.TempoCache(P); n.load();
  await compare(`avbruten inbakning (${crash})`);
  if (fs.existsSync(J + '.baked')) { console.log('  .baked kvar!'); fails++; }
}
console.log(fails ? `FEL: ${fails}` : 'ALLT IDENTISKT');
process.exit(fails ? 1 : 0);
