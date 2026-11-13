/**
 * DELAD ANALYSATOR (2026-09-21): transporten mellan den SNABBA tråden (ljudvägen: FFT, band,
 * onset, kick, nivå, drop — måste svara inom en hop) och den LÅNGSAMMA (tempo, gridfas,
 * sektioner, upprepning — sekunder är ok). Den långsamma kör i en worker_threads-Worker
 * med egen V8-heap och egen kärna, så dess beräkningar och skräpsamling aldrig ligger i
 * vägen för hop-loopen och ticken. Ägarens fråga: "dela upp analysatorn och lägga en del
 * på egen cpu som löpande försöker förstå vilken sektion vi är i samt build-up".
 *
 * Snittet (kartlagt med fältanalys av analyser.ts): computeBpm/computeGridPhase läser bara
 * 100 Hz-ringarna (helband + bas) plus sin egen tid; sectionHop läser blocksummor per hop
 * (intensitet, kickar, rms², centroid, bandAbs) plus dropCount/activeMs/buildUp. Tillbaka
 * går ~12 tal: bpm, konfidens, gridfas, sektion, upprepning.
 *
 * Transport: en SharedArrayBuffer-ring med ett RECORD per env-sampel (100 Hz, ~26 doubles)
 * skrivet av den snabba tråden, och ett TILLSTÅNDSBLOCK (seqlock) skrivet av den långsamma.
 * Inga meddelanden i driftvägen, ingen allokering, ingen kopiering. Kommandon (tystnads-
 * nollning, resetTempo, låtbyteshint, virtuell klocka) åker som flaggor I recordet, så
 * ordningen mot ljuddata bevaras exakt — det gör att inline-läget (båda i samma tråd, se
 * createAnalyser) ger BIT-IDENTISKT tempo mot den odelade analysatorn, vilket körbänken bevisar.
 */

import { trustStep } from "./analyserClock.js";   // tilliten utjämnas i hoppets tid (11-11)
export const REC_LEN = 37;
export const RING_N = 1024;                    // ~10 s vid 100 Hz — workern får ligga efter utan att tappa
export const RING_MARGIN = 8;                  // records workern lämnar orörda mot skrivaren (80 ms) — läses aldrig närmare kanten

// Record-fält (Float64)
export const R_SEQ = 0, R_PERF = 1, R_WALL = 2, R_ENV = 3, R_BASS = 4, R_FLAGS = 5, R_HINT_MS = 6, R_VCLOCK = 7,
  R_SEC_N = 8, R_SEC_INT = 9, R_SEC_KICKS = 10, R_SEC_BREAK = 11, R_SEC_RMS2 = 12, R_SEC_CENT = 13, R_SEC_DT = 14,
  R_DROPS = 15, R_ACTIVE = 16, R_BUILD = 17, R_SEC_SPEC0 = 18 /* ..25 */, R_SEC_WALL = 26, R_TS = 27 /* Date.now() vid skrivning, for lagmatt over tradar */,
  R_FLAGCNT = 28 /* packade flaggräknare (se packFlagCounts): hur många gånger varje flagga rests t.o.m. detta record */,
  R_SEC_BON = 29 /* NYA SEKTIONSSARDRAG (09-23): basonset-envelope (dB-flux 20-250 Hz, summa per hop) */, R_SEC_BPK = 30 /* basonset-toppar (librosa-lik toppplockning, antal) */,
  R_SEC_FLUX = 31 /* helbandsflux (fluxNorm, summa) */, R_SEC_RMS4 = 32 /* summa rms^4 (dynamik inom blocket) */,
  R_HIGH = 33 /* diskant-onset-ringens sampel (bara med <prefix>HIGH_DIAG/HIGH_VOTE) */,
  R_BIGSEQ = 34 /* STORA VÄGEN: antal hop-record (stora ringen) skrivna före detta env-record - workern kör dem först */,
  R_CLOCK = 35 /* EN KÄLLA (r0): klockans bpm (analysatorns enda tempo) */, R_CLOCK_CONF = 36 /* klockans tillit */;

// Flaggor (bitmask i R_FLAGS)
export const F_SIL350 = 1, F_SIL10 = 2, F_RESET_TEMPO = 4, F_HINT = 8, F_RESET_BAR = 16, F_VCLOCK_SET = 32, F_VCLOCK_NULL = 64;
export const FLAG_BITS = 7;

/**
 * ROBUSTHET (2026-09-21 natt): om workern ligger > RING_N-RING_MARGIN records efter skrivs ringen över och records
 * TAPPAS. En flagga (t.ex. F_SIL10 = "släpp tempot") som låg i ett överskrivet record fick förr ingen konsekvens alls:
 * snabba sidan hade nollat lokalt, men nästa tillståndsblock (S_REC_SEQ ≥ barrierSeq) återställde tempot. Därför bär
 * varje record en PACKAD RÄKNARE per flagga (7 flaggor × 7 bitar = 49 bitar, exakt i en double): antal gånger flaggan
 * rests t.o.m. recordet, modulo 128. Workern jämför räknaren i recordet den återupptar vid med räknaren i det senast
 * behandlade och får exakt vilka flaggor som gått förlorade — utan någon kapplöpning mot skrivaren (allt ligger i
 * recordet, som seq:en). Modulo 128 räcker: ingen flagga kan resas 128 gånger på de ≤ 10 s ett tapp omfattar.
 */
export const FLAG_MOD = 128;
export function packFlagCounts(cnt: ArrayLike<number>): number {
  let v = 0, m = 1;
  for (let k = 0; k < FLAG_BITS; k++) { v += (cnt[k] % FLAG_MOD) * m; m *= FLAG_MOD; }
  return v;
}
/** Bitmask över flaggor vars räknare skiljer mellan `before` och `after` (packade), minus flaggorna i `ownFlags`
 *  (recordet man återupptar vid behandlas ändå normalt, dess egna flaggor ska inte dubbleras). */
export function lostFlags(before: number, after: number, ownFlags: number): number {
  let lost = 0;
  for (let k = 0; k < FLAG_BITS; k++) {
    const a = Math.floor(after / FLAG_MOD ** k) % FLAG_MOD, b = Math.floor(before / FLAG_MOD ** k) % FLAG_MOD;
    let d = (a - b + FLAG_MOD) % FLAG_MOD;
    if (ownFlags & (1 << k)) d = (d - 1 + FLAG_MOD) % FLAG_MOD;
    if (d !== 0) lost |= 1 << k;
  }
  return lost;
}

// Kontrollord (Int32, Atomics)
export const C_WRITE = 0;        // antal skrivna records (monotont) — workern väntar på detta
export const C_READ = 1;         // antal lästa records
export const C_STATE_SEQ = 2;    // seqlock för tillståndsblocket (udda = skrivning pågår)
export const C_WAITING = 3;      // 1 = workern ligger i Atomics.wait (skrivaren notify:ar bara då)

/**
 * SEQ-WRAP: C_WRITE/C_READ är Int32 och seq:en växer 100/s → 2^31 efter 248 dagar. Båda sidor räknar därför seq som
 * JS-tal (double, aldrig wrap) och lägger bara de låga 32 bitarna i kontrollordet (`seq | 0`). Läsaren rekonstruerar
 * ur en SIGNERAD 32-bitars skillnad mot sin egen seq, korrekt så länge avståndet är < 2^31 records (248 dagar efter
 * varandra — ringen är 1 024). Aldrig `Atomics.load(C_WRITE)` rakt mot en JS-seq: jämför med seqDelta().
 */
export function seqLow(seq: number): number { return seq | 0; }
/** Signerad skillnad (ctrlLow − mySeq) i records, wrap-säker. */
export function seqDelta(ctrlLow: number, mySeq: number): number { return (ctrlLow - (mySeq | 0)) | 0; }

// Tillståndsblock (Float64)
export const S_REC_SEQ = 0, S_BPM = 1, S_CONF = 2, S_BPMF = 3, S_PHASE_MS = 4, S_PHASE_CONF = 5, S_SECTION = 6, S_SEC_START = 7,
  S_SEC_INDEX = 8, S_SEC_TIER = 9, S_REP_SIM = 10, S_REP_AGO = 11, S_REP_SEC = 12, S_PROCESSED = 13, S_LAG_MS = 14, S_LAG_MAX = 15,
  S_BUSY_US = 16, S_BUSY_MAX_US = 17, S_SKIPPED = 18, S_EXPECT_MS = 19, S_EXPECT_SRC = 20, S_PREV_SEC = 21, S_LVL_HIGH = 22,
  S_LOST_FLAGS = 23 /* flaggor aterskapade ur raknarna efter tapp */, S_BUILD_AT = 24, S_BUILD_SEEN = 25 /* uppbyggnadens start / senast sedd (frame.buildProg) */;
export const STATE_LEN = 26;

export const SECTIONS = ['', 'intro', 'low', 'build', 'high', 'break'];
export function sectionCode(s: string): number { const i = SECTIONS.indexOf(s); return i < 0 ? 0 : i; }

export interface SplitBuffers { ctrl: SharedArrayBuffer; ring: SharedArrayBuffer; state: SharedArrayBuffer; hop?: SharedArrayBuffer; hopState?: SharedArrayBuffer /* taktvägen */;
  big?: SharedArrayBuffer; bigPcm?: SharedArrayBuffer; bigState?: SharedArrayBuffer; spec?: SharedArrayBuffer /* stora vägen */ }

/** Meddelanden main ↔ worker (bara utanför driftvägen). `crash` finns ENBART bakom <prefix>SPLIT_TEST_CRASH=1 (stresstest). */
export type WorkerMsg = { type: 'stop' } | { type: 'crash' };
/** cfg ar en KOPIA (structured clone) fran workerns start: den langsamma sidan ser aldrig motorns senare andringar (cfg.beat,
 *  UI-andrade detection-varden). Las darfor aldrig cfg efter start i den langsamma sidan - behovs ett levande varde, skicka det i recorden
 *  (bankens inline-lage ger samma kopia, structuredClone, sedan 10-19). */
export interface WorkerData { cfg: unknown; buffers: SplitBuffers; resumeSeq: number /* senast lästa record (full seq) — 0 vid första start */; sync?: boolean /* bänkens synk-läge */;
  part?: 'all' | 'lane' | 'slow' /* två trådar med stora vägen: taktvägen resp. analysatorn (slowWorker.ts) */ }

export function createSplitBuffers(hopLane = false): SplitBuffers {
  const b: SplitBuffers = {
    ctrl: new SharedArrayBuffer(16 * 4),
    ring: new SharedArrayBuffer(RING_N * REC_LEN * 8),
    state: new SharedArrayBuffer(STATE_LEN * 8),
  };
  if (hopLane) { b.hop = new SharedArrayBuffer(HOP_RING_N * HOP_REC_LEN * 8); b.hopState = new SharedArrayBuffer(FEED_STATE_LEN * 8); }
  b.big = new SharedArrayBuffer(BIG_RING_N * BIG_REC_LEN * 8); b.bigPcm = new SharedArrayBuffer(BIG_RING_N * BIG_HOP_MAX * 4);
  b.bigState = new SharedArrayBuffer(BIG_STATE_LEN * 8); b.spec = new SharedArrayBuffer(SPEC_SLOTS * SPEC_MAX * 4);
  return b;
}

export function viewsOf(b: SplitBuffers): { ctrl: Int32Array; ring: Float64Array; state: Float64Array } {
  return { ctrl: new Int32Array(b.ctrl), ring: new Float64Array(b.ring), state: new Float64Array(b.state) };
}

/** Skriv tillståndsblocket under seqlock (skrivaren är ensam: workern). `word` = seqlockens kontrollord (taktvägen: C_FEED_SEQ). */
export function stateWrite(ctrl: Int32Array, state: Float64Array, fill: (s: Float64Array) => void, word = C_STATE_SEQ): void {
  const s = Atomics.load(ctrl, word);
  Atomics.store(ctrl, word, s + 1);
  fill(state);
  Atomics.store(ctrl, word, s + 2);
}

/** Läs tillståndsblocket konsistent till `out` (kopia). false = fick ingen konsistent läsning (behåll förra). */
export function stateRead(ctrl: Int32Array, state: Float64Array, out: Float64Array, word = C_STATE_SEQ): boolean {
  for (let tries = 0; tries < 4; tries++) {
    const s1 = Atomics.load(ctrl, word);
    if (s1 & 1) continue;
    out.set(state);
    const s2 = Atomics.load(ctrl, word);
    if (s1 === s2) return true;
  }
  return false;
}

/** stateRead med minne (a7): står seqlock-ordet kvar på samma jämna värde som vid förra lyckade läsningen har ingen skrivning
 *  börjat sedan dess, och `out` håller redan exakt det blocket - då hoppas kopian över. Annars som stateRead. Ett minne per `out`. */
export class StateReader {
  private w = -1;   // ordet vid senaste lyckade läsningen (-1: ingen; udda värden matchar aldrig)
  read(ctrl: Int32Array, state: Float64Array, out: Float64Array, word = C_STATE_SEQ): boolean {
    if (Atomics.load(ctrl, word) === this.w) return true;
    for (let tries = 0; tries < 4; tries++) {
      const s1 = Atomics.load(ctrl, word);
      if (s1 & 1) continue;
      out.set(state);
      const s2 = Atomics.load(ctrl, word);
      if (s1 === s2) { this.w = s1; return true; }
    }
    return false;
  }
}

/** SYNK-LÄGET (bara bänken, createAnalyser(cfg, 'sync')): den snabba sidan väntar tills workern publicerat (workern notify:ar `word`
 *  efter varje publicering) - den RIKTIGA workern i lås-steg med ljudet, så den kan jämföras hop för hop mot inline-läget. */
export function syncWait(ctrl: Int32Array, word: number, ready: () => boolean): void {
  for (let i = 0; i < 300; i++) {
    const v = Atomics.load(ctrl, word);
    if (ready()) return;
    Atomics.wait(ctrl, word, v, 100);
  }
  throw new Error('analyser-split sync: workern svarar inte (30 s)');
}

// ── STORA VÄGEN (arena tvavagar a3, 2026-11-08): allt i analysatorns hop som inte är ljusets direkta signal ──────────────────────
// Snabba vägen behåller 512-FFT:n, nivån/AGC:n, kicken, snabba banden (FAST_BANDS) och trumenveloperna. 2048-FFT:n med sina 8 band,
// drop-detektorn (baskroppen), risern/buildUp, karaktärsprofilen, basgången och sektionsaggregatet körs i den långsamma tråden på
// ett record PER HOP (hoppets 128 sampel + ~15 fakta från snabba sidan). Resultatet (dropCount, bodyDb, buildUp, profilen och
// 2048-spektrumet till låtgränsens sink) går tillbaka i ett eget tillståndsblock. I inline/synk-läget körs recordet inom samma
// process() -> bit-identiskt; i realtid ligger de här fälten workerns fördröjning efter (p50 ~1 hop).
// Bara med FAST_BANDS + SECTION_AGG 'hop' (DMX); annars kör snabba sidan allt som förr.
export const BIG_REC_LEN = 16, BIG_RING_N = 2048, BIG_HOP_MAX = 256;
export const B_SEQ = 0, B_N = 1, B_RMS = 2, B_LVL = 3, B_CENT = 4, B_ACTIVE = 5, B_WALL = 6, B_KICK = 7, B_KICKHIT = 8, B_INT = 9, B_BREAK = 10,
  B_SEC = 11, B_LVH = 12, B_CONF = 13, B_ENVF = 14, B_ENVBPM = 15;
export const C_BIG_WRITE = 8, C_BIG_READ = 9, C_BIG_SEQ = 10 /* stora vägens seqlock */, C_WAITING_B = 11 /* analysatortråden väntar (två trådar, se slowWorker) */;
export const BS_SEQ = 0, BS_BODY = 1, BS_DROPS = 2, BS_MINI = 3, BS_BUILD = 4, BS_RISER = 5, BS_PUNCH = 6, BS_BASS = 7, BS_BRIGHT = 8, BS_BEAT = 9,
  BS_BASSLINE = 10, BS_SPEC_N = 11 /* antal 2048-spektra skrivna */, BS_SKIPPED = 12,
  // EN DROPDETEKTOR + LYFT (a3): kandidaterna, minidrop-klasserna, flankens styrka, nästan-drop/lyft/stopp (VAD + styrka)
  BS_CAND = 13, BS_DEMOTED = 14, BS_SPACED = 15, BS_DROPRISE = 16, BS_NEAR = 17, BS_NEARDIP = 18, BS_LIFT = 19, BS_STOPS = 20, BS_STOPSEC = 21,
  BS_UNDER = 22 /* dB baskroppen ligger under sitt tak (klockans break-håll) */;
export const BIG_STATE_LEN = 23;
export const SPEC_SLOTS = 16, SPEC_MAX = 1024;   // 16 spektra = 48 hop: en sen worker tappar inget till låtgränsens sink

// ── TAKTVÄGEN (2026-11-08, ägaren: 'en analysator, två vägar - den snabba och den som ger dirigenten information') ─────────────
// Systemets TAKTMATNING (DMX: src/beatFeed.ts, ~20 % av motorns CPU) körs i den långsamma tråden i stället för i hop-loopen.
// I båda systemen när analysatorn är delad och BEAT_FEED inte är 'inline': DMX-motorn matar (hopLane.feed), lotus analysator matar själv (hopSelf).
// Den snabba sidan skriver ett RECORD PER HOP (ramens ~10 fält taktmatningen läser + hoppets klocka) i en egen ring; workern kör
// taktmatningen på recordet och publicerar resultatet (rutnätet, tilliten, analysatorns eget rutnät, kommandona resetTempo/resetBar)
// i ett eget tillståndsblock med egen seqlock. Den snabba sidan lägger resultatet i motorns cfg/ram och utför kommandona på SIN
// analysator (som förr - flaggorna går sedan i env-recorden som vanligt), så kommandoordningen är exakt den gamla i inline-läget.
// Taktmatningen läser inget ur den långsamma analysatorn: de två körs oberoende i workern.
export const HOP_REC_LEN = 18;
export const HOP_RING_N = 4096;                // ~11 s vid 375 Hz
export const H_SEQ = 0, H_NOW = 1 /* Date.now() vid hoppet = taktmatningens klocka */, H_TS = 2 /* timeOrigin+performance.now(), fördröjningsmått */,
  H_BPM = 3, H_CONF = 4, H_ANCHOR = 5, H_KICKAT = 6, H_BARSHIFT = 7, H_ON_KICK = 8, H_ON_HIMID = 9, H_ON_TREBLE = 10, H_SA_SUB = 11, H_SA_KICK = 12, H_SA_BASS = 13 /* a5: basgången (ettan) */,
  H_BOUND = 14 /* låtgränsräknaren (an.trackBoundaries, a4 entempo) */, H_QUIET = 15 /* ms tystnad (an.quietMs, r0: klockans tystnadssignal) */,
  H_SURE = 16 /* låtgränsen är säker 0/1 (an.boundSure, LÅTENS MINNE) */, H_UNDER = 17 /* dB baskroppen ligger under sitt tak (an.bodyUnderDb, klockans break-håll) */;
export const C_HOP_WRITE = 4, C_HOP_READ = 5, C_FEED_SEQ = 6 /* taktvägens seqlock */, C_WAKE = 7 /* väckningsord: env- OCH hop-record (bara med taktvägen) */;
export const FS_HOP_SEQ = 0, FS_BEAT = 1 /* cfg.beat: 0 undefined, -1 null, 1 objekt */, FS_ANCHOR = 2, FS_BPM = 3, FS_BCONF = 4,
  FS_BEATERR = 5 /* NaN = osatt */, FS_FCONF = 6 /* frame.bpmConfidence efter matningen, NaN = orörd */, FS_GRID = 7 /* analysatorns rutnät 0 null/1 */,
  FS_GANCHOR = 8, FS_GBPM = 9, FS_GCONF = 10, FS_RT_CNT = 11 /* resetTempo, räknare */, FS_RB_CNT = 12 /* resetBar, räknare */,
  FS_PROCESSED = 13, FS_LAG_MS = 14, FS_LAG_MAX = 15, FS_BUSY_US = 16, FS_BUSY_MAX_US = 17, FS_SKIPPED = 18,
  FS_BARK = 19 /* EN ETTA (klocka r0): klockans taktmodell har dömt en etta 0/1 */;
export const FEED_STATE_LEN = 20;

/** Det taktmatningen läser ur ramen, och det den skriver (cfg.beat/beatErr, frame.bpmConfidence, analysatorns rutnät/kommandon). */
export interface HopFrame { bpm: number; bpmConfidence: number; beatAnchorMs: number; kickAtMs: number; barShift: number; beatTrust?: number;
  onset: { kick: number; highMid: number; treble: number }; specAbs: { sub: number; kick: number; bass: number } }
export interface HopGrid { anchorMs: number; bpm: number; confidence?: number }
export interface HopCfg { beat?: HopGrid | null; beatErr?: number }
export interface HopTarget { resetTempo(): void; resetBar(): void; setClockGrid?(g: HopGrid | null): void; trackBoundaries?: number; quietMs?: number; boundSure?: boolean; bodyUnderDb?: number;
  /** EN KÄLLA (r0): analysatorns tempo/tillit = klockans (cfg.beat efter matningen). */ setClock?(bpm: number, conf: number): void }
/** Systemets taktmatning (DMX: BeatFeed). `now` = hoppets klocka (Date.now() när hoppet kom, inte när workern kör det). */
export interface HopFeed { update(frame: HopFrame, cfg: HopCfg, an: HopTarget, now: number): void; /** EN ETTA (r0): taktmodellen har en etta */ barKnown?(): boolean }

/** Taktvägen, snabba sidan (motorns tråd): skriv hoppet, hämta senaste resultatet och lägg det i motorns cfg/ram/analysator. */
export class HopLaneFast {
  private readonly ctrl: Int32Array; private readonly ring: Float64Array; private readonly state: Float64Array;
  private readonly s = new Float64Array(FEED_STATE_LEN); private readonly sr = new StateReader();
  private seq = 0; private applied = 0; private rt = 0; private rb = 0;
  private readonly grid = { anchorMs: 0.5, bpm: 0.5, confidence: 0.5 };
  /** Klockans tempo/tillit efter senaste feed - analysatorn läser dem själv i början av nästa process() (a7r, ingen setClock utifrån). */
  clockBpm = 0; clockConf = 0; private trust = 0; private trustAt = 0;
  /** EN ETTA (klocka r0): klockans taktmodell har dömt en etta (workerns senaste publicering). */
  barKnown = false;
  /** inline-läget (bänken): den långsamma sidan körs synkront här. */
  peer: HopLaneSlow | null = null;
  constructor(b: SplitBuffers, private readonly sync = false) {
    this.ctrl = new Int32Array(b.ctrl); this.ring = new Float64Array(b.hop!); this.state = new Float64Array(b.hopState!);
  }
  /** Ett hop (efter analysatorn, före effekterna - där motorn förr anropade taktmatningen). */
  feed(f: HopFrame, cfg: HopCfg, an: HopTarget): void {
    const r = this.ring, ctrl = this.ctrl, seq = ++this.seq, o = (seq % HOP_RING_N) * HOP_REC_LEN;
    const now = Date.now();
    r[o + H_NOW] = now; r[o + H_TS] = performance.timeOrigin + performance.now();
    r[o + H_BPM] = f.bpm; r[o + H_CONF] = f.bpmConfidence; r[o + H_ANCHOR] = f.beatAnchorMs; r[o + H_KICKAT] = f.kickAtMs; r[o + H_BARSHIFT] = f.barShift;
    r[o + H_ON_KICK] = f.onset?.kick ?? 0; r[o + H_ON_HIMID] = f.onset?.highMid ?? 0; r[o + H_ON_TREBLE] = f.onset?.treble ?? 0;
    r[o + H_SA_SUB] = f.specAbs?.sub ?? 0; r[o + H_SA_KICK] = f.specAbs?.kick ?? 0; r[o + H_SA_BASS] = f.specAbs?.bass ?? 0;
    r[o + H_BOUND] = an.trackBoundaries ?? 0; r[o + H_QUIET] = an.quietMs ?? 0; r[o + H_SURE] = an.boundSure ? 1 : 0; r[o + H_UNDER] = an.bodyUnderDb ?? 0;
    r[o + H_SEQ] = seq;                                    // sist: seq = recordet ar komplett
    Atomics.store(ctrl, C_HOP_WRITE, seqLow(seq)); Atomics.add(ctrl, C_WAKE, 1);
    if (Atomics.load(ctrl, C_WAITING) || Atomics.load(ctrl, C_WAITING_B)) Atomics.notify(ctrl, C_WAKE);   // alla väntare (en eller två trådar)
    if (this.peer) this.peer.drain();
    else if (this.sync) syncWait(ctrl, C_FEED_SEQ, () => this.sr.read(ctrl, this.state, this.s, C_FEED_SEQ) && this.s[FS_HOP_SEQ] >= seq);
    this.apply(cfg, an);
    // EN KÄLLA (r0): ramen och analysatorn bär klockans tempo och tillit (0/0 utan klocka) - samma tal för ljuset, låtgränsen och sektionerna
    const b = cfg.beat; f.bpm = b ? b.bpm : 0; f.bpmConfidence = b ? (b.confidence ?? 0) : 0; this.clockBpm = f.bpm; this.clockConf = f.bpmConfidence;   // a7r: analysatorn läser dem själv i nästa process()
    // EN TILLIT TILL DIRIGENTERNA (11-11): utjämnad i hoppets tid (trustStep, analyserClock.ts)
    { const dt = this.trustAt > 0 ? now - this.trustAt : 0; this.trustAt = now; f.beatTrust = this.trust = trustStep(this.trust, f.bpmConfidence, cfg.beatErr ?? 0, dt > 250 ? 250 : dt); }
  }
  private apply(cfg: HopCfg, an: HopTarget): void {
    const s = this.s, ctrl = this.ctrl;
    if (!this.sr.read(ctrl, this.state, s, C_FEED_SEQ) || s[FS_HOP_SEQ] === 0) return;   // inget resultat an (eller mitt i skrivning: behall forra)
    if (s[FS_HOP_SEQ] === this.applied) return;
    this.applied = s[FS_HOP_SEQ];
    if (s[FS_RT_CNT] !== this.rt) { this.rt = s[FS_RT_CNT]; an.resetTempo(); }
    if (s[FS_RB_CNT] !== this.rb) { this.rb = s[FS_RB_CNT]; an.resetBar(); }
    if (s[FS_GRID] === 1) { const g = this.grid; g.anchorMs = s[FS_GANCHOR]; g.bpm = s[FS_GBPM]; g.confidence = s[FS_GCONF]; an.setClockGrid?.(g); }
    else an.setClockGrid?.(null);
    const bc = s[FS_BEAT];
    if (bc === 1) {
      if (!cfg.beat) cfg.beat = { anchorMs: s[FS_ANCHOR], bpm: s[FS_BPM], confidence: s[FS_BCONF] };
      else { cfg.beat.anchorMs = s[FS_ANCHOR]; cfg.beat.bpm = s[FS_BPM]; cfg.beat.confidence = s[FS_BCONF]; }
    } else cfg.beat = bc === -1 ? null : undefined;
    const be = s[FS_BEATERR]; if (be === be) cfg.beatErr = be;
    this.barKnown = s[FS_BARK] === 1;
  }
  /** Hälsa: hur långt efter taktvägen ligger (hop och ms), dess kostnad per hop, tappade hop. */
  stats(): { written: number; processed: number; behind: number; lagMs: number; lagMaxMs: number; busyUs: number; busyMaxUs: number; skipped: number } {
    const s = this.s;
    return { written: this.seq, processed: s[FS_PROCESSED], behind: this.seq - s[FS_HOP_SEQ], lagMs: +s[FS_LAG_MS].toFixed(2), lagMaxMs: +s[FS_LAG_MAX].toFixed(2),
      busyUs: +s[FS_BUSY_US].toFixed(1), busyMaxUs: Math.round(s[FS_BUSY_MAX_US]), skipped: s[FS_SKIPPED] };
  }
}

/** Taktvägen, långsamma sidan (workern, eller inline i bänken): kör systemets taktmatning på varje hop-record, publicera resultatet. */
export class HopLaneSlow {
  private readonly ctrl: Int32Array; private readonly ring: Float64Array; private readonly state: Float64Array;
  private seq: number; private rt: number; private rb: number; private processed: number;
  private skipped = 0; private lagMaxMs = 0; private busyEmaUs = 0; private busyMaxUs = 0; private fconf = NaN;
  private readonly fr = { bpm: 0.5, bpmConfidence: 0.5, beatAnchorMs: 0.5, kickAtMs: 0.5, barShift: 0.5,
    onset: { kick: 0.5, highMid: 0.5, treble: 0.5 }, specAbs: { sub: 0.5, kick: 0.5, bass: 0.5 } };
  private readonly cfg: HopCfg = { beat: undefined, beatErr: undefined };
  private grid: HopGrid | null = null;
  private readonly target: HopTarget = { trackBoundaries: 0, quietMs: 0, resetTempo: () => { this.rt++; }, resetBar: () => { this.rb++; }, setClockGrid: (g) => { this.grid = g; } };
  constructor(b: SplitBuffers, private readonly feed: HopFeed, private readonly notify = false) {
    this.ctrl = new Int32Array(b.ctrl); this.ring = new Float64Array(b.hop!); this.state = new Float64Array(b.hopState!);
    // Omstart av workern: fortsatt i sekvensen och med raknarna (annars ser snabba sidan ett 'nytt' resetTempo); matningen borjar om.
    const sq = Atomics.load(this.ctrl, C_FEED_SEQ); if (sq & 1) Atomics.store(this.ctrl, C_FEED_SEQ, sq + 1);   // dog mitt i skrivning
    const st = this.state; this.seq = st[FS_HOP_SEQ]; this.rt = st[FS_RT_CNT]; this.rb = st[FS_RB_CNT]; this.processed = st[FS_PROCESSED];
  }
  readSeq(): number { return this.seq; }
  /** Behandla alla hop-record sedan sist, publicera. Returnerar antal. */
  drain(): number {
    const ctrl = this.ctrl, r = this.ring, fr = this.fr;
    const w = this.seq + seqDelta(Atomics.load(ctrl, C_HOP_WRITE), this.seq); let n = 0, lagMs = 0;
    if (w - this.seq > HOP_RING_N - RING_MARGIN) { this.skipped += (w - this.seq) - (HOP_RING_N - RING_MARGIN); this.seq = w - (HOP_RING_N - RING_MARGIN); }
    while (this.seq < w) {
      const seq = ++this.seq, o = (seq % HOP_RING_N) * HOP_REC_LEN;
      if (r[o + H_SEQ] !== seq) { this.skipped++; continue; }
      const t0 = performance.now();
      this.target.trackBoundaries = r[o + H_BOUND]; this.target.quietMs = r[o + H_QUIET]; this.target.boundSure = r[o + H_SURE] === 1; this.target.bodyUnderDb = r[o + H_UNDER];
      fr.bpm = r[o + H_BPM]; fr.bpmConfidence = r[o + H_CONF]; fr.beatAnchorMs = r[o + H_ANCHOR]; fr.kickAtMs = r[o + H_KICKAT]; fr.barShift = r[o + H_BARSHIFT];
      fr.onset.kick = r[o + H_ON_KICK]; fr.onset.highMid = r[o + H_ON_HIMID]; fr.onset.treble = r[o + H_ON_TREBLE];
      fr.specAbs.sub = r[o + H_SA_SUB]; fr.specAbs.kick = r[o + H_SA_KICK]; fr.specAbs.bass = r[o + H_SA_BASS];
      const cin = fr.bpmConfidence;
      this.feed.update(fr, this.cfg, this.target, r[o + H_NOW]);
      this.fconf = fr.bpmConfidence !== cin ? fr.bpmConfidence : NaN;
      const t1 = performance.now(), us = (t1 - t0) * 1000;
      this.busyEmaUs = this.busyEmaUs === 0 ? us : this.busyEmaUs + 0.02 * (us - this.busyEmaUs);
      if (us > this.busyMaxUs) this.busyMaxUs = us;
      lagMs = performance.timeOrigin + t1 - r[o + H_TS]; if (lagMs > this.lagMaxMs) this.lagMaxMs = lagMs;
      n++;
    }
    if (n > 0) {
      this.processed += n;
      Atomics.store(ctrl, C_HOP_READ, seqLow(this.seq));
      stateWrite(ctrl, this.state, (s) => {
        const b = this.cfg.beat, g = this.grid;
        s[FS_HOP_SEQ] = this.seq; s[FS_BEAT] = b ? 1 : b === null ? -1 : 0;
        if (b) { s[FS_ANCHOR] = b.anchorMs; s[FS_BPM] = b.bpm; s[FS_BCONF] = b.confidence ?? 0; }
        s[FS_BEATERR] = this.cfg.beatErr ?? NaN; s[FS_FCONF] = this.fconf;
        s[FS_GRID] = g ? 1 : 0; if (g) { s[FS_GANCHOR] = g.anchorMs; s[FS_GBPM] = g.bpm; s[FS_GCONF] = g.confidence ?? 0; }
        s[FS_RT_CNT] = this.rt; s[FS_RB_CNT] = this.rb;
        s[FS_PROCESSED] = this.processed; s[FS_LAG_MS] = lagMs; s[FS_LAG_MAX] = this.lagMaxMs; s[FS_BUSY_US] = this.busyEmaUs; s[FS_BUSY_MAX_US] = this.busyMaxUs; s[FS_SKIPPED] = this.skipped;
        s[FS_BARK] = this.feed.barKnown?.() ? 1 : 0;
      }, C_FEED_SEQ);
      if (this.notify) Atomics.notify(ctrl, C_FEED_SEQ);
    }
    return n;
  }
}
