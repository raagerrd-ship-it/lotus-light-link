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
 * index.ts) ger BIT-IDENTISKT tempo mot den odelade analysatorn, vilket körbänken bevisar.
 */

export const REC_LEN = 28;
export const RING_N = 1024;                    // ~10 s vid 100 Hz — workern får ligga efter utan att tappa

// Record-fält (Float64)
export const R_SEQ = 0, R_PERF = 1, R_WALL = 2, R_ENV = 3, R_BASS = 4, R_FLAGS = 5, R_HINT_MS = 6, R_VCLOCK = 7,
  R_SEC_N = 8, R_SEC_INT = 9, R_SEC_KICKS = 10, R_SEC_BREAK = 11, R_SEC_RMS2 = 12, R_SEC_CENT = 13, R_SEC_DT = 14,
  R_DROPS = 15, R_ACTIVE = 16, R_BUILD = 17, R_SEC_SPEC0 = 18 /* ..25 */, R_SEC_WALL = 26, R_TS = 27 /* Date.now() vid skrivning, for lagmatt over tradar */;

// Flaggor (bitmask i R_FLAGS)
export const F_SIL350 = 1, F_SIL10 = 2, F_RESET_TEMPO = 4, F_HINT = 8, F_RESET_BAR = 16, F_VCLOCK_SET = 32, F_VCLOCK_NULL = 64;

// Kontrollord (Int32, Atomics)
export const C_WRITE = 0;        // antal skrivna records (monotont) — workern väntar på detta
export const C_READ = 1;         // antal lästa records
export const C_STATE_SEQ = 2;    // seqlock för tillståndsblocket (udda = skrivning pågår)

// Tillståndsblock (Float64)
export const S_REC_SEQ = 0, S_BPM = 1, S_CONF = 2, S_BPMF = 3, S_PHASE_MS = 4, S_PHASE_CONF = 5, S_SECTION = 6, S_SEC_START = 7,
  S_SEC_INDEX = 8, S_SEC_TIER = 9, S_REP_SIM = 10, S_REP_AGO = 11, S_REP_SEC = 12, S_PROCESSED = 13, S_LAG_MS = 14, S_LAG_MAX = 15,
  S_BUSY_US = 16, S_BUSY_MAX_US = 17, S_SKIPPED = 18;
export const STATE_LEN = 20;

export const SECTIONS = ['', 'intro', 'low', 'build', 'high', 'break'];
export function sectionCode(s: string): number { const i = SECTIONS.indexOf(s); return i < 0 ? 0 : i; }

export interface SplitBuffers { ctrl: SharedArrayBuffer; ring: SharedArrayBuffer; state: SharedArrayBuffer; }

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
