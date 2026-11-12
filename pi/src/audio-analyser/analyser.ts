/**
 * ENAD ANALYSATOR (2026-09-24) — en fil, samma byte i lotus-light-link (pi/src/audio-analyser/) och
 * dmx-control (pi-dmx/engine/src/). Deploy-skripten i båda repona vägrar deploya om filen skiljer
 * sig från den gemensamma (md5, se ANALYSER_SHARED_MD5 i respektive deploy-skript).
 *
 * SYSTEMSKILLNADER BARA VIA KONFIGURATION, aldrig via "vilket system är detta":
 *   - analyserProfile.ts (en fil per system, bredvid denna) ger env-prefixet och systemets
 *     standardvärden för de rattar där systemen i dag har olika standard.
 *   - Rattar med systemprefix läses som LOTUS_<X> eller DMX_<X> (eget prefix först, det andra som
 *     alias). Rattar utan prefix (BPM_MIN, DROP_ARM_MS ...) läses som de heter.
 *   - Utan env och med respektive profil beter sig analysatorn exakt som systemets analysator
 *     gjorde före sammanslagningen (bevisat hop för hop i paritetsbänken, tools/analyserParity.mjs).
 *
 * Analysatorn läser ljud (process) och levererar Frame. Den vet inget om vad konsumenterna gör
 * med ljudet eller ramarna.
 */

import { PROFILE } from './analyserProfile.js';
/** frame.bassEnergy / bassEnergyShort: 0 = så många dB under taket (eller mer), 1 = vid taket. BRETT med avsikt - mätningen klipper
 *  så lite som möjligt; hur stor del av spannet ljuset använder väljer effektsidan (effects.ts B_SPAN_DB). */
export const BASS_SPAN_DB = 36;
import {
  REC_LEN, RING_N, R_SEQ, R_PERF, R_WALL, R_ENV, R_BASS, R_HIGH, R_FLAGS, R_HINT_MS, R_VCLOCK, R_SEC_N, R_SEC_INT, R_SEC_KICKS, R_SEC_BREAK,
  R_SEC_RMS2, R_SEC_CENT, R_SEC_DT, R_DROPS, R_ACTIVE, R_BUILD, R_SEC_SPEC0, R_SEC_WALL, R_TS, R_FLAGCNT, RING_MARGIN, FLAG_BITS, R_SEC_BON, R_SEC_BPK, R_SEC_FLUX, R_SEC_RMS4,
  packFlagCounts, lostFlags, seqLow, seqDelta, C_WAITING, C_STATE_SEQ, S_LOST_FLAGS,
  F_SIL350, F_SIL10, F_RESET_TEMPO, F_HINT, F_RESET_BAR, F_VCLOCK_SET, F_VCLOCK_NULL,
  C_WRITE, C_READ, S_REC_SEQ, S_BPM, S_CONF, S_BPMF, S_PHASE_MS, S_PHASE_CONF, S_SECTION, S_SEC_START, S_SEC_INDEX, S_SEC_TIER,
  S_REP_SIM, S_REP_AGO, S_REP_SEC, S_EXPECT_MS, S_EXPECT_SRC, S_PREV_SEC, S_LVL_HIGH, S_PROCESSED, S_LAG_MS, S_LAG_MAX, S_BUSY_US, S_BUSY_MAX_US, S_SKIPPED, STATE_LEN,
  SECTIONS, sectionCode, viewsOf, stateWrite, stateRead, createSplitBuffers, type SplitBuffers, type WorkerData,
  C_WAKE, syncWait, HopLaneFast, HopLaneSlow, StateReader, type HopFeed,
  R_BIGSEQ, R_CLOCK, R_CLOCK_CONF, BIG_REC_LEN, BIG_RING_N, BIG_HOP_MAX, B_SEQ, B_N, B_RMS, B_LVL, B_CENT, B_ACTIVE, B_WALL, B_KICK, B_KICKHIT, B_INT, B_BREAK, B_SEC, B_LVH, B_CONF,
  B_ENVF, B_ENVBPM, C_WAITING_B, C_BIG_WRITE, C_BIG_READ, C_BIG_SEQ, BS_SEQ, BS_BODY, BS_DROPS, BS_MINI, BS_BUILD, BS_RISER, BS_PUNCH, BS_BASS, BS_BRIGHT, BS_BEAT,
  BS_BASSLINE, BS_SPEC_N, BS_SKIPPED, BS_CAND, BS_DEMOTED, BS_SPACED, BS_DROPRISE, BS_NEAR, BS_NEARDIP, BS_LIFT, BS_STOPS, BS_STOPSEC, BIG_STATE_LEN, SPEC_SLOTS, SPEC_MAX,
} from './split.js';
import FFT from "fft.js";
import { BeatFeed, publishPhase, type ClockCfg } from "./analyserClock.js";   // ANALYSATORNS KLOCKA (a7r): tempogram, rutnät, etta, tillit

// ── RATTAR ─────────────────────────────────────────────────────────────────────────────────────
const ENV: Record<string, string | undefined> | undefined = typeof process !== 'undefined' ? process.env : undefined;
const ALIAS_PREFIX = PROFILE.envPrefix === 'LOTUS_' ? 'DMX_' : 'LOTUS_';
/** Ratt MED systemprefix: <eget prefix><name>, sedan <andra prefixet><name> (alias), sedan profilens standard. */
/** KICKSPÄRRENS TAK (r0 entempo): spärren är 0,6 slag på klockans tempo men högst 330 ms (= 0,6 slag vid 109 BPM). Mätt (r0/verktyg/kick.mjs,
 *  lang1011 141-300 s): klockan står på 87 där analysatorns egen sökning stod på 110-131; utan tak tog 414 ms-spärren var tredje kick
 *  (44 kickar/20 s, platt = sektionernas kicktäthet utan kontrast, upp_s 1,35 -> 2,85 s), med taket 148 mot basens 140 per minut. */
const KICK_CAP_MS = 330;
function sysEnv(name: string): string | undefined {
  return ENV?.[PROFILE.envPrefix + name] ?? ENV?.[ALIAS_PREFIX + name] ?? PROFILE.sys[name];
}
/** TEMPOKÄLLAN (EN KLOCKA FÖR BÅDA, klocka a8 11-09): klockan (analyserClock.ts) är analysatorns ENDA tempo, fas och tillit i BÅDA
 *  profilerna. Lotus egen sökning (computeBpm/scoreEnv/alignScore/shiftDetect) och gridfasen (computeGridPhase) är borttagna;
 *  profilen väljer bara VAR klockan körs (sys.BEAT_FEED 'slow' = taktvägen i workern, annars sist i process(), se clockMode). */
/** Ratt UTAN prefix (namnet som det star), sedan profilens standard. */
function env(name: string): string | undefined {
  return ENV?.[name] ?? PROFILE.bare[name];
}
/** Sann om ratten ar satt till nagot icke-tomt (motsvarar `!!process.env.X`). */
function sysOn(name: string): boolean { return !!sysEnv(name); }
// Rattar som lases i tatslingan (per hop) - lases EN gang vid modulladdning.
const HIGH_ON = sysOn('HIGH_DIAG') || false;
const BPM_TRACE = sysOn('BPM_TRACE');
const DROP_TRACE = sysOn('DROP_TRACE');
/** Tystnad (350 ms) nollar aven en vantande kick-forfining (pendingKickMs). */
const SIL_CLEAR_PENDING = sysEnv('SIL_CLEAR_PENDING') === '1';
/** Tempots storsta lag: 'half' = hogst halva ringen (N >> 1), 'full' = hela ringen (N - 1). */
const TEMPO_LAGMAX = sysEnv('TEMPO_LAGMAX') || 'half';
/** SEKTIONSBLOCKENS TAKT: 'env' = blocksummor per env-sampel (100 Hz; identiskt i odelad och delad analysator),
 *  'hop' = sectionHop per hop i odelad analysator, spektrum ur band-dB (aldre vagen). */
const SECTION_AGG = sysEnv('SECTION_AGG') || 'env';
const SECTION_AGG_HOP = SECTION_AGG === 'hop';
/** Rangpoangens buffert i 32-bitars flyttal (aldre vagen) i stallet for 64. */
const SECTION_SCORE_F32 = sysEnv('SECTION_SCORE_F32') === '1';

export interface BeatGrid { bpm: number; anchorMs: number; confidence?: number; }

/** Detektionsparametrar. Objektet LASES LOPANDE (varje hop) - vardarna kan andras under drift. */
export interface AnalyserDetection { autoGainTarget: number; tauUp: number; tauDown: number; noiseFloor: number; maxGain?: number }

export interface AnalyserConfig {
  /** Platt form (lotus): */
  sampleRate?: number;
  hopSize?: number;
  /** Small-FFT size (default 512). Must match the hop rate the analyser is fed. */
  fftSize?: number;
  autoGainTarget?: number;
  tauUp?: number;
  tauDown?: number;
  noiseFloor?: number;
  /** Släckgränsen på frame.level (motorns cfg.silenceLevel), standard SILENCE_LEVEL. */
  silenceLevel?: number;
  /** Upper clamp for analyser gain. */
  maxGain?: number;
  /** Enable log-compressed, adaptively whitened and normalized onset features. */
  onsetEnhancements?: boolean;
  /** Nastlad form (DMX-motorns config-objekt): audio.rate, fft.size/hop, detection (lases lopande) och beat
   *  (taktrastret, lases lopande - motorn skriver det). Ges `detection` anvands objektet sjalvt, inte en kopia. */
  audio?: { rate: number };
  fft?: { size: number; hop: number };
  detection?: AnalyserDetection;
  beat?: BeatGrid | null;
  /** DELAD ANALYSATOR (split.ts): 'all' (standard, allt i en trad) | 'fast' (ljudvagen; tempo/sektion hamtas ur
   *  tillstandsblocket) | 'slow' (workern: matas ur SAB-ringen via drainRecords()). Kan aven ges som andra argument. */
  role?: 'all' | 'fast' | 'slow';
  split?: SplitBuffers;
  /** Seq att fortsatta fran (slow: senast LASTA record vid omstart av workern; fast: senast SKRIVNA).
   *  0/utelamnad = fran borjan. Full JS-seq (inte de 32 laga bitarna). */
  resumeSeq?: number;
}

/** DELAD ANALYSATOR (split.ts): rollen och de delade buffertarna, som andra argument till konstruktorn. */
export interface SplitInit {
  role: 'all' | 'fast' | 'slow';
  split?: SplitBuffers;
  resumeSeq?: number;
  /** Bänkens synk-läge (createAnalyser(cfg, 'sync')): snabba sidan väntar på workern, workern notify:ar efter publicering. */
  sync?: boolean;
}

/** Rikt log-spektrum (8 band) från den parallella 2048-FFT:n. Varje band är
 *  per-band AGC-normaliserat (0..1) så alla band nyttjar full range oavsett mix. */
export interface Spectrum {
  sub: number;      // ~20–60 Hz   — sub/808-rumble
  kick: number;     // ~60–120 Hz  — kick-grundton/kropp (nu SKILD från basen)
  bass: number;     // ~120–250 Hz — basgång/basnoter
  lowMid: number;   // ~250–500 Hz — låg kropp, toms, låg röst
  mid: number;      // ~0,5–1,2 kHz — röst, snare-kropp, synth
  highMid: number;  // ~1,2–3,5 kHz — snare-crack/presence (dedikerad backbeat-kanal)
  treble: number;   // ~3,5–10 kHz — hi-hats, cymbaler
  air: number;      // ~10–16 kHz  — luft/glitter
}

/** Släckgränsens standard (motorns cfg.silenceLevel saknas). */
export const SILENCE_LEVEL = 0.05;
let silenceLevelLive = SILENCE_LEVEL;
/** Samma tystnadsbeslut som frame.silent för den som bara har nivån (BoundaryDetector matad av verktyg utan ramens flagga). */
export function silentLevel(level: number): boolean { return level <= silenceLevelLive; }

export interface Frame {
  /** TYSTNAD (a7): level <= släckgränsen (cfg.silenceLevel, EN tröskel, sätts live via setSilenceLevel). Läses av effekternas
   *  släck-/ingångsgrind och låtgränsens 3 s-tystnad - ingen konsument har egen nivågräns för "tyst". */
  silent: boolean;
  level: number;        // 0..1, auto-gained RMS (15ms attack / 400ms release smoothed)
  levelRaw: number;     // 0..1, samma auto-gain men OSMOOTHAT (rå per-hop)
  levelVU: number;      // 0..1, ~200ms symmetriskt smoothat PÅ HOP-TAKT (375Hz) — för VU-taket
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
  /** MINIDROP: mindre lyft (stigning MINI_RISE_DB efter kort svacka) som inte ar en full drop. Monoton. 0 nar MINI_SPACING_MS=0 (av). */
  miniDropCount: number;
  /** EN DROPDETEKTOR (a3, 11-09: förr effects.ts flankStep bredvid dropStep). dropCount = full drop på FLANKEN (break + smäll, efter
   *  spärren SHOW_DROP_GAP_MS). Detektorns lägre steg är minidrops: dropDemoted = slam-kandidat utan egen flank (inom 2 s),
   *  dropSpaced = flank inom spärren. Båda räknas också i miniDropCount. dropRiseDb = senaste flankens stigning (styrka). */
  dropDemoted: number; dropSpaced: number; dropRiseDb: number;
  /** LYFT/NÄSTAN-DROP/STOPP (a3, förr effects.ts stepLifts): VAD (> 0 medan villkoret håller) + STYRKA (dB).
   *  nearDropDb = språnget från dippens botten (dipp nearDipDb under 8 s-normalen), liftDb = kroppen 0,6 s över lugnet 6..2 s sedan,
   *  stopCount = basstopp 0,6-3 s som kom tillbaka (monoton), stopS = dess längd. Reaktionen (refraktär, look, lyft) ligger i effekterna. */
  nearDropDb: number; nearDipDb: number; liftDb: number; stopCount: number; stopS: number;
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
  profile: { punch: number; bass: number; bright: number; beat: number; bassline: number };   // bassline: TYDLIG BASGANG 0..1 (basnot-anslag per slag, ~1 s)
  beatAnchorMs: number; // wall-clock ms för ett taktslag (fas)
  /** >0 = ett trumslag är FÄRDIGMÄTT denna ruta: väggklocka för slagets flux-topp
   *  med sub-hop-precision (±1.3 ms). Kommer en hop EFTER frame.kick (parabeln
   *  behöver hoppet efter toppen) och är den enda tidsstämpel PLL:en får mäta
   *  fasfel mot — Date.now() vid rutans behandling bär ALSA-leveransens jitter. */
  kickAtMs: number;
  /** TAKTFAS: hur många slag ankaret ska flyttas FRAMÅT för att landa på ettan
   *  (0..3), eller -1 när fasen ännu är osäker. Motorn äger ankaret och applicerar. */
  barShift: number;
  /** GRIDFAS (09-20, opt-in LOTUS_GRID_PHASE=1): vaggklocka (ms) for ett NYLIGT TAKTSLAG enligt fasanalys pa basringen +
   *  helbandsringen vid last tempo, med halvslagstest och hysteres. 0 = ej beraknad/olast. Motorn kan folja den
   *  (LOTUS_PHASE_FOLLOW=1) i stallet for att lasa fasen pa forsta basta kick. */
  beatPhaseMs: number;
  /** Gridfasens on/half-kvot (>1 = slagfasen starkare an halvslagsfasen; ~1 = tvetydig). */
  beatPhaseConf: number;
  /** TILLITEN TILL TAKTEN 0..1 (11-11): klockans tillit över grinden, nerdragen av fasfel, utjämnad (trustStep i analyserClock.ts).
   *  Dirigenternas grind i båda systemen - ingen motor räknar en egen. */
  beatTrust: number;
  /** SEKTION (09-20, opt-in LOTUS_SECTION=1) - realtidens sektionstillstand relativt LATENS EGEN historik, for
   *  orkestrering (DMX-dirigenten, Lotus show): 'intro' | 'low' (vers/lugnt) | 'build' (uppbyggnad) | 'high' (refrang/drop)
   *  | 'break' (svacka efter topp). Ingen latkunskap kravs; refrangen kanns igen som upprepning (repeat*). */
  section: string;
  sectionAgeMs: number;     // ms sedan sektionen borjade
  sectionIndex: number;     // antal 'high'-partier hittills i laten (refrang nr)
  sectionTier: number;      // 0 lag / 1 mellan / 2 hog (stabil niva-tier, hysteres 3 s)
  /** UPPREPNING: likhet (cosinus, 0..1) mellan de senaste 4 s och det mest lika partiet >= 16 s tillbaka i laten,
   *  och hur langt tillbaka det lag samt vilken sektion det hade. repeatSim >= 0,92 mot 'high' = refrangen ar tillbaka.
   *  Med LOTUS_SECTION_REPEAT (bit 1) ar avtrycket z-normerat och repeatSim typiskt 0,2-0,9 (troskel REPEAT_THR 0,7), se Analyser.REPEAT. */
  repeatSim: number; repeatAgoMs: number; repeatSection: string;
  /** SEKTIONSMINNE + FORUTSAGELSE (09-21, workern; agaren: "komma ihag hur laten lat for nagra sekunder sedan och forra sektionen").
   *  expectHighInMs: ms tills nasta 'high' vantas (-1 = ingen forutsagelse, 0 = vi ar i high). Tva kallor: (1) MINNE - en tidigare
   *  sektion med samma etikett foljdes av 'high' efter N takter (avrundat till 4) -> samma langd nu; (2) FRAS - energin stiger
   *  (secRiseRun >= 4 raka stigande block, LOTUS_PREDICT_RISE) -> nasta 4-taktsgrans i ett frasgitter forankrat i senaste high-starten
   *  (LOTUS_PREDICT_GRID/LAT); (3) SUG (opt-in LOTUS_PREDICT_DIP) - dyk i dB strax fore smallen -> high om 2 s. prevSection = forra sektionens etikett.
   *  levelVsHighDb = blockets dB mot senaste refrangens medel-dB (negativt = tystare an refrangen; 0 utan refrang) - latens EGEN
   *  referens for dynamiken. sectionBars = takter sedan sektionsstart (0 utan tempo). */
  expectHighInMs: number; prevSection: string; levelVsHighDb: number; sectionBars: number;
  /** Rikt spektrum + per-band onset (anslag) från dubbel-FFT:n (hög-upplöst). */
  spec: Spectrum;       // per-band NIVÅ (AGC 0..1)
  /** Absolut per-band magnitud före AGC, för Lotus ljusväg och bandandelar. */
  specAbs: Spectrum;
  /** BASKROPPEN I RA dB (negativt tal, medel av sub+kick+bas), utan AGC - drop-detektorns kropp. */
  bodyDb: number;
  /** BASENERGIN 0..1 (arenan basenergi 2026-11-11, EN mätning för båda systemen; förr DMX effects.ts bHi/bLo/eBass): basens NIVÅ
   *  (sub+kick i rå dB, vikt 0,25/0,75) mot ett TAK, som dB-skillnad över ett fast spann: 1 = vid taket, 0 = BE_SPAN_DB eller mer
   *  under det. Taket räknas med SLAGET SOM TIDSENHET (klockans tempo; utan klocka 500 ms). TVÅ SKALOR:
   *  bassEnergy = mot FRASEN (taket = de starkaste slagen, glöms på BE_TOP_BEATS slag: starka och svaga partier skiljs åt),
   *  bassEnergyShort = mot TAKTEN (glöms på BE_FAST_BEATS slag: varje slag mot sina närmaste grannar, ikapp två slag efter ett
   *  nivåbyte). bassEnergyShort >= bassEnergy. Bara dB-skillnader: oberoende av ingångsnivån; 0 när ramen är tyst. Ren mätning:
   *  ingen dal, ingen uttoning, ingen kurva - hur fort ljuset släpper efter ett slag (pulsens bredd), vilken skala det följer och
   *  dropläget ligger i effekterna. Se bassEnergyStep.
   *  bassLevel (0..1) = PARTIETS BASNIVÅ MOT LÅTENS REFERENS: frasens tak mot refrängens tak som amplitudkvot (6 dB under = 0,5),
   *  så som levelVsHighDb mäter hela nivån mot refrängen. I refrängen (section 'high') ÄR frasens tak referensen (1); i vers, break
   *  och uppbyggnad står referensen kvar som låtens minne (följer ett starkare tak direkt upp, glöms på BE_MEM_BEATS slag). Före
   *  låtens första refräng är referensen det starkaste partiet hittills. Hur mycket ett svagare parti ska dämpas väljer konsumenten. */
  bassEnergy: number; bassEnergyShort: number; bassLevel: number;
  /** ABSOLUT mid+diskant-niva i dB (band 3-7, >250 Hz), RMS-kombinerad, ingen AGC. */
  midHiDb: number;
  /** KICKENS STIGNING, OMÄTTAD (10-28, fynd 10-22/10-27): basens (specAbs sub+kick) stigning i dB mot KICK_RISE_HOPS hop sedan,
   *  halvvåg (0 vid fall). onset.kick är klampad 0/1 och står på 1 under hela bas-svallet; det här fältet toppar på ansatsen.
   *  Samma tal som DMX:s FEED_RISE-vikning räknar själv (beatFeed.ts). Bara utdata: ingen konsument i analysatorn läser det. */
  kickRise: number;
  onset: Spectrum;      // per-band ONSET/anslag (halvvågs-flux mot adaptiv baslinje, 0..1)
  /** TRUM-KIT-envelopes (0..1): peak-hold + decay PÅ HOP-TAKT (375Hz) → fångar
   *  varje anslag, aldrig missat mellan två render-frames. kick=diskret kick +
   *  snare=highMid-onset, hat=treble-onset, bass=spec.bass (nivå).
   *  OBS: kick drivs ENBART av den diskreta kick-detektorn. Den fylldes forut
   *  ocksa pa av onset.kick (bandOn[1]), men det bandet domineras av sustained
   *  bas — MATT 816-1377 anslag/min dar ~110 fanns, dvs 8x for manga. */
  drum: { kick: number; snare: number; hat: number; bass: number };
}

// ── DROP-DETEKTOR ──────────────────────────────────────────────────────────────────────────────
// Kroppen ar RA dB -> alla grindar ar dB-SKILLNADER (gain-oberoende). underPeak-kvalitetsgrinden skiljer
// riktiga slam (landar pa toppen) fran falska partiella aterhamtningar. Alla rattar inerta i standard.
const BODY_RISE_DB = Number(env('BODY_RISE_DB') ?? 17);   // 18+ halverar traffarna (matt)
const BODY_GONE_DB = 5;
const BODY_GONE_MIN_MS = Number(env('BODY_GONE_MIN_MS') ?? 2000);   // breakdown-langd som kravs
const BODY_PEAK_DB = 10;   // BRED onset-grind (en ren edge per event)
// HARD KVALITETSGRIND vid fyrningen: underPeak (bodyPeak-bodyFast) ar BIMODAL - riktiga drops slar till full
// niva (< 3 dB), falska ar partiella aterhamtningar kring 9-10 dB. Att kapa i gapet dodar de falska.
const DROP_QUALITY_DB = Number(env('DROP_QUALITY_DB') ?? 3.5);
// ARMERAT FONSTER: edgen ARMERAR, fyrningen sker nar fullSlam blir sann inom fonstret (mjuka pop-drops toppar
// 50-200 ms efter edgen). 0 = bara edge-ogonblicket.
const DROP_ARM_MS = 300;
// FYR-LAGG: hela laggen ar bodyFast-filtret (tau 120 ms) som alla tre villkor laser. BODY_FAST_S sveper tau.
const BODY_FAST_S = 0.06;
// DROP_RISE_MIN: stigningen mats mot MINIMUM av bodyFast senaste 0,5 s, inte mot punkten 0,5 s bakat. Mjuka
// pop-drops har ett SUG (dipp 100-200 ms) fore dropen; med punkt-referensen nas kravet forst nar referensen
// hamnar i dippen -> fyrningen landar 0,5 s sent = en takt vid 130 BPM ("drop en takt efter").
// VILLKORAT STIGNINGSKRAV: landar kandidaten NARA TOPPEN (underPeak < DROP_RISE_LOW_Q) racker DROP_RISE_LOW_DB. 0 = av.
const DROP_RISE_LOW_DB = Number(env('DROP_RISE_LOW_DB') ?? 0);
const DROP_RISE_LOW_Q = 3;
// LUGN-SEKTIONS-GRIND (opt-in <prefix>DROP_CALM_GATE=1): i lugna partier (sektion low/intro, eller >= DROP_CALM_DB under senaste
// refrangen) kravs starkare bevis (riser, landning vid toppen eller extra lyft). DROP_CALM_LAND_MS > 0 -> kandidaten halls och fyrar
// forst vid verifierad landning; 0 -> nekas.
/** SEKTIONER OVERLEVER TEMPOTAPP (opt-in <prefix>SECTION_HINT_LOWCONF=0): lassslappet efter 8 s lag taktkonfidens ar ingen latgrans, men
 *  hintTrackChange nollade sektionerna (SECTION_ON_HINT) -> ett taktlost break mitt i laten gjorde refrangen efter till 'intro' utan historik
 *  (ladan 2026-09-24 23:00: 'varfor ar den sa seg pa att komma igang i refrangen?'). 0 = lassslappet ror bara tempot. Standard = som forr. */
const SECTION_HINT_LOWCONF = sysEnv('SECTION_HINT_LOWCONF') !== '0';
const DROP_UNDERPEAK_MIN = Number(env('DROP_UNDERPEAK_MIN') ?? 0);   // se 'INTE I TAKET'
/** STRIKT INTRO (opt-in DROP_CALM_INTRO_STRICT=1, kraver <prefix>DROP_CALM_GATE): i 'intro' fyrar en drop bara efter riser (buildUp >= DROP_CALM_BUILD). */
const DROP_CALM_DB = 6;
const DROP_CALM_BUILD = 0.25;
const DROP_CALM_Q = 1.5;
const DROP_CALM_RISE_DB = 8;
const DROP_CALM_LAND_MS = 0;
// KICK-LAS (opt-in DROP_KICK_LOCK_MS > 0): kroppsvillkoret armerar, fyrningen sker pa forsta kicken darefter (tak DROP_KICK_LOCK_MS
// eller en halv takt). DROP_KICK_LOCK_GRID=1: nasta rasterslag ar malet om gridfasen ar palitlig.

// MINIDROPS: egen losare lyft-detektor med eget avstand MINI_SPACING_MS. 0 = av.
const MINI_SPACING_MS = Number(env('MINI_SPACING_MS') ?? 0);
const MINI_RISE_DB = 10;
const MINI_GONE_DB = 3;
const MINI_GONE_MS = 800;
const MINI_PEAK_DB = 10;
const DROP_SHORT_MS = 4000;    // minsta drop-avstand nar dropen ESKALERAR
const DROP_LONG_MS = 20000;    // annars maste sa har lang tid ga (mot falska upprepningar)
const DROP_ESCALATE_DB = 3;    // tatare drops maste vara TYDLIGT starkare for att fyra
const BODY_CEIL_DB_S = 0.15;   // taket haller latens loud-referens lange
// FULL DROP PÅ FLANKEN (flyttad ur effects.ts 11-09, a3 - historiken: ägarens ladan 10-12..10-30, se git-historiken för effects.ts):
// baskroppens topp (bodyFast över FLANK_HOLD_S) har legat >= FLANK_GONE_DB under taket (bodyCeil) i >= FLANK_BREAK_S (eller
// >= FLANK_SHORT_S med >= FLANK_SHORT_RISE_DB djup), och fyrar när bodyFast går upp till taket - FLANK_LAND_DB med >= FLANK_RISE_DB
// stigning på 0,5 s. Helt tyst (lvlSmooth <= FLANK_SILENT_LV) i breaket = låtlucka, ingen drop. Samma filter som slam-kandidaten
// (bodyFast 60 ms, bodyEnv 350 ms, bodyCeil -0,15 dB/s) - förr en egen kopia i effekterna.
const FLANK_GONE_DB = 10, FLANK_BREAK_S = 4, FLANK_LAND_DB = 6, FLANK_RISE_DB = 12, FLANK_HOLD_S = 0.6, FLANK_GRACE_S = 1;
const FLANK_SHORT_S = 2, FLANK_SHORT_RISE_DB = 24, FLANK_SILENT_LV = 0.005;
const SHOW_DROP_GAP_MS = 12000;   // spärr mellan full drops (ägaren 10-12): flank inom spärren = minidrop (dropSpaced)
// LYFT/NÄSTAN-DROP/STOPP (flyttade ur effects.ts stepLifts 11-09): kroppen 120 ms (nearB), normalnivån 8 s, historik i 25 ms-rutor.
const NEAR_RISE_DB = 10, NEAR_DIP_DB = 8, LIFT_DB = 10, STOP_MINI_S = 0.6;

// ── TEMPO-RATTAR (inerta i standard) ──
const COMB3 = 0.33;      // comb-filtrets 3:e-harmonik-vikt (ac[3*lag])
const PRIOR_W = 0.7;   // log-Gauss-priorns bredd
const PRIOR_C = 0;   // prior-centrum (0 = folj fonstret: 1.5 x BPM_MIN)
const SUBH_MULT = Number(env('SUBH_MULT') ?? 3);   // subhSuspect: rostmultiplikator pa OCT-DOWN/NEAR (<prefix>SUBH_GUARD)
const NEAR_REACQ = 3; // NEAR-roster i reacq-fonstret
const SUBH_GUARD = sysOn('SUBH_GUARD');

// Diagnostik-/provrattar i tempovalet (alla inerta i standard, lases en gang):
const HIGH_VOTE = undefined as string | undefined;                          // 'always' | 'cond' | 'sharp'

const HIGH_K = 2;

const HIGH_CAP = undefined as string | undefined;

const HIGH_DIAG = sysOn('HIGH_DIAG');
const VETO_WIN = undefined as string | undefined;

const TG_ADAPT_A = 0.35;

const GHOST_WAIT = sysOn('GHOST_WAIT');

const GHOST_MS = 12000;

/** Instansfalt som MATT (--trace-generalization, 240 s pop-facit, 2026-09-27) byter Smi->Double efter start. Ges Double-form i
 *  konstruktorn (se slutet av constructor) sa kartan inte deprecerar mitt i driften. Fyra av dem stod har redan sedan 896ab7c. */
const DOUBLE_FROM_START = [
  'secHiStartMs', 'secHiEndMs', 'expectHighMs', 'levelVsHighDb',
  'sumSq', 'lastT', 'dbgRms', 'lastKick', 'envAccum', 'envAccumT', 'envBassAccum', 'blAccum', 'lvlSmooth', 'lvlVU', 'engSmooth', 'activeMs',
  'buildUp', 'novSlow', 'kickHit', 'snareHit', 'hatHit', 'bodyEnv', 'bodyFast', 'bodyCeil', 'bodyPeak', 'lastGoneSpanMs', 'lastDropMs',
  'lastMiniGoneMs', 'lastMiniMs', 'pendingKickMs', 'pendingKickW', 'kfPrev', 'kfPrev2', 'beatAnchorMs',
  'blPrev1', 'blPrev2', 'blTrough', 'profBassline', 'bassOnsetsPerBeat',
  'lastConfMs', 'lastVoteMs', 'lowConfSinceMs', 'newSongVote', 'lockPeak', 'nearChallenger', 'octaveVote', 'rawBpmLast', 'localBpmConfidence',
  'secPct', 'secSongStartMs', 'sectionStartMs', 'secBlkMs', 'secBlkInt', 'secBlkCent', 'secBlkRms2', 'secCurDbSum', 'repeatSim', 'repeatAgoMs',
  'miniGoneMs', 'bodyGoneMs', 'lastBodyGoneMs', 'dropArmUntil', 'dropArmAt',
  'fdGone', 'fdSpan', 'fdEnd', 'fdAt', 'fdQuietAt', 'lastShowDropMs', 'dropRiseDb', 'nearB', 'nearNorm', 'nearFloor', 'liftCalm', 'liftLift', 'liftHistAt', 'stopRunS',
  'nearDropDb', 'nearDipDb', 'liftDb', 'stopS',   // byter forst vid forsta drop-episoden (sags i andra matningen)
] as const;
/** TYPSTABILA TALFALT (2026-09-27, realtidsprincipen): skriv ett icke-heltal och sedan ursprungsvardet, sa V8 ger faltet
 *  Double-representation fran start. Ett Smi-initierat falt (0, -1 ...) som senare far ett decimaltal deprecerar objektets
 *  form, och TurboFan kastar all kod som lastes med den formen (matt: 'wrong map'-deopts av process() i stabilt lage). */
function stabiliseNumbers(o: object): void {
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) { const v = r[k]; if (typeof v === 'number') { r[k] = 0.5; r[k] = v; } }
}

export class Analyser {
  private fft: FFT;
  private window: Float32Array;
  private buffer: Float32Array;      // sliding FFT window
  private prevMag: Float32Array;     // transformed magnitude from the previous hop
  private onsetPeak!: Float32Array;  // per-bin whitening peak history
  private onsetPrev!: Float32Array;  // previous raw magnitude for onset differencing
  private onsetPeakReady = false;
  private onsetPeakDecay = 0;
  // --- Pre-allokerade scratchpads för 512-FFT + utdata (GC-skydd: process()
  //     allokerade ~7KB/hop → ~2.6 MB/s skräp @375Hz. Nu 0 alloc/hop). ---
  private windowed512!: Float32Array;   // fönstrad tidssignal (scratch)
  private spectrum512!: number[];       // fft.js komplex-spektrum (scratch)
  private mag512!: Float32Array;        // magnitud denna hop (swap:as med prevMag)
  private outSpecAbs: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outSpec: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outOnset: Spectrum = { sub: 0, kick: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 };
  private outDrum = { kick: 0, snare: 0, hat: 0, bass: 0 };   // trum-envelopes (återanvänt)
  private outProfile = { punch: 0.4, bass: 0.5, bright: 0.3, beat: 0.5, bassline: 0 };   // karaktärsprofil (återanvänt)
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
  private bufferBig!: Float32Array;     // egen glidande buffert (matas samma hops) - RING (a7): äldsta sampel vid bigPos
  private bigPos = 0;
  private prevMagBig!: Float32Array;    // för per-band flux
  private magBig!: Float32Array;        // scratch magnitud
  private magBigMax = 0;                // högsta bin någon läser (band 8-taket)
  /** Cachade vyer (0..magBigMax) till specSink — subarray() per stor-FFT vore 125
   *  alloc/s. Vyerna växlas tillsammans med buffertarna, annars pekar de fel
   *  varannan frame. */
  private magBigView!: Float32Array;
  private prevMagBigView!: Float32Array;

  private specBig!: number[];           // scratch complex (fft.js createComplexArray)
  private static readonly BAND_HZ = [20, 60, 120, 250, 500, 1200, 3500, 10000, 16000];
  private bandLo: number[] = [];        // bin-start per band (förberäknat)
  private bandHi: number[] = [];        // bin-slut per band
  private bandPeak = new Float32Array(8);  // per-band AGC-peak (själv-skalande nivå)
  private bandAbs = new Float32Array(8);   // absolut per-band magnitud före AGC
  private onsetMed = new Float32Array(8);  // robust glidande median av per-band-fluxen
  private onsetMad = new Float32Array(8);  // robust MAD -> troskelspridning per band
  private static readonly ONSET_K = 3.0;   // troskel = median + K*MAD
  private bandLvl = new Float32Array(8);   // scratch: per-band nivå denna frame (~90ms smoothad)
  private bandOn = new Float32Array(8);    // scratch: per-band onset denna frame
  private static readonly KICK_RISE_HOPS = 6;   // kickRise-fönstret (16 ms), = DMX:s FEED_RISE_HOPS
  private kickRiseDb = new Float64Array(Analyser.KICK_RISE_HOPS); private kickRisePos = 0;
  /** BASENERGIN MED SLAGET SOM TIDSENHET (frame.bassEnergy / bassEnergyShort). Alla tider räknas i SLAG ur klockans tempo (60000 / bpm,
   *  hållet inom BE_BEAT_MIN_MS..BE_BEAT_MAX_MS så ett halv-/dubbeltempo inte flyttar skalan långt; utan klocka BE_FALLBACK_MS):
   *  TAKET följer basen direkt upp och glöms mot den på BE_TOP_BEATS slag (frasens skala) resp. BE_FAST_BEATS slag (taktens skala) -
   *  hur fort skalan hinner ikapp ett nivåbyte följer musikens tempo i stället för en klocka i sekunder. Fältet = basens läge i ett
   *  FAST spann BE_SPAN_DB under taket. Bara dB-SKILLNADER: ingen tystnadsgrind och ingen absolut nivå i mätningen (oberoende av
   *  ingångsnivån). Fyra tal i tillstånd (beRef = låtens referens för frame.bassLevel), inga objekt per hop. INGEN DAL HÄR (ägaren 11-11: en dal som återhämtar sig inom slaget
   *  bestämmer pulsens bredd = ljusstyrning) - den ligger i effects.ts stepEnergy och följer fältet, inte ljudet.
   *  (Provat och förkastat i arenan: toppen som kvantil/median av de 32 senaste slagtopparna - plattare ljus, sämre takt i bänken.) */
  private static readonly BE_TOP_BEATS = 16; private static readonly BE_FAST_BEATS = 2; private static readonly BE_SPAN_DB = BASS_SPAN_DB; private static readonly BE_MEM_BEATS = 240;
  private static readonly BE_BEAT_MIN_MS = 300; private static readonly BE_BEAT_MAX_MS = 600; private static readonly BE_FALLBACK_MS = 500;
  private beHi = NaN; private beHiShort = NaN; private beRef = NaN; private beShort = 0;
  /** Stegar skalorna ett hop; returnerar frasens värde, taktens ligger i beShort. */
  private bassEnergyStep(sub: number, kick: number): number {
    const x = 5 * Math.log10(sub + 1e-7) + 15 * Math.log10(kick + 1e-7), hopMs = this.dtHop * 1000;   // 0,25 x sub dB + 0,75 x kick dB
    let per = this.localBpm > 40 ? 60000 / this.localBpm : Analyser.BE_FALLBACK_MS;   // slagets längd ur klockan
    per = per < Analyser.BE_BEAT_MIN_MS ? Analyser.BE_BEAT_MIN_MS : per > Analyser.BE_BEAT_MAX_MS ? Analyser.BE_BEAT_MAX_MS : per;
    this.beHi = !(x <= this.beHi) ? x : this.beHi + (x - this.beHi) * (hopMs / (Analyser.BE_TOP_BEATS * per));
    this.beHiShort = !(x <= this.beHiShort) ? x : this.beHiShort + (x - this.beHiShort) * (hopMs / (Analyser.BE_FAST_BEATS * per));
    this.beRef = this.section === 'high' || !(this.beHi <= this.beRef) ? this.beHi : this.beRef + (this.beHi - this.beRef) * (hopMs / (Analyser.BE_MEM_BEATS * per));   // låtens referens = refrängens tak
    let e = 1 - (this.beHiShort - x) / Analyser.BE_SPAN_DB;
    this.beShort = e > 0 ? e : 0;
    e = 1 - (this.beHi - x) / Analyser.BE_SPAN_DB;
    return e > 0 ? e : 0;
  }

  private bigCounter = 0;                  // decimering av 2048-FFT:n (se BIG_EVERY)
  private static readonly BIG_EVERY = 3;   // kor stor-FFT var N:e hop → analysen ryms i realtid
  /** bandPeak-decay per stor-FFT (τ ≈ 3.8 s oavsett BIG_EVERY). */
  private static readonly PEAK_DECAY = Math.pow(0.9993, Analyser.BIG_EVERY);
  /** SNABBA BANDEN FÖR LJUSET (opt-in <prefix>FAST_BANDS=1, DMX-fyndet 10-21): ramens LJUSFÄLT - spec, specAbs, onset, drum.hat/
   *  snare/bass, midHiDb - räknas VARJE hop ur en snabb väg i stället för ur 2048-FFT:n (42,7 ms Hann, var 3:e hop: 21-27 ms efter
   *  ljudet). Sub/kick/bas (band 0-2) ur en IIR-filterbank i tidsdomänen (Butterworth HP+LP per band, effekten per hop utjämnad
   *  FB_TAU_MS), band 3-7 ur 512-FFT:n (94 Hz per bin räcker där). Egen uppsättning (fb*): 2048-vägens band räknas OFÖRÄNDRAT och
   *  matar allt som är analys eller drop - dropkroppen (bodyDb), sektionen, karaktärsprofilen, basgången, risern. Nivåerna är
   *  kalibrerade mot 2048-vägens bandmedel (FB_K) så dB-skalan är densamma; tidskonstanterna desamma (90 ms nivå, peak-decay ~3,8 s,
   *  onset-medianens steg, uppvärmning), räknade per hop. Mätt 10-21 (faltLatens, 2 filer): specAbs.kick 21 -> 5 ms, onset.kick 27 -> 5,
   *  onset.treble 21 -> 3 ms efter ljudet. */
  private static readonly FAST_BANDS = sysEnv('FAST_BANDS') === '1';
  private static readonly FB_TAU_MS = [12, 6, 3];
  private static readonly FB_K = [385, 475, 313, 1.46, 1.62, 1.8, 2.03, 2.12];   // 2048-medel / snabbt medel, median över 4 ladan-inspelningar (+-2 dB mellan filerna)
  private fbMag = new Float32Array(256); private fbPrevMag = new Float32Array(256);
  private fbLo = new Int32Array(8); private fbHi = new Int32Array(8);
  private fbCoef = new Float64Array(3 * 2 * 5);   // per lågband: HP-biquad + LP-biquad (b0 b1 b2 a1 a2)
  private fbState = new Float64Array(3 * 2 * 4); // x1 x2 y1 y2 per biquad
  private fbPow = new Float64Array(3); private fbPrevAmp = new Float64Array(3); private fbA = new Float64Array(3);
  private fbAbs = new Float32Array(8); private fbDbRaw = new Float32Array(8); private fbLvl = new Float32Array(8); private fbOn = new Float32Array(8);
  private fbPeak = new Float32Array(8).fill(1e-4); private fbOnMed = new Float32Array(8); private fbOnMad = new Float32Array(8);
  private fbAlvl = 0.5; private fbMax = 0; private fbWarm = 0;
  /** Valfri avlyssnare på den stora magnituden (låtminnets fingeravtryck). */
  private specSink: ((mag: Float32Array, binHz: number) => void) | null = null;
  setSpectrumSink(fn: ((mag: Float32Array, binHz: number) => void) | null): void { this.specSink = fn; }

  private kickMed = 0.1;             // robust glidande MEDIAN av kick-fluxen (sign-baserad)
  private kickMad = 0.05;            // robust MAD (median absolut avvikelse) → tröskel-spridning
  private kickSeed = 0;              // warmup-räknare: snabb EMA-seed av skalan innan sign-baserad tar över
  private kickWasAbove = false;      // stigande-flank-detektion
  private kickPrimed = false;        // false på första framen (skräp-flux) → ingen falsk kick
  private static readonly ENV_HZ = 100;
  private static readonly ONSET_PEAK_FLOOR = 0.05;
  /** Onset-ringens langd i sekunder x 100 Hz. Env LOTUS_TEMPO_ENV_S bara for korbanken (bench.mjs) - 5 s ar driftvardet. */
  private static readonly ENV_LEN = 100 * Math.max(3, Math.min(20, Number(sysEnv('TEMPO_ENV_S')) || 5));
  private envRing = new Float32Array(Analyser.ENV_LEN);
  private envPos = 0;
  /** Fasval: 'sum' = bas+helband (standard), 'bass' = basringen forst, helbandet bara nar basen ar tvetydig (kvot < BASS_MIN). Korbank-A/B. */

  /** GRIDFASENS SYSTEMATISKA SLAP (2026-09-23, opt-in LOTUS_GRID_PHASE_TRIM=1). PC-referensen tre dygn i rad:
   *  gridets slap mot Beat This!-slagen 5,7 -> 9,9 -> 18,3 ms (median) medan KICKARNAS bias ar 0,0 ms
   *  (onset bias +0,1 ms, on-beat-recall 0,95). Felet sitter alltsa i fasmatningen, inte i kedjan: fasen mats
   *  pa envelope-ringen i 10 ms-hinkar (ENV_HZ) med max over +-1 sampel, vilket lagger estimatet en halv hink
   *  eller mer efter det verkliga anslaget. Kickarna ar sub-hop-forfinade (parabeltopp) och darmed obiaserade.
   *  TRIM: median av de senaste 8 on-beat-kickarnas offset mot RA gridfas, klampt till +-TRIM_MS, laggs pa
   *  frame.beatPhaseMs. Ingen aterkoppling: offseten mats alltid mot den ORORDA fasen, sa trimmen ar en
   *  absolut skattning och kan inte skena. Rors bara i den snabba vagen (worker/odelad ger samma varde).
   *  MATT 2026-09-23 (korbank, 145 banklatar, live-flaggor, foljar-emulering mot Beat This!-slagen):
   *    av:  offset-median +15 ms, |offset| 22 ms, puls on-beat 0,84, andel |offset| <= 30 ms 0,63
   *    pa:  offset-median +16 ms, |offset| 23 ms, puls on-beat 0,82, andel 0,60   (tempo 114/145 i bada)
   *  ALLTSA INGEN VINST - och det motbevisar premissen: hade kickarna legat 15 ms fore gridet hade trimmen
   *  dragit gridet dit. Att den inte ror sig betyder att kickarna ligger i SAMMA fas som gridet, dvs. hela
   *  onset-fronten (bade analysatorns kickar och PC-referensens onsets, dar biasen mattes till 0 ms) ligger
   *  ~15 ms efter ML-slagen. Det ar en KONSTANT i detektorn, inte ett fasfel att folja. Flaggan lamnas
   *  opt-in och AV som dokumentation av det negativa resultatet; nasta prov ar en konstant, inte en trim. */

  /** ONSET-FRONTENS KONSTANTA SLAP (2026-09-23, opt-in LOTUS_GRID_PHASE_OFFSET_MS, standard 0).
   *  Mattes fram av trimmens misslyckande (se ovan): gridet OCH kickarna ligger i samma fas, ~15 ms efter
   *  ML-slagen (Beat This!). Kedjan ljud->ljus (30 ms, mat med klapp + 240 fps) ar en ANNAN sak och
   *  kompenseras avsiktligt inte - det har ar ett matfel i sjalva detektorn: envelope-ringen ar 10 ms-hinkar
   *  och fasscoret tar max over +-1 sampel, vilket skjuter estimatet efter anslaget. Darfor dras en KONSTANT
   *  fran den utsanda gridfasen (positivt varde = rapportera slaget tidigare). Ingen inlarning, inget att
   *  skena med. Mats i banken som foljarens offset-median mot Beat This!-slagen. */
  private static readonly GRID_PHASE_OFFSET_MS = Number(sysEnv('GRID_PHASE_OFFSET_MS')) || 0;

  /** KLISTRIG FAS (09-20 15:10, live-spar): estimatet bytte halvslag var ~20 s pa NORTHMAN Remix med kvot 1,5 och foljaren hangde med.
   *  Ny fas > 0,3 slag fran forra tas bara nar dess poang slar forra fasens poang med STICKY_K under STICKY_N raka analyser (1,5 s).
   *  Sma justeringar (< 0,3 slag) gar igenom som forr. LOTUS_GRID_PHASE_STICKY=0 stanger av (gamla: 3 raka, ingen marginal). */
  private static readonly STICKY_K = 1.25;
  private static readonly STICKY_N = 6;
  private envLastWallMs = 0;
  // ── SEKTION (opt-in LOTUS_SECTION=1) ──────────────────────────────────────
  /** SEKTIONSLAGE: 'rank' (standard, 09-20 15:35) = kausal percentilrang av 4 s-fonstrets energi+anslagstathet mot alla block
   *  hittills i laten (samma matt som referens, sektionsreferensen, fast i realtid); 'tier' = gamla intensity-tiern (bank: 0,53 = slump). */

  /** SEKTIONEN NOLLAS VID LATBYTE (2026-09-23, opt-in LOTUS_SECTION_ON_HINT=1).
   *  MATT pa 128 latborjor fran kvallens lyssning: vid borjan av en NY lat sager sektionsetiketten 'low' i 77 %,
   *  'high' i 12 %, 'build' i 9 % - och 'intro' i 2 %. Sektionsindex vid ny lat: median 44, max 174. Sektions-
   *  maskineriet nollas namligen BARA vid 10 s tystnad eller full resetTempo, sa i en spellista rullar det vidare
   *  genom hela kvallen: rang-percentilerna jamfor nya laten mot FORRA latens block, `levelVsHighDb` mater mot
   *  forra latens refrang, och 'intro' (som drop-grinden hanger pa) kan aldrig intraffa efter forsta laten.
   *  Det ar samma klass av overhang som kommentaren i hintTrackChange redan dokumenterar for tempogrammet -
   *  och det ar orsaken till agarens "falska drops vid latbyte/intro/outro".
   *  Tempot ror vi INTE: hinten ar fortfarande mjuk dar, av de skal som star i hintTrackChange. */
  /** BLOCK OVER LATGRANSEN (opt-in <prefix>SECTION_CARRY=N, 2026-10-14, DMX-fyndet 'intro 17 % av ladans tid'): hintTrackChange
   *  nollar sektionerna och etiketten star 'intro' tills 20 nya block finns - en FALSK latgrans ger 20 s intro mitt i refrangen.
   *  N > 0: de senaste N blocken (niva/tathet/klang) bars over nollningen, sa rangen fortsatter direkt. 0 = som forr. */
  private static readonly SECTION_CARRY = Analyser.secEnv('SECTION_CARRY', 0);
  /** Forutsagelsens kallor (bitmask): 1 = minne (tidigare sektion med samma etikett), 2 = fras (stigande energi -> 8-taktsgrans). Bank-A/B. */
  private static readonly PREDICT_SRC = 2;   // standard 2 sedan frasgittret: minnet gav +1,6 falska/min utan traffar (09-21 kvall)
  /** Frasregel: LOS (standard): 2 stigande block ELLER energi, horisont 16 takter; LOTUS_PREDICT_STRICT=1: 3 block OCH energi, 8 takter.
   *  Bank 09-21 (12 hela latar, 22 refrangstarter): los 8/22 forutsedda inom +-2 s, lead 11,9 s, 6,0 falska/min; stram 4/22, 4,0/min;
   *  bara minne 2/22, 2,0/min. Taket satts av sektionsdetektorn sjalv (high==high 0,51) - battre sektioner -> battre forutsagelse. */

  /** FRASGITTER (09-21 kvall, agent-sec4): LOTUS_PREDICT_GRID = 'hi' (standard) forankrar frasgittret i senaste 'high'-STARTEN (fore forsta
   *  refrangen: sektionsstarten) i stallet for i varje sektionsstart (som flimrar 6 byten/min) -> samma maltid oavsett nar regeln tander.
   *  'sec' = gamla. LOTUS_PREDICT_LAT = gitterlangd i takter (standard 4; gamla 8). LOTUS_PREDICT_RISE = minsta antal raka stigande block
   *  (secRiseRun) for frasregeln (standard 4; 0 = gamla losa regeln riseRun>=2 || buildUp>0,35 || bInt>0,55). LOTUS_PREDICT_DIP = dB (0 = av):
   *  SUG-regel - blockets dB dyker >= DIP dB under medianen av de 6 blocken fore, i hog kontext (medianen >= refrangens dB - 4) -> high om 2 s
   *  (kalla 3; bara pa dykets forsta block). Bank (12 hela latar, 22 refrangstarter): standard 8/22, 2,0 falska/min (var 8/22, 6,0);
   *  RISE=0 12/22, 6,0/min; DIP=5 ensam 3/22, 0,8/min (kort lead 2,3 s) men +1,2/min ovanpa standard utan nya traffar. */

  private static readonly PREDICT_LAT = 4;
  private static readonly PREDICT_RISE = 4;

  private static readonly RANK_HI = 0.67;
  private static readonly RANK_LO = 0.33;
  private static secEnv(name: string, def: number): number { const v = sysEnv(name); const x = Number(v); return v !== undefined && v !== '' && Number.isFinite(x) ? x : def; }
  /** RANG-RATTAR (09-21, agent-sec1; offline-simulering av 12 hela latar + bank): referens rankar SEGMENTMEDEL, sa fonstret rankas mot
   *  alla 4 s-FONSTERMEDEL hittills (RANK_WIN=0 -> mot enskilda block som forr); kickvikt 0,5 (kicktatheten korrelerar 0,87 med dB men
   *  -0,05 med referensens onsettathet - den ar en nivaproxy, inte ett eget sardrag); centroid 0,5 (basta proxyn for referensens onsettathet,
   *  0,55); hysteres 0,15 kring trosklarna for den redan satta tiern; 3 raka block. Bank: high==high 0,51 -> 0,60, refrang-recall
   *  0,34 -> 0,73, falsk-high 0,58 -> 0,41, byten/lat 15 -> 7. Taket med referensens egna granser och dB ensamt ar ~0,64 (referensens
   *  onsettathet ar negativt korrelerad med dess dB, -0,23). */

  private static readonly RANK_WIN = Analyser.secEnv('SECTION_WIN', 4);
  private static readonly RANK_W_DENS = 0.5;
  private static readonly RANK_W_CENT = 0.5;
  /** NYA SARDRAG I RANGPOANGEN (09-23, agent-sec6; alla 0 = av = identisk poang). Bakgrund: vers 2 och refrang skiljer < 1,5 dB,
   *  kickraknaren ar mattad (~5,8/s overallt, den raknar tempo) och centroiden skiljer ~0,02 - vers 2 ar oskiljbar med dB/kick/centroid.
   *  Referensens tiers (sektionsreferensen) = librosa-RMS + BASONSET-TATHET (onset_strength fmax 220 Hz -> onset_detect toppar/s).
   *  Kandidater, alla per 1 s-block, z-normerade mot latens historik som dB: W_BASSON = basonset-toppar/s (librosa-lik toppplockning
   *  pa ett dB-flux-envelope 20-250 Hz, INTE kickdetektorn), W_BASSENV = medelvarde av samma envelope, W_HIGH = de hoga bandens
   *  absolutniva (bandAbs 6+7, 3,5-16 kHz, dB), W_FLAT = spektral flathet over 8 band (geometriskt/aritmetiskt medel),
   *  W_FLUX = helbandsflux (fluxNorm-medel), W_DYN = dynamik inom blocket (variationskoefficient for rms^2).
   *  MATT 09-23 (blockdump, AUC 4 s-fonster mot proxy-tier / akustiskt upprepningsreferens, train): basonset-toppar 0,51/0,48 (skiljer INGET -
   *  referensens egen onsetPerS skiljer refrang fran vers 2 bara 0,59 mot 0,71 for dB), basenvelope 0,59/0,51, hoga band 0,63/0,71,
   *  flathet 0,56/0,64, flux 0,62/0,73, dynamik 0,46/0,42 (fel tecken), dagens poang 0,64/0,68. BANK (frusen bankmaterial 165, REPEAT 117):
   *  W_HIGH 1,0 = enda som vinner pa TEST mot bada referenserna: sektionsreferens 0,29/0,54/0,65/0,52 -> 0,29/0,57/0,71/0,52 (falsk-high lika),
   *  refrang 2 <= 4 s akustiskt 7/30 -> 9/30 (median 9,1 -> 7,5 s), proxy 1/20 -> 2/20 (proxyns <= 8 s 6 -> 4/20, n litet);
   *  train 0,29/0,61/0,71/0,47 -> 0,38/0,61/0,75/0,47, vers 2 ej high 0,50 -> 0,58. W_FLUX 1,0-1,5 neutral/samre pa refrang 2,
   *  W_HIGH 1,5 lika bra pa test men sektionsreferens oforandrad pa train. Standard 0 (av) tills agaren slar pa. */
  private static readonly RANK_W_BASSON = 0;
  private static readonly RANK_W_BASSENV = 0;
  private static readonly RANK_W_HIGH = 1.0;
  private static readonly RANK_W_FLAT = 0;
  private static readonly RANK_W_FLUX = 0;
  private static readonly RANK_W_DYN = 0;
  /** Basonset-toppplockning (snabba sidan, var BIG_EVERY:e hop = 8 ms): librosa onset_detect-lika parametrar i sampel a 8 ms:
   *  pre_max 4 (30 ms), pre/post_avg 12 (100 ms), wait 4 (30 ms), delta i dB (librosas 0,07 pa ett dB-envelope). */
  private static readonly BASSON_DELTA = 0.07;
  private static readonly BASSON_LEN = 32; private static readonly BASSON_AVG = 12; private static readonly BASSON_MAX = 4; private static readonly BASSON_WAIT = 4;
  private bassOnRing = new Float32Array(Analyser.BASSON_LEN); private bassOnN = 0; private bassOnLastPk = -1e9; private bassOnPeak = false;
  private secBlkBon = 0; private secBlkBpk = 0; private secBlkFlux = 0; private secBlkRms4 = 0;
  private secBlkH: { bon: number[]; bpk: number[]; high: number[]; flat: number[]; flux: number[]; dyn: number[] } = { bon: [], bpk: [], high: [], flat: [], flux: [], dyn: [] };
  private static readonly RANK_HYST = 0.15;
  private static readonly RANK_RUN = Analyser.secEnv('SECTION_RUN', 3);
  /** SNABB ATTACK (09-22, agent-sec5, matt REFRANG 2): LOTUS_SECTION_RUN_IN = antal raka block for att ga IN i tier 2 (high) fran en
   *  lagre tier (0 = som RANK_RUN). Ut ur high galler RANK_RUN som forr (asymmetrisk hysteres: refrangen ska synas direkt, slappa langsamt).
   *  LOTUS_SECTION_HOLD_BARS = N (0 = av): uppehallet i high (REPEAT bit 16/32) ersatts av TAKTSTRUKTUR - minst N takter fran high-starten,
   *  sedan slapps high bara pa en 4-taktsgrans (fas +-1 takt) nar rangen inte langre sager high. */
  private static readonly RANK_RUN_IN = Analyser.secEnv('SECTION_RUN_IN', 0);
  /** BASEN TILLBAKA = HIGH (2026-10-19, DMX-fyndet: 12/68 show-drops gick in i 'build' 2-8 s EFTER smallen): <prefix>SECTION_BODY_HIGH = ms
   *  kroppen (bodyEnv) maste ha varit borta (under taket - BODY_GONE_DB), 0 = av. Nar den kommer tillbaka och inom 2 s nar
   *  bodyPeak - SECTION_BODY_HIGH_DB raknas det som en drop for sektionen: 'high' direkt, forbi uppehallstiden. */
  private static readonly BODY_HIGH_MS = Analyser.secEnv('SECTION_BODY_HIGH', 0);
  private static readonly BODY_HIGH_DB = Analyser.secEnv('SECTION_BODY_HIGH_DB', 3);
  private secBodyRet = 0; private secBodyArmMs = 0;

  /** ATERINTRADE (09-22, agent-sec5): efter forsta refrangen ar refrangnivan kand (lastHighDb). Ar 2-blocksmedlet tillbaka pa den nivan
   *  (>= lastHighDb - REENTRY_DB) och 4 s-fonstrets rang >= REENTRY_PCT (under RANK_HI 0,67) -> 'high' DIREKT utan 3-blocks-run.
   *  Offline-sim pa train-dumpen (14 latar med refrang 2): refrang 2 <= 4 s 0 -> 3/14 (median 12,3 -> 8,0 s), vers 2 oforandrad,
   *  refrang-recall 0,58 -> 0,67, falsk-high 0,54 -> 0,55; dB-gransen binder nastan aldrig (0,5-2,0 lika), rangen ar det som avgor.
   *  REENTRY_PCT = 0 (standard) = av. */

  /** NIVAMINNE (09-22, agent-a47; opt-in LOTUS_SECTION_LEVELREF bitmask): efter refrang 1 finns en ABSOLUT referens (lastHighDb =
   *  refrangens medel-dB, lastHighDens = dess kickar/s). Percentilrangen ar relativ mot allt hittills och trog (4 s-fonster, 3 block,
   *  hysteres) - refrang 2 tog lika lang tid som refrang 1 (bank 09-22: median 12 s). bit 1 INTRADE: blockets dB >= ref - LVL_IN och
   *  kickar >= ref x LVL_IN_DENS i LVL_IN_RUN block i rad -> 'high' direkt, forbi rangen. bit 2 UTTRADE/GRIND: dB <= ref - LVL_OUT i
   *  LVL_OUT_RUN block i rad -> inte 'high' (ur high: 'break'), aven om uppehallet (REPEAT 16/32) sager high - det ar vers 2.
   *  bit 4 REFRANG 1 SNABBT: fore forsta high - blocket >= latens hittills hogsta 4 s-fonstermedel + LVL_PEAK dB och kickar >= medel,
   *  LVL_IN_RUN block i rad -> 'high' (fran 10 s, i stallet for rangens 20 s historik). Referensen nollas med sectionReset (10 s tystnad).
   *  BANK 09-22 (bankmaterial, bench.mjs REFRANG 2, REPEAT 117): block-dB ar i praktiken PLATT genom latarna (median refrang 1 - vers 2 = 0,0 dB,
   *  refrang 2 - refrang 1 = 0,2 dB) och kickraknaren mattad (~5,8/s overallt) - referensens energitiers vilar pa sub-dB-skillnader +
   *  librosa-basonsettathet. Darfor: LVL_IN 2 dB fyrar nastan alltid (vers 2 ej high 0,43 -> 0,22), LVL_OUT 5 dB fyrar aldrig, 1 dB
   *  sanker recall (0,58 -> 0,53); bit 4 gor inget (+1,5 dB over hittills hogsta finns inte). Basta: bit 1 med LVL_IN 0 (hogre an
   *  refrangens medel) i 3 block: train refrang 2 <= 4 s 0/14 -> 5/14, <= 8 s 5 -> 7, median 12,3 -> 6,8 s, vers 2 ej high 0,43 (of.),
   *  refrang-recall 0,58 -> 0,69; med 2 block 6/14, 8/14, 5,4 s men vers 2 0,39. TEST (2 block): 0/13 -> 1/13, 3 -> 4, 30 -> 25 s,
   *  vers 2 0,26 -> 0,21, high==high 0,54 -> 0,49 - vinsten overfors svagt. Standard = 0 (av). */

  private secBlkCentH: number[] = []; private secScoreBuf: Float64Array | Float32Array = SECTION_SCORE_F32 ? new Float32Array(600) : new Float64Array(600);
  private secBlkHighH: number[] = [];
  /** levelVsHighDb-referens: 'section' = senaste refrangens medel-dB (standard), 'rank' = HIGH_REF_P-percentilen av latens block-dB. */

  /** LATGRANS-NYHET (opt-in <prefix>BOUNDARY_NOV=1): bandfordelning + centroid per 1 s-block mot ett langsamt referensavtryck
   *  (BOUNDARY_TAU block); kosinusavstandet stiger nar klangen byts. Raknas pa den sida som kor sectionHop. */

 private bndRef = new Float32Array(9);
  /** Klangnyhet 0..1 per 1 s-block mot det langsamma referensavtrycket (se BOUNDARY_NOV). 0 = av/okand. */
  boundaryNov = 0;
  /** Bandens absoluta magnitud for sektionsblocket (SECTION_AGG 'hop') - scratch sa hop-vagen inte allokerar. */
  private secSpecHop = new Float64Array(8);
  private secBlkRms2 = 0; private secBlkDb: number[] = []; private secBlkDens: number[] = [];
  /** Korbanks-dump (LOTUS_SECTION_DUMP=1): en rad per 1 s-block [tS, dB, kickar, centroid, bInt, breaking, dropped, spec0..7, tier, label] for offline-simulering av rangloggiken. */
  secDump: number[][] | null = sysEnv('SECTION_DUMP') === '1' ? [] : null;
  section = 'intro'; sectionStartMs = 0; sectionIndex = 0; sectionTier = 1; repeatSim = 0; repeatAgoMs = 0; repeatSection = '';
  // Sektionsminne (se Frame.expectHighInMs): logg over avslutade sektioner + forutsagelse + referensniva
  expectHighMs = 0; expectSource = 0; prevSection = ''; levelVsHighDb = 0;
  private secHiStartMs = 0;   // frasgittrets ankare (senaste high-start), sug-regelns mal + flank
  private secLog: Array<{ label: string; startMs: number; endMs: number; db: number; dens: number }> = [];
  private secCurDbSum = 0; private secCurDbN = 0; private secCurDens = 0; private lastHighDb = NaN;
  /** SNABBA KANTER (2026-11-12, uppföljningen av arenan bygg): rangen avgör VILKA partier som är 'high', nivåns kant avgör NÄR.
   *  SEC_EDGE_DB = så stort ska ett nivåskifte vara för att räknas som kant (dB; samma tal åt båda håll och för 'når referensen').
   *  UPP: blocket ligger SEC_EDGE_DB över medianen av frasen före (4 takter ur klockan - medianen ser varken ett hål eller en smäll på
   *  något slag) och når referensen (inom SEC_EDGE_DB från senaste 'high'-partiets nivå, lastHighDb) -> 'high' direkt, rangen ställs på 2.
   *  NED: blocket ligger SEC_EDGE_DB under referensen och blocket före minst halvvägs (skiftet träffar sällan blockgränsen; ett stopp på
   *  ett enda block är inget sektionsbyte) -> ur 'high' direkt till 'low' (dit rangen själv går ur 'high' när nivån fallit), rangen
   *  ställs på 0 och får kvalificera sig på nytt.
   *  Samma mått håller rangen tillbaka: så länge partiet ligger under den refräng musiken lämnade (samma villkor som NED) är rangens
   *  topp 'build' (på väg upp), inte 'high' - annars tar rangen tillbaka ett tyst parti några sekunder efter kanten.
   *  secCarryHighDb = förra låtens referens, buren över låtgränsen som blocken (SECTION_CARRY) tills nya låten har en egen (bara UPP). */
  private static readonly SEC_EDGE_DB = 4;
  private secCarryHighDb = NaN; private secHiEndMs = 0; private secEdgeBuf = new Float64Array(16);
  private secBlkMs = 0; private secBlkN = 0; private secBlkInt = 0; private secBlkKicks = 0; private secBlkCent = 0; private secBlkSpec = new Float32Array(8);
  private secTierRun = 0; private secTierCand = 1; private secRiseRun = 0; private secSongStartMs = 0; private secDropSeen = 0; private secSilentBlocks = 0; private secDropHoldUntil = 0;
  private secHist = new Float32Array(16); private secHistPos = 0; private secHistN = 0;
  private static readonly FP_DIM = 11; private static readonly FP_MAX = 96;
  private secFp = new Float32Array(Analyser.FP_MAX * Analyser.FP_DIM); private secFpT = new Float64Array(Analyser.FP_MAX); private secFpLab: string[] = [];
  private secFpN = 0; private secFpPos = 0; private secFpAcc = new Float32Array(Analyser.FP_DIM); private secFpAccN = 0;
  /** UPPREPNINGSMINNE v2 (09-21, opt-in LOTUS_SECTION_REPEAT bitmask; bank agent-sec3). Det gamla avtrycket (11 positiva dim, cosinus)
   *  gav repeatSim 0,97-1,00 mot ALLT (bandandelar summerar till 1 - vinkeln ar alltid liten) och kunde inte anvandas i beslut.
   *  bit 1: nytt avtryck - 12 dim (8 bandandelar, centroid, kicktathet, intensitet, dB) per 2 s, Z-NORMERAT mot latens egen
   *         historik (alla lagrade avtryck) och SEKVENSMATCHAT (3 rutor = 6 s) mot alla lagen >= 16 s tillbaka. Det matchade
   *         partiet OMRANKAS med dagens kunskap (dess dB/kicktathet mot hela blockfordelningen) -> repeatTier, och tiden for
   *         forsta high-blocket efter det matchade partiet + lag -> repeatHighAtMs ("det forflutna spelas upp igen med lag L").
   *  bit 2: etikettregel HIGH - liknar nuet (sim >= REPEAT_THR) ett parti som nu rankas high och nuet inte ar tydligt lagt -> 'high'.
   *  bit 4: forutsagelse via lag (predictHigh, hogsta prioritet).   bit 8: etikettregel LOW (matchat parti rankas low -> ej 'high').
   *  bit 16: uppehall i high = langsta omrankade high-korningen hittills (tak 40 s); bit 32: prior 8 takter; bit 64: intrade i high nar
   *  det forflutnas high-start + lag ar NU; bit 128: utgang ur high nar det forflutnas high-slut + lag ar NU (och hall tills dess).
   *  BANK 09-21 (12 hela latar, 22 refrangstarter; gransfel / high==high / recall / falsk-high; forutsedd, lead, falska/min):
   *    baslinje (0):        0,32 / 0,51 / 0,34 / 0,58;  8/22, 11,9 s, 6,0
   *    REKOMMENDERAD 117:   0,23 / 0,57 / 0,61 / 0,45;  9/22, 11,2 s, 5,2   (W 2; bit 2 gav inget utover 64, bit 8 sankte recall 0,54->0,47)
   *    245 (= 117 + 128):   0,29 / 0,57 / 0,56 / 0,48; 10/22, 11,2 s, 5,2
   *  Obs: repeatSim byter betydelse med bit 1 (cosinus av z-vektorer, -1..1, typiskt 0,2-0,9; gamla 0,92-troskeln galler inte).
   *  bit 256/512: KLANGMALL (09-22), se TEMPL_*. Varfor bit 2 inte gav nagot: avtryck var 2 s + sekvens 2 rutor = nuet syns forst
   *  4-6 s in i refrangen, dessutom kravs st >= 1 (rangens 3-blocks-hysteres) och att det MATCHADE partiet omrankas high (dB+kickar,
   *  percentil >= 0,67 - i platt country ligger refrangen ofta under). Nar bit 64 (lag-intrade) traffar ar bit 2 overflodig; annars for sen. */
  private static readonly REPEAT = Number(sysEnv('SECTION_REPEAT')) || 0;
  private static readonly REPEAT_THR = 0.7;
  private static readonly REPEAT_STEP = 2;
  private static readonly REPEAT_W = 2;
  private static readonly FP2_DIM = 12; private static readonly FP2_MAX = 128;
  private secFp2 = new Float32Array(Analyser.FP2_MAX * Analyser.FP2_DIM); private secFp2Z = new Float32Array(Analyser.FP2_MAX * Analyser.FP2_DIM);
  private secFp2T = new Float64Array(Analyser.FP2_MAX); private secFp2Db = new Float32Array(Analyser.FP2_MAX); private secFp2Dens = new Float32Array(Analyser.FP2_MAX); private secFp2Lab: string[] = [];
  private secFp2N = 0; private secFp2Pos = 0; private secFp2Acc = new Float32Array(Analyser.FP2_DIM); private secFp2AccN = 0; private secFp2AccDb = 0; private secFp2AccDens = 0;
  private secFp2Mu = new Float32Array(Analyser.FP2_DIM); private secFp2Sd = new Float32Array(Analyser.FP2_DIM);
  private secBlkT: number[] = []; private secRank = { md: 0, sd: 1, mk: 0, sk: 1 }; private secScoreSorted = new Float64Array(601);   // 2026-10-17: typad scratch, sorteras på plats (var number[] + sort((a, b) => a - b): ~10 kB skräp per block)
  /** KLANGMALL (09-22, REPEAT bit 256/512; bank agent 'refrang 2'): refrang 2 later som refrang 1. I stallet for W rutor mot EN punkt
   *  (bit 2: avtryck var 2 s, sekvens 2 rutor = nuet syns forst 4-6 s in i refrangen, och st >= 1 kravde rangens 3-blocks-hysteres) matchas
   *  VARJE 1 s-block (glidande medel TEMPL_SM block) mot MEDELAVTRYCKET av alla block som hittills varit refrang (TEMPL_SRC 'lab' = egna
   *  'high'-etiketter, 'rank' = omrankade high-block) resp. INTE refrang, minst 8 s gamla; z-normerat mot latens alla block, cosinus.
   *  bit 256: simHi >= TEMPL_THR och simHi - simLo >= TEMPL_MARGIN och 4 s-fonstrets rang >= TEMPL_MINPCT -> 'high' direkt (ingen rang-dwell).
   *  bit 512: i 'high' som halls av minnet/prior (st < 2): simLo - simHi >= TEMPL_MARGIN i TEMPL_RUN raka block -> 'break' (vers 2 liknar vers 1).
   *  TEMPL_W: dimensionsvikter 'full' | 'nobass' (band 0-2 bort) | 'timbre' (bara band + centroid) | 'nolvl' (dB bort).
   *  BANK 09-22 (bench.mjs 'refrang2': refrang 2 igenkand <= 4 s / <= 8 s, median; vers 2 ej high; sektionsreferens gransfel/high==high/recall/falsk):
   *    train (n 14)  117 (Pi):            0/14, 5/14, 12,3 s; 0,43; 0,31/0,51/0,58/0,54      119 (bit 2): identiskt med 117
   *                  373 rank (117+256):  4/14, 7/14,  7,8 s; 0,43; 0,30/0,51/0,71/0,55      373 lab: 2/14, 5/14, 11,9 s
   *                  325 rank (uppehall 16/32 AV + 256): 5/14, 8/14, 5,2 s; 0,51; 0,31/0,52/0,62/0,52   <- REKOMMENDERAD
   *    test  (n 13)  117: 0/13, 3/13, 30,1 s; 0,26; 0,27/0,54/0,65/0,52   373 rank: 3/13, 5/13, 25,4 s; 0,17   325 rank: 4/13, 6/13, 15,3 s; 0,26; 0,33/0,52/0,71/0,53
   *  Uppehallet (16/32) var det som gjorde vers 2 till 'high' (halls sa lange som forra refrangen); med mallinträdet ateroppnas high inom
   *  1-2 s nar refrangen ar tillbaka, sa uppehallet behovs inte. Bit 512 (utgang pa klang) ar INTE bankad: offline ar klangen per block
   *  inte separerbar (vers 2 liknar refrangmallen lika ofta som refrang 2; nyhet vid gransen = nyhet inne i sektionen), sa den ar av. */

  private secBlkFeat: Float32Array[] = []; private secBlkHi: number[] = []; private secPct = 0;

  /** Klangmallens likhet for senaste blocket: mot refrangmallen / mot icke-refrangmallen (-1..1; 0 utan mall), antal mallblock. Bank-telemetri. */
  /** Matchat parti: tier med dagens rankning (-1 = inget), och nar 'high' vantas om det forflutna upprepas (absolut tid, 0 = ingen). */
  repeatTier = -1; repeatHighAtMs = 0; repeatHighEndAtMs = 0; private repeatHighRun = 0; private secHighRunMs = 0;
  beatPhaseMs = 0; beatPhaseConf = 0; private phaseAnti = 0; private phaseLastBeatMs = 0; private phaseScratch = new Float32Array(128);

  private phaseScratchB = new Float32Array(128); private phaseScratchF = new Float32Array(128);
  /** Korbanks-telemetri for gridfasen: vald fas mot motfas per band. */
  dbgPhase = { conf: 0, bassOn: 0, bassAnti: 0, fullOn: 0, fullAnti: 0, bestPh: 0, nPh: 0, pending: 0 };
  /** Korbanks-krok: ett anrop per sektionsblock (1 s) med blockets varden (null i drift, ingen kostnad). */
  dbgSecBlock: ((b: Record<string, unknown>) => void) | null = null;
  private envFilled = 0;
  private envAccum = 0;
  private envAccumT = 0;
  private bpmCounter = 0;
  // ── DELAD ANALYSATOR (split.ts) ─────────────────────────────────────────────────────────────
  readonly role: 'all' | 'fast' | 'slow';
  private splitCtrl: Int32Array | null = null; private splitRing: Float64Array | null = null; private splitState: Float64Array | null = null;
  private stateCopy = new Float64Array(STATE_LEN); private stateRd = new StateReader();   // a7: kopian bara när blocket ändrats
  private recSeq = 0;              // fast: senast skrivna record; slow: senast lasta. JS-tal, wrap-sakert (split.ts seqDelta)
  private barrierSeq = 0;          // fast: tillstand aldre an detta record ignoreras (en flagga ar pa vag)
  private pendFlags = 0; private pendHintMs = 0; private pendVclock = 0;
  private flagCnt = new Int32Array(FLAG_BITS);   // fast: antal ganger varje flagga rests (packas i R_FLAGCNT, se split.ts)
  private slowLastCnt = -1;        // slow: R_FLAGCNT i senast behandlade record (-1 = okant, t.ex. direkt efter omstart)
  private slowGap = false;         // slow: records tappade sedan senast behandlade -> kontrollera forlorade flaggor
  private slowLostFlags = 0;       // slow: antal flaggor som aterskapats ur raknarna efter tapp (statistik)
  splitRestarts = 0;               // fast: antal omstarter av workern (satts av index.ts)
  /** TAKTVÄGEN (split.ts): systemets taktmatning i den långsamma tråden. null = ingen (lotus; DMX utan BEAT_FEED 'slow' eller odelad). */
  hopLane: HopLaneFast | null = null;
  /** EN KLOCKA (klocka a8): analysatorn matar SJÄLV sin taktväg sist i process() - profilen utan BEAT_FEED (lotus), vars motor inte
   *  anropar hopLane.feed. DMX (BEAT_FEED 'slow') matar från index.ts som förr. Samma klocka, samma tråd (workern), bara vem som matar. */
  hopSelf = false;
  private syncWorker = false;      // fast: vänta på workern efter varje record; slow: notify efter publicering (bänkens synk-läge)
  /** HOPPETS VÄRDEN (2026-10-17, skräpjakten): decimaltal som skickas som argument till, eller returneras från, en metod som V8 inte
   *  inlinar blir ett nytt HeapNumber per anrop (process 47 -> 6 kB/s skräp när de gick via fält). De heta stegen läser därför hoppets
   *  värden ur fält som process() skriver. Alla initieras som decimaltal (0,5) så fälten har Double-form från start. */
  private hRms = 0.5; private hNow = 0.5; private hDt = 0.5; private hKickFlux = 0.5; private hEnergy = 0.5; private hHopMs = 0.5;
  private hIntensity = 0.5; private hNowWall = 0.5; private hBody = 0.5; private hKick = false; private hLevel = 0.5; private hFlux = 0.5;
  private hInZone = false; private hBreaking = false; private hInRiser = false; private hKickAt = 0.5;
  /** sectionHop:s summor (samma skäl): anroparen fyller, sectionHop läser. */
  private shIn = { hops: 0.5, intSum: 0.5, kicks: 0.5, breaking: false, nowMs: 0.5, dtMs: 0.5, rms2Sum: 0.5, centSum: 0.5, specOff: 0.5, bonSum: 0.5, bpk: 0.5, fluxSum: 0.5, rms4Sum: 0.5 };
  private secAgg = { n: 0, int: 0, kicks: 0, breaking: 0, rms2: 0, cent: 0, dt: 0, wall: 0, drops: 0, active: 0, build: 0, spec: new Float64Array(8), bon: 0, bpk: 0, flux: 0, rms4: 0 };
  private inlinePeer: Analyser | null = null;
  /** STORA VÄGEN (split.ts, a3): 2048-FFT, drop, riser, profil, basgång och sektionsaggregat i långsamma tråden, ett record per hop.
   *  fast: skriver recordet och läser tillbaka; slow: kör stegen. Bara med FAST_BANDS + SECTION_AGG 'hop' och split-buffertarna. */
  readonly bigOn: boolean = false;
  private bigRing: Float64Array | null = null; private bigPcm: Float32Array | null = null; private bigState: Float64Array | null = null; private specRing: Float32Array | null = null;
  private bigSeq = 0; private bigCopy = new Float64Array(BIG_STATE_LEN); private bigRd = new StateReader(); private specCopy = new Float32Array(0); private specDelivered = 0; private specN = 0; private bigSkipped = 0;
  private bigEnvFlag = 0; private bigEnvBpm = 0.5;
  /** Snabba sidans syn på långsamma värden vid hoppet (drop/profil/basgång läser dessa i stället för de levande fälten). */
  private dSec = 'intro'; private dLvh = 0.5; private dConf = 0.5; private dBpm = 0.5;
  /** slow + stora vägen: sektionens syn på drop-räknaren (som R_DROPS förr: värdet vid förra env-recordet). */
  private secVDrops = 0;
  /** PI:NS VERKLIGHET (a3r): EN worker-tråd (motorn är låst till 2 kärnor). Anropas efter varje behandlat env- och hop-record, så
   *  taktvägen (det motorn läser varje hop) körs mellan dem och aldrig köar bakom en hel 2048-backlog. null i bänkens inline/synk-läge
   *  (taktvägen är oberoende av analysatorn, så ordningen påverkar inga värden). */
  bigYield: (() => void) | null = null;
  private secSpecDirty = true;
  private slowBusyEmaUs = 0; private slowBusyMaxUs = 0; private slowLagMaxMs = 0; private slowSkipped = 0; private slowProcessed = 0;
  private localBpm = 0;
  private localBpmConfidence = 0;
  /** Antal estimat sedan senaste latbyte/tystnad -- las inte forran tempogrammet mognat. */
  private warmCalls = 0;
  /** Anrop sedan senaste latbyte -- commiten hallas oppen tills onset-ringen ar ren. */
  private holdCalls = 0;
  // TÄCKNING 60..180 — INTE en oktav (ratio 3). Det är ett medvetet byte av vad
  // MÄTT I LOTUS 2026-08-30: ett 3×-spann (60..180) går sönder i skarp drift —
  // 43 tempohopp på 29 min (kvoter 1/2, 2/3, 3/4, 4/3, 3/2, 2/1), 5,2 % av tiden
  // mer än 12 % fel tempo, och `locked=true, confidence=1.00` under alltihop
  // (konfidensen mäter tempogrammets SKÄRPA, inte korrektheten). Orsaken är att
  // vikningen inte längre ger en unik representant, så oktavgrenarna får två
  // lagliga svar att pendla mellan. 90..180 provades också: allt under 90 vek upp
  // (en 85-BPM-låt blev 170) → "mycket dubbeltakt".
  // REGELN: intervallet MÅSTE vara exakt en oktav (MAX = 2 × MIN). 80..160 är
  // DMX-masterns ursprungliga värde och den enda kombination som både viker unikt
  // och låter en 85-BPM-ballad bo kvar i sin egen oktav.
  // Terminering kräver MAX >= 2*MIN; med t.ex. 90..170 studsar 175 -> 87.5 -> 175
  // i all evighet och motorn hänger.
  // Långsam puls i lugna/snabba partier löses i PRESENTATIONEN (halveringen i
  // effects.ts), inte i vikningen.
  private static readonly BPM_MIN = 80;    // MAX måste vara == 2*MIN (exakt en oktav)
  private static readonly BPM_MAX = Analyser.BPM_MIN * 2;
  /** EVIDENSVAL (2026-09-19): tempogrammet som kandidatgenerator, slagpoang pa basonseten avgor. 0 = gamla argmax. */
  // Korbank 09-19 (med ljuddriven klocka): evidensvalet gav 6/8 syntet = samma som gamla vagen, men 1/6 mot 3/6 pa
  // bankmaterial - verkliga baslinjer har toner pa manga delslag, sa slagpoangen skiljer inte grannkandidater. OPT-IN.
  private static readonly EVIDENCE_ON = sysEnv('TEMPO_EVIDENCE') === '1';
  private static readonly EVIDENCE_K = 5;
  /** EVIDENSBAND (09-20): kandidatvalets slagpoang mots BASringen (standard). 'both' vager in helbandsringen nar basen ar
   *  svag - orkestral/akustisk musik (filmmusik, sjomansvisor) har ingen kick, sa baspoangen blir brus och valet slumpartat.
   *  Vikt = hur mycket basringen sticker ut (basens poangspridning); kvot < EVID_FULL_MIN => helbandet far halva rosten. */

  /** FANTOM UPPAT (opt-in <prefix>TEMPO_UP43=1, 09-24, morgonagenten): evidensvinnaren b (80..160) provas mot b*4/3 och b*3/2 (under 160):
   *  har den hogre perioden minst lika hog traffandel (alignScore.hit) pa HELBANDSringen tas den. Mal: 3+3+2-rytmer (Mio min
   *  mio, facit 141, live 108 = 3/4): basringens traffandel ar mattad (0,8-1,0 for alla kandidater, kickarna sitter pa 3+3+2
   *  sa 141 far LAGRE baspoang an fantomen) - virveln pa 2 och 4 syns bara i helbandet. Korbank live vs live+UP43 (214 latar):
   *  171 -> 180 (+11/-2), test 81 -> 86/104 (+6/-1), syntet 6/8 = 6/8, Mio 1/3 -> 2/3. Basringen som domare gav 176 (+11/-6),
   *  Mio 1/3; helband + poang >= 177, test 84. OBS: traffgransen ar basringens (alignScore cachar percentilen per anrop,
   *  basen raknas forst) - det ar sa varianten bankades. Standard AV = bit-identiskt. */
  private static readonly TEMPO_UP43 = sysEnv('TEMPO_UP43') === '1';
  /** 5/4-FANTOM (opt-in <prefix>TEMPO_FIVE4=1, 10-05): efter evidensvalet (och UP43) provas vinnaren mot 5/4 och 4/5 av tempot pa
   *  HELBANDSringen; en kandidat tas bara om traffandelen ar minst <prefix>FIVE4_MARGIN hogre (standard 0,15). Mal: 10 av 503
   *  musiksnuttar dar facit (PC = Beat This!) och analysatorn skiljer 1,25/0,80 (3 Doors Down, Ricky Rose, Wailers). Standard AV. */
  private static readonly TEMPO_FIVE4 = sysEnv('TEMPO_FIVE4') === '1';
  private static readonly FIVE4_MARGIN = 0.15;
  /** TIDIG REFRANG KRAVER NIVA (2026-09-24, drejboken i ladan: varje lat fick intro -> build -> high vid 20-28 s): direkt efter 20 s-
   *  uppvarmningen rangordnas nuet mot bara introt, sa forsta starkare parti blir 'high' aven om det ar en vers. De forsta
   *  <prefix>SECTION_EARLY_S sekunderna (0 = av) far 'high' bara om de senaste 4 blockens medel ligger >= SECTION_EARLY_DB over
   *  latens blockmedian hittills; annars 'build' (pa vag upp) / kvar. Drop far alltid ge high. */
  private static readonly SECTION_EARLY_S = 45;
  private static readonly SECTION_EARLY_DB = Number(sysEnv('SECTION_EARLY_DB')) || 3;
  /** KICKDETEKTOR-RATTAR (09-20, korbank banken (bench.mjs), BENCH_GRID=1, 107 latar med PC-basonsets/slag):
   *  troskelfaktor mot MAD (4,5), grinden mot eget grid (pa), cooldown (170 ms) och energigolv (0,06). Env for A/B.
   *  Svep 2026-09-20 (tempot orort i alla): baslinje kick-recall 0,48 / precision 0,84 / on-beat-recall 0,63;
   *  grind av 0,52/0,85/0,68; grind av + cooldown 120 -> 0,70/0,84/0,89; cooldown 100 -> 0,82/0,84/0,95 (LIVE sedan
   *  10:23 via tempo-variant.conf); cooldown 80 -> 0,89/0,83/0,96. Orsak: en baston strax fore slaget skuggade slagets
   *  kick i 170 ms, och grinden forkastade slagets kick nar gridet lag fel. K 3,0-3,5 gav inget (0,53/0,85). */
  private static readonly KICK_K = 4.5;
  private static readonly KICK_NOGATE = sysEnv('KICK_NOGATE') === '1';
  /** 0 = tempoanpassad: max(170, 0,6 slag) nar tempot ar kant, annars 170 ms. */
  private static readonly KICK_COOLDOWN_MS = Number(sysEnv('KICK_COOLDOWN')) || 0;
  private static readonly KICK_EFLOOR = Number(sysEnv('KICK_EFLOOR')) || 0.06;
  /** EVIDENSLAS (opt-in, LOTUS_TEMPO_EVIDLOCK=1): laset = median av evidensestimatet i stallet for den gamla lasapparaten.
   *  Korbank 09-19: SAMRE (syntet 4/8 mot 6/8, bankmaterial 1/6 mot 3/6) - grannkandidater poangsatts nastan lika och medianen hoppar.
   *  Glid + commit i den gamla apparaten ger stabiliteten. Kvar for vidare matning. */


  /** Telemetri: foljarens senaste svar. */
  /** Korbank: tempogrammets argmax-lag och sokfonster i senaste anropet. */
  dbgKick: { flux: number; thresh: number; med: number; mad: number; energy: number; gain: number; rms: number; env: number; locked: boolean } | null = null; dbgRms = 0;
  dbgBestLag = 0; dbgLagMin = 0; dbgLagMax = 0; dbgTgAt = (lag: number): number => this.tempoGram[lag] ?? 0;
  /** Evidensomlasning: sa manga computeBpm-anrop i rad (4 Hz lasta = ~2 s) med tydlig, sammanhallen evidens for annat tempo. */
  private static readonly EVID_RELOCK_N = 8;
  evidRelockVotes = 0; private evidRelockBpm = 0;
  /** TEMPOVAXLING INOM LAT (opt-in <prefix>TEMPO_SHIFT=1, 10-09): se shiftDetect(). Av = ingen kod kors (bit-identiskt). */
  /** TAKTEN HALLS OVER EN PAUS (opt-in <prefix>TEMPO_HOLD=1, ladan 2026-10-09: "fran att lamporna slacks tar det tid innan de kommer
   *  igang, kanns inte synkat"). MATT (dynBench --steg, samma lat med 1-4 s tystnad): 350 ms-flanken nollade konfidens, onsetring-fyllnad,
   *  rost-historik och fas -> lasets konfidens 0 i 6-8 s efter aterkomsten och laset kom ofta pa FEL tempo (118 -> 93/133), och under
   *  tystnaden fortsatte tempoberakningen pa nollor (118 -> 130). Med TEMPO_HOLD: kort tystnad (0,35-10 s) ror inte laset - tempo,
   *  konfidens, fas och historik behalls och tempoberakningen VILAR medan det ar tyst (holdSilent). 10 s-regeln (ny lat) ar oforandrad.
   *  Ljuset ar slackt under tystnaden anda (DMX: hard ingangsgrans). Av = ingen kod kors (bit-identiskt). */
  private holdSilent = false; private holdGrace = 0;   // holdGrace: env-sampel kvar da laset halls efter pausen (onsetringen fylls pa nytt)
  private static readonly SHIFT_S = Math.max(2, Math.min(8, 4));
  private static readonly SHIFT_N = 6;
  private static readonly SHIFT_K = 1.3;   // 1,15 gav 394/503 (falska uppat 1,06/1,17); 1,3 gav 396/503, 0 forluster
  private static readonly SHIFT_MAX = 1.19;
  /** Aven nedat (TEMPO_SHIFT_DOWN=1). Standard bara UPPAT: bank 10-09 pa 503 med bada hallen 395 -> 387, forlusterna var nastan alla
   *  falska nedatvaxlingar till ~0,83-0,86 x laset (116->96, 127->108, 134->124) - en 5/6-fantom i det korta fonstret. */

  private static readonly SHIFT_STABLE_MS = (8) * 1000;   // laset ska ha legat inom 3 % sa lange innan en vaxling far tas
  private shiftLag = 0; private shiftVotes = 0; private shiftHoldBpm = 0; private shiftHoldUntilMs = 0; private shiftAgree = 0; private shiftRefBpm = 0; private shiftSinceMs = 0;
  /** Telemetri: antal tempovaxlingar (TEMPO_SHIFT). */
  tempoShifts = 0;
  /** EVIDENSLAS: egen rostring (250 ms, 12 = 3 s) av evidensestimatet; laset ar dess median. */

 private localBpmF = 0;
  /** Antal evidensomlasningar (telemetri/korbank) + lasets senaste slagpoang. */
  evidenceRelocks = 0; evidenceLockScore = 0;
  private candLag = new Int32Array(12); private candVal = new Float32Array(12); private candScore = new Float32Array(12); private candHalf = new Float32Array(12); private candHit = new Float32Array(12);
  /** Senaste evidensvalets telemetri: vald kandidats slagpoang, halvslagskvot, antal kandidater, tvaans poang. */
  evidenceScore = 0; evidenceHalf = 0; evidenceCands = 0; evidenceSecond = 0;
  /** Senaste RA-estimatet (vikt till 80..160) fore las/median - for korbanken. */
  rawBpmLast = 0;
  /** Korbank: kandidaterna fran senaste evidensvalet. */
  debugCandidates(): Array<{ lag: number; bpm: number; tg: number; score: number; half: number; hit: number }> {
    const out: Array<{ lag: number; bpm: number; tg: number; score: number; half: number; hit: number }> = []; for (let i = 0; i < this.evidenceCands; i++) out.push({ lag: this.candLag[i], bpm: Math.round(Analyser.ENV_HZ * 60 / this.candLag[i] * 10) / 10, tg: this.candVal[i], score: this.candScore[i], half: this.candHalf[i], hit: this.candHit[i] });
    return out;
  }
  private octaveVote = 0;   // ackumulerat bevis för att byta oktav (självrättande lås)
  /** Bevis för att DUBBLERA (estimaten pekar högre) mot att HALVERA (lägre).
   *  SYMMETRISKT (8/8): asymmetrin 8/24 hörde till 60..180-experimentet. Med en
   *  ÄKTA oktavvikning kollapsar b och 2b, så grenarna fångar 3:2-/triol-artefakter
   *  — och där vill vi ha snabb rättning åt BÅDA håll.
   *  Grannrättningen är också symmetrisk — se den mätta motiveringen där. */
  // OCT_UP 8 -> 24 (2026-08-31): med EXAKT en oktavs vikning (80..160) kan ett akta
  // oktavfel aldrig overleva vikningen -- b och 2b kollapsar till samma varde. Allt
  // som nar ratio > 1.4 ar darfor en TRIOL-artefakt, inte en oktav. Grenen far dock
  // inte stangas helt: vid 32+ roster fastnade real.wav pa 113 och tog sig aldrig loss.
  // MATT pa riktigt ljud med verifierat referens (Songstats/Tunebat), tre klipp:
  //   OCT_UP  8: utandig 14.4%  real 53.2%  drickervin 100%
  //   OCT_UP 24: utandig 25.0%  real 68.2%  drickervin 100%   <- inre optimum
  //   OCT_UP 32: utandig 25.0%  real  0.0%  drickervin 100%   <- stupet
  // 24 -> 48 (2026-09-01). Efter att bankmaterialet fatt country/Americana utover
  // Ledin-materialet ger 48 atta av elva unika latar ratt mot 24:s sju.
  // Kostar 240 ms laslatens (739 -> 979 ms) men BARA vid kallstart och efter
  // tystnad -- uppvarmningen ar grindad pa localBpm === 0, och vid latbyte
  // behalls tempot. Normal uppspelning paverkas alltsa inte.
  private static readonly REFRAC_N = 20;   // 200 ms @ ENV_HZ 100
  private static readonly RELOCK_K = 2;
  private static readonly WARM_N = 48;
  private static readonly HOLD_N = 50;
  private static readonly OCT_UP = Number(env('OCT_UP') ?? 24);

  // HARMONI-VETO (2026-08-31). En AKTA ny lat landar sallan exakt pa en trioldelning
  // av den forra; en trioltopp i SAMMA lat gor det alltid. Se grann-grenen nedan.
  private static readonly HARM_TOL = 0.035;
  private static readonly HARM_PENALTY = 6;
  private static readonly OCT_DOWN = 8;

  private nearVote = 0;     // bevis för GRANN-fel (t.ex. 122 låst mot 136): bara före commit
  private nearChallenger = 0;  // tempot grann-rösterna pekar på (måste hålla ihop, som challengerBpm)
  private bpmStable = 0;    // antal stabila (finjusterings-)estimat i rad → committa oktaven
  private challengerBpm = -0;   // typstabilt (Double fran start)   // tempot rösterna faktiskt pekar på (måste hålla ihop)
  private lockPeak = 0;        // tempogram-toppens styrka när takten är frisk (referens)
  private lastSongVoteMs = -0;   // typstabilt (Double fran start)  // väggklocka för förra låtbytesrösten (bevis mäts i TID)
  private newSongVote = 0;  // ihållande oenighet trots låst oktav → låtbyte utan tystnadslucka
  /** Antal stabila finjusterings-estimat (@4Hz) innan oktaven committas OCH
   *  låtbytesvakten öppnar. MÅSTE vara samma tal på båda ställena — se dödläget
   *  dokumenterat vid `committed` i computeBpm(). */
  private static readonly BPM_COMMIT = 24;
  /** Väggklocka för när konfidensen senast var frisk (≥0.3) — grund för den mjuka
   *  låssläppningen sist i computeBpm(). 0 = ej satt. */
  private lowConfSinceMs = 0;
  /** Väggklocka: t.o.m. denna tid gäller vidgad tempo-sökning efter en låtbytes-hint. */
  private reacqUntilMs = -0;   // typstabilt (se lastDropRise)

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
  private combScratch = new Float32Array(Analyser.ENV_LEN);
  private prefScratch = new Float64Array(Analyser.ENV_LEN + 1);   // prefix-summa → lokalt medel (whitening)
  private prefSqScratch = new Float64Array(Analyser.ENV_LEN + 1);  // prefix-summa → lokal varians
  /** BASBANDETS onset-envelope (kick-flux), samma raster och position som envRing. */
  private envBassRing = new Float32Array(Analyser.ENV_LEN);
  private envBassAccum = 0;
  private scoreFull = new Float32Array(Analyser.ENV_LEN);
  private scoreBass = new Float32Array(Analyser.ENV_LEN);
  /** Ackumulerat tempogram (EMA av hela lag-kurvan mellan anrop). */
  private tempoGram = new Float32Array(Analyser.ENV_LEN);
  private lastVoteMs = 0;   // tidsviktad median-röstning (max 4 röster/s)
  private lastConfMs = 0;   // tidsbaserad alpha för bpmConfidence (stride-oberoende)
  /** TAKTFAS: vikt per taktslags-plats (idx mod 4) mot cfg.beat-gridet. Ettan bär
   *  tyngsta slaget i så gott som all dansmusik — den plats som samlar mest
   *  kick-tyngd ÄR ettan. Glöms långsamt så ett låtbyte kan flytta fasen. */
  /** Perceptuell prior (log-Gauss runt 120 BPM) per lag — lagg→BPM ar fast, sa
   *  de ~78 Math.exp()-anropen per computeBpm-anrop kan bakas en gang. */
  private priorLut = (() => {
    const t = new Float32Array(Analyser.ENV_LEN);
    for (let lag = 1; lag < Analyser.ENV_LEN; lag++) {
      const oct = Math.log2(((Analyser.ENV_HZ * 60) / lag) / (PRIOR_C || Analyser.BPM_MIN * 1.5));
      // BREDD 2.0 -> 0.7 (sigma 1.0 -> 0.59 oktav).
      // Utsignalen viks ALLTID till [80,160), en enda oktav. En prior bredare an
      // det fonstret later kandidater UTANFOR fonstret tavla pa nastan lika
      // villkor -- och det ar just de som blir 4/3- och 2/3-artefakter efter
      // vikningen.
      // MATT pa 23 latar med publicerat referens + 22 latovergangar:
      //   2.0  20/23 ratt, snitt 87.6 %, TVA 4/3-fel, overgangar 76.9 %
      //   1.0  23/23 ratt, snitt 97.3 %, noll fel,    overgangar 78.0 %
      //   0.7  23/23 ratt, snitt 97.6 %, noll fel,    overgangar 85.2 %  <- vald
      //   0.5  23/23 ratt, snitt 98.3 %, noll fel,    overgangar 86.8 %
      // 0.5 ar marginellt battre pa riktigt ljud men mjukar upp syntetscenariot
      // "breakdown 142" fran 100 % till 88 %. 0.7 tar nastan hela vinsten utan
      // den kostnaden, och "158 (nara gransen)" pastas inte av nagon av dem --
      // fonsterkanten offras alltsa inte.
      // TIDIGARE FELSLUT: pa bara fyra handplockade klipp (alla 90-124, dvs kring
      // priorns egen topp) sag detta ut som overfittning och parkerades. Med 23
      // latars tempospridning ar trenden monoton pa BADA matten.
      t[lag] = Math.exp(-(oct * oct) / PRIOR_W);
    }
    return t;
  })();
  private hGated = false;   // brusgrinden för hoppet (process)
  private silenceLevel = SILENCE_LEVEL;
  /** Släckgränsen live (index.ts, /setup-ratten cfg.silenceLevel). */
  setSilenceLevel(v: number | undefined): void { this.silenceLevel = silenceLevelLive = v ?? SILENCE_LEVEL; }
  private silentMs = -0;   // typstabilt (se lastDropRise)
  private diagLagMin = 0; private diagLagMax = 0;
  private _why = "";   // TRACE: vilken gren bytte tempot (<prefix>BPM_TRACE)
  /** Senast COMMITTADE tempot. SUBHARMONIK-GUARD (<prefix>SUBH_GUARD): en kandidat som ar exakt 2/3 (SUBH_HALF: aven 1/2)
   *  av det (+-4 %) ar nastan alltid comb-filtrets ac[3P]-artefakt vid ett byte -> krav mangfalt mer bevis. */
  private lastGoodBpm = 0;
  private subhSuspect(cand: number): boolean {
    if (!SUBH_GUARD || this.lastGoodBpm <= 0 || cand <= 0) return false;
    const r = cand / this.lastGoodBpm;
    return Math.abs(r / (2 / 3) - 1) < 0.04;
  }
  /** Tempogrammets lagfonster i senaste anropet (diagnostik). */
  get lagBounds(): [number, number] { return [this.diagLagMin, this.diagLagMax]; }
  get tempoGramSnapshot(): Float32Array { return this.tempoGram; }
  private static readonly TG_KEEP = 0;      // hintTrackChange: 0 = nolla tempogrammet, (0,1) = skala ner
  private static readonly REFRAC_ATT = 0;   // env-ringens refraktar: 0 = nolla sampel efter stort anslag
  /** TYDLIG BASGANG: basNOTER (bandLvl[1]+bandLvl[2], 60-250 Hz) mellan kickarna pa env-rastret; en topp ar en not om den
   *  reser sig >= 25 % av senaste topphojd over dalen och inte ligger inom 60 ms efter en kick. Noter per slag (2 s fonster)
   *  -> profile.bassline 0..1, glattat ~1 s. */
  private blAccum = 0; private blPrev1 = 0; private blPrev2 = 0; private blRef = 0.1; private blLastOnset = -100;
  private blOnsets = new Int32Array(32); private blOnsetPos = 0; private envSeq = 0; private profBassline = 0; private blTrough = 1; private blKickSeq = -100;
  bassOnsetsPerBeat = 0;
  // DIAGNOSTIK (<prefix>HIGH_DIAG / HIGH_VOTE): diskant-onset-ring (bandOn[6]/[7]) - mater om diskanten bar tempot.
  private envHighRing = new Float32Array(Analyser.ENV_LEN);
  private envHighAccum = 0;
  private scoreHigh = new Float32Array(Analyser.ENV_LEN);
  private _hiTop = 0; private _hiVal = 0; private _eHigh = 0;
  /** Peak-to-mean over [lagMin,lagMax] — hur SKARP bandets autokorrelationstopp ar. */
  private sharpOf(arr: Float32Array, lagMin: number, lagMax: number): number {
    let mx = 0, sum = 0, n = 0;
    for (let l = lagMin; l <= lagMax; l++) { const v = arr[l]; if (v > mx) mx = v; sum += v; n++; }
    return n > 0 && sum > 0 ? mx / (sum / n) : 0;
  }
  /** true = tystnadssläppningen redan gjord för denna tystnad (flanktriggad). */
  private silenceArmed = false;
  private beatAnchorMs = 0;
  // #2 sub-hop fas: kick-flankens flux-topp ligger sällan exakt på en hop. Vi
  // sparar de två föregående kick-flux-värdena och gör parabolisk interpolation
  // hoppet EFTER en kick → förfinar beatAnchorMs med ±0.5 hop (~1.3ms). Ren
  // fas-korrektion; själva kick-blixten fyrar oförändrat direkt.
  private kfPrev = 0;
  private kfPrev2 = 0;
  private pendingKickMs = 0;   // >0 = kick väntar på fas-förfining nästa hop
  private pendingKickW = 1;    // slagets ABSOLUTA anslagsstyrka — vikt i taktfas-räkningen
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

  private inZoneState = false;   // hysteres för topp-zonen
  /** BASKROPPEN — (sub+kick+bas)/3, utjämnad. Det är HÄR en drop syns.
   *  MÄTT över 15 min av ägarens egen musik: `level` ligger i sin övre tredjedel
   *  67 % av tiden (dynamik p90/p10 = 2.1) — den kan omöjligt peka ut ett särskilt
   *  ögonblick. Baskroppen ligger högt bara 9 % av tiden (dynamik 5.6). Sång och
   *  synth håller uppe nivån hela låten; det som FÖRSVINNER i en breakdown och
   *  SLÅR TILLBAKA i dropen är basen.
   *  Nivå-baserad zon gav 172 flanker på 15 min (en var 5:e sekund) för ~19 drops.
   *  Baskropps-zonen ger 46 (en var 20:e sekund) — rätt storleksordning. */
  private bodyEnv = -120;
  /** Snabb envelopp (0.12 s) ENBART for stigningstakten. Den langsammare
   *  bodyEnv (0.35 s) styr tak och franvaro. Blandar man ihop dem dampas
   *  stigningen och trosklarna slutar motsvara det som mattes i banken. */
  private bodyFast = -120;
  private bodyCeil = -300;   // dB
  private bodyPeak = -300;   // SEG topp (loud-referens i minuter) for landa-hogt
  private lastGoneSpanMs = 0;
  private lastDropRise = -0;   // -0 = HeapNumber: Double-falt fran start (typstabilt), beter sig som 0
  private wasBodyOnset = false;
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
  private miniDropCount = 0; private lastMiniMs = -1e9; private miniGoneMs = 0; private lastMiniGoneMs = -1e9; private wasMiniOnset = false;
  private dropArmUntil = 0; private dropArmAt = 0; private dropArmGoneMs = -1.5;   // armerat drop-fonster (DROP_ARM_MS)
  private calmHoldStart = -0; private calmHoldRise = -0;   // DROP_CALM_LAND_MS: kandidat som halls for verifierad landning

  private goneEpisodeMs = -1.5;   // (double fran start, se dropArmGoneMs) gone-episodens START (lastBodyGoneMs uppdateras varje hop och duger INTE som id)
  private dropCount = 0;         // monoton drop-räknare (edge-säker för konsumenter) - full drop på flanken
  private dropCand = 0;          // slam-kandidaterna (förr dropCount): sektionens drop-evidens och minidrop utan flank
  private dropDemoted = 0; private dropSpaced = 0; private dropRiseDb = -0;
  private fdGone = -0; private fdSpan = -0; private fdEnd = -1e12; private fdAbove = true; private fdAt = -1e12; private fdQuietAt = -1e12; private lastShowDropMs = -1e12;
  private fdT = new Float64Array(1024); private fdV = new Float64Array(1024); private fdS0 = 0; private fdN = 0;   // (tid, bodyFast) för toppens fönster
  private nearOn = false; private nearB = -0; private nearNorm = -0; private nearFloor = 1e9; private liftCalm = -0; private liftLift = -0;
  private liftHist = new Float64Array(240); private liftW = 0; private liftN = 0; private liftHistAt = -1e12; private stopRunS = -0;
  private nearDropDb = -0; private nearDipDb = -0; private liftDb = -0; private stopCount = 0; private stopS = -0;
  private lastDropMs = -1.5e9;   // utanfor Smi-intervallet -> Double fran start (typstabilt)
  // RISER/UPPBYGGNAD (flyttad från effects)
  /**
   * OBEHANDLAD LOGBANDNIVÅ — riserdetektorns egen ingång.
   *
   * `bandLvl` går genom per-band-AGC:n, och den har NOLL attacktid: så fort
   * `avg > bandPeak` sätts taket till `avg`, och kvoten blir avg/avg ≈ 1. En
   * STIGANDE bandnivå är därmed per konstruktion konstant 1,0 — och en riser ÄR
   * definitionsmässigt en monoton stigning i flera band samtidigt. Alla band
   * pinnar på 1, tvåsekundersmedelvärdet hinner ikapp, och novelty går mot noll.
   *   DET är förklaringen till den uppmätta `buildUp` p50 = p90 = 0.00. Signalen
   *   var inte feljusterad, den var BORTKALIBRERAD av sin egen normalisering.
   * `bandLvl` lämnas orörd — hela effektlagret är kalibrerat mot den. Riser och
   * novelty läser i stället den här, i dB, där en ramp är en ramp oavsett nivå.
   */
  private bandDb = new Float32Array(8);
  private bandDbRaw = new Float32Array(8);   // RA dB per band (drop-detektorns kropp) — synk fran DMX-master 2026-09-03
  /** Stor-FFT-rutor med signal i rad. Onsets hålls tysta tills MAD hunnit byggas
   *  upp — se `ONSET_WARM` och kommentaren vid bandOn. */
  private onsetWarm = 0;
  /** ~1,5 s vid 125 Hz. MAD startar i noll efter tystnad och byggs upp med
   *  `mad ← 1.006·mad + 6e-5`, vilket tar ≈183 rutor att nå ett användbart värde. */
  private static readonly ONSET_WARM = 183;
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
  private lvlVU = 0;      // ~200ms hop-takt-smooth av levelRaw → VU-taket (låg jitter)
  private engSmooth = 0;
  private centSmooth = 0.5;

  private gainLocked = false;

  /** Called when the input routing changes — the old gain is meaningless for
   *  the new source's signal level, so re-converge from neutral. */

  resetGain(startGain = 1) {
    // Seed per input: line (aux) arrives hot -> 1x; the room mic is weak -> ~20x.
    this.gain = Math.max(0.5, Math.min(20, startGain));
    // NEUTRALT ÄR autoGainTarget, INTE 0: AGC:n räknar desired = target/max(1e-4, env),
    // så env = 0 ger ett enormt tal som slår gainen i 20x-taket innan envelopen
    // konvergerat — en hörbar ljuspump vid varje ingångsbyte.
    this.envelope = this.cfg.detection.autoGainTarget;
    this.resetAgcBlocks();
  }

  /** Lock the AGC (aux: fixed 1x, level tracks the mixer directly) or let it run. */
  setGainLock(locked: boolean, fixed = 1) {
    this.gainLocked = locked;
    if (locked) { this.gain = fixed; this.envelope = this.cfg.detection.autoGainTarget; this.resetAgcBlocks(); }
  }

  /** PERCENTIL-AGC: 16 blockmaxima à 128 ms (~2 s historik) av RÅ rms. Envelopen är
   *  näst största blockmaximum ≈ 95:e percentilen — en enstaka transient kan alltså
   *  inte dra ner gainen, men en ihållande het ingång kan.
   *  MÄTT I LOTUS: momentan-nivå som AGC-mål pinnade level ≥0.95 i ~55 % av tiden
   *  med upp till 21 % klipp; uppbyggnader blev osynliga eftersom nivån redan låg i
   *  taket. Percentilen tar bort inbränningen — därför är målet ett TAK för topparna,
   *  aldrig ett medelvärde att sikta på. */
  private static readonly AGC_BLOCKS = 16;
  private static readonly AGC_BLOCK_MS = 128;
  private agcBlocks = new Float32Array(Analyser.AGC_BLOCKS);
  private agcBlockIdx = 0;
  private agcBlockMax = 0;
  private agcBlockStartMs = 0;
  private agcBlocksFilled = 0;

  private resetAgcBlocks(): void {
    this.agcBlocks.fill(0);
    this.agcBlockIdx = 0; this.agcBlockMax = 0; this.agcBlockStartMs = 0; this.agcBlocksFilled = 0;
  }

  /** Mata in rå rms; returnerar näst största av de senaste 16 blockmaxima (0 = ej varm). */
  private agcEnvelope(rawRms: number, nowMs: number): number {
    if (rawRms > this.agcBlockMax) this.agcBlockMax = rawRms;
    if (this.agcBlockStartMs === 0) this.agcBlockStartMs = nowMs;
    if (nowMs - this.agcBlockStartMs >= Analyser.AGC_BLOCK_MS) {
      this.agcBlocks[this.agcBlockIdx] = this.agcBlockMax;
      this.agcBlockIdx = (this.agcBlockIdx + 1) % Analyser.AGC_BLOCKS;
      if (this.agcBlocksFilled < Analyser.AGC_BLOCKS) this.agcBlocksFilled++;
      this.agcBlockMax = 0;
      this.agcBlockStartMs = nowMs;
    }
    // Näst största över de fyllda blocken (16 tal → linjär skanning är billigast).
    if (this.agcBlocksFilled < 2) return 0;
    let top = 0, second = 0;
    for (let i = 0; i < this.agcBlocksFilled; i++) {
      const v = this.agcBlocks[i];
      if (v > top) { second = top; top = v; }
      else if (v > second) { second = v; }
    }
    return second;
  }


  /** SEKTION (2026-09-20). Realtidens sektionstillstand ur latens EGEN historik - inget latminne, ingen PC, inget moln
   *  (slutlaget: bada Pi-systemen kor allt i realtid). Bygger pa intensity (niva relativt latens robusta baslinje),
   *  buildUp/breaking/drop-detektorn och en 1 s-blockstatistik. Tier (lag/mellan/hog) med 3 s hysteres; trend = skillnad
   *  mot 8 s tidigare. Upprepning: ett klangavtryck per 4 s (8 band normerade + centroid + kicktathet + intensitet, L2)
   *  jamfors med alla avtryck >= 16 s tillbaka (max 96 = 6,4 min); bast cosinus -> repeatSim/repeatAgoMs/repeatSection.
   *  Kostnad: nagra adds per hop, ~100 punktprodukter a 11 var fjarde sekund. Referens for bansken: all-in-one pa hela latar. */
  /** Sektionens drop-evidens: levande i roll 'all'/'fast'; i workern med stora vägen värdet vid förra env-recordet (som R_DROPS förr). */
  private secDropsNow(): number { return this.role === 'slow' && this.bigOn ? this.secVDrops : this.dropCand + this.secBodyRet; }
  private sectionReset(): void {
    this.section = 'intro'; this.sectionStartMs = 0; this.sectionIndex = 0; this.sectionTier = 1; this.repeatSim = 0; this.repeatAgoMs = 0; this.repeatSection = '';
    this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0);
    this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0; const H = this.secBlkH; H.bon.length = 0; H.bpk.length = 0; H.high.length = 0; H.flat.length = 0; H.flux.length = 0; H.dyn.length = 0;
    this.secTierRun = 0; this.secTierCand = 1; this.secRiseRun = 0; this.secSongStartMs = 0; this.secBlkRms2 = 0; this.secBlkDb.length = 0; this.secBlkDens.length = 0; this.secBlkCentH.length = 0; this.secDropSeen = this.secDropsNow(); this.secSilentBlocks = 0; this.secDropHoldUntil = 0;
    this.secHistN = 0; this.secHistPos = 0; this.secFpN = 0; this.secFpPos = 0; this.secFpLab.length = 0; this.secFpAcc.fill(0); this.secFpAccN = 0;
    this.secLog.length = 0; this.secCurDbSum = 0; this.secCurDbN = 0; this.secCurDens = 0; this.lastHighDb = NaN; this.secCarryHighDb = NaN; this.secHiEndMs = 0; this.expectHighMs = 0; this.expectSource = 0; this.prevSection = ''; this.levelVsHighDb = 0;
    
    this.secHiStartMs = 0; this.secPct = 0;
    this.secFp2N = 0; this.secFp2Pos = 0; this.secFp2Lab.length = 0; this.secFp2Acc.fill(0); this.secFp2AccN = 0; this.secFp2AccDb = 0; this.secFp2AccDens = 0;
    this.secBlkT.length = 0; this.secRank.md = 0; this.secRank.sd = 1; this.secRank.mk = 0; this.secRank.sk = 1; this.repeatTier = -1; this.repeatHighAtMs = 0; this.repeatHighEndAtMs = 0; this.repeatHighRun = 0; this.secHighRunMs = 0;
    this.secBlkFeat.length = 0; this.secBlkHi.length = 0; this.secPct = 0;

    this.secBlkHighH.length = 0; this.bndRef.fill(0); this.boundaryNov = 0;
  }

  /** Tar BLOCKSUMMOR (n hop): i roll 'all' anropas den per hop med n = 1, i workern en gang per env-sampel med summorna
   *  for de ~4 hoppen (split.ts). Samma matematik - medelvardena delas med secBlkN i bada fallen. */
  private sectionHop(spec: ArrayLike<number>): void {
    const I = this.shIn, hops = I.hops, intSum = I.intSum, kicks = I.kicks, breaking = I.breaking, nowMs = I.nowMs, dtMs = I.dtMs, rms2Sum = I.rms2Sum, centSum = I.centSum,
      specOff = I.specOff, bonSum = I.bonSum, bpk = I.bpk, fluxSum = I.fluxSum, rms4Sum = I.rms4Sum;
    if (this.secSongStartMs === 0) { this.secSongStartMs = nowMs; this.sectionStartMs = nowMs; this.secDropSeen = this.secDropsNow(); }
    this.secBlkMs += dtMs; this.secBlkN += hops; this.secBlkInt += intSum; this.secBlkKicks += kicks; this.secBlkCent += centSum; this.secBlkRms2 += rms2Sum;
    this.secBlkBon += bonSum; this.secBlkBpk += bpk; this.secBlkFlux += fluxSum; this.secBlkRms4 += rms4Sum;
    for (let i = 0; i < 8; i++) this.secBlkSpec[i] += spec[specOff + i];
    if (this.secBlkMs < 1000) return;
    this.sectionBlock(nowMs, breaking);
  }

  /** Blockets sardrag och etikett (1 s): den kalla delen av sectionHop, egen funktion sa att dess sallan korda grenar inte deoptimerar 100 Hz-ackumuleringen. */
  private sectionBlock(nowMs: number, breaking: boolean): void {
    const n = this.secBlkN || 1; const bInt = this.secBlkInt / n; const bKicks = this.secBlkKicks; const bCent = this.secBlkCent / n;
    const blkDb = 10 * Math.log10(this.secBlkRms2 / n + 1e-10);
    // NYA SARDRAG (09-23): basonset-envelope/toppar, hoga band, flathet, flux, dynamik - per block, se RANK_W_*.
    const bBon = this.secBlkBon / n, bBpk = this.secBlkBpk / Math.max(0.25, this.secBlkMs / 1000), bFlux = this.secBlkFlux / n;
    const m2 = this.secBlkRms2 / n, v2 = this.secBlkRms4 / n - m2 * m2; const bDyn = m2 > 1e-12 ? Math.sqrt(Math.max(0, v2)) / m2 : 0;
    let sAr = 0, sGe = 0; for (let i = 0; i < 8; i++) { const v = this.secBlkSpec[i] / n + 1e-7; sAr += v; sGe += Math.log(v); }
    const bFlat = Math.exp(sGe / 8) / (sAr / 8); const bHigh = 20 * Math.log10((this.secBlkSpec[6] + this.secBlkSpec[7]) / n + 1e-7);
    // tystnad mellan latar: 3 tysta block -> ny lat
    if (this.activeMs === 0) { if (++this.secSilentBlocks >= 10) { this.sectionReset(); return; } }   // 10 s tystnad (var 3: en tyst vers nollade laten, Regnblota 100 s)
    else this.secSilentBlocks = 0;
    // tier med hysteres
    let tier = bInt >= 0.62 ? 2 : bInt <= 0.40 ? 0 : 1;
    {
      // KAUSAL PERCENTILRANG (15:35): blockets dB (ra rms, fore AGC) och basonset-tathet (kickar/s) z-normeras mot alla block
      // hittills i laten, 4 s-fonstrets medelpoang rangordnas mot alla blockpoang hittills. Minst 20 s historik; innan dess 'intro'.
      const db = 10 * Math.log10(this.secBlkRms2 / n + 1e-10); this.secBlkDb.push(db); this.secBlkDens.push(bKicks); this.secBlkCentH.push(bCent); this.secBlkHighH.push(bHigh); if (Analyser.REPEAT & 1) this.secBlkT.push(nowMs);
      { const H = this.secBlkH; H.bon.push(bBon); H.bpk.push(bBpk); H.high.push(bHigh); H.flat.push(bFlat); H.flux.push(bFlux); H.dyn.push(bDyn); }
      if (this.secBlkDb.length > 600) { this.secBlkDb.shift(); this.secBlkDens.shift(); this.secBlkCentH.shift(); this.secBlkHighH.shift(); { const H = this.secBlkH; H.bon.shift(); H.bpk.shift(); H.high.shift(); H.flat.shift(); H.flux.shift(); H.dyn.shift(); } if (Analyser.REPEAT & 1) this.secBlkT.shift();  }
      const nb = this.secBlkDb.length;
      if (nb >= 20) {
        tier = this.rankTier(nb);
      } else { tier = 1; this.secPct = 0; }
    }
    if (tier === this.secTierCand) this.secTierRun++; else { this.secTierCand = tier; this.secTierRun = 1; }
    const runNeed = (Analyser.RANK_RUN_IN > 0 && this.secTierCand === 2 && this.sectionTier < 2) ? Analyser.RANK_RUN_IN : Analyser.RANK_RUN;
    if (this.secTierRun >= runNeed) this.sectionTier = this.secTierCand;
    // SNABBA KANTER (se SEC_EDGE_DB): nivåskiftet mot referensen tar etiketten direkt, förbi rangens fönster, lopp och uppehållstid.
    let edgeUp = false, edgeDown = false, fallen = false;
    {
      const D = this.secBlkDb, nb = D.length, E = Analyser.SEC_EDGE_DB, ref = this.lastHighDb === this.lastHighDb ? this.lastHighDb : this.secCarryHighDb;
      fallen = nb >= 2 && blkDb <= this.lastHighDb - E && D[nb - 2] <= this.lastHighDb - E / 2;   // partiet ligger under låtens egen referens
      if (this.section === 'high') edgeDown = fallen;
      else if (blkDb >= ref - E) {
        const barMs = this.localBpm > 40 ? 240000 / this.localBpm : 4 * Analyser.BE_FALLBACK_MS;
        const m = Math.min(nb - 1, 4 * Math.max(2, Math.min(4, Math.round(barMs / 1000)))), w = this.secEdgeBuf;   // frasen före blocket, i block
        if (m >= 4) {
          for (let i = 0; i < m; i++) { const v = D[nb - 2 - i]; let k = i; while (k > 0 && w[k - 1] > v) { w[k] = w[k - 1]; k--; } w[k] = v; }
          edgeUp = blkDb - w[m >> 1] >= E;
        }
      }
      if (edgeUp || edgeDown) { this.sectionTier = edgeUp ? 2 : 0; this.secTierCand = this.sectionTier; this.secTierRun = 0; }
    }
    const st = this.sectionTier;
    // trend mot 8 s sedan
    this.secHist[this.secHistPos] = bInt; this.secHistPos = (this.secHistPos + 1) & 15; if (this.secHistN < 16) this.secHistN++;
    const rise = this.secHistN >= 9 ? bInt - this.secHist[(this.secHistPos - 9 + 16) & 15] : 0;
    this.secRiseRun = rise >= 0.10 ? this.secRiseRun + 1 : 0;
    const sinceStart = nowMs - this.secSongStartMs; const dropEv = this.secDropsNow(); const dropped = dropEv !== this.secDropSeen; this.secDropSeen = dropEv;
    const prev = this.section; let label: string;
    {
      // rang-lage: tier 2 = high, tier 0 = low, mitten = 'break' pa vag ner fran high, 'build' pa vag upp fran low/intro, annars kvar
      // SECTION_BODY_HIGH aven i intro (DMX-fyndet 10-20: latgransen 0,1-7 s fore dropen nollade till intro, smallen nadde aldrig high):
      // basen tillbaka = 'high' direkt och kvar tills rangen har 20 block.
      if (this.secBlkDb.length < 20) label = edgeDown ? 'low' : edgeUp || (Analyser.BODY_HIGH_MS > 0 && (dropped || prev === 'high')) ? 'high' : 'intro';
      else if (dropped || st === 2) label = 'high';
      else if (st === 0) label = 'low';
      else label = prev === 'high' || prev === 'break' ? 'break' : (prev === 'low' || prev === 'intro' || prev === 'build') ? 'build' : prev;
      if (label === 'high' && !dropped && !edgeUp && prev !== 'high' && sinceStart < Analyser.SECTION_EARLY_S * 1000 && this.secBlkDb.length >= 4) {
        const D = this.secBlkDb, nb = D.length; const srt = D.slice().sort((a, b) => a - b); const med = srt[nb >> 1];
        const m4 = (D[nb - 1] + D[nb - 2] + D[nb - 3] + D[nb - 4]) / 4;
        if (m4 < med + Analyser.SECTION_EARLY_DB) label = prev === 'intro' || prev === 'low' || prev === 'build' ? 'build' : prev;
      }
      // MINNET (bit 2/8): nuet liknar ett tidigare parti -> det partiets tier (omrankad med dagens kunskap) vager in.
      // INTRADE VIA LAG (bit 64): det forflutnas high-start + lag ar NU (-1,5..+1 s) -> high direkt, utan rangens 2-blocks-hysteres + 4 s-fonster
      if ((Analyser.REPEAT & 64) && this.repeatSim >= Analyser.REPEAT_THR && this.repeatHighAtMs > 0 && st >= 1 && label !== 'high' && !dropped) {
        const d = this.repeatHighAtMs - nowMs; if (d >= -1500 && d <= 1000) label = 'high';
      }
      // ATERINTRADE (REENTRY_PCT): nivan ar tillbaka pa refrangens och rangen nastan uppe -> high direkt (refrang 2 <= 4 s)
      // KLANGMALL IN (bit 256): blocket later som refrangen hittills (och inte som resten) och rangen ar inte tydligt lag -> high direkt
      // UPPEHALL I HIGH (bit 16 minne / bit 32 prior 8 takter): rangen dippar till mellan mitt i refrangen (4 s-fonster) -> high -> break -> high
      // var 4 s (baslinjen: joaquinphoenix 24h 28b 32h 36b 45h mot referens high 27-102 s). Sa lange forra refrangen varade halls high; tier 0 slapper.
      if ((Analyser.REPEAT & 48) && prev === 'high' && label === 'break' && st === 1) {
        {
          let hold = (Analyser.REPEAT & 16) ? Math.min(40000, this.secHighRunMs) : 0;
          if ((Analyser.REPEAT & 32) && this.localBpm > 0) hold = Math.max(hold, 8 * 240000 / this.localBpm);
          if (nowMs - this.sectionStartMs < hold) label = 'high';
        }
      }
      // DROPEN HALLER HIGH (2026-11-03, DMX-fyndet 11-02: break med full bas efter dropen, high 66,2 -> break -> high 71,3 i ladan):
      // dropped ger high i ett block, men rangens 4 s-fonster bar breakets block i RANK_WIN + RANK_RUN block till - sa lange halls
      // 'high' efter en drop om tier >= 1; tier 0 slapper. Standard i koden sedan 11-03 (agaren; backup/fore-drop-hold-20261103).
      if (dropped && label === 'high') this.secDropHoldUntil = nowMs + (Analyser.RANK_WIN + Analyser.RANK_RUN) * 1000;
      else if (prev === 'high' && label !== 'high' && st >= 1 && nowMs < this.secDropHoldUntil) label = 'high';
      // UTGANG VIA LAG (bit 128): det forflutnas high-SLUT + lag. Sa lange det forflutna fortfarande ar high halls high (st 1);
      // nar slutet ar NU (-1,5..+1,5 s) och rangen inte langre sager high -> 'break' direkt (minnets grans i stallet for uppehallets slut).
      // NIVAMINNE (LEVELREF, se flaggan): absolut referens fran refrang 1 i stallet for den troga percentilrangen. Drop vinner alltid.
      // KLANGMALL UT (bit 512): high som bara halls (rangen sager inte high) men blocket later som icke-refrangen i TEMPL_RUN raka block -> break
    }
    // RANGEN NÅR INTE REFERENSEN (se SEC_EDGE_DB): rangen säger topp men partiet ligger kvar under den refräng musiken lämnade ->
    // på väg upp ('build'), inte framme. Gäller så länge den referensen är färsk (BE_MEM_BEATS slag, som basenergins referens).
    if (label === 'high' && prev !== 'high' && !dropped && !edgeUp && fallen && nowMs - this.secHiEndMs < Analyser.BE_MEM_BEATS * (this.localBpm > 40 ? 60000 / this.localBpm : Analyser.BE_FALLBACK_MS)) {
      label = prev === 'break' ? 'break' : 'build'; this.sectionTier = 1;
    }
    // UPPEHALLSTID (09-20, forsta forsta hela laten: build/intro/low bytte var 1-3 s): ett byte kravs ha statt >= 4 s i nuvarande
    // sektion, utom in i 'high' (drop/topp ska synas direkt) och ur 'high' till 'break' (svackan ar en flank).
    // uppehallstid 8 s (var 4: build/low/high bytte var 4 s pa pop 14:30), utom in i 'high' (4 s) och high -> break (direkt)
    const dwellMs = label === 'high' ? 4000 : 8000;
    const dwellOk = nowMs - this.sectionStartMs >= dwellMs || (prev === 'high' && label === 'break') || (Analyser.BODY_HIGH_MS > 0 && dropped && label === 'high') || edgeUp || edgeDown;
    if (label !== prev && dwellOk) {
      // MINNE: avslutad sektion till loggen (medel-dB, kickar/s); refrangens dB blir referensen for levelVsHighDb.
      const dbMean = this.secCurDbN ? this.secCurDbSum / this.secCurDbN : blkDb;
      this.secLog.push({ label: prev, startMs: this.sectionStartMs, endMs: nowMs, db: dbMean, dens: this.secCurDbN ? this.secCurDens / this.secCurDbN : 0 });
      if (this.secLog.length > 48) this.secLog.shift();
      if (prev === 'high') { this.lastHighDb = dbMean; this.secHiEndMs = nowMs; }
      this.prevSection = prev; this.secCurDbSum = 0; this.secCurDbN = 0; this.secCurDens = 0;
      this.sectionStartMs = nowMs; if (label === 'high') { this.sectionIndex++; this.secHiStartMs = nowMs; } this.section = label;
    }
    this.secCurDbSum += blkDb; this.secCurDbN++; this.secCurDens += bKicks;
    if (this.secDump) { const row = [(nowMs - this.secSongStartMs) / 1000, blkDb, bKicks, bCent, bInt, breaking ? 1 : 0, dropped ? 1 : 0]; for (let i = 0; i < 8; i++) row.push(this.secBlkSpec[i] / n); row.push(st, ['intro', 'low', 'build', 'high', 'break'].indexOf(this.section)); this.secDump.push(row); }
    if (this.section === 'high') { this.lastHighDb = this.secCurDbSum / this.secCurDbN; }   // pagaende refrang = farskaste referensen
    this.levelVsHighDb = Number.isFinite(this.lastHighDb) ? blkDb - this.lastHighDb : 0;
    this.predictHigh(nowMs, bInt);
    if (this.dbgSecBlock) this.dbgSecBlock({ nowMs, section: this.section, sectionStartMs: this.sectionStartMs, prev, label, bpm: this.localBpm, bInt, bKicks, bCent, blkDb, buildUp: this.buildUp, riseRun: this.secRiseRun, rise, dropped, breaking, tier: this.sectionTier, repeatSim: this.repeatSim, repeatAgoMs: this.repeatAgoMs, repeatSection: this.repeatSection, spec: Array.from(this.secBlkSpec, (v) => v / n), lastHighDb: this.lastHighDb, expectHighMs: this.expectHighMs, expectSource: this.expectSource, beatPhaseMs: this.beatPhaseMs, secLogN: this.secLog.length, secLogLast: this.secLog[this.secLog.length - 1] ?? null, bBon, bBpk, bFlux, bDyn, bHigh, bFlat, pct: this.secPct });
    if (Analyser.REPEAT & 1) { this.repeatStep(nowMs, blkDb, bKicks, bCent, bInt); this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0); this.secBlkRms2 = 0; this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0; return; }
    // klangavtryck var 4:e sekund
    let sum = 0; for (let i = 0; i < 8; i++) sum += this.secBlkSpec[i];
    const acc = this.secFpAcc; for (let i = 0; i < 8; i++) acc[i] += sum > 0 ? this.secBlkSpec[i] / sum : 0;
    acc[8] += bCent; acc[9] += Math.min(1, bKicks / 4); acc[10] += bInt; this.secFpAccN++;
    if (this.secFpAccN >= 4) {
      const D = Analyser.FP_DIM; let nrm = 0; for (let i = 0; i < D; i++) { acc[i] /= this.secFpAccN; nrm += acc[i] * acc[i]; }
      nrm = Math.sqrt(nrm) || 1; for (let i = 0; i < D; i++) acc[i] /= nrm;
      let best = 0, bestAt = 0, bestLab = '';
      for (let k = 0; k < this.secFpN; k++) {
        if (nowMs - this.secFpT[k] < 16000) continue;
        let dot = 0; const o = k * D; for (let i = 0; i < D; i++) dot += acc[i] * this.secFp[o + i];
        if (dot > best) { best = dot; bestAt = this.secFpT[k]; bestLab = this.secFpLab[k]; }
      }
      this.repeatSim = best; this.repeatAgoMs = best > 0 ? nowMs - bestAt : 0; this.repeatSection = bestLab;
      const o = this.secFpPos * D; for (let i = 0; i < D; i++) this.secFp[o + i] = acc[i];
      this.secFpT[this.secFpPos] = nowMs; this.secFpLab[this.secFpPos] = this.section;
      this.secFpPos = (this.secFpPos + 1) % Analyser.FP_MAX; if (this.secFpN < Analyser.FP_MAX) this.secFpN++;
      acc.fill(0); this.secFpAccN = 0;
    }
    this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0); this.secBlkRms2 = 0; this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0;
  }

  /** RANGBERÄKNINGEN (2026-10-17, skräpjakten): utbruten ur sectionBlock. sectionBlock körs 1 gång/s och deoptas; V8 optimerar om
   *  först efter tusentals anrop, så looparna här över hela låtens block (~600) gick otolkade och boxade varje flyttal (~21 kB per
   *  block). Som egen metod med tunga loopar optimeras den på loopbudgeten. Samma räkning i samma ordning; returnerar tiern. */
  private rankTier(nb: number): number {
    const D = this.secBlkDb, K = this.secBlkDens, C = this.secBlkCentH, wk = Analyser.RANK_W_DENS, wc = Analyser.RANK_W_CENT;
    let md = 0, mk = 0, mc = 0; for (let i = 0; i < nb; i++) { md += D[i]; mk += K[i]; mc += C[i]; } md /= nb; mk /= nb; mc /= nb;
    let sd = 0, sk = 0, sc = 0; for (let i = 0; i < nb; i++) { sd += (D[i] - md) ** 2; sk += (K[i] - mk) ** 2; sc += (C[i] - mc) ** 2; }
    sd = Math.max(1.0, Math.sqrt(sd / nb)); sk = Math.max(0.3, Math.sqrt(sk / nb)); sc = Math.max(0.02, Math.sqrt(sc / nb));
    this.secRank.md = md; this.secRank.sd = sd; this.secRank.mk = mk; this.secRank.sk = sk;
    // Nya sardrag (RANK_W_*): z mot latens historik med sd-golv (skala per sardrag), viktade in i samma poang i fast
    // ordning. Poangen summeras i 64 bitar och lagras en gang (SECTION_SCORE_F32 avrundar da en gang, som aldre vagen).
    const terms = this.secTerms; let nt = 0;
    {
      const H = this.secBlkH;
      nt = this.rankTerm(nt, H.bpk, Analyser.RANK_W_BASSON, 0.5, nb); nt = this.rankTerm(nt, H.bon, Analyser.RANK_W_BASSENV, 0.02, nb); nt = this.rankTerm(nt, this.secBlkHighH, Analyser.RANK_W_HIGH, 1.0, nb);
      nt = this.rankTerm(nt, H.flat, Analyser.RANK_W_FLAT, 0.02, nb); nt = this.rankTerm(nt, H.flux, Analyser.RANK_W_FLUX, 0.01, nb); nt = this.rankTerm(nt, H.dyn, Analyser.RANK_W_DYN, 0.05, nb);
    }
    const S = this.secScoreBuf;
    for (let i = 0; i < nb; i++) {
      let v = (D[i] - md) / sd + wk * (K[i] - mk) / sk + wc * (C[i] - mc) / sc;
      for (let t = 0; t < nt; t++) { const T = terms[t]; v += T.w * (T.X[i] - T.m) / T.s; }
      S[i] = v;
    }
    let win = 0; const W = Math.min(Analyser.RANK_WIN, nb); for (let i = nb - W; i < nb; i++) win += S[i]; win /= W;
    let below = 0, cnt = 0;
    { let acc = 0; for (let e = 1; e <= nb; e++) { acc += S[e - 1]; if (e > W) acc -= S[e - 1 - W]; if (e >= W) { cnt++; if (acc / W < win) below++; } } }
    const pct = below / cnt; const cur = this.sectionTier, h = Analyser.RANK_HYST; this.secPct = pct;
    return pct >= Analyser.RANK_HI - (cur === 2 ? h : 0) ? 2 : pct <= Analyser.RANK_LO + (cur === 0 ? h : 0) ? 0 : 1;
  }

  /** En RANK_W_*-term (2026-10-17: fasta objekt i secTerms i st f en ny array + objekt + closure per block). Samma räkning som förr. */
  private rankTerm(nt: number, X: number[], w: number, floor: number, nb: number): number {
    if (w === 0) return nt;
    let m = 0; for (let i = 0; i < nb; i++) m += X[i]; m /= nb; let s = 0; for (let i = 0; i < nb; i++) s += (X[i] - m) ** 2; s = Math.max(floor, Math.sqrt(s / nb));
    const T = this.secTerms[nt]; T.X = X; T.w = w; T.m = m; T.s = s; return nt + 1;
  }
  private secTerms = [0, 1, 2, 3, 4, 5].map(() => ({ X: [] as number[], w: 0.5, m: 0.5, s: 0.5 }));

  /** UPPREPNINGSMINNE v2 (se REPEAT). Kors per sektionsblock; avtryck var REPEAT_STEP:e block. Bara sectionHops blocksummor + egna falt. */
  private repeatStep(nowMs: number, blkDb: number, bKicks: number, bCent: number, bInt: number): void {
    const D = Analyser.FP2_DIM, MAX = Analyser.FP2_MAX, acc = this.secFp2Acc;
    let sum = 0; for (let i = 0; i < 8; i++) sum += this.secBlkSpec[i];
    for (let i = 0; i < 8; i++) acc[i] += sum > 0 ? this.secBlkSpec[i] / sum : 0;
    acc[8] += bCent; acc[9] += Math.min(1, bKicks / 4); acc[10] += bInt; acc[11] += blkDb / 10; this.secFp2AccDb += blkDb; this.secFp2AccDens += bKicks; this.secFp2AccN++;
    if (this.secFp2AccN < Analyser.REPEAT_STEP) return;
    const pos = this.secFp2Pos, o = pos * D; for (let i = 0; i < D; i++) this.secFp2[o + i] = acc[i] / this.secFp2AccN;
    this.secFp2T[pos] = nowMs; this.secFp2Db[pos] = this.secFp2AccDb / this.secFp2AccN; this.secFp2Dens[pos] = this.secFp2AccDens / this.secFp2AccN; this.secFp2Lab[pos] = this.section;
    this.secFp2Pos = (pos + 1) % MAX; if (this.secFp2N < MAX) this.secFp2N++;
    acc.fill(0); this.secFp2AccN = 0; this.secFp2AccDb = 0; this.secFp2AccDens = 0;
    const N = this.secFp2N; const idx = (m: number) => (pos - m + MAX) % MAX;   // m = alder i rutor (0 = nyaste)
    // z-normering mot latens egen historik: medel/std per dimension over alla lagrade avtryck, sedan enhetslangd
    const mu = this.secFp2Mu, sd = this.secFp2Sd; mu.fill(0); sd.fill(0);
    for (let m = 0; m < N; m++) { const q = idx(m) * D; for (let i = 0; i < D; i++) mu[i] += this.secFp2[q + i]; }
    for (let i = 0; i < D; i++) mu[i] /= N;
    for (let m = 0; m < N; m++) { const q = idx(m) * D; for (let i = 0; i < D; i++) sd[i] += (this.secFp2[q + i] - mu[i]) ** 2; }
    for (let i = 0; i < D; i++) sd[i] = Math.max(1e-3, Math.sqrt(sd[i] / N));
    const z = this.secFp2Z;
    for (let m = 0; m < N; m++) { const q = idx(m) * D; let nrm = 0; for (let i = 0; i < D; i++) { const v = (this.secFp2[q + i] - mu[i]) / sd[i]; z[q + i] = v; nrm += v * v; } nrm = Math.sqrt(nrm) || 1; for (let i = 0; i < D; i++) z[q + i] /= nrm; }
    // sekvensmatch: de W senaste rutorna mot W rutor som slutar >= 16 s tillbaka
    const W = Math.min(Analyser.REPEAT_W, N); let best = 0, bestM = -1;
    for (let m = W; m + W - 1 < N; m++) {
      if (nowMs - this.secFp2T[idx(m)] < 16000) continue;
      let s = 0; for (let j = 0; j < W; j++) { const a = idx(j) * D, b = idx(m + j) * D; for (let i = 0; i < D; i++) s += z[a + i] * z[b + i]; }
      s /= W; if (s > best) { best = s; bestM = m; }
    }
    const prevAt = this.repeatHighAtMs;
    this.repeatSim = best; this.repeatTier = -1; this.repeatHighAtMs = 0; this.repeatHighEndAtMs = 0;
    // omrankning med dagens kunskap: blockpoang sorterade -> percentil for det matchade partiet (medel over W rutor) och for blocken efter det
    const nb = this.secBlkDb.length; if (nb < 20) { this.repeatAgoMs = 0; this.repeatSection = ''; return; }
    const R = this.secRank; const score = (db: number, dens: number) => (db - R.md) / R.sd + (dens - R.mk) / R.sk;
    const ss = this.secScoreSorted; for (let i = 0; i < nb; i++) ss[i] = score(this.secBlkDb[i], this.secBlkDens[i]); ss.subarray(0, nb).sort();
    const pct = (v: number) => { let lo = 0, hi = nb; while (lo < hi) { const mid = (lo + hi) >> 1; if (ss[mid] < v) lo = mid + 1; else hi = mid; } return lo / nb; };
    // MINNE OM LANGD (bit 16): langsta high-korningen (omrankad, luckor <= 2 block) fore nuvarande sektion -> sa lange varar high
    if (Analyser.REPEAT & 16) {
      let run = 0, gap = 0, bestRun = 0;
      for (let i = 0; i < nb; i++) {
        if (this.secBlkT[i] >= this.sectionStartMs) break;
        if (pct(score(this.secBlkDb[i], this.secBlkDens[i])) >= Analyser.RANK_HI) { run += 1 + gap; gap = 0; if (run > bestRun) bestRun = run; }
        else if (run > 0 && ++gap > 2) { run = 0; gap = 0; }
      }
      this.secHighRunMs = bestRun * 1000;
    }
    if (bestM < 0) { this.repeatAgoMs = 0; this.repeatSection = ''; return; }
    const kEnd = idx(bestM); const lagMs = nowMs - this.secFp2T[kEnd];
    this.repeatAgoMs = lagMs; this.repeatSection = this.secFp2Lab[kEnd];
    let ps = 0; for (let j = 0; j < W; j++) { const k = idx(bestM + j); ps += score(this.secFp2Db[k], this.secFp2Dens[k]); } ps /= W;
    const p = pct(ps); this.repeatTier = p >= Analyser.RANK_HI ? 2 : p <= Analyser.RANK_LO ? 0 : 1;
    // det forflutnas framtid: forsta blocket efter det matchade partiet som (2 i rad) rankas high -> vantas igen efter lag
    const tEnd = this.secFp2T[kEnd]; let run = 0, at = 0, endAt = 0, lowRun = 0;
    for (let i = 0; i < nb; i++) {
      if (this.secBlkT[i] <= tEnd) continue;
      const hi = pct(score(this.secBlkDb[i], this.secBlkDens[i])) >= Analyser.RANK_HI;
      if (at === 0) { if (hi) { if (++run >= 2) at = this.secBlkT[i - 1] + lagMs; } else run = 0; }
      else if (!hi) { if (++lowRun >= 3) { endAt = this.secBlkT[i - 2] + lagMs; break; } } else lowRun = 0;   // slutet: 3 block i rad under high
    }
    this.repeatHighEndAtMs = at > 0 ? endAt : 0;
    // STABILT MAL: matchningens lag driver nagra sekunder mellan stegen (techno: allt liknar allt) och malet gled med (tim: 12 falska/min).
    // Ett aktivt mal behalls om det nya ligger inom +-4 s; ett mal publiceras forst nar det statt tva steg i rad (repeatHighRun).
    if (at > 0 && prevAt > nowMs && Math.abs(at - prevAt) <= 4000) { at = prevAt; this.repeatHighRun++; }
    else this.repeatHighRun = at > 0 ? 1 : 0;
    this.repeatHighAtMs = at;
  }

  /** FORUTSAGELSE av nasta 'high' (se Frame.expectHighInMs). Kors per sektionsblock (1 s) i workern. Kallor: 1 minne, 2 fras
   *  (stigande energi -> nasta gitterpunkt), 3 sug (dyk i dB strax fore smallen). Frasgittret ligger i takter fran senaste
   *  high-starten (PREDICT_GRID 'hi') sa att en forutsagelse pekar pa samma tid oavsett i vilket block regeln tander. */
  private predictHigh(nowMs: number, bInt: number): void {
    const bpm = this.localBpm; const barMs = bpm > 0 ? 240000 / bpm : 0;
    let exp = 0, src = 0;
    // (4) UPPREPNING (REPEAT bit 4): det forflutna spelas upp igen med lag L -> forra gangens high-start + L
    if ((Analyser.REPEAT & 4) && this.section !== 'high' && this.repeatSim >= Analyser.REPEAT_THR && this.repeatHighRun >= 2 && this.repeatHighAtMs > nowMs + 500 && this.repeatHighAtMs - nowMs <= 32000) { exp = this.repeatHighAtMs; src = 4; }
    if (!exp && this.section !== 'high' && barMs > 0) {
      // (1) MINNE: senaste tidigare sektion med samma etikett som foljdes av 'high' -> samma antal takter (avrundat till 4, minst 4)
      if (Analyser.PREDICT_SRC & 1) for (let i = this.secLog.length - 2; i >= 0; i--) {
        const a = this.secLog[i], b = this.secLog[i + 1];
        if (a.label !== this.section || b.label !== 'high') continue;
        const bars = Math.max(4, Math.round((a.endMs - a.startMs) / barMs / 4) * 4);
        const cand = this.sectionStartMs + bars * barMs;
        if (cand > nowMs + 500) { exp = cand; src = 1; }
        break;
      }
      // (2) FRAS: energin stiger -> nasta gitterpunkt (PREDICT_LAT takter) fran ankaret (minst en takt bort, hogst 16 takter)
      const rising = this.secRiseRun >= Analyser.PREDICT_RISE;
      if (!exp && (Analyser.PREDICT_SRC & 2) && rising) {
        const anchor = this.secHiStartMs > 0 ? this.secHiStartMs : this.sectionStartMs;
        const L = Analyser.PREDICT_LAT * barMs;
        const elapsed = nowMs - anchor; const k = Math.ceil((elapsed + barMs) / L);
        const cand = anchor + k * L;
        if (cand - nowMs <= 16 * barMs) { exp = cand; src = 2; }
      }
    }
    if (exp === 0 && this.expectHighMs > 0 && this.section !== 'high' && this.expectHighMs > nowMs - 2000) { exp = this.expectHighMs; src = this.expectSource; }   // hall forutsagelsen tills 2 s efter
    this.expectHighMs = exp; this.expectSource = src;
  }

  /** Env-steget (100 Hz): tempo pa stride + gridfas. Kors i 'all' direkt och i 'slow' per record. */
  private envStep(): void {
    // EN KLOCKA: ingen egen temposökning och ingen egen gridfas - tempo och fas kommer från klockan (analyserClock.ts) i båda profilerna.
    if (this.holdSilent) return;
  }

  /** TYDLIG BASGANG (env-rastret, 100 Hz): se blAccum. */
  private stepBassline(): void {
    const v = this.blAccum; this.blAccum = 0;
    const seq = ++this.envSeq;
    const p1 = this.blPrev1;
    if (v < this.blTrough) this.blTrough = v;
    if (p1 >= this.blPrev2 && p1 > v && p1 > 0.05 && p1 - this.blTrough >= 0.25 * this.blRef && seq - 1 - this.blLastOnset >= 6) {
      if (seq - 1 - this.blKickSeq >= 6) { this.blOnsets[this.blOnsetPos] = seq - 1; this.blOnsetPos = (this.blOnsetPos + 1) & 31; }
      this.blLastOnset = seq - 1;
      this.blRef += (p1 - this.blRef) * 0.1;
      this.blTrough = p1;
    } else if (this.blRef > 0.05) this.blRef *= 0.999;
    this.blPrev2 = p1; this.blPrev1 = v;
    let n = 0; for (let i = 0; i < 32; i++) if (seq - this.blOnsets[i] <= 200 && this.blOnsets[i] > 0) n++;
    const beats2s = (this.dBpm > 0 ? this.dBpm : 120) / 30;
    const opb = n / beats2s;
    this.bassOnsetsPerBeat = opb;
    const raw = Math.max(0, Math.min(1, (opb - 0.4) / 0.8));
    this.profBassline += (raw - this.profBassline) * 0.01;
  }

  /** Roll 'all': sektionsblocket ur samma aggregat som workern far (se secAgg). */
  private sectionFlushAgg(): void {
    const g = this.secAgg; if (g.n === 0) return;
    { const I = this.shIn; I.hops = g.n; I.intSum = g.int; I.kicks = g.kicks; I.breaking = g.breaking > 0; I.nowMs = g.wall; I.dtMs = g.dt; I.rms2Sum = g.rms2; I.centSum = g.cent;
      I.specOff = 0; I.bonSum = g.bon; I.bpk = g.bpk; I.fluxSum = g.flux; I.rms4Sum = g.rms4; }
    this.sectionHop(g.spec);
    g.n = 0; g.int = 0; g.kicks = 0; g.breaking = 0; g.rms2 = 0; g.cent = 0; g.dt = 0; g.spec.fill(0); g.bon = 0; g.bpk = 0; g.flux = 0; g.rms4 = 0;
  }

  // ── DELAD ANALYSATOR: snabba sidan ────────────────────────────────────────────────────────────
  private flagSlow(f: number): void {
    if (this.role !== 'fast') return;
    this.pendFlags |= f; this.barrierSeq = this.recSeq + 1;
    for (let k = 0; k < FLAG_BITS; k++) if (f & (1 << k)) this.flagCnt[k]++;
  }
  /** Ett record per env-sampel (100 Hz) till workern: ringvardena, flaggorna sedan forra recordet, sektionens blocksummor. */
  private pushSlowRecord(e: number, b: number, h: number): void {
    const r = this.splitRing!, ctrl = this.splitCtrl!;
    const seq = ++this.recSeq; const o = (seq % RING_N) * REC_LEN; const g = this.secAgg;
    r[o + R_PERF] = this.perfNow(); r[o + R_WALL] = this.wallNow(); r[o + R_TS] = Date.now();
    r[o + R_ENV] = e; r[o + R_BASS] = b; r[o + R_HIGH] = h; r[o + R_FLAGS] = this.pendFlags; r[o + R_HINT_MS] = this.pendHintMs; r[o + R_VCLOCK] = this.pendVclock;
    r[o + R_SEC_N] = g.n; r[o + R_SEC_INT] = g.int; r[o + R_SEC_KICKS] = g.kicks; r[o + R_SEC_BREAK] = g.breaking; r[o + R_SEC_RMS2] = g.rms2;
    r[o + R_SEC_CENT] = g.cent; r[o + R_SEC_DT] = g.dt; r[o + R_SEC_WALL] = g.wall;
    for (let i = 0; i < 8; i++) r[o + R_SEC_SPEC0 + i] = g.spec[i];
    r[o + R_SEC_BON] = g.bon; r[o + R_SEC_BPK] = g.bpk; r[o + R_SEC_FLUX] = g.flux; r[o + R_SEC_RMS4] = g.rms4;
    // SECTION_AGG 'hop': fakta fran sista aggregerade hoppet (som sectionHop sag dem i odelat lage); 'env': vid skrivningen.
    if (SECTION_AGG_HOP) { r[o + R_DROPS] = g.drops; r[o + R_ACTIVE] = g.active; r[o + R_BUILD] = g.build; }
    else { r[o + R_DROPS] = this.dropCand + this.secBodyRet; r[o + R_ACTIVE] = this.activeMs; r[o + R_BUILD] = this.buildUp; }
    r[o + R_FLAGCNT] = packFlagCounts(this.flagCnt);
    r[o + R_CLOCK] = this.localBpm; r[o + R_CLOCK_CONF] = this.localBpmConfidence;   // EN KÄLLA (r0): klockans tempo/tillit till långsamma sidan
    r[o + R_BIGSEQ] = this.bigSeq;                         // stora vägen: hop-record före detta (workern kör dem först)
    r[o + R_SEQ] = seq;                                    // sist: seq = recordet ar komplett
    g.n = 0; g.int = 0; g.kicks = 0; g.breaking = 0; g.rms2 = 0; g.cent = 0; g.dt = 0; g.spec.fill(0); g.bon = 0; g.bpk = 0; g.flux = 0; g.rms4 = 0;
    this.pendFlags = 0;
    Atomics.store(ctrl, C_WRITE, seqLow(seq));             // laga 32 bitarna; workern rekonstruerar via seqDelta (wrap-sakert)
    if (this.bigOn) {   // stora vägen: analysatortråden väntar på C_WAKE (C_WAITING_B); med taktväg väcker feed() i samma hop
      Atomics.add(ctrl, C_WAKE, 1);
      if ((this.syncWorker || !this.hopLane) && (Atomics.load(ctrl, C_WAITING) || Atomics.load(ctrl, C_WAITING_B))) Atomics.notify(ctrl, C_WAKE);
    } else if (!this.hopLane) { if (Atomics.load(ctrl, C_WAITING)) Atomics.notify(ctrl, C_WRITE, 1); }   // Dekker: workern satter C_WAITING fore wait-jamforelsen
    // a7: MED taktvägen väntar workern bara på C_WAKE - en notify på C_WRITE vore ett anrop i onödan.
    else { Atomics.add(ctrl, C_WAKE, 1); if (Atomics.load(ctrl, C_WAITING)) Atomics.notify(ctrl, C_WAKE, 1); }   // taktvägen: workern väntar på C_WAKE
    if (this.inlinePeer) { this.inlinePeer.drainRecords(); this.pullSlowState(); }   // inline-lage (korbank): synkront har, tillstandet hamtas direkt
    else if (this.syncWorker) { syncWait(ctrl, C_STATE_SEQ, () => this.stateRd.read(ctrl, this.splitState!, this.stateCopy) && this.stateCopy[S_REC_SEQ] >= seq); this.pullSlowState(); }
  }
  /** Hamta tempo/gridfas/sektion ur tillstandsblocket (varje hop, ~20 doubles). Aldre an barrierSeq ignoreras. */
  private pullSlowState(): void {
    if (!this.stateRd.read(this.splitCtrl!, this.splitState!, this.stateCopy)) return;
    const s = this.stateCopy; if (s[S_REC_SEQ] < this.barrierSeq) return;
    // (EN KÄLLA, r0: med klockan sätts localBpm/localBpmConfidence via setClock - inte av långsamma sidans tillstånd; lotus väg: som förr)
    this.beatPhaseMs = s[S_PHASE_MS]; this.beatPhaseConf = s[S_PHASE_CONF];
    this.section = SECTIONS[s[S_SECTION]] || 'intro'; this.sectionStartMs = s[S_SEC_START]; this.sectionIndex = s[S_SEC_INDEX]; this.sectionTier = s[S_SEC_TIER];
    this.repeatSim = s[S_REP_SIM]; this.repeatAgoMs = s[S_REP_AGO]; this.repeatSection = SECTIONS[s[S_REP_SEC]] || '';
    this.expectHighMs = s[S_EXPECT_MS]; this.expectSource = s[S_EXPECT_SRC]; this.prevSection = SECTIONS[s[S_PREV_SEC]] || ''; this.levelVsHighDb = s[S_LVL_HIGH];
  }
  setInlinePeer(slow: Analyser | null): void { this.inlinePeer = slow; }
  /** Halsa for /api/live: hur langt efter workern ligger (records och ms), dess kostnad per record, tappade records. */
  getSplitStats(): { role: string; written: number; processed: number; behind: number; lagMs: number; lagMaxMs: number; busyUs: number; busyMaxUs: number; skipped: number; lostFlags: number; restarts: number } | null {
    if (this.role !== 'fast') return null;
    const s = this.stateCopy;
    return { role: this.role, written: this.recSeq, processed: s[S_PROCESSED], behind: this.recSeq - s[S_REC_SEQ], lagMs: +s[S_LAG_MS].toFixed(1), lagMaxMs: +s[S_LAG_MAX].toFixed(1),
      busyUs: Math.round(s[S_BUSY_US]), busyMaxUs: Math.round(s[S_BUSY_MAX_US]), skipped: s[S_SKIPPED], lostFlags: s[S_LOST_FLAGS], restarts: this.splitRestarts };
  }
  /** fast: senast skrivna record (full seq) resp. senast LASTA enligt workern (C_READ, wrap-sakert) — for omstart av workern. */
  fastWriteSeq(): number { return this.recSeq; }
  fastReadSeq(): number { const d = seqDelta(Atomics.load(this.splitCtrl!, C_READ), this.recSeq); return d > 0 ? this.recSeq : this.recSeq + d; }

  // ── DELAD ANALYSATOR: langsamma sidan (workern / inline) ─────────────────────────────────────
  slowReadSeq(): number { return this.recSeq; }
  /** Behandla alla records som skrivits sedan sist, publicera tillstandet. Returnerar antal. */
  drainRecords(): number {
    const ctrl = this.splitCtrl!, r = this.splitRing!;
    const w = this.recSeq + seqDelta(Atomics.load(ctrl, C_WRITE), this.recSeq); let n = 0;   // full seq ur 32 laga bitar (wrap-sakert)
    if (w - this.recSeq > RING_N - RING_MARGIN) { this.slowSkipped += (w - this.recSeq) - (RING_N - RING_MARGIN); this.recSeq = w - (RING_N - RING_MARGIN); this.slowGap = true; }   // ringen hann skrivas over
    let lagMs = 0;
    while (this.recSeq < w) {
      const seq = ++this.recSeq; const o = (seq % RING_N) * REC_LEN;
      if (r[o + R_SEQ] !== seq) { this.slowSkipped++; this.slowGap = true; continue; }
      const t0 = performance.now();
      if (this.slowGap) {
        // Records tappade sedan senast behandlade: flaggor som lag i dem far inte forsvinna utan konsekvens (split.ts).
        // Vardena (hint-fonster, virtuell klocka) ar borta -> standard 5000 ms resp. recordets egen tid.
        if (this.slowLastCnt >= 0) {
          const lost = lostFlags(this.slowLastCnt, r[o + R_FLAGCNT], r[o + R_FLAGS]);
          if (lost) { this.slowLostFlags++; this.applyFlags(lost, 5000, r[o + R_PERF]); }
        }
        this.slowGap = false;
      }
      if (this.bigOn) this.drainBig(r[o + R_BIGSEQ]);   // stora vägen: hoppen före recordet först (sektionsaggregatet, drop-räknaren)
      this.slowStep(o); this.slowLastCnt = r[o + R_FLAGCNT];
      if (this.bigYield) this.bigYield();
      const us = (performance.now() - t0) * 1000;
      this.slowBusyEmaUs = this.slowBusyEmaUs === 0 ? us : this.slowBusyEmaUs + 0.02 * (us - this.slowBusyEmaUs);
      if (us > this.slowBusyMaxUs) this.slowBusyMaxUs = us;
      lagMs = Date.now() - r[o + R_TS]; if (lagMs > this.slowLagMaxMs) this.slowLagMaxMs = lagMs;
      n++;
    }
    if (n > 0) {
      this.slowProcessed += n;
      Atomics.store(ctrl, C_READ, seqLow(this.recSeq));
      stateWrite(ctrl, this.splitState!, (s) => {
        s[S_REC_SEQ] = this.recSeq; s[S_BPM] = this.localBpm; s[S_CONF] = this.localBpmConfidence; s[S_BPMF] = this.localBpmF;
        s[S_PHASE_MS] = this.beatPhaseMs; s[S_PHASE_CONF] = this.beatPhaseConf;
        s[S_SECTION] = sectionCode(this.section); s[S_SEC_START] = this.sectionStartMs; s[S_SEC_INDEX] = this.sectionIndex; s[S_SEC_TIER] = this.sectionTier;
        s[S_REP_SIM] = this.repeatSim; s[S_REP_AGO] = this.repeatAgoMs; s[S_REP_SEC] = sectionCode(this.repeatSection);
        s[S_EXPECT_MS] = this.expectHighMs; s[S_EXPECT_SRC] = this.expectSource; s[S_PREV_SEC] = sectionCode(this.prevSection); s[S_LVL_HIGH] = this.levelVsHighDb;
        s[S_PROCESSED] = this.slowProcessed; s[S_LAG_MS] = lagMs; s[S_LAG_MAX] = this.slowLagMaxMs; s[S_BUSY_US] = this.slowBusyEmaUs; s[S_BUSY_MAX_US] = this.slowBusyMaxUs; s[S_SKIPPED] = this.slowSkipped; s[S_LOST_FLAGS] = this.slowLostFlags;
      });
      if (this.syncWorker) Atomics.notify(ctrl, C_STATE_SEQ);
    }
    if (this.bigOn) this.drainBig(Infinity);
    return n;
  }

  // ── STORA VÄGEN (split.ts) ────────────────────────────────────────────────────────────────────
  /** fast: hoppets record (sampel + snabba sidans fakta) till långsamma tråden; hämta drop/riser/profil/kropp/spektrum tillbaka. */
  private pushBig(samples: Float32Array): void {
    const r = this.bigRing!, ctrl = this.splitCtrl!, seq = ++this.bigSeq, slot = seq % BIG_RING_N, o = slot * BIG_REC_LEN, n = samples.length;
    this.bigPcm!.set(samples, slot * BIG_HOP_MAX);
    r[o + B_N] = n; r[o + B_RMS] = this.hRms; r[o + B_LVL] = this.lvlSmooth; r[o + B_CENT] = this.centSmooth; r[o + B_ACTIVE] = this.activeMs;
    r[o + B_WALL] = this.hNowWall; r[o + B_KICK] = this.hKick ? 1 : 0; r[o + B_KICKHIT] = this.kickHit; r[o + B_INT] = this.hIntensity; r[o + B_BREAK] = this.hBreaking ? 1 : 0;
    r[o + B_SEC] = sectionCode(this.section); r[o + B_LVH] = this.levelVsHighDb; r[o + B_CONF] = this.localBpmConfidence;
    r[o + B_ENVF] = this.bigEnvFlag; r[o + B_ENVBPM] = this.bigEnvBpm; this.bigEnvFlag = 0;
    r[o + B_SEQ] = seq;                                    // sist: recordet ar komplett
    Atomics.store(ctrl, C_BIG_WRITE, seqLow(seq)); Atomics.add(ctrl, C_WAKE, 1);
    // Väckning: taktvägens feed() följer i samma hop och väcker workern - här bara i synk-läget eller utan taktväg.
    if ((this.syncWorker || !this.hopLane) && (Atomics.load(ctrl, C_WAITING) || Atomics.load(ctrl, C_WAITING_B))) Atomics.notify(ctrl, C_WAKE);
    if (this.inlinePeer) this.inlinePeer.drainBig(Infinity);
    else if (this.syncWorker) syncWait(ctrl, C_BIG_SEQ, () => this.bigRd.read(ctrl, this.bigState!, this.bigCopy, C_BIG_SEQ) && this.bigCopy[BS_SEQ] >= seq);
    const s = this.bigCopy;
    if (!this.bigRd.read(ctrl, this.bigState!, s, C_BIG_SEQ) || s[BS_SEQ] === 0) return;
    this.hBody = s[BS_BODY]; this.dropCount = s[BS_DROPS]; this.miniDropCount = s[BS_MINI];
    this.dropDemoted = s[BS_DEMOTED]; this.dropSpaced = s[BS_SPACED]; this.dropRiseDb = s[BS_DROPRISE]; this.nearDropDb = s[BS_NEAR]; this.nearDipDb = s[BS_NEARDIP]; this.liftDb = s[BS_LIFT]; this.stopCount = s[BS_STOPS]; this.stopS = s[BS_STOPSEC]; this.buildUp = s[BS_BUILD]; this.hInRiser = s[BS_RISER] === 1;
    const p = this.outProfile; p.punch = s[BS_PUNCH]; p.bass = s[BS_BASS]; p.bright = s[BS_BRIGHT]; p.beat = s[BS_BEAT]; p.bassline = s[BS_BASSLINE];
    const sn = s[BS_SPEC_N];
    if (sn > this.specDelivered) {
      const sink = this.specSink, binHz = this.cfg.audio.rate / this.bufferBig.length, R = this.specRing!, c = this.specCopy;
      for (let k = Math.max(this.specDelivered + 1, sn - SPEC_SLOTS + 1); k <= sn; k++) {
        if (sink) { const o2 = (k % SPEC_SLOTS) * SPEC_MAX; c.set(R.subarray(o2, o2 + c.length)); sink(c, binHz); }
      }
      this.specDelivered = sn;
    }
  }

  /** slow: behandla hop-recorden t.o.m. `limit` (full seq) i exakt snabba sidans gamla ordning, publicera. */
  drainBig(limit: number): number {
    const ctrl = this.splitCtrl!, r = this.bigRing!, pcm = this.bigPcm!;
    let w = this.bigSeq + seqDelta(Atomics.load(ctrl, C_BIG_WRITE), this.bigSeq); if (limit < w) w = limit;
    if (w - this.bigSeq > BIG_RING_N - RING_MARGIN) { this.bigSkipped += (w - this.bigSeq) - (BIG_RING_N - RING_MARGIN); this.bigSeq = w - (BIG_RING_N - RING_MARGIN); }
    let n = 0;
    while (this.bigSeq < w) {
      const seq = ++this.bigSeq, slot = seq % BIG_RING_N, o = slot * BIG_REC_LEN;
      if (r[o + B_SEQ] !== seq) { this.bigSkipped++; continue; }
      const hn = r[o + B_N];
      // basgången (process(): ackumulatorn med förra 2048-bandens nivå och förra hoppets kick, sedan env-sampelns steg)
      { const bl = this.bandLvl[1] + this.bandLvl[2]; if (bl > this.blAccum) this.blAccum = bl; if (this.kickHit >= 1) this.blKickSeq = this.envSeq; }
      if (r[o + B_ENVF] === 1) { this.dBpm = r[o + B_ENVBPM]; this.stepBassline(); }
      this.hRms = r[o + B_RMS]; this.lvlSmooth = r[o + B_LVL]; this.centSmooth = r[o + B_CENT]; this.activeMs = r[o + B_ACTIVE]; this.kickHit = r[o + B_KICKHIT];
      const wall = r[o + B_WALL];
      { const po = slot * BIG_HOP_MAX; this.bigRingPush(pcm.subarray(po, po + hn)); }
      if (++this.bigCounter >= Analyser.BIG_EVERY) this.bigStep();
      this.hNowWall = wall; this.hBody = (this.bandDbRaw[0] + this.bandDbRaw[1] + this.bandDbRaw[2]) / 3;
      this.dSec = SECTIONS[r[o + B_SEC]]; this.dLvh = r[o + B_LVH];
      this.dropStep();
      this.hInRiser = this.riserStep();
      this.dConf = r[o + B_CONF];
      this.profileStep();
      this.bigAgg(r[o + B_INT], r[o + B_KICK] === 1, r[o + B_BREAK] === 1, wall);
      n++;
      if (this.bigYield) this.bigYield();
    }
    if (n > 0) {
      Atomics.store(ctrl, C_BIG_READ, seqLow(this.bigSeq));
      const p = this.outProfile;
      stateWrite(ctrl, this.bigState!, (s) => {
        s[BS_SEQ] = this.bigSeq; s[BS_BODY] = this.hBody; s[BS_DROPS] = this.dropCount; s[BS_MINI] = this.miniDropCount; s[BS_CAND] = this.dropCand;
        s[BS_DEMOTED] = this.dropDemoted; s[BS_SPACED] = this.dropSpaced; s[BS_DROPRISE] = this.dropRiseDb; s[BS_NEAR] = this.nearDropDb; s[BS_NEARDIP] = this.nearDipDb; s[BS_LIFT] = this.liftDb; s[BS_STOPS] = this.stopCount; s[BS_STOPSEC] = this.stopS; s[BS_BUILD] = this.buildUp; s[BS_RISER] = this.hInRiser ? 1 : 0;
        s[BS_PUNCH] = p.punch; s[BS_BASS] = p.bass; s[BS_BRIGHT] = p.bright; s[BS_BEAT] = p.beat; s[BS_BASSLINE] = p.bassline; s[BS_SPEC_N] = this.specN; s[BS_SKIPPED] = this.bigSkipped;
      }, C_BIG_SEQ);
      if (this.syncWorker) Atomics.notify(ctrl, C_BIG_SEQ);
    }
    return n;
  }
  /** 2048-bufferten som RING (a7/a8): hoppet skrivs på den äldstas plats i stället för copyWithin (8 kB memmove per hop);
   *  bigStep läser ringen i tidsordning från bigPos -> samma sampel i samma ordning, bit-identiskt. Förutsätter hop <= 2048. */
  private bigRingPush(samples: Float32Array): void {
    const B = this.bufferBig, N = B.length, p = this.bigPos, hop = samples.length, first = N - p;
    if (hop <= first) B.set(samples, p);
    else { B.set(samples.subarray(0, first), p); B.set(samples.subarray(first), 0); }
    this.bigPos = (p + hop) % N;
  }
  /** slow: alla hop-record lästa? (workerns sömnvillkor) */
  bigIdle(): boolean { return seqLow(this.bigSeq) === Atomics.load(this.splitCtrl!, C_BIG_WRITE); }
  /** slow: sektionens hopaggregat (som snabba sidans SECTION_AGG 'hop'-gren förr, samma summeringsordning). */
  private bigAgg(intensity: number, kick: boolean, breaking: boolean, wall: number): void {
    const rms = this.hRms;
    const sp = this.secSpecHop;   // bandDbRaw ändras bara i bigStep (var 3:e hop): räkna om då, samma värden
    if (this.secSpecDirty) { this.secSpecDirty = false; for (let i = 0; i < 8; i++) sp[i] = Math.pow(10, this.bandDbRaw[i] / 20); }
    const g = this.secAgg; g.n++; g.int += intensity; if (kick) g.kicks++; g.rms2 += rms * rms; g.cent += this.centSmooth; g.dt += this.dtHop * 1000;
    g.breaking = breaking ? 1 : 0; g.wall = wall; g.drops = this.dropCand + this.secBodyRet; g.active = this.activeMs; g.build = this.buildUp;
    for (let i = 0; i < 8; i++) g.spec[i] += sp[i];
  }
  /** Snabba sidans kommandon i exakt den ordning de restes (virtuell klocka forst: den nollar ankare som resten skriver). */
  private applyFlags(flags: number, hintMs: number, vclock: number): void {
    if (flags & F_VCLOCK_NULL) this.setVirtualClock(null); else if (flags & F_VCLOCK_SET) this.setVirtualClock(vclock);
    if (flags & F_RESET_TEMPO) this.resetTempo();
    if (flags & F_HINT) this.hintTrackChange(hintMs);
    if (flags & F_RESET_BAR) this.resetBar();
    if (flags & F_SIL350) this.holdSilent = true;   // TEMPO_HOLD: bara vila (se TEMPO_HOLD)
    else if (flags & F_SIL350) {
      this.localBpmConfidence = 0; this.clearLockVotes();
      this.envFilled = 0; this.beatAnchorMs = 0; this.beatPhaseMs = 0; this.beatPhaseConf = 0; this.phaseLastBeatMs = 0; this.phaseAnti = 0; 
      this.bpmHistLen = 0; this.bpmHistPos = 0; this.lastVoteMs = 0;
      for (let i = 0; i < this.tempoGram.length; i++) this.tempoGram[i] *= 0.5;
    }
    if (flags & F_SIL10) { this.localBpm = 0; this.tempoGram.fill(0); this.holdGrace = 0; }
  }
  /** Ett record = ett env-sampel: flaggor i ordning, ringvardena, snabba sidans fakta, env-steget, sektionsblocket. */
  private slowStep(o: number): void {
    const r = this.splitRing!;
    this.applyFlags(r[o + R_FLAGS], r[o + R_HINT_MS], r[o + R_VCLOCK]);
    this.virtualMs = r[o + R_PERF]; this.virtualOn = true;   // perfNow() = snabba tradens tid vid sampeln (deterministiskt)
    if (this.holdSilent && r[o + R_ENV] > 1e-6) { this.holdSilent = false; if (this.localBpm > 0) this.holdGrace = Analyser.ENV_LEN; }   // TEMPO_HOLD: ljudet ar tillbaka
    this.envRing[this.envPos] = r[o + R_ENV]; this.envBassRing[this.envPos] = r[o + R_BASS];
    if (HIGH_ON) this.envHighRing[this.envPos] = r[o + R_HIGH];
    this.envPos = (this.envPos + 1) % Analyser.ENV_LEN;
    this.envLastWallMs = r[o + R_WALL];
    this.localBpm = r[o + R_CLOCK], this.localBpmConfidence = r[o + R_CLOCK_CONF];   // EN KÄLLA (r0): klockans tempo, inte en egen sökning
    this.envFilled = Math.min(this.envFilled + 1, Analyser.ENV_LEN);
    if (this.bigOn) {   // stora vägen: sektionens fakta och blocksummor ur den egna hopvägen (hoppen före recordet är redan körda)
      const g = this.secAgg;
      if (g.n > 0) this.secVDrops = g.drops;
      this.envStep();
      if (g.n > 0) {
        const I = this.shIn; I.hops = g.n; I.intSum = g.int; I.kicks = g.kicks; I.breaking = g.breaking > 0; I.nowMs = g.wall; I.dtMs = g.dt; I.rms2Sum = g.rms2; I.centSum = g.cent;
        I.specOff = 0; I.bonSum = g.bon; I.bpk = g.bpk; I.fluxSum = g.flux; I.rms4Sum = g.rms4;
        this.sectionHop(g.spec);
        g.n = 0; g.int = 0; g.kicks = 0; g.breaking = 0; g.rms2 = 0; g.cent = 0; g.dt = 0; g.spec.fill(0); g.bon = 0; g.bpk = 0; g.flux = 0; g.rms4 = 0;
      }
      return;
    }
    const secN = r[o + R_SEC_N] > 0;
    if (!SECTION_AGG_HOP || secN) { this.dropCand = r[o + R_DROPS]; this.activeMs = r[o + R_ACTIVE]; this.buildUp = r[o + R_BUILD]; }
    this.envStep();
    if (secN)
    { const I = this.shIn; I.hops = r[o + R_SEC_N]; I.intSum = r[o + R_SEC_INT]; I.kicks = r[o + R_SEC_KICKS]; I.breaking = r[o + R_SEC_BREAK] > 0; I.nowMs = r[o + R_SEC_WALL];
      I.dtMs = r[o + R_SEC_DT]; I.rms2Sum = r[o + R_SEC_RMS2]; I.centSum = r[o + R_SEC_CENT]; I.specOff = o + R_SEC_SPEC0; I.bonSum = r[o + R_SEC_BON]; I.bpk = r[o + R_SEC_BPK];
      I.fluxSum = r[o + R_SEC_FLUX]; I.rms4Sum = r[o + R_SEC_RMS4];
      this.sectionHop(r); }
  }

  /** Sparets tid (s sedan den virtuella epoken) och VETO_WIN-fonstret (diagnostik, bara med sparflaggor). */
  private traceT(): number { return (this.wallNow() - 1700000000000) / 1000; }
  private traceWin(): boolean { if (!VETO_WIN) return false; const [wa, wb] = VETO_WIN.split(',').map(Number); const tt = this.traceT(); return tt >= wa && tt <= wb; }
  /** Nollställ tempoläget — anropas när låtminnet BEKRÄFTAT en låtgräns. Då vet vi
   *  att historiken tillhör förra låten; att medianrösta vidare på den kostade 6 s
   *  omlåsning. Nästa estimat får låsa direkt (localBpm === 0 ⇒ första röst låser). */
  resetTempo(): void {
    if (BPM_TRACE) console.log(`[bpmrst] t=${this.traceT().toFixed(1)} RESET bpm=${this.localBpm}`);
    this.flagSlow(F_RESET_TEMPO);
    this.localBpm = 0; this.localBpmConfidence = 0;
    this.bpmHistLen = 0; this.bpmHistPos = 0;
    this.clearLockVotes();
    this.tempoGram.fill(0);
  }

  /**
   * MJUK låtbytes-hint (Sonos trackName ändrades). Till skillnad från resetTempo()
   * kastas INTE tempot: många byten landar på liknande takt, och en bevarad
   * startgissning bekräftas i praktiken direkt (~1 takt) i stället för att byggas
   * upp från noll (~5 s MÄTT). Vi gör bara sökningen villigare att hoppa:
   *   • historiken töms (medianfönstret tillhör förra låten),
   *   • oktav-commit släpps (bpmStable=0) så ½×/2× får rättas igen,
   *   • lockPeak nollas så nya låtens takt inte jämförs mot förra låtens styrka,
   *   • under `windowMs` sänks grann-rättningens conf-grind och röstkrav.
   */
  /** LÅTGRÄNSEN (a4 entempo): antal låtgränser (boundaryDetector -> hintTrackChange). Klockan läser den per hop (hop-recordet H_BOUND) -
   *  det är klockans ENDA signal om låtbyte. */
  trackBoundaries = 0;
  /** Tystnad i ms (klockans tystnadssignal, hop-recordet H_QUIET; > 10 s släpper klockan som förr F_SIL10 släppte tempot). */
  get quietMs(): number { return this.silentMs; }
  /** EN KÄLLA (r0 entempo): analysatorns ENDA tempo och tillit = klockans (taktvägen i analysatorns långsamma väg, efter varje hop).
   *  Läses av kickspärren/-grinden (via rutnätet), sectionBars, basgången, sektionernas långsamma sida (env-recordet R_CLOCK) och ramen. */
  setClock(bpm: number, conf: number): void { this.localBpm = bpm > 40 ? bpm : 0; this.localBpmConfidence = bpm > 40 ? conf : 0; }
  hintTrackChange(windowMs = 5000, sections = true): void {
    if (this.role !== 'slow') this.trackBoundaries++;
    if (BPM_TRACE) console.log(`[bpmrst] t=${this.traceT().toFixed(1)} HINT bpm=${this.localBpm} conf=${this.localBpmConfidence.toFixed(2)}`);
    // A5: reacq-fönstret jämförs mot perfNow() (samma tidbas som voteNow).
    // Date.now() gjorde `voteNow < reacqUntilMs` alltid falskt → hinten var död.
    if (this.role === 'fast') { this.pendHintMs = windowMs; this.flagSlow(F_HINT); }
    this.reacqUntilMs = this.perfNow() + windowMs;
    this.bpmHistLen = 0; this.bpmHistPos = 0; this.lastVoteMs = 0;
    // TEMPOGRAMMET MASTE NOLLAS HAR. Det ar EMA-ackumulerat (a = 0.15 nar last)
    // och overlevde tidigare latbytet, sa forra latens toppar lag kvar och
    // konkurrerade med den nya latens bevis under de forsta avgorande sekunderna.
    // MATT offline pa latpar (tools/carryOver.mjs i pi-dmx): samma ljud
    // gav "En dag pa stranden" 97 % ratt med FARSK analysator men 0 % (median 151)
    // nar den kordes efter foregaende lat -- exakt det fel anvandaren sag live.
    // Overhanget kostade 14.8 procentenheter i snitt; med nollning -0.2.
    // ATT SKALA arrayen racker INTE (provat 0.5 / 0.3 / 0.15: noll effekt) --
    // en konstant faktor andrar inte vilken bin som ar storst. Bara nollning biter.
    const k = Analyser.TG_KEEP;
    if (k <= 0) this.tempoGram.fill(0); else if (k < 1) for (let i = 0; i < this.tempoGram.length; i++) this.tempoGram[i] *= k;
    this.clearLockVotes();
    // NY LAT = NY STRUKTUR. Tempot bars over (se ovan), men sektionshistoriken tillhor forra laten och maste bort:
    // annars rangordnas nya laten mot gamla block och 'intro' intraffar aldrig. sectionReset() ar samma nollning
    // som 10 s tystnad redan gor - enda skillnaden ar att vi nu ocksa litar pa latbytes-signalen.
    if (sections) {
      const N = Analyser.SECTION_CARRY;
      if (N > 0) {
        const keep = <T>(x: T[]) => x.slice(Math.max(0, x.length - N)); const H = this.secBlkH;
        const c = [keep(this.secBlkDb), keep(this.secBlkDens), keep(this.secBlkCentH), keep(this.secBlkHighH), keep(this.secBlkT), keep(this.secBlkFeat), keep(this.secBlkHi), keep(H.bon), keep(H.bpk), keep(H.high), keep(H.flat), keep(H.flux), keep(H.dyn)];
        const hd = this.lastHighDb === this.lastHighDb ? this.lastHighDb : this.secCarryHighDb;
        this.sectionReset(); this.secCarryHighDb = hd;
        const put = <T>(x: T[], v: T[]) => { x.length = 0; for (const e of v) x.push(e); };
        put(this.secBlkDb, c[0] as number[]); put(this.secBlkDens, c[1] as number[]); put(this.secBlkCentH, c[2] as number[]); put(this.secBlkHighH, c[3] as number[]); put(this.secBlkT, c[4] as number[]); put(this.secBlkFeat, c[5] as Float32Array[]); put(this.secBlkHi, c[6] as number[]);
        put(H.bon, c[7] as number[]); put(H.bpk, c[8] as number[]); put(H.high, c[9] as number[]); put(H.flat, c[10] as number[]); put(H.flux, c[11] as number[]); put(H.dyn, c[12] as number[]);
      } else this.sectionReset();
    }
  }

  /** Nollställ lås-/röst-ackumulatorerna — gemensam kärna för resetTempo/hintTrackChange/
   *  silens, så de tre inte kan divergera (jfr A5-buggen som var just en divergens). */
  private clearLockVotes(): void {
    this.warmCalls = 0; this.holdCalls = 0;
    this.octaveVote = 0; this.nearVote = 0; this.nearChallenger = 0; this.bpmStable = 0;
    this.newSongVote = 0; this.challengerBpm = 0; this.lastSongVoteMs = 0; this.lockPeak = 0;
  }

  /** Taktfasen är applicerad av motorn (ankaret flyttat) → börja om räkningen. */
  resetBar(): void { this.flagSlow(F_RESET_BAR); }

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
   *  ålder. Spelar man upp ljud snabbare än realtid hinner åtta takter
   *  gå på några millisekunder och hela strukturlogiken kollapsar.
   *
   *  Med en injicerbar klocka blir analysatorn DETERMINISTISK: samma ljud in ger
   *  samma bildrutor ut, oavsett hur fort man matar den. Det är förutsättningen
   *  för en regressionsbänk — och för att kunna välja tröskelvärden mot tjugo
   *  låtar i stället för mot en. Live är beteendet oförändrat (null = riktig tid). */
  // TYPSTABIL (2026-09-27, realtidsprincipen): aldrig null<->tal i ett falt som lases varje hop - det deprecerar
  // instansens map och kastar TurboFan-koden. virtualOn ar vaxeln, virtualMs alltid ett tal (NaN nar av).
  private virtualMs = NaN; private virtualOn = false;
  /** Driv analysatorn på en virtuell klocka (offline-uppspelning). Anropas med
   *  ackumulerad ljudtid i ms före varje process(). null = tillbaka till realtid. */
  /**
   * VIRTUELL KLOCKA FOR OFFLINE-BANKEN.
   *
   * Alla klockankare maste nollstallas, annars laser detektorerna sig. Uppmatt
   * mekanism: efter en live-korning ar `lastKick` ~1e6 medan `now` startar om
   * pa ~0, sa `now - lastKick` blir NEGATIVT → cooldown-villkoret blir aldrig
   * sant → ingen kick fyrar nagonsin igen, och eftersom `lastKick` bara skrivs
   * NAR en kick fyrar ar lasningen permanent. Samma falla gallde flera andra
   * ankare. Att bara satta `virtualMs` racker alltsa inte.
   */
  setVirtualClock(ms: number | null) {
    if (this.role === 'fast') { if (ms === null) this.flagSlow(F_VCLOCK_NULL); else { this.pendVclock = ms; this.flagSlow(F_VCLOCK_SET); } }
    // LAGESBYTE bara vid ett HOPP (forsta anropet, bakat, eller > 1 s framat): en bank som anropar per hop med
    // ljudtiden far bara klockan flyttad (som advanceVirtualClock) - ankarna nollas inte varje hop.
    const prev = this.virtualMs;
    const jump = ms === null || !this.virtualOn || ms < prev || ms - prev > 1000;
    if (ms === null) { this.virtualOn = false; this.virtualMs = NaN; } else { this.virtualOn = true; this.virtualMs = ms; }
    if (!jump) return;
    this.lastKick = 0;
    this.pendingKickMs = 0;
    this.lastVoteMs = 0;
    this.lastConfMs = 0;
    this.lastSongVoteMs = 0;
    this.reacqUntilMs = 0;
    this.beatAnchorMs = 0; this.beatPhaseMs = 0; this.beatPhaseConf = 0; this.phaseLastBeatMs = 0; this.phaseAnti = 0; this.sectionReset();
    this.lastT = 0;
  }
  /** KORBANK (09-20): flytta bara den virtuella klockan, utan att nolla nagra ankare. setVirtualClock() ar ett
   *  LAGESBYTE (nollar lastT/lastKick/pendingKickMs/lastVoteMs...) och far bara anropas en gang - anropad per hop
   *  fros AGC:n (dt=0), kickar forfinades aldrig (0 kickar) och rosterna foll varje anrop. */
  advanceVirtualClock(ms: number): void { this.virtualMs = ms; this.virtualOn = true; }
  private perfNow(): number { return this.virtualOn ? this.virtualMs : performance.now(); }
  /**
   * LJUDKLOCKAN — ms sedan start raknat ur ANTALET BEARBETADE SAMPEL, satt av
   * matningen strax fore varje process(). -1 = inte satt (aldre anropare).
   *
   * VARFOR: slagtiden (`beatAnchorMs` -> `kickAtMs`) forfinas sub-hop med en
   * parabel och PLL:en litar pa den som "+-1,3 ms". Men stampeln som parabeln
   * forfinar RELATIVT var `Date.now()` vid den hop som sag slaget — alltsa
   * exakt den ALSA-leveransjitter PLL-kommentaren tror sig ha undvikit.
   * Perioden ar 5,3 ms, callbacks kommer i klumpar om 1-3 hop, plus
   * handelseloopens fordrojning: verklig fasnoise +-5-8 ms per slag, och
   * systematiskt sen. Sub-hop-precisionen var alltsa illusorisk.
   *
   * Ljudklockan bar ingen leveransjitter alls. Den mappas till vaggtid via en
   * LANGSAMT filtrerad offset, sa PLL:ens vaggklocke-ram behalls men jittret
   * forsvinner. Det tar ocksa bort analyslatensen ur fasen: slaget stamplas
   * nar det VAR i ljudet, inte nar det rapporterades.
   */
  private audioClockMs = -1;
  private audioToWallOffset = 0;
  private audioOffsetSeeded = false;
  setAudioClockMs(ms: number): void {
    this.audioClockMs = ms;
    const raw = Date.now() - ms;
    if (!this.audioOffsetSeeded) { this.audioToWallOffset = raw; this.audioOffsetSeeded = true; return; }
    // DISKONTINUITET (mic-omstart, stall): ljudklockan star still medan
    // vaggklockan gar, och en EMA med tau ~5 s skulle lamna slagen felstamplade i
    // sekunder. Ett hopp storre an ett taktslag ar aldrig drift — sa om direkt.
    if (Math.abs(raw - this.audioToWallOffset) > 250) { this.audioToWallOffset = raw; return; }
    // Tidskonstant ~5 s vid 375 Hz: foljer klockdrift, slatar ut leveransjitter.
    this.audioToWallOffset += (raw - this.audioToWallOffset) * 0.0005;
  }
  /** Tillbaka till Date.now(). Nasta setAudioClockMs sar om offseten. */
  clearAudioClock(): void { this.audioClockMs = -1; this.audioOffsetSeeded = false; this.audioToWallOffset = 0; }
  private wallNow(): number {
    if (this.virtualOn) return this.virtualEpoch + this.virtualMs;
    return this.audioClockMs >= 0 ? this.audioClockMs + this.audioToWallOffset : Date.now();
  }
  private virtualEpoch = 1700000000000;

  private cfg: {
    audio: { rate: number };
    fft: { size: number; hop: number };
    detection: AnalyserDetection;
    onset: { enhancements: boolean };
  };
  /** Taktrastret (kick-grind + taktfas). Nastlad konfig: motorns eget objekt (lases lopande); platt: internt, via setBeatGrid. */
  private beatSrc: { beat?: BeatGrid | null };

  /** EN KLOCKA: rutnätet utifrån (lotus PLL via setAnalyserBeatGrid, bänkens BENCH_GRID) är INGEN rutnätskälla - kickgrinden läser
   *  klockans inre rutnät (setClockGrid). Det sparas bara som REFERENS för slagindexet i frame.barShift (EN ETTA, publishPhase):
   *  klockans etta uttryckt i systemets eget rutnäts index. */
  setBeatGrid(grid: BeatGrid | null): void { this.extGrid = grid; }
  private extGrid: BeatGrid | null = null;
  /** Klockans inre rutnät (analyserClock.update / taktvägen HopLaneFast) - analysatorns enda rutnät. */
  setClockGrid(grid: BeatGrid | null): void { this.beatSrc.beat = grid; }

  constructor(cfgIn: AnalyserConfig, splitIn?: SplitInit) {
    this.role = splitIn?.role ?? cfgIn.role ?? 'all';
    const splitBuf = splitIn?.split ?? cfgIn.split;
    if (this.role !== 'all') {
      if (!splitBuf) throw new Error('Analyser: roll ' + this.role + ' kraver split-buffertar');
      const v = viewsOf(splitBuf); this.splitCtrl = v.ctrl; this.splitRing = v.ring; this.splitState = v.state;
      // resumeSeq (full JS-seq) fran index.ts: slow = senast lasta record (omstart av workern fortsatter dar den dog,
      // drainRecords klipper backloggen till RING_N-RING_MARGIN); C_READ ar bara 32 laga bitar och duger inte ensamt.
      this.recSeq = splitIn?.resumeSeq ?? cfgIn.resumeSeq ?? 0;
      this.syncWorker = splitIn?.sync === true;
      if (this.role === 'slow') {
        this.slowGap = true;   // forsta recordet: okand forhistoria -> raknarna tas som utgangspunkt
        // Seqlock-paritet: dog forra workern MITT I stateWrite (terminate/OOM) star C_STATE_SEQ udda for alltid och varje
        // stateRead pa snabba sidan misslyckas — aven mot den nya workern (som skulle skriva udda→jamn→udda). En skribent
        // i taget, sa det ar sakert att jamna till har.
        const sq = Atomics.load(v.ctrl, C_STATE_SEQ); if (sq & 1) Atomics.store(v.ctrl, C_STATE_SEQ, sq + 1);
      }
      if (Analyser.FAST_BANDS && SECTION_AGG_HOP && splitBuf.big && splitBuf.bigPcm && splitBuf.bigState && splitBuf.spec) {
        (this as { bigOn: boolean }).bigOn = true;
        this.bigRing = new Float64Array(splitBuf.big); this.bigPcm = new Float32Array(splitBuf.bigPcm); this.bigState = new Float64Array(splitBuf.bigState); this.specRing = new Float32Array(splitBuf.spec);
        if (this.role === 'slow') {   // omstart av workern: fortsätt i sekvensen, med räknarna (en drop-räknare som hoppar bakåt vore en ny 'drop')
          const sq = Atomics.load(v.ctrl, C_BIG_SEQ); if (sq & 1) Atomics.store(v.ctrl, C_BIG_SEQ, sq + 1);
          const st = this.bigState; this.bigSeq = st[BS_SEQ]; this.dropCount = st[BS_DROPS]; this.miniDropCount = st[BS_MINI]; this.specN = st[BS_SPEC_N]; this.dropCand = st[BS_CAND]; this.secVDrops = this.dropCand;
          this.dropDemoted = st[BS_DEMOTED]; this.dropSpaced = st[BS_SPACED]; this.stopCount = st[BS_STOPS];
        }
      }
    }
    const cfg = this.cfg = {
      audio: { rate: cfgIn.audio?.rate ?? cfgIn.sampleRate ?? 48000 },
      fft: { size: cfgIn.fft?.size ?? cfgIn.fftSize ?? 512, hop: cfgIn.fft?.hop ?? cfgIn.hopSize ?? 128 },
      // Nastlad form: motorns detection-objekt anvands sjalvt (UI:t kan andra AGC-rattarna under drift).
      detection: cfgIn.detection ?? {
        autoGainTarget: cfgIn.autoGainTarget ?? 0.15,
        tauUp: cfgIn.tauUp ?? 3,
        tauDown: cfgIn.tauDown ?? 8,
        noiseFloor: cfgIn.noiseFloor ?? 0.002,
        maxGain: cfgIn.maxGain ?? 20,
      },
      onset: { enhancements: cfgIn.onsetEnhancements ?? false },
    };
    this.beatSrc = cfgIn.detection ? cfgIn : { beat: null };
    this.setSilenceLevel(cfgIn.silenceLevel);
    this.fft = new FFT(cfg.fft.size);
    this.window = hannWindow(cfg.fft.size);
    this.buffer = new Float32Array(cfg.fft.size);
    this.prevMag = new Float32Array(cfg.fft.size / 2);
    this.onsetPeak = new Float32Array(cfg.fft.size / 2);
    this.onsetPrev = new Float32Array(cfg.fft.size / 2);
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
    if (Analyser.FAST_BANDS) {   // snabba banden: 512-binnar för band 3-7, biquads för band 0-2 (RBJ, Q 0,707)
      const binHz = cfg.audio.rate / cfg.fft.size, half = cfg.fft.size / 2;
      for (let b = 3; b < 8; b++) { this.fbLo[b] = Math.max(1, Math.round(Analyser.BAND_HZ[b] / binHz)); this.fbHi[b] = Math.min(half, Math.max(this.fbLo[b] + 1, Math.round(Analyser.BAND_HZ[b + 1] / binHz))); }
      this.fbMax = Math.min(half, this.fbHi[7] + 1);
      if (this.fbMag.length < half) { this.fbMag = new Float32Array(half); this.fbPrevMag = new Float32Array(half); }
      const dtMs = cfg.fft.hop / cfg.audio.rate * 1000;
      for (let b = 0; b < 3; b++) {
        for (let s = 0; s < 2; s++) {
          const f0 = Analyser.BAND_HZ[b + s], w = 2 * Math.PI * f0 / cfg.audio.rate, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
          const o = (b * 2 + s) * 5, C = this.fbCoef;
          if (s === 0) { C[o] = (1 + c) / 2 / a0; C[o + 1] = -(1 + c) / a0; C[o + 2] = (1 + c) / 2 / a0; }   // HP vid bandets nedre kant
          else { C[o] = (1 - c) / 2 / a0; C[o + 1] = (1 - c) / a0; C[o + 2] = (1 - c) / 2 / a0; }          // LP vid övre kanten
          C[o + 3] = -2 * c / a0; C[o + 4] = (1 - al) / a0;
        }
        this.fbA[b] = 1 - Math.exp(-dtMs / Analyser.FB_TAU_MS[b]);
      }
      this.fbAlvl = 1 - Math.exp(-dtMs / 90);
    }
    this.magBigMax = Math.min(BIG / 2, this.bandHi[7] + 1);
    this.magBigView = this.magBig.subarray(0, this.magBigMax);
    this.prevMagBigView = this.prevMagBig.subarray(0, this.magBigMax);
    if (this.bigOn) this.specCopy = new Float32Array(Math.min(SPEC_MAX, this.magBigMax));

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
      silent: true, level: 0, levelRaw: 0, levelVU: 0, energy: 0, centroid: 0, flux: 0,
      kick: false, gain: 1, bpm: 0, bpmConfidence: 0, intensity: 0.5,
      dropCount: 0, miniDropCount: 0, dropDemoted: 0, dropSpaced: 0, dropRiseDb: 0, nearDropDb: 0, nearDipDb: 0, liftDb: 0, stopCount: 0, stopS: 0, bodyDb: 0, bassEnergy: 0, bassEnergyShort: 0, bassLevel: 1, midHiDb: -120, kickRise: 0, inZone: false, breaking: false, buildUp: 0, inRiser: false, profile: this.outProfile, beatAnchorMs: 0,
      kickAtMs: 0, barShift: -1, beatPhaseMs: 0, beatPhaseConf: 0, beatTrust: 0, section: 'intro', sectionAgeMs: 0, sectionIndex: 0, sectionTier: 1, repeatSim: 0, repeatAgoMs: 0, repeatSection: '', expectHighInMs: -1, prevSection: '', levelVsHighDb: 0, sectionBars: 0,
      spec: this.outSpec, specAbs: this.outSpecAbs, onset: this.outOnset, drum: this.outDrum,
    };
    // Ramen och dess delobjekt skrivs varje hop av optimerad kod: ge alla talfalt Double-form redan har (se stabiliseNumbers).
    for (const o of [this.outFrame, this.outProfile, this.outSpec, this.outSpecAbs, this.outOnset, this.outDrum]) stabiliseNumbers(o);
    // Instansfalt som i stabilt lage bytte Smi->Double forst vid sallsynta handelser (V8 --trace-generalization, 540 s).
    // FORSLAG 2026-09-27 (minnesgranskningen, tools/mem/): --trace-generalization over 240 s pop-facit visade att 60 instansfalt
    // byter Smi->Double EFTER start (var och en deprecerar Analyser-kartan: +10..+369 kartor per falt) -> scoreEnv deoptades 41 ggr,
    // process() 13 ggr ("wrong map", "Maps became deprecated during optimization"), och ooptimerad kod boxar varje flyttal:
    // 43 kB skrap/hop kallt mot 1,2 kB/hop stabilt (--no-opt: 1 MB/hop). Listan ar exakt de falt som mattes generalisera.
    for (const k of DOUBLE_FROM_START) { const v = (this as unknown as Record<string, number>)[k]; if (typeof v === 'number') { (this as unknown as Record<string, number>)[k] = 0.5; (this as unknown as Record<string, number>)[k] = v; } }
    stabiliseNumbers(this.secRank as unknown as Record<string, unknown>);
  }

  /** Feed a hop-sized chunk of mono samples, get a frame back. */
  process(samples: Float32Array): Frame {
    if (this.hopLane) this.setClock(this.hopLane.clockBpm, this.hopLane.clockConf);   // EN KÄLLA (a7r): klockans tal ur analysatorns EGEN taktväg (förra hoppets publicering)
    if (this.role === 'fast') this.pullSlowState();
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
    { const buf = this.buffer, win = this.window; for (let i = 0; i < windowed.length; i++) windowed[i] = buf[i] * win[i]; }
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
    const kickBins = Math.min(1, half);                             // ENBART bin 0 ≈ 0–94 Hz (bastrummans transient, inte basgången)
    const enhancedOnset = this.cfg.onset.enhancements;

    // Ljusets nivå använder fortfarande rå magnitud. Onset-vägen kan däremot
    // komprimeras och vitbalanseras per FFT-bin, så en högljudd/tonal källa inte
    // sväljer svagare transienter i tempogrammet.
    // TRE LOOPAR I STÄLLET FÖR EN (a7, samma aritmetik i samma ordning): basbinnen (onset + snabba bandens magnitud = samma
    // sqrt som m), binnen upp till de snabba bandens tak (sqrt) och resten (bara centroidens summor). Fälten hissade ut ur
    // loopen (ingen this-läsning per varv); powSum/powW summeras fortfarande i stigande bin-ordning.
    const fbMax = Analyser.FAST_BANDS ? this.fbMax : 0, fbMag = this.fbMag;
    const onsetPeak = this.onsetPeak, onsetPrev = this.onsetPrev, peakDecay = this.onsetPeakDecay, peakReady = this.onsetPeakReady, PFLOOR = Analyser.ONSET_PEAK_FLOOR;
    for (let i = 0; i < bassBins; i++) {
      const re = spectrum[2 * i];
      const im = spectrum[2 * i + 1];
      const p = re * re + im * im;
      const m = Math.sqrt(p);
      bassEnergy += m;
      let onsetMag = m;
      if (enhancedOnset) {
        // Log-kompression före differensen + SuperFlux-liknande långsam
        // per-bin-whitening. Peak uppdateras före division så varje bin börjar
        // på en stabil skala även när signalen startar från tystnad.
        const compressed = Math.log1p(m);
        let peak = onsetPeak[i] * peakDecay;
        if (compressed > peak) peak = compressed;
        onsetPeak[i] = peak;
        onsetMag = peakReady ? compressed / Math.max(PFLOOR, peak) : 0;
      }
      mag[i] = m;
      const dd = onsetMag - onsetPrev[i];
      onsetPrev[i] = onsetMag;
      if (dd > 0) { flux += dd; if (i < kickBins) kickFlux += dd; }   // half-wave rectified
      powSum += p; powW += i * p;
      if (i < fbMax) fbMag[i] = m;
    }
    const fbEnd = Math.max(bassBins, Math.min(fbMax, half));
    for (let i = bassBins; i < fbEnd; i++) {
      const re = spectrum[2 * i], im = spectrum[2 * i + 1], p = re * re + im * im;
      powSum += p; powW += i * p;
      fbMag[i] = Math.sqrt(p);
    }
    for (let i = fbEnd; i < half; i++) {
      const re = spectrum[2 * i], im = spectrum[2 * i + 1], p = re * re + im * im;
      powSum += p; powW += i * p;
    }
    this.onsetPeakReady = true;
    if (enhancedOnset) {
      for (let i = 0; i < bassBins; i++) this.prevMag[i] = this.onsetPrev[i];
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
    const fluxNorm = Math.min(1, flux * (enhancedOnset ? 0.08 : 0.005));

    // Auto-gain (slow: seconds-to-minute timescales)
    const now = this.perfNow();
    const dt = this.lastT === 0 ? 0 : Math.max(0, Math.min(0.1, (now - this.lastT) / 1000));
    this.lastT = now;
    const d = this.cfg.detection;
    // AGC körs BARA för mic (aux låser gain på 1× — line-level är hett & stabilt).
    // PERCENTIL-AGC (från Lotus, live-mätt): envelopen är 95:e percentilen av RÅ rms
    // över ~2 s, inte en EMA av den gainade momentannivån. Målet är ett TAK för
    // topparna. Långsam attack (tauUp×2) så uppbyggnader får höras, snabb retreat
    // (tauDown×0.25) eftersom AGC:n inte kan ta bort redan inbränd klippning.
    this.dbgRms = rms;
    this.hRms = rms; this.hNow = now; this.hDt = dt;
    this.hGated = rms >= this.cfg.detection.noiseFloor * 1.5;   // BRUSGRINDEN (a7): enda jämförelsen, snabba sidan; workern läser activeMs > 0 (B_ACTIVE)
    if (!this.gainLocked && rms > d.noiseFloor) this.agcStep();

    const level = Math.min(1, rms * this.gain);

    this.hKickFlux = kickFlux; this.hEnergy = energy;
    const kick = this.kickStep();

    // Hoppets längd i ms. (Tva stallen nedan raknar fortfarande `dtHop * 1000`
    // for hand i stallet for att lasa den har — numeriskt identiskt, men
    // pastaendet "en enda forberaknad konstant" var inte sant.)
    const hopMs = this.hopMs;
    // Tystnad → nollställ BPM-klockan så beat-effekter inte fortsätter i fantom-takt.
    this.hHopMs = hopMs;
    this.silenceStep();
    // --- Onset-envelope → lokal BPM (nedsamplad till 100 Hz) ---

    this.envAccum = Math.max(this.envAccum, fluxNorm);
    // Basbandets egen envelope (kick-flux) — samma raster, oberoende signal.
    const bassFluxNorm = Math.min(1, kickFlux * (this.cfg.onset.enhancements ? 0.5 : 0.02));
    if (bassFluxNorm > this.envBassAccum) this.envBassAccum = bassFluxNorm;
    // TYDLIG BASGANG: basnivans topp per env-sampel + senaste kick (se stepBassline).
    const big = this.bigOn;   // STORA VÄGEN (fast): basgången, 2048-vägen, drop, riser, profil och sektionsaggregatet körs i långsamma tråden
    if (!big) { const bl = this.bandLvl[1] + this.bandLvl[2]; if (bl > this.blAccum) this.blAccum = bl; if (this.kickHit >= 1) this.blKickSeq = this.envSeq; }
    if (HIGH_ON) { const hi = this.bandOn[6] > this.bandOn[7] ? this.bandOn[6] : this.bandOn[7]; if (hi > this.envHighAccum) this.envHighAccum = hi; }
    this.envAccumT += hopMs;
    if (this.envAccumT >= 1000 / Analyser.ENV_HZ) this.envSampleStep();
    // #2 Förfina förra kickens fas: nu har vi y(-1)=kfPrev2, y(0)=kfPrev, y(+1)=kickFlux
    // runt kick-hopet. Parabelns topp ger sub-hop-offset δ ∈ [-0.5,0.5] hop.
    let kickAtMs = 0;

    if (this.pendingKickMs > 0) { this.kickRefine(); kickAtMs = this.hKickAt; }
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

    this.intensityStep();
    const intensity = this.hIntensity;

    // --- DUBBEL-FFT: hög-upplöst log-spektrum för effekterna ---
    // Egen glidande 2048-buffert, matas samma hop. Ger 23 Hz/bin i botten så
    // sub/kick/bas separeras. Per-band AGC-nivå + per-band adaptiv onset.
    // Bufferten matas VARJE hop (glidande fönster måste vara obrutet)...
    if (!big) {
    this.bigRingPush(samples);
    // ...men själva FFT:n + band-analysen körs bara var BIG_EVERY:e hop. 2048-FFT:n
    // är analysatorns dyraste steg och spec-NIVÅERNA smoothas ändå ~90ms — de behöver
    // inte 375Hz. MÄTT: analysen tog 3.8ms/hop mot 2.67ms budget → ljud droppades och
    // ljuset låg 40–140ms efter. Decimeringen får den att rymmas i realtid.
    // Tidssteget skalas (bigDt) så smoothing-tidskonstanterna blir oförändrade.
    if (++this.bigCounter >= Analyser.BIG_EVERY) this.bigStep();
    }
    if (Analyser.FAST_BANDS) this.fastBandStep(samples);
    // TRUM-KIT peak-hold-envelopes PÅ HOP-TAKT (var 2.7ms) → fångar varje anslag,
    // aldrig missat mellan två render-frames (100Hz). tau bevarade från effects.ts:
    // hat 60ms (treble+air-onset O[6]/O[7]) / snare 110ms (highMid-onset O[5]) / kick 150ms
    // (ENBART diskret kick — se nedan). bass = spec.bass-NIVÅ (L[2], ingen envelope).
    // Hi-hats/sizzle i modern EDM/trap ligger ofta >10 kHz, så hat får lyssna på både
    // treble (3,5–10 kHz) och air (10–16 kHz) och ta den starkaste transienten.
    const ON = Analyser.FAST_BANDS ? this.fbOn : this.bandOn;   // trumenveloperna är ljus: snabba banden med FAST_BANDS
    const hatOnset = ON[6] > ON[7] ? ON[6] : ON[7];
    this.hatHit = Math.max(this.hatHit * this.dHat, hatOnset);
    this.snareHit = Math.max(this.snareHit * this.dSnare, ON[5]);
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

    // TRE villkor, inte tva: utover hysteresen (85 % in / 70 % ut) finns ett
    // ABSOLUT golv pa 0.65 som saknar motsvarighet pa vagen ut. Det kan ensamt
    // halla inZone falsk genom en hel tyst lat. Odokumenterat tidigare.
    if (this.lvlSmooth > this.levelCeil * 0.85 && this.lvlSmooth > 0.65) this.inZoneState = true;
    else if (this.lvlSmooth < this.levelCeil * 0.70) this.inZoneState = false;
    const inZone = this.inZoneState;
    // BASKROPPEN — drop-detektionens egen signal (tak + frånvaro + stigningstakt).
    // `inZone` lämnas orörd: effektlagret använder den som "musiken ligger högt".

    this.hKick = kick; this.hNowWall = nowWallA;
    let inRiser: boolean;
    if (big) {
      this.hIntensity = intensity; this.hBreaking = breaking;
      this.pushBig(samples);
      inRiser = this.hInRiser;
    } else {
      const bodyNow = (this.bandDbRaw[0] + this.bandDbRaw[1] + this.bandDbRaw[2]) / 3;   // ra dB
      this.hBody = bodyNow;
      this.dSec = this.section; this.dLvh = this.levelVsHighDb;
      this.dropStep();
      inRiser = this.riserStep();
      this.dConf = this.localBpmConfidence;
      this.profileStep();
    }
    this.hLevel = level; this.hFlux = fluxNorm; this.hIntensity = intensity; this.hInZone = inZone; this.hBreaking = breaking; this.hInRiser = inRiser;
    this.hKickAt = kickAtMs;
    return this.fillFrame();
  }

  /** AGC (bara mic): utbruten ur process() 2026-09-27 — anropas nar gainen ar olast och signalen over golvet. */
  private agcStep(): void {
    const rms = this.hRms, now = this.hNow, dt = this.hDt;
    const d = this.cfg.detection;
      const env = this.agcEnvelope(rms, now);
      if (env > 0) {
        this.envelope = env;
        const desired = d.autoGainTarget / Math.max(1e-4, env);
        const gTau = desired > this.gain ? d.tauUp * 2 : d.tauDown * 0.25;
        const ga = 1 - Math.exp(-dt / gTau);
        this.gain += (desired - this.gain) * ga;
        if (this.gain < 0.5) this.gain = 0.5;
        else if (this.gain > 20) this.gain = 20;
      }
  }

  /** Kick-detektorn (median/MAD-troskel, taktgrind, flank + cooldown). Het varje hop; egen funktion sa att process() ar kompakt. */
  private kickStep(): boolean {
    const kickFlux = this.hKickFlux, energy = this.hEnergy, now = this.hNow;
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
      const dMed = kickFlux - this.kickMed;
      this.kickMed += (dMed > 0 ? 1 : dMed < 0 ? -1 : 0) * kStep * (this.kickMed + 0.01);
      const dMad = Math.abs(kickFlux - this.kickMed) - this.kickMad;
      this.kickMad += (dMad > 0 ? 1 : dMad < 0 ? -1 : 0) * kStep * (this.kickMad + 0.01);
      // KLAMP MOT NOLL — UTAN DEN PARKERAR SPÅRAREN PÅ -0.01 OCH DÖR DÄR.
      // Steget skalas med (x + 0.01), så -0.01 är en ATTRAHERANDE fixpunkt: steget
      // kollapsar geometriskt och efter ~16 s digital tystnad är det under en halv
      // ulp. Återhämtningen går då från sekunder till ~10^5 s, dvs permanent tills
      // processen startas om. Följden är inte "sämre detektion" utan att kicken
      // TYSTNAR HELT: kickThresh = med + 4.5*mad blir negativ, `above` blir alltid
      // sann, och flankvillkoret (above && !kickWasAbove) kan då aldrig bli sant.
      // Utlösaren är exakta nollor — mutad codec, ALSA-loopback utan skrivare,
      // eller en WAV med digital tystnad i offline-bänken.
      if (this.kickMed < 0) this.kickMed = 0;
      if (this.kickMad < 0) this.kickMad = 0;
    }
    const kickThresh = this.kickMed + Analyser.KICK_K * this.kickMad;
    // korbank-telemetri. Objektet skapas EN gang och skrivs sedan i stallet (skrapjakten 09-30: ett nytt objekt per hop
    // med boxade flyttal = ~220 B/hop = ~85 kB/s skrap i huvudtraden; ingen laser en gammal referens).
    const dk = this.dbgKick;
    if (dk === null) this.dbgKick = { flux: kickFlux, thresh: kickThresh, med: this.kickMed, mad: this.kickMad, energy, gain: this.gain, rms: this.dbgRms, env: this.envelope, locked: this.gainLocked };
    else { dk.flux = kickFlux; dk.thresh = kickThresh; dk.med = this.kickMed; dk.mad = this.kickMad; dk.energy = energy; dk.gain = this.gain; dk.rms = this.dbgRms; dk.env = this.envelope; dk.locked = this.gainLocked; }
    // ms → hindrar sub-beat-dubbelfyr. 0 i ratten = tempoanpassad (0,6 slag, minst 170 ms, nar tempot ar kant).
    const gk = this.beatSrc.beat;   // EN KÄLLA (r0): klockans rutnät; null = klockan i coast -> öppen grind och 170 ms (som förr utan tempo)
    const cb = gk && gk.bpm > 40 ? gk.bpm : 0;
    const KICK_COOLDOWN = Analyser.KICK_COOLDOWN_MS > 0 ? Analyser.KICK_COOLDOWN_MS
      : (cb > 0 ? Math.max(170, Math.min(KICK_CAP_MS, (60000 / cb) * 0.6)) : 170);
    let above = kickFlux > kickThresh && energy > Analyser.KICK_EFLOOR;
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
    const grid = this.beatSrc.beat;
    if (above && grid && grid.bpm > 40 && (grid.confidence ?? 0) > 0.5) {
      const beatMs = 60000 / grid.bpm;
      const gridMs = beatMs / 2;                    // attondelar: four-on-the-floor + upptakter
      const offset = ((this.wallNow() - grid.anchorMs) % gridMs + gridMs) % gridMs;

      const distToGrid = Math.min(offset, gridMs - offset);
      const tolerance = Math.max(30, beatMs * 0.15);   // 60 ms vid 150 BPM (0.15*400)
      if (distToGrid > tolerance && !Analyser.KICK_NOGATE) above = false;    // skarp transient, men felplacerad
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
    return kick;
  }

  /** Tystnadsflanken (350 ms / 10 s). Sallan korda grenar: i egen funktion sa att en forsta korning inte deoptimerar hetslingan. */
  private silenceStep(): void {
    const hopMs = this.hHopMs;
    if (!this.hGated) {
      this.silentMs += hopMs;
      // FLANKTRIGGAT: hela reseten kördes förut VARJE tyst hop efter 350 ms —
      // tempoGram.fill(0) är 500 skrivningar × 375 Hz i tystnad, och localBpm=0
      // gjorde återinlåsningen dyrare än den behövde vara (olåst stride = 100 Hz).
      // Nu: en gång på flanken. Tempot BEHÅLLS som startgissning (låst stride ⇒
      // billigt, och de flesta tystnader är en paus i samma låt), tempogrammet
      // halveras i stället för att nollas, konfidensen nollas så beat-effekter inte
      // fortsätter i fantom-takt. Full släppning först efter 10 s tystnad — då är
      // det en ny låt/nytt set och historiken är värdelös.
      if (this.silentMs > 350 && !this.silenceArmed) {   // TEMPO_HOLD: laset ror inte, berakningen vilar
        this.silenceArmed = true; this.holdSilent = true;
        if (this.role === 'fast') this.flagSlow(F_SIL350);
      } else if (this.silentMs > 350 && !this.silenceArmed) {
        if (BPM_TRACE) console.log(`[bpmrst] t=${this.traceT().toFixed(1)} SILENCE bpm=${this.localBpm}`);
        this.silenceArmed = true;
        this.localBpmConfidence = 0;
        this.clearLockVotes();
        this.envFilled = 0; this.beatAnchorMs = 0; if (SIL_CLEAR_PENDING) this.pendingKickMs = 0; this.beatPhaseMs = 0; this.beatPhaseConf = 0; this.phaseLastBeatMs = 0; this.phaseAnti = 0;   // sektionerna nollas INTE har (350 ms-flanken = paus i samma lat; egen 10 s-regel i sectionHop) this.pendingKickMs = 0;
        this.bpmHistLen = 0; this.bpmHistPos = 0; this.lastVoteMs = 0;
        for (let i = 0; i < this.tempoGram.length; i++) this.tempoGram[i] *= 0.5;
        this.envBassAccum = 0;
        if (HIGH_ON) this.envHighAccum = 0;
        this.flagSlow(F_SIL350);
      } else if (this.silenceArmed && this.silentMs > 10000 && this.localBpm !== 0) {
        this.localBpm = 0;
        this.tempoGram.fill(0);
        this.flagSlow(F_SIL10);
      }
    } else {
      this.silentMs = 0;
      this.silenceArmed = false;
      if (this.holdSilent && this.localBpm > 0) this.holdGrace = Analyser.ENV_LEN;
      this.holdSilent = false;
    }
  }

  /** Ett onset-envelope-sampel (ENV_HZ): dubbelslagsdampning, ringar, basgang, sektionsflush/record till workern. */
  private envSampleStep(): void {
      this.envAccumT -= 1000 / Analyser.ENV_HZ;
      // DUBBELSLAG: tva anslag narmare an REFRAC_N sampel ar SAMMA handelse.
      // Anvandarens regel: "om det ar mindre an X ms mellan slag ar det ett
      // dubbelslag och 1a ska raknas till bpm". Implementerad som icke-max-
      // undertryckning (standard onset-peakplockning): ett sampel som foregas av
      // ett STORRE inom fonstret dampas bort.
      // 200 ms (20 sampel @ ENV_HZ 100) UPPMATT som optimum pa 110 ljudklipp
      // ur tva genrer: unika latar ratt 13/18 -> 15/18, snitt 89.7 -> 91.7 %.
      //   100 ms 13/18 · 150 ms 15/18 (90.8) · 200 ms 15/18 (91.7) · 250 ms 12/18
      //   300 ms 14/18 · 400 ms 13/18
      // Att 200 slar 300 ar logiskt: vid 150 BPM ar en attondel exakt 200 ms, sa
      // ett bredare fonster borjar ata genuina attondelar i stallet for prydnadsslag.
      // Loste dessutom syntetscenariot "svag bas + pad 132" som legat pa 0 % sedan
      // lange -- just utsmetade anslag ar dar dubbelslagen gor mest skada.
      let _e = this.envAccum;
      const _R = Analyser.REFRAC_N;
      if (_R > 0 && _e > 0) {
        let _big = false;
        for (let _k = 1; _k <= _R; _k++) {
          const _i = (this.envPos - _k + Analyser.ENV_LEN * 2) % Analyser.ENV_LEN;
          if (this.envRing[_i] >= _e) { _big = true; break; }
        }
        if (_big) _e *= Analyser.REFRAC_ATT;
      }
      const _b = this.envBassAccum, _h = this.envHighAccum;
      this.envRing[this.envPos] = _e;
      this.envBassRing[this.envPos] = _b;
      if (this.bigOn) { this.bigEnvFlag = 1; this.bigEnvBpm = this.localBpm; } else { this.dBpm = this.localBpm; this.stepBassline(); }
      if (HIGH_ON) this.envHighRing[this.envPos] = _h;
      this.envPos = (this.envPos + 1) % Analyser.ENV_LEN;
      this.envFilled = Math.min(this.envFilled + 1, Analyser.ENV_LEN);
      this.envAccum = 0;
      this.envBassAccum = 0;
      if (HIGH_ON) this.envHighAccum = 0;
      // Sektionens blocksummor levereras per ENV-SAMPEL i bada rollerna (SECTION_AGG 'env': samma kodvag -> delad och odelad
      // analysator ar bit-identiska). SECTION_AGG 'hop': odelad analysator kor sectionHop per hop sist i process().
      if (this.role === 'fast') { this.pushSlowRecord(_e, _b, _h); } else { this.envStep(); if (!SECTION_AGG_HOP) this.sectionFlushAgg(); }
  }

  /** Forfinar forra kickens fas (parabel). Returnerar kickAtMs (i hKickAt). */
  private kickRefine(): void {
    const kickFlux = this.hKickFlux, hopMs = this.hHopMs;
    let kickAtMs = 0;
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
      // (EN ETTA, klocka r0: analysatorns kick-taktfas (barAcc) är borta - frame.barShift = klockans taktmodell, se analyserClock publishPhase.)
    this.hKickAt = kickAtMs;
  }

  /** Sektionsenergi 0..1 (aktiv tid, EMA, sjalvkalibrerande golv och spann). Returnerar intensity. */
  private intensityStep(): void {
    const dtHop = this.dtHop;
    // SEKTIONSENERGI (0..1) — hur energiskt partiet är RELATIVT låtens eget snitt.
    // Ren analys av nivån över tid → hör hemma här, inte i show-orkestreringen.
    // En komprimerad signal ligger jämnt högt, så absolut nivå säger inget; jämför
    // mot en robust baslinje (P50-median, ej EMA-medel som pinnas upp av loud
    // sections). Mitten = snittet, tydligt över = drop/topp, under = breakdown.
    // Attack något snabbare än release så uppbyggnader syns. WARMUP: baslinjen
    // konvergerar snabbt (~3s) de första 8s aktiv musik, sen stabil ~25s.
    // Nollställs vid tystnad → snabb omkalibrering vid låtbyte.
    if (this.hGated) this.activeMs += dtHop * 1000;
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
    else this.intensityFloor += (this.intensityEma > this.intensityFloor ? 1 : this.intensityEma < this.intensityFloor ? -1 : 0) * floorRate * (this.intensityFloor + 0.05);
    // SJALVKALIBRERANDE SKALA: den fasta namnaren 0.30 var en GISSNING om hur
    // stor dynamiken ar. Mat den i stallet — ett glidande medelavvikelse-matt
    // (MAD) over avvikelsen fran golvet. Da nyttjar intensity hela 0..1 oavsett
    // om baren spelar dynamisk rock eller platt komprimerad house. +-2 MAD
    // spanner hela skalan; minsta 0.015 hindrar att tyst brus blir blaser upp.
    const dev = this.intensityEma - this.intensityFloor;
    this.intensitySpread += (Math.abs(dev) - this.intensitySpread) * (iWarm ? dtHop / 3 : dtHop / 60);
    const scale = Math.max(0.015, this.intensitySpread) * 4;
    const intensity = Math.max(0, Math.min(1, 0.5 + dev / scale));
    this.hIntensity = intensity;
  }

  /** SNABBA BANDEN (FAST_BANDS, se fältet): varje hop, till fb*-uppsättningen. Samma nivå/AGC/onset-räkning som 2048-vägens bandloop
   *  i bigStep, med tidskonstanterna per hop i stället för per stor-FFT (nivå 90 ms, peak-decay 0,9993, onset-steg 0,002, uppvärmning
   *  ONSET_WARM x BIG_EVERY hop). */
  private fastBandStep(samples: Float32Array): void {
    const gated = this.hGated;
    if (gated) this.fbWarm++; else this.fbWarm = 0;
    const warm = gated && this.fbWarm >= Analyser.ONSET_WARM * Analyser.BIG_EVERY;
    const C = this.fbCoef, S = this.fbState, n = samples.length;
    for (let b = 0; b < 8; b++) {
      let avg: number, fluxN: number;
      if (b < 3) {   // biquad HP + LP i följd, effekten per hop, utjämnad; amplitud = rot ur effekten, skalad till ett bandmedel
        const o1 = b * 10, o2 = o1 + 5, s1 = b * 8, s2 = s1 + 4;
        let x1 = S[s1], x2 = S[s1 + 1], y1 = S[s1 + 2], y2 = S[s1 + 3], u1 = S[s2], u2 = S[s2 + 1], v1 = S[s2 + 2], v2 = S[s2 + 3], pw = 0;
        // Koefficienterna i lokala konstanter (a7): tio typade läsningar per sampel bort, samma tal i samma uttryck.
        const a0 = C[o1], a1 = C[o1 + 1], a2 = C[o1 + 2], a3 = C[o1 + 3], a4 = C[o1 + 4];
        const c0 = C[o2], c1 = C[o2 + 1], c2 = C[o2 + 2], c3 = C[o2 + 3], c4 = C[o2 + 4];
        for (let i = 0; i < n; i++) {
          const x = samples[i];
          const y = a0 * x + a1 * x1 + a2 * x2 - a3 * y1 - a4 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y;
          const v = c0 * y + c1 * u1 + c2 * u2 - c3 * v1 - c4 * v2; u2 = u1; u1 = y; v2 = v1; v1 = v;
          pw += v * v;
        }
        S[s1] = x1; S[s1 + 1] = x2; S[s1 + 2] = y1; S[s1 + 3] = y2; S[s2] = u1; S[s2 + 1] = u2; S[s2 + 2] = v1; S[s2 + 3] = v2;
        this.fbPow[b] += (pw / n - this.fbPow[b]) * this.fbA[b];
        avg = Math.sqrt(this.fbPow[b]) * Analyser.FB_K[b];
        const d = avg - this.fbPrevAmp[b]; fluxN = d > 0 ? d : 0; this.fbPrevAmp[b] = avg;
      } else {       // 512-FFT:ns binnar (fbMag fylls i process()), flux mot förra hoppet
        const lo = this.fbLo[b], hi = this.fbHi[b], m = this.fbMag, pm = this.fbPrevMag;
        let sum = 0, fl = 0;
        for (let i = lo; i < hi; i++) { const v = m[i]; sum += v; const d = v - pm[i]; if (d > 0) fl += d; }
        const nb = hi - lo;
        avg = sum / nb * Analyser.FB_K[b]; fluxN = fl / nb * Analyser.FB_K[b];
      }
      this.fbAbs[b] = avg;
      if (b >= 3) this.fbDbRaw[b] = 20 * Math.log10(avg + 1e-7);   // bara band 3-7 läses (midHiDb)
      const minPeak = this.lvlSmooth * 0.15;
      if (gated && avg > this.fbPeak[b]) this.fbPeak[b] = Math.max(avg, minPeak);
      else this.fbPeak[b] = Math.max(this.fbPeak[b] * 0.9993, minPeak);
      const lvlRawB = gated ? Math.min(1, avg / (this.fbPeak[b] + 1e-6)) : 0;
      this.fbLvl[b] += (lvlRawB - this.fbLvl[b]) * this.fbAlvl;
      const oStep = 0.002;
      const dOMed = fluxN - this.fbOnMed[b];
      this.fbOnMed[b] += (dOMed > 0 ? 1 : dOMed < 0 ? -1 : 0) * oStep * (this.fbOnMed[b] + 0.01);
      const dOMad = Math.abs(fluxN - this.fbOnMed[b]) - this.fbOnMad[b];
      this.fbOnMad[b] += (dOMad > 0 ? 1 : dOMad < 0 ? -1 : 0) * oStep * (this.fbOnMad[b] + 0.01);
      if (this.fbOnMed[b] < 0) this.fbOnMed[b] = 0;
      if (this.fbOnMad[b] < 0) this.fbOnMad[b] = 0;
      const oThr = this.fbOnMed[b] + Analyser.ONSET_K * this.fbOnMad[b];
      this.fbOn[b] = warm ? Math.max(0, Math.min(1, (fluxN - oThr) / Math.max(1e-6, this.fbOnMad[b] * 3))) : 0;
    }
    { const t = this.fbPrevMag; this.fbPrevMag = this.fbMag; this.fbMag = t; }
  }

  /** Decimerad stor-FFT (var BIG_EVERY:e hop): 2048-magnitud, latminnets spec-sink, basonset-envelope, 8 band (niva/AGC/onset) + swap. */
  private bigStep(): void {
    this.bigCounter = 0;
    { const buf = this.bufferBig, w = this.windowBig, out = this.windowedBig, B = buf.length, p = this.bigPos, n1 = B - p;
      for (let i = 0; i < n1; i++) out[i] = buf[p + i] * w[i];
      for (let i = n1; i < B; i++) out[i] = buf[i - n1] * w[i]; }
    this.fftBig.realTransform(this.specBig, this.windowedBig);
    // Bara upp till högsta bin som någon läser (band 8 slutar vid 16 kHz ≈ bin 683,
    // låtminnet slutar vid 5 kHz ≈ bin 218). Resterande ~340 sqrt per stor-FFT hade
    // ingen läsare.
    // Hissade referenser: JIT:en slipper verifiera this-formen per varv och kan
    // hålla pekarna i register. Samma aritmetik, samma utfall.
    const specBig = this.specBig, magBig = this.magBig, magMax = this.magBigMax;
    for (let i = 0; i < magMax; i++) {
      const re = specBig[2 * i], im = specBig[2 * i + 1];
      magBig[i] = Math.sqrt(re * re + im * im);
    }

    // LÅTMINNET får samma magnitud (ingen extra FFT). Anropas före swap:en nedan,
    // så bufferten faktiskt innehåller DENNA frames spektrum. Skickas som cachad vy
    // (0..magBigMax) — svansen räknas inte, så ingen läsare kan tyst få nollor.
    if (this.bigOn) { const k = ++this.specN, R = this.specRing!, o = (k % SPEC_SLOTS) * SPEC_MAX; R.set(this.magBigView.subarray(0, this.specCopy.length), o); }
    else this.specSink?.(this.magBigView, this.cfg.audio.rate / this.bufferBig.length);
    const gated = this.activeMs > 0;   // brusgrinden ur snabba sidan (B_ACTIVE) - workerns cfg-kopia läses inte

    // Signal i rad? Räknaren driver ONSET_WARM ovan.

    if (gated) this.onsetWarm++; else this.onsetWarm = 0;

    // Samma hissning som magnitud-loopen: pekarna ut ur this före det inre varvet.
    const bandLo = this.bandLo, bandHi = this.bandHi;
    const prevMagBig = this.prevMagBig;
    if (!SECTION_AGG_HOP) {   // a3r: bara SECTION_AGG 'env' laser basonset-ringen (g.bon/g.bpk); i 'hop' (DMX) var den dod - 11 log10 per stor-FFT
      // BASONSET-ENVELOPE (09-23, sektionssardrag): som librosa onset_strength(fmax 220): medel over basbinen (20-250 Hz) av
      // halvvagslikriktad dB-skillnad mot forra stor-FFT:n. Toppplockning som onset_detect (pre_max/avg/post_avg/wait/delta) pa
      // 8 ms-raster med 100 ms fordrojning (post_avg) - toppen raknas i det block som pagar, sa fordrojningen ar harmlos.
      const lo = bandLo[0], hi = bandHi[2]; let o = 0;
      for (let i = lo; i < hi; i++) { const d = 20 * Math.log10((magBig[i] + 1e-6) / (prevMagBig[i] + 1e-6)); if (d > 0) o += d; }
      o /= Math.max(1, hi - lo);
      const L = Analyser.BASSON_LEN, R = this.bassOnRing, n = this.bassOnN, A = Analyser.BASSON_AVG;
      R[n % L] = o; this.bassOnN = n + 1;
      // kandidat c = n - A (100 ms bakat): lokalt max over [c - pre_max, c], >= medel over [c - A, c + A] + delta, wait sedan forra toppen
      if (n >= 2 * A) {
        const c = n - A; const xc = R[c % L]; let ok = true;
        for (let k = 1; k <= Analyser.BASSON_MAX && ok; k++) if (R[(c - k) % L] > xc) ok = false;
        if (ok) { let s = 0; for (let k = c - A; k <= n; k++) s += R[k % L]; if (xc < s / (2 * A + 1) + Analyser.BASSON_DELTA) ok = false; }
        if (ok && c - this.bassOnLastPk > Analyser.BASSON_WAIT) { this.bassOnLastPk = c; this.bassOnPeak = true; }
      }
    }
    for (let b = 0; b < 8; b++) {
      const lo = bandLo[b], hi = bandHi[b];
      const nb = Math.max(1, hi - lo);
      let sum = 0, fl = 0;
      for (let i = lo; i < hi; i++) {
        const m = magBig[i];
        sum += m;
        const d = m - prevMagBig[i];
        if (d > 0) fl += d;
      }
      const avg = sum / nb;
      // Lotus-adaptern använder rå bandmagnitud som spektral andel för ljuset.
      // Den får inte ersättas av bandLvl, som är per-band AGC-normaliserad.
      this.bandAbs[b] = avg;
      // Obehandlad nivå i dB, normaliserad till 0..1 över ett 60 dB-spann.
      // Ingen AGC, inget tak som följer med uppåt → en stigning syns som stigning.
      const db = 20 * Math.log10(avg + 1e-7);
      this.bandDbRaw[b] = db;   // RA dB (drop-kropp)
      this.secSpecDirty = true;
      this.bandDb[b] = Math.max(0, Math.min(1, (db + 70) / 60));
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
      // EN array, inte tva. `bandLvlSm` hade exakt en lasare — kopieringen till
      // `bandLvl` — sa tva Float32Array(8) bar identiska varden hela tiden.
      this.bandLvl[b] += (lvlRawB - this.bandLvl[b]) * this.aBandLvl;
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
      const dOMed = fluxN - this.onsetMed[b];
      this.onsetMed[b] += (dOMed > 0 ? 1 : dOMed < 0 ? -1 : 0) * oStep * (this.onsetMed[b] + 0.01);
      const dOMad = Math.abs(fluxN - this.onsetMed[b]) - this.onsetMad[b];
      this.onsetMad[b] += (dOMad > 0 ? 1 : dOMad < 0 ? -1 : 0) * oStep * (this.onsetMad[b] + 0.01);
      // Samma klamp som kick-spåraren ovan, av samma skäl: -0.01 är en dödsfälla.
      // Här blir följden att ALLA åtta band låser på bandOn = 1 konstant.
      if (this.onsetMed[b] < 0) this.onsetMed[b] = 0;
      if (this.onsetMad[b] < 0) this.onsetMad[b] = 0;
      const oThr = this.onsetMed[b] + Analyser.ONSET_K * this.onsetMad[b];
      // Skala mot MAD i stallet for en fast faktor -> sjalvskalande per band.
      // UPPVÄRMNING — ANNARS BLIXTRAR ALLA ÅTTA BAND TILL 1,0 EFTER VARJE TYSTNAD.
      // Nämnaren är MAD, och MAD sjunker mot noll under tystnad (τ ≈ 1,3 s). När
      // musiken kommer tillbaka slår `gated` om i samma ögonblick, nämnaren står
      // på golvet 1e-6, och varje positivt flux klampar till 1 — i ~1,5 s, i alla
      // band samtidigt. Alltså en fullskalig ljussmäll vid varje låtgräns med paus.
      // Vi väntar in MAD i stället för att gissa en amplitudtröskel: räknaren mäter
      // exakt den uppbyggnadstid nämnaren behöver.
      this.bandOn[b] = (gated && this.onsetWarm >= Analyser.ONSET_WARM)
        ? Math.max(0, Math.min(1, (fluxN - oThr) / Math.max(1e-6, this.onsetMad[b] * 3)))
        : 0;
    }
    { const t = this.prevMagBig; this.prevMagBig = this.magBig; this.magBig = t;
      const v = this.prevMagBigView; this.prevMagBigView = this.magBigView; this.magBigView = v; }
  }

  /** Drop-detektionen (baskropp, franvaro, stigning, armering, minidrop, lugn-grind, kick-las, fyrning). Manga kalla grenar: egen funktion sa att en deopt bara kostar den har, inte hetslingan. */
  private dropStep(): void {
    const nowWallA = this.hNowWall, bodyNow = this.hBody;
    const dtHop = this.dtHop;
    this.bodyEnv += (bodyNow - this.bodyEnv) * Math.min(1, dtHop / 0.35);
    this.bodyFast += (bodyNow - this.bodyFast) * Math.min(1, dtHop / BODY_FAST_S);
    const bodyPeek = this.bodyFast;   // (DROP_PEEK forkastad 09-08: ra-min oppnade falska klassen)   // 0.06 testat men gav falsklarm live utan att fixa beat-lagget (det sitter i lamp-vagen/energin, inte har)
    // TAKET SJUNKER I dB PER SEKUND, inte i procent. Kroppen ar nu ett dB-tal
    // (negativt), och "1,5 % av ett negativt tal" gor taket STORRE, inte mindre —
    // den gamla raden var matematiskt omvand sa fort skalan blev logaritmisk.
    this.bodyCeil = Math.max(this.bodyEnv, this.bodyCeil - dtHop * BODY_CEIL_DB_S);
    this.bodyPeak = Math.max(this.bodyEnv, this.bodyPeak - dtHop * 0.04);   // ~0.04 dB/s ≈ haller loud-referensen i minuter
    const flank = this.flankStep(nowWallA, dtHop);   // EN DROPDETEKTOR: flanken på samma filter (se FLANK_GONE_DB)
    this.liftStep(nowWallA, dtHop, bodyNow);

    // BAS-FRÅNVARO med VARAKTIGHETSKRAV: under 40 % av taket i ≥2 s i sträck.
    // FRANVARO = ETT AVSTAND I dB, inte en kvot. En kvot mellan tva logaritmer
    // betyder ingenting fysiskt.
    if (this.bodyEnv < this.bodyCeil - BODY_GONE_DB) {
      this.bodyGoneMs += dtHop * 1000;
      // BODY_GONE_MIN_MS: hur LÄNGE kroppen måste ha varit borta för att räknas
      // som en riktig breakdown. En 2s sidechain-dipp i en megamix är inte en
      // drop-förberedelse; en riktig breakdown varar flera sekunder. Env-tunbar
      // så den kan svepas mot referens offline.
      if (this.bodyGoneMs >= BODY_GONE_MIN_MS) {
        if (this.bodyGoneMs - dtHop * 1000 < BODY_GONE_MIN_MS) this.goneEpisodeMs = nowWallA;   // NY episod (korsningen), oforandrad tills nasta
        this.lastBodyGoneMs = nowWallA;
      }
    } else {
      if (Analyser.BODY_HIGH_MS > 0 && this.bodyGoneMs >= Analyser.BODY_HIGH_MS) this.secBodyArmMs = nowWallA;
      if (this.bodyGoneMs > 0) this.lastGoneSpanMs = this.bodyGoneMs; this.bodyGoneMs = 0;
      if (this.secBodyArmMs > 0) { if (nowWallA - this.secBodyArmMs > 2000) this.secBodyArmMs = 0; else if (this.bodyEnv >= this.bodyPeak - Analyser.BODY_HIGH_DB) { this.secBodyRet++; this.secBodyArmMs = 0; } }
    }
    // STIGNINGSTAKT över 0.5 s (ringbuffert, ingen allokering).
    const hist = this.bodyHist, HL = hist.length;
    const oldest = hist[(this.bodyHistPos + HL - this.bodyHistLen) % HL];
    let riseRef = oldest;
    // MINIMUM UTAN MODULO (a7): fönstret pos-1 .. pos-len läses som högst två raka bitar (var en heltalsdivision per varv,
    // ~188 varv per hop). Samma mängd värden -> samma minimum.
    { const pos = this.bodyHistPos, len = this.bodyHistLen; let mn = oldest;
      const n1 = len < pos ? len : pos;   // pos-1 .. pos-n1
      for (let j = pos - n1; j < pos; j++) { const v = hist[j]; if (v < mn) mn = v; }
      for (let j = HL - (len - n1); j < HL; j++) { const v = hist[j]; if (v < mn) mn = v; }   // resten från slutet
      riseRef = mn; }
    let bodyRise = bodyPeek - riseRef;   // let: CALMLAND/KICKLOCK bar kandidatens lyft vidare till fyrningen
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
    // MÅSTE LANDA HÖGT, inte bara stiga. bodyRise är i dB, så en liten uppgång från
    // nära-tystnad (en djup breakdown) ger ett STORT dB-lyft trots att den landar på
    // en fortfarande LÅG nivå → falsk drop "där energin knappt gått upp" (ägaren i
    // ladan 2026-09-03). Kräv att kroppen landar inom BODY_PEAK_DB av den senaste
    // toppen (bodyCeil) — en riktig drop når nästan sitt eget tak; en uppgång i ett
    // tyst parti gör det inte.
    // Mot SEGA toppen (bodyPeak), inte snabba taket: en falsk drop i ett tyst parti
    // landar lagt (fast ~10) medan riktiga landar hogt (fast ~34+); den sega toppen
    // haller loud-referensen (~44) sa den laga landningen avvisas aven om taket tillf. sjunkit.
    const landsHigh = bodyPeek > this.bodyPeak - BODY_PEAK_DB;
    const riseOk = bodyRise > BODY_RISE_DB || (DROP_RISE_LOW_DB > 0 && bodyRise > DROP_RISE_LOW_DB && this.bodyPeak - bodyPeek < DROP_RISE_LOW_Q);
    const bodyOnset = riseOk && landsHigh && nowWallA - this.lastBodyGoneMs < 6000;
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
    // REFRAKTAR = 32 taktslag (8 takter). MATT: verkliga drop-avstand 8-40 takter.
    // TESTAT 2026-09-02 att korta till 16: F1 45 -> 33, +50 falsklarm (modern-spar
    // fyrar flera ggr per drop utan spärren). "Kroppen-var-borta"-kravet racker INTE
    // som ensamt skydd → spärren behalls. En falsk drop som lasar ute en riktig loses
    // med BATTRE PRECISION eller energi-gasen, inte med kortare spärr.
    // DROP-REFRAKTÄR 4 s (ägaren i ladan 2026-09-03: vill ha tätare lamp-drops).
    // Var 32 taktslag (~15 s). Röken översprutar INTE av detta — den har egen
    // cooldown (fog.cooldownMs = 30 s) som gatar den oberoende av lampornas drop.
    // OBS: kortare spärr → fler drops (och fler falska); medvetet val, agaren dömer
    // live. testDrops-F1 sjunker (spärren gjorde jobb där) men det är sekundärt här.
    // ESKALERINGS-REFRAKTÄR (ägaren i ladan 2026-09-03, mot falska drops): en drop
    // strax efter en annan får BARA fyra om den är TYDLIGT STARKARE (större bas-lyft)
    // än den förra — annars måste 20 s gå. Riktiga drops eskalerar (varje större);
    // falska är svagare upprepningar och sållas bort. En eskalerande drop (kvällens
    // stora ögonblick) släpps ändå igenom direkt (ned till 4 s).
    const sinceDrop = nowWallA - this.lastDropMs;
    const stronger = bodyRise > this.lastDropRise + DROP_ESCALATE_DB;
    const dropSpacingOk = sinceDrop > DROP_LONG_MS || (sinceDrop > DROP_SHORT_MS && stronger);   // (DROP_UPGRADE_DB matt 09-12, av: risk for dubbelsmall)
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
    // STIGANDE FLANK: `bodyOnset` är sann KONTINUERLIGT i höga/pumpande partier (basen
    // dippar och återhämtar ~17 dB varje takt via sidechain → bodyRise ligger konstant
    // över tröskeln). MÄTT 2026-09-03: många kandidater/sekund. Fyra bara på den FÖRSTA
    // framen lyftet passerar tröskeln → ett kandidat-event per verkligt lyft, inte per
    // frame. Då blir eskalerings-/spärr-kravet meningsfullt (jämför distinkta lyft).
    const bodyOnsetEdge = bodyOnset && !this.wasBodyOnset;
    this.wasBodyOnset = bodyOnset;
    // Armera bara EN gang per "borta"-episod. Floden vid ARM=300 (36 mot 19 pa referens) kom fran
    // UPPREPADE aterhamtnings-edges i samma post-breakdown-fonster. Forsta edgen efter en ny
    // gone-episod armerar (fangar en mjuk drops fordrojda topp); senare edges far bara ogonblicket.
    if (bodyOnsetEdge && this.goneEpisodeMs !== this.dropArmGoneMs) { this.dropArmUntil = nowWallA + DROP_ARM_MS; this.dropArmAt = nowWallA; this.dropArmGoneMs = this.goneEpisodeMs; }
    const armed = bodyOnsetEdge || nowWallA < this.dropArmUntil;
    // (KICK-FIRST forkastad 09-04: flod pa megamix; [firstkick]-sparet borttaget 09-27.)
    // MINIDROP-lyftet (se MINI_*). Egen svacka-raknare (kortare/grundare an gone) och egen flank.
    if (MINI_SPACING_MS > 0) {
      if (this.bodyEnv < this.bodyCeil - MINI_GONE_DB) { this.miniGoneMs += dtHop * 1000; if (this.miniGoneMs >= MINI_GONE_MS) this.lastMiniGoneMs = nowWallA; }
      else this.miniGoneMs = 0;
      // Samma fönster som riseRef plus det nyss skrivna värdet (minus inget: den äldsta platsen ingår via `oldest`) -> en jämförelse
      // i stället för en andra genomläsning (a7).
      const nv = hist[(this.bodyHistPos + HL - 1) % HL]; const mnRef = nv < riseRef ? nv : riseRef;
      const miniOnset = (bodyPeek - mnRef) > MINI_RISE_DB && bodyPeek > this.bodyPeak - MINI_PEAK_DB && nowWallA - this.lastMiniGoneMs < 4000;
      const miniEdge = miniOnset && !this.wasMiniOnset; this.wasMiniOnset = miniOnset;
      if (miniEdge && this.activeMs > 2000 && nowWallA - this.lastDropMs > MINI_SPACING_MS && nowWallA - this.lastMiniMs > MINI_SPACING_MS
          && (DROP_UNDERPEAK_MIN <= 0 || this.bodyPeak - bodyPeek >= DROP_UNDERPEAK_MIN)) {   // INTE I TAKET galler aven minidrops (19:19: 'falsk' = minidrop med underPeak 0,6)
        this.miniDropCount++; this.lastMiniMs = nowWallA;
        if (DROP_TRACE) console.log(`[minidrop] wall ${this.wallNow()} rise ${(bodyPeek - mnRef).toFixed(1)} underPeak ${(this.bodyPeak - bodyPeek).toFixed(1)} goneAgo ${((nowWallA - this.lastMiniGoneMs)/1000).toFixed(1)}s`);
      }
    }
    const fullSlam = this.bodyPeak - bodyPeek < DROP_QUALITY_DB;
    // DMX_DROP_TRACE=1: logga KONSUMERADE edges (kandidat som INTE fyrade) — var ligger kroppen vid
    // forsta takten? Matdata for DROP_QUALITY_DB pa mjukare material (pop) dar inget referens finns.
    if (DROP_TRACE && bodyOnsetEdge && !(dropSpacingOk && fullSlam)) console.log(`[dropedge] rise ${bodyRise.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s spacingOk ${dropSpacingOk} sinceDrop ${(sinceDrop/1000).toFixed(1)}s`);
    // INTE I TAKET (opt-in DROP_UNDERPEAK_MIN, ladan 2026-09-29): en drop som fyrar nar kroppen redan ligger vid sin topp (underPeak
    // 0,4/0,8 dB) ar en upprepning av samma small, inte en ny - agarens markeringar: ratta 2,4-6,5 dB, falska 0,4/0,8/2,9. 0 = av.
    const notAtCeil = DROP_UNDERPEAK_MIN <= 0 || this.bodyPeak - this.bodyFast >= DROP_UNDERPEAK_MIN;
    let fireNow = dropSpacingOk && armed && this.activeMs > 2000 && fullSlam && notAtCeil;
    let fireTag = '';
    const underNow = this.bodyPeak - bodyPeek;
    // LUGN-SEKTIONS-GRINDEN (se DROP_CALM_GATE). Domen tas per kandidat-hop; den hallna kandidaten (DROP_CALM_LAND_MS) foljs nedan.
    if (fireNow) {
      const calm = (this.dSec === 'low' || this.dSec === 'intro') || this.dLvh <= -DROP_CALM_DB;
      let strong = this.buildUp >= DROP_CALM_BUILD || underNow < DROP_CALM_Q || bodyRise >= BODY_RISE_DB + DROP_CALM_RISE_DB;
      // STRIKT INTRO (ladan 09-24: 'den gjorde fortfarande drop i intro'): landning vid toppen racker inte i intro - bara en riktig riser.
      if (this.dSec === 'intro') strong = this.buildUp >= DROP_CALM_BUILD;
      if (calm && !strong) {
        fireNow = false;
        if (DROP_CALM_LAND_MS > 0 && this.calmHoldStart === 0) { this.calmHoldStart = nowWallA; this.calmHoldRise = bodyRise; }
        if (DROP_TRACE && bodyOnsetEdge) console.log(`[dropcalm] wall ${this.wallNow()} ${DROP_CALM_LAND_MS > 0 ? 'HALLS' : 'NEKAD'} sect ${this.dSec} lvh ${this.dLvh.toFixed(1)} build ${this.buildUp.toFixed(2)} underPeak ${underNow.toFixed(1)} rise ${bodyRise.toFixed(1)}`);
      }
    }
    if (this.calmHoldStart > 0) {   // verifierad landning: kroppen maste ligga kvar vid toppen hela DROP_CALM_LAND_MS
      if (!fullSlam) { if (DROP_TRACE) console.log(`[dropcalm] wall ${this.wallNow()} SLAPPT efter ${(nowWallA - this.calmHoldStart).toFixed(0)} ms (underPeak ${underNow.toFixed(1)})`); this.calmHoldStart = 0; }
      else if (fireNow) this.calmHoldStart = 0;   // fyrar anda (starkare bevis kom)
      else if (nowWallA - this.calmHoldStart >= DROP_CALM_LAND_MS && dropSpacingOk) { fireNow = true; fireTag = ` CALMLAND +${(nowWallA - this.calmHoldStart).toFixed(0)}ms`; bodyRise = Math.max(bodyRise, this.calmHoldRise); this.calmHoldStart = 0; }
    }
    // KICK-LASET (se DROP_KICK_LOCK_MS): kandidaten vantar in forsta kicken, hogst en halv takt / DROP_KICK_LOCK_MS.
    if (fireNow) {
      this.dropArmUntil = 0; this.calmHoldStart = 0;
      this.dropCand++; this.lastDropMs = nowWallA; this.lastDropRise = bodyRise;
      console.log(`[dropfire] wall ${this.wallNow()}${fireTag} rise ${bodyRise.toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} ceil ${this.bodyCeil.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} sinceDrop ${(sinceDrop/1000).toFixed(1)}s goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s goneSpan ${(this.lastGoneSpanMs/1000).toFixed(1)}s edgeAgo ${(nowWallA - this.dropArmAt).toFixed(0)}ms`);
    }
    this.dropClassify(flank, fireNow, nowWallA);
  }

  /** EN DROPDETEKTOR - klassningen (a3): flanken är full drop (efter spärren), slam-kandidaten utan egen flank inom 2 s är minidrop. */
  private dropClassify(flank: boolean, cand: boolean, nowWallA: number): void {
    if (flank) {
      if (nowWallA - this.lastShowDropMs < SHOW_DROP_GAP_MS) { this.dropSpaced++; this.miniDropCount++; }
      else { this.lastShowDropMs = nowWallA; this.dropCount++; }
    } else if (cand && nowWallA - this.fdAt > 2000) { this.dropDemoted++; this.miniDropCount++; }
  }

  /** FULL DROP PÅ FLANKEN (se FLANK_GONE_DB): på dropStep:s egna filter (bodyFast/bodyEnv/bodyCeil), per hop. */
  private flankStep(now: number, dt: number): boolean {
    const CAP = 1024, T = this.fdT, V = this.fdV, f = this.bodyFast, ceil = this.bodyCeil;
    if (this.fdN === CAP) { this.fdS0 = (this.fdS0 + 1) & (CAP - 1); this.fdN--; }
    { const w = (this.fdS0 + this.fdN) & (CAP - 1); T[w] = now; V[w] = f; this.fdN++; }
    while (this.fdN > 1 && now - T[this.fdS0] > FLANK_HOLD_S * 1000) { this.fdS0 = (this.fdS0 + 1) & (CAP - 1); this.fdN--; }
    let top = -1e9, low = 1e9; for (let q = 0; q < this.fdN; q++) { const i = (this.fdS0 + q) & (CAP - 1); if (V[i] > top) top = V[i]; if (now - T[i] <= 500 && V[i] < low) low = V[i]; }
    if (top < ceil - FLANK_GONE_DB) this.fdGone += dt; else { if (this.fdGone > 0) { this.fdSpan = this.fdGone; this.fdEnd = now; } this.fdGone = 0; }
    const above = f > ceil - FLANK_LAND_DB, edge = above && !this.fdAbove; this.fdAbove = above;
    const span = this.fdGone > 0 ? this.fdGone : now - this.fdEnd < FLANK_GRACE_S * 1000 ? this.fdSpan : 0;
    if (this.lvlSmooth <= FLANK_SILENT_LV) this.fdQuietAt = now;
    if (!edge || f - low < FLANK_RISE_DB || (span < FLANK_BREAK_S && !(span >= FLANK_SHORT_S && ceil - low >= FLANK_SHORT_RISE_DB))) return false;
    if (now - this.fdQuietAt < span * 1000 + 500) { this.fdGone = 0; this.fdSpan = 0; if (DROP_TRACE) console.log(`[flank] ingen drop: helt tyst i breaket (latstart), break ${span.toFixed(1)} s`); return false; }
    this.fdGone = 0; this.fdSpan = 0; this.fdAt = now; this.dropRiseDb = f - low;
    if (DROP_TRACE) console.log(`[flank] full drop pa flanken: break ${span.toFixed(1)} s, stigning ${(f - low).toFixed(1)} dB`);
    return true;
  }

  /** NÄSTAN-DROP, ENERGILYFT, STOPP (a3, förr effects.ts stepLifts): VAD + STYRKA ut i ramen; effekterna avgör reaktionen. */
  private liftStep(now: number, dt: number, body: number): void {
    const x = Math.max(-90, body);
    if (!this.nearOn) { this.nearOn = true; this.nearB = x; this.nearNorm = x; }
    this.nearB += (x - this.nearB) * Math.min(1, dt / 0.12);
    this.nearNorm += (this.nearB - this.nearNorm) * Math.min(1, dt / 8);
    const h = this.liftHist;
    if (now - this.liftHistAt >= 25) {   // 25 ms-rutor AV TID: 60 rutor = dippens botten (1,5 s), 240 = lugnet 6..2 s + lyftet 0,6 s
      this.liftHistAt = now; h[this.liftW] = this.nearB; this.liftW = (this.liftW + 1) % 240; if (this.liftN < 240) this.liftN++;
      const n = this.liftN, o0 = this.liftW - n + 240;
      let fl = 1e9; for (let q = Math.max(0, n - 60), j = (o0 + q) % 240; q < n; q++) { const v = h[j]; if (v < fl) fl = v; if (++j === 240) j = 0; }
      this.nearFloor = fl;
      if (n >= 240) {
        let sum = 0; for (let q = 0, j = o0 % 240; q < 160; q++) { sum += h[j]; if (++j === 240) j = 0; }
        let now6 = 0; for (let q = n - 24, j = (o0 + q) % 240; q < n; q++) { now6 += h[j]; if (++j === 240) j = 0; }
        this.liftCalm = sum / 160; this.liftLift = now6 / 24 - this.liftCalm;
      }
    }
    const floor = this.nearFloor, rise = this.nearB - floor, dip = this.nearNorm - floor;
    const near = rise >= NEAR_RISE_DB && dip >= NEAR_DIP_DB && floor > -80 && this.nearB >= this.nearNorm - 1;   // floor > -80: inspelningsavbrott
    this.nearDropDb = near ? rise : 0; this.nearDipDb = near ? dip : 0;
    this.liftDb = this.liftN >= 240 && this.liftCalm > -80 && this.liftLift >= LIFT_DB ? this.liftLift : 0;
    if (this.nearB < this.nearNorm - 12) this.stopRunS += dt;
    else if (this.nearB >= this.nearNorm - 1) {
      if (this.stopRunS >= STOP_MINI_S && this.stopRunS <= 3) { this.stopCount++; this.stopS = this.stopRunS; }
      this.stopRunS = 0;
    }
  }

  /** Uppbyggnad/riser (spektral novelty + klang/niva). Returnerar inRiser och uppdaterar buildUp. */
  private riserStep(): boolean {
    const nowWallA = this.hNowWall;
    const dtHop = this.dtHop;
    // ── UPPBYGGNAD / RISER (flyttad hit) ──
    // Spektral NOVELTY = summan av bandens POSITIVA avvikelse från en ~2s baslinje,
    // ihållande ~1.5s. Mätt validerad: ramsar 0.25→0.78 in i en drop. Relativt en
    // ~8s baslinje → RISER = novelty STIGER över den (filter-sweep/snare-roll),
    // skilt från bara-busy (ihållande → baslinjen kommer ikapp). Gammal väg
    // (klang+nivå stiger) ligger kvar som OR. Inte direkt efter en drop.
    let nov = 0; const sr = this.aSpecSlow;
    // NOVELTY PÅ `bandDb`, INTE `bandLvl` — se fältets dokumentation. Med den
    // AGC-normaliserade nivån var det här uttrycket matematiskt tvunget att gå
    // mot noll under exakt de förlopp det skulle upptäcka.
    for (let b = 0; b < 8; b++) { this.specSlow[b] += (this.bandDb[b] - this.specSlow[b]) * sr; nov += Math.max(0, this.bandDb[b] - this.specSlow[b]); }
    this.novSlow += (nov - this.novSlow) * this.aNovSlow;
    this.novBaseline += (this.novSlow - this.novBaseline) * (dtHop / 8);
    const novRiser = this.novSlow > this.novBaseline + 0.15 && this.novSlow > 0.45;
    this.centSlow += (this.centSmooth - this.centSlow) * (dtHop / 2.5);
    this.lvlSlowR += (this.lvlSmooth - this.lvlSlowR) * (dtHop / 2.5);
    const inRiser = this.activeMs > 2500 && this.lvlSmooth > 0.3 && nowWallA - this.lastDropMs > 1500 && (
        novRiser
        || (this.centSmooth > this.centSlow + 0.06 && this.lvlSmooth > this.lvlSlowR + 0.04 && this.lvlSmooth > 0.4)
      );
    // Stampla uppbyggnaden. OBS: drop-villkoret ovan kraver INTE en riser — det
    // kravet ar avstangt (se dar). Stampeln halls uppdaterad for att kravet ska
    // kunna aterinforas nu nar riser-signalen faktiskt lever (se `bandDb`).
    // Nagot "4000 ms-fonster" finns inte i filen; den formuleringen var kvar
    // fran en tidigare version av villkoret.
    const bTarget = inRiser ? 1 : 0;
    const bRate = bTarget > this.buildUp ? dtHop / 3.5 : dtHop / 1.0;   // bygg ~3.5s, klinga ~1s
    this.buildUp += Math.max(-bRate, Math.min(bRate, bTarget - this.buildUp));
    return inRiser;
  }

  /** Karaktarsprofilen (~8 s) → outProfile. */
  private profileStep(): void {
    // ── KARAKTÄRSPROFIL (~8s) — musikens KARAKTÄR, inte dess energinivå ──
    // Banden är redan per-band AGC:ade (0..1 var), så vi jobbar med RELATIONER:
    // hur stor del av ljudbilden som är låg-end resp. luft, och hur transientrikt
    // det är. Långsam (8s) → stabil nog att styra effektval utan att fladdra.
    let bSum = 1e-6; for (let b = 0; b < 8; b++) bSum += this.bandLvl[b];
    const bassW = (this.bandLvl[0] + this.bandLvl[1] + this.bandLvl[2]) / bSum;   // sub+kick+bas
    const brightW = (this.bandLvl[6] + this.bandLvl[7]) / bSum;                    // diskant+luft
    // punch drivs av den dedikerade kick-detektorn (renare transient än bandOn[1],
    // som ligger i 60–120 Hz och drunknar i rullande bas) plus snare/hat-anslag.
    const punchNow = Math.min(1, (this.kickHit + this.bandOn[5] + this.bandOn[6]) * 0.6);  // kick+snare+hat
    const pr = this.aProf;
    this.profPunch += (punchNow - this.profPunch) * pr;
    this.profBass += (bassW - this.profBass) * pr;
    this.profBright += (brightW - this.profBright) * pr;
    this.profBeat += (this.dConf - this.profBeat) * pr;
    // Skala råvärdena till användbara 0..1-spann (typiska musikvärden → full range).
    // Skalningen är KALIBRERAD mot uppmätta råvärden på riktig musik (annars
    // mättar punch på 1.00 och bright ligger konstant högt → ingen diskriminering).
    this.outProfile.punch = cl01((this.profPunch - 0.05) / 0.40);
    this.outProfile.bass = cl01((this.profBass - 0.28) / 0.30);
    this.outProfile.bright = cl01((this.profBright - 0.14) / 0.19);
    this.outProfile.beat = cl01(this.profBeat);
    this.outProfile.bassline = this.profBassline;
  }

  /** Sektionens blocksummor per hop (SECTION_AGG 'env': ackumulator; 'hop': sectionHop direkt / snabba sidans aggregat). */
  private sectionAggStep(): void {
    const intensity = this.hIntensity, kick = this.hKick, breaking = this.hBreaking, rms = this.hRms, fluxNorm = this.hFlux, nowWallA = this.hNowWall;
    const dtHop = this.dtHop;
      if (this.bigOn) return;   // stora vägen: aggregatet byggs i långsamma tråden (bigAgg)
      if (SECTION_AGG_HOP) {
        // Aldre vagen: bandens magnitud ur band-dB; odelad analysator kor sectionHop per hop, snabba sidan aggregerar.
        const sp = this.secSpecHop;   // bandDbRaw ändras bara i bigStep (var BIG_EVERY:e hop): potensen räknas om då, samma värden (a7/a8)
        if (this.secSpecDirty) { this.secSpecDirty = false; for (let i = 0; i < 8; i++) sp[i] = Math.pow(10, this.bandDbRaw[i] / 20); }
        if (this.role === 'fast') {
          const g = this.secAgg; g.n++; g.int += intensity; if (kick) g.kicks++; g.rms2 += rms * rms; g.cent += this.centSmooth; g.dt += this.dtHop * 1000;
          g.breaking = breaking ? 1 : 0; g.wall = this.wallNow(); g.drops = this.dropCand + this.secBodyRet; g.active = this.activeMs; g.build = this.buildUp;
          for (let i = 0; i < 8; i++) g.spec[i] += sp[i];
        } else { const I = this.shIn; I.hops = 1; I.intSum = intensity; I.kicks = kick ? 1 : 0; I.breaking = breaking; I.nowMs = this.wallNow(); I.dtMs = this.dtHop * 1000;
          I.rms2Sum = rms * rms; I.centSum = this.centSmooth; I.specOff = 0; I.bonSum = 0; I.bpk = 0; I.fluxSum = 0; I.rms4Sum = 0; this.sectionHop(sp); }
      } else {
        const g = this.secAgg; g.n++; g.int += intensity; if (kick) g.kicks++; if (breaking) g.breaking = 1; g.rms2 += rms * rms; g.cent += this.centSmooth; g.dt += dtHop * 1000; g.wall = nowWallA;
        for (let i = 0; i < 8; i++) g.spec[i] += this.bandAbs[i];
        g.bon += this.bassOnRing[(this.bassOnN - 1 + Analyser.BASSON_LEN) % Analyser.BASSON_LEN]; if (this.bassOnPeak) { g.bpk++; this.bassOnPeak = false; } g.flux += fluxNorm; g.rms4 += rms * rms * rms * rms;
      }
  }

  /** Muterar det ateranvanda Frame:t (spec/onset/drum + alla skalarer) och kor sektionsaggregatet. Bara skalarer in: ingen allokering per hop. */
  private fillFrame(): Frame {
    const level = this.hLevel, fluxNorm = this.hFlux, kick = this.hKick, intensity = this.hIntensity, bodyNow = this.hBody, inZone = this.hInZone, breaking = this.hBreaking,
      inRiser = this.hInRiser, kickAtMs = this.hKickAt, nowWallA = this.hNowWall;
    const FB = Analyser.FAST_BANDS, L = FB ? this.fbLvl : this.bandLvl, A = FB ? this.fbAbs : this.bandAbs, O = FB ? this.fbOn : this.bandOn;   // ljusfälten
    const spec = this.outSpec, specAbs = this.outSpecAbs, onset = this.outOnset;
    spec.sub = L[0]; spec.kick = L[1]; spec.bass = L[2]; spec.lowMid = L[3]; spec.mid = L[4]; spec.highMid = L[5]; spec.treble = L[6]; spec.air = L[7];
    specAbs.sub = A[0]; specAbs.kick = A[1]; specAbs.bass = A[2]; specAbs.lowMid = A[3]; specAbs.mid = A[4]; specAbs.highMid = A[5]; specAbs.treble = A[6]; specAbs.air = A[7];
    onset.sub = O[0]; onset.kick = O[1]; onset.bass = O[2]; onset.lowMid = O[3]; onset.mid = O[4]; onset.highMid = O[5]; onset.treble = O[6]; onset.air = O[7];
    const dr = this.outDrum;
    dr.kick = this.kickHit; dr.snare = this.snareHit; dr.hat = this.hatHit; dr.bass = L[2];

    // Mutera det återanvända Frame:t (spec/onset pekar redan på outSpec/outOnset).
    const f = this.outFrame;
    f.silent = this.lvlSmooth <= this.silenceLevel; f.level = this.lvlSmooth; f.levelRaw = level; f.levelVU = this.lvlVU;
    f.energy = this.engSmooth;
    f.centroid = this.centSmooth; f.flux = fluxNorm; f.kick = kick; f.gain = this.gain;
    f.bpm = this.localBpm; f.bpmConfidence = this.localBpmConfidence; f.intensity = intensity; f.beatAnchorMs = this.beatAnchorMs;
    f.bodyDb = bodyNow; { const be = this.bassEnergyStep(A[0], A[1]); f.bassEnergy = f.silent ? 0 : be; f.bassEnergyShort = f.silent ? 0 : this.beShort; f.bassLevel = Math.pow(10, (this.beHi - this.beRef) / 20); }
    {   // kickRise: basens dB mot KICK_RISE_HOPS hop sedan (ringen håller de senaste), halvvåg
      const db = 20 * Math.log10(A[0] + A[1] + 1e-7), old = this.kickRiseDb[this.kickRisePos];
      this.kickRiseDb[this.kickRisePos] = db; this.kickRisePos = (this.kickRisePos + 1) % Analyser.KICK_RISE_HOPS;
      f.kickRise = old !== 0 && db > old ? db - old : 0;
    }
    { let s2 = 1e-12; for (let b = 3; b < 8; b++) { const lin = Math.pow(10, (FB ? this.fbDbRaw : this.bandDbRaw)[b] / 20); s2 += lin * lin; } f.midHiDb = 20 * Math.log10(Math.sqrt(s2)); }
    f.dropCount = this.dropCount; f.miniDropCount = this.miniDropCount; f.dropDemoted = this.dropDemoted; f.dropSpaced = this.dropSpaced; f.dropRiseDb = this.dropRiseDb;
    f.nearDropDb = this.nearDropDb; f.nearDipDb = this.nearDipDb; f.liftDb = this.liftDb; f.stopCount = this.stopCount; f.stopS = this.stopS; f.inZone = inZone; f.breaking = breaking; f.buildUp = this.buildUp; f.inRiser = inRiser;
    f.kickAtMs = kickAtMs; f.barShift = -1;   // EN ETTA (r0): klockans etta sätts av publishPhase nedan (lotus); DMX läser ettan i cfg.beat
    // Gridfasen ut: konstant offset (detektorns slap) och/eller trim. Bada 0/av som standard => oforandrad fas.
    f.beatPhaseMs = this.beatPhaseMs > 0 ? this.beatPhaseMs - Analyser.GRID_PHASE_OFFSET_MS : this.beatPhaseMs;
    f.beatPhaseConf = this.beatPhaseConf;
    this.sectionAggStep();
    const nowS = SECTION_AGG_HOP ? this.wallNow() : nowWallA;
    f.section = this.section; f.sectionAgeMs = this.sectionStartMs > 0 ? nowS - this.sectionStartMs : 0; f.sectionIndex = this.sectionIndex; f.sectionTier = this.sectionTier;
    f.repeatSim = this.repeatSim; f.repeatAgoMs = this.repeatAgoMs; f.repeatSection = this.repeatSection;
    f.expectHighInMs = this.section === 'high' ? 0 : this.expectHighMs > 0 ? Math.max(0, this.expectHighMs - nowS) : -1;
    f.prevSection = this.prevSection; f.levelVsHighDb = this.levelVsHighDb;
    f.sectionBars = this.localBpm > 0 && this.sectionStartMs > 0 ? (nowS - this.sectionStartMs) / (240000 / this.localBpm) : 0;
    if (this.clock || this.hopSelf) {
      if (this.clock) this.clock.update(f, this.clockOut, this, Date.now());   // KLOCKAN I process() (BEAT_FEED 'inline', eller ingen delning)
      else this.hopLane!.feed(f, this.clockOut, this);                          // KLOCKAN I WORKERN (lotus delad: taktvägen, egen matning)
      // EN FAS OCH EN ETTA (r0): ramens fas och etta = klockans publicerade rutnät och taktmodell (publishPhase, analyserClock.ts)
      publishPhase(f, this.clockOut.beat, this.clock ? this.clock.barKnown() : this.hopLane!.barKnown, this.extGrid, Date.now(), Analyser.GRID_PHASE_OFFSET_MS);
    }
    return f;
  }
  /** ANALYSATORNS KLOCKA utan taktväg (a7r; lotus profil, eller DMX utan delning): körs sist i process(), utfallet här. */
  clock: BeatFeed | null = null;
  readonly clockOut: ClockCfg = { beat: undefined, beatErr: undefined };
  /** Klockans utfall till motorn (som hopLane.feed gör med taktvägen): rutnätet och fasfelet. */
  publishClock(cfg: ClockCfg): void { cfg.beat = this.clockOut.beat; cfg.beatErr = this.clockOut.beatErr; }
}

/** Asymmetrisk EMA (snabb attack, långsam release) — modulnivå så tick-vägen
 *  inte allokerar en closure per hop. */
function ema(prev: number, x: number, aUp: number, aDown: number): number {
  return prev + (x - prev) * (x > prev ? aUp : aDown);
}

/** alignScore:s toppvärde runt sampel i (max av i-1, i, i+1 i fönstret, golv 0) - modulnivå i st f closure per anrop (2026-10-17). */
function alignAt(ring: Float32Array, start: number, LEN: number, N: number, i: number): number {
  const c = ring[(start + i) % LEN]; const a = i > 0 ? ring[(start + i - 1) % LEN] : c; const b = i + 1 < N ? ring[(start + i + 1) % LEN] : c;
  const m = c > a ? (c > b ? c : b) : (a > b ? a : b);
  return m > 0 ? m : 0;
}

function cl01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// ── DELAD ANALYSATOR: fabriken ────────────────────────────────────────────────────────────────
/** Omstart av workern: backoff 1/2/5/5/5 s, hogst 5 omstarter per 10 min, sedan ges upp (snabba
 *  sidan fortsatter leverera ljus med senaste tillstandet i blocket; tempo/sektion fryser). */
export const WORKER_RESTART_BACKOFF_MS = [1000, 2000, 5000, 5000, 5000];
export const WORKER_RESTART_MAX = 5;
export const WORKER_RESTART_WINDOW_MS = 10 * 60_000;

/**
 * <prefix>ANALYSER_SPLIT (se split.ts):
 *   (osatt)   en analysator i en trad.
 *   worker    snabba delen har, langsamma (tempo/gridfas/sektion) i en worker_threads-Worker pa egen karna.
 *   inline    bada i SAMMA trad, workern kord synkront efter varje record — for banken: bevisar att den delade
 *             analysatorn ger identiskt resultat som den odelade (deterministiskt, virtuell klocka).
 *
 * Testkrokar pa den returnerade analysatorn (bara worker-laget): __worker (aktuell Worker), __stopWorker() (stanger
 * utan omstart), splitRestarts (antal omstarter hittills).
 *
 * `mode` (andra argumentet, bara bänken) går före ratten; 'sync' = den RIKTIGA workern i lås-steg (snabba sidan väntar på
 * varje publicering) - deterministiskt, för att jämföra workern hop för hop mot inline-läget.
 *
 * TAKTVÄGEN (split.ts): har systemets profil <prefix>BEAT_FEED 'slow' och en slowHopFeed-fabrik (DMX) körs taktmatningen i den
 * långsamma vägen; motorn matar den med analyser.hopLane.feed(frame, cfg, analyser). Lotus profil saknar båda: hopLane = null.
 */
export function createAnalyser(cfg: AnalyserConfig, modeIn?: 'worker' | 'inline' | 'sync'): Analyser {
  const mode = modeIn ?? sysEnv('ANALYSER_SPLIT');
  const cm = clockMode();
  if (mode !== 'worker' && mode !== 'inline' && mode !== 'sync') { const a = new Analyser(cfg); a.clock = new BeatFeed(); return a; }
  const sync = mode === 'sync';
  const feedMk = cm === 'slow' ? hopFeedFactory() : undefined;
  const buffers = createSplitBuffers(!!feedMk);
  const fast = new Analyser(cfg, { role: 'fast', split: buffers, sync });
  if (cm === 'inline') fast.clock = new BeatFeed();
  if (feedMk) { fast.hopLane = new HopLaneFast(buffers, sync); fast.hopSelf = sysEnv('BEAT_FEED') === undefined; }
  if (mode === 'inline') {
    fast.setInlinePeer(new Analyser(cfg, { role: 'slow', split: buffers }));
    if (feedMk) fast.hopLane!.peer = new HopLaneSlow(buffers, feedMk());
    return fast;
  }
  // Worker: SAB:arna delas via workerData (structured clone DELAR SharedArrayBuffer). cfg ar ren data och klonas.
  // Importen ar dynamisk sa modulen fortfarande laddar i miljoer utan worker_threads (bank, webblasare). Synk-läget måste starta
  // workern innan första process() (den väntar på den) och tar modulen synkront.
  const withWorker = ({ Worker }: typeof import('node:worker_threads')) => {
    let stopped = false;
    const attempts: number[] = [];   // tidpunkter for omstarter inom fonstret
    // STORA VÄGEN + TAKTVÄG (a3): två trådar - 'lane' (bara taktmatningen) och 'slow' (analysatorn: env + stora vägen). Annars en.
    // PI:NS VERKLIGHET (a3r): EN worker-tråd även med stora vägen - motorn är låst till 2 kärnor (CPUAffinity), en tredje tråd delar
    // kärna med ljusvägen. Taktvägen får förtur i tråden via bigYield (slowWorker.ts). Delningen 'lane'/'slow' finns kvar i slowWorker.
    const parts: Array<'all' | 'lane' | 'slow'> = ['all'];
    const workers: Array<{ postMessage: (m: unknown) => void }> = [];
    const start = (part: 'all' | 'lane' | 'slow', resumeSeq: number, why: string) => {
      const data: WorkerData = { cfg: { ...cfg }, buffers, resumeSeq, sync, part };
      // Pekar pa den BYGGDA filen (slowWorker.js bredvid denna).
      const w = new Worker(new URL('./slowWorker.js', import.meta.url), { workerData: data });
      w.on('error', (e) => console.error('[analyser-split] worker FEL:', e?.message ?? e));
      w.on('exit', (code) => {
        if (stopped || code === 0) { console.log(`[analyser-split] worker stangd (kod ${code})`); return; }
        const now = Date.now();
        while (attempts.length && now - attempts[0] > WORKER_RESTART_WINDOW_MS) attempts.shift();
        if (attempts.length >= WORKER_RESTART_MAX) {
          console.error(`[analyser-split] worker dog (kod ${code}) — ${WORKER_RESTART_MAX} omstarter pa ${WORKER_RESTART_WINDOW_MS / 60000} min, ger upp: tempo/sektion fryser pa senaste tillstandet; starta om motorn`);
          return;
        }
        const delay = WORKER_RESTART_BACKOFF_MS[Math.min(attempts.length, WORKER_RESTART_BACKOFF_MS.length - 1)];
        attempts.push(now);
        console.warn(`[analyser-split] worker dog (kod ${code}) — omstart #${attempts.length} om ${delay} ms, aterupptar vid record ${fast.fastReadSeq()} (skrivet ${fast.fastWriteSeq()})`);
        const t = setTimeout(() => { if (stopped) return; fast.splitRestarts++; start(part, part === 'lane' ? 0 : fast.fastReadSeq(), 'omstart'); }, delay);
        t.unref();
      });
      w.unref();
      workers[parts.indexOf(part)] = w;
      if (part !== 'lane') (fast as unknown as { __worker: unknown }).__worker = w;
      console.log(`[analyser-split] langsam analysator i worker startad (${part}) — ${why}, fran record ${resumeSeq}`);
    };
    (fast as unknown as { __stopWorker: () => void }).__stopWorker = () => {
      stopped = true;
      for (const w of workers) w?.postMessage({ type: 'stop' });
    };
    for (const p of parts) start(p, 0, 'start');
  };
  if (sync) withWorker((process as unknown as { getBuiltinModule(id: string): typeof import('node:worker_threads') }).getBuiltinModule('node:worker_threads'));
  else import('node:worker_threads').then(withWorker).catch((e) => console.error('[analyser-split] kunde inte starta worker:', e?.message ?? e));
  return fast;
}

/** TAKTVÄGEN: systemets taktmatning för den långsamma vägen, om profilen har <prefix>BEAT_FEED 'slow' och en slowHopFeed-fabrik. */
export function hopFeedFactory(): (() => HopFeed) | undefined {
  return clockMode() === 'slow' ? () => new BeatFeed() : undefined;
}
/** VAR KLOCKAN KÖRS - profilen på ETT ställe (sys.BEAT_FEED): 'slow' = i taktvägen (analysatorns långsamma väg, workern) när
 *  analysatorn är delad, annars sist i process(); 'inline' = alltid sist i process() (ingen taktväg); osatt (lotus) = som 'slow', men analysatorn matar taktvägen själv (hopSelf; EN KLOCKA: det finns ingen annan tempoväg). */
function clockMode(): 'slow' | 'inline' { return sysEnv('BEAT_FEED') === 'inline' ? 'inline' : 'slow'; }
