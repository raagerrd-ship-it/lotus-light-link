/**
 * LÅTKLOCKA — var i låten är vi, just nu, på millisekunden?
 *
 * Ingen enskild källa kan svara. Tre lager, där varje lager rättar det
 * föregående lagrets svaghet:
 *
 *   lokal klocka   jämn och kontinuerlig   men DRIVER
 *   Sonos-flank    absolut och driftfri    men GROV och hoppig
 *   micens slag    millisekunder           men vet inte VILKET slag
 *
 * ── Varför flanken och inte värdet ────────────────────────────────────────
 * UPPMÄTT 2026-09-01: Sonos rapporterar `positionMillis` i HELA SEKUNDER
 * (80000, 80000, 81000, 81000, …). UPnP ger `RelTime` som HH:MM:SS, så finare
 * värden finns inte att hämta. Värdet självt är alltså ±500 ms — ett helt slag
 * i 120 BPM.
 *
 * MEN ÖVERGÅNGEN är skarp. Ser vi 81000 bli 82000 vet vi att låten passerade
 * exakt 82,000 s i det ögonblicket. Osäkerheten blir då halva samplingsintervallet,
 * inte halva sekunden. Vid 10 Hz pollning: ±50 ms.
 *
 * (Uppmätt på nuvarande gateway: den frågar Sonos var ~2:a sekund och missar
 * därför varannan flank — steg om 2000 ms. Klockan fungerar ändå, men blir
 * klart bättre när gatewayen pollar tätare.)
 *
 * ── Varför drift måste mätas, inte antas ──────────────────────────────────
 * Mellan flankarna interpoleras med den lokala klockan. Går den fortare eller
 * långsammare än Sonos uppspelning ackumuleras felet. Varje ny flank ger ett
 * facit på var vi TRODDE vi var mot var vi FAKTISKT var — och den skillnaden
 * är driften. Den skattas löpande i stället för att antas vara noll.
 */

/** Hur mycket takthållningen får korrigeras per sekund. Ett hopp syns; en glidning gör det inte. */
const MAX_SLEW_PPM = 20000;   // 2 % — rymmer alla rimliga klockfel med marginal
/** Flankar tätare än så är samma händelse (dubbel-event från gatewayen). */
const MIN_EDGE_GAP_MS = 200;
/** Utan ny flank så länge är klockan inte att lita på längre. */
const STALE_MS = 15000;
/**
 * Hur många flankar som krävs innan klockan säger något alls.
 *
 * ÄGARENS KRAV: "för mig gör det inget om det tar 10 sekunder innan den
 * synkat". Med ~2 s mellan flankarna räcker det till ungefär fem — alltså gott
 * om underlag. Därför prioriteras KORREKTHET framför snabbhet i hela kedjan:
 * hellre tyst i tio sekunder än fel från första sekunden.
 */
const MIN_EDGES = 3;
/**
 * Baslinje for driftskattningen.
 *
 * VARFOR INTE FLANK-TILL-FLANK: sedan klockan matas med hela 1 Hz-flodet ligger
 * flankarna en sekund isar. En leveransjitter pa 30 ms blir da 30 000 ppm --
 * hundra ganger storre an driften som ska matas. Uppmatt gav det en skattning
 * som hoppade mellan -107 och -2646 ppm fran sekund till sekund.
 *
 * Drift ar en HARDVARUEGENSKAP och andras over minuter, inte sekunder. Mats den
 * mot en flank som ar en halv minut gammal delas samma jitter pa 30 s och bruset
 * faller med faktor 30.
 */
const DRIFT_BASELINE_MS = 30000;

export interface SongClockState {
  /** Skattad position i låten, ms. null = vet inte. */
  positionMs: number | null;
  /** Hur gammal den senaste absoluta flanken är. */
  ageMs: number;
  /** Skattad klockdrift i ppm. Positiv = vår klocka går fort. */
  driftPpm: number;
  /** Hur långt fel förra gissningen låg när flanken kom, ms. Sanningsvittnet. */
  lastErrorMs: number;
  /** Antal flankar vi sett. Under ~3 är driftskattningen inte värd något. */
  edges: number;
}

export class SongClock {
  private anchorSongMs = 0;      // låtposition vid senaste flank
  private anchorLocalMs = 0;     // lokal tid då flanken sågs
  private lastRawPos: number | null = null;
  private lastEdgeLocalMs = 0;
  private driftPpm = 0;
  private lastErrorMs = 0;
  private edges = 0;
  private beatTrimMs = 0;
  /** Referensflank for driftskattningen — avsiktligt gammal, se DRIFT_BASELINE_MS. */
  private driftRefSongMs = 0;
  private driftRefLocalMs = 0;

  /** Nollställ vid låtbyte — ingenting från förra låten gäller. */
  reset(): void {
    this.anchorSongMs = 0;
    this.anchorLocalMs = 0;
    this.lastRawPos = null;
    this.lastEdgeLocalMs = 0;
    this.lastErrorMs = 0;
    this.edges = 0;
    this.beatTrimMs = 0;
    this.driftRefLocalMs = 0;   // ny lat = ny baslinje
    // driftPpm behålls med flit: klockfelet tillhör HÅRDVARAN, inte låten.
  }

  /**
   * Mata in Sonos rapporterade position. Anropas så ofta det går — bara
   * FÖRÄNDRINGAR används, resten kastas.
   */
  onPosition(rawPosMs: number | null, localNowMs: number): void {
    if (rawPosMs == null || !Number.isFinite(rawPosMs)) return;
    if (this.lastRawPos === rawPosMs) return;              // samma sekund igen: ingen information

    const prev = this.lastRawPos;
    this.lastRawPos = rawPosMs;
    if (prev == null) {                                    // första värdet: ankra utan att lära
      this.anchorSongMs = rawPosMs;
      this.anchorLocalMs = localNowMs;
      this.lastEdgeLocalMs = localNowMs;
      this.edges = 1;
      this.driftRefSongMs = rawPosMs;
      this.driftRefLocalMs = localNowMs;
      return;
    }
    if (localNowMs - this.lastEdgeLocalMs < MIN_EDGE_GAP_MS) return;   // dubbel-event

    // FLANKEN ÄR SANNINGEN: låten passerade rawPosMs just nu.
    const predicted = this.rawPredict(localNowMs);
    this.lastErrorMs = predicted - rawPosMs;               // + = vi låg före

    // Driften skattas ur felet över tiden sedan förra flanken. Först efter ett
    // par flankar finns tillräckligt underlag för att den ska betyda något.
    // DRIFT MOT LANG BASLINJE. Jamfor hur mycket lokal tid som gatt mot hur
    // mycket LATEN gatt sedan referensflanken. Skillnaden ar driften -- och over
    // 30 s dranks leveransjittret som annars dominerar helt.
    if (this.driftRefLocalMs > 0) {
      const localEl = localNowMs - this.driftRefLocalMs;
      const songEl = rawPosMs - this.driftRefSongMs;
      if (localEl >= DRIFT_BASELINE_MS && songEl > 0) {
        const ppm = ((localEl - songEl) / localEl) * 1e6;
        if (Math.abs(ppm) < MAX_SLEW_PPM) {
          // Fortfarande EMA: baslinjen tar bort bruset, EMA:n enstaka utstickare.
          this.driftPpm += (ppm - this.driftPpm) * 0.30;
        }
        this.driftRefSongMs = rawPosMs;
        this.driftRefLocalMs = localNowMs;
      }
    } else {
      this.driftRefSongMs = rawPosMs;
      this.driftRefLocalMs = localNowMs;
    }

    this.anchorSongMs = rawPosMs;
    this.anchorLocalMs = localNowMs;
    this.lastEdgeLocalMs = localNowMs;
    if (this.edges < 1000) this.edges++;
  }

  /** Position utan finjustering — används internt för att mäta felet. */
  private rawPredict(localNowMs: number): number {
    const el = localNowMs - this.anchorLocalMs;
    return this.anchorSongMs + el * (1 - this.driftPpm / 1e6);
  }

  /**
   * SISTA TRIMNINGEN, från micen. Slagfasen ger millisekunder men kan inte
   * säga VILKET slag — därför får den bara flytta klockan inom ett halvt
   * slag, aldrig hoppa en hel beat. Utan den gränsen skulle en granne-beat
   * kunna dra klockan en hel takt fel utan att något märks.
   */
  trimToBeat(beatOffsetMs: number, beatPeriodMs: number): void {
    if (!(beatPeriodMs > 0)) return;
    const half = beatPeriodMs / 2;
    let d = beatOffsetMs;
    while (d > half) d -= beatPeriodMs;
    while (d < -half) d += beatPeriodMs;
    // Glid, hoppa inte: ett hopp i ljuset syns, en glidning gör det inte.
    // Mjukt: tio sekunder till full inställning är helt acceptabelt, och en
    // långsam trimning kan aldrig rycka till på en enstaka feltolkad transient.
    this.beatTrimMs += (d - this.beatTrimMs) * 0.12;
  }

  state(localNowMs: number): SongClockState {
    if (this.edges < MIN_EDGES) {
      return { positionMs: null, ageMs: Infinity, driftPpm: this.driftPpm, lastErrorMs: 0, edges: 0 };
    }
    const age = localNowMs - this.anchorLocalMs;
    return {
      positionMs: age > STALE_MS ? null : this.rawPredict(localNowMs) + this.beatTrimMs,
      ageMs: age,
      driftPpm: Math.round(this.driftPpm),
      lastErrorMs: Math.round(this.lastErrorMs),
      edges: this.edges,
    };
  }
}
