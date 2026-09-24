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

export const REC_LEN = 34;
export const RING_N = 1024;                    // ~10 s vid 100 Hz — workern får ligga efter utan att tappa
export const RING_MARGIN = 8;                  // records workern lämnar orörda mot skrivaren (80 ms) — läses aldrig närmare kanten

// Record-fält (Float64)
export const R_SEQ = 0, R_PERF = 1, R_WALL = 2, R_ENV = 3, R_BASS = 4, R_FLAGS = 5, R_HINT_MS = 6, R_VCLOCK = 7,
  R_SEC_N = 8, R_SEC_INT = 9, R_SEC_KICKS = 10, R_SEC_BREAK = 11, R_SEC_RMS2 = 12, R_SEC_CENT = 13, R_SEC_DT = 14,
  R_DROPS = 15, R_ACTIVE = 16, R_BUILD = 17, R_SEC_SPEC0 = 18 /* ..25 */, R_SEC_WALL = 26, R_TS = 27 /* Date.now() vid skrivning, for lagmatt over tradar */,
  R_FLAGCNT = 28 /* packade flaggräknare (se packFlagCounts): hur många gånger varje flagga rests t.o.m. detta record */,
  R_SEC_BON = 29 /* NYA SEKTIONSSARDRAG (09-23): basonset-envelope (dB-flux 20-250 Hz, summa per hop) */, R_SEC_BPK = 30 /* basonset-toppar (librosa-lik toppplockning, antal) */,
  R_SEC_FLUX = 31 /* helbandsflux (fluxNorm, summa) */, R_SEC_RMS4 = 32 /* summa rms^4 (dynamik inom blocket) */,
  R_HIGH = 33 /* diskant-onset-ringens sampel (bara med <prefix>HIGH_DIAG/HIGH_VOTE) */;

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
  S_LOST_FLAGS = 23 /* flaggor aterskapade ur raknarna efter tapp */;
export const STATE_LEN = 24;

export const SECTIONS = ['', 'intro', 'low', 'build', 'high', 'break'];
export function sectionCode(s: string): number { const i = SECTIONS.indexOf(s); return i < 0 ? 0 : i; }

export interface SplitBuffers { ctrl: SharedArrayBuffer; ring: SharedArrayBuffer; state: SharedArrayBuffer; }

/** Meddelanden main ↔ worker (bara utanför driftvägen). `crash` finns ENBART bakom <prefix>SPLIT_TEST_CRASH=1 (stresstest). */
export type WorkerMsg = { type: 'stop' } | { type: 'crash' };
export interface WorkerData { cfg: unknown; buffers: SplitBuffers; resumeSeq: number /* senast lästa record (full seq) — 0 vid första start */ }

export function createSplitBuffers(): SplitBuffers {
  return {
    ctrl: new SharedArrayBuffer(16 * 4),
    ring: new SharedArrayBuffer(RING_N * REC_LEN * 8),
    state: new SharedArrayBuffer(STATE_LEN * 8),
  };
}

export function viewsOf(b: SplitBuffers): { ctrl: Int32Array; ring: Float64Array; state: Float64Array } {
  return { ctrl: new Int32Array(b.ctrl), ring: new Float64Array(b.ring), state: new Float64Array(b.state) };
}

/** Skriv tillståndsblocket under seqlock (skrivaren är ensam: workern). */
export function stateWrite(ctrl: Int32Array, state: Float64Array, fill: (s: Float64Array) => void): void {
  const s = Atomics.load(ctrl, C_STATE_SEQ);
  Atomics.store(ctrl, C_STATE_SEQ, s + 1);
  fill(state);
  Atomics.store(ctrl, C_STATE_SEQ, s + 2);
}

/** Läs tillståndsblocket konsistent till `out` (kopia). false = fick ingen konsistent läsning (behåll förra). */
export function stateRead(ctrl: Int32Array, state: Float64Array, out: Float64Array): boolean {
  for (let tries = 0; tries < 4; tries++) {
    const s1 = Atomics.load(ctrl, C_STATE_SEQ);
    if (s1 & 1) continue;
    out.set(state);
    const s2 = Atomics.load(ctrl, C_STATE_SEQ);
    if (s1 === s2) return true;
  }
  return false;
}
