/**
 * Audio analyser — portable, framework-agnostic.
 *
 * ⚠️  MIRROR — DO NOT EDIT DIRECTLY. Read-only i Lotus.
 * Master: DMX Control / pi-dmx/engine/src/analyser.ts.
 * Synk från commit: b0442f3
 *   git log b0442f3..HEAD -- pi-dmx/engine/src/analyser.ts
 * För att uppdatera: ändra i DMX-projektet, commit:a där, kopiera hit,
 * uppdatera hashen ovan. Se README.md ("Source of truth").
 *
 * Feed hop-sized mono Float32 samples via process(samples). Returns a Frame
 * with level, kick, per-band spectrum/onset, BPM, drop/riser, intensity,
 * character profile, kickAtMs (sub-hop kick-tid) och barShift (taktfas).
 *
 * Design: two parallel FFTs
 *   - 512  @ every hop  → timing (RMS, kick, flux, BPM)
 *   - 2048 @ every 3rd hop → 8-band spectrum + per-band onsets (23 Hz/bin)
 *
 * Enda skillnaden mot mastern: EngineConfig är ersatt av en liten
 * AnalyserConfig (mappas till samma cfg-form internt) och beat-gridet
 * sätts utifrån via setBeatGrid() i stället för att läsas ur EngineConfig.
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
  /** Övre klamp för AGC-gainen (default 20). Höj när insignalen är rå mic utan pre-gain. */
  maxGain?: number;
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
                        // mid/treble på 512-FFT:n är BORTA: ingen effekt läste dem — effektlagret
                        // använder spec.mid/spec.treble ur 2048-FFT:ns oktavband, som är bättre
                        // upplösta. Två EMA + två bandsummor per hop gick åt till ingenting.

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
  /** >0 = ett trumslag är FÄRDIGMÄTT denna ruta: väggklocka för slagets flux-topp
   *  med sub-hop-precision (±1.3 ms). Kommer en hop EFTER frame.kick (parabeln
   *  behöver hoppet efter toppen) och är den enda tidsstämpel PLL:en får mäta
   *  fasfel mot — Date.now() vid rutans behandling bär ALSA-leveransens jitter. */
  kickAtMs: number;
  /** TAKTFAS: hur många slag ankaret ska flyttas FRAMÅT för att landa på ettan
   *  (0..3), eller -1 när fasen ännu är osäker. Motorn äger ankaret och applicerar. */
  barShift: number;
  /** Rikt spektrum + per-band onset (anslag) från dubbel-FFT:n (hög-upplöst). */
  spec: Spectrum;       // per-band NIVÅ (AGC 0..1)
  /** ABSOLUT per-band magnitud (INGEN AGC, ingen normalisering). Används av
   *  ljus-vägen: ljusstyrkan ska följa insignalen linjärt, inte AGC-normaliserad
   *  bandnivå (som mättar på 100 och gör ljuset nivå-oberoende). */
  specAbs: Spectrum;
  onset: Spectrum;      // per-band ONSET/anslag (halvvågs-flux mot adaptiv baslinje, 0..1)
  /** TRUM-KIT-envelopes (0..1): peak-hold + decay PÅ HOP-TAKT (375Hz) → fångar
   *  varje anslag, aldrig missat mellan två render-frames. kick=diskret kick +
   *  onset.kick, snare=highMid-onset, hat=treble-onset, bass=spec.bass (nivå). */
  drum: { kick: number; snare: number; hat: number; bass: number };
}


export class Analyser {
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
  private outSpecAbs: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
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
  private magBigMax = 0;                // högsta bin någon läser (band 8-taket)
  /** Cachade vyer (0..magBigMax) till specSink — subarray() per stor-FFT vore 125
   *  alloc/s. Vyerna växlas tillsammans med buffertarna, annars pekar de fel
   *  varannan frame. */
  private magBigView!: Float32Array;
  private prevMagBigView!: Float32Array;

  private specBig!: number[];           // scratch complex (fft.js createComplexArray)
  private static readonly BAND_HZ = [20, 60, 120, 250, 500, 2000, 5000, 10000, 16000];
  private bandLo: number[] = [];        // bin-start per band (förberäknat)
  private bandHi: number[] = [];        // bin-slut per band
  private bandPeak = new Float32Array(8);  // per-band AGC-peak (själv-skalande nivå)
  private bandAbs = new Float32Array(8);   // per-band ABSOLUT magnitud (pre-AGC, för ljus-vägen)
  private onsetMed = new Float32Array(8);  // robust glidande median av per-band-fluxen
  private onsetMad = new Float32Array(8);  // robust MAD -> troskelspridning per band
  private static readonly ONSET_K = 3.0;   // troskel = median + K*MAD
  private onsetBase = new Float32Array(8); // per-band adaptiv flux-baslinje (onsets)
  private bandLvl = new Float32Array(8);   // scratch: per-band nivå denna frame (~90ms smoothad)
  private bandLvlSm = new Float32Array(8); // per-band nivå-smooth (håll mellan frames)
  private bandOn = new Float32Array(8);    // scratch: per-band onset denna frame
  private bigCounter = 0;                  // decimering av 2048-FFT:n (se BIG_EVERY)
  private static readonly BIG_EVERY = 3;   // kor stor-FFT var N:e hop → analysen ryms i realtid
  /** bandPeak-decay per stor-FFT (τ ≈ 3.8 s oavsett BIG_EVERY). */
  private static readonly PEAK_DECAY = Math.pow(0.9993, Analyser.BIG_EVERY);
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
  // 90..180 = EXAKT en oktav → vikningen är entydig. (80..180 gav 2.25× och
  // tvetydighet i 80–90.) Snabba låtar presenteras dubbelt av dirigentens
  // auto-dubbel (beatDoubleBelowBpm), inte genom att vidga spannet.
  private static readonly BPM_MIN = 80;    // festintervall; MAX maste vara exakt 2x MIN
  private static readonly BPM_MAX = 160;
  private octaveVote = 0;   // ackumulerat bevis för att byta oktav (självrättande lås)
  private nearVote = 0;     // bevis för GRANN-fel (t.ex. 122 låst mot 136): bara före commit
  private nearChallenger = 0;  // tempot grann-rösterna pekar på (måste hålla ihop, som challengerBpm)
  private bpmStable = 0;    // antal stabila (finjusterings-)estimat i rad → committa oktaven
  private challengerBpm = 0;   // tempot rösterna faktiskt pekar på (måste hålla ihop)
  private lockPeak = 0;        // tempogram-toppens styrka när takten är frisk (referens)
  private lastSongVoteMs = 0;  // väggklocka för förra låtbytesrösten (bevis mäts i TID)
  private newSongVote = 0;  // ihållande oenighet trots låst oktav → låtbyte utan tystnadslucka
  /** Väggklocka: t.o.m. denna tid gäller vidgad tempo-sökning efter en låtbytes-hint. */
  private reacqUntilMs = 0;

  // Ringbuffert för senaste råestimat (~5s) → median-stabilisering utan allokering.
  private static readonly BPM_HIST = 20;
  private bpmHist = new Float64Array(Analyser.BPM_HIST);
  private bpmHistLen = 0;
  private bpmHistPos = 0;
  private bpmSortScratch = new Float64Array(Analyser.BPM_HIST);
  // Förberäknade EMA-alfor / decay-faktorer (fasta dtHop + fasta tidskonstanter).
  private dtHop = 0; private hopMs = 0;

  private aAtt = 0; private aRel = 0; private aVU = 0;
  private aIUp = 0; private aIDown = 0; private aBandLvl = 0;
  private dHat = 0; private dSnare = 0; private dKick = 0;
  private aSpecSlow = 0; private aNovSlow = 0; private aProf = 0;
  // Pre-allokerade scratchpads för computeBpm (GC-skydd; annars 4× Float32Array/anrop).
  private envScratch = new Float32Array(Analyser.ENV_LEN);
  private envPosScratch = new Float32Array(Analyser.ENV_LEN);
  private acScratch = new Float32Array(Analyser.ENV_LEN);
  private pulseScratch = new Float32Array(Analyser.ENV_LEN);
  private combScratch = new Float64Array(Analyser.ENV_LEN);
  private prefScratch = new Float64Array(Analyser.ENV_LEN + 1);   // prefix-summa → lokalt medel (whitening)
  /** BASBANDETS onset-envelope (kick-flux), samma raster och position som envRing. */
  private envBassRing = new Float32Array(Analyser.ENV_LEN);
  private envBassAccum = 0;
  private scoreFull = new Float64Array(Analyser.ENV_LEN);
  private scoreBass = new Float64Array(Analyser.ENV_LEN);
  /** Ackumulerat tempogram (EMA av hela lag-kurvan mellan anrop). */
  private tempoGram = new Float64Array(Analyser.ENV_LEN);
  private lastVoteMs = 0;   // tidsviktad median-röstning (max 4 röster/s)
  private lastConfMs = 0;   // tidsbaserad alpha för bpmConfidence (stride-oberoende)
  /** TAKTFAS: vikt per taktslags-plats (idx mod 4) mot cfg.beat-gridet. Ettan bär
   *  tyngsta slaget i så gott som all dansmusik — den plats som samlar mest
   *  kick-tyngd ÄR ettan. Glöms långsamt så ett låtbyte kan flytta fasen. */
  private barAcc = new Float64Array(4);
  private barCount = 0;        // antal bokförda slag (bevisunderlag för taktfasen)
  /** Perceptuell prior (log-Gauss runt 120 BPM) per lag — lagg→BPM ar fast, sa
   *  de ~78 Math.exp()-anropen per computeBpm-anrop kan bakas en gang. */
  private priorLut = (() => {
    const t = new Float64Array(Analyser.ENV_LEN);
    for (let lag = 1; lag < Analyser.ENV_LEN; lag++) {
      const oct = Math.log2(((Analyser.ENV_HZ * 60) / lag) / 120);
      t[lag] = Math.exp(-(oct * oct) / 2.0);
    }
    return t;
  })();
  private silentMs = 0;
  private silenceArmed = false;   // flank-trigg för tystnads-släppningen
  private lowConfSinceMs = 0;     // när localBpmConfidence senast var >= 0.3
  private beatAnchorMs = 0;
  // #2 sub-hop fas: kick-flankens flux-topp ligger sällan exakt på en hop. Vi
  // sparar de två föregående kick-flux-värdena och gör parabolisk interpolation
  // hoppet EFTER en kick → förfinar beatAnchorMs med ±0.5 hop (~1.3ms). Ren
  // fas-korrektion; själva kick-blixten fyrar oförändrat direkt.
  private kfPrev = 0;
  private kfPrev2 = 0;
  private pendingKickMs = 0;   // >0 = kick väntar på fas-förfining nästa hop
  private pendingKickW = 1;    // slagets styrka (flux/tröskel) — vikt i taktfas-räkningen
  private gain = 1;
  // Attack/release-smoothed outputs — raw per-hop values update ~370x/s and
  // read as flicker on the lamps. Fast attack keeps hits punchy; the slower
  // release lets light glide down instead of sputtering.
  private lvlSmooth = 0;
  private intensityEma = 0.5;    // sektionsenergi: utjämnad nivå
  private intensityFloor = 0.5;  // dess robusta P50-baslinje (låtens snitt)
  private intensitySpread = 0.05;  // glidande medelabsolutavvikelse (EJ median-MAD) → sjalvkalibrerande skala
  private activeMs = 0;          // hur länge musik spelat (warmup för baslinjen)
  // DROP-DETEKTION (flyttad från effects: analys hör hemma här; show-reaktionen stannar där)
  private levelCeil = 0.5;       // långsamt nivå-tak (låtens loud-topp)
  private lastRiserMs = 0;       // senaste uppbyggnad (reserverad: riser-kravet är avstängt)

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
  private centSmooth = 0.5;

  /** Called when the input routing changes — the old gain is meaningless for
   *  the new source's signal level, so re-converge from neutral. */
  private gainLocked = false;
  // Percentil-AGC: 16 block-maxima à 128 ms ≈ 2 s historik av RÅ rms.
  private agcBlocks = new Float32Array(16);
  private agcBlockIdx = 0;
  private agcBlockMax = 0;
  private agcBlockMs = 0;

  private resetAgcWindow(seedRms = 0) {
    this.agcBlocks.fill(seedRms);
    this.agcBlockIdx = 0;
    this.agcBlockMax = 0;
    this.agcBlockMs = 0;
    this.envelope = seedRms;
  }

  resetGain(startGain = 1) {
    // Seed per input: line (aux) arrives hot -> 1x; the room mic is weak -> ~20x.
    // Klampas mot cfg.maxGain (inte hårdkodat 20) — mic-tappen körs o-gainad och
    // behöver 100-tals × , så en 20×-klamp skulle göra seedningen meningslös.
    this.gain = Math.max(0.5, Math.min(this.cfg.detection.maxGain, startGain));
    // Percentil-fönstret seedas ur seed-gainen: envelope är nu RÅ rms-percentil,
    // så det konsistenta startvärdet är target/gain (ger desired == startGain).
    this.resetAgcWindow(this.cfg.detection.autoGainTarget / this.gain);
  }


  /** Lock the AGC (aux: fixed 1x, level tracks the mixer directly) or let it run. */
  setGainLock(locked: boolean, fixed = 1) {
    this.gainLocked = locked;
    if (locked) { this.gain = fixed; this.resetAgcWindow(this.cfg.detection.autoGainTarget / fixed); }
  }


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
  /** Autokorrelation + comb + pulse-xcorr + prior för EN onset-envelope.
   *  Fyller `out[lagMin..lagMax]` med normaliserad score och returnerar bandets
   *  medelenergi (0 = tyst band → anroparen kan vikta ner det). Scratcharna håller
   *  efteråt den SENAST scorade envelopen — off-beat-testet och den paraboliska
   *  interpolationen läser dem, så helbandet måste scoras sist. */
  private scoreEnv(ring: Float32Array, N: number, out: Float64Array, lagMin: number, lagMax: number): number {
    const L = Analyser.ENV_LEN;
    const env = this.envScratch;
    const pre = this.prefScratch;
    const start = (this.envPos - N + L) % L;
    let energy = 0;
    pre[0] = 0;
    // Ringen läses i TVÅ RAKA BLOCK. `% L` i den inre loopen kostade en modulo per
    // sampel (N upp till 500, två anrop per computeBpm) helt i onödan.
    const n1 = Math.min(N, L - start);
    for (let i = 0; i < n1; i++) {
      const v = ring[start + i];
      env[i] = v; energy += v; pre[i + 1] = pre[i] + v;
    }
    for (let i = n1; i < N; i++) {
      const v = ring[i - n1];
      env[i] = v; energy += v; pre[i + 1] = pre[i] + v;
    }

    // WHITENING: subtrahera ett LOKALT medel (1 s glidande) i stället för det
    // globala. En långsam nivådrift inom fönstret (uppbyggnad, breakdown, AGC som
    // andas) läcker annars rakt in i autokorrelationen och lyfter de långa laggen.
    const half = Analyser.ENV_HZ >> 1;
    for (let i = 0; i < N; i++) {
      const lo = i - half > 0 ? i - half : 0;
      const hi = i + half + 1 < N ? i + half + 1 : N;
      env[i] -= (pre[hi] - pre[lo]) / (hi - lo);
    }
    // 1) Rå autokorrelation, LENGTH-NORMALISERAD: /(N-lag) tar bort biasen mot
    //    korta lag (annars vinner alltid snabb takt eftersom fler termer bidrar).
    const ac = this.acScratch;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let sum = 0;
      const M = N - lag;
      for (let i = 0; i < M; i++) sum += env[i] * env[i + lag];
      ac[lag] = sum / M;
    }
    // Halvvågsrektifierad envelope (positiv del) — pulse xcorr använder bara energi PÅ slaget.
    const envPos = this.envPosScratch;
    for (let i = 0; i < N; i++) envPos[i] = env[i] > 0 ? env[i] : 0;
    // 2) COMB-SCORING: ac(L) + ½·ac(2L) + ⅓·ac(3L). En äkta beat-period resonerar
    //    även på dubbla/trippla lag — enskilda toppar gör det inte. (Klapuri.)
    // 3) PULSE-TRAIN CROSS-CORRELATION (Percival-Tzanetakis 2014, Essentia):
    //    korrelera envelopen mot en idealiserad pulsserie vid bästa fas. Fångar
    //    regelbundenheten även när AC är utsmetad (mjuka onsets, synkoperingar).
    const pulse = this.pulseScratch;
    const combArr = this.combScratch;
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
      combArr[lag] = comb;
      if (comb > combMax) combMax = comb;
    }
    // Normalisera båda till [0,1] och rösta jämnt — så de kan väga upp varandra.
    // AC svarar starkt på självlikhet, pulse xcorr på regelbunden energi-fördelning.
    // 4) PERCEPTUELL PRIOR: log-Gauss runt 120 BPM, σ = 1.0 oktav (Ellis/librosa).
    for (let lag = lagMin; lag <= lagMax; lag++) {
      out[lag] = (0.5 * (combArr[lag] / combMax) + 0.5 * (pulse[lag] / pulseMax)) * this.priorLut[lag];
    }
    return energy / N;
  }

  private computeBpm() {
    if (this.envFilled < 50) return;   // ~0.5s → snabbt första grovestimat (täcker ≥~122 BPM;
                                       //  långsammare spår låser på overton tills fönstret växer),
                                       //  förfinas löpande. Halverar time-to-first-lock.
    const N = this.envFilled;
    const HZ = Analyser.ENV_HZ;
    const lagMin = Math.floor(HZ * 60 / 185);
    const lagMax = Math.min(N - 1, Math.floor(HZ * 60 / 55));   // sokfonstret ar bredare an vikningen med flit
    // FLERBANDS-ONSET: helbandsfluxen smetas ut av sång och synth — slaget bor i
    // basen. Två OBEROENDE score-kurvor som röstar ihop rättar just de fall där
    // off-beat-testet annars tvekar mellan ballad och danslåt. Helbandet scoras
    // SIST eftersom scratcharna (env/envPos) används nedan.
    const eBass = this.scoreEnv(this.envBassRing, N, this.scoreBass, lagMin, lagMax);
    const eFull = this.scoreEnv(this.envRing, N, this.scoreFull, lagMin, lagMax);
    if (eFull <= 0 && eBass <= 0) return;
    const wBass = eBass > eFull * 0.15 ? 0.55 : 0;   // tomt basband → helbandet ensamt
    const wFull = 1 - wBass;
    // TEMPOGRAM-ACKUMULERING: förr kastades hela score-kurvan varje anrop och bara
    // toppen sparades, varpå medianen fick städa upp efteråt (~5 s till lås). Nu
    // EMA:as HELA lag-kurvan mellan anrop, så bevis ackumuleras där det hör hemma:
    // låset kommer på 1–2 s och oktav-flippar dör innan de hinner synas.
    const a = this.localBpm === 0 ? 0.30 : 0.15;
    const tg = this.tempoGram;
    let bestLag = 0, bestVal = 0, scoreSum = 0, scoreCount = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const s = wFull * this.scoreFull[lag] + wBass * this.scoreBass[lag];
      const v = tg[lag] + (s - tg[lag]) * a;
      tg[lag] = v;
      scoreSum += v; scoreCount++;
      if (v > bestVal) { bestVal = v; bestLag = lag; }
    }
    const envPos = this.envPosScratch;   // helbandets rektifierade envelope (scoreEnv körde sist)


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
    // Läser acScratch (råa autokorrelationen), INTE tempoGram: PROVAT (2026-08-23)
    // att interpolera på samma yta toppen valdes ur, men tempogrammets prior-vikt är
    // en lutning över lag och drog vertexen mot 120 BPM (128→127, 150→149, taktfas
    // 128→129). Råkurvan är symmetrisk kring toppen och landar exakt.
    // ÄVEN PROVAT (2026-08-23): (wFull·scoreFull + wBass·scoreBass) / priorLut, dvs
    // bandviktad yta med priorn dividerad bort. Samma bias kvar (128→127.0,
    // 140→139.0, 150→149.0) — comb/pulse-normaliseringen i scoreEnv är inte heller
    // symmetrisk kring toppen. acScratch ger 128.0/140.0/150.0 exakt. Behålls.
    let lagF = bestLag;
    if (bestLag - 1 >= lagMin && bestLag + 1 <= lagMax) {
      const yl = this.acScratch[bestLag - 1], y0 = this.acScratch[bestLag], yr = this.acScratch[bestLag + 1];
      const den = yl - 2 * y0 + yr;
      if (den < 0) { const d = 0.5 * (yl - yr) / den; if (Math.abs(d) < 1) lagF = bestLag + d; }
    }


    let bpm = (HZ * 60) / lagF;
    // BPM-FILTER: vik in i 90..180 — festmusik ligger dar, och allt utanfor ar
    // en oktav-artefakt (en 76-BPM-last ar i praktiken 152, en 170 ar 85).
    // Intervallet MASTE spanna exakt en oktav (max = 2x min): med t.ex. 80..150
    // blir 155 -> 77.5 -> 155 -> 77.5 i all evighet och motorn hanger.
    // STRUKTURELL FÖLJD (2026-08-28): eftersom MAX === 2*MIN kollapsar b och 2b till
    // SAMMA representant. Alltså: ett äkta oktavfel kan aldrig visa sig som ratio≈2 —
    // det visar sig som ratio≈1. ratio>1.4 / <0.7 är därför INTE oktavgrenar; de
    // fångar 3:2-/triol-artefakter och wrap-sömmen kring 90/180. Off-beat-testet
    // (bestLag = P) upphävs exakt av vikningen och är en no-op för oktaven.
    while (bpm < Analyser.BPM_MIN) bpm *= 2;
    while (bpm >= Analyser.BPM_MAX) bpm /= 2;
    // Median över RÅestimaten (utan oktav-tvång) → dämpar brus men låser inte
    // fast oktaven, så en fel initial låsning kan rättas. Långt fönster (~5s) för
    // att inte studsa på brusiga/tvetydiga låtar.
    // TIDSVIKTAD RÖSTNING: före lås körs computeBpm() 100 Hz, så de 20 "rösterna"
    // var samma 0.2 s data tjugo gånger — ingen medianvinst, bara fördröjning.
    // Max en röst per 250 ms ⇒ fönstret täcker verkligen ~5 s.
    const HN = Analyser.BPM_HIST;
    const voteNow = this.perfNow();
    if (this.bpmHistLen === 0 || voteNow - this.lastVoteMs >= 250) {
      this.lastVoteMs = voteNow;
      this.bpmHist[this.bpmHistPos] = bpm;
      this.bpmHistPos = (this.bpmHistPos + 1) % HN;
      if (this.bpmHistLen < HN) this.bpmHistLen++;
    }
    const n = this.bpmHistLen;
    const scratch = this.bpmSortScratch;
    for (let i = 0; i < n; i++) scratch[i] = this.bpmHist[(this.bpmHistPos - n + i + HN) % HN];
    for (let i = 1; i < n; i++) {           // insertion sort (n ≤ 20, redan nästan sorterad)
      const v = scratch[i]; let j = i - 1;
      while (j >= 0 && scratch[j] > v) { scratch[j + 1] = scratch[j]; j--; }
      scratch[j + 1] = v;
    }
    const med = scratch[n >> 1];
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
      // ASYMMETRIN ÄR MEDVETEN: 24 (~6 s) för oktav-låset — låset hann annars aldrig
      // committa innan tempot rörde sig (MÄTT: spann 96–146 → 142–143 BPM) — men 60
      // (~15 s) för låtbytes-vakten nedan, som ska vara konservativ.
      const committed = this.bpmStable >= 24;      // OKTAV-LÅS: ~6 s
      const ratio = med / this.localBpm;
      if (ratio >= 0.9 && ratio <= 1.11) {
        this.nearVote = 0; this.nearChallenger = 0;                                 // samma takt → inget grann-fel
        this.localBpm = Math.round(this.localBpm + (med - this.localBpm) * 0.35);   // samma takt → glid
        this.octaveVote *= 0.5;
        // Referens för hur STARK takten är när allt är gott — låtbytesgrinden nedan
        // jämför mot den (ett breakdown har svag takt, en ny låt en full).
        this.lockPeak = this.lockPeak > 0 ? this.lockPeak + (bestVal - this.lockPeak) * 0.05 : bestVal;
        if (this.bpmStable < 100000) this.bpmStable++;                              // stabil tid ackumuleras
      } else if (!committed && ratio > 1.4) {
        this.octaveVote = Math.max(0, this.octaveVote) + 1;                          // estimaten HÖGRE oktav
        if (this.octaveVote >= 8) { this.localBpm = Math.round(med); this.octaveVote = 0; this.bpmStable = 0; }
      } else if (!committed && ratio < 0.7) {
        this.octaveVote = Math.min(0, this.octaveVote) - 1;                          // estimaten LÄGRE oktav
        if (this.octaveVote <= -8) { this.localBpm = Math.round(med); this.octaveVote = 0; this.bpmStable = 0; }
      } else if (!committed && ratio >= 0.7 && ratio <= 1.4) {   // GRANNRÄTTNING
        // ett tidigt lås från 0.5 s fönster kan hamna 10-20 % fel
        // (MÄTT: brusigt rum 136 låste 122 på en av åtta brus-seeder och satt kvar
        // hela låten — glid-bandet slutar vid 1.11 och oktav-grenen börjar vid 1.4,
        // så felet låg i ett dödområde). Räknas bara före commit.
        // SAMMA TRE SKYDD som låtbytesvägen, av samma mätta skäl:
        //   1. SAMMANHÅLLEN UTMANARE — brus är oense men pekar ingenstans; utan detta
        //      kunde estimat som studsar 0.75×↔1.3× rösta fram ett byte och låsa på
        //      vad `med` råkade vara.
        //   2. KVALITETSGRIND — conf-golv, annars kan ett intro/en tidig break (där
        //      råestimatet vandrar) yanka låset under de första 15 s.
        //   3. HISTORIKEN TÖMS vid omlåsning — annars drar medianfönstret, halvfullt
        //      av det felaktiga tempot, tillbaka och låset glider i stället för att landa.
        // LÅTBYTES-HINT (Sonos): under re-acquisition-fönstret sänks kvalitetsgrinden
        // och röstkravet, så en ny takt kan bekräftas på ~2-3 s i stället för ~5 s.
        // Skydden finns kvar (sammanhållen utmanare + tömd historik) — bara mildare.
        const reacq = voteNow < this.reacqUntilMs;
        if (conf < (reacq ? 0.55 : 0.75)) {
          this.nearVote = 0; this.nearChallenger = 0;
        } else if (this.nearChallenger > 0 && Math.abs(bpm / this.nearChallenger - 1) <= 0.04) {
          this.nearChallenger += (bpm - this.nearChallenger) * 0.3;
          this.nearVote++;
          if (this.nearVote >= (reacq ? 3 : 8)) {
            this.localBpm = Math.round(med);
            this.bpmHistLen = 0; this.bpmHistPos = 0;
            this.nearVote = 0; this.nearChallenger = 0; this.octaveVote = 0; this.bpmStable = 0;
          }
        } else {
          this.nearChallenger = bpm; this.nearVote = 1;
        }
      } else {
        this.octaveVote *= 0.7;                                                      // committad off-oktav → brus
      }

      // ── LÅTBYTE UTAN TYSTNADSLUCKA ────────────────────────────────────────────
      // Låset ovan nollställs annars BARA av 350 ms tystnad — men crossfade, DJ-set
      // och gapless spelning har ingen. Då satt localBpm fast på första låtens tempo
      // resten av kvällen och hela takt-gridet var fel.
      //
      // Beslutet ligger UTANFÖR median-grenarna och mäts på RÅestimatet. MÄTT
      // 2026-08-23 på crossfade 128→146: tempogrammet pekade om inom ~0,4 s, men
      // 5 s-medianen låg kvar innanför ±11 % i sex sekunder — alltså tog "samma
      // takt"-grenen hand om rutan och rösträkningen startade inte ens förrän 26,9 s.
      // Omlåsning skedde 28,4 s (8,4 s efter bytet). Med rå bedömning startar
      // beviset direkt vid bytet; medianen får fortsätta sköta glid och oktav.
      //
      // TRE VILLKOR måste hålla SAMTIDIGT, annars vädras beviset ut (×0.7):
      //   1. RÅ OENIGHET   estimatet ligger >11 % från låset (samma band som glidet).
      //   2. SAMMA UTMANARE varje estimat inom 4 % glider in i challengerBpm; allt
      //      annat nollställer. Brus är oense men pekar ingenstans — det ska inte
      //      kunna ackumulera fram ett låtbyte (MÄTT: brusigt rum tappade takten helt
      //      när räkningen inte krävde en sammanhållen utmanare).
      //   3. DOMINANS       hur mycket bättre är utmanarens lag än den låstas i det
      //      ackumulerade tempogrammet? Ett breakdown gör låset svagare men ger ingen
      //      dominant rival — en ny låt gör det.
      // Rösterna räknas i TID, inte i anrop: stride växlar 100→20 Hz med låset.
      const committedNow = this.bpmStable >= 24;   // SAMMA tröskel som oktav-låset: 60 gav dödläge
      const rawOff = Math.abs(bpm / this.localBpm - 1) > 0.11;
      const sameChallenger = this.challengerBpm > 0 && Math.abs(bpm / this.challengerBpm - 1) <= 0.04;
      // 4. FRISK TAKT. Ett breakdown ser ut som ett låtbyte i allt utom kvaliteten:
      //    MÄTT 2026-08-23 (breakdown 142) låg conf 0.58–0.70 och tempogram-toppen på
      //    ~0.5 mot 0.9 i den friska delen, och råestimatet vandrade till ~107 medan
      //    basen kom tillbaka — tillräckligt för att fälla låset (BPM 142→111).
      //    En riktig ny låt har full topp och conf ~1.0. Så: bara ett TYDLIGT tempo
      //    får rösta bort ett fungerande lås.
      const healthy = conf >= 0.9 && (this.lockPeak <= 0 || bestVal >= this.lockPeak * 0.8);
      if (!committedNow || !rawOff || !healthy) {
        this.newSongVote *= 0.7;
        if (this.newSongVote < 0.5) { this.newSongVote = 0; this.challengerBpm = 0; }
      } else if (!sameChallenger) {
        this.challengerBpm = bpm;                 // ny riktning → beviset börjar om
        this.newSongVote = 0;
        this.lastSongVoteMs = voteNow;
      } else {
        this.challengerBpm += (bpm - this.challengerBpm) * 0.2;
        const lockLag = Math.round((HZ * 60) / this.localBpm);
        const rival = lockLag >= lagMin && lockLag <= lagMax
          ? bestVal / Math.max(1e-9, tg[lockLag]) : 1;
        // Dominant rival ⇒ 1,5 s bevis. Svag ⇒ 25 s, som förr: MÄTT tidigare att 6 s
        // halverade BPM 145→73→144 mitt i en låt när ett breakdown nådde tröskeln.
        const needMs = rival > 2.5 ? 1500 : rival > 1.6 ? 4000 : 25000;
        const dtVote = this.lastSongVoteMs > 0 ? Math.min(200, voteNow - this.lastSongVoteMs) : 0;
        this.lastSongVoteMs = voteNow;
        this.newSongVote += dtVote;
        if (this.newSongVote >= needMs) {
          // Lås på UTMANAREN, inte medianen, och kasta historiken: ett medianfönster
          // halvfullt av förra låtens tempo kostade flera sekunder till rätt takt.
          this.localBpm = Math.round(this.challengerBpm);
          this.bpmHistLen = 0; this.bpmHistPos = 0; this.lastVoteMs = 0;
          this.challengerBpm = 0;
          this.newSongVote = 0;
          this.octaveVote = 0;
          this.bpmStable = 0;   // nytt lås får byggas om från början
          this.lockPeak = 0;
        }
      }
    }
    // Smooth confidence (undvik hoppig UI); attack snabbt, release långsamt.
    // TIDSBASERAD alpha: computeBpm() körs 100 Hz olåst men 4 Hz låst (adaptiv
    // stride). Med fasta 0.35/0.08 rörde konfidensen sig 5× olika snabbt beroende
    // på läge — och den grindar kick-gridet (>0.5), PLL-frekvenstermen (>0.4) och
    // hjärtslagets djup. Tidskonstanterna (25 ms upp, 120 ms ner) är valda så att
    // beteendet i OLÅST läge är exakt som förut.
    const dt = this.lastConfMs > 0 ? Math.min(0.5, (voteNow - this.lastConfMs) / 1000) : 0.01;
    this.lastConfMs = voteNow;

    const cA = this.localBpmConfidence;
    const aC = 1 - Math.exp(-dt / (conf > cA ? 0.025 : 0.120));
    this.localBpmConfidence = cA + (conf - cA) * aC;

    // SLÄPPNING SOM INTE BYGGER PÅ TYSTNAD: Sonos-låtbyteshinten missas i TV-/SPDIF-
    // läge (definierat som avsaknad av trackName), på radio/streams där spårnamnet
    // aldrig ändras, och under pollnings-backoff (upp till 30 s). I ett bryggeri
    // återställs dessutom silentMs av en hostning eller en dörr. Så: har takten varit
    // svag (< 0.3) i mer än 8 s är låset inte längre trovärdigt → släpp committen.
    if (this.localBpmConfidence >= 0.3) {
      this.lowConfSinceMs = voteNow;
    } else if (this.lowConfSinceMs > 0 && voteNow - this.lowConfSinceMs > 8000) {
      this.lowConfSinceMs = voteNow;
      this.hintTrackChange(5000, true);   // släpp LÅSET, behåll tempo-gissningen
    } else if (this.lowConfSinceMs === 0) {
      this.lowConfSinceMs = voteNow;
    }
  }

  /**
   * LÅTBYTES-HINT = REN OMLÅSNING. Att behålla `localBpm` som startgissning gjorde att
   * varje låt öppnade med FÖRRA låtens tempo och hill-climbade dit rätt (MÄTT: 3.5–23.4 s,
   * en låt satt 5–8 s per steg i en trappa uppåt). `localBpm = 0` ger dessutom stride 1
   * (fri sökning) i stället för 25. Utöver tempot:
   *   • historiken töms (medianfönstret tillhör förra låten),
   *   • oktav-commit släpps (bpmStable=0) så ½×/2× får rättas igen,
   *   • lockPeak nollas så nya låtens takt inte jämförs mot förra låtens styrka,
   *   • under `windowMs` sänks grann-rättningens conf-grind och röstkrav.
   * @param keepBpm true = behåll tempo-gissningen (tystnads-vägen: ett kort uppehåll
   *   mitt i en låt ska släppa LÅSET men inte kasta takten).
   */
  hintTrackChange(windowMs = 5000, keepBpm = false): void {
    if (!keepBpm) {
      this.localBpm = 0;
      this.localBpmConfidence = 0;
      this.tempoGram.fill(0);
    }
    // A5: reacq-fönstret jämförs mot perfNow() (samma tidbas som voteNow).
    // Date.now() gjorde `voteNow < reacqUntilMs` alltid falskt → hinten var död.
    this.reacqUntilMs = this.perfNow() + windowMs;
    this.bpmHistLen = 0; this.bpmHistPos = 0; this.lastVoteMs = 0;
    this.bpmStable = 0; this.lockPeak = 0;
    this.octaveVote = 0; this.nearVote = 0; this.nearChallenger = 0;
    this.newSongVote = 0; this.challengerBpm = 0; this.lastSongVoteMs = 0;
    this.barAcc.fill(0); this.barCount = 0;
  }


  /** Taktfasen är applicerad av motorn (ankaret flyttat) → börja om räkningen. */
  resetBar(): void { this.barAcc.fill(0); this.barCount = 0; }

  private envelope: number;
  private lastKick = 0;
  // 0 = "ej satt". Får INTE seedas med performance.now(): vid virtuell klocka
  // (perfNow → virtualMs, startar nära 0) blir första dt negativ → exp(+stort)
  // → NaN i envelope/gain, och NaN passerar båda clamparna nedan.
  private lastT = 0;
  /** Löpande kvadratsumma över `buffer` (glidande RMS) + räknare för full omräkning. */
  private sumSq = 0;
  private rmsRecalc = 0;

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

  // Lotus-adapter: samma cfg-form som mastern, men matad ur AnalyserConfig.
  private cfg: {
    audio: { rate: number };
    fft: { size: number; hop: number };
    detection: { autoGainTarget: number; tauUp: number; tauDown: number; noiseFloor: number; maxGain: number };
    beat: BeatGrid | null;
  };
  /** Optional external beat grid (from a PLL). Null = no grid gate on kicks. */
  setBeatGrid(grid: BeatGrid | null) { this.cfg.beat = grid; }

  constructor(cfgIn: AnalyserConfig) {
    const cfg = this.cfg = {
      audio: { rate: cfgIn.sampleRate },
      fft: { size: cfgIn.fftSize ?? 512, hop: cfgIn.hopSize },
      detection: {
        autoGainTarget: cfgIn.autoGainTarget ?? 0.15,
        tauUp: cfgIn.tauUp ?? 3,
        tauDown: cfgIn.tauDown ?? 8,
        noiseFloor: cfgIn.noiseFloor ?? 0.002,
        maxGain: cfgIn.maxGain ?? 20,
      },
      beat: null,
    };
    this.fft = new FFT(cfg.fft.size);
    this.window = hannWindow(cfg.fft.size);
    this.buffer = new Float32Array(cfg.fft.size);
    this.prevMag = new Float32Array(cfg.fft.size / 2);
    this.windowed512 = new Float32Array(cfg.fft.size);
    this.spectrum512 = this.fft.createComplexArray();
    this.mag512 = new Float32Array(cfg.fft.size / 2);
    this.envelope = cfg.detection.autoGainTarget;
    // Dubbel-FFT: 2048 för hög låg-uppl. Egen buffert, matas samma hop-chunks.
    const BIG = 2048;
    this.fftBig = new FFT(BIG);
    this.windowBig = hannWindow(BIG);
    this.windowedBig = new Float32Array(BIG);
    this.bufferBig = new Float32Array(BIG);
    this.prevMagBig = new Float32Array(BIG / 2);
    this.magBig = new Float32Array(BIG / 2);
    this.specBig = this.fftBig.createComplexArray();
    const binHzBig = cfg.audio.rate / BIG;
    for (let b = 0; b < 8; b++) {
      this.bandLo[b] = Math.max(1, Math.round(Analyser.BAND_HZ[b] / binHzBig));
      this.bandHi[b] = Math.min(BIG / 2, Math.round(Analyser.BAND_HZ[b + 1] / binHzBig));
      this.bandPeak[b] = 1e-4;   // seed → själv-kalibrerar inom ~1s
    }
    this.magBigMax = Math.min(BIG / 2, this.bandHi[7] + 1);
    this.magBigView = this.magBig.subarray(0, this.magBigMax);
    this.prevMagBigView = this.prevMagBig.subarray(0, this.magBigMax);

    // FÖRBERÄKNADE EMA-ALFOR. dtHop och alla tidskonstanter är fasta, så de 11
    // Math.exp()-anropen per hop (~4000/s vid 375 Hz) hörde inte hemma i tick-vägen.
    const dtHop = cfg.fft.hop / cfg.audio.rate;
    this.dtHop = dtHop;
    this.hopMs = dtHop * 1000;
    const bigDt = dtHop * Analyser.BIG_EVERY;

    this.aAtt = 1 - Math.exp(-dtHop / 0.015);
    this.aRel = 1 - Math.exp(-dtHop / 0.4);
    this.aVU = 1 - Math.exp(-dtHop / 0.20);
    this.aIUp = 1 - Math.exp(-dtHop / 1.5);
    this.aIDown = 1 - Math.exp(-dtHop / 3.0);
    this.aBandLvl = 1 - Math.exp(-bigDt / 0.09);
    this.dHat = Math.exp(-dtHop / 0.06);
    this.dSnare = Math.exp(-dtHop / 0.11);
    this.dKick = Math.exp(-dtHop / 0.15);
    this.aSpecSlow = 1 - Math.exp(-dtHop / 2.0);
    this.aNovSlow = 1 - Math.exp(-dtHop / 1.5);
    this.aProf = 1 - Math.exp(-dtHop / 8.0);
    // Ett återanvänt Frame (spec/onset pekar på de pre-allokerade objekten).
    this.outFrame = {
      level: 0, levelRaw: 0, levelVU: 0, energy: 0, centroid: 0, flux: 0,
      kick: false, gain: 1, bpm: 0, bpmConfidence: 0, intensity: 0.5,
      dropCount: 0, inZone: false, breaking: false, buildUp: 0, inRiser: false, profile: this.outProfile, beatAnchorMs: 0,
      kickAtMs: 0, barShift: -1,
      spec: this.outSpec, specAbs: this.outSpecAbs, onset: this.outOnset, drum: this.outDrum,
    };
  }

  /** Feed a hop-sized chunk of mono samples, get a frame back. */
  process(samples: Float32Array): Frame {
    // Slide buffer left by hop, append new samples at end.
    const hop = samples.length;
    // RMS på rå (o-fönstrad) buffert — LÖPANDE SUMMA. Bufferten glider en hop i
    // taget, så det räcker att dra av utgående hop och lägga till den inkommande
    // (128 ops i stället för 512 kvadrater, 375 gånger i sekunden). Full omräkning
    // ~1×/s mot flyttalsdrift.
    let ss = this.sumSq;
    for (let i = 0; i < hop; i++) { const v = this.buffer[i]; ss -= v * v; }
    this.buffer.copyWithin(0, hop);
    this.buffer.set(samples, this.buffer.length - hop);
    // Läs den INKOMMANDE hopen ur this.buffer (efter set), inte ur `samples`: annars
    // adderas float64-tal och subtraheras float32-tal → systematisk drift, inte brus.
    for (let i = this.buffer.length - hop; i < this.buffer.length; i++) { const v = this.buffer[i]; ss += v * v; }
    if (++this.rmsRecalc >= 400 || ss < 0) {
      this.rmsRecalc = 0; ss = 0;
      for (let i = 0; i < this.buffer.length; i++) { const v = this.buffer[i]; ss += v * v; }
    }
    this.sumSq = ss;
    // DC-HANTERING: PROVAT OCH FÖRKASTAT (2026-08-23), båda vägarna kostade lås:
    //  • utesluta bin 0 ur bass/kick-banden — binbredden är 93.75 Hz, så bin 0 är
    //    0–94 Hz och BÄR bastrumman ("brusigt rum 136" gick 100 % → 0 %);
    //  • dra bort fönstrets medelvärde före FFT:n — vid 512 sampel (10.7 ms) är det
    //    ett högpass kring 100 Hz som dämpade 58 Hz-kicken (92/100 BPM låste på 113);
    //  • RMS som standardavvikelse (ss/N − mean²) — sänkte nivån just under
    //    energi-grinden i brusiga rum (100 % → 0 %).
    const rms = Math.sqrt(ss / this.buffer.length);

    // Windowed FFT (pre-allokerade scratchpads → ingen alloc/hop)
    const windowed = this.windowed512;
    for (let i = 0; i < windowed.length; i++) windowed[i] = this.buffer[i] * this.window[i];
    const spectrum = this.spectrum512;
    this.fft.realTransform(spectrum, windowed);

    // Magnitude spectrum + bass band (mag återanvänds; swap:as med prevMag nedan)
    const half = this.cfg.fft.size / 2;
    const mag = this.mag512;
    let bassEnergy = 0;
    let flux = 0;
    let kickFlux = 0;                               // onset ENBART i kick-bandet (sub-bas)
    let powSum = 0, powW = 0;                       // för spektralt centroid (EFFEKT-viktat)
    const bassBins = Math.min(16, half);                            // ~0–1.5 kHz
    const kickBins = Math.min(3, half);                            // bins 0–2 ≈ 0–280 Hz (kick-trumman)

    // MAGNITUD (sqrt) räknas bara i basbanden — det är de enda bin som läses. Övriga
    // 240 sqrt/hop (~90 000/s) fanns bara för centroiden, som nu viktar på EFFEKT
    // (re²+im²) i stället: samma spektrala tyngdpunkt, ingen rot.
    for (let i = 0; i < half; i++) {
      const re = spectrum[2 * i];
      const im = spectrum[2 * i + 1];
      const p = re * re + im * im;
      if (i < bassBins) {
        const m = Math.sqrt(p);
        mag[i] = m;
        bassEnergy += m;
        const dd = m - this.prevMag[i];
        if (dd > 0) { flux += dd; if (i < kickBins) kickFlux += dd; }   // half-wave rectified
      }
      powSum += p; powW += i * p;
    }


    // Swap: denna hops magnitud blir nästa hops prevMag (zero-copy, ingen alloc).
    { const t = this.prevMag; this.prevMag = this.mag512; this.mag512 = t; }
    // Gain-compensated like `level` — otherwise the band-driven fixtures and
    // the kick energy gate die at low volume while the AGC keeps level alive.
    const energy = Math.min(1, (bassEnergy / bassBins) * 0.02 * this.gain);
    // CENTROID-KALIBRERING (mätt 2026-08-23, 60 s syntetisk låt 128 BPM, statistik
    // på `frame.centroid` = det EMA-utjämnade värdet, inte råvärdet per hop):
    //   magnitudviktad (gamla) p10/p50/p90 = 0.194 / 0.254 / 0.343
    //   effektviktad rå                    = 0.025 / 0.044 / 0.115
    // Effektvikten kvadrerar ungefär tyngdpunkten, så sqrt återställer skalan.
    // KONSTANTEN 1.47 ÄR PASSAD MOT MEDIANEN, inget annat: sqrt är monoton, så en
    // enda faktor kan bara träffa en percentil. Efter ändringen mätte utjämnade
    // p10/p50/p90 = 0.176 / 0.223 / 0.353 — p50 landar där den låg, svansarna
    // ungefär (den övre något bredare). Kostar 1 sqrt/hop i stället för 240, och
    // `centSmooth > centSlow + 0.06` samt effektlagrets färgtemperatur läser rätt
    // storleksordning igen.
    // FOTNOT: sqrt(effektviktad tyngdpunkt) är INTE samma mått som magnitudviktad —
    // effektvikten ger de starkaste binen mer att säga till om, så glesa/ljusa
    // arrangemang (sparsam techno, akustiskt) kan landa annorlunda. Riser-grinden är
    // relativ och tål det; färgtemperaturen är absolut och märks först. Ser lamporna
    // ovanligt varma ut på ett spår utanför sviten är det här konstanten sitter.
    const centroid = powSum > 1e-12 ? Math.min(1, Math.sqrt(1.47 * (powW / powSum) / half)) : 0;
    const fluxNorm = Math.min(1, flux * 0.005);


    // Auto-gain (slow: seconds-to-minute timescales)
    const now = this.perfNow();
    const dt = this.lastT === 0 ? 0 : Math.max(0, Math.min(0.1, (now - this.lastT) / 1000));
    this.lastT = now;
    const d = this.cfg.detection;
    // AGC körs BARA för mic (aux låser gain på 1× — line-level är hett & stabilt).
    // PERCENTIL-AGC: målet är ett TAK för TOPPARNA, inte ett medel. Momentan-nivå
    // som mål pressade level till 1.0 (uppmätt: ≥0.95 i ~55 % av tiden, clip 21 %)
    // → inbränd klippning som AGC:n inte kan ta bort, och energi-uppgångar blev
    // osynliga. Nu mäts en hög percentil av senaste ~2 s (16 block-maxima à 128 ms,
    // näst-största ≈ 95:e percentilen) → en enstaka transient drar inte upp gainen.
    if (!this.gainLocked && rms > d.noiseFloor) {
      // block-max → ringbuffert (billigt: en scan per 128 ms, inga sorteringar)
      if (rms > this.agcBlockMax) this.agcBlockMax = rms;
      this.agcBlockMs += dt * 1000;
      if (this.agcBlockMs >= 128) {
        this.agcBlockMs = 0;
        this.agcBlocks[this.agcBlockIdx] = this.agcBlockMax;
        this.agcBlockIdx = (this.agcBlockIdx + 1) % this.agcBlocks.length;
        this.agcBlockMax = 0;
        // näst-största av 16 block ≈ 95:e percentilen av ~2 s
        let m1 = 0, m2 = 0;
        for (let i = 0; i < this.agcBlocks.length; i++) {
          const v = this.agcBlocks[i];
          if (v > m1) { m2 = m1; m1 = v; } else if (v > m2) { m2 = v; }
        }
        this.envelope = m2 > 0 ? m2 : m1;
      }
      if (this.envelope > 1e-4) {
        const desired = d.autoGainTarget / this.envelope;
        // Långsam attack (bränner ingen klippning), snabb retreat när topparna
        // närmar sig taket.
        const tau = desired > this.gain ? d.tauUp * 2 : d.tauDown * 0.25;
        const ga = 1 - Math.exp(-dt / tau);
        this.gain += (desired - this.gain) * ga;
        if (this.gain < 0.5) this.gain = 0.5;
        else if (this.gain > d.maxGain) this.gain = d.maxGain;
      }
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
    // VIKTIGT: referensen ar cfg.beat.anchorMs (PLL:ens stabila fas), INTE
    // this.beatAnchorMs - den senare sätts av varje detekterad kick och vore
    // cirkulär: en falsk kick skulle flytta gridet den doms mot.
    //
    // TIDSBAS: anchorMs är VÄGGKLOCKA (PLL:en mäter mot frame.kickAtMs = wallNow()).
    // Här användes `now` = perfNow() (ms sedan processtart) — 1,7·10¹² ms fel, vilket
    // efter `% gridMs` blev en konstant men helt godtycklig fasförskjutning: grinden
    // släppte igenom transienter i fel fas och kastade äkta kickar.
    const grid = this.cfg.beat;
    if (above && grid && grid.bpm > 40 && this.localBpmConfidence > 0.5) {
      const beatMs = 60000 / grid.bpm;
      const gridMs = beatMs / 2;                    // attondelar: four-on-the-floor + upptakter
      const offset = ((this.wallNow() - grid.anchorMs) % gridMs + gridMs) % gridMs;

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

    // Hoppets längd i ms — en enda förberäknad konstant (räknades förut fram tre
    // gånger per hop under tre olika namn: frameMs0, frameMs, hopMs).
    const hopMs = this.hopMs;
    // Tystnad → nollställ BPM-klockan så beat-effekter inte fortsätter i fantom-takt.
    if (rms < this.cfg.detection.noiseFloor * 1.5) {
      this.silentMs += hopMs;
      // BEHÅLL GISSNINGEN, SLÄPP LÅSET: att nolla localBpm gjorde återinlåsningen 25×
      // långsammare (stride 25 när localBpm !== 0) och ett kort uppehåll mitt i en låt
      // räckte. FLANK-triggat: tempoGram-skrivningarna kördes annars varje tyst hop.
      if (this.silentMs > 350 && !this.silenceArmed) {
        this.silenceArmed = true;
        this.localBpmConfidence = 0;          // beat-UTSIGNALEN av (inga fantom-pulser)
        this.beatAnchorMs = 0; this.pendingKickMs = 0;
        this.envFilled = 0; this.envBassAccum = 0;
        this.hintTrackChange(5000, true);     // släpper commit + historik, rör INTE localBpm
        for (let i = 0; i < this.tempoGram.length; i++) this.tempoGram[i] *= 0.5;
      }
      if (this.silentMs > 10000) { this.localBpm = 0; this.tempoGram.fill(0); }   // full släppning
    } else {
      this.silentMs = 0; this.silenceArmed = false;
    }
    // --- Onset-envelope → lokal BPM (nedsamplad till 100 Hz) ---

    this.envAccum = Math.max(this.envAccum, fluxNorm);
    // Basbandets egen envelope (kick-flux) — samma raster, oberoende signal.
    const bassFluxNorm = Math.min(1, kickFlux * 0.02);
    if (bassFluxNorm > this.envBassAccum) this.envBassAccum = bassFluxNorm;
    this.envAccumT += hopMs;
    if (this.envAccumT >= 1000 / Analyser.ENV_HZ) {
      this.envAccumT -= 1000 / Analyser.ENV_HZ;
      this.envRing[this.envPos] = this.envAccum;
      this.envBassRing[this.envPos] = this.envBassAccum;
      this.envPos = (this.envPos + 1) % Analyser.ENV_LEN;
      this.envFilled = Math.min(this.envFilled + 1, Analyser.ENV_LEN);
      this.envAccum = 0;
      this.envBassAccum = 0;
      // Innan lås: räkna på varje ny envelope-sample (100 Hz) för snabbast första estimat.
      // Efter lås: 4 Hz räcker gott — sparar CPU och förfinar med median.
      // TAK PÅ OLÅST TAKT: kostnaden växer med fönstret (uppmätt 28 µs @ N=100,
      // 110 µs @ N=500 på x86 ⇒ ~10× på Zero 2W). Med 100 Hz och fullt fönster
      // blir det en CPU-spik som aldrig ger något: när fönstret redan är >1.5 s
      // och ingen lås skett är låten taktlös/otydlig, och 20 Hz räcker mer än väl.
      // De första ~1.5 s körs fortfarande i full takt — time-to-first-lock är orörd.
      const stride = this.localBpm !== 0 ? Analyser.ENV_HZ / 4
        : this.envFilled < 150 ? 1 : 5;
      if (++this.bpmCounter >= stride) { this.bpmCounter = 0; this.computeBpm(); }

    }
    // #2 Förfina förra kickens fas: nu har vi y(-1)=kfPrev2, y(0)=kfPrev, y(+1)=kickFlux
    // runt kick-hopet. Parabelns topp ger sub-hop-offset δ ∈ [-0.5,0.5] hop.
    let kickAtMs = 0;
    let barShift = -1;

    if (this.pendingKickMs > 0) {
      const ym1 = this.kfPrev2, y0 = this.kfPrev, yp1 = kickFlux;
      const denom = ym1 - 2 * y0 + yp1;
      if (denom < 0) {                                   // konkav → äkta topp
        let delta = 0.5 * (ym1 - yp1) / denom;
        if (delta > 0.5) delta = 0.5; else if (delta < -0.5) delta = -0.5;
        this.beatAnchorMs = this.pendingKickMs + delta * hopMs;

      }
      this.pendingKickMs = 0;
      // Slaget är färdigmätt → lämna över dess EXAKTA tid till PLL:en.
      kickAtMs = this.beatAnchorMs;
      // TAKTFAS: bokför slagets tyngd på sin plats i fyrtakten. Vikten är slagets
      // EGEN styrka (flux mot sin tröskel, kvadrerad så skillnaden mellan ettans
      // tunga och mellanslagens lätta trumma verkligen separerar). Bandenergin gick
      // inte att använda: den är utjämnad över ~100 ms och gav alla fyra platser
      // samma vikt ⇒ ingen marginal, ingen taktfas (MÄTT 2026-08-23).
      const g = this.cfg.beat;
      if (g && g.bpm > 40 && this.localBpmConfidence > 0.5) {
        const bMs = 60000 / g.bpm;
        const slot = ((Math.round((kickAtMs - g.anchorMs) / bMs) % 4) + 4) % 4;
        this.barAcc[slot] += this.pendingKickW * this.pendingKickW;
        if (this.barCount < 1000) this.barCount++;
        for (let i = 0; i < 4; i++) this.barAcc[i] *= 0.997;   // ~4 takters glömska
        // VINNANDE PLATS räknas ut HÄR, inte varje hop: barAcc ändras bara när ett
        // slag bokförs, så mellanliggande hops gav exakt samma svar. Vinsten är
        // dessutom att förslaget kommer högst en gång per slag i stället för i varje
        // ruta fram till att motorn hunnit flytta ankaret.
        // Kravet: TYDLIG marginal (35 %) och nog med bevis (~16 slag). Annars -1 —
        // bättre ingen taktfas än en som sitter en åtta bort.
        let bi = 0, best = this.barAcc[0], second = -1;
        for (let i = 1; i < 4; i++) if (this.barAcc[i] > best) { second = best; best = this.barAcc[i]; bi = i; }
        for (let i = 0; i < 4; i++) if (i !== bi && this.barAcc[i] > second) second = this.barAcc[i];
        if (this.barCount >= 16 && best > second * 1.35) barShift = bi;
      }
    }
    if (kick) {
      this.beatAnchorMs = this.wallNow();
      this.pendingKickMs = this.beatAnchorMs;
      this.pendingKickW = kickFlux;   // absolut anslagsstyrka (kvot mot tröskeln mättade)
    }

    this.kfPrev2 = this.kfPrev;
    this.kfPrev = kickFlux;

    const dtHop = this.dtHop;
    const aAtt = this.aAtt;
    const aRel = this.aRel;
    // Modulnivå-funktion, inte closure: två closures per hop (~750/s) allokerades
    // rakt emot filens 0-alloc-ambition.
    this.lvlSmooth = ema(this.lvlSmooth, level, aAtt, aRel);
    // VU-nivå: symmetrisk ~200ms lågpass PÅ HOP-TAKT (integrerar alla 375 hops/s
    // → långt mindre brus än att smootha rå-nivån efter 50Hz-decimering). ≤200 BPM
    // = ett slag var ≥300ms, så 200ms suddar aldrig ut en äkta beat — bara brus.
    this.lvlVU += (level - this.lvlVU) * this.aVU;
    this.engSmooth = ema(this.engSmooth, energy, aAtt, aRel);
    this.centSmooth = ema(this.centSmooth, centroid, aAtt, aRel);


    // SEKTIONSENERGI (0..1) — hur energiskt partiet är RELATIVT låtens eget snitt.
    // Ren analys av nivån över tid → hör hemma här, inte i show-orkestreringen.
    // En komprimerad signal ligger jämnt högt, så absolut nivå säger inget; jämför
    // mot en robust baslinje (P50-median, ej EMA-medel som pinnas upp av loud
    // sections). Mitten = snittet, tydligt över = drop/topp, under = breakdown.
    // Attack något snabbare än release så uppbyggnader syns. WARMUP: baslinjen
    // konvergerar snabbt (~3s) de första 8s aktiv musik, sen stabil ~25s.
    // Nollställs vid tystnad → snabb omkalibrering vid låtbyte.
    if (rms >= this.cfg.detection.noiseFloor * 1.5) this.activeMs += dtHop * 1000;
    else this.activeMs = 0;
    const iUp = this.aIUp;
    const iDown = this.aIDown;
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
    // Bara upp till högsta bin som någon läser (band 8 slutar vid 16 kHz ≈ bin 683,
    // låtminnet slutar vid 5 kHz ≈ bin 218). Resterande ~340 sqrt per stor-FFT hade
    // ingen läsare.
    for (let i = 0; i < this.magBigMax; i++) {
      const re = this.specBig[2 * i], im = this.specBig[2 * i + 1];
      this.magBig[i] = Math.sqrt(re * re + im * im);
    }

    // LÅTMINNET får samma magnitud (ingen extra FFT). Anropas före swap:en nedan,
    // så bufferten faktiskt innehåller DENNA frames spektrum. Skickas som cachad vy
    // (0..magBigMax) — svansen räknas inte, så ingen läsare kan tyst få nollor.
    this.specSink?.(this.magBigView, this.cfg.audio.rate / this.bufferBig.length);
    const gated = rms > this.cfg.detection.noiseFloor * 1.5;

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
      this.bandAbs[b] = avg;
      // Per-band AGC: skala mot egen långsamt sjunkande peak → varje band nyttjar
      // full range oavsett mix (bas dominerar annars alltid rå-magnituden).
      // GOLV (~0.15·lvlSmooth): peaken nollställs INTE i tystnad → när ett tidigare
      // tyst band (t.ex. diskant i ett intro) smäller till blir det en balanserad
      // respons, inte en överstyrd ljus-chock/pump. (Gemini.)
      const minPeak = this.lvlSmooth * 0.15;
      // DECAYEN SKALAS MED BIG_EVERY: blocket körs 125/s, inte 375/s. Rå 0.9993 gav
      // τ ≈ 11 s i stället för kalibrerade ~3.8 s (ett hett band höll sin peak in i
      // nästa parti → konstlat låg diskant efter en drop). PEAK_DECAY = 0.9993^BIG_EVERY.
      if (gated && avg > this.bandPeak[b]) this.bandPeak[b] = Math.max(avg, minPeak);
      else this.bandPeak[b] = Math.max(this.bandPeak[b] * Analyser.PEAK_DECAY, minPeak);
      // Nivån smoothas ~90ms PÅ HOP-TAKT → nivå-drivna/lugna effekter (som läser
      // spec via ctx.band) flimrar inte av det råa per-hop-AGC-bruset. onset lämnas
      // skarp (nedan) så transient-drivna effekter behåller sin punch.
      const lvlRawB = gated ? Math.min(1, avg / (this.bandPeak[b] + 1e-6)) : 0;
      this.bandLvlSm[b] += (lvlRawB - this.bandLvlSm[b]) * this.aBandLvl;
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
    { const t = this.prevMagBig; this.prevMagBig = this.magBig; this.magBig = t;
      const v = this.prevMagBigView; this.prevMagBigView = this.magBigView; this.magBigView = v; }
    }   // slut på decimerad stor-FFT
    // TRUM-KIT peak-hold-envelopes PÅ HOP-TAKT (var 2.7ms) → fångar varje anslag,
    // aldrig missat mellan två render-frames (100Hz). tau bevarade från effects.ts:
    // hat 60ms (treble-onset O[6]) / snare 110ms (highMid-onset O[5]) / kick 150ms
    // (diskret kick + kick-onset O[1]). bass = spec.bass-NIVÅ (L[2], ingen envelope).
    this.hatHit = Math.max(this.hatHit * this.dHat, this.bandOn[6]);
    this.snareHit = Math.max(this.snareHit * this.dSnare, this.bandOn[5]);
    // Drivs ENBART av den riktiga kick-detektorn (median + 4.5*MAD). Tidigare
    // fylldes den ocksa pa av bandOn[1], men det bandet (60-120 Hz) domineras av
    // sustained bas: MATT 816-1377 anslag/min dar ~110 fanns, dvs 8x for manga.
    // Den svammade over den korrekta detektorn sa envelopen aldrig slocknade och
    // kicken forlorade sin accent.
    if (kick) this.kickHit = 1;
    else this.kickHit = this.kickHit * this.dKick;
    // ── DROP-DETEKTION (flyttad hit: att AVGÖRA om det är en drop är analys) ──
    // En "riktig" drop = nivån surgar upp mot låtens tak EFTER en break (svacka).
    // Topp-zonen har hysteres (in vid 85% av taket, ut först vid 70%) så nivån inte
    // flimrar kring tröskeln. Kräver ≥2s musik så låtens INTRO (tystnad→musik) inte
    // läses som en drop. Resultatet exponeras som en MONOTON räknare → en konsument
    // på lägre takt kan aldrig missa flanken.
    const nowWallA = this.wallNow();
    this.levelCeil = Math.max(this.lvlSmooth, this.levelCeil - dtHop * 0.015 * this.levelCeil);   // tak, decay ~65s
    // `breaking` = nivån ligger i en svacka. Exponeras till effektlagret (lugnt läge).
    // Den GAMLA svack-stämpeln (breakAtMs, 400 ms ihållande) grindade drop-villkoret
    // innan flanken flyttades till baskroppen; den är borttagen med sitt villkor.
    const breaking = this.lvlSmooth < this.levelCeil * 0.65;

    if (this.lvlSmooth > this.levelCeil * 0.85 && this.lvlSmooth > 0.65) this.inZoneState = true;
    else if (this.lvlSmooth < this.levelCeil * 0.70) this.inZoneState = false;
    const inZone = this.inZoneState;
    // BASKROPPEN — drop-detektionens egen signal (tak + frånvaro + stigningstakt).
    // `inZone` lämnas orörd: effektlagret använder den som "musiken ligger högt".

    const bodyNow = (this.bandLvl[0] + this.bandLvl[1] + this.bandLvl[2]) / 3;   // sub + kick + bas
    this.bodyEnv += (bodyNow - this.bodyEnv) * Math.min(1, dtHop / 0.35);
    this.bodyFast += (bodyNow - this.bodyFast) * Math.min(1, dtHop / 0.12);
    this.bodyCeil = Math.max(this.bodyEnv, this.bodyCeil - dtHop * 0.015 * this.bodyCeil);

    // BAS-FRÅNVARO med VARAKTIGHETSKRAV: under 40 % av taket i ≥2 s i sträck.
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
    // ENERGIGOLVET (intensity > 0.45) och svacka/riser-fönstren är BORTA som villkor
    // sedan flanken flyttades till baskroppen: de mättes fram mot den gamla
    // nivå-zon-detektorn och grindade signaler som inte längre bär beslutet.
    // Innan något av dem återinförs måste det mätas om mot bodyOnset.

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
    // RISER-KRAVET AR AVSTANGT — men INTE for att signalen ar dod. Den gamla
    // motiveringen ("inRiser 0% av tiden, buildUp p99=0.31") mattes mot en
    // aldre riser-detektor och ar RADERAD som falsk.
    //   OMMATT mot novelty-baserad novRiser (tools/testDrops.mjs, 8 seeder):
    //   inRiser 8.8% av tiden, buildUp p50=0.00 p90=0.00 p99=0.42 max=0.85.
    //   p50/p90=0 ar forvantat — en riser SKA vara sallsynt. I ett brusigt rum
    //   fyrar den nastan aldrig (0.6%, max 0.04), sa ett hart riser-krav skulle
    //   sla av drop-detektionen just dar mikrofonen sitter.
    // Kravet ar fortfarande avstangt tills det matts om mot bodyOnset pa akta
    // material (se nedan) — men grunden ar nu grindens kalibrering, inte en dod
    // signal.


    // FLANKEN TAS PÅ BASKROPPEN, inte på nivån. Nivå-zonen var sann 80 % av tiden
    // i ägarens musik → dess flanker låg godtyckligt, och 8-takters-spärren blev
    // i praktiken den som VALDE när en drop fyrade (första flanken efter att
    // fönstret löpt ut). Uppmätt resultat: 3 träffar av 19, 16 falsklarm.
    if (dropSpacingOk && bodyOnset && this.activeMs > 2000) {
      this.dropCount++; this.lastDropMs = nowWallA;
    }


    // ── UPPBYGGNAD / RISER (flyttad hit) ──
    // Spektral NOVELTY = summan av bandens POSITIVA avvikelse från en ~2s baslinje,
    // ihållande ~1.5s. Mätt validerad: ramsar 0.25→0.78 in i en drop. Relativt en
    // ~8s baslinje → RISER = novelty STIGER över den (filter-sweep/snare-roll),
    // skilt från bara-busy (ihållande → baslinjen kommer ikapp). Gammal väg
    // (klang+nivå stiger) ligger kvar som OR. Inte direkt efter en drop.
    let nov = 0; const sr = this.aSpecSlow;
    for (let b = 0; b < 8; b++) { this.specSlow[b] += (this.bandLvl[b] - this.specSlow[b]) * sr; nov += Math.max(0, this.bandLvl[b] - this.specSlow[b]); }
    this.novSlow += (nov - this.novSlow) * this.aNovSlow;
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
    const pr = this.aProf;
    this.profPunch += (punchNow - this.profPunch) * pr;
    this.profBass += (bassW - this.profBass) * pr;
    this.profBright += (brightW - this.profBright) * pr;
    this.profBeat += (this.localBpmConfidence - this.profBeat) * pr;
    // Skala råvärdena till användbara 0..1-spann (typiska musikvärden → full range).
    // Skalningen är KALIBRERAD mot uppmätta råvärden på riktig musik (annars
    // mättar punch på 1.00 och bright ligger konstant högt → ingen diskriminering).
    this.outProfile.punch = cl01((this.profPunch - 0.05) / 0.40);
    this.outProfile.bass = cl01((this.profBass - 0.28) / 0.30);
    this.outProfile.bright = cl01((this.profBright - 0.14) / 0.19);
    this.outProfile.beat = cl01(this.profBeat);


    const L = this.bandLvl, O = this.bandOn;
    const spec = this.outSpec, onset = this.outOnset;
    spec.sub = L[0]; spec.kick = L[1]; spec.bass = L[2]; spec.lowMid = L[3]; spec.mid = L[4]; spec.highMid = L[5]; spec.treble = L[6]; spec.air = L[7];
    onset.sub = O[0]; onset.kick = O[1]; onset.bass = O[2]; onset.lowMid = O[3]; onset.mid = O[4]; onset.highMid = O[5]; onset.treble = O[6]; onset.air = O[7];
    const A = this.bandAbs, sa = this.outSpecAbs;
    sa.sub = A[0]; sa.kick = A[1]; sa.bass = A[2]; sa.lowMid = A[3]; sa.mid = A[4]; sa.highMid = A[5]; sa.treble = A[6]; sa.air = A[7];
    const dr = this.outDrum;
    dr.kick = this.kickHit; dr.snare = this.snareHit; dr.hat = this.hatHit; dr.bass = L[2];

    // Mutera det återanvända Frame:t (spec/onset pekar redan på outSpec/outOnset).
    const f = this.outFrame;
    f.level = this.lvlSmooth; f.levelRaw = level; f.levelVU = this.lvlVU;
    f.energy = this.engSmooth;
    f.centroid = this.centSmooth; f.flux = fluxNorm; f.kick = kick; f.gain = this.gain;
    f.bpm = this.localBpm; f.bpmConfidence = this.localBpmConfidence; f.intensity = intensity; f.beatAnchorMs = this.beatAnchorMs;
    f.dropCount = this.dropCount; f.inZone = inZone; f.breaking = breaking; f.buildUp = this.buildUp; f.inRiser = inRiser;
    f.kickAtMs = kickAtMs; f.barShift = barShift;
    return f;
  }
}

/** Asymmetrisk EMA (snabb attack, långsam release) — modulnivå så tick-vägen
 *  inte allokerar en closure per hop. */
function ema(prev: number, x: number, aUp: number, aDown: number): number {
  return prev + (x - prev) * (x > prev ? aUp : aDown);
}

function cl01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
