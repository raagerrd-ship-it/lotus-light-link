/**
 * LÅSET — var i den lagrade inspelningen är vi, på riktigt?
 *
 * Sonos säger VILKEN låt. Det här säger VAR, och det är en helt annan fråga.
 *
 * ── Varför inte energikurvan ────────────────────────────────────────────────
 * Den metoden byggdes först: korskorrelera lagrad energi mot vad micen hör.
 * Den fungerar, men energin är en SLÄT kurva, så korrelationstoppen blir bred.
 * Uppmätt gav samma låt −950 ms en gång och −1270 ms nästa; spridningen mellan
 * mätningar var 100–300 ms. Det räcker inte: en drop som ligger 300 ms fel syns.
 *
 * ── Vad landmärken gör i stället ────────────────────────────────────────────
 * Ett landmärke är två spektraltoppar och avståndet mellan dem — en DISKRET
 * händelse, inte ett värde på en kurva. Samma ljud ger samma landmärke. Slår vi
 * upp varje landmärke micen hör bland dem som lagrades, och räknar hur långt
 * fram i inspelningen träffarna låg, hamnar de RÄTTA träffarna alla på samma
 * tidsskillnad medan slumpträffar sprids jämnt. Histogrammet får en spik.
 *
 * ── Och det viktigaste ──────────────────────────────────────────────────────
 * Landmärkena lagras i SAMMA tidslinje som showen renderas i. En träff säger
 * därför direkt "det du hör nu är showens tid X". Vad `recordedFromMs` råkade
 * vara spelar ingen roll — felet finns i båda leden och tar ut sig självt. Det
 * gör hela Sonos-positionen umbärlig för synken.
 */

/** Histogrammets upplösning. Landmärkestiderna är ändå kvantiserade till rutor. */
const BIN_MS = 100;
/** Så många röster krävs i vinnarfacket innan låset räknas som giltigt. */
const MIN_VOTES = 12;
/**
 * Hur mycket bättre vinnaren måste vara än bästa facket UTANFÖR sin närhet.
 *
 * Musik upprepar sig. Ett omkväde som återkommer ger äkta träffar på flera
 * ställen, och utan marginalkrav kunde låset landa en hel vers fel.
 */
const MARGIN = 1.6;
/** Fack inom detta avstånd från vinnaren räknas som samma topp. */
const NEAR_BINS = 3;
/** Röster äldre än så är inte längre relevanta — låten har gått vidare. */
const VOTE_TTL_MS = 20000;

export interface LockState {
  /** Skattad tid i den lagrade tidslinjen, ms. null = inte låst. */
  showMs: number | null;
  /** Antal röster bakom låset. */
  votes: number;
  /** Hur mycket vinnaren slog tvåan. Under MARGIN är låset inte att lita på. */
  margin: number;
  /** Ms sedan låset senast bekräftades. */
  ageMs: number;
}

export class SongLock {
  /** Sorterade hashar och deras tider i den lagrade tidslinjen. */
  private hash: Int32Array = new Int32Array(0);
  private time: Int32Array = new Int32Array(0);
  private durMs = 0;

  /** Röster: fack -> [antal, summa av exakta offset, senast sedd]. */
  private bins = new Map<number, [number, number, number]>();
  private offsetMs: number | null = null;
  private lastFixAt = 0;
  private votes = 0;
  private margin = 0;

  /** Ladda en låts landmärken. Tomt = inget lås möjligt. */
  load(hash: number[] | undefined, time: number[] | undefined, durMs: number): void {
    this.clear();
    if (!hash || !time || hash.length !== time.length || hash.length < 50) return;
    // Sortera på hash EN gång så uppslaget blir en binärsökning i stället för
    // en Map — en Map med tusentals nycklar per låt kostar mer minne än hela
    // låtminnet är värt, och pi-dmx mätte just det.
    const idx = hash.map((_, i) => i).sort((a, b) => hash[a] - hash[b] || time[a] - time[b]);
    this.hash = new Int32Array(idx.length);
    this.time = new Int32Array(idx.length);
    for (let i = 0; i < idx.length; i++) { this.hash[i] = hash[idx[i]]; this.time[i] = time[idx[i]]; }
    this.durMs = durMs;
  }

  clear(): void {
    this.hash = new Int32Array(0);
    this.time = new Int32Array(0);
    this.bins.clear();
    this.offsetMs = null;
    this.lastFixAt = 0;
    this.votes = 0;
    this.margin = 0;
  }

  get loaded(): boolean { return this.hash.length > 0; }

  /** Första index i `hash` med värdet h, eller -1. */
  private lowerBound(h: number): number {
    let lo = 0, hi = this.hash.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.hash[mid] < h) lo = mid + 1; else hi = mid;
    }
    return lo < this.hash.length && this.hash[lo] === h ? lo : -1;
  }

  /**
   * Ett landmärke micen just hörde. `liveMs` är ljudklockan — samma tidsbas som
   * användes när landmärkena lagrades, så skillnaden är meningsfull.
   */
  feed(h: number, liveMs: number): void {
    if (!this.hash.length) return;
    let i = this.lowerBound(h);
    if (i < 0) return;
    for (; i < this.hash.length && this.hash[i] === h; i++) {
      const off = this.time[i] - liveMs;
      const bin = Math.round(off / BIN_MS);
      const cur = this.bins.get(bin);
      if (cur) { cur[0]++; cur[1] += off; cur[2] = liveMs; }
      else this.bins.set(bin, [1, off, liveMs]);
    }
  }

  /**
   * Räkna ihop rösterna. Anropas glest (någon gång per sekund räcker) — det är
   * `feed` som är het.
   */
  resolve(liveMs: number): void {
    if (!this.bins.size) return;
    // Glöm gamla röster. Utan detta skulle låset dras mot där låten var för en
    // minut sedan i stället för var den är nu.
    for (const [k, v] of this.bins) if (liveMs - v[2] > VOTE_TTL_MS) this.bins.delete(k);

    let bestBin = 0, bestN = 0, bestSum = 0;
    for (const [k, v] of this.bins) if (v[0] > bestN) { bestN = v[0]; bestBin = k; bestSum = v[1]; }
    if (bestN < MIN_VOTES) { this.votes = bestN; return; }

    // Grannfack hör till samma topp — en spik som hamnar mellan två fack ska
    // inte straffas för det.
    let near = 0, nearSum = 0, rival = 0;
    for (const [k, v] of this.bins) {
      if (Math.abs(k - bestBin) <= NEAR_BINS) { near += v[0]; nearSum += v[1]; }
      else if (v[0] > rival) rival = v[0];
    }
    this.votes = near;
    this.margin = rival > 0 ? near / rival : Infinity;
    if (this.margin < MARGIN) return;

    const off = nearSum / near;
    // Glid, hoppa inte: ett hopp i ljuset syns, en glidning gör det inte.
    this.offsetMs = this.offsetMs == null ? off : this.offsetMs + (off - this.offsetMs) * 0.35;
    this.lastFixAt = liveMs;
  }

  /** Nollställ rösterna men behåll landmärkena — vid spolning eller omstart. */
  forgetVotes(): void {
    this.bins.clear();
    this.offsetMs = null;
    this.votes = 0;
    this.margin = 0;
  }

  state(liveMs: number): LockState {
    const locked = this.offsetMs != null;
    const showMs = locked ? liveMs + (this.offsetMs as number) : null;
    return {
      showMs: showMs != null && showMs >= 0 && (this.durMs <= 0 || showMs <= this.durMs + 5000) ? showMs : null,
      votes: this.votes,
      margin: this.margin === Infinity ? 99 : Math.round(this.margin * 10) / 10,
      ageMs: locked ? liveMs - this.lastFixAt : Infinity,
    };
  }
}
