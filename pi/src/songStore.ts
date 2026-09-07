/**
 * LÅTMINNE — vad vi VET om en låt, i stället för vad vi gissar oss till i realtid.
 *
 * Sonos ger artist och titel vid varje låtbyte. Det gör identiteten GRATIS, och
 * därmed försvinner hela fingeravtryckslagret som systerprojektet pi-dmx behöver
 * (landmärkeshashar, röstning i offset-fack, biblioteksberoende beviskrav).
 * Här räcker en uppslagstabell.
 *
 * VARFÖR DET HÄR ÄR VÄRT NÅGOT: realtidsanalysen är kausal — den ser inte framåt
 * och måste bestämma sig innan låten är slut. En analys i efterhand ser hela låten.
 * UPPMÄTT 2026-09-01 mot publicerat, Spotify-oberoende facit:
 *
 *   låt                        facit   realtidsanalys   efterhandsanalys
 *   LINEDANCE                  145     96   FEL         146,3  RÄTT
 *   I'm In a Hurry             129     86   FEL         129,0  RÄTT
 *   Feel Like Hell Today        76     153 (vikt)       75,9   RÄTT
 *
 * ARBETSFÖRDELNING (mätt 2026-09-01, avgör hur minnet får användas):
 *
 *   låtminnet      exakt tempo, ingen oktavvikning   -> VAD lampan pulsar i
 *   Sonos-position kvantiserad till HELA SEKUNDER    -> vilken SEKTION vi är i
 *   mikrofonen     fas, uppmätt −8 ms                -> NÄR slaget infaller
 *
 * Sonos rapporterar bara jämna tusental (uppmätt: 80000, 80000, 81000, 81000,
 * 82000 … och ibland +2000 när en uppdatering missas). Bästa möjliga fel är
 * alltså ±500 ms — ett helt slag i 120 BPM. Positionen duger till sektioner och
 * drops, ALDRIG till fassynk. Fasen måste komma från micen.
 *
 * Det är rätt uppdelning: micen är bra på FAS men dålig på TEMPO, och det är
 * exakt tempot minnet tar över.
 *
 * Sista raden i tabellen ovan är den viktigaste: analysatorns vikningsfönster är [80,160) och kan
 * inte uttrycka 76 — den MÅSTE svara 152. Ett lagrat värde har ingen sådan gräns,
 * så en långsam låt kan äntligen pulsa i sitt eget tempo i stället för dubbelt.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Sektion med FUNKTION, inte bara en tidpunkt — dirigenten ska veta VAD som börjar. */
export interface SongPart {
  /** ms från låtens början */
  t: number;
  /** intro | verse | chorus | bridge | break | outro | inst | solo */
  label: string;
}

export interface SongEntry {
  artist: string;
  title: string;
  /** Musikaliskt tempo. INTE vikt till [80,160) — det är hela poängen. */
  bpm: number;
  /** Var värdet kommer ifrån: 'allin1' (ljudmodell), 'katalog' (publicerat), 'motor' (realtid). */
  bpmSource: string;
  /**
   * ms för VARJE slag. Det här är den viktigaste raden i filen.
   *
   * Realtidsanalysen måste PREDIKTERA var nästa slag hamnar — den är kausal och
   * ser inte framåt. Hela apparaten (tempogram, comb-filter, oktavvikning,
   * commit-grindar, harmoni-veton) finns bara för den gissningen.
   *
   * En slaglista gissar ingenting. Slagen ligger där. Och en LISTA HAR INGEN
   * OKTAV — därmed försvinner vikningsproblemet helt: en låt i 76 BPM behöver
   * inte längre rapporteras som 152 bara för att fönstret är [80,160).
   *
   * Kostnad: ~480 tal för en fyraminuterslåt i 120 BPM, alltså några kB JSON.
   */
  beats?: number[];
  /** ms för varje taktetta. Ger frasgrid utan gissning. */
  downbeats?: number[];
  /** 1..4 — var i takten varje slag i `beats` ligger. Samma längd som `beats`. */
  beatPositions?: number[];
  /**
   * DROPS: ms + styrka 0..1. Strukturmodellen ger takt och sektioner men INTE
   * drops — de räknas ur ljudets egen energikurva och snäpps till modellens
   * taktettor, så en drop alltid landar på ett nedslag och aldrig mellan två.
   *
   * Poängen med att ha dem lagrade: i realtid kan en drop bara upptäckas EFTER
   * att den hänt, och då är lampan redan sen. Med en tidslinje kan den fyras
   * strax FÖRE (systerprojektet pi-dmx använder 120 ms).
   */
  drops?: Array<{ t: number; s: number }>;
  /**
   * Energikurvan, RMS per 100 ms normaliserad till 0-255. ~7 kB för tre minuter.
   *
   * Lagras för att drops ska kunna räknas OM i efterhand när detektorn
   * förbättras — utan att låten behöver spelas in på nytt. Ljudet raderas
   * direkt efter analys, så utan den här kurvan är varje justering av
   * dropströsklarna beroende av att samma låt råkar spelas igen.
   */
  energy?: number[];
  parts?: SongPart[];
  /**
   * Hur många sekunder ljud analysen såg. AVGÖRANDE för hur `parts` får tolkas:
   * ett 40-sekundersklipp ÄR introt, och modellen svarar då helt riktigt
   * "intro/intro" (UPPMÄTT). Sektioner kräver hela låten; tempo gör det inte.
   */
  analysedSeconds: number;
  /**
   * Låtposition (ms) där inspelningen började. Alla tider ovan är förskjutna
   * med detta, alltså relativa till LÅTENS början — inte inspelningens.
   * Insamlaren startar några sekunder in eftersom låtbytet upptäcks med
   * fördröjning; utan korrigeringen hamnar varje sektion och drop för tidigt.
   */
  recordedFromMs?: number;
  /**
   * UPPMATT tidsforskjutning mellan lagrad tidslinje och verkligheten, ms.
   *
   * VARFOR DEN BEHOVS: allt lagrat (slag, delar, drops, energi) ligger i latens
   * tidslinje via `recordedFromMs` -- men det vardet kommer fran ETT grovt
   * Sonos-varde vid inspelningsstart, kvantiserat till hela sekunder och taget
   * genom en gateway med egen fordrojning. Hela tidslinjen arver darfor ett
   * okant fel, olika for varje inspelning. Uppmatt: -80, -400, -1260 och
   * -1700 ms pa fyra latar.
   *
   * Felet gar inte att rakna bort, men det gar att MATA: motorn korskorrelerar
   * energikurvan mot vad micen faktiskt hor och sparar svaret har. Nasta gang
   * laten spelas ar den redan ratt.
   */
  syncOffsetMs?: number;
  /**
   * AKUSTISKA LANDMARKEN — tva parallella listor: hash och tid.
   *
   * Tiderna ligger i SAMMA tidslinje som showen renderas i (inspelningstid plus
   * `recordedFromMs`, precis som slag, delar och drops). Det ar hela poangen: en
   * traff sager da direkt "det du hor nu ar showens tid X", utan omvag over
   * Sonos-positionen och utan att inspelningsoffsetens fel spelar nagon roll.
   *
   * Tva listor och inte en lista med par: typade arrayer gar att binarsoka i
   * utan att skapa tusentals objekt per lat.
   */
  /**
   * Energikurvans steg i ms. Saknas den ar kurvan gammal och lag i 100 ms-steg.
   *
   * Nyare inspelningar lagras i SHOW_STEP_MS — en energipunkt per showsteg — sa
   * uppspelningen blir en atergivning i stallet for en interpolation. Den gamla
   * upplosningen smetade ut varje trumslags attack: uppmatt borjade ljuset stiga
   * 120 ms fore slaget.
   */
  energyStepMs?: number;
  lmHash?: number[];
  lmTime?: number[];
  /** ISO-datum, så gamla poster går att spåra när metoden ändras. */
  analysedAt: string;
}

export interface SongStoreFile {
  v: number;
  songs: Record<string, SongEntry>;
}

const V = 1;

/** Nyckeln. Normaliserad så små stavningsskillnader från Sonos inte ger dubbletter. */
export function songKey(artist: string, title: string): string {
  const n = (s: string) => (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // diakriter bort: "för" och "for" samma
    .replace(/\s*[-–—]\s*(radio edit|remaster(ed)?( \d{4})?|single version|live)\b.*$/i, '')
    .replace(/\s*\((radio edit|remaster(ed)?( \d{4})?|single version)\)\s*$/i, '')
    .replace(/[^a-z0-9]+/g, '');
  return n(artist) + '|' + n(title);
}

export class SongStore {
  private songs = new Map<string, SongEntry>();
  private dirty = false;

  constructor(private path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const f = JSON.parse(raw) as SongStoreFile;
      if (f?.v !== V || !f.songs) return;
      for (const [k, e] of Object.entries(f.songs)) if (e?.bpm > 0) this.songs.set(k, e);
    } catch {
      // Saknad fil är normaltillståndet vid första start, inte ett fel.
    }
  }

  get size(): number { return this.songs.size; }

  lookup(artist: string, title: string): SongEntry | null {
    return this.songs.get(songKey(artist, title)) ?? null;
  }

  /** Alla lagrade låtar, nyaste först — för listan i UI:t. */
  list(): Array<SongEntry & { key: string }> {
    return [...this.songs.entries()]
      .map(([key, e]) => ({ key, ...e }))
      .sort((a, b) => (b.analysedAt || '').localeCompare(a.analysedAt || '')
                   || a.artist.localeCompare(b.artist));
  }

  /**
   * Glöm en låt. Nästa uppspelning faller tillbaka på realtidsanalysen, och
   * låten kan analyseras om nästa gång den spelas in.
   *
   * VARFÖR DET MÅSTE GÅ: analysen kan slå fel på en enskild inspelning — ett
   * kort klipp, en tyst intro, en låt utan stabil puls. Ett dåligt värde i
   * minnet är VÄRRE än inget värde, eftersom det används med hög konfidens och
   * därför inte rättas av realtidsanalysen. Ägaren måste kunna slänga det.
   */
  forget(key: string): boolean {
    const had = this.songs.delete(key);
    if (had) this.dirty = true;
    return had;
  }

  /** Spara en uppmatt synkkorrigering. EMA sa en enstaka dalig matning inte styr. */
  async setSyncOffset(artist: string, title: string, ms: number): Promise<void> {
    // LASER OM FORST, med flit. Tva processer skriver den har filen: motorn
    // (den har vagen) och refinern (nya analyser). Bada haller en egen kopia i
    // minnet och skriver ut HELA filen, sa den som sparar sist raderar det den
    // andra hann lagga till. Motorn laser dessutom bara om vid latbyte, sa dess
    // kopia kan vara flera minuter gammal nar den skriver.
    //
    // Att lasa om precis fore andringen kryper fonstret till nastan noll. Ingen
    // riktig las — men skrivningarna ar sallsynta (en per lat och uppspelning)
    // och en missad korrigering mats bara om nasta gang laten spelas.
    try { await this.load(); } catch { /* hellre skriva pa gammal kopia an inte alls */ }
    const e = this.lookup(artist, title);
    if (!e) return;
    const prev = e.syncOffsetMs;
    e.syncOffsetMs = prev == null ? ms : Math.round(prev + (ms - prev) * 0.5);
    // save() avbryter tyst om `dirty` inte ar satt — utan den har raden matte
    // motorn sitt synkfel varje uppspelning utan att nagot nadde filen.
    this.dirty = true;
    await this.save();
  }

  put(e: SongEntry): void {
    this.songs.set(songKey(e.artist, e.title), e);
    this.dirty = true;
  }

  /** Atomisk skrivning: minnet får aldrig bli halvskrivet om strömmen går. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const f: SongStoreFile = { v: V, songs: Object.fromEntries(this.songs) };
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    const tmp = this.path + '.tmp';
    await writeFile(tmp, JSON.stringify(f, null, 1), 'utf8');
    await rename(tmp, this.path);
    this.dirty = false;
  }
}
