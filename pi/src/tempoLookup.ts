/**
 * KATALOGTEMPO (2026-09-18). Sonos ger artist + titel; en oppen katalog (Deezers publika
 * API, ingen nyckel, ~0,8 s fran Pi:n) ger latens publicerade BPM. Analysatorns tempofonster
 * ar [80,160) — exakt en oktav — sa en 172-lat rapporteras alltid som 86: "Ego" (Indila,
 * 172,3 i katalogen) pulsade i halv fart. Katalogen har ingen vikning.
 *
 * Motorn (piEngine.setMetaTempo / updateBeatClock) accepterar bara ett katalogtempo som
 * stammer med analysatorn (kvot 1/2, 1, 2 — eller 2/3, 3/2 for analysatorns kanda fantomer —
 * inom +-5 %), sa en felmatchad lat kan aldrig styra ljuset. Cache per lat (aven "inget
 * tempo", 7 dagar; natfel cachas INTE) sa natet fragas en gang per lat.
 */
import { isDebugEnabled } from './debugLog.js';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, statSync, unlinkSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { songKey } from './songStore.js';

export interface TempoHit { bpm: number; rawBpm: number; source: string; matchArtist: string; matchTitle: string; id: number; score: number; genre?: string }
export interface TempoCacheEntry {
  bpm: number; rawBpm?: number; source: string; matchArtist?: string; matchTitle?: string; score?: number; genre?: string;
  at: number; artist: string; title: string;
  /** Motorns dom nar analysatorn fatt ett sakert varde: ok / ok-fantom / avvisat. */
  analyserBpm?: number; ratio?: number; verdict?: string; verdictAt?: number;
  /** Motorns inlarningsrad for laten (piEngine.learnSummary): analysatorns bpm-statistik + kick-ringens intervall. */
  learn?: Record<string, number>; learnAt?: number;
  /** Dom vid latslut: facit mot hela latens median-bpm (ok / ok-oktav-0.5|2 / ok-fantom-x / avvisat). */
  verdictEnd?: string;
  /** AUTOMATISKT LARD: oktavledtrad (2 / 0.5 / 1) ur verdictEnd, och hur manga spelningar som gett samma klass. */
  octaveHint?: number; hintCount?: number;
  /** TEMPOLEDTRAD (09-19): facit/analysator-klass vid forra spelningen (1, 2, 0.5, 1.5, 0.667, 1.333, 0.75) + analysatorns
   *  median da. Nasta spelning: grid = analysatorns varde x ratio, bara om analysatorn ligger inom +-8 % av anBpm. */
  tempoHint?: { ratio: number; anBpm: number; count: number };
}
const NEG_TTL_MS = 7 * 24 * 3600e3;

/** TEMPO-MINNET (2026-09-30). Cachen holl ~5 MB levande heap (~30 % av huvudtradens levande data) och varje sparning var en
 *  synkron JSON.stringify av ~1,5 MB mitt i musiken. Nu:
 *   - I MINNET bara karnfalten (det motorn laser vid latbyte); de tunga falten (HEAVY) ligger bara pa disk. Av dem behover
 *     motorn bara "har pc" (inspelaren) och tva tal ur learn (oktavstatistiken): egna sma tabeller.
 *   - PA DISK: tempo-cache.json = ogonblicksbild i EXAKT det gamla formatet + tempo-cache.journal.jsonl = en rad per andring
 *     (samma operationer som forr: set/upsert/update + dropdomen). Sparning = en asynkron append av en rad, aldrig hela filen.
 *   - Journalen bakas in i ogonblicksbilden BARA vid load (boot/omstart, fore musiken; Pi:n rebootar 05:00) - precis dar den
 *     gamla koden laste om sin JSON. En inbakning under drift skulle tappa platsen for undefined-falt som det gamla minnet
 *     behaller till nasta omstart (nyckelordningen i API-svaret skulle skilja). Journalen vaxer ~0,5 KB/lat. Inbakningen
 *     ar kraschsaker: (1) full bild -> .tmp, (2) journalen -> .baked, (3) .tmp -> tempo-cache.json, (4) .baked bort.
 *     Finns .baked vid load har (1)-(2) hunnit ske: .tmp (om kvar) ar den fulla bilden och journalen ar redan i den.
 *   - /api/tempo/cache (listFull) spelar upp ogonblicksbild + journal fran disk -> samma innehall och nyckelordning som forr.
 *  Aterstallning till gammal kod: kor load() en gang med den nya koden (journalen bakas in i tempo-cache.json), sedan byt dist. */
const HEAVY = new Set(['pc', 'candidates', 'dropEvents', 'learn']);
type Op = { o: 'set'; k: string; e: any } | { o: 'up'; k: string; a: string; t: string; p: any } | { o: 'upd'; k: string; p: any } | { o: 'drop'; k: string; a: string; t: string; ev: any };
/** undefined pa toppniva (t.ex. rawBpm: undefined fran resolveTempo) behaller sin plats i det gamla minnesobjektet och avgor
 *  nyckelordningen om faltet satts senare -> journalen bar en markor och uppspelningen satter tillbaka undefined pa platsen. */
const UNDEF = '\u0000undefined';
function encodeOp(op: Op): string {
  const top = op.o === 'set' ? op.e : op.o === 'drop' ? null : op.p;
  return JSON.stringify(op, function (this: unknown, _k: string, v: unknown) { return v === undefined && this === top ? UNDEF : v; });
}
function decodeOp(line: string): Op | null {
  let op: any; try { op = JSON.parse(line); } catch { return null; }   // avbruten sista rad (stromavbrott) hoppas over
  const top = op?.o === 'set' ? op.e : op?.p;
  if (top && typeof top === 'object') for (const f in top) if (top[f] === UNDEF) top[f] = undefined;
  return op;
}
/** Exakt den gamla minnessemantiken (set/upsert/update + configServers dropdom), pa den FULLA kartan. */
function applyOp(map: Record<string, any>, op: Op): void {
  if (op.o === 'set') { const old = map[op.k]; map[op.k] = old?.learn ? { ...op.e, learn: old.learn, learnAt: old.learnAt } : op.e; return; }
  if (op.o === 'upd') { const e = map[op.k]; if (e) Object.assign(e, op.p); return; }
  const e = map[op.k] ?? (map[op.k] = { bpm: 0, source: 'ej-uppslagen', at: 0, artist: op.a, title: op.t });
  if (op.o === 'up') { Object.assign(e, op.p); return; }
  Object.assign(e, { dropEvents: [...(Array.isArray(e.dropEvents) ? e.dropEvents.slice(-19) : []), op.ev] });
}

export class TempoCache {
  /** Karnfalten per lat (inga HEAVY-falt). */
  private map: Record<string, TempoCacheEntry> = {};
  private pcKeys = new Set<string>();
  /** learn.octave2x / learn.facitRatioEnd per lat som har en inlarningsrad (oktavstatistiken i index.ts). */
  private learnLite = new Map<string, { o: unknown; f: unknown }>();
  private jpath: string;
  private q: Promise<unknown> = Promise.resolve();
  /** Journalens storlek (byte) som bakades in vid senaste load - bootloggen. */
  bakedBytes = 0;
  constructor(private path: string) { this.jpath = path.replace(/\.json$/, '') + '.journal.jsonl'; }

  /** Ogonblicksbild + journal -> full karta (samma som det gamla minnet). */
  private static replay(snap: string | null, journal: string | null): Record<string, any> {
    let map: Record<string, any> = {};
    try { map = (snap ? JSON.parse(snap) : {}) || {}; } catch { map = {}; }
    if (journal) for (const line of journal.split('\n')) { if (!line) continue; const op = decodeOp(line); if (op) applyOp(map, op); }
    return map;
  }
  load(): void {
    const rd = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
    try { if (existsSync(this.jpath + '.baked')) { if (existsSync(this.path + '.tmp')) renameSync(this.path + '.tmp', this.path); unlinkSync(this.jpath + '.baked'); } } catch { /* avbruten inbakning, se ovan */ }
    const snap = rd(this.path), journal = rd(this.jpath);
    // Engangsbackup av originalfilen (fore forsta journalen).
    try { const bak = this.path + '.bak-tempominne'; if (snap !== null && !existsSync(bak)) copyFileSync(this.path, bak); } catch { /* bara backup */ }
    const full = TempoCache.replay(snap, journal);
    this.bakedBytes = journal?.length ?? 0;
    if (journal) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        const tmp = this.path + '.tmp', baked = this.jpath + '.baked';
        writeFileSync(tmp, JSON.stringify(full)); renameSync(this.jpath, baked); renameSync(tmp, this.path); unlinkSync(baked);
      } catch { /* nasta load forsoker igen; journalen ar kvar */ }
    }
    this.map = {}; this.pcKeys.clear(); this.learnLite.clear();
    for (const k of Object.keys(full)) { this.map[k] = this.core(full[k], true); this.noteHeavy(k, full[k], true); }
  }
  /** Utan HEAVY-falten. fromDisk: som en JSON-omlasning (gamla load) - undefined-falt fran journalen foljer inte med. */
  private core(src: any, fromDisk = false): any { const c: any = {}; for (const f in src) if (!HEAVY.has(f) && !(fromDisk && src[f] === undefined)) c[f] = src[f]; return c; }
  private noteHeavy(k: string, src: any, withLearn: boolean): void {
    if ('pc' in src) { if (src.pc) this.pcKeys.add(k); else this.pcKeys.delete(k); }
    if (withLearn && 'learn' in src) { if (src.learn) this.learnLite.set(k, { o: src.learn.octave2x, f: src.learn.facitRatioEnd }); else this.learnLite.delete(k); }
  }
  /** En rad till journalen, i ordning, asynkront. Fel far aldrig falla motorn. */
  private log(op: Op): void {
    let line: string; try { line = encodeOp(op) + '\n'; } catch { return; }
    this.q = this.q.then(() => appendFile(this.jpath, line)).catch(() => { /* cachen far aldrig falla motorn */ });
  }
  get size(): number { return Object.keys(this.map).length; }
  get(key: string): TempoCacheEntry | null {
    const e = this.map[key]; if (!e) return null;
    if (e.source === 'ej-uppslagen') return null;                       // bara inlarningsrad, ingen uppslagning gjord
    if (e.bpm <= 0 && Date.now() - e.at > NEG_TTL_MS) return null;      // negativt svar har gatt ut
    return e;
  }
  /** Har laten en PC-analys (`pc`)? (inspelaren: fanga inte tempo igen) */
  hasPc(key: string): boolean { return this.pcKeys.has(key); }
  set(key: string, e: TempoCacheEntry): void {
    this.log({ o: 'set', k: key, e });
    const keepLearn = this.learnLite.has(key);                          // inlarningsraden overlever nytt uppslag
    const c = this.core(e); if (keepLearn) c.learnAt = this.map[key]?.learnAt;
    this.map[key] = c; this.pcKeys.delete(key);
    if (!keepLearn) this.learnLite.delete(key);
    this.noteHeavy(key, e, !keepLearn);
  }
  /** Inlarningsrad aven for latar som aldrig slogs upp (natfel) - skapar en tom post utan att blockera uppslag. */
  upsert(key: string, artist: string, title: string, patch: Partial<TempoCacheEntry> & Record<string, unknown>): void {
    this.log({ o: 'up', k: key, a: artist, t: title, p: patch });
    const e = this.map[key] ?? (this.map[key] = { bpm: 0, source: 'ej-uppslagen', at: 0, artist, title });
    Object.assign(e, this.core(patch)); this.noteHeavy(key, patch, true);
  }
  update(key: string, patch: Partial<TempoCacheEntry> & Record<string, unknown>): void {
    const e = this.map[key]; if (!e) return;
    this.log({ o: 'upd', k: key, p: patch });
    Object.assign(e, this.core(patch)); this.noteHeavy(key, patch, true);
  }
  /** PC:ns dropdom: laggs till latens dropEvents (de 20 senaste) utan att listan finns i minnet. */
  appendDropEvent(key: string, artist: string, title: string, ev: Record<string, unknown>): void {
    this.log({ o: 'drop', k: key, a: artist, t: title, ev });
    if (!this.map[key]) this.map[key] = { bpm: 0, source: 'ej-uppslagen', at: 0, artist, title };
  }
  /** Oktavregelns traffsakerhet: latar med facit (bpm>0) dar regeln presenterade 2x och facitkvoten finns. */
  octaveStat(): { hit: number; n: number } {
    let hit = 0, n = 0;
    for (const [k, l] of this.learnLite) {
      if (!((this.map[k]?.bpm ?? 0) > 0) || !(((l.o as number) ?? 0) > 0.5) || typeof l.f !== 'number') continue;
      n++; if (Math.abs(l.f / 2 - 1) < 0.05) hit++;
    }
    return { hit, n };
  }
  /** Hela cachen i det gamla list()-formatet (/api/tempo/cache): ogonblicksbild + journal fran disk, efter alla koade skrivningar. */
  listFull(): Promise<Array<TempoCacheEntry & { key: string }>> {
    const p = this.q.then(async () => {
      const rd = async (f: string) => { try { return await readFile(f, 'utf8'); } catch { return null; } };
      const snap = await rd(this.path), journal = await rd(this.jpath);
      return Object.entries(TempoCache.replay(snap, journal)).map(([key, e]) => ({ key, ...e }));
    });
    this.q = p.catch(() => { /* kon far aldrig fastna */ });
    return p;
  }
  /** Vanta tills alla koade journalrader ar skrivna (tester). */
  drain(): Promise<void> { return this.q.then(() => undefined, () => undefined); }
  /** Journalens storlek i byte (diagnostik). */
  journalBytes(): number { try { return statSync(this.jpath).size; } catch { return 0; } }
}

/** Titel/artist utan versaler, diakriter, "(Radio Edit)", "- Remastered", "feat. ..." och skiljetecken. */
function norm(s: string): string {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([][^)\]]*(remix|edit|version|remaster|live|feat|mix|sped up|slowed)[^)\]]*[)\]]/gi, '')
    .replace(/\s*-\s*(radio edit|remaster(ed)?( \d{4})?|single version|live|sped up).*$/i, '')
    .replace(/\bfeat\.?.*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function bigrams(s: string): Set<string> {
  const t = ' ' + s + ' '; const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
/** Dice-koefficient pa bigram, 0..1. "NÄR RÄVEN RASKAR" ~ "När räven raskar (Sped Up)" = 1. */
export function similarity(a: string, b: string): number {
  const A = bigrams(norm(a)), B = bigrams(norm(b)); if (!A.size || !B.size) return 0;
  let n = 0; for (const g of A) if (B.has(g)) n++;
  return (2 * n) / (A.size + B.size);
}

/** Katalogens oktav ar inte alltid den kanda: Deezer ger "Dancing Queen" 200,7 (kanns ~100) men "Ego" 172
 *  (kanns 172 - lampan i 86 var for langsam). Utanfor [70, 180] viks en oktav; innanfor litar vi pa katalogen.
 *  Ravardet foljer med i cachen sa regeln kan omprovas mot lardatan. */
export function foldCatalogBpm(bpm: number): number {
  let b = bpm;
  while (b > 180) b /= 2;
  while (b > 0 && b < 70) b *= 2;
  return b;
}

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Deezer: sok, ranka pa titel+artist-likhet, hamta bpm for de basta tills en har bpm>0. */
export async function lookupDeezer(artist: string | null, title: string, timeoutMs = 8000): Promise<TempoHit | null> {
  const strict = artist ? `artist:"${artist}" track:"${title}"` : title;
  const tries = artist ? [strict, `${artist} ${title}`] : [strict];
  for (const query of tries) {
    const d = await getJson('https://api.deezer.com/search?limit=10&q=' + encodeURIComponent(query), timeoutMs);
    const cands = ((d?.data || []) as any[]).map((r) => {
      const st = similarity(title, r.title || '');
      const sa = artist ? similarity(artist, r.artist?.name || '') : 1;
      return { id: r.id as number, t: (r.title || '') as string, a: (r.artist?.name || '') as string, albumId: (r.album?.id ?? 0) as number, st, sa, score: st * 0.6 + sa * 0.4 };
    }).filter((c) => c.st >= (artist ? 0.6 : 0.9) && c.sa >= 0.6).sort((x, y) => y.score - x.score).slice(0, 4);
    for (const c of cands) {
      const t = await getJson(`https://api.deezer.com/track/${c.id}`, timeoutMs);
      const bpm = Number(t?.bpm) || 0;
      if (bpm > 40 && bpm < 300) {
        // Genre (album -> genres): lardata for att se VILKEN musik analysatorn faller pa. Bast-effort.
        let genre: string | undefined;
        try { const al = c.albumId ? await getJson(`https://api.deezer.com/album/${c.albumId}`, timeoutMs) : null; genre = (al?.genres?.data || []).map((g: any) => g.name).join(', ') || undefined; } catch { /* genre ar bonus */ }
        return { bpm: foldCatalogBpm(bpm), rawBpm: bpm, source: artist ? 'deezer' : 'deezer-titel', matchArtist: c.a, matchTitle: c.t, id: c.id, score: c.score, genre };
      }
    }
  }
  return null;
}

/** Cache forst, natet sedan. null = inget tempo finns (cachas); natfel cachas inte. */
export async function resolveTempo(cache: TempoCache, artist: string | null, title: string): Promise<{ hit: TempoHit | null; cached: boolean }> {
  const key = songKey(artist || '', title);
  const c = cache.get(key);
  if (c) return { hit: c.bpm > 0 ? { bpm: c.bpm, rawBpm: c.rawBpm ?? c.bpm, source: c.source, matchArtist: c.matchArtist || '', matchTitle: c.matchTitle || '', id: 0, score: c.score || 0 } : null, cached: true };
  // KATALOGEN BARA VID FELSOKNING (2026-10-04, agaren: realtid utan moln): katalogtempot ar facit/statistik (styr inte ljuset,
  // useMetaTempo av), och en ny HTTPS-anslutning pa huvudtraden kostade 120-145 ms vid varje okant latbyte (cpuprofile 16:48:
  // isIPv6 ~53 ms + DNS-resolver + TLS-kontext). Cachen anvands som forut; ingen post skrivs, sa laten slas upp nasta gang felsokning ar pa.
  if (!isDebugEnabled()) return { hit: null, cached: false };
  let hit: TempoHit | null;
  try { hit = await lookupDeezer(artist, title); } catch { return { hit: null, cached: false }; }
  cache.set(key, { bpm: hit?.bpm || 0, rawBpm: hit?.rawBpm, genre: hit?.genre, source: hit?.source || 'ingen', matchArtist: hit?.matchArtist, matchTitle: hit?.matchTitle, score: hit?.score, at: Date.now(), artist: artist || '', title });
  return { hit, cached: false };
}
