/**
 * Audio analyser — portable, framework-agnostic.
 *
 * ⚠️  MIRROR — DO NOT EDIT DIRECTLY. Read-only i Lotus.
 * Master: DMX Control / pi-dmx/engine/src/analyser.ts.
 * Synk från commit: 39eb98fd
 *   git log 39eb98fd..HEAD -- pi-dmx/engine/src/analyser.ts
 * För att uppdatera: ändra i DMX-projektet, commit:a där, kopiera hit,
 * uppdatera hashen ovan. Se README.md ("Source of truth").
 *
 * Feed hop-sized mono Float32 samples via process(samples). Returns a Frame
 * with level, kick, per-band spectrum/onset, BPM, drop/riser, intensity,
 * character profile.
 *
 * Design: two parallel FFTs
 *   - 512  @ every hop  → timing (RMS, kick, flux, BPM)
 *   - 2048 @ every 3rd hop → 8-band spectrum + per-band onsets (23 Hz/bin)
 *
 * Extracted from DMX Control's engine. Kept semantically identical; the
 * only change is that EngineConfig has been replaced by a small
 * AnalyserConfig so this module has no cross-project coupling.
 */

import FFT from "fft.js";

export interface BeatGrid { bpm: number; anchorMs: number; }

export interface AnalyserConfig {
  sampleRate: number;
  hopSize: number;
  /** Small-FFT size (default 512). Must match the hop rate the analyser is fed. */
  fftSize?: number;
  autoGainTarget?: number;
  tauUp?: number;
  tauDown?: number;
  noiseFloor?: number;
}

/** Rikt log-spektrum (8 band) från den parallella 2048-FFT:n. Varje band är
 *  per-band AGC-normaliserat (0..1) så alla band nyttjar full range oavsett mix. */
export interface Spectrum {
  sub: number;      // ~20–60 Hz   — sub/808-rumble
  kick: number;     // ~60–120 Hz  — kick-grundton/kropp (nu SKILD från basen)
  bass: number;     // ~120–250 Hz — basgång/basnoter
  lowMid: number;   // ~250–500 Hz — låg kropp, toms, låg röst
  mid: number;      // ~0.5–2 kHz  — röst, snare-kropp, synth
  highMid: number;  // ~2–5 kHz    — närvaro, snare-crack, konsonanter
  treble: number;   // ~5–10 kHz   — hi-hats, cymbaler
  air: number;      // ~10–16 kHz  — luft/glitter
}

export interface Frame {
  level: number;        // 0..1, auto-gained RMS (15ms attack / 400ms release smoothed)
  levelRaw: number;     // 0..1, samma auto-gain men OSMOOTHAT (rå per-hop)
  levelVU: number;      // 0..1, ~130ms symmetriskt smoothat PÅ HOP-TAKT (375Hz) — för VU-taket
                        //  (ser alla hops → mycket mindre brus än att smootha rå på 50Hz)
  energy: number;       // 0..1, bass-band spectral energy (~0–1.5 kHz)
  mid: number;          // 0..1, mid-band spectral energy (~1.5–12 kHz: röst/synth/virvel)
  treble: number;       // 0..1, high-band spectral energy (hats/cymbals/vocals top)
  centroid: number;     // 0..1, spektralt tyngdpunkt: mörk/bastung → 0, ljus/diskant → 1
  flux: number;         // 0..1, bass-band spectral flux
  kick: boolean;        // true on rising edge only
  gain: number;         // current auto-gain factor (debug)
  bpm: number;          // 0 = ej låst; lokal tempo-estimat via autokorrelation
  bpmConfidence: number;// 0..1, hur tydlig vinnande takttoppen är (peak-to-mean)
  intensity: number;    // 0..1 SEKTIONSENERGI relativt låtens eget snitt (0.5 = snittet,
                        //  <0.34 breakdown, >0.78 drop/topp) — driver show-orkestreringen
  /** DROP-DETEKTION. dropCount är MONOTON: den ökar en gång per upptäckt drop, så
   *  en konsument på lägre takt (render 100Hz) kan jämföra mot sitt eget senaste
   *  värde och ALDRIG missa en flank (till skillnad från en enframs-boolean). */
  dropCount: number;    // monoton räknare — +1 per drop
  inZone: boolean;      // nivån är i låtens topp-zon (ihållande tillstånd, hysteres)
  breaking: boolean;    // nivån är i en svacka/break (ihållande tillstånd)
  /** UPPBYGGNAD (riser): 0..1 tension som ramsar upp mot en drop. Mjuk signal →
   *  sampling-säker. Show-REAKTIONERNA (strobe, swell) ligger i effekt-motorn. */
  buildUp: number;
  inRiser: boolean;
  /** KARAKTÄRSPROFIL (~8s glidande) — vad SLAGS musik är detta? Dirigenten väljer
   *  effekt efter passform mot den här, inte bara efter energinivå.
   *    punch  = transienttäthet (fyra-på-golvet/trummigt ↔ svävande)
   *    bass   = låg-endens tyngd (sub+kick+bas mot resten)
   *    bright = klang uppåt (hi-hats/luft mot resten)
   *    beat   = hur tydlig takten är (BPM-konfidens) */
  profile: { punch: number; bass: number; bright: number; beat: number };
  beatAnchorMs: number; // wall-clock ms för ett taktslag (fas)
  /** Rikt spektrum + per-band onset (anslag) från dubbel-FFT:n (hög-upplöst). */
  spec: Spectrum;       // per-band NIVÅ (AGC 0..1)
  onset: Spectrum;      // per-band ONSET/anslag (halvvågs-flux mot adaptiv baslinje, 0..1)
  /** TRUM-KIT-envelopes (0..1): peak-hold + decay PÅ HOP-TAKT (375Hz) → fångar
   *  varje anslag, aldrig missat mellan två render-frames. kick=diskret kick +
   *  onset.kick, snare=highMid-onset, hat=treble-onset, bass=spec.bass (nivå). */
  drum: { kick: number; snare: number; hat: number; bass: number };
}


export class Analyser {
  // Config (decoupled from DMX Control's EngineConfig)
  private sampleRate: number;
  private hopSize: number;
  private fftSize = 512;
  private autoGainTarget: number;
  private tauUp: number;
  private tauDown: number;
  private noiseFloor: number;
  private beatGrid: BeatGrid | null = null;
  private fft: FFT;
  private window: Float32Array;
  private buffer: Float32Array;      // sliding FFT window
  private prevMag: Float32Array;     // for flux
  // --- Pre-allokerade scratchpads för 512-FFT + utdata (GC-skydd: process()
  //     allokerade ~7KB/hop → ~2.6 MB/s skräp @375Hz. Nu 0 alloc/hop). ---
  private windowed512!: Float32Array;   // fönstrad tidssignal (scratch)
  private spectrum512!: number[];       // fft.js komplex-spektrum (scratch)
  private mag512!: Float32Array;        // magnitud denna hop (swap:as med prevMag)
  private outSpec: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outOnset: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outDrum = { kick: 0, snare: 0, hat: 0, bass: 0 };   // trum-envelopes (återanvänt)
  private outProfile = { punch: 0.4, bass: 0.5, bright: 0.3, beat: 0.5 };   // karaktärsprofil (återanvänt)
  private outFrame!: Frame;             // ETT återanvänt Frame (muteras/hop; säkert — main-tråden läser synkront)
  // TRUM-KIT peak-hold-envelopes (håll mellan hops). Flyttade FRÅN effects.ts render
  // (100Hz) hit (375Hz) → fångar varje onset-topp. tau bevarade: hat 60ms / snare
  // 110ms / kick 150ms. (Block 3 av arkitektur-refaktoreringen.)
  private hatHit = 0;
  private snareHit = 0;
  private kickHit = 0;
  // --- DUBBEL-FFT: en parallell 2048-FFT enbart för effekternas ljudbild.
  //     512:an ovan sköter RMS/kick/BPM/onset ORÖRT (all tightad timing intakt);
  //     denna ger 23 Hz/bin (4× uppl. i botten) → kick och bas kan äntligen skiljas. ---
  private fftBig!: FFT;
  private windowBig!: Float32Array;
  private windowedBig!: Float32Array;   // scratch (återanvänds, ingen alloc/frame)
  private bufferBig!: Float32Array;     // egen glidande buffert (matas samma hops)
  private prevMagBig!: Float32Array;    // för per-band flux
  private magBig!: Float32Array;        // scratch magnitud
  private magBigMax = 0;                // högsta bin banden läser (= bandHi[7], 16 kHz)

  private specBig!: number[];           // scratch complex (fft.js createComplexArray)
  private static readonly BAND_HZ = [20, 60, 120, 250, 500, 2000, 5000, 10000, 16000];
  private bandLo: number[] = [];        // bin-start per band (förberäknat)
  private bandHi: number[] = [];        // bin-slut per band
  private bandPeak = new Float32Array(8);  // per-band AGC-peak (själv-skalande nivå)
  private onsetMed = new Float32Array(8);  // robust glidande median av per-band-fluxen
  private onsetMad = new Float32Array(8);  // robust MAD -> troskelspridning per band
  private static readonly ONSET_K = 3.0;   // troskel = median + K*MAD
  private onsetBase = new Float32Array(8); // per-band adaptiv flux-baslinje (onsets)
  private bandLvl = new Float32Array(8);   // scratch: per-band nivå denna frame (~90ms smoothad)
  private bandLvlSm = new Float32Array(8); // per-band nivå-smooth (håll mellan frames)
  private bandOn = new Float32Array(8);    // scratch: per-band onset denna frame
  private bigCounter = 0;                  // decimering av 2048-FFT:n (se BIG_EVERY)
  private static readonly BIG_EVERY = 3;   // kor stor-FFT var N:e hop → analysen ryms i realtid
  /** Valfri avlyssnare på den stora magnituden (låtminnets fingeravtryck). */
  private specSink: ((mag: Float32Array, binHz: number) => void) | null = null;
  setSpectrumSink(fn: ((mag: Float32Array, binHz: number) => void) | null): void { this.specSink = fn; }

  private kickMed = 0.1;             // robust glidande MEDIAN av kick-fluxen (sign-baserad)
  private kickMad = 0.05;            // robust MAD (median absolut avvikelse) → tröskel-spridning
  private kickSeed = 0;              // warmup-räknare: snabb EMA-seed av skalan innan sign-baserad tar över
  private kickWasAbove = false;      // stigande-flank-detektion
  private kickPrimed = false;        // false på första framen (skräp-flux) → ingen falsk kick
  private static readonly ENV_HZ = 100;
  private static readonly ENV_LEN = 100 * 5;
  private envRing = new Float32Array(Analyser.ENV_LEN);
  private envPos = 0;
  private envFilled = 0;
  private envAccum = 0;
  private envAccumT = 0;
  private bpmCounter = 0;
  private localBpm = 0;
  private localBpmConfidence = 0;
  private static readonly BPM_MIN = 80;    // festintervall; MAX maste vara exakt 2x MIN
  private static readonly BPM_MAX = 160;
  private octaveVote = 0;   // ackumulerat bevis för att byta oktav (självrättande lås)
  private bpmStable = 0;    // antal stabila (finjusterings-)estimat i rad → committa oktaven
  private newSongVote = 0;  // ihållande oenighet trots låst oktav → låtbyte utan tystnadslucka

  private bpmHist = new Float64Array(20);   // ringbuffert: senaste råestimat (~3s) för median
  private bpmHistLen = 0;
  private bpmHistPos = 0;
  private bpmSortScratch = new Float64Array(20);
  // Per-hop EMA-alfor: dtHop och tidskonstanterna ar fixa efter konstruktion, sa
  // exp() rakans EN gang i stallet for ~9 anrop per hop (375 Hz) → sparad CPU.
  private aAtt = 0; private aRel = 0; private aVU = 0;
  private aIUp = 0; private aIDown = 0; private aBandLvl = 0;
  private dHat = 0; private dSnare = 0; private dKick = 0;
  private aNovR = 0; private aNovSlow = 0; private aPr = 0;

  // Pre-allokerade scratchpads för computeBpm (GC-skydd; annars 4× Float32Array/anrop).
  private envScratch = new Float32Array(Analyser.ENV_LEN);
  private envPosScratch = new Float32Array(Analyser.ENV_LEN);
  private acScratch = new Float32Array(Analyser.ENV_LEN);
  private pulseScratch = new Float32Array(Analyser.ENV_LEN);
  private silentMs = 0;
  private beatAnchorMs = 0;
  // #2 sub-hop fas: kick-flankens flux-topp ligger sällan exakt på en hop. Vi
  // sparar de två föregående kick-flux-värdena och gör parabolisk interpolation
  // hoppet EFTER en kick → förfinar beatAnchorMs med ±0.5 hop (~1.3ms). Ren
  // fas-korrektion; själva kick-blixten fyrar oförändrat direkt.
  private kfPrev = 0;
  private kfPrev2 = 0;
  private pendingKickMs = 0;   // >0 = kick väntar på fas-förfining nästa hop
  private gain = 1;
  // Attack/release-smoothed outputs — raw per-hop values update ~370x/s and
  // read as flicker on the lamps. Fast attack keeps hits punchy; the slower
  // release lets light glide down instead of sputtering.
  private lvlSmooth = 0;
  private intensityEma = 0.5;    // sektionsenergi: utjämnad nivå
  private intensityFloor = 0.5;  // dess robusta P50-baslinje (låtens snitt)
  private intensitySpread = 0.05;  // uppmatt dynamik (MAD) → sjalvkalibrerande skala
  private activeMs = 0;          // hur länge musik spelat (warmup för baslinjen)
  // DROP-DETEKTION (flyttad från effects: analys hör hemma här; show-reaktionen stannar där)
  private levelCeil = 0.5;       // långsamt nivå-tak (låtens loud-topp)
  private breakAtMs = 0;         // senaste svacka
  private lastRiserMs = 0;       // senaste uppbyggnad — en drop maste foljas pa en riser
  private breakHoldMs = 0;       // hur lange svackan hallit i sig (mikro-dippar raknas inte)
  private inZoneState = false;   // hysteres för topp-zonen
  /** BASKROPPEN — (sub+kick+bas)/3, utjämnad. Det är HÄR en drop syns.
   *  MÄTT över 15 min av ägarens egen musik: `level` ligger i sin övre tredjedel
   *  67 % av tiden (dynamik p90/p10 = 2.1) — den kan omöjligt peka ut ett särskilt
   *  ögonblick. Baskroppen ligger högt bara 9 % av tiden (dynamik 5.6). Sång och
   *  synth håller uppe nivån hela låten; det som FÖRSVINNER i en breakdown och
   *  SLÅR TILLBAKA i dropen är basen.
   *  Nivå-baserad zon gav 172 flanker på 15 min (en var 5:e sekund) för ~19 drops.
   *  Baskropps-zonen ger 46 (en var 20:e sekund) — rätt storleksordning. */
  private bodyEnv = 0;
  /** Snabb envelopp (0.12 s) ENBART for stigningstakten. Den langsammare
   *  bodyEnv (0.35 s) styr tak och franvaro. Blandar man ihop dem dampas
   *  stigningen och trosklarna slutar motsvara det som mattes i banken. */
  private bodyFast = 0;
  private bodyCeil = 0.2;
  private bodyZoneState = false;
  private wasBodyZone = false;
  /** ANSLAGSDETEKTION. En tröskel som ska NÅS korsas först när basen redan
   *  kommit — uppmätt 2.5 s efter anslaget. STIGNINGSTAKTEN fyrar när den
   *  börjar: uppmätt 0.1 s. Ringbuffert med 0.5 s historik (förallokerad). */
  private bodyHist = new Float32Array(200);
  private bodyHistPos = 0;
  private bodyHistLen = 1;
  /** Ihållande bas-FRÅNVARO. Det som gör en drop till en drop är att basen
   *  varit BORTA. Utan varaktighetskrav räcker en trumfill, och då är villkoret
   *  uppfyllt nästan jämt — då blir 8-takters-spärren det enda som begränsar
   *  takten och detektorn förvandlas till en METRONOM. Uppmätt live: den fyrade
   *  var 15:e sekund (= spärren) och användarens riktiga drops låg 9-15 s FEL,
   *  blockerade av den föregående falska avfyrningen. */
  private bodyGoneMs = 0;
  private lastBodyGoneMs = -1e9;
  private wasInZone = false;
  private dropCount = 0;         // monoton drop-räknare (edge-säker för konsumenter)
  private lastDropMs = -1e9;
  // RISER/UPPBYGGNAD (flyttad från effects)
  private specSlow = new Float32Array(8);
  private novSlow = 0;           // ihållande spektral novelty (~1.5s)
  private novBaseline = 0.2;     // ~8s baslinje → riser = novelty STIGER över den
  private centSlow = 0.3;
  private lvlSlowR = 0.3;
  private buildUp = 0;           // 0..1 uppbyggnads-envelope
  // KARAKTÄRSPROFIL (långsam, ~8s)
  private profPunch = 0.4;
  private profBass = 0.5;
  private profBright = 0.3;
  private profBeat = 0.5;
  private lvlVU = 0;      // ~130ms hop-takt-smooth av levelRaw → VU-taket (låg jitter)
  private engSmooth = 0;
  private midSmooth = 0;
  private trbSmooth = 0;
  private centSmooth = 0.5;

  /** Called when the input routing changes — the old gain is meaningless for
   *  the new source's signal level, so re-converge from neutral. */
  private gainLocked = false;

  resetGain(startGain = 1) {
    // Seed per input: line (aux) arrives hot -> 1x; the room mic is weak -> ~20x.
    this.gain = Math.max(0.5, Math.min(20, startGain));
    this.envelope = 0;
  }

  /** Lock the AGC (aux: fixed 1x, level tracks the mixer directly) or let it run. */
  setGainLock(locked: boolean, fixed = 1) {
    this.gainLocked = locked;
    if (locked) { this.gain = fixed; this.envelope = 0; }
  }

  /** Optional external beat grid (from a PLL). Null = no grid gate on kicks. */
  setBeatGrid(grid: BeatGrid | null) { this.beatGrid = grid; }

  /**
   * BPM (80..160) från onset-envelopens autokorrelation.
   *  1) Toppen i autokorrelationen ger en kandidat-lag.
   *  2) SUB-HARMONIC-PREFERENS: om dubbla/tredubbla lagget (halva/tredjedels
   *     tempot) resonerar nästan lika bra är det oftast det ÄKTA beatet — annars
   *     låser en tryckare/ballad på sin subdivision (dubbeltakt). Väljer grundtempot.
   *  3) MEDIAN över ~3s → robust mot enstaka oktav-flippar (istället för att
   *     bestämma per frame, vilket flimrade). Snäpper vid verkligt oktavbyte,
   *     glider mjukt vid små avvik.
   *  (Ref: comb/sub-harmonic + fler-frames-röstning, se @audio/beat och
   *   OBTAIN-realtidsbeat-tracking.)
   */
  private computeBpm() {
    if (this.envFilled < 50) return;   // ~0.5s → snabbt första grovestimat (täcker ≥~122 BPM;
                                       //  långsammare spår låser på overton tills fönstret växer),
                                       //  förfinas löpande. Halverar time-to-first-lock.
    const N = this.envFilled;
    const env = this.envScratch;   // pre-allokerad (index 0..N-1)
    let mean = 0;
    const start = (this.envPos - N + Analyser.ENV_LEN) % Analyser.ENV_LEN;
    for (let i = 0; i < N; i++) { env[i] = this.envRing[(start + i) % Analyser.ENV_LEN]; mean += env[i]; }
    mean /= N;
    for (let i = 0; i < N; i++) env[i] -= mean;
    const HZ = Analyser.ENV_HZ;
    const lagMin = Math.floor(HZ * 60 / 185);
    const lagMax = Math.min(N - 1, Math.floor(HZ * 60 / 55));   // sokfonstret ar bredare an vikningen med flit
    // 1) Rå autokorrelation, LENGTH-NORMALISERAD: /(N-lag) tar bort biasen mot
    //    korta lag (annars vinner alltid snabb takt eftersom fler termer bidrar).
    // 2) COMB-SCORING: ac(L) + ½·ac(2L) + ⅓·ac(3L). En äkta beat-period resonerar
    //    även på dubbla/trippla lag — enskilda toppar gör det inte. (Klapuri.)
    // 3) PULSE-TRAIN CROSS-CORRELATION (Percival-Tzanetakis 2014, Essentia):
    //    korrelera envelopen mot en idealiserad pulsserie vid bästa fas. Fångar
    //    regelbundenheten även när AC är utsmetad (mjuka onsets, synkoperingar).
    // 4) PERCEPTUELL PRIOR: log-Gauss runt 120 BPM, σ = 1.0 oktav (Ellis/librosa).
    const ac = this.acScratch;   // pre-allokerad (index lagMin..lagMax skrivs/läses)
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let sum = 0;
      const M = N - lag;
      for (let i = 0; i < M; i++) sum += env[i] * env[i + lag];
      ac[lag] = sum / M;
    }
    // Halvvågsrektifierad envelope (positiv del) — pulse xcorr använder bara energi PÅ slaget.
    const envPos = this.envPosScratch;   // pre-allokerad (index 0..N-1)
    for (let i = 0; i < N; i++) envPos[i] = env[i] > 0 ? env[i] : 0;
    // Pulse-train xcorr per lag: max över fas av Σ envPos[φ + k·L], normaliserad per antal pulser.
    const pulse = this.pulseScratch;   // pre-allokerad (index lagMin..lagMax)
    let pulseMax = 1e-9, combMax = 1e-9;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let best = 0;
      for (let ph = 0; ph < lag; ph++) {
        let s = 0, k = 0;
        for (let i = ph; i < N; i += lag) { s += envPos[i]; k++; }
        if (k > 0) { const norm = s / k; if (norm > best) best = norm; }
      }
      pulse[lag] = best;
      if (best > pulseMax) pulseMax = best;
      let comb = ac[lag];
      if (2 * lag <= lagMax) comb += 0.5 * ac[2 * lag];
      if (3 * lag <= lagMax) comb += 0.33 * ac[3 * lag];
      if (comb > combMax) combMax = comb;
    }
    let bestLag = 0, bestVal = 0;
    let scoreSum = 0, scoreCount = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let comb = ac[lag];
      if (2 * lag <= lagMax) comb += 0.5 * ac[2 * lag];
      if (3 * lag <= lagMax) comb += 0.33 * ac[3 * lag];
      // Normalisera båda till [0,1] och rösta jämnt — så de kan väga upp varandra.
      // AC svarar starkt på självlikhet, pulse xcorr på regelbunden energi-fördelning.
      const combN = comb / combMax;
      const pulseN = pulse[lag] / pulseMax;
      const bpmAt = (HZ * 60) / lag;
      const oct = Math.log2(bpmAt / 120);
      const prior = Math.exp(-(oct * oct) / 2.0);   // σ = 1.0 oktav
      const score = (0.5 * combN + 0.5 * pulseN) * prior;
      scoreSum += score; scoreCount++;
      if (score > bestVal) { bestVal = score; bestLag = lag; }
    }

    if (bestLag === 0 || bestVal <= 0) return;
    // Peak-to-mean confidence: en tydlig takttopp sticker ut från medelnivån,
    // en utsmetad "tempolös" låt eller brus har ~platt scoring. clamp(0..1).
    const meanScore = scoreSum / Math.max(1, scoreCount);
    const rawConf = meanScore > 0 ? 1 - meanScore / bestVal : 0;
    // Skala MÄTT, inte gissad. Kommentaren här sa förut att ~0.35 råvärde är
    // "helt låst" och mappade 0..0.5 → 0..1. Verkligheten:
    //   rawConf p05=0.33  p50=0.65  p95=0.72  — och 82-90 % låg ÖVER 0.5.
    // Alltså mättades nio fall av tio till exakt 1.00 och hela det informativa
    // området (0.5-0.75) kastades bort. Konfidensen såg levande ut men var en
    // konstant, och allt som hängde på den stod stilla: beatPulse skulle tona ut
    // när takten är oklar men gjorde det aldrig, och samma värde styr numera
    // chase-låsningen och drops.
    // Golvet 0.35 är inte noll för att även taktlös musik ger en viss topp i
    // autokorrelationen; det är där diskrimineringen faktiskt börjar.
    const conf = Math.max(0, Math.min(1, (rawConf - 0.35) / 0.40));

    // OFF-BEAT-TEST → skilj äkta snabb takt (dans) från subdivision (ballad).
    // Vik onset-envelopen på DUBBLA perioden, jämför energi PÅ slaget vs MELLAN.
    // Svaga mellanslag → sanna takten är halva; starka → behåll snabb takt.
    const P = bestLag * 2;
    if (P <= lagMax) {
      let bestPhase = 0, bestPhaseSum = -1;
      for (let ph = 0; ph < P; ph++) {
        let s = 0; for (let i = ph; i < N; i += P) s += envPos[i];
        if (s > bestPhaseSum) { bestPhaseSum = s; bestPhase = ph; }
      }
      let onE = 0, offE = 0, offC = 0;
      const offPh = (bestPhase + bestLag) % P;
      for (let i = bestPhase; i < N; i += P) onE += envPos[i];
      for (let i = offPh;    i < N; i += P) { offE += envPos[i]; offC++; }
      let posMean = 0; for (let i = 0; i < N; i++) posMean += envPos[i]; posMean /= N;
      const offAvg = offC > 0 ? offE / offC : 0;
      // Halvera bara om mellanslagen (a) är mycket svagare än slagen OCH (b) inte
      // har ett EGET onset (ligger nära baslinjen, offAvg < ~1.2× medel). (b)
      // skiljer en ballad (tomma mellanslag → halvera) från en danslåt med
      // accent-mönster (svagare men RIKTIGA kick-slag → behåll snabb takt).
      if (onE > 0 && offE < onE * 0.45 && offAvg < posMean * 1.2) bestLag = P;
    }

    // Parabolisk interpolation kring toppen → sub-lag-precision (t.ex. 125 ist. 122).
    let lagF = bestLag;
    if (bestLag > lagMin && bestLag + 1 <= lagMax) {
      const acAt = (L: number) => { let s = 0; for (let i = 0; i + L < N; i++) s += env[i] * env[i + L]; return s; };
      const yl = acAt(bestLag - 1), y0 = acAt(bestLag), yr = acAt(bestLag + 1);
      const den = yl - 2 * y0 + yr;
      if (den < 0) { const d = 0.5 * (yl - yr) / den; if (Math.abs(d) < 1) lagF = bestLag + d; }
    }
    let bpm = (HZ * 60) / lagF;
    // BPM-FILTER: vik in i 80..160 — festmusik ligger dar, och allt utanfor ar
    // en oktav-artefakt (en 76-BPM-last ar i praktiken 152, en 170 ar 85).
    // Intervallet MASTE spanna exakt en oktav (max = 2x min): med t.ex. 80..150
    // blir 155 -> 77.5 -> 155 -> 77.5 i all evighet och motorn hanger.
    while (bpm < Analyser.BPM_MIN) bpm *= 2;
    while (bpm >= Analyser.BPM_MAX) bpm /= 2;
    // Median över RÅestimaten (utan oktav-tvång) → dämpar brus men låser inte
    // fast oktaven, så en fel initial låsning kan rättas. Långt fönster (~5s) för
    // att inte studsa på brusiga/tvetydiga låtar.
    this.bpmHist.push(bpm);
    if (this.bpmHist.length > 20) this.bpmHist.shift();
    const sorted = [...this.bpmHist].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    if (this.localBpm === 0) {
      this.localBpm = Math.round(med);
      this.octaveVote = 0;
      this.bpmStable = 0;
    } else {
      // SJÄLVRÄTTANDE OKTAV: håll nuvarande takt för stabilitet, MEN om estimaten
      // ihållande pekar på en annan oktav (½× eller 2×) → byt efter ~2s bevis, så
      // en halvtempo-låsning "ökar" till rätt takt istället för att fastna. Ett
      // enstaka breakdown hinner inte nå tröskeln → ingen flimrig växling.
      // COMMIT: efter ~15s STABIL lås (60 finjusterings-estimat @4Hz) LÅSES oktaven —
      // bara finjustering tillåts, aldrig ½×/2× mitt i en låt (en låt byter inte
      // oktav; halvering nollade takt-gridet & bröt beat-synken). Ett wrong initial-
      // lås hinner rättas under första 15s. Nollställs vid tystnad/låtbyte (localBpm=0).
      const committed = this.bpmStable >= 60;
      const ratio = med / this.localBpm;
      if (ratio >= 0.9 && ratio <= 1.11) {
        this.localBpm = Math.round(this.localBpm + (med - this.localBpm) * 0.35);   // samma takt → glid
        this.octaveVote *= 0.5;
        this.newSongVote *= 0.5;                                                    // ense igen → glöm oenigheten
        if (this.bpmStable < 100000) this.bpmStable++;                              // stabil tid ackumuleras
      } else if (!committed && ratio > 1.4) {
        this.octaveVote = Math.max(0, this.octaveVote) + 1;                          // estimaten HÖGRE oktav
        if (this.octaveVote >= 8) { this.localBpm = Math.round(med); this.octaveVote = 0; this.bpmStable = 0; }
      } else if (!committed && ratio < 0.7) {
        this.octaveVote = Math.min(0, this.octaveVote) - 1;                          // estimaten LÄGRE oktav
        if (this.octaveVote <= -8) { this.localBpm = Math.round(med); this.octaveVote = 0; this.bpmStable = 0; }
      } else {
        this.octaveVote *= 0.7;                                                      // mellanting (3/2) / committad off-oktav → brus
        // LÅTBYTE UTAN TYSTNADSLUCKA: låset ovan nollställs annars BARA av 350 ms
        // tystnad — men crossfade/DJ-set/gapless spelning har ingen. Då satt
        // localBpm fast på första låtens tempo resten av kvällen och hela
        // takt-gridet var fel. Skillnaden mot ett breakdown är inte hur MYCKET
        // estimaten är oense utan hur LÄNGE: ett breakdown är oense några sekunder,
        // en ny låt för alltid. ~25s ihållande oenighet (100 estimat @4Hz) = ny låt
        // → släpp låset och lås om.
        // MÄTT: 6s var för kort — på riktig musik halverades BPM 145→73→144 mitt
        // i en låt när ett breakdown hann nå tröskeln. En låt är 3–5 min, så 25s
        // ryms lätt inom ett låtbyte men ingen sektion håller i sig så länge.
        // Värsta fall efter ett låtbyte: 25s fel takt. Mot hela kvällen fel.
        if (committed && ++this.newSongVote >= 100) {
          this.localBpm = Math.round(med);
          this.newSongVote = 0;
          this.octaveVote = 0;
          this.bpmStable = 0;   // nytt lås får byggas om från början
        }
      }
    }
    // Smooth confidence (undvik hoppig UI); attack snabbt, release långsamt.
    const cA = this.localBpmConfidence;
    this.localBpmConfidence = cA + (conf - cA) * (conf > cA ? 0.35 : 0.08);
  }

  private envelope: number;
  private lastKick = 0;
  private lastT = performance.now();
  /** VIRTUELL KLOCKA. Analysatorns dtHop är sampelbaserad, men fyra beslut läser
   *  väggklockan — drop-spärren ("8 takter sedan förra"), svackans ålder, riserns
   *  ålder. Spelar man upp en inspelning snabbare än realtid hinner åtta takter
   *  gå på några millisekunder och hela strukturlogiken kollapsar.
   *
   *  Med en injicerbar klocka blir analysatorn DETERMINISTISK: samma ljud in ger
   *  samma bildrutor ut, oavsett hur fort man matar den. Det är förutsättningen
   *  för en regressionsbänk — och för att kunna välja tröskelvärden mot tjugo
   *  låtar i stället för mot en. Live är beteendet oförändrat (null = riktig tid). */
  private virtualMs: number | null = null;
  /** Driv analysatorn på en virtuell klocka (offline-uppspelning). Anropas med
   *  ackumulerad ljudtid i ms före varje process(). null = tillbaka till realtid. */
  setVirtualClock(ms: number | null) { this.virtualMs = ms; }
  private perfNow(): number { return this.virtualMs ?? performance.now(); }
  private wallNow(): number { return this.virtualMs === null ? Date.now() : this.virtualEpoch + this.virtualMs; }
  private virtualEpoch = 1700000000000;

  constructor(cfg: AnalyserConfig) {
    this.sampleRate = cfg.sampleRate;
    this.hopSize = cfg.hopSize;
    this.fftSize = cfg.fftSize ?? 512;
    this.autoGainTarget = cfg.autoGainTarget ?? 0.15;
    this.tauUp = cfg.tauUp ?? 3;
    this.tauDown = cfg.tauDown ?? 8;
    this.noiseFloor = cfg.noiseFloor ?? 0.002;

    this.fft = new FFT(this.fftSize);
    this.window = hannWindow(this.fftSize);
    this.buffer = new Float32Array(this.fftSize);
    this.prevMag = new Float32Array(this.fftSize / 2);
    this.windowed512 = new Float32Array(this.fftSize);
    this.spectrum512 = this.fft.createComplexArray();
    this.mag512 = new Float32Array(this.fftSize / 2);
    this.envelope = this.autoGainTarget;
    // Dubbel-FFT: 2048 för hög låg-uppl. Egen buffert, matas samma hop-chunks.
    const BIG = 2048;
    this.fftBig = new FFT(BIG);
    this.windowBig = hannWindow(BIG);
    this.windowedBig = new Float32Array(BIG);
    this.bufferBig = new Float32Array(BIG);
    this.prevMagBig = new Float32Array(BIG / 2);
    this.magBig = new Float32Array(BIG / 2);
    this.specBig = this.fftBig.createComplexArray();
    const binHzBig = this.sampleRate / BIG;
    for (let b = 0; b < 8; b++) {
      this.bandLo[b] = Math.max(1, Math.round(Analyser.BAND_HZ[b] / binHzBig));
      this.bandHi[b] = Math.min(BIG / 2, Math.round(Analyser.BAND_HZ[b + 1] / binHzBig));
      this.bandPeak[b] = 1e-4;   // seed → själv-kalibrerar inom ~1s
    }
    this.magBigMax = this.bandHi[7];

    // Ett återanvänt Frame (spec/onset pekar på de pre-allokerade objekten).
    this.outFrame = {
      level: 0, levelRaw: 0, levelVU: 0, energy: 0, mid: 0, treble: 0, centroid: 0, flux: 0,
      kick: false, gain: 1, bpm: 0, bpmConfidence: 0, intensity: 0.5,
      dropCount: 0, inZone: false, breaking: false, buildUp: 0, inRiser: false, profile: this.outProfile, beatAnchorMs: 0,
      spec: this.outSpec, onset: this.outOnset, drum: this.outDrum,
    };
  }

  /** Feed a hop-sized chunk of mono samples, get a frame back. */
  process(samples: Float32Array): Frame {
    // Slide buffer left by hop, append new samples at end.
    const hop = samples.length;
    this.buffer.copyWithin(0, hop);
    this.buffer.set(samples, this.buffer.length - hop);

    // Windowed FFT (pre-allokerade scratchpads → ingen alloc/hop)
    const windowed = this.windowed512;
    for (let i = 0; i < windowed.length; i++) windowed[i] = this.buffer[i] * this.window[i];
    const spectrum = this.spectrum512;
    this.fft.realTransform(spectrum, windowed);

    // RMS on raw (un-windowed) buffer — cheaper and more stable for auto-gain
    let sumSq = 0;
    for (let i = 0; i < this.buffer.length; i++) sumSq += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sumSq / this.buffer.length);

    // Magnitude spectrum + bass band (mag återanvänds; swap:as med prevMag nedan)
    const half = this.fftSize / 2;
    const mag = this.mag512;
    let bassEnergy = 0;
    let midEnergy = 0;
    let trebleEnergy = 0;
    let flux = 0;
    let kickFlux = 0;                               // onset ENBART i kick-bandet (sub-bas)
    let magSum = 0, magW = 0;                       // för spektralt centroid
    const binHz = this.sampleRate / this.fftSize;          // ~93.75 Hz @ 48k/512
    const bassBins = Math.min(16, half);                            // ~0–1.5 kHz
    const kickBins = Math.min(3, half);                            // bins 0–2 ≈ 0–280 Hz (kick-trumman)
    // Diskant = hi-hats/cymbaler ~5–13 kHz (INTE 12 kHz+ där det är tomt).
    const trebleStart = Math.min(half - 1, Math.round(5000 / binHz));   // ~5 kHz
    const trebleEnd = Math.min(half, Math.round(13000 / binHz));        // ~13 kHz
    for (let i = 0; i < half; i++) {
      const re = spectrum[2 * i];
      const im = spectrum[2 * i + 1];
      mag[i] = Math.sqrt(re * re + im * im);
      if (i < bassBins) {
        bassEnergy += mag[i];
        const d = mag[i] - this.prevMag[i];
        if (d > 0) { flux += d; if (i < kickBins) kickFlux += d; }    // half-wave rectified
      } else if (i < trebleStart) {
        midEnergy += mag[i];                         // mellanband (~1.5–5 kHz: röst/synth/virvel)
      } else if (i < trebleEnd) {
        trebleEnergy += mag[i];                      // diskant (~5–13 kHz: hi-hats/cymbaler)
      }
      magSum += mag[i]; magW += i * mag[i];          // centroid = viktad medelfrekvens
    }
    // Swap: denna hops magnitud blir nästa hops prevMag (zero-copy, ingen alloc).
    { const t = this.prevMag; this.prevMag = this.mag512; this.mag512 = t; }
    // Gain-compensated like `level` — otherwise the band-driven fixtures and
    // the kick energy gate die at low volume while the AGC keeps level alive.
    const energy = Math.min(1, (bassEnergy / bassBins) * 0.02 * this.gain);
    const mid = Math.min(1, (midEnergy / Math.max(1, trebleStart - bassBins)) * 0.025 * this.gain);
    const treble = Math.min(1, (trebleEnergy / Math.max(1, trebleEnd - trebleStart)) * 0.04 * this.gain);
    const centroid = magSum > 1e-6 ? Math.min(1, (magW / magSum) / half) : 0;
    const fluxNorm = Math.min(1, flux * 0.005);

    // Auto-gain (slow: seconds-to-minute timescales)
    const now = this.perfNow();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    // AGC körs BARA för mic (aux låser gain på 1× — line-level är hett & stabilt).
    // Beprövad envelope→autoGainTarget. (Percentil-AGC:n vore bättre men rör bara
    // denna oanvända mic-väg → behåller det testade.)
    if (!this.gainLocked && rms > this.noiseFloor) {
      const tau = rms * this.gain > this.envelope ? this.tauDown : this.tauUp;
      const a = 1 - Math.exp(-dt / tau);
      this.envelope += (rms * this.gain - this.envelope) * a;
      const desired = (this.autoGainTarget / Math.max(1e-4, this.envelope)) * this.gain;
      const gTau = desired > this.gain ? this.tauUp : this.tauDown;
      const ga = 1 - Math.exp(-dt / gTau);
      this.gain += (desired - this.gain) * ga;
      if (this.gain < 0.5) this.gain = 0.5;
      else if (this.gain > 20) this.gain = 20;
    }
    const level = Math.min(1, rms * this.gain);

    // KICK-DETEKTION v2: onset i kick-bandet (sub-bas ~0–280 Hz) mot en ADAPTIV
    // baslinje (långsam EMA av kick-fluxen). En kick = flux tydligt över
    // baslinjen; tröskeln skalar med signalen → fyrar pålitligt även på
    // komprimerat material där en fast tröskel missade nästan alla slag.
    // Stigande flank + cooldown = exakt ett slag per träff.
    // ROBUST kick-tröskel (Lovable/Gemini): sign-baserad glidande MEDIAN + MAD i
    // st.f. EMA-medel × fast faktor. En kick är en OUTLIER → flyttar medianen bara
    // ett litet steg, så tröskeln self-inflatear INTE (EMA-medlet drogs upp av
    // kickarna själva → missade efterföljande). Steget skalar med signalen. Tröskel
    // = median + 4.5·MAD → robust z-score, okänslig för outliers.
    // Warmup ~1s: snabb EMA för att hitta signalens SKALA direkt (annars klättrar
    // median från init i 20s med falska kickar). Sen sign-baserad = robust steady-state.
    if (this.kickSeed < 400) {
      this.kickSeed++;
      this.kickMed += (kickFlux - this.kickMed) * 0.05;
      this.kickMad += (Math.abs(kickFlux - this.kickMed) - this.kickMad) * 0.05;
    } else {
      const kStep = 0.002;
      this.kickMed += Math.sign(kickFlux - this.kickMed) * kStep * (this.kickMed + 0.01);
      this.kickMad += Math.sign(Math.abs(kickFlux - this.kickMed) - this.kickMad) * kStep * (this.kickMad + 0.01);
    }
    const kickThresh = this.kickMed + 4.5 * this.kickMad;
    const KICK_COOLDOWN = 170;                     // ms → max ~350 BPM, hindrar sub-beat-dubbelfyr
    let above = kickFlux > kickThresh && energy > 0.06;
    // ── TAKT-GRID-GRIND ──────────────────────────────────────────────────────
    // Morfologiska filter kan INTE skilja en synth-stot fran en bastrumma - matt
    // och forkastat tre ganger: SuperFlux (191->222 falska), relativ flux
    // (190->193) och stigtid (p50 = 2 hops, ingen svans att filtrera). De falska
    // kickarna ar ocksa skarpa transienter, bara inte fran trumman.
    // Kvar ar KRONOLOGIN: hor transienten hemma pa taktgridet?
    //
    // VIKTIGT: referensen ar this.beatGrid?.anchorMs (PLL:ens stabila fas), INTE
    // this.beatAnchorMs - den senare sätts av varje detekterad kick och vore
    // cirkulär: en falsk kick skulle flytta gridet den doms mot.
    const grid = this.beatGrid;
    if (above && grid && grid.bpm > 40 && this.localBpmConfidence > 0.5) {
      const beatMs = 60000 / grid.bpm;
      const gridMs = beatMs / 2;                    // attondelar: four-on-the-floor + upptakter
      let offset = ((now - grid.anchorMs) % gridMs + gridMs) % gridMs;
      const distToGrid = Math.min(offset, gridMs - offset);
      const tolerance = Math.max(30, beatMs * 0.15);   // ~+-40 ms vid 150 BPM
      if (distToGrid > tolerance) above = false;    // skarp transient, men felplacerad
    }
    // ─────────────────────────────────────────────────────────────────────────
    let kick = false;
    // Första framen: prevMag är noll → flux = hela spektrumet → falsk kick som
    // annars sätter beat-ankaret / triggar drop-blixt vid start-in-i-musik. Hoppa.
    if (above && !this.kickWasAbove && now - this.lastKick > KICK_COOLDOWN && this.kickPrimed) {
      kick = true;
      this.lastKick = now;
    }
    this.kickWasAbove = above;
    this.kickPrimed = true;

    const frameMs0 = (this.hopSize / this.sampleRate) * 1000;
    // Tystnad → nollställ BPM-klockan så beat-effekter inte fortsätter i fantom-takt.
    if (rms < this.noiseFloor * 1.5) {
      this.silentMs += frameMs0;
      if (this.silentMs > 350) { this.localBpm = 0; this.localBpmConfidence = 0; this.octaveVote = 0; this.bpmStable = 0; this.newSongVote = 0; this.envFilled = 0; this.beatAnchorMs = 0; this.pendingKickMs = 0; this.bpmHist.length = 0; }
    } else {
      this.silentMs = 0;
    }
    // --- Onset-envelope → lokal BPM (nedsamplad till 100 Hz) ---
    const frameMs = (this.hopSize / this.sampleRate) * 1000;
    this.envAccum = Math.max(this.envAccum, fluxNorm);
    this.envAccumT += frameMs;
    if (this.envAccumT >= 1000 / Analyser.ENV_HZ) {
      this.envAccumT -= 1000 / Analyser.ENV_HZ;
      this.envRing[this.envPos] = this.envAccum;
      this.envPos = (this.envPos + 1) % Analyser.ENV_LEN;
      this.envFilled = Math.min(this.envFilled + 1, Analyser.ENV_LEN);
      this.envAccum = 0;
      // Innan lås: räkna på varje ny envelope-sample (100 Hz) för snabbast första estimat.
      // Efter lås: 4 Hz räcker gott — sparar CPU och förfinar med median.
      const stride = this.localBpm === 0 ? 1 : Analyser.ENV_HZ / 4;
      if (++this.bpmCounter >= stride) { this.bpmCounter = 0; this.computeBpm(); }

    }
    // #2 Förfina förra kickens fas: nu har vi y(-1)=kfPrev2, y(0)=kfPrev, y(+1)=kickFlux
    // runt kick-hopet. Parabelns topp ger sub-hop-offset δ ∈ [-0.5,0.5] hop.
    if (this.pendingKickMs > 0) {
      const ym1 = this.kfPrev2, y0 = this.kfPrev, yp1 = kickFlux;
      const denom = ym1 - 2 * y0 + yp1;
      if (denom < 0) {                                   // konkav → äkta topp
        let delta = 0.5 * (ym1 - yp1) / denom;
        if (delta > 0.5) delta = 0.5; else if (delta < -0.5) delta = -0.5;
        const hopMs = (this.hopSize / this.sampleRate) * 1000;
        this.beatAnchorMs = this.pendingKickMs + delta * hopMs;
      }
      this.pendingKickMs = 0;
    }
    if (kick) { this.beatAnchorMs = this.wallNow(); this.pendingKickMs = this.beatAnchorMs; }
    this.kfPrev2 = this.kfPrev;
    this.kfPrev = kickFlux;

    const dtHop = this.hopSize / this.sampleRate;
    const aAtt = 1 - Math.exp(-dtHop / 0.015);
    const aRel = 1 - Math.exp(-dtHop / 0.4);
    const smooth = (prev: number, x: number) => prev + (x - prev) * (x > prev ? aAtt : aRel);
    this.lvlSmooth = smooth(this.lvlSmooth, level);
    // VU-nivå: symmetrisk ~200ms lågpass PÅ HOP-TAKT (integrerar alla 375 hops/s
    // → långt mindre brus än att smootha rå-nivån efter 50Hz-decimering). ≤200 BPM
    // = ett slag var ≥300ms, så 200ms suddar aldrig ut en äkta beat — bara brus.
    this.lvlVU += (level - this.lvlVU) * (1 - Math.exp(-dtHop / 0.20));
    this.engSmooth = smooth(this.engSmooth, energy);
    this.midSmooth = smooth(this.midSmooth, mid);
    this.trbSmooth = smooth(this.trbSmooth, treble);
    this.centSmooth = smooth(this.centSmooth, centroid);

    // SEKTIONSENERGI (0..1) — hur energiskt partiet är RELATIVT låtens eget snitt.
    // Ren analys av nivån över tid → hör hemma här, inte i show-orkestreringen.
    // En komprimerad signal ligger jämnt högt, så absolut nivå säger inget; jämför
    // mot en robust baslinje (P50-median, ej EMA-medel som pinnas upp av loud
    // sections). Mitten = snittet, tydligt över = drop/topp, under = breakdown.
    // Attack något snabbare än release så uppbyggnader syns. WARMUP: baslinjen
    // konvergerar snabbt (~3s) de första 8s aktiv musik, sen stabil ~25s.
    // Nollställs vid tystnad → snabb omkalibrering vid låtbyte.
    if (rms >= this.noiseFloor * 1.5) this.activeMs += dtHop * 1000;
    else this.activeMs = 0;
    const iUp = 1 - Math.exp(-dtHop / 1.5);
    const iDown = 1 - Math.exp(-dtHop / 3.0);
    this.intensityEma += (this.lvlSmooth - this.intensityEma) * (this.lvlSmooth > this.intensityEma ? iUp : iDown);
    const iWarm = this.activeMs < 8000;
    // REFERENSEN MASTE VARA MYCKET LANGSAMMARE AN DET DEN MATER. Golvet gick
    // forut pa 25s (~0.022/s), men musikens sektioner andrar sig over tiotals
    // sekunder OCH auto-gainen plattar ut nivaskillnaderna — sa golvet hann
    // ikapp EMA:n och gapet oppnade sig aldrig.
    //   MATT: intensity p10=0.50 p50=0.50 p90=0.51 p99=0.63.
    // Tiern kraver <0.34 for lugn och >0.78 for full, sa BADA ytterlagena var
    // oatkomliga: full-tiern (11 effekter) spelades 1 gang av 13 pa en kvart.
    // 150s referens = flera latar, alltsa ett aftonsnitt i stallet for ett
    // glidande just-nu-varde.
    const floorRate = iWarm ? dtHop / 3 : dtHop / 150;
    if (iWarm) this.intensityFloor += (this.intensityEma - this.intensityFloor) * floorRate;   // seed snabbt
    else this.intensityFloor += Math.sign(this.intensityEma - this.intensityFloor) * floorRate * (this.intensityFloor + 0.05);
    // SJALVKALIBRERANDE SKALA: den fasta namnaren 0.30 var en GISSNING om hur
    // stor dynamiken ar. Mat den i stallet — ett glidande medelavvikelse-matt
    // (MAD) over avvikelsen fran golvet. Da nyttjar intensity hela 0..1 oavsett
    // om baren spelar dynamisk rock eller platt komprimerad house. +-2 MAD
    // spanner hela skalan; minsta 0.015 hindrar att tyst brus blir blaser upp.
    const dev = this.intensityEma - this.intensityFloor;
    this.intensitySpread += (Math.abs(dev) - this.intensitySpread) * (iWarm ? dtHop / 3 : dtHop / 60);
    const scale = Math.max(0.015, this.intensitySpread) * 4;
    const intensity = Math.max(0, Math.min(1, 0.5 + dev / scale));

    // --- DUBBEL-FFT: hög-upplöst log-spektrum för effekterna ---
    // Egen glidande 2048-buffert, matas samma hop. Ger 23 Hz/bin i botten så
    // sub/kick/bas separeras. Per-band AGC-nivå + per-band adaptiv onset.
    // Bufferten matas VARJE hop (glidande fönster måste vara obrutet)...
    this.bufferBig.copyWithin(0, hop);   // skjut vänster med en hop
    this.bufferBig.set(samples, this.bufferBig.length - hop);
    // ...men själva FFT:n + band-analysen körs bara var BIG_EVERY:e hop. 2048-FFT:n
    // är analysatorns dyraste steg och spec-NIVÅERNA smoothas ändå ~90ms — de behöver
    // inte 375Hz. MÄTT: analysen tog 3.8ms/hop mot 2.67ms budget → ljud droppades och
    // ljuset låg 40–140ms efter. Decimeringen får den att rymmas i realtid.
    // Tidssteget skalas (bigDt) så smoothing-tidskonstanterna blir oförändrade.
    if (++this.bigCounter >= Analyser.BIG_EVERY) {
    this.bigCounter = 0;
    const bigDt = dtHop * Analyser.BIG_EVERY;
    for (let i = 0; i < this.bufferBig.length; i++) this.windowedBig[i] = this.bufferBig[i] * this.windowBig[i];
    this.fftBig.realTransform(this.specBig, this.windowedBig);
    const halfBig = this.bufferBig.length / 2;
    // Banden läser bara upp till bin 683 (16 kHz, BAND_HZ[8]). Räkna sqrt bara så
    // långt — MEN full bredd när en spectrum-sink (låtminnets fingerprint/novelty)
    // är kopplad, den kan läsa hela spektrumet.
    const magLimit = this.specSink ? halfBig : this.magBigMax;
    for (let i = 0; i < magLimit; i++) {
      const re = this.specBig[2 * i], im = this.specBig[2 * i + 1];
      this.magBig[i] = Math.sqrt(re * re + im * im);
    }

    // LÅTMINNET får samma magnitud (ingen extra FFT). Anropas före swap:en nedan,
    // så bufferten faktiskt innehåller DENNA frames spektrum.
    this.specSink?.(this.magBig, this.sampleRate / this.bufferBig.length);
    const gated = rms > this.noiseFloor * 1.5;

    for (let b = 0; b < 8; b++) {
      const lo = this.bandLo[b], hi = this.bandHi[b];
      const nb = Math.max(1, hi - lo);
      let sum = 0, fl = 0;
      for (let i = lo; i < hi; i++) {
        sum += this.magBig[i];
        const d = this.magBig[i] - this.prevMagBig[i];
        if (d > 0) fl += d;
      }
      const avg = sum / nb;
      // Per-band AGC: skala mot egen långsamt sjunkande peak → varje band nyttjar
      // full range oavsett mix (bas dominerar annars alltid rå-magnituden).
      // GOLV (~0.15·lvlSmooth): peaken nollställs INTE i tystnad → när ett tidigare
      // tyst band (t.ex. diskant i ett intro) smäller till blir det en balanserad
      // respons, inte en överstyrd ljus-chock/pump. (Gemini.)
      const minPeak = this.lvlSmooth * 0.15;
      if (gated && avg > this.bandPeak[b]) this.bandPeak[b] = Math.max(avg, minPeak);
      else this.bandPeak[b] = Math.max(this.bandPeak[b] * 0.9993, minPeak);
      // Nivån smoothas ~90ms PÅ HOP-TAKT → nivå-drivna/lugna effekter (som läser
      // spec via ctx.band) flimrar inte av det råa per-hop-AGC-bruset. onset lämnas
      // skarp (nedan) så transient-drivna effekter behåller sin punch.
      const lvlRawB = gated ? Math.min(1, avg / (this.bandPeak[b] + 1e-6)) : 0;
      this.bandLvlSm[b] += (lvlRawB - this.bandLvlSm[b]) * (1 - Math.exp(-bigDt / 0.09));
      this.bandLvl[b] = this.bandLvlSm[b];
      // Per-band onset: halvvågs-flux mot adaptiv baslinje (som kick-detektorn) →
      // rena anslag oberoende av bandets absoluta energi.
      const fluxN = fl / nb;
      // ROBUST PROMINENS-GRIND (samma som kick-detektorn anvander, banden fick den
      // aldrig). Den gamla grinden var "1.3x en EMA-baslinje x6", vilket slapper
      // igenom varje transient i bandet i stallet for verkliga trumslag.
      //   MATT vid BPM 134: kick 1116 slag/min (borde ~134, 8x for manga),
      //   virvel 429/min (borde ~67, 6x). Darfor kandes trum-envelopen alltid pa
      //   och gav ingen musikalisk accent - den var inte matttad, den overtriggade.
      // Sign-baserad median + MAD ar okanslig for outliers (ett slag ar en outlier
      // och far darfor INTE dra upp sin egen troskel, till skillnad fran en EMA).
      // Steget skalas med BIG_EVERY sa tidskonstanten blir samma som kickens trots
      // att banden uppdateras var tredje hop.
      const oStep = 0.002 * Analyser.BIG_EVERY;
      this.onsetMed[b] += Math.sign(fluxN - this.onsetMed[b]) * oStep * (this.onsetMed[b] + 0.01);
      this.onsetMad[b] += Math.sign(Math.abs(fluxN - this.onsetMed[b]) - this.onsetMad[b]) * oStep * (this.onsetMad[b] + 0.01);
      const oThr = this.onsetMed[b] + Analyser.ONSET_K * this.onsetMad[b];
      // Skala mot MAD i stallet for en fast faktor -> sjalvskalande per band.
      this.bandOn[b] = gated ? Math.max(0, Math.min(1, (fluxN - oThr) / Math.max(1e-6, this.onsetMad[b] * 3))) : 0;
    }
    { const t = this.prevMagBig; this.prevMagBig = this.magBig; this.magBig = t; }
    }   // slut på decimerad stor-FFT
    // TRUM-KIT peak-hold-envelopes PÅ HOP-TAKT (var 2.7ms) → fångar varje anslag,
    // aldrig missat mellan två render-frames (100Hz). tau bevarade från effects.ts:
    // hat 60ms (treble-onset O[6]) / snare 110ms (highMid-onset O[5]) / kick 150ms
    // (diskret kick + kick-onset O[1]). bass = spec.bass-NIVÅ (L[2], ingen envelope).
    this.hatHit = Math.max(this.hatHit * Math.exp(-dtHop / 0.06), this.bandOn[6]);
    this.snareHit = Math.max(this.snareHit * Math.exp(-dtHop / 0.11), this.bandOn[5]);
    // Drivs ENBART av den riktiga kick-detektorn (median + 4.5*MAD). Tidigare
    // fylldes den ocksa pa av bandOn[1], men det bandet (60-120 Hz) domineras av
    // sustained bas: MATT 816-1377 anslag/min dar ~110 fanns, dvs 8x for manga.
    // Den svammade over den korrekta detektorn sa envelopen aldrig slocknade och
    // kicken forlorade sin accent.
    if (kick) this.kickHit = 1;
    else this.kickHit = this.kickHit * Math.exp(-dtHop / 0.15);
    // ── DROP-DETEKTION (flyttad hit: att AVGÖRA om det är en drop är analys) ──
    // En "riktig" drop = nivån surgar upp mot låtens tak EFTER en break (svacka).
    // Topp-zonen har hysteres (in vid 85% av taket, ut först vid 70%) så nivån inte
    // flimrar kring tröskeln. Kräver ≥2s musik så låtens INTRO (tystnad→musik) inte
    // läses som en drop. Resultatet exponeras som en MONOTON räknare → en konsument
    // på lägre takt kan aldrig missa flanken.
    const nowWallA = this.wallNow();
    this.levelCeil = Math.max(this.lvlSmooth, this.levelCeil - dtHop * 0.015 * this.levelCeil);   // tak, decay ~65s
    // SVACKAN MASTE VARA IHALLANDE. Forut satte VILKEN dipp som helst breakAtMs,
    // aven en som varade nagra tiondelar - en trumfill eller en kort lucka racker.
    // I en lat som ligger konstant hogt betyder det att varje sadan mikro-dipp
    // foljd av ateringang i topp-zonen raknades som en drop.
    //   MATT pa en lat anvandaren rapporterade som "falsk-droppar hela tiden":
    //   4.0 drops/min, inZone 90% av tiden, nivan aldrig lag (p10=0.57), och
    //   intensiteten vid varje drop 0.65-0.83 - alltsa passerade energigrinden
    //   utan problem. Det var inte energin som var fel utan svack-definitionen.
    // Ett verkligt breakdown varar sekunder, inte tiondelar. 400ms ihallande.
    const breaking = this.lvlSmooth < this.levelCeil * 0.65;
    if (breaking) {
      this.breakHoldMs += dtHop * 1000;
      if (this.breakHoldMs > 400) this.breakAtMs = nowWallA;
    } else {
      this.breakHoldMs = 0;
    }
    if (this.lvlSmooth > this.levelCeil * 0.85 && this.lvlSmooth > 0.65) this.inZoneState = true;
    else if (this.lvlSmooth < this.levelCeil * 0.70) this.inZoneState = false;
    const inZone = this.inZoneState;
    // BASKROPPS-ZON — drop-detektionens egen zon. Samma form som ovan (adaptivt
    // tak + hysteres) men på den signal där drops faktiskt syns. `inZone` lämnas
    // orörd: effektlagret använder den som "musiken ligger högt", vilket den
    // fortfarande betyder korrekt.
    const bodyNow = (this.bandLvl[0] + this.bandLvl[1] + this.bandLvl[2]) / 3;   // sub + kick + bas
    this.bodyEnv += (bodyNow - this.bodyEnv) * Math.min(1, dtHop / 0.35);
    this.bodyFast += (bodyNow - this.bodyFast) * Math.min(1, dtHop / 0.12);
    this.bodyCeil = Math.max(this.bodyEnv, this.bodyCeil - dtHop * 0.015 * this.bodyCeil);
    if (this.bodyEnv > this.bodyCeil * 0.80) this.bodyZoneState = true;
    else if (this.bodyEnv < this.bodyCeil * 0.45) this.bodyZoneState = false;
    // BAS-FRÅNVARO med VARAKTIGHETSKRAV: under 30 % av taket i ≥3 s i sträck.
    if (this.bodyEnv < this.bodyCeil * 0.40) {
      this.bodyGoneMs += dtHop * 1000;
      if (this.bodyGoneMs >= 2000) this.lastBodyGoneMs = nowWallA;
    } else this.bodyGoneMs = 0;
    // STIGNINGSTAKT över 0.5 s (ringbuffert, ingen allokering).
    const hist = this.bodyHist, HL = hist.length;
    const oldest = hist[(this.bodyHistPos + HL - this.bodyHistLen) % HL];
    const bodyRise = this.bodyFast - oldest;
    hist[this.bodyHistPos] = this.bodyFast;
    this.bodyHistPos = (this.bodyHistPos + 1) % HL;
    const want = Math.min(HL - 1, Math.max(1, Math.round(0.5 / dtHop)));
    if (this.bodyHistLen < want) this.bodyHistLen++;
    // Anslaget: basen stiger snabbt OCH den var nyss borta på riktigt.
    // TROSKLARNA ar svepta mot 15 min av agarens musik (20 varianter). Ett
    // STORRE stigningskrav vann i tre av fyra franvaro-varianter — riktningen
    // ar alltsa robust, aven om decimalerna inte ar det (n=17 referenspunkter).
    // 40 %/2 s slar 30 %/3 s: verkliga drops kommer ofta efter en DELVIS
    // nedgang, inte total tystnad — 10 av 11 missade drops foll pa just det.
    // Precision 46 -> 56 %, recall 35 -> 53 %.
    const bodyOnset = bodyRise > 0.15 && nowWallA - this.lastBodyGoneMs < 6000;
    // EN DROP MASTE LANDA I HOG ENERGI. Villkoren ovan tittar bara pa LOKALA
    // nivasprang (svacka -> topp-zon) och vet inget om var i laten vi ar, sa varje
    // liten variation i ett tyst parti raknades som en drop.
    //   MATT: 4.7 drops/minut, varav 71% vid intensitet under 0.45. Uppmatta
    //   drop-intensiteter: 0.39 0.32 0.81 0.34 0.40 0.37 0.51 - bara EN av sju
    //   lag i genuint hog energi.
    // En drop ar per definition ett sprang IN i hog energi, inte bara ett sprang.
    // intensity ar nu en levande signal (se 4392f61) och raknas fram i samma
    // funktion, sa gransen kostar ingenting.
    // TVA VAGAR IN I EN DROP, inte en. Villkoret krävde tidigare att nivan FALLIT
    // (breakAtMs inom 3.5s) fore zonintradet - alltsa breakdown -> drop. Men en
    // modern EDM-uppbyggnad STIGER rakt in i dropen utan att forst falla, och da
    // blockerades den.
    //   MATT vid atta zonintraden: ett hade energi 1.00 OCH aktiv riser - ett
    //   solklart drop - men blockerades for att senaste svackan lag 8.0s bort.
    // Nu racker antingen en svacka (klassisk breakdown) ELLER en riser (modern
    // uppbyggnad) strax innan. Riser-signalen ar bekraftat levande: den fyrar
    // 9.8% av tiden och buildUp nar 0.61.
    const hadBreak = nowWallA - this.breakAtMs < 3500;
    const hadRiser = nowWallA - this.lastRiserMs < 4000;
    // Troskeln ar MATT fram, inte gissad. Skuggmatning over 14 zonintraden gav
    // antal drops per troskel (givet att ovriga grindar passerar):
    //   0.60 -> 1 drop | 0.45 -> 2 | 0.35 -> 2 | 0.10 -> 2 | 0.05 -> 4 | 0.00 -> 11
    // En PLATA mellan 0.10 och 0.60: exakt varde spelar ingen roll dar. 0.45 ligger
    // mitt i den med marginal at bada hall, och slapper igenom ett akta drop
    // (intensitet 0.47 med aktiv riser) som 0.60 blockerade.
    // Golvet ar viktigt: sju av fjorton zonintraden lag pa intensitet 0.00 och
    // passerade alla ANDRA grindar - utan energikravet blir det 11 drops i st.f. 2.
    // Den tidigare 0.60 var cirkulart satt (kalibrerad mot drops som redan
    // passerat samma grind), darav ommatningen.
    const dropEnergyOk = intensity > 0.45;
    // REFRAKTARPERIOD. Det fanns ingen alls: en drop kunde folja pa en annan
    // inom brakdelen av en sekund. MATT i drop-intervall-loggen: tva av tio
    // intervall lag pa 0.2 och 0.5 TAKTER, dvs dubbelfyrningar - resten lag pa
    // 8-40 takter. En drop ar en sektionsgrans; tva sadana kan inte ligga en
    // halv sekund isar. 2s ar valdigt lagt satt mot narmaste akta intervall
    // (8 takter = ~13s vid 150 BPM), sa den kan inte kapa nagot verkligt.
    // SPARRAS I TAKTER, INTE SEKUNDER. Musik raknas inte i millisekunder: 2s var
    // drygt EN takt vid 150 BPM. Uppmatta AKTA drop-intervall lag pa 8-40 takter,
    // dar 8 var det kortaste. En drop kan alltsa omojligt folja pa en annan inom
    // 8 takter (32 taktslag). Gransen skalar nu med tempot: ~13s vid 150 BPM,
    // ~21s vid 90 BPM.
    const minGapMs = this.localBpm > 40 ? (32 * 60000 / this.localBpm) : 13000;
    const dropSpacingOk = nowWallA - this.lastDropMs > minGapMs;
    // EN DROP AR KULMEN PA EN UPPBYGGNAD, inte bara "nivan gick upp". Utan detta
    // var detektorn ren nivalogik: varje ateringang i topp-zonen raknades, sa en
    // lat som ligger konstant hogt (uppmatt inZone 90% av tiden) falsk-droppade
    // om och om. En riser MASTE ha funnits strax innan - det ar skillnaden mellan
    // ett strukturellt ogonblick och en nivavariation.
    const dropAfterRiser = nowWallA - this.lastRiserMs < 4000;
    // RISER-KRAVET AR AVSTANGT. Det var ratt tanke - en drop ar kulmen pa en
    // uppbyggnad - men det grindade pa en DOD signal och slog darmed av drop-
    // detektionen helt i stallet for att rensa den.
    //   MATT: buildUp p50=0.00 p90=0.00 p99=0.31 (kravet ar >0.35) och inRiser
    //   0% av tiden -> 0 drops pa 70s. Riser-detektorn fyrar i princip aldrig.
    // Femte signalen i sessionen som ser levande ut men ar en konstant. Innan
    // kravet kan aterinforas maste inRiser/buildUp lagas och matas om - annars
    // ar det bara ett dyrt satt att stanga av dropsen.
    // FLANKEN TAS PÅ BASKROPPEN, inte på nivån. Nivå-zonen var sann 80 % av tiden
    // i ägarens musik → dess flanker låg godtyckligt, och 8-takters-spärren blev
    // i praktiken den som VALDE när en drop fyrade (första flanken efter att
    // fönstret löpt ut). Uppmätt resultat: 3 träffar av 19, 16 falsklarm.
    if (dropSpacingOk && bodyOnset && this.activeMs > 2000) {
      // MÄTNING (loggar bara, grindar inte): hör dropen hemma på taktgridet?
      // En drop är ett musikaliskt beslut och landar nästan alltid PÅ en takt.
      // Kick-detektionen har redan den kronologi-kontrollen; drops har den inte.
      // Innan den införs som villkor mäts hur långt FRÅN gridet de faktiskt ligger.
      const g = this.beatGrid;
      if (g && g.bpm > 40) {
        const bMs = 60000 / g.bpm;
        const off = ((nowWallA - g.anchorMs) % bMs + bMs) % bMs;
        const dist = Math.min(off, bMs - off);
        // intensitet loggas med: energigolvet (dropEnergyOk, > 0.45) mattes fram mot den
        // GAMLA niva-zon-detektorn och foljde aldrig med nar flanken flyttades till
        // baskroppen. Innan det ateranvands vill vi se vilka drops det skulle kapa.
        console.log(`[dropgrid] ${dist.toFixed(0)} ms fran takten (takt ${bMs.toFixed(0)} ms, ${(100 * dist / (bMs / 2)).toFixed(0)} %% av halva takten, konf ${this.localBpmConfidence.toFixed(2)}, intensitet ${intensity.toFixed(2)}, svacka ${hadBreak ? "ja" : "nej"}, riser ${hadRiser ? "ja" : "nej"})`);
      } else {
        console.log("[dropgrid] ingen takt last");
      }
      this.dropCount++; this.lastDropMs = nowWallA;
    }
    this.wasInZone = inZone;
    this.wasBodyZone = this.bodyZoneState;

    // ── UPPBYGGNAD / RISER (flyttad hit) ──
    // Spektral NOVELTY = summan av bandens POSITIVA avvikelse från en ~2s baslinje,
    // ihållande ~1.5s. Mätt validerad: ramsar 0.25→0.78 in i en drop. Relativt en
    // ~8s baslinje → RISER = novelty STIGER över den (filter-sweep/snare-roll),
    // skilt från bara-busy (ihållande → baslinjen kommer ikapp). Gammal väg
    // (klang+nivå stiger) ligger kvar som OR. Inte direkt efter en drop.
    let nov = 0; const sr = 1 - Math.exp(-dtHop / 2.0);
    for (let b = 0; b < 8; b++) { this.specSlow[b] += (this.bandLvl[b] - this.specSlow[b]) * sr; nov += Math.max(0, this.bandLvl[b] - this.specSlow[b]); }
    this.novSlow += (nov - this.novSlow) * (1 - Math.exp(-dtHop / 1.5));
    this.novBaseline += (this.novSlow - this.novBaseline) * (dtHop / 8);
    const novRiser = this.novSlow > this.novBaseline + 0.15 && this.novSlow > 0.45;
    this.centSlow += (this.centSmooth - this.centSlow) * (dtHop / 2.5);
    this.lvlSlowR += (this.lvlSmooth - this.lvlSlowR) * (dtHop / 2.5);
    const inRiser = this.activeMs > 2500 && this.lvlSmooth > 0.3 && nowWallA - this.lastDropMs > 1500 && (
        novRiser
        || (this.centSmooth > this.centSlow + 0.06 && this.lvlSmooth > this.lvlSlowR + 0.04 && this.lvlSmooth > 0.4)
      );
    // Stampla uppbyggnaden — drop-villkoret ovan kraver att en riser fanns strax
    // innan. inRiser raknas fram EFTER drop-kontrollen, sa stampeln lases forst
    // nasta hop (2.7ms senare); helt utan betydelse mot 4000ms-fonstret.
    if (inRiser) this.lastRiserMs = nowWallA;
    const bTarget = inRiser ? 1 : 0;
    const bRate = bTarget > this.buildUp ? dtHop / 3.5 : dtHop / 1.0;   // bygg ~3.5s, klinga ~1s
    this.buildUp += Math.max(-bRate, Math.min(bRate, bTarget - this.buildUp));

    // ── KARAKTÄRSPROFIL (~8s) — musikens KARAKTÄR, inte dess energinivå ──
    // Banden är redan per-band AGC:ade (0..1 var), så vi jobbar med RELATIONER:
    // hur stor del av ljudbilden som är låg-end resp. luft, och hur transientrikt
    // det är. Långsam (8s) → stabil nog att styra effektval utan att fladdra.
    let bSum = 1e-6; for (let b = 0; b < 8; b++) bSum += this.bandLvl[b];
    const bassW = (this.bandLvl[0] + this.bandLvl[1] + this.bandLvl[2]) / bSum;   // sub+kick+bas
    const brightW = (this.bandLvl[6] + this.bandLvl[7]) / bSum;                    // diskant+luft
    const punchNow = Math.min(1, (this.bandOn[1] + this.bandOn[5] + this.bandOn[6]) * 0.8);  // kick+snare+hat-anslag
    const pr = 1 - Math.exp(-dtHop / 8.0);
    this.profPunch += (punchNow - this.profPunch) * pr;
    this.profBass += (bassW - this.profBass) * pr;
    this.profBright += (brightW - this.profBright) * pr;
    this.profBeat += (this.localBpmConfidence - this.profBeat) * pr;
    // Skala råvärdena till användbara 0..1-spann (typiska musikvärden → full range).
    const cl = (x: number) => x < 0 ? 0 : x > 1 ? 1 : x;
    // Skalningen är KALIBRERAD mot uppmätta råvärden på riktig musik (annars
    // mättar punch på 1.00 och bright ligger konstant högt → ingen diskriminering).
    this.outProfile.punch = cl((this.profPunch - 0.05) / 0.40);
    this.outProfile.bass = cl((this.profBass - 0.28) / 0.30);
    this.outProfile.bright = cl((this.profBright - 0.14) / 0.19);
    this.outProfile.beat = cl(this.profBeat);

    const L = this.bandLvl, O = this.bandOn;
    const spec = this.outSpec, onset = this.outOnset;
    spec.sub = L[0]; spec.kick = L[1]; spec.bass = L[2]; spec.lowMid = L[3]; spec.mid = L[4]; spec.highMid = L[5]; spec.treble = L[6]; spec.air = L[7];
    onset.sub = O[0]; onset.kick = O[1]; onset.bass = O[2]; onset.lowMid = O[3]; onset.mid = O[4]; onset.highMid = O[5]; onset.treble = O[6]; onset.air = O[7];
    const dr = this.outDrum;
    dr.kick = this.kickHit; dr.snare = this.snareHit; dr.hat = this.hatHit; dr.bass = L[2];

    // Mutera det återanvända Frame:t (spec/onset pekar redan på outSpec/outOnset).
    const f = this.outFrame;
    f.level = this.lvlSmooth; f.levelRaw = level; f.levelVU = this.lvlVU;
    f.energy = this.engSmooth; f.mid = this.midSmooth; f.treble = this.trbSmooth;
    f.centroid = this.centSmooth; f.flux = fluxNorm; f.kick = kick; f.gain = this.gain;
    f.bpm = this.localBpm; f.bpmConfidence = this.localBpmConfidence; f.intensity = intensity; f.beatAnchorMs = this.beatAnchorMs;
    f.dropCount = this.dropCount; f.inZone = inZone; f.breaking = breaking; f.buildUp = this.buildUp; f.inRiser = inRiser;
    return f;
  }
}

function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
