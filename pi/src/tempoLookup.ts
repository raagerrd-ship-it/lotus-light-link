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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { songKey } from './songStore.js';

export interface TempoHit { bpm: number; rawBpm: number; source: string; matchArtist: string; matchTitle: string; id: number; score: number }
export interface TempoCacheEntry {
  bpm: number; rawBpm?: number; source: string; matchArtist?: string; matchTitle?: string; score?: number;
  at: number; artist: string; title: string;
  /** Motorns dom nar analysatorn fatt ett sakert varde: ok / ok-fantom / avvisat. */
  analyserBpm?: number; ratio?: number; verdict?: string; verdictAt?: number;
}
const NEG_TTL_MS = 7 * 24 * 3600e3;

export class TempoCache {
  private map: Record<string, TempoCacheEntry> = {};
  constructor(private path: string) {}
  load(): void { try { this.map = JSON.parse(readFileSync(this.path, 'utf8')) || {}; } catch { this.map = {}; } }
  get size(): number { return Object.keys(this.map).length; }
  get(key: string): TempoCacheEntry | null {
    const e = this.map[key]; if (!e) return null;
    if (e.bpm <= 0 && Date.now() - e.at > NEG_TTL_MS) return null;      // negativt svar har gatt ut
    return e;
  }
  set(key: string, e: TempoCacheEntry): void { this.map[key] = e; this.save(); }
  update(key: string, patch: Partial<TempoCacheEntry>): void { const e = this.map[key]; if (!e) return; Object.assign(e, patch); this.save(); }
  list(): Array<TempoCacheEntry & { key: string }> { return Object.entries(this.map).map(([key, e]) => ({ key, ...e })); }
  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp'; writeFileSync(tmp, JSON.stringify(this.map, null, 1)); renameSync(tmp, this.path);
    } catch { /* cachen far aldrig falla motorn */ }
  }
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
      return { id: r.id as number, t: (r.title || '') as string, a: (r.artist?.name || '') as string, st, sa, score: st * 0.6 + sa * 0.4 };
    }).filter((c) => c.st >= (artist ? 0.6 : 0.9) && c.sa >= 0.6).sort((x, y) => y.score - x.score).slice(0, 4);
    for (const c of cands) {
      const t = await getJson(`https://api.deezer.com/track/${c.id}`, timeoutMs);
      const bpm = Number(t?.bpm) || 0;
      if (bpm > 40 && bpm < 300) return { bpm: foldCatalogBpm(bpm), rawBpm: bpm, source: artist ? 'deezer' : 'deezer-titel', matchArtist: c.a, matchTitle: c.t, id: c.id, score: c.score };
    }
  }
  return null;
}

/** Cache forst, natet sedan. null = inget tempo finns (cachas); natfel cachas inte. */
export async function resolveTempo(cache: TempoCache, artist: string | null, title: string): Promise<{ hit: TempoHit | null; cached: boolean }> {
  const key = songKey(artist || '', title);
  const c = cache.get(key);
  if (c) return { hit: c.bpm > 0 ? { bpm: c.bpm, rawBpm: c.rawBpm ?? c.bpm, source: c.source, matchArtist: c.matchArtist || '', matchTitle: c.matchTitle || '', id: 0, score: c.score || 0 } : null, cached: true };
  let hit: TempoHit | null;
  try { hit = await lookupDeezer(artist, title); } catch { return { hit: null, cached: false }; }
  cache.set(key, { bpm: hit?.bpm || 0, rawBpm: hit?.rawBpm, source: hit?.source || 'ingen', matchArtist: hit?.matchArtist, matchTitle: hit?.matchTitle, score: hit?.score, at: Date.now(), artist: artist || '', title });
  return { hit, cached: false };
}
