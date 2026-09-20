/**
 * TEMPOFOLJARE MED TILLSTAND (2026-09-20). Ersatter (bakom LOTUS_TEMPO_HMM=1) argmax + vikning + lasapparaten
 * i analyser.computeBpm med en enda mekanism: tempot ar ett tillstand pa ett logaritmiskt rutnat (56..185 BPM,
 * 1 %-steg, INGEN vikning), och varje uppdatering vager en observation mot overgangskostnader:
 *   - observation: tempogrammets varde vid tillstandets lag (komb-scorad autokorrelation) x slagpoang pa
 *     basonseten kring kandidattopparna (fantomer 3/2, 4/3 traffar kickarna bara delvis) x halvslagsbevis
 *     (starka halvslag => stod for dubbla tempot; PC-facit-regeln: kvot >= 0,6)
 *   - overgang: gratis att sta kvar, billigt att driva +-3 %, dyrt att hoppa, mattligt att byta oktav
 *   - Viterbi (max-produkt) i logdomanen: skarpa beslut, ingen underflow, hysteres inbyggd i kostnaderna
 * Utdata: basta tillstandets BPM och marginalen (log) till basta tillstand utanfor +-3 % som konfidens.
 * Korbanken (tools/tempo-facit-pc/bench.mjs) ar grinden: ska sla liveprovets 57/91 utan syntetforlust.
 */
export interface TempoObservation {
  /** Tempogramvarde per tillstand (0..1-normaliserat mot max i anropet), 0 utanfor sokfonstret. */
  tg: Float32Array;
  /** Slagpoang-stod per tillstand (0..1), 0 = ingen kandidat nara. */
  align: Float32Array;
  /** Halvslagsstod per tillstand (0..1): hur starkt basonseten pa HALVA perioden ar for tillstandet = bevis for 2x. */
  half: Float32Array;
}

export class TempoTracker {
  static readonly BPM_MIN = 56;
  static readonly BPM_MAX = 185;
  static readonly STEP = 1.01;                          // 1 % per tillstand
  readonly n: number;
  readonly bpmOf: Float32Array;
  private logPost: Float32Array;
  private scratch: Float32Array;
  private lastUpdateMs = 0;
  private best = -1;
  private stable = 0;
  /** Kostnader i log-enheter (naturliga). */
  private static envNum(k: string, d: number): number { const v = typeof process !== 'undefined' ? Number(process.env?.[k]) : NaN; return Number.isFinite(v) && v > 0 ? v : d; }
  static readonly COST_DRIFT = TempoTracker.envNum('LOTUS_TEMPO_HMM_DRIFT', 0.6);      // per 1 %-steg, upp till +-3 steg
  /** Mjuk oktavprior: kostnad per uppdatering och 10 BPM utanfor [80,160] - vikningens konvention (och facit:s), men slagbar av stark evidens. */
  static readonly PRIOR_OUT = TempoTracker.envNum('LOTUS_TEMPO_HMM_PRIOR', 0.15);
  static readonly HALF_THR = TempoTracker.envNum('LOTUS_TEMPO_HMM_HALF', 0.6);
  static readonly PRIOR_HI = TempoTracker.envNum('LOTUS_TEMPO_HMM_PRIOR_HI', 160);
  static readonly W_HALF_ENV = TempoTracker.envNum('LOTUS_TEMPO_HMM_WHALF', 0.8);
  static readonly COST_JUMP = 7.0;                      // godtyckligt hopp (latbyte utan hint)
  static readonly COST_OCTAVE = 3.5;                    // x2 / /2
  static readonly W_TG = 1.0;                           // vikt tempogram
  static readonly W_ALIGN = 1.4;                        // vikt slagpoang
  static readonly W_HALF = TempoTracker.W_HALF_ENV;      // vikt halvslagsbevis (for dubbla tempot)
  static readonly FLOOR = 0.05;

  constructor() {
    const steps = Math.floor(Math.log(TempoTracker.BPM_MAX / TempoTracker.BPM_MIN) / Math.log(TempoTracker.STEP)) + 1;
    this.n = steps;
    this.bpmOf = new Float32Array(steps);
    for (let i = 0; i < steps; i++) this.bpmOf[i] = TempoTracker.BPM_MIN * Math.pow(TempoTracker.STEP, i);
    this.logPost = new Float32Array(steps);
    this.scratch = new Float32Array(steps);
    this.reset();
  }

  reset(): void { this.logPost.fill(0); this.best = -1; this.stable = 0; this.lastUpdateMs = 0; }

  /** Tillstandsindex narmast ett BPM (klampat). */
  indexOf(bpm: number): number {
    if (bpm <= 0) return -1;
    const i = Math.round(Math.log(bpm / TempoTracker.BPM_MIN) / Math.log(TempoTracker.STEP));
    return i < 0 ? 0 : i >= this.n ? this.n - 1 : i;
  }

  /** Antal tillstand som motsvarar en oktav (log2 / log1.01 ~ 69,7 -> 70). */
  get octaveSteps(): number { return Math.round(Math.log(2) / Math.log(TempoTracker.STEP)); }

  /** En uppdatering. Returnerar null om det gick < minIntervalMs sedan forra. */
  update(obs: TempoObservation, nowMs: number, minIntervalMs = 200): { bpm: number; conf: number; stable: number; index: number } | null {
    if (this.lastUpdateMs > 0 && nowMs - this.lastUpdateMs < minIntervalMs) return null;
    this.lastUpdateMs = nowMs;
    const n = this.n, prev = this.logPost, next = this.scratch, oct = this.octaveSteps;
    const CD = TempoTracker.COST_DRIFT, CJ = TempoTracker.COST_JUMP, CO = TempoTracker.COST_OCTAVE;
    // globalt max for hopp-alternativet
    let gmax = -Infinity; for (let i = 0; i < n; i++) if (prev[i] > gmax) gmax = prev[i];
    for (let s = 0; s < n; s++) {
      let b = prev[s];                                                      // sta kvar
      for (let d = 1; d <= 3; d++) {                                        // drift +-d steg
        if (s - d >= 0) { const v = prev[s - d] - CD * d; if (v > b) b = v; }
        if (s + d < n) { const v = prev[s + d] - CD * d; if (v > b) b = v; }
      }
      if (s - oct >= 0) { const v = prev[s - oct] - CO; if (v > b) b = v; }   // fran halva tempot
      if (s + oct < n) { const v = prev[s + oct] - CO; if (v > b) b = v; }    // fran dubbla tempot
      const j = gmax - CJ; if (j > b) b = j;                                 // hopp
      // observation (log-likelihood)
      const like = TempoTracker.FLOOR + TempoTracker.W_TG * obs.tg[s] + TempoTracker.W_ALIGN * obs.align[s] + TempoTracker.W_HALF * obs.half[s];
      const bpm = this.bpmOf[s]; const out = bpm < 80 ? (80 - bpm) / 10 : bpm > TempoTracker.PRIOR_HI ? (bpm - TempoTracker.PRIOR_HI) / 10 : 0;
      next[s] = b + Math.log(like) - TempoTracker.PRIOR_OUT * out;
    }
    // normalisera
    let mx = -Infinity, bi = 0; for (let i = 0; i < n; i++) if (next[i] > mx) { mx = next[i]; bi = i; }
    for (let i = 0; i < n; i++) prev[i] = next[i] - mx;
    // marginal till basta utanfor +-3 %
    let second = -Infinity; for (let i = 0; i < n; i++) if (Math.abs(i - bi) > 3 && prev[i] > second) second = prev[i];
    const conf = second === -Infinity ? 1 : Math.max(0, Math.min(1, -second / 6));   // 6 log-enheter = helt sakert
    if (this.best >= 0 && Math.abs(bi - this.best) <= 3) this.stable++; else this.stable = 0;
    this.best = bi;
    return { bpm: this.bpmOf[bi], conf, stable: this.stable, index: bi };
  }
}
