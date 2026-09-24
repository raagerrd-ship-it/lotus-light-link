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

import { TempoTracker } from './tempoTracker.js';
import { PROFILE } from './analyserProfile.js';
import {
  REC_LEN, RING_N, R_SEQ, R_PERF, R_WALL, R_ENV, R_BASS, R_HIGH, R_FLAGS, R_HINT_MS, R_VCLOCK, R_SEC_N, R_SEC_INT, R_SEC_KICKS, R_SEC_BREAK,
  R_SEC_RMS2, R_SEC_CENT, R_SEC_DT, R_DROPS, R_ACTIVE, R_BUILD, R_SEC_SPEC0, R_SEC_WALL, R_TS, R_FLAGCNT, RING_MARGIN, FLAG_BITS, R_SEC_BON, R_SEC_BPK, R_SEC_FLUX, R_SEC_RMS4,
  packFlagCounts, lostFlags, seqLow, seqDelta, C_WAITING, C_STATE_SEQ, S_LOST_FLAGS,
  F_SIL350, F_SIL10, F_RESET_TEMPO, F_HINT, F_RESET_BAR, F_VCLOCK_SET, F_VCLOCK_NULL,
  C_WRITE, C_READ, S_REC_SEQ, S_BPM, S_CONF, S_BPMF, S_PHASE_MS, S_PHASE_CONF, S_SECTION, S_SEC_START, S_SEC_INDEX, S_SEC_TIER,
  S_REP_SIM, S_REP_AGO, S_REP_SEC, S_EXPECT_MS, S_EXPECT_SRC, S_PREV_SEC, S_LVL_HIGH, S_PROCESSED, S_LAG_MS, S_LAG_MAX, S_BUSY_US, S_BUSY_MAX_US, S_SKIPPED, STATE_LEN,
  SECTIONS, sectionCode, viewsOf, stateWrite, stateRead, createSplitBuffers, type SplitBuffers, type WorkerData,
} from './split.js';
import FFT from "fft.js";

// ── RATTAR ─────────────────────────────────────────────────────────────────────────────────────
const ENV: Record<string, string | undefined> | undefined = typeof process !== 'undefined' ? process.env : undefined;
const ALIAS_PREFIX = PROFILE.envPrefix === 'LOTUS_' ? 'DMX_' : 'LOTUS_';
/** Ratt MED systemprefix: <eget prefix><name>, sedan <andra prefixet><name> (alias), sedan profilens standard. */
function sysEnv(name: string): string | undefined {
  return ENV?.[PROFILE.envPrefix + name] ?? ENV?.[ALIAS_PREFIX + name] ?? PROFILE.sys[name];
}
/** Ratt UTAN prefix (namnet som det star), sedan profilens standard. */
function env(name: string): string | undefined {
  return ENV?.[name] ?? PROFILE.bare[name];
}
/** Sann om ratten ar satt till nagot icke-tomt (motsvarar `!!process.env.X`). */
function sysOn(name: string): boolean { return !!sysEnv(name); }
function envOn(name: string): boolean { return !!env(name); }
// Rattar som lases i tatslingan (per hop) - lases EN gang vid modulladdning.
const HIGH_ON = sysOn('HIGH_DIAG') || sysOn('HIGH_VOTE');
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

export interface Frame {
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
  /** ABSOLUT mid+diskant-niva i dB (band 3-7, >250 Hz), RMS-kombinerad, ingen AGC. */
  midHiDb: number;
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
const BODY_PEAK_DB = Number(env('BODY_PEAK_DB') ?? 10);   // BRED onset-grind (en ren edge per event)
// HARD KVALITETSGRIND vid fyrningen: underPeak (bodyPeak-bodyFast) ar BIMODAL - riktiga drops slar till full
// niva (< 3 dB), falska ar partiella aterhamtningar kring 9-10 dB. Att kapa i gapet dodar de falska.
const DROP_QUALITY_DB = Number(env('DROP_QUALITY_DB') ?? 3.5);
// ARMERAT FONSTER: edgen ARMERAR, fyrningen sker nar fullSlam blir sann inom fonstret (mjuka pop-drops toppar
// 50-200 ms efter edgen). 0 = bara edge-ogonblicket.
const DROP_ARM_MS = Number(env('DROP_ARM_MS') ?? 0);
// FYR-LAGG: hela laggen ar bodyFast-filtret (tau 120 ms) som alla tre villkor laser. BODY_FAST_S sveper tau.
const BODY_FAST_S = Number(env('BODY_FAST_S') ?? 0.12);
// DROP_PEEK_MS: lopande minimum av ra bodyNow over N ms. 0 = ra-varde direkt; utelamnad = av.
const DROP_PEEK_MS = Number(env('DROP_PEEK_MS') ?? (envOn('DROP_PEEK') ? 0 : -1));
const DROP_PEEK = DROP_PEEK_MS >= 0;
// DROP_RISE_MIN: stigningen mats mot MINIMUM av bodyFast senaste 0,5 s, inte mot punkten 0,5 s bakat. Mjuka
// pop-drops har ett SUG (dipp 100-200 ms) fore dropen; med punkt-referensen nas kravet forst nar referensen
// hamnar i dippen -> fyrningen landar 0,5 s sent = en takt vid 130 BPM ("drop en takt efter").
const DROP_RISE_MIN = envOn('DROP_RISE_MIN');
// UPPGRADERING: inom korta fonstret far en kandidat fyra om den landar minst sa har manga dB NARMARE toppen an forra. 0 = av.
const DROP_UPGRADE_DB = Number(env('DROP_UPGRADE_DB') ?? 0);
// VILLKORAT STIGNINGSKRAV: landar kandidaten NARA TOPPEN (underPeak < DROP_RISE_LOW_Q) racker DROP_RISE_LOW_DB. 0 = av.
const DROP_RISE_LOW_DB = Number(env('DROP_RISE_LOW_DB') ?? 0);
const DROP_RISE_LOW_Q = Number(env('DROP_RISE_LOW_Q') ?? 3);
// LUGN-SEKTIONS-GRIND (opt-in <prefix>DROP_CALM_GATE=1): i lugna partier (sektion low/intro, eller >= DROP_CALM_DB under senaste
// refrangen) kravs starkare bevis (riser, landning vid toppen eller extra lyft). DROP_CALM_LAND_MS > 0 -> kandidaten halls och fyrar
// forst vid verifierad landning; 0 -> nekas.
const DROP_CALM_GATE = sysEnv('DROP_CALM_GATE') === '1';
const DROP_CALM_DB = Number(env('DROP_CALM_DB') ?? 6);
const DROP_CALM_BUILD = Number(env('DROP_CALM_BUILD') ?? 0.25);
const DROP_CALM_Q = Number(env('DROP_CALM_Q') ?? 1.5);
const DROP_CALM_RISE_DB = Number(env('DROP_CALM_RISE_DB') ?? 8);
const DROP_CALM_LAND_MS = Number(env('DROP_CALM_LAND_MS') ?? 0);
// KICK-LAS (opt-in DROP_KICK_LOCK_MS > 0): kroppsvillkoret armerar, fyrningen sker pa forsta kicken darefter (tak DROP_KICK_LOCK_MS
// eller en halv takt). DROP_KICK_LOCK_GRID=1: nasta rasterslag ar malet om gridfasen ar palitlig.
const DROP_KICK_LOCK_MS = Number(env('DROP_KICK_LOCK_MS') ?? 0);
const DROP_KICK_RECENT_MS = Number(env('DROP_KICK_RECENT_MS') ?? 100);
const DROP_KICK_LOCK_GRID = env('DROP_KICK_LOCK_GRID') === '1';
const DROP_KICK_FIRST = envOn('DROP_KICK_FIRST');
const KICK_FIRST_RISE = Number(env('KICK_FIRST_RISE') ?? 6);
// MINIDROPS: egen losare lyft-detektor med eget avstand MINI_SPACING_MS. 0 = av.
const MINI_SPACING_MS = Number(env('MINI_SPACING_MS') ?? 0);
const MINI_RISE_DB = Number(env('MINI_RISE_DB') ?? 10);
const MINI_GONE_DB = Number(env('MINI_GONE_DB') ?? 3);
const MINI_GONE_MS = Number(env('MINI_GONE_MS') ?? 800);
const MINI_PEAK_DB = Number(env('MINI_PEAK_DB') ?? 10);
const DROP_SHORT_MS = 4000;    // minsta drop-avstand nar dropen ESKALERAR
const DROP_LONG_MS = 20000;    // annars maste sa har lang tid ga (mot falska upprepningar)
const DROP_ESCALATE_DB = 3;    // tatare drops maste vara TYDLIGT starkare for att fyra
const BODY_CEIL_DB_S = 0.15;   // taket haller latens loud-referens lange

// ── TEMPO-RATTAR (inerta i standard) ──
const COMB3 = Number(env('COMB3') ?? 0.33);      // comb-filtrets 3:e-harmonik-vikt (ac[3*lag])
const PRIOR_W = Number(env('PRIOR_W') ?? 0.7);   // log-Gauss-priorns bredd
const PRIOR_C = env('PRIOR_C') ? Number(env('PRIOR_C')) : 0;   // prior-centrum (0 = folj fonstret: 1.5 x BPM_MIN)
const SUBH_MULT = Number(env('SUBH_MULT') ?? 3);   // subhSuspect: rostmultiplikator pa OCT-DOWN/NEAR (<prefix>SUBH_GUARD)
const NEAR_REACQ = Number(env('NEAR_REACQ') ?? 3); // NEAR-roster i reacq-fonstret
const SUBH_GUARD = sysOn('SUBH_GUARD');
const SUBH_HALF = envOn('SUBH_HALF');
// Diagnostik-/provrattar i tempovalet (alla inerta i standard, lases en gang):
const HIGH_VOTE = sysEnv('HIGH_VOTE');                          // 'always' | 'cond' | 'sharp'
const HIGH_COND_CONF = Number(env('HIGH_COND_CONF') ?? 0.4);
const HIGH_W = Number(env('HIGH_W') ?? 0.3);
const HIGH_K = Number(env('HIGH_K') ?? 2);
const HIGH_SHARP_COND = envOn('HIGH_SHARP_COND');
const HIGH_CAP = env('HIGH_CAP');
const HIGH_CLEAR = envOn('HIGH_CLEAR');
const HIGH_DIAG = sysOn('HIGH_DIAG');
const VETO_WIN = env('VETO_WIN');
const TG_ADAPT = sysOn('TG_ADAPT');
const TG_ADAPT_A = Number(env('TG_ADAPT_A') ?? 0.35);
const DEADBEAT = sysOn('DEADBEAT');
const DEADBEAT_TH = Number(env('DEADBEAT_TH') ?? 0.05);
const DEADBEAT_MS = Number(env('DEADBEAT_MS') ?? 6000);
const CONFBLEED = sysOn('CONFBLEED');
const GHOST_WAIT = sysOn('GHOST_WAIT');
const GHOST_LASTGOOD = envOn('GHOST_LASTGOOD');
const GHOST_34 = envOn('GHOST_34');
const GHOST_MS = Number(env('GHOST_MS') ?? 12000);
const PULSE_VETO = sysOn('PULSE_VETO');
const PULSE_VETO_MIN = Number(env('PULSE_VETO_MIN') ?? 0);
const PULSE_VETO_R = Number(env('PULSE_VETO_R') ?? 0.75);

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
  private static readonly ONSET_PEAK_TAU_S = 1.5;
  private static readonly ONSET_PEAK_FLOOR = 0.05;
  /** Onset-ringens langd i sekunder x 100 Hz. Env LOTUS_TEMPO_ENV_S bara for korbanken (bench.mjs) - 5 s ar driftvardet. */
  private static readonly ENV_LEN = 100 * Math.max(3, Math.min(20, Number(sysEnv('TEMPO_ENV_S')) || 5));
  private envRing = new Float32Array(Analyser.ENV_LEN);
  private envPos = 0;
  /** GRIDFAS (09-20): se computeGridPhase. Opt-in - standardbygget ar oforandrat. */
  private static readonly GRID_PHASE_ON = sysEnv('GRID_PHASE') === '1';
  /** Fasval: 'sum' = bas+helband (standard), 'bass' = basringen forst, helbandet bara nar basen ar tvetydig (kvot < BASS_MIN). Korbank-A/B. */
  private static readonly GRID_PHASE_MODE = sysEnv('GRID_PHASE_MODE') || 'sum';
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
  private static readonly GRID_PHASE_TRIM_ON = sysEnv('GRID_PHASE_TRIM') === '1';
  private static readonly GRID_PHASE_TRIM_MS = Number(sysEnv('GRID_PHASE_TRIM_MS')) || 25;
  /** ONSET-FRONTENS KONSTANTA SLAP (2026-09-23, opt-in LOTUS_GRID_PHASE_OFFSET_MS, standard 0).
   *  Mattes fram av trimmens misslyckande (se ovan): gridet OCH kickarna ligger i samma fas, ~15 ms efter
   *  ML-slagen (Beat This!). Kedjan ljud->ljus (30 ms, mat med klapp + 240 fps) ar en ANNAN sak och
   *  kompenseras avsiktligt inte - det har ar ett matfel i sjalva detektorn: envelope-ringen ar 10 ms-hinkar
   *  och fasscoret tar max over +-1 sampel, vilket skjuter estimatet efter anslaget. Darfor dras en KONSTANT
   *  fran den utsanda gridfasen (positivt varde = rapportera slaget tidigare). Ingen inlarning, inget att
   *  skena med. Mats i banken som foljarens offset-median mot Beat This!-slagen. */
  private static readonly GRID_PHASE_OFFSET_MS = Number(sysEnv('GRID_PHASE_OFFSET_MS')) || 0;
  private static readonly GRID_PHASE_BASS_MIN = Number(sysEnv('GRID_PHASE_BASS_MIN')) || 1.2;
  /** KLISTRIG FAS (09-20 15:10, live-spar): estimatet bytte halvslag var ~20 s pa NORTHMAN Remix med kvot 1,5 och foljaren hangde med.
   *  Ny fas > 0,3 slag fran forra tas bara nar dess poang slar forra fasens poang med STICKY_K under STICKY_N raka analyser (1,5 s).
   *  Sma justeringar (< 0,3 slag) gar igenom som forr. LOTUS_GRID_PHASE_STICKY=0 stanger av (gamla: 3 raka, ingen marginal). */
  private static readonly STICKY_K = sysEnv('GRID_PHASE_STICKY') === '0' ? 1.0 : (Number(sysEnv('GRID_PHASE_STICKY_K')) || 1.25);
  private static readonly STICKY_N = sysEnv('GRID_PHASE_STICKY') === '0' ? 3 : (Number(sysEnv('GRID_PHASE_STICKY_N')) || 6);
  private envLastWallMs = 0;
  // ── SEKTION (opt-in LOTUS_SECTION=1) ──────────────────────────────────────
  private static readonly SECTION_ON = sysEnv('SECTION') === '1';
  /** SEKTIONSLAGE: 'rank' (standard, 09-20 15:35) = kausal percentilrang av 4 s-fonstrets energi+anslagstathet mot alla block
   *  hittills i laten (samma matt som referens, sektionsreferensen, fast i realtid); 'tier' = gamla intensity-tiern (bank: 0,53 = slump). */
  private static readonly SECTION_MODE = sysEnv('SECTION_MODE') || 'rank';
  /** SEKTIONEN NOLLAS VID LATBYTE (2026-09-23, opt-in LOTUS_SECTION_ON_HINT=1).
   *  MATT pa 128 latborjor fran kvallens lyssning: vid borjan av en NY lat sager sektionsetiketten 'low' i 77 %,
   *  'high' i 12 %, 'build' i 9 % - och 'intro' i 2 %. Sektionsindex vid ny lat: median 44, max 174. Sektions-
   *  maskineriet nollas namligen BARA vid 10 s tystnad eller full resetTempo, sa i en spellista rullar det vidare
   *  genom hela kvallen: rang-percentilerna jamfor nya laten mot FORRA latens block, `levelVsHighDb` mater mot
   *  forra latens refrang, och 'intro' (som drop-grinden hanger pa) kan aldrig intraffa efter forsta laten.
   *  Det ar samma klass av overhang som kommentaren i hintTrackChange redan dokumenterar for tempogrammet -
   *  och det ar orsaken till agarens "falska drops vid latbyte/intro/outro".
   *  Tempot ror vi INTE: hinten ar fortfarande mjuk dar, av de skal som star i hintTrackChange. */
  private static readonly SECTION_ON_HINT = sysEnv('SECTION_ON_HINT') === '1';
  /** Forutsagelsens kallor (bitmask): 1 = minne (tidigare sektion med samma etikett), 2 = fras (stigande energi -> 8-taktsgrans). Bank-A/B. */
  private static readonly PREDICT_SRC = sysEnv('PREDICT_SRC') !== undefined ? Number(sysEnv('PREDICT_SRC')) : 2;   // standard 2 sedan frasgittret: minnet gav +1,6 falska/min utan traffar (09-21 kvall)
  /** Frasregel: LOS (standard): 2 stigande block ELLER energi, horisont 16 takter; LOTUS_PREDICT_STRICT=1: 3 block OCH energi, 8 takter.
   *  Bank 09-21 (12 hela latar, 22 refrangstarter): los 8/22 forutsedda inom +-2 s, lead 11,9 s, 6,0 falska/min; stram 4/22, 4,0/min;
   *  bara minne 2/22, 2,0/min. Taket satts av sektionsdetektorn sjalv (high==high 0,51) - battre sektioner -> battre forutsagelse. */
  private static readonly PREDICT_STRICT = sysEnv('PREDICT_STRICT') === '1';
  /** FRASGITTER (09-21 kvall, agent-sec4): LOTUS_PREDICT_GRID = 'hi' (standard) forankrar frasgittret i senaste 'high'-STARTEN (fore forsta
   *  refrangen: sektionsstarten) i stallet for i varje sektionsstart (som flimrar 6 byten/min) -> samma maltid oavsett nar regeln tander.
   *  'sec' = gamla. LOTUS_PREDICT_LAT = gitterlangd i takter (standard 4; gamla 8). LOTUS_PREDICT_RISE = minsta antal raka stigande block
   *  (secRiseRun) for frasregeln (standard 4; 0 = gamla losa regeln riseRun>=2 || buildUp>0,35 || bInt>0,55). LOTUS_PREDICT_DIP = dB (0 = av):
   *  SUG-regel - blockets dB dyker >= DIP dB under medianen av de 6 blocken fore, i hog kontext (medianen >= refrangens dB - 4) -> high om 2 s
   *  (kalla 3; bara pa dykets forsta block). Bank (12 hela latar, 22 refrangstarter): standard 8/22, 2,0 falska/min (var 8/22, 6,0);
   *  RISE=0 12/22, 6,0/min; DIP=5 ensam 3/22, 0,8/min (kort lead 2,3 s) men +1,2/min ovanpa standard utan nya traffar. */
  private static readonly PREDICT_GRID = sysEnv('PREDICT_GRID') || 'hi';
  private static readonly PREDICT_LAT = Number(sysEnv('PREDICT_LAT')) || 4;
  private static readonly PREDICT_RISE = sysEnv('PREDICT_RISE') !== undefined ? Number(sysEnv('PREDICT_RISE')) : 4;
  private static readonly PREDICT_DIP = Number(sysEnv('PREDICT_DIP')) || 0;
  private static readonly RANK_HI = Number(sysEnv('SECTION_RANK_HI')) || 0.67;
  private static readonly RANK_LO = Number(sysEnv('SECTION_RANK_LO')) || 0.33;
  private static secEnv(name: string, def: number): number { const v = sysEnv(name); const x = Number(v); return v !== undefined && v !== '' && Number.isFinite(x) ? x : def; }
  /** RANG-RATTAR (09-21, agent-sec1; offline-simulering av 12 hela latar + bank): referens rankar SEGMENTMEDEL, sa fonstret rankas mot
   *  alla 4 s-FONSTERMEDEL hittills (RANK_WIN=0 -> mot enskilda block som forr); kickvikt 0,5 (kicktatheten korrelerar 0,87 med dB men
   *  -0,05 med referensens onsettathet - den ar en nivaproxy, inte ett eget sardrag); centroid 0,5 (basta proxyn for referensens onsettathet,
   *  0,55); hysteres 0,15 kring trosklarna for den redan satta tiern; 3 raka block. Bank: high==high 0,51 -> 0,60, refrang-recall
   *  0,34 -> 0,73, falsk-high 0,58 -> 0,41, byten/lat 15 -> 7. Taket med referensens egna granser och dB ensamt ar ~0,64 (referensens
   *  onsettathet ar negativt korrelerad med dess dB, -0,23). */
  private static readonly RANK_VS_WIN = sysEnv('SECTION_RANK_WIN') !== '0';
  private static readonly RANK_WIN = Analyser.secEnv('SECTION_WIN', 4);
  private static readonly RANK_W_DENS = Analyser.secEnv('SECTION_W_DENS', 0.5);
  private static readonly RANK_W_CENT = Analyser.secEnv('SECTION_W_CENT', 0.5);
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
  private static readonly RANK_W_BASSON = Analyser.secEnv('SECTION_W_BASSON', 0);
  private static readonly RANK_W_BASSENV = Analyser.secEnv('SECTION_W_BASSENV', 0);
  private static readonly RANK_W_HIGH = Analyser.secEnv('SECTION_W_HIGH', 0);
  private static readonly RANK_W_FLAT = Analyser.secEnv('SECTION_W_FLAT', 0);
  private static readonly RANK_W_FLUX = Analyser.secEnv('SECTION_W_FLUX', 0);
  private static readonly RANK_W_DYN = Analyser.secEnv('SECTION_W_DYN', 0);
  private static readonly RANK_W_NEW = Analyser.RANK_W_BASSON !== 0 || Analyser.RANK_W_BASSENV !== 0 || Analyser.RANK_W_HIGH !== 0 || Analyser.RANK_W_FLAT !== 0 || Analyser.RANK_W_FLUX !== 0 || Analyser.RANK_W_DYN !== 0;
  /** Basonset-toppplockning (snabba sidan, var BIG_EVERY:e hop = 8 ms): librosa onset_detect-lika parametrar i sampel a 8 ms:
   *  pre_max 4 (30 ms), pre/post_avg 12 (100 ms), wait 4 (30 ms), delta i dB (librosas 0,07 pa ett dB-envelope). */
  private static readonly BASSON_DELTA = Analyser.secEnv('BASSON_DELTA', 0.07);
  private static readonly BASSON_LEN = 32; private static readonly BASSON_AVG = 12; private static readonly BASSON_MAX = 4; private static readonly BASSON_WAIT = 4;
  private bassOnRing = new Float32Array(Analyser.BASSON_LEN); private bassOnN = 0; private bassOnSum = 0; private bassOnLastPk = -1e9; private bassOnPeak = false;
  private secBlkBon = 0; private secBlkBpk = 0; private secBlkFlux = 0; private secBlkRms4 = 0;
  private secBlkH: { bon: number[]; bpk: number[]; high: number[]; flat: number[]; flux: number[]; dyn: number[] } = { bon: [], bpk: [], high: [], flat: [], flux: [], dyn: [] };
  private static readonly RANK_HYST = Analyser.secEnv('SECTION_HYST', 0.15);
  private static readonly RANK_RUN = Analyser.secEnv('SECTION_RUN', 3);
  /** SNABB ATTACK (09-22, agent-sec5, matt REFRANG 2): LOTUS_SECTION_RUN_IN = antal raka block for att ga IN i tier 2 (high) fran en
   *  lagre tier (0 = som RANK_RUN). Ut ur high galler RANK_RUN som forr (asymmetrisk hysteres: refrangen ska synas direkt, slappa langsamt).
   *  LOTUS_SECTION_HOLD_BARS = N (0 = av): uppehallet i high (REPEAT bit 16/32) ersatts av TAKTSTRUKTUR - minst N takter fran high-starten,
   *  sedan slapps high bara pa en 4-taktsgrans (fas +-1 takt) nar rangen inte langre sager high. */
  private static readonly RANK_RUN_IN = Analyser.secEnv('SECTION_RUN_IN', 0);
  private static readonly HOLD_BARS = Analyser.secEnv('SECTION_HOLD_BARS', 0);
  /** ATERINTRADE (09-22, agent-sec5): efter forsta refrangen ar refrangnivan kand (lastHighDb). Ar 2-blocksmedlet tillbaka pa den nivan
   *  (>= lastHighDb - REENTRY_DB) och 4 s-fonstrets rang >= REENTRY_PCT (under RANK_HI 0,67) -> 'high' DIREKT utan 3-blocks-run.
   *  Offline-sim pa train-dumpen (14 latar med refrang 2): refrang 2 <= 4 s 0 -> 3/14 (median 12,3 -> 8,0 s), vers 2 oforandrad,
   *  refrang-recall 0,58 -> 0,67, falsk-high 0,54 -> 0,55; dB-gransen binder nastan aldrig (0,5-2,0 lika), rangen ar det som avgor.
   *  REENTRY_PCT = 0 (standard) = av. */
  private static readonly REENTRY_PCT = Analyser.secEnv('SECTION_REENTRY_PCT', 0);
  private static readonly REENTRY_DB = Analyser.secEnv('SECTION_REENTRY_DB', 1.0);
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
  private static readonly LEVELREF = Analyser.secEnv('SECTION_LEVELREF', 0);
  private static readonly LVL_IN_DB = Analyser.secEnv('SECTION_LVL_IN', 0);
  private static readonly LVL_IN_DENS = Analyser.secEnv('SECTION_LVL_IN_DENS', 0.8);
  private static readonly LVL_IN_RUN = Analyser.secEnv('SECTION_LVL_IN_RUN', 3);
  private static readonly LVL_OUT_DB = Analyser.secEnv('SECTION_LVL_OUT', 5);
  private static readonly LVL_OUT_RUN = Analyser.secEnv('SECTION_LVL_OUT_RUN', 3);
  private static readonly LVL_PEAK_DB = Analyser.secEnv('SECTION_LVL_PEAK', 1.5);
  private lastHighDens = NaN; private secLvlInRun = 0; private secLvlOutRun = 0; private secLvlOutRef = NaN; private secPeakRun = 0;
  private secBlkCentH: number[] = []; private secScoreBuf: Float64Array | Float32Array = SECTION_SCORE_F32 ? new Float32Array(600) : new Float64Array(600);
  private secBlkHighH: number[] = [];
  /** levelVsHighDb-referens: 'section' = senaste refrangens medel-dB (standard), 'rank' = HIGH_REF_P-percentilen av latens block-dB. */
  private static readonly HIGH_REF = sysEnv('HIGH_REF') || 'section';
  private static readonly HIGH_REF_P = Number(sysEnv('HIGH_REF_P')) || 0.85;
  /** LATGRANS-NYHET (opt-in <prefix>BOUNDARY_NOV=1): bandfordelning + centroid per 1 s-block mot ett langsamt referensavtryck
   *  (BOUNDARY_TAU block); kosinusavstandet stiger nar klangen byts. Raknas pa den sida som kor sectionHop. */
  private static readonly BOUNDARY_NOV = sysEnv('BOUNDARY_NOV') === '1';
  private static readonly BOUNDARY_TAU = Number(sysEnv('BOUNDARY_TAU')) || 16;
  private secRefBuf = new Float64Array(600);   // sorteringsbuffert for HIGH_REF='rank'
  private bndVec = new Float32Array(9); private bndRef = new Float32Array(9); private bndRefN = 0;
  /** Klangnyhet 0..1 per 1 s-block mot det langsamma referensavtrycket (se BOUNDARY_NOV). 0 = av/okand. */
  boundaryNov = 0;
  /** Bandens absoluta magnitud for sektionsblocket (SECTION_AGG 'hop') - scratch sa hop-vagen inte allokerar. */
  private secSpecHop = new Float64Array(8);
  private secBlkRms2 = 0; private secBlkDb: number[] = []; private secBlkDens: number[] = []; private secRankRun = 0; private secRankCand = 1;
  /** Korbanks-dump (LOTUS_SECTION_DUMP=1): en rad per 1 s-block [tS, dB, kickar, centroid, bInt, breaking, dropped, spec0..7, tier, label] for offline-simulering av rangloggiken. */
  secDump: number[][] | null = sysEnv('SECTION_DUMP') === '1' ? [] : null;
  section = 'intro'; sectionStartMs = 0; sectionIndex = 0; sectionTier = 1; repeatSim = 0; repeatAgoMs = 0; repeatSection = '';
  // Sektionsminne (se Frame.expectHighInMs): logg over avslutade sektioner + forutsagelse + referensniva
  expectHighMs = 0; expectSource = 0; prevSection = ''; levelVsHighDb = 0;
  private secHiStartMs = 0; private secDipExpMs = 0; private secInDip = false;   // frasgittrets ankare (senaste high-start), sug-regelns mal + flank
  private secLog: Array<{ label: string; startMs: number; endMs: number; db: number; dens: number }> = [];
  private secCurDbSum = 0; private secCurDbN = 0; private secCurDens = 0; private lastHighDb = NaN;
  private secBlkMs = 0; private secBlkN = 0; private secBlkInt = 0; private secBlkKicks = 0; private secBlkCent = 0; private secBlkSpec = new Float32Array(8);
  private secTierRun = 0; private secTierCand = 1; private secRiseRun = 0; private secSongStartMs = 0; private secHighSeen = false; private secDropSeen = 0; private secSilentBlocks = 0;
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
  private static readonly REPEAT_THR = Number(sysEnv('SECTION_REPEAT_THR')) || 0.7;
  private static readonly REPEAT_STEP = Number(sysEnv('SECTION_REPEAT_STEP')) || 2;
  private static readonly REPEAT_W = Number(sysEnv('SECTION_REPEAT_W')) || 2;
  private static readonly FP2_DIM = 12; private static readonly FP2_MAX = 128;
  private secFp2 = new Float32Array(Analyser.FP2_MAX * Analyser.FP2_DIM); private secFp2Z = new Float32Array(Analyser.FP2_MAX * Analyser.FP2_DIM);
  private secFp2T = new Float64Array(Analyser.FP2_MAX); private secFp2Db = new Float32Array(Analyser.FP2_MAX); private secFp2Dens = new Float32Array(Analyser.FP2_MAX); private secFp2Lab: string[] = [];
  private secFp2N = 0; private secFp2Pos = 0; private secFp2Acc = new Float32Array(Analyser.FP2_DIM); private secFp2AccN = 0; private secFp2AccDb = 0; private secFp2AccDens = 0;
  private secFp2Mu = new Float32Array(Analyser.FP2_DIM); private secFp2Sd = new Float32Array(Analyser.FP2_DIM);
  private secBlkT: number[] = []; private secRank = { md: 0, sd: 1, mk: 0, sk: 1 }; private secScoreSorted: number[] = [];
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
  private static readonly TEMPL_THR = Analyser.secEnv('SECTION_TEMPL_THR', 0.5);
  private static readonly TEMPL_MARGIN = Analyser.secEnv('SECTION_TEMPL_MARGIN', 0.1);
  private static readonly TEMPL_MINPCT = Analyser.secEnv('SECTION_TEMPL_MINPCT', 0.33);
  private static readonly TEMPL_SM = Analyser.secEnv('SECTION_TEMPL_SM', 2);
  private static readonly TEMPL_RUN = Analyser.secEnv('SECTION_TEMPL_RUN', 2);
  private static readonly TEMPL_MINN = Analyser.secEnv('SECTION_TEMPL_MINN', 8);
  private static readonly TEMPL_SRC = sysEnv('SECTION_TEMPL_SRC') || 'rank';   // 'rank' (standard, bank 09-22) | 'lab'
  private static readonly TEMPL_WV: Float32Array = (() => { const w = sysEnv('SECTION_TEMPL_W') || 'full';
    const t: Record<string, number[]> = { full: [1,1,1,1,1,1,1,1,1,1,1,1], nobass: [0,0,0,1,1,1,1,1,1,1,1,1], timbre: [1,1,1,1,1,1,1,1,1,0,0,0], nolvl: [1,1,1,1,1,1,1,1,1,1,1,0], halfbass: [0.5,0.5,0.5,1,1,1,1,1,1,1,1,1] };
    return new Float32Array(t[w] || t.full); })();
  private secBlkFeat: Float32Array[] = []; private secBlkHi: number[] = []; private secPct = 0; private templLoRun = 0;
  private templMu = new Float32Array(Analyser.FP2_DIM); private templSd = new Float32Array(Analyser.FP2_DIM); private templHi = new Float32Array(Analyser.FP2_DIM); private templLo = new Float32Array(Analyser.FP2_DIM); private templZ = new Float32Array(Analyser.FP2_DIM);
  /** Klangmallens likhet for senaste blocket: mot refrangmallen / mot icke-refrangmallen (-1..1; 0 utan mall), antal mallblock. Bank-telemetri. */
  templSimHi = 0; templSimLo = 0; templN = 0;
  /** Matchat parti: tier med dagens rankning (-1 = inget), och nar 'high' vantas om det forflutna upprepas (absolut tid, 0 = ingen). */
  repeatTier = -1; repeatHighAtMs = 0; repeatHighEndAtMs = 0; private repeatHighRun = 0; private secHighRunMs = 0;
  beatPhaseMs = 0; beatPhaseConf = 0; private phaseAnti = 0; private phaseLastBeatMs = 0; private phaseScratch = new Float32Array(128);
  private phaseTrimRing = new Float32Array(8); private phaseTrimN = 0;   // kick-offset mot ra gridfas (ms), ringbuffert for trimmen
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
  private stateCopy = new Float64Array(STATE_LEN);
  private recSeq = 0;              // fast: senast skrivna record; slow: senast lasta. JS-tal, wrap-sakert (split.ts seqDelta)
  private barrierSeq = 0;          // fast: tillstand aldre an detta record ignoreras (en flagga ar pa vag)
  private pendFlags = 0; private pendHintMs = 0; private pendVclock = 0;
  private flagCnt = new Int32Array(FLAG_BITS);   // fast: antal ganger varje flagga rests (packas i R_FLAGCNT, se split.ts)
  private slowLastCnt = -1;        // slow: R_FLAGCNT i senast behandlade record (-1 = okant, t.ex. direkt efter omstart)
  private slowGap = false;         // slow: records tappade sedan senast behandlade -> kontrollera forlorade flaggor
  private slowLostFlags = 0;       // slow: antal flaggor som aterskapats ur raknarna efter tapp (statistik)
  splitRestarts = 0;               // fast: antal omstarter av workern (satts av index.ts)
  private secAgg = { n: 0, int: 0, kicks: 0, breaking: 0, rms2: 0, cent: 0, dt: 0, wall: 0, drops: 0, active: 0, build: 0, spec: new Float64Array(8), bon: 0, bpk: 0, flux: 0, rms4: 0 };
  private inlinePeer: Analyser | null = null;
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
  private static readonly BPM_MIN = Number(env('BPM_MIN') ?? 100);    // MAX måste vara == 2*MIN (exakt en oktav)
  private static readonly BPM_MAX = Analyser.BPM_MIN * 2;
  /** EVIDENSVAL (2026-09-19): tempogrammet som kandidatgenerator, slagpoang pa basonseten avgor. 0 = gamla argmax. */
  // Korbank 09-19 (med ljuddriven klocka): evidensvalet gav 6/8 syntet = samma som gamla vagen, men 1/6 mot 3/6 pa
  // bankmaterial - verkliga baslinjer har toner pa manga delslag, sa slagpoangen skiljer inte grannkandidater. OPT-IN.
  private static readonly EVIDENCE_ON = sysEnv('TEMPO_EVIDENCE') === '1';
  private static readonly EVIDENCE_K = 5;
  /** EVIDENSBAND (09-20): kandidatvalets slagpoang mots BASringen (standard). 'both' vager in helbandsringen nar basen ar
   *  svag - orkestral/akustisk musik (filmmusik, sjomansvisor) har ingen kick, sa baspoangen blir brus och valet slumpartat.
   *  Vikt = hur mycket basringen sticker ut (basens poangspridning); kvot < EVID_FULL_MIN => helbandet far halva rosten. */
  private static readonly EVID_BAND = sysEnv('EVID_BAND') || 'bass';
  private static readonly EVID_FULL_W = Number(sysEnv('EVID_FULL_W')) || 0.5;
  /** KICKDETEKTOR-RATTAR (09-20, korbank banken (bench.mjs), BENCH_GRID=1, 107 latar med PC-basonsets/slag):
   *  troskelfaktor mot MAD (4,5), grinden mot eget grid (pa), cooldown (170 ms) och energigolv (0,06). Env for A/B.
   *  Svep 2026-09-20 (tempot orort i alla): baslinje kick-recall 0,48 / precision 0,84 / on-beat-recall 0,63;
   *  grind av 0,52/0,85/0,68; grind av + cooldown 120 -> 0,70/0,84/0,89; cooldown 100 -> 0,82/0,84/0,95 (LIVE sedan
   *  10:23 via tempo-variant.conf); cooldown 80 -> 0,89/0,83/0,96. Orsak: en baston strax fore slaget skuggade slagets
   *  kick i 170 ms, och grinden forkastade slagets kick nar gridet lag fel. K 3,0-3,5 gav inget (0,53/0,85). */
  private static readonly KICK_K = Number(sysEnv('KICK_K')) || 4.5;
  private static readonly KICK_NOGATE = sysEnv('KICK_NOGATE') === '1';
  /** 0 = tempoanpassad: max(170, 0,6 slag) nar tempot ar kant, annars 170 ms. */
  private static readonly KICK_COOLDOWN_MS = Number(sysEnv('KICK_COOLDOWN')) || 0;
  private static readonly KICK_EFLOOR = Number(sysEnv('KICK_EFLOOR')) || 0.06;
  /** EVIDENSLAS (opt-in, LOTUS_TEMPO_EVIDLOCK=1): laset = median av evidensestimatet i stallet for den gamla lasapparaten.
   *  Korbank 09-19: SAMRE (syntet 4/8 mot 6/8, bankmaterial 1/6 mot 3/6) - grannkandidater poangsatts nastan lika och medianen hoppar.
   *  Glid + commit i den gamla apparaten ger stabiliteten. Kvar for vidare matning. */
  private static readonly EVIDLOCK_ON = sysEnv('TEMPO_EVIDLOCK') === '1';
  /** TEMPOFOLJARE MED TILLSTAND (opt-in LOTUS_TEMPO_HMM=1): se tempoTracker.ts. Ersatter argmax+vikning+lasapparaten. */
  private static readonly HMM_ON = sysEnv('TEMPO_HMM') === '1';
  private tracker = new TempoTracker();
  private trkTg = new Float32Array(this.tracker.n); private trkAlign = new Float32Array(this.tracker.n); private trkHalf = new Float32Array(this.tracker.n);
  private hmmConf = 0; private hmmReacqStamp = 0; private hmmLastLocal = 0;
  /** Telemetri: foljarens senaste svar. */
  hmmBpm = 0; hmmStable = 0;
  /** Korbank: tempogrammets argmax-lag och sokfonster i senaste anropet. */
  dbgKick: { flux: number; thresh: number; med: number; mad: number; energy: number; gain: number; rms: number; env: number; locked: boolean } | null = null; dbgRms = 0;
  dbgBestLag = 0; dbgLagMin = 0; dbgLagMax = 0; dbgTgAt = (lag: number): number => this.tempoGram[lag] ?? 0;
  /** Evidensomlasning: sa manga computeBpm-anrop i rad (4 Hz lasta = ~2 s) med tydlig, sammanhallen evidens for annat tempo. */
  private static readonly EVID_RELOCK_N = 8;
  evidRelockVotes = 0; private evidRelockBpm = 0;
  /** EVIDENSLAS: egen rostring (250 ms, 12 = 3 s) av evidensestimatet; laset ar dess median. */
  private evidHist = new Float32Array(12); private evidSort2 = new Float32Array(12); private evidHistPos = 0; private evidHistLen = 0; private evidLastVoteMs = 0;
  private evidChangeBpm = 0; private evidChangeVotes = 0; private localBpmF = 0; private evidLastLocal = 0;
  /** Antal evidensomlasningar (telemetri/korbank) + lasets senaste slagpoang. */
  evidenceRelocks = 0; evidenceLockScore = 0;
  private candLag = new Int32Array(12); private candVal = new Float32Array(12); private candScore = new Float32Array(12); private candHalf = new Float32Array(12); private candFull = new Float32Array(12);
  /** Senaste evidensvalets telemetri: vald kandidats slagpoang, halvslagskvot, antal kandidater, tvaans poang. */
  evidenceScore = 0; evidenceHalf = 0; evidenceCands = 0; evidenceSecond = 0;
  /** Senaste RA-estimatet (vikt till 80..160) fore las/median - for korbanken. */
  rawBpmLast = 0;
  /** Korbank: kandidaterna fran senaste evidensvalet. */
  debugCandidates(): Array<{ lag: number; bpm: number; tg: number; score: number; half: number }> {
    const out: Array<{ lag: number; bpm: number; tg: number; score: number; half: number }> = []; for (let i = 0; i < this.evidenceCands; i++) out.push({ lag: this.candLag[i], bpm: Math.round(Analyser.ENV_HZ * 60 / this.candLag[i] * 10) / 10, tg: this.candVal[i], score: this.candScore[i], half: this.candHalf[i] });
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
  private static readonly RELOCK_K = Number(env('RELOCK_K') ?? 2);
  private static readonly WARM_N = 48;
  private static readonly HOLD_N = 50;
  private static readonly OCT_UP = Number(env('OCT_UP') ?? 24);

  // HARMONI-VETO (2026-08-31). En AKTA ny lat landar sallan exakt pa en trioldelning
  // av den forra; en trioltopp i SAMMA lat gor det alltid. Se grann-grenen nedan.
  private static readonly HARM_TOL = Number(env('HARM_TOL') ?? 0.035);
  private static readonly HARM_PENALTY = Number(env('HARM_PENALTY') ?? 6);
  private static readonly OCT_DOWN = Number(env('OCT_DOWN') ?? 8);


  private nearVote = 0;     // bevis för GRANN-fel (t.ex. 122 låst mot 136): bara före commit
  private nearChallenger = 0;  // tempot grann-rösterna pekar på (måste hålla ihop, som challengerBpm)
  private bpmStable = 0;    // antal stabila (finjusterings-)estimat i rad → committa oktaven
  private challengerBpm = 0;   // tempot rösterna faktiskt pekar på (måste hålla ihop)
  private lockPeak = 0;        // tempogram-toppens styrka när takten är frisk (referens)
  private lastSongVoteMs = 0;  // väggklocka för förra låtbytesrösten (bevis mäts i TID)
  private newSongVote = 0;  // ihållande oenighet trots låst oktav → låtbyte utan tystnadslucka
  /** Antal stabila finjusterings-estimat (@4Hz) innan oktaven committas OCH
   *  låtbytesvakten öppnar. MÅSTE vara samma tal på båda ställena — se dödläget
   *  dokumenterat vid `committed` i computeBpm(). */
  private static readonly BPM_COMMIT = 24;
  /** Väggklocka för när konfidensen senast var frisk (≥0.3) — grund för den mjuka
   *  låssläppningen sist i computeBpm(). 0 = ej satt. */
  private lowConfSinceMs = 0;
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
  private barAcc = new Float64Array(4);
  private barCount = 0;        // antal bokförda slag (bevisunderlag för taktfasen)
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
  private silentMs = 0;
  private diagLagMin = 0; private diagLagMax = 0;
  private _why = "";   // TRACE: vilken gren bytte tempot (<prefix>BPM_TRACE)
  /** Senast COMMITTADE tempot. SUBHARMONIK-GUARD (<prefix>SUBH_GUARD): en kandidat som ar exakt 2/3 (SUBH_HALF: aven 1/2)
   *  av det (+-4 %) ar nastan alltid comb-filtrets ac[3P]-artefakt vid ett byte -> krav mangfalt mer bevis. */
  private lastGoodBpm = 0;
  private subhSuspect(cand: number): boolean {
    if (!SUBH_GUARD || this.lastGoodBpm <= 0 || cand <= 0) return false;
    const r = cand / this.lastGoodBpm;
    return Math.abs(r / (2 / 3) - 1) < 0.04 || (SUBH_HALF && Math.abs(r / 0.5 - 1) < 0.04);
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
  private bodyEnv = -120;
  /** Snabb envelopp (0.12 s) ENBART for stigningstakten. Den langsammare
   *  bodyEnv (0.35 s) styr tak och franvaro. Blandar man ihop dem dampas
   *  stigningen och trosklarna slutar motsvara det som mattes i banken. */
  private bodyFast = -120;
  private bodyCeil = -300;   // dB
  private bodyPeak = -300;   // SEG topp (loud-referens i minuter) for landa-hogt
  private lastGoneSpanMs = 0;
  private lastDropRise = 0;
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
  private peekRing = new Float32Array(64).fill(-120); private peekPos = 0;   // DROP_PEEK_MS lopande minimum av ra bodyNow
  private lastDropUnderPeak = 99;   // underPeak vid senaste fyrningen (DROP_UPGRADE_DB)
  private miniDropCount = 0; private lastMiniMs = -1e9; private miniGoneMs = 0; private lastMiniGoneMs = -1e9; private wasMiniOnset = false;
  private dropArmUntil = 0; private dropArmAt = 0; private dropArmGoneMs = -1;   // armerat drop-fonster (DROP_ARM_MS)
  private dropKickGoneMs = -1; private kickSeenGoneMs = -1;   // KICK-FIRST + [firstkick]-spar per gone-episod
  private calmHoldStart = 0; private calmHoldRise = 0;   // DROP_CALM_LAND_MS: kandidat som halls for verifierad landning
  private dropPendAt = 0; private dropPendStart = 0; private dropPendRise = 0; private dropPendGrid = false; private lastKickWallMs = -1e9;   // DROP_KICK_LOCK_MS
  private goneEpisodeMs = -1;   // gone-episodens START (lastBodyGoneMs uppdateras varje hop och duger INTE som id)
  private dropCount = 0;         // monoton drop-räknare (edge-säker för konsumenter)
  private lastDropMs = -1e9;
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


  /**
   * BPM (90..180) från onset-envelopens autokorrelation.
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
  private scoreEnv(ring: Float32Array, N: number, out: Float32Array, lagMin: number, lagMax: number): number {
    const L = Analyser.ENV_LEN;
    const env = this.envScratch;
    const pre = this.prefScratch;
    const preSq = this.prefSqScratch;
    const start = (this.envPos - N + L) % L;
    let energy = 0;
    pre[0] = 0;
    preSq[0] = 0;
    // Ringen läses i TVÅ RAKA BLOCK. `% L` i den inre loopen kostade en modulo per
    // sampel (N upp till 500, två anrop per computeBpm) helt i onödan.
    const n1 = Math.min(N, L - start);
    for (let i = 0; i < n1; i++) {
      const v = ring[start + i];
      env[i] = v; energy += v; pre[i + 1] = pre[i] + v; preSq[i + 1] = preSq[i] + v * v;
    }
    for (let i = n1; i < N; i++) {
      const v = ring[i - n1];
      env[i] = v; energy += v; pre[i + 1] = pre[i] + v; preSq[i + 1] = preSq[i] + v * v;
    }

    // WHITENING: subtrahera ett LOKALT medel (1 s glidande) i stället för det
    // globala. En långsam nivådrift inom fönstret (uppbyggnad, breakdown, AGC som
    // andas) läcker annars rakt in i autokorrelationen och lyfter de långa laggen.
    const half = Analyser.ENV_HZ >> 1;
    for (let i = 0; i < N; i++) {
      const lo = i - half > 0 ? i - half : 0;
      const hi = i + half + 1 < N ? i + half + 1 : N;
      const width = hi - lo;
      const mean = (pre[hi] - pre[lo]) / width;
      const centered = env[i] - mean;
      if (this.cfg.onset.enhancements) {
        const variance = Math.max(0, (preSq[hi] - preSq[lo]) / width - mean * mean);
        // Lokal standardisering håller tempogrammets novelty-kontrast användbar
        // genom både breakdowns och uppbyggnader utan att ändra rå ljudnivå.
        env[i] = centered / Math.max(0.01, Math.sqrt(variance));
      } else {
        env[i] = centered;
      }
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
      // ANTALET TERMER ÄR KÄNT I FÖRVÄG — räkna det inte.
      // Med q = (N/lag)|0 och r = N - q·lag har faserna 0..r-1 exakt q+1 termer,
      // resten q. Två divisioner per lag i stället för ~70, och ~39 000 k++ per
      // anrop försvinner. Uppmätt -7 %, och utfallet är BIT-IDENTISKT: samma
      // termer adderas i samma ordning, bara räknaren är borta.
      // DIVISIONEN BEHÅLLS. Att i stället multiplicera med en förberäknad reciprok
      // hade sparat ytterligare någon nanosekund men är INTE bit-identiskt i
      // flyttal — och hela poängen med den här ändringen är att den inte får
      // röra utfallet.
      const q = (N / lag) | 0;
      const r = N - q * lag;
      for (let ph = 0; ph < lag; ph++) {
        let sAcc = 0;
        for (let i = ph; i < N; i += lag) sAcc += envPos[i];
        const k = ph < r ? q + 1 : q;
        if (k > 0) { const norm = sAcc / k; if (norm > best) best = norm; }
      }
      pulse[lag] = best;
      if (best > pulseMax) pulseMax = best;
      // NORMALISERA MOT DE VIKTER SOM FAKTISKT ANVANDES (Klapuri gor det).
      // Utan det far korta lag systematiskt hogre comb bara for att de RYMMER
      // fler harmoniker inom lagMax — alltsa precis den snabbtakts-bias
      // comb-scoringen ska motverka. Varre: poangen blev DISKONTINUERLIG dar
      // antalet termer andras (2*lag och 3*lag passerar lagMax), sa tva tempon
      // som skiljer 1 BPM bedomdes med olika manga termer.
      let comb = ac[lag];
      let wSum = 1;
      if (2 * lag <= lagMax) { comb += 0.5 * ac[2 * lag]; wSum += 0.5; }
      if (3 * lag <= lagMax) { comb += COMB3 * ac[3 * lag]; wSum += COMB3; }
      comb /= wSum;
      combArr[lag] = comb;
      if (comb > combMax) combMax = comb;
    }
    // Normalisera båda till [0,1] och rösta jämnt — så de kan väga upp varandra.
    // AC svarar starkt på självlikhet, pulse xcorr på regelbunden energi-fördelning.
    // 4) PERCEPTUELL PRIOR: log-Gauss runt 120 BPM, σ = 1.0 oktav (Ellis/librosa).
    for (let lag = lagMin; lag <= lagMax; lag++) {
      // GUARDET MASTE SITTA PA DIVISIONEN, inte pa initialvardet. `combArr` kan
      // vara negativ (ac ar en centrerad korrelation), sa combMax kan bli <= 0 —
      // och da blir kvoten ~1e8 med fel tecken och injiceras i tempogrammet med
      // a = 0.15, dvs forgiftar det i ~40 anrop. `pulseMax` ar saker (envPos >= 0).
      const cDen = combMax > 1e-9 ? combMax : 1e-9;
      out[lag] = (0.5 * (combArr[lag] / cDen) + 0.5 * (pulse[lag] / pulseMax)) * this.priorLut[lag];
    }
    return energy / N;
  }

  /** SLAGPOANG for en kandidatperiod L (i env-sampel @100 Hz) pa en onset-ring over de senaste N samplen:
   *  slagen laggs ut med basta fas, medel pa slagen (max over i-1..i+1, onsets ar nagra sampel breda)
   *  delat med medel over fonstret. Fantomer (3/2, 4/3, 7/6) traffar kickarna bara delvis och far lag
   *  poang. half = medel pa halvslagen / medel pa slagen (oktavtelemetri, PC-regeln: >= 0,6 => dubbla). */
  private evidSortScratch = new Float32Array(Analyser.ENV_LEN); private evidThresh = 0; private evidThreshN = -1; private evidThreshPos = -1;
  private alignScore(ring: Float32Array, N: number, L: number): { score: number; half: number; hit: number } {
    const LEN = Analyser.ENV_LEN;
    const start = (this.envPos - N + LEN) % LEN;
    const at = (i: number): number => {
      const c = ring[(start + i) % LEN]; const a = i > 0 ? ring[(start + i - 1) % LEN] : c; const b = i + 1 < N ? ring[(start + i + 1) % LEN] : c;
      const m = c > a ? (c > b ? c : b) : (a > b ? a : b);
      return m > 0 ? m : 0;
    };
    let tot = 0; for (let i = 0; i < N; i++) { const v = ring[(start + i) % LEN]; if (v > 0) tot += v; }
    const mean = tot / N;
    if (mean <= 0 || L < 2) return { score: 0, half: 0, hit: 0 };
    // TRAFFANDEL: andel slag dar en onset verkligen finns (>= 30 % av fonstrets 95-percentil). Medelpoangen
    // ensam var for snall mot fantomer (3/2 fick 1,8-2,1 mot ratt 2,2-2,5): med bastafas och +-1 sampel
    // fangar den anda tva av tre kickar. Traffandelen ar 1,0 for ratt tempo, ~0,67 for 3/2, ~0,75 for 4/3.
    if (this.evidThreshN !== N || this.evidThreshPos !== this.envPos) {       // en percentil per anrop, inte per kandidat
      const sc = this.evidSortScratch; let n = 0; for (let i = 0; i < N; i++) { const v = ring[(start + i) % LEN]; sc[n++] = v > 0 ? v : 0; }
      const sub = sc.subarray(0, n); sub.sort(); this.evidThresh = 0.3 * sub[Math.floor(n * 0.95)]; this.evidThreshN = N; this.evidThreshPos = this.envPos;
    }
    const th = this.evidThresh;
    let bestPh = 0, bestSum = -1, bestHits = 0;
    for (let ph = 0; ph < L; ph++) {
      let sum = 0, hits = 0; for (let i = ph; i < N; i += L) { const v = at(i); sum += v; if (v >= th) hits++; }
      if (sum > bestSum) { bestSum = sum; bestPh = ph; bestHits = hits; }
    }
    const nOn = Math.floor((N - 1 - bestPh) / L) + 1; const on = bestSum / nOn; const hit = bestHits / nOn;
    let hs = 0, nh = 0; for (let i = bestPh + (L >> 1); i < N; i += L) { hs += at(i); nh++; }
    const half = nh ? hs / nh : 0;
    return { score: (on / mean) * (0.5 + hit), half: on > 0 ? half / on : 0, hit };
  }

  /** SEKTION (2026-09-20). Realtidens sektionstillstand ur latens EGEN historik - inget latminne, ingen PC, inget moln
   *  (slutlaget: bada Pi-systemen kor allt i realtid). Bygger pa intensity (niva relativt latens robusta baslinje),
   *  buildUp/breaking/drop-detektorn och en 1 s-blockstatistik. Tier (lag/mellan/hog) med 3 s hysteres; trend = skillnad
   *  mot 8 s tidigare. Upprepning: ett klangavtryck per 4 s (8 band normerade + centroid + kicktathet + intensitet, L2)
   *  jamfors med alla avtryck >= 16 s tillbaka (max 96 = 6,4 min); bast cosinus -> repeatSim/repeatAgoMs/repeatSection.
   *  Kostnad: nagra adds per hop, ~100 punktprodukter a 11 var fjarde sekund. Referens for bansken: all-in-one pa hela latar. */
  private sectionReset(): void {
    this.section = 'intro'; this.sectionStartMs = 0; this.sectionIndex = 0; this.sectionTier = 1; this.repeatSim = 0; this.repeatAgoMs = 0; this.repeatSection = '';
    this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0);
    this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0; const H = this.secBlkH; H.bon.length = 0; H.bpk.length = 0; H.high.length = 0; H.flat.length = 0; H.flux.length = 0; H.dyn.length = 0;
    this.secTierRun = 0; this.secTierCand = 1; this.secRiseRun = 0; this.secSongStartMs = 0; this.secBlkRms2 = 0; this.secBlkDb.length = 0; this.secBlkDens.length = 0; this.secBlkCentH.length = 0; this.secHighSeen = false; this.secDropSeen = this.dropCount; this.secSilentBlocks = 0;
    this.secHistN = 0; this.secHistPos = 0; this.secFpN = 0; this.secFpPos = 0; this.secFpLab.length = 0; this.secFpAcc.fill(0); this.secFpAccN = 0;
    this.secLog.length = 0; this.secCurDbSum = 0; this.secCurDbN = 0; this.secCurDens = 0; this.lastHighDb = NaN; this.expectHighMs = 0; this.expectSource = 0; this.prevSection = ''; this.levelVsHighDb = 0;
    this.lastHighDens = NaN; this.secLvlInRun = 0; this.secLvlOutRun = 0; this.secLvlOutRef = NaN; this.secPeakRun = 0;
    this.secHiStartMs = 0; this.secDipExpMs = 0; this.secInDip = false; this.secPct = 0;
    this.secFp2N = 0; this.secFp2Pos = 0; this.secFp2Lab.length = 0; this.secFp2Acc.fill(0); this.secFp2AccN = 0; this.secFp2AccDb = 0; this.secFp2AccDens = 0;
    this.secBlkT.length = 0; this.secScoreSorted.length = 0; this.secRank.md = 0; this.secRank.sd = 1; this.secRank.mk = 0; this.secRank.sk = 1; this.repeatTier = -1; this.repeatHighAtMs = 0; this.repeatHighEndAtMs = 0; this.repeatHighRun = 0; this.secHighRunMs = 0;
    this.secBlkFeat.length = 0; this.secBlkHi.length = 0; this.secPct = 0; this.templLoRun = 0; this.templSimHi = 0; this.templSimLo = 0; this.templN = 0;

    this.secBlkHighH.length = 0; this.bndRefN = 0; this.bndRef.fill(0); this.boundaryNov = 0;
  }

  /** Tar BLOCKSUMMOR (n hop): i roll 'all' anropas den per hop med n = 1, i workern en gang per env-sampel med summorna
   *  for de ~4 hoppen (split.ts). Samma matematik - medelvardena delas med secBlkN i bada fallen. */
  private sectionHop(hops: number, intSum: number, kicks: number, breaking: boolean, nowMs: number, dtMs: number, rms2Sum: number, centSum: number, spec: ArrayLike<number>, specOff = 0, bonSum = 0, bpk = 0, fluxSum = 0, rms4Sum = 0): void {
    if (this.secSongStartMs === 0) { this.secSongStartMs = nowMs; this.sectionStartMs = nowMs; this.secDropSeen = this.dropCount; }
    this.secBlkMs += dtMs; this.secBlkN += hops; this.secBlkInt += intSum; this.secBlkKicks += kicks; this.secBlkCent += centSum; this.secBlkRms2 += rms2Sum;
    this.secBlkBon += bonSum; this.secBlkBpk += bpk; this.secBlkFlux += fluxSum; this.secBlkRms4 += rms4Sum;
    for (let i = 0; i < 8; i++) this.secBlkSpec[i] += spec[specOff + i];
    if (this.secBlkMs < 1000) return;
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
    if (Analyser.SECTION_MODE === 'rank') {
      // KAUSAL PERCENTILRANG (15:35): blockets dB (ra rms, fore AGC) och basonset-tathet (kickar/s) z-normeras mot alla block
      // hittills i laten, 4 s-fonstrets medelpoang rangordnas mot alla blockpoang hittills. Minst 20 s historik; innan dess 'intro'.
      const db = 10 * Math.log10(this.secBlkRms2 / n + 1e-10); this.secBlkDb.push(db); this.secBlkDens.push(bKicks); this.secBlkCentH.push(bCent); this.secBlkHighH.push(bHigh); if (Analyser.REPEAT & 769) this.secBlkT.push(nowMs);
      if (Analyser.RANK_W_NEW) { const H = this.secBlkH; H.bon.push(bBon); H.bpk.push(bBpk); H.high.push(bHigh); H.flat.push(bFlat); H.flux.push(bFlux); H.dyn.push(bDyn); }
      if (Analyser.REPEAT & 768) { const ft = new Float32Array(Analyser.FP2_DIM); let ssum = 0; for (let i = 0; i < 8; i++) ssum += this.secBlkSpec[i]; for (let i = 0; i < 8; i++) ft[i] = ssum > 0 ? this.secBlkSpec[i] / ssum : 0; ft[8] = bCent; ft[9] = Math.min(1, bKicks / 4); ft[10] = bInt; ft[11] = db / 10; this.secBlkFeat.push(ft); this.secBlkHi.push(0); }
      if (this.secBlkDb.length > 600) { this.secBlkDb.shift(); this.secBlkDens.shift(); this.secBlkCentH.shift(); this.secBlkHighH.shift(); if (Analyser.RANK_W_NEW) { const H = this.secBlkH; H.bon.shift(); H.bpk.shift(); H.high.shift(); H.flat.shift(); H.flux.shift(); H.dyn.shift(); } if (Analyser.REPEAT & 769) this.secBlkT.shift(); if (Analyser.REPEAT & 768) { this.secBlkFeat.shift(); this.secBlkHi.shift(); } }
      const nb = this.secBlkDb.length;
      if (nb >= 20) {
        const D = this.secBlkDb, K = this.secBlkDens, C = this.secBlkCentH, wk = Analyser.RANK_W_DENS, wc = Analyser.RANK_W_CENT;
        let md = 0, mk = 0, mc = 0; for (let i = 0; i < nb; i++) { md += D[i]; mk += K[i]; mc += C[i]; } md /= nb; mk /= nb; mc /= nb;
        let sd = 0, sk = 0, sc = 0; for (let i = 0; i < nb; i++) { sd += (D[i] - md) ** 2; sk += (K[i] - mk) ** 2; sc += (C[i] - mc) ** 2; }
        sd = Math.max(1.0, Math.sqrt(sd / nb)); sk = Math.max(0.3, Math.sqrt(sk / nb)); sc = Math.max(0.02, Math.sqrt(sc / nb));
        this.secRank.md = md; this.secRank.sd = sd; this.secRank.mk = mk; this.secRank.sk = sk;
        // Nya sardrag (RANK_W_*): z mot latens historik med sd-golv (skala per sardrag), viktade in i samma poang i fast
        // ordning. Poangen summeras i 64 bitar och lagras en gang (SECTION_SCORE_F32 avrundar da en gang, som aldre vagen).
        const terms: Array<{ X: number[]; w: number; m: number; s: number }> = [];
        if (Analyser.RANK_W_NEW) {
          const H = this.secBlkH;
          const add = (X: number[], w: number, floor: number) => { if (w === 0) return; let m = 0; for (let i = 0; i < nb; i++) m += X[i]; m /= nb; let s = 0; for (let i = 0; i < nb; i++) s += (X[i] - m) ** 2; s = Math.max(floor, Math.sqrt(s / nb)); terms.push({ X, w, m, s }); };
          add(H.bpk, Analyser.RANK_W_BASSON, 0.5); add(H.bon, Analyser.RANK_W_BASSENV, 0.02); add(this.secBlkHighH, Analyser.RANK_W_HIGH, 1.0); add(H.flat, Analyser.RANK_W_FLAT, 0.02); add(H.flux, Analyser.RANK_W_FLUX, 0.01); add(H.dyn, Analyser.RANK_W_DYN, 0.05);
        }
        const S = this.secScoreBuf, nt = terms.length;
        for (let i = 0; i < nb; i++) {
          let v = (D[i] - md) / sd + wk * (K[i] - mk) / sk + wc * (C[i] - mc) / sc;
          for (let t = 0; t < nt; t++) { const T = terms[t]; v += T.w * (T.X[i] - T.m) / T.s; }
          S[i] = v;
        }
        let win = 0; const W = Math.min(Analyser.RANK_WIN, nb); for (let i = nb - W; i < nb; i++) win += S[i]; win /= W;
        let below = 0, cnt = 0;
        if (Analyser.RANK_VS_WIN) { let acc = 0; for (let e = 1; e <= nb; e++) { acc += S[e - 1]; if (e > W) acc -= S[e - 1 - W]; if (e >= W) { cnt++; if (acc / W < win) below++; } } }
        else { cnt = nb; for (let i = 0; i < nb; i++) if (S[i] < win) below++; }
        const pct = below / cnt; const cur = this.sectionTier, h = Analyser.RANK_HYST; this.secPct = pct;
        tier = pct >= Analyser.RANK_HI - (cur === 2 ? h : 0) ? 2 : pct <= Analyser.RANK_LO + (cur === 0 ? h : 0) ? 0 : 1;
      } else { tier = 1; this.secPct = 0; }
      if (Analyser.REPEAT & 768) this.templStep(nowMs);
    }
    if (tier === this.secTierCand) this.secTierRun++; else { this.secTierCand = tier; this.secTierRun = 1; }
    const runNeed = Analyser.SECTION_MODE !== 'rank' ? 3 : (Analyser.RANK_RUN_IN > 0 && this.secTierCand === 2 && this.sectionTier < 2) ? Analyser.RANK_RUN_IN : Analyser.RANK_RUN;
    if (this.secTierRun >= runNeed) this.sectionTier = this.secTierCand;
    const st = this.sectionTier;
    // trend mot 8 s sedan
    this.secHist[this.secHistPos] = bInt; this.secHistPos = (this.secHistPos + 1) & 15; if (this.secHistN < 16) this.secHistN++;
    const rise = this.secHistN >= 9 ? bInt - this.secHist[(this.secHistPos - 9 + 16) & 15] : 0;
    this.secRiseRun = rise >= 0.10 ? this.secRiseRun + 1 : 0;
    const sinceStart = nowMs - this.secSongStartMs; const dropped = this.dropCount !== this.secDropSeen; this.secDropSeen = this.dropCount;
    const prev = this.section; let label: string;
    if (Analyser.SECTION_MODE === 'rank') {
      // rang-lage: tier 2 = high, tier 0 = low, mitten = 'break' pa vag ner fran high, 'build' pa vag upp fran low/intro, annars kvar
      if (this.secBlkDb.length < 20) label = 'intro';
      else if (dropped || st === 2) label = 'high';
      else if (st === 0) label = 'low';
      else label = prev === 'high' || prev === 'break' ? 'break' : (prev === 'low' || prev === 'intro' || prev === 'build') ? 'build' : prev;
      // MINNET (bit 2/8): nuet liknar ett tidigare parti -> det partiets tier (omrankad med dagens kunskap) vager in.
      if ((Analyser.REPEAT & 10) && this.repeatSim >= Analyser.REPEAT_THR && this.repeatTier >= 0 && !dropped) {
        if ((Analyser.REPEAT & 2) && this.repeatTier === 2 && st >= 1) label = 'high';
        else if ((Analyser.REPEAT & 8) && this.repeatTier === 0 && label === 'high') label = prev === 'high' ? 'break' : 'low';
      }
      // INTRADE VIA LAG (bit 64): det forflutnas high-start + lag ar NU (-1,5..+1 s) -> high direkt, utan rangens 2-blocks-hysteres + 4 s-fonster
      if ((Analyser.REPEAT & 64) && this.repeatSim >= Analyser.REPEAT_THR && this.repeatHighAtMs > 0 && st >= 1 && label !== 'high' && !dropped) {
        const d = this.repeatHighAtMs - nowMs; if (d >= -1500 && d <= 1000) label = 'high';
      }
      // ATERINTRADE (REENTRY_PCT): nivan ar tillbaka pa refrangens och rangen nastan uppe -> high direkt (refrang 2 <= 4 s)
      if (Analyser.REENTRY_PCT > 0 && label !== 'high' && prev !== 'high' && st >= 1 && !dropped && Number.isFinite(this.lastHighDb) && this.secBlkDb.length >= 20) {
        const D = this.secBlkDb, nb = D.length; const m2 = (D[nb - 1] + D[nb - 2]) / 2;
        if (m2 >= this.lastHighDb - Analyser.REENTRY_DB && this.secPct >= Analyser.REENTRY_PCT) label = 'high';
      }
      // KLANGMALL IN (bit 256): blocket later som refrangen hittills (och inte som resten) och rangen ar inte tydligt lag -> high direkt
      if ((Analyser.REPEAT & 256) && label !== 'high' && !dropped && this.templN >= Analyser.TEMPL_MINN && this.templSimHi >= Analyser.TEMPL_THR && this.templSimHi - this.templSimLo >= Analyser.TEMPL_MARGIN && this.secPct >= Analyser.TEMPL_MINPCT) label = 'high';
      // UPPEHALL I HIGH (bit 16 minne / bit 32 prior 8 takter): rangen dippar till mellan mitt i refrangen (4 s-fonster) -> high -> break -> high
      // var 4 s (baslinjen: joaquinphoenix 24h 28b 32h 36b 45h mot referens high 27-102 s). Sa lange forra refrangen varade halls high; tier 0 slapper.
      if ((Analyser.REPEAT & 48) && prev === 'high' && label === 'break' && st === 1) {
        if (Analyser.HOLD_BARS > 0 && this.localBpm > 0 && this.secHiStartMs > 0) {
          // TAKTSTRUKTUR (HOLD_BARS): minst N takter i high, sedan slapp bara pa 4-taktsgrans (fas < 1 eller > 3 takter in i blocket)
          const bars = (nowMs - this.secHiStartMs) / (240000 / this.localBpm); const ph = bars % 4;
          if (bars < Analyser.HOLD_BARS || !(ph < 1.0 || ph > 3.0)) label = 'high';
        } else {
          let hold = (Analyser.REPEAT & 16) ? Math.min(40000, this.secHighRunMs) : 0;
          if ((Analyser.REPEAT & 32) && this.localBpm > 0) hold = Math.max(hold, 8 * 240000 / this.localBpm);
          if (nowMs - this.sectionStartMs < hold) label = 'high';
        }
      }
      // UTGANG VIA LAG (bit 128): det forflutnas high-SLUT + lag. Sa lange det forflutna fortfarande ar high halls high (st 1);
      // nar slutet ar NU (-1,5..+1,5 s) och rangen inte langre sager high -> 'break' direkt (minnets grans i stallet for uppehallets slut).
      if ((Analyser.REPEAT & 128) && prev === 'high' && this.repeatSim >= Analyser.REPEAT_THR && this.repeatHighEndAtMs > 0 && st <= 1 && !dropped) {
        const d = this.repeatHighEndAtMs - nowMs;
        if (d > 1500 && st === 1) label = 'high'; else if (d >= -1500 && d <= 1500) label = 'break';
      }
      // NIVAMINNE (LEVELREF, se flaggan): absolut referens fran refrang 1 i stallet for den troga percentilrangen. Drop vinner alltid.
      if (Analyser.LEVELREF && !dropped) {
        const L = Analyser.LEVELREF; const haveRef = Number.isFinite(this.lastHighDb); const nb = this.secBlkDb.length;
        if ((L & 1) && haveRef && prev !== 'high') {
          const ok = blkDb >= this.lastHighDb - Analyser.LVL_IN_DB && (!(this.lastHighDens > 0) || bKicks >= this.lastHighDens * Analyser.LVL_IN_DENS);
          this.secLvlInRun = ok ? this.secLvlInRun + 1 : 0;
          if (this.secLvlInRun >= Analyser.LVL_IN_RUN) label = 'high';
        } else this.secLvlInRun = 0;
        if ((L & 4) && !this.secHighSeen && prev !== 'high') {
          const D = this.secBlkDb, K = this.secBlkDens, R = Analyser.LVL_IN_RUN, W = 4;
          if (nb >= 10 + R) {
            let mx = -Infinity, acc = 0, mk = 0; const m = nb - R;
            for (let i = 0; i < m; i++) { acc += D[i]; if (i >= W) acc -= D[i - W]; if (i >= W - 1 && acc / W > mx) mx = acc / W; mk += K[i]; } mk /= m;
            const ok = blkDb >= mx + Analyser.LVL_PEAK_DB && bKicks >= mk;
            this.secPeakRun = ok ? this.secPeakRun + 1 : 0;
            if (this.secPeakRun >= R) label = 'high';
          }
        } else this.secPeakRun = 0;
        if ((L & 4) && prev === 'high' && nb < 20 && label === 'intro') label = 'high';   // tidig refrang: rangens 'intro' (< 20 s historik) far inte avbryta
        if ((L & 2) && haveRef) {
          if (this.secLvlOutRun === 0) this.secLvlOutRef = this.lastHighDb;   // frys referensen vid lagkorningens start (lopande medlet dras annars ner av versen)
          const low = blkDb <= this.secLvlOutRef - Analyser.LVL_OUT_DB;
          this.secLvlOutRun = low ? this.secLvlOutRun + 1 : 0;
          if (this.secLvlOutRun >= Analyser.LVL_OUT_RUN && label === 'high') label = prev === 'high' ? 'break' : st === 0 ? 'low' : prev;
        }
      }
      // KLANGMALL UT (bit 512): high som bara halls (rangen sager inte high) men blocket later som icke-refrangen i TEMPL_RUN raka block -> break
      if (Analyser.REPEAT & 512) {
        const verseLike = this.templN >= Analyser.TEMPL_MINN && this.templSimLo - this.templSimHi >= Analyser.TEMPL_MARGIN;
        this.templLoRun = verseLike ? this.templLoRun + 1 : 0;
        if (prev === 'high' && label === 'high' && st < 2 && !dropped && this.templLoRun >= Analyser.TEMPL_RUN) label = 'break';
      }
    }
    else if (dropped || st === 2) label = 'high';
    else if (prev === 'high' && (breaking || rise <= -0.2)) label = 'break';
    else if (this.buildUp > 0.5 || (this.secRiseRun >= 3 && bInt > 0.45)) label = 'build';   // stigning i 3 raka block (15:20: var 1 block -> build/low-flimmer var 4 s)
    else if (st === 0) label = (!this.secHighSeen && sinceStart < 30000) ? 'intro' : (prev === 'break' ? 'break' : 'low');
    else label = (prev === 'intro' && !this.secHighSeen && sinceStart < 30000) ? 'intro' : 'low';
    // UPPEHALLSTID (09-20, forsta forsta hela laten: build/intro/low bytte var 1-3 s): ett byte kravs ha statt >= 4 s i nuvarande
    // sektion, utom in i 'high' (drop/topp ska synas direkt) och ur 'high' till 'break' (svackan ar en flank).
    // uppehallstid 8 s (var 4: build/low/high bytte var 4 s pa pop 14:30), utom in i 'high' (4 s) och high -> break (direkt)
    const dwellMs = label === 'high' ? 4000 : 8000;
    const dwellOk = nowMs - this.sectionStartMs >= dwellMs || (prev === 'high' && label === 'break');
    if (label !== prev && dwellOk) {
      // MINNE: avslutad sektion till loggen (medel-dB, kickar/s); refrangens dB blir referensen for levelVsHighDb.
      const dbMean = this.secCurDbN ? this.secCurDbSum / this.secCurDbN : blkDb;
      this.secLog.push({ label: prev, startMs: this.sectionStartMs, endMs: nowMs, db: dbMean, dens: this.secCurDbN ? this.secCurDens / this.secCurDbN : 0 });
      if (this.secLog.length > 48) this.secLog.shift();
      if (prev === 'high') { this.lastHighDb = dbMean; this.lastHighDens = this.secCurDbN ? this.secCurDens / this.secCurDbN : 0; }
      this.prevSection = prev; this.secCurDbSum = 0; this.secCurDbN = 0; this.secCurDens = 0;
      this.sectionStartMs = nowMs; if (label === 'high') { this.sectionIndex++; this.secHighSeen = true; this.secHiStartMs = nowMs; } this.section = label;
    }
    this.secCurDbSum += blkDb; this.secCurDbN++; this.secCurDens += bKicks;
    if ((Analyser.REPEAT & 768) && this.secBlkHi.length) this.secBlkHi[this.secBlkHi.length - 1] = this.section === 'high' ? 1 : 0;
    if (this.secDump) { const row = [(nowMs - this.secSongStartMs) / 1000, blkDb, bKicks, bCent, bInt, breaking ? 1 : 0, dropped ? 1 : 0]; for (let i = 0; i < 8; i++) row.push(this.secBlkSpec[i] / n); row.push(st, ['intro', 'low', 'build', 'high', 'break'].indexOf(this.section)); this.secDump.push(row); }
    if (this.section === 'high') { this.lastHighDb = this.secCurDbSum / this.secCurDbN; this.lastHighDens = this.secCurDens / this.secCurDbN; }   // pagaende refrang = farskaste referensen
    if (Analyser.HIGH_REF === 'rank' && this.secBlkDb.length >= 20) {
      // HIGH_REF 'rank': referensen ar HIGH_REF_P-percentilen av latens block-dB (finns fran 20 s, oberoende av etiketterna)
      const nn = this.secBlkDb.length, Bf = this.secRefBuf; for (let i = 0; i < nn; i++) Bf[i] = this.secBlkDb[i];
      const sub = Bf.subarray(0, nn); sub.sort();
      this.levelVsHighDb = blkDb - sub[Math.min(nn - 1, Math.floor(Analyser.HIGH_REF_P * nn))];
    } else this.levelVsHighDb = Number.isFinite(this.lastHighDb) ? blkDb - this.lastHighDb : 0;
    this.predictHigh(nowMs, bInt);
    if (this.dbgSecBlock) this.dbgSecBlock({ nowMs, section: this.section, sectionStartMs: this.sectionStartMs, prev, label, bpm: this.localBpm, bInt, bKicks, bCent, blkDb, buildUp: this.buildUp, riseRun: this.secRiseRun, rise, dropped, breaking, tier: this.sectionTier, repeatSim: this.repeatSim, repeatAgoMs: this.repeatAgoMs, repeatSection: this.repeatSection, spec: Array.from(this.secBlkSpec, (v) => v / n), lastHighDb: this.lastHighDb, expectHighMs: this.expectHighMs, expectSource: this.expectSource, beatPhaseMs: this.beatPhaseMs, secLogN: this.secLog.length, secLogLast: this.secLog[this.secLog.length - 1] ?? null, bBon, bBpk, bFlux, bDyn, bHigh, bFlat, pct: this.secPct });
    if (Analyser.REPEAT & 1) { this.repeatStep(nowMs, blkDb, bKicks, bCent, bInt); this.secBlkMs = 0; this.secBlkN = 0; this.secBlkInt = 0; this.secBlkKicks = 0; this.secBlkCent = 0; this.secBlkSpec.fill(0); this.secBlkRms2 = 0; this.secBlkBon = 0; this.secBlkBpk = 0; this.secBlkFlux = 0; this.secBlkRms4 = 0; return; }
    // klangavtryck var 4:e sekund
    let sum = 0; for (let i = 0; i < 8; i++) sum += this.secBlkSpec[i];
    if (Analyser.BOUNDARY_NOV) {
      // Latgrans-nyhet: normerad bandfordelning + centroid, kosinusavstand mot det langsamma referensavtrycket
      const v = this.bndVec; for (let i = 0; i < 8; i++) v[i] = sum > 0 ? this.secBlkSpec[i] / sum : 0; v[8] = bCent;
      let nv = 0; for (let i = 0; i < 9; i++) nv += v[i] * v[i]; nv = Math.sqrt(nv) || 1; for (let i = 0; i < 9; i++) v[i] /= nv;
      if (this.bndRefN === 0) { this.bndRef.set(v); this.boundaryNov = 0; }
      else {
        let dot = 0, rn = 0; for (let i = 0; i < 9; i++) { dot += v[i] * this.bndRef[i]; rn += this.bndRef[i] * this.bndRef[i]; }
        rn = Math.sqrt(rn) || 1; const cos = dot / rn;
        this.boundaryNov = cos >= 1 ? 0 : cos <= 0 ? 1 : 1 - cos;
        const a = 1 / Analyser.BOUNDARY_TAU; for (let i = 0; i < 9; i++) this.bndRef[i] += (v[i] - this.bndRef[i]) * a;
      }
      this.bndRefN++;
    }
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

  /** KLANGMALL (se TEMPL_*). Kors per sektionsblock i rank-laget nar bit 256/512 ar pa, efter att blockets sardrag lagts i secBlkFeat.
   *  Mallar: medel av z-normerade sardrag over block >= 8 s gamla som var refrang (secBlkHi, eller omrankade high vid TEMPL_SRC 'rank')
   *  resp. inte. Nuet = glidande medel over TEMPL_SM block. Kostnad: ~nb x 12 x 3 flops per sekund (nb <= 600). */
  private templStep(nowMs: number): void {
    const D = Analyser.FP2_DIM, F = this.secBlkFeat, nb = F.length, w = Analyser.TEMPL_WV;
    this.templSimHi = 0; this.templSimLo = 0; this.templN = 0;
    if (nb < 20) return;
    const mu = this.templMu, sd = this.templSd; mu.fill(0); sd.fill(0);
    for (let j = 0; j < nb; j++) { const f = F[j]; for (let i = 0; i < D; i++) mu[i] += f[i]; }
    for (let i = 0; i < D; i++) mu[i] /= nb;
    for (let j = 0; j < nb; j++) { const f = F[j]; for (let i = 0; i < D; i++) sd[i] += (f[i] - mu[i]) ** 2; }
    for (let i = 0; i < D; i++) sd[i] = Math.max(1e-3, Math.sqrt(sd[i] / nb));
    // vilka block ar refrang: egna etiketter, eller omrankning (dB + kicktathet mot alla block, percentil >= RANK_HI) vid TEMPL_SRC 'rank'
    let isHi: (j: number) => boolean;
    if (Analyser.TEMPL_SRC === 'rank') {
      const R = this.secRank; const score = (j: number) => (this.secBlkDb[j] - R.md) / R.sd + (this.secBlkDens[j] - R.mk) / R.sk;
      const ss = this.secScoreSorted; ss.length = nb; for (let j = 0; j < nb; j++) ss[j] = score(j); ss.sort((a, b) => a - b);
      const thr = ss[Math.min(nb - 1, Math.floor(Analyser.RANK_HI * nb))];
      isHi = (j) => score(j) >= thr;
    } else isHi = (j) => this.secBlkHi[j] === 1;
    const hi = this.templHi, lo = this.templLo, z = this.templZ; hi.fill(0); lo.fill(0); let nHi = 0, nLo = 0;
    const T = this.secBlkT; const cut = nowMs - 8000;
    const zOf = (j: number, out: Float32Array, add: boolean) => { let nrm = 0; for (let i = 0; i < D; i++) { const v = w[i] * (F[j][i] - mu[i]) / sd[i]; z[i] = v; nrm += v * v; } nrm = Math.sqrt(nrm) || 1; for (let i = 0; i < D; i++) { if (add) out[i] += z[i] / nrm; else out[i] = z[i] / nrm; } };
    for (let j = 0; j < nb; j++) { if (T[j] >= cut) break; if (isHi(j)) { zOf(j, hi, true); nHi++; } else { zOf(j, lo, true); nLo++; } }
    this.templN = Math.min(nHi, nLo);
    if (nHi < 2 || nLo < 2) return;
    // nuet: glidande medel over TEMPL_SM block (ra sardrag), sedan z + enhetslangd
    const S = Math.min(Analyser.TEMPL_SM, nb); const cur = this.templZ; let nrm = 0;
    for (let i = 0; i < D; i++) { let a = 0; for (let j = nb - S; j < nb; j++) a += F[j][i]; const v = w[i] * (a / S - mu[i]) / sd[i]; cur[i] = v; nrm += v * v; }
    nrm = Math.sqrt(nrm) || 1;
    let nh = 0, nl = 0, dh = 0, dl = 0; for (let i = 0; i < D; i++) { nh += hi[i] * hi[i]; nl += lo[i] * lo[i]; dh += cur[i] * hi[i]; dl += cur[i] * lo[i]; }
    this.templSimHi = dh / nrm / (Math.sqrt(nh) || 1); this.templSimLo = dl / nrm / (Math.sqrt(nl) || 1);
  }

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
    const ss = this.secScoreSorted; ss.length = nb; for (let i = 0; i < nb; i++) ss[i] = score(this.secBlkDb[i], this.secBlkDens[i]); ss.sort((a, b) => a - b);
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
      const strict = Analyser.PREDICT_STRICT; const minRise = Analyser.PREDICT_RISE;
      const rising = strict ? (this.secRiseRun >= 3 && (this.buildUp > 0.35 || bInt > 0.55))
        : minRise > 0 ? this.secRiseRun >= minRise : (this.secRiseRun >= 2 || this.buildUp > 0.35 || bInt > 0.55);
      if (!exp && (Analyser.PREDICT_SRC & 2) && rising) {
        const anchor = Analyser.PREDICT_GRID === 'hi' && this.secHiStartMs > 0 ? this.secHiStartMs : this.sectionStartMs;
        const L = Analyser.PREDICT_LAT * barMs;
        const elapsed = nowMs - anchor; const k = Math.ceil((elapsed + barMs) / L);
        const cand = anchor + k * L;
        if (cand - nowMs <= (strict ? 8 : 16) * barMs) { exp = cand; src = 2; }
      }
    }
    // (3) SUG (opt-in PREDICT_DIP): blockets dB >= DIP dB under medianen av de 6 blocken fore, kontexten hog (median >= refrangens dB - 4,
    // utan refrang: alltid) -> high om 2 s; bara pa dykets forsta block, ateraktiveras nar dB ar tillbaka inom DIP/2.
    const dip = Analyser.PREDICT_DIP; const nb = this.secBlkDb.length;
    if (dip > 0 && nb >= 9 && this.section !== 'high') {
      const w = this.secBlkDb.slice(nb - 8, nb - 2).sort((a, b) => a - b); const ref = w[3];
      const loud = !Number.isFinite(this.lastHighDb) || ref >= this.lastHighDb - 4;
      const isDip = loud && this.secBlkDb[nb - 1] <= ref - dip;
      if (isDip && !this.secInDip) this.secDipExpMs = nowMs + 2000;
      if (isDip) this.secInDip = true; else if (this.secBlkDb[nb - 1] >= ref - dip / 2) this.secInDip = false;
    }
    if (dip > 0 && this.secDipExpMs > nowMs - 1000 && this.section !== 'high') { exp = this.secDipExpMs; src = 3; }   // suget vinner: narmast i tid
    if (exp === 0 && this.expectHighMs > 0 && this.section !== 'high' && this.expectHighMs > nowMs - 2000) { exp = this.expectHighMs; src = this.expectSource; }   // hall forutsagelsen tills 2 s efter
    this.expectHighMs = exp; this.expectSource = src;
  }

  /** GRIDFAS (2026-09-20). Bankmaterialets handelseloggar (39 latar med ratt tempo i samma oktav): motorns pulser i fas i 5,
   *  i MOTFAS i 9 (lampan pa off-beaten), resten daremellan. Orsak: motorns PLL initieras pa en kick och slapper bara
   *  in kickar inom +-1/4 slag - ett grid pa attondelsbasen bekraftar sig sjalvt for alltid. Har mats fasen direkt:
   *  vid last tempo laggs slagen ut med alla faser (1 env-sampel = 10 ms) over de senaste ~12 slagen pa BAS-ringen
   *  (kickar) OCH helbandsringen (virvel/hi-hat/gitarr; PC-referensen 09-20: helbandet ar 1,3-1,7x starkare pa slaget an
   *  pa halvslaget i alla grupper, aven dar motorn lag i motfas). Vinnande fas = max av summan av de normerade
   *  medelvardena (max over +-1 sampel, onsets ar nagra sampel breda). Utdata: vaggtiden for det senaste slaget i den
   *  fasen + on/half-kvot. Hysteres: en fas >0,3 slag fran forra estimatet kravs i 3 raka analyser (0,75 s) innan
   *  den tas - annars foljs forra fasen. Kostnad: ~nPh x 12 x 2 uppslag = ~2 000 per anrop, 4 Hz. */
  /** Medianen av de senaste on-beat-kickarnas offset mot ra gridfas, klampt. 0 tills 4 kickar mats. */
  private phaseTrimMs(): number {
    const n = Math.min(this.phaseTrimN, 8);
    if (n < 4) return 0;
    const a = Array.prototype.slice.call(this.phaseTrimRing, 0, n).sort((x: number, y: number) => x - y);
    const m = n & 1 ? a[n >> 1] : (a[(n >> 1) - 1] + a[n >> 1]) / 2;
    const lim = Analyser.GRID_PHASE_TRIM_MS;
    return m > lim ? lim : (m < -lim ? -lim : m);
  }

  /** En detekterad kick bokfors som fasfel mot den RA gridfasen (bara on-beat, |fel| <= 1/4 slag). */
  private phaseTrimSample(kickAtMs: number): void {
    const bpm = this.localBpmF > 0 ? this.localBpmF : this.localBpm;
    if (bpm <= 0 || this.beatPhaseMs <= 0 || kickAtMs <= 0) return;
    const per = 60000 / bpm;
    let d = ((((kickAtMs - this.beatPhaseMs) % per) + per) % per);
    if (d > per / 2) d -= per;
    if (Math.abs(d) > per / 4) return;
    this.phaseTrimRing[this.phaseTrimN % 8] = d; this.phaseTrimN++;
  }

  private computeGridPhase(): void {
    const bpm = this.localBpmF > 0 ? this.localBpmF : this.localBpm;
    if (bpm <= 0 || this.envFilled < 200 || this.envLastWallMs <= 0) { this.beatPhaseMs = 0; this.beatPhaseConf = 0; return; }
    const LEN = Analyser.ENV_LEN, HZ = Analyser.ENV_HZ;
    const Lf = (HZ * 60) / bpm;                                            // period i env-sampel (flyttal)
    const N = Math.min(this.envFilled, Math.round(Lf * 12), 600);         // ~12 slag, hogst 6 s
    if (N < Lf * 4) return;
    const start = (this.envPos - N + LEN) % LEN;
    const bass = this.envBassRing, full = this.envRing;
    let mb = 0, mf = 0; for (let i = 0; i < N; i++) { const j = (start + i) % LEN; mb += bass[j]; mf += full[j]; }
    mb = mb / N || 1e-9; mf = mf / N || 1e-9;
    const at = (ring: Float32Array, i: number): number => {
      const c = ring[(start + i) % LEN]; const a = i > 0 ? ring[(start + i - 1) % LEN] : c; const b = i + 1 < N ? ring[(start + i + 1) % LEN] : c;
      return c > a ? (c > b ? c : b) : (a > b ? a : b);
    };
    const nPh = Math.max(4, Math.min(128, Math.round(Lf))); const scores = this.phaseScratch, sB = this.phaseScratchB, sF = this.phaseScratchF; let bestPh = 0, bestS = -1;
    for (let p = 0; p < nPh; p++) {
      const ph = (p * Lf) / nPh; let sb = 0, sf = 0, n = 0;
      for (let x = ph; x < N; x += Lf) { const i = Math.round(x); if (i >= N) break; sb += at(bass, i); sf += at(full, i); n++; }
      sB[p] = n ? sb / n / mb : 0; sF[p] = n ? sf / n / mf : 0;
      const sc = sB[p] + sF[p]; scores[p] = sc;
      if (sc > bestS) { bestS = sc; bestPh = p; }
    }
    if (Analyser.GRID_PHASE_MODE === 'bass') {
      // BASEN FORST (09-20, Tequila/hardstyle): helbandet domineras av leads/skrik pa off-beaten och rostade ner kicken;
      // basringen (kick) har fasen nar den ar tydlig. Tvetydig bas (kvot < BASS_MIN) -> summan som forr.
      let bb = 0; for (let p = 1; p < nPh; p++) if (sB[p] > sB[bb]) bb = p;
      const ba = (bb + (nPh >> 1)) % nPh;
      if (sB[ba] > 1e-6 && sB[bb] / sB[ba] >= Analyser.GRID_PHASE_BASS_MIN) { bestPh = bb; bestS = scores[bb]; }
    }
    const anti = (bestPh + (nPh >> 1)) % nPh; const conf = scores[anti] > 1e-6 ? bestS / scores[anti] : 9;
    this.dbgPhase.conf = conf; this.dbgPhase.bassOn = sB[bestPh]; this.dbgPhase.bassAnti = sB[anti]; this.dbgPhase.fullOn = sF[bestPh]; this.dbgPhase.fullAnti = sF[anti]; this.dbgPhase.bestPh = bestPh; this.dbgPhase.nPh = nPh; this.dbgPhase.pending = this.phaseAnti;
    const ph0 = (bestPh * Lf) / nPh; const kLast = Math.floor((N - 1 - ph0) / Lf); const iLast = ph0 + kLast * Lf;
    const beatMs = this.envLastWallMs - (N - 1 - iLast) * (1000 / HZ);
    const per = 60000 / bpm;
    if (this.phaseLastBeatMs > 0) {
      const d = ((((beatMs - this.phaseLastBeatMs) % per) + per) % per) / per; const err = d < 0.5 ? d : d - 1;
      if (Math.abs(err) > 0.3) {
        // forra fasens poang i dagens matning: fasbinet narmast forra slaget
        const prevPh = ((((this.phaseLastBeatMs - this.envLastWallMs) / (1000 / HZ)) % Lf) + Lf) % Lf;   // env-sampel-offset for forra fasen
        const prevBin = Math.round((prevPh / Lf) * nPh) % nPh; const prevScore = scores[prevBin];
        const strongEnough = prevScore <= 1e-6 || bestS >= prevScore * Analyser.STICKY_K;
        if (!strongEnough || ++this.phaseAnti < Analyser.STICKY_N) {
          // hall forra fasen: rapportera senaste slaget i DEN fasen (sa foljaren inte ser ett hopp)
          const kPrev = Math.round((beatMs - this.phaseLastBeatMs) / per); const held = this.phaseLastBeatMs + kPrev * per;
          this.phaseLastBeatMs = held; this.beatPhaseMs = held; this.beatPhaseConf = prevScore > 1e-6 ? prevScore / Math.max(1e-6, scores[(prevBin + (nPh >> 1)) % nPh]) : conf;
          if (!strongEnough) this.phaseAnti = 0;
          return;
        }
      }
      this.phaseAnti = 0;
    }
    this.phaseLastBeatMs = beatMs; this.beatPhaseMs = beatMs; this.beatPhaseConf = conf;
  }

  /** Env-steget (100 Hz): tempo pa stride + gridfas. Kors i 'all' direkt och i 'slow' per record. */
  private envStep(): void {
    // Innan lås: räkna på varje ny envelope-sample (100 Hz) för snabbast första estimat.
    // Efter lås: 4 Hz räcker gott — sparar CPU och förfinar med median. (Mätt 2026-08-09: computeBpm ~470 µs,
    // scoreEnv 201 µs x 2; 20 Hz olast = ~10 % av en Zero 2 W-karna -> 10 Hz efter 1,5 s utan las.)
    const stride = this.localBpm !== 0 ? Analyser.ENV_HZ / 4
      : this.envFilled < 150 ? 1 : 10;
    if (++this.bpmCounter >= stride) { this.bpmCounter = 0; this.computeBpm(); if (Analyser.GRID_PHASE_ON && this.localBpm > 0) this.computeGridPhase(); }
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
    const beats2s = (this.localBpm > 0 ? this.localBpm : 120) / 30;
    const opb = n / beats2s;
    this.bassOnsetsPerBeat = opb;
    const raw = Math.max(0, Math.min(1, (opb - 0.4) / 0.8));
    this.profBassline += (raw - this.profBassline) * 0.01;
  }

  /** Roll 'all': sektionsblocket ur samma aggregat som workern far (se secAgg). */
  private sectionFlushAgg(): void {
    const g = this.secAgg; if (!Analyser.SECTION_ON || g.n === 0) return;
    this.sectionHop(g.n, g.int, g.kicks, g.breaking > 0, g.wall, g.dt, g.rms2, g.cent, g.spec, 0, g.bon, g.bpk, g.flux, g.rms4);
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
    else { r[o + R_DROPS] = this.dropCount; r[o + R_ACTIVE] = this.activeMs; r[o + R_BUILD] = this.buildUp; }
    r[o + R_FLAGCNT] = packFlagCounts(this.flagCnt);
    r[o + R_SEQ] = seq;                                    // sist: seq = recordet ar komplett
    g.n = 0; g.int = 0; g.kicks = 0; g.breaking = 0; g.rms2 = 0; g.cent = 0; g.dt = 0; g.spec.fill(0); g.bon = 0; g.bpk = 0; g.flux = 0; g.rms4 = 0;
    this.pendFlags = 0;
    Atomics.store(ctrl, C_WRITE, seqLow(seq));             // laga 32 bitarna; workern rekonstruerar via seqDelta (wrap-sakert)
    if (Atomics.load(ctrl, C_WAITING)) Atomics.notify(ctrl, C_WRITE, 1);   // Dekker: workern satter C_WAITING fore wait-jamforelsen
    if (this.inlinePeer) { this.inlinePeer.drainRecords(); this.pullSlowState(); }   // inline-lage (korbank): synkront har, tillstandet hamtas direkt
  }
  /** Hamta tempo/gridfas/sektion ur tillstandsblocket (varje hop, ~20 doubles). Aldre an barrierSeq ignoreras. */
  private pullSlowState(): void {
    if (!stateRead(this.splitCtrl!, this.splitState!, this.stateCopy)) return;
    const s = this.stateCopy; if (s[S_REC_SEQ] < this.barrierSeq) return;
    this.localBpm = s[S_BPM]; this.localBpmConfidence = s[S_CONF]; this.localBpmF = s[S_BPMF];
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
      this.slowStep(o); this.slowLastCnt = r[o + R_FLAGCNT];
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
    }
    return n;
  }
  /** Snabba sidans kommandon i exakt den ordning de restes (virtuell klocka forst: den nollar ankare som resten skriver). */
  private applyFlags(flags: number, hintMs: number, vclock: number): void {
    if (flags & F_VCLOCK_NULL) this.setVirtualClock(null); else if (flags & F_VCLOCK_SET) this.setVirtualClock(vclock);
    if (flags & F_RESET_TEMPO) this.resetTempo();
    if (flags & F_HINT) this.hintTrackChange(hintMs);
    if (flags & F_RESET_BAR) this.resetBar();
    if (flags & F_SIL350) {
      this.localBpmConfidence = 0; this.clearLockVotes();
      this.envFilled = 0; this.beatAnchorMs = 0; this.beatPhaseMs = 0; this.beatPhaseConf = 0; this.phaseLastBeatMs = 0; this.phaseAnti = 0; this.phaseTrimN = 0;
      this.bpmHistLen = 0; this.bpmHistPos = 0; this.lastVoteMs = 0;
      for (let i = 0; i < this.tempoGram.length; i++) this.tempoGram[i] *= 0.5;
      this.barAcc.fill(0); this.barCount = 0;
    }
    if (flags & F_SIL10) { this.localBpm = 0; this.tempoGram.fill(0); }
  }
  /** Ett record = ett env-sampel: flaggor i ordning, ringvardena, snabba sidans fakta, env-steget, sektionsblocket. */
  private slowStep(o: number): void {
    const r = this.splitRing!;
    this.applyFlags(r[o + R_FLAGS], r[o + R_HINT_MS], r[o + R_VCLOCK]);
    this.virtualMs = r[o + R_PERF];                        // perfNow() = snabba tradens tid vid sampeln (deterministiskt)
    this.envRing[this.envPos] = r[o + R_ENV]; this.envBassRing[this.envPos] = r[o + R_BASS];
    if (HIGH_ON) this.envHighRing[this.envPos] = r[o + R_HIGH];
    this.envPos = (this.envPos + 1) % Analyser.ENV_LEN;
    this.envLastWallMs = r[o + R_WALL];
    this.envFilled = Math.min(this.envFilled + 1, Analyser.ENV_LEN);
    const secN = Analyser.SECTION_ON && r[o + R_SEC_N] > 0;
    if (!SECTION_AGG_HOP || secN) { this.dropCount = r[o + R_DROPS]; this.activeMs = r[o + R_ACTIVE]; this.buildUp = r[o + R_BUILD]; }
    this.envStep();
    if (secN)
      this.sectionHop(r[o + R_SEC_N], r[o + R_SEC_INT], r[o + R_SEC_KICKS], r[o + R_SEC_BREAK] > 0, r[o + R_SEC_WALL], r[o + R_SEC_DT], r[o + R_SEC_RMS2], r[o + R_SEC_CENT], r, o + R_SEC_SPEC0, r[o + R_SEC_BON], r[o + R_SEC_BPK], r[o + R_SEC_FLUX], r[o + R_SEC_RMS4]);
  }

  /** Sparets tid (s sedan den virtuella epoken) och VETO_WIN-fonstret (diagnostik, bara med sparflaggor). */
  private traceT(): number { return (this.wallNow() - 1700000000000) / 1000; }
  private traceWin(): boolean { if (!VETO_WIN) return false; const [wa, wb] = VETO_WIN.split(',').map(Number); const tt = this.traceT(); return tt >= wa && tt <= wb; }
  private computeBpm() {
    const _b0 = this.localBpm; this._why = "";
    if (this.envFilled < 50) return;   // ~0.5s → snabbt första grovestimat (täcker ≥~122 BPM;
                                       //  långsammare spår låser på overton tills fönstret växer),
                                       //  förfinas löpande. Halverar time-to-first-lock.
    const N = this.envFilled;
    const HZ = Analyser.ENV_HZ;
    const lagMin = Math.floor(HZ * 60 / 185);
    // MINST HALVA FONSTRET SOM OVERLAPPNING. `ac[lag] = sum / M` med M = N - lag
    // tar bort BIAS, men lamnar en VARIANS-gradient: vid lag nara N bygger
    // estimatet pa nagra fa produkter (vid forsta laset ar N = 50, sa lag 49 gav
    // EN enda produkt) och blir kraftigt brusigt utan att viktas ner — vilket
    // gynnar langa lag, dvs langsamma tempon. N>>1 stanger det.
    // Sokfonstret ar fortfarande bredare an vikningen med flit.
    // TEMPO_LAGMAX 'full' (aldre vagen) tillater lag upp till N - 1.
    const lagMax = Math.min(TEMPO_LAGMAX === 'full' ? N - 1 : N >> 1, Math.floor(HZ * 60 / 55));
    if (HIGH_ON) {
      this._eHigh = this.scoreEnv(this.envHighRing, N, this.scoreHigh, lagMin, lagMax);
      let bl = lagMin, bv = -1; for (let l = lagMin; l <= lagMax; l++) if (this.scoreHigh[l] > bv) { bv = this.scoreHigh[l]; bl = l; }
      this._hiTop = (Analyser.ENV_HZ * 60) / bl; this._hiVal = bv;
    }
    // FLERBANDS-ONSET: helbandsfluxen smetas ut av sång och synth — slaget bor i
    // basen. Två OBEROENDE score-kurvor som röstar ihop rättar just de fall där
    // off-beat-testet annars tvekar mellan ballad och danslåt. Helbandet scoras
    // SIST eftersom scratcharna (env/envPos) används nedan.
    const eBass = this.scoreEnv(this.envBassRing, N, this.scoreBass, lagMin, lagMax);
    const eFull = this.scoreEnv(this.envRing, N, this.scoreFull, lagMin, lagMax);
    const vetoWin = BPM_TRACE || HIGH_DIAG ? this.traceWin() : false;
    if (BPM_TRACE && vetoWin) console.log(`[eh] t=${this.traceT().toFixed(1)} eHigh=${this._eHigh.toFixed(4)} eFull=${eFull.toFixed(4)} eBass=${eBass.toFixed(4)} mode=${HIGH_VOTE}`);
    if (HIGH_DIAG && vetoWin) {
      let fl = lagMin, fv = -1; for (let l = lagMin; l <= lagMax; l++) if (this.scoreFull[l] > fv) { fv = this.scoreFull[l]; fl = l; }
      console.log(`[hi] t=${this.traceT().toFixed(1)} lock=${this.localBpm} HIGH top=${this._hiTop.toFixed(0)} val=${this._hiVal.toFixed(3)} | FULL top=${((Analyser.ENV_HZ * 60) / fl).toFixed(0)} val=${fv.toFixed(3)}`);
    }
    // DISKANTROST (<prefix>HIGH_VOTE 'always' | 'cond' | 'sharp'; av i standard): diskantringen far vikt i tempogrammet.
    let wHigh = 0;
    const hvUnstable = this.bpmStable === 0 || this.localBpmConfidence < HIGH_COND_CONF;
    if (HIGH_VOTE && this._eHigh > 0 && (HIGH_VOTE === 'always' || (HIGH_VOTE === 'cond' && hvUnstable))) wHigh = HIGH_W;
    if (eFull <= 0 && eBass <= 0 && wHigh <= 0) return;
    const wBass = eBass > eFull * 0.15 ? 0.55 : 0;   // tomt basband → helbandet ensamt
    const wFull = 1 - wBass;
    let wF = wFull, wB = wBass, wH = wHigh;
    const sharp = HIGH_VOTE === 'sharp' && this._eHigh > 0 && (!HIGH_SHARP_COND || hvUnstable);
    if (sharp) {
      const k = HIGH_K;
      const sF = this.sharpOf(this.scoreFull, lagMin, lagMax), sB = wBass > 0 ? this.sharpOf(this.scoreBass, lagMin, lagMax) : 0, sH = this.sharpOf(this.scoreHigh, lagMin, lagMax);
      wF = Math.pow(sF, k); wB = Math.pow(sB, k); wH = Math.pow(sH, k);
      if (HIGH_CAP) { const cap = Number(HIGH_CAP); const tot = wF + wB + wH; if (tot > 0 && wH / tot > cap) wH = cap * (wF + wB) / (1 - cap); }
      if (BPM_TRACE && vetoWin && ((this.traceT() * 10) | 0) % 8 === 0)
        console.log(`[sharp] t=${this.traceT().toFixed(1)} sF=${sF.toFixed(2)} sB=${sB.toFixed(2)} sH=${sH.toFixed(2)} -> wF=${(wF / (wF + wB + wH)).toFixed(2)} wB=${(wB / (wF + wB + wH)).toFixed(2)} wH=${(wH / (wF + wB + wH)).toFixed(2)}`);
    }
    // Normerad blandning bara nar diskantrosten ar med (annars exakt wFull*F + wBass*B som alltid).
    const mixN = wH !== 0 || sharp; const wNorm = wF + wB + wH;
    // TEMPOGRAM-ACKUMULERING: förr kastades hela score-kurvan varje anrop och bara
    // toppen sparades, varpå medianen fick städa upp efteråt (~5 s till lås). Nu
    // EMA:as HELA lag-kurvan mellan anrop, så bevis ackumuleras där det hör hemma:
    // låset kommer på 1–2 s och oktav-flippar dör innan de hinner synas.
    const underChallenge = TG_ADAPT && (this.newSongVote > 500 || this.localBpmConfidence < 0.6);
    const a = this.localBpm === 0 ? 0.30 : (underChallenge ? TG_ADAPT_A : 0.15);
    const tg = this.tempoGram;
    this.diagLagMin = lagMin; this.diagLagMax = lagMax;
    let bestLag = 0, bestVal = 0, scoreSum = 0, scoreCount = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const s = mixN ? (wF * this.scoreFull[lag] + wB * this.scoreBass[lag] + wH * this.scoreHigh[lag]) / wNorm : wFull * this.scoreFull[lag] + wBass * this.scoreBass[lag];
      const v = tg[lag] + (s - tg[lag]) * a;
      tg[lag] = v;
      scoreSum += v; scoreCount++;
      if (v > bestVal) { bestVal = v; bestLag = lag; }
    }
    const envPos = this.envPosScratch;   // helbandets rektifierade envelope (scoreEnv körde sist)
    this.dbgBestLag = bestLag; this.dbgLagMin = lagMin; this.dbgLagMax = lagMax;

    // ── EVIDENSVAL (2026-09-19) ───────────────────────────────────────────────
    // Rapporten "Tio latar mot referens" (bankmaterial med PC-referensen): argmax pa tempogrammet gav ratt tempo i
    // 3 av 10 - fantomer 3/2 och 4/3 i fyra, grannfel 7/6 i tva. Kamfiltret har sub-harmoniska toppar
    // (var annan/tredje tand traffar ett slag) och priorn drar mot 120; toppens HOJD sager inte om
    // slagen sitter pa kickarna. Har ar tempogrammet KANDIDATGENERATOR: topp-K lokala maxima, och
    // varje kandidats slag laggs ut pa BAS-onset-envelopen (kickar, inte hi-hats). Vinnaren ar den
    // vars slag traffar kickarna; tie inom 10 % -> hogre tempogramvarde. Samma metod som PC-referensen
    // (6/6 pa syntet dar librosas default gav 2/6). Korbank: banken (bench.mjs).
    // Oktaven lamnas at vikningen (80..160) - under den ar alla fel icke-oktav-fantomer.
    if (Analyser.EVIDENCE_ON || Analyser.HMM_ON) {
      const K = Analyser.EVIDENCE_K; const cL = this.candLag, cV = this.candVal, cS = this.candScore, cH = this.candHalf; let nc = 0;
      for (let lag = lagMin + 1; lag < lagMax; lag++) {
        const v = tg[lag];
        if (v <= 0 || v < tg[lag - 1] || v < tg[lag + 1]) continue;                  // lokalt maximum
        let dup = false;
        for (let i = 0; i < nc; i++) if (Math.abs(lag / cL[i] - 1) < 0.03) { if (v > cV[i]) { cV[i] = v; cL[i] = lag; } dup = true; break; }
        if (dup) continue;
        if (nc < K) { cL[nc] = lag; cV[nc] = v; nc++; }
        else { let mi = 0; for (let i = 1; i < K; i++) if (cV[i] < cV[mi]) mi = i; if (v > cV[mi]) { cL[mi] = lag; cV[mi] = v; } }
      }
      // OKTAVPARTNER (09-20): tempogrammet la "To Keep from Missing You" (referens 160,7) pa lag 75 = 80 BPM (tg 0,53)
      // med 160 pa bara 0,2 - 160 fanns inte bland kandidaterna alls, sa varken evidensval eller foljare KUNDE
      // valja den (gamla vagen fick 159,8 av vikningens kant: 79,9 < 80 -> x2, tur). Varje kandidats L/2 och 2L
      // laggs darfor till (inom fonstret, tak 8), sa slagpoang och halvslagsbevis raknas for bada oktaverna.
      const nc0 = nc;
      for (let i = 0; i < nc0 && nc < 8; i++) for (const L2 of [cL[i] >> 1, cL[i] * 2]) {
        if (L2 < lagMin || L2 > lagMax) continue;
        let dup = false; for (let j = 0; j < nc; j++) if (Math.abs(L2 / cL[j] - 1) < 0.03) { dup = true; break; }
        if (!dup) { cL[nc] = L2; cV[nc] = tg[L2] > 0 ? tg[L2] : 0; nc++; }
      }
      if (nc > 0) {
        let bi = -1, bs = -1;
        if (Analyser.EVID_BAND === 'both') {
          // bas + helband: bada normeras mot sin egen medelpoang sa de ar jamforbara, helbandet vagt EVID_FULL_W.
          let mb = 0, mf = 0; const fS = this.candFull;
          for (let i = 0; i < nc; i++) { const rb = this.alignScore(this.envBassRing, N, cL[i]); const rf = this.alignScore(this.envRing, N, cL[i]); cS[i] = rb.score; fS[i] = rf.score; cH[i] = rb.half; mb += rb.score; mf += rf.score; }
          mb = mb / nc || 1; mf = mf / nc || 1;
          for (let i = 0; i < nc; i++) { cS[i] = (cS[i] / mb + Analyser.EVID_FULL_W * (fS[i] / mf)) / (1 + Analyser.EVID_FULL_W) * mb; if (cS[i] > bs) { bs = cS[i]; bi = i; } }
        } else
        for (let i = 0; i < nc; i++) { const r = this.alignScore(this.envBassRing, N, cL[i]); cS[i] = r.score; cH[i] = r.half; if (r.score > bs) { bs = r.score; bi = i; } }
        for (let i = 0; i < nc; i++) if (i !== bi && cS[i] >= bs * 0.9 && cV[i] > cV[bi] * 1.15) { bi = i; bs = cS[i]; }
        let second = 0; for (let i = 0; i < nc; i++) if (i !== bi && cS[i] > second) second = cS[i];
        this.evidenceScore = bs; this.evidenceHalf = cH[bi]; this.evidenceCands = nc; this.evidenceSecond = second;
        if (Analyser.EVIDENCE_ON) { bestLag = cL[bi]; bestVal = tg[bestLag]; }
      }
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
    // BPM-FILTER: vik in i 80..160 (exakt en oktav → UNIK representant). Sökningen
    // (lagMin/lagMax) täcker 55..185, så vikningen tar kanterna: under 80 dubbleras,
    // från 160 halveras. Vilken oktav som gäller avgörs av off-beat-testet ovan och
    // oktavgrenarna nedan (symmetriska, 8/8).
    // Terminering kräver MAX >= 2*MIN; med t.ex. 90..170 blir 175 -> 87.5 -> 175 -> 87.5
    // i all evighet och motorn hänger.
    while (bpm < Analyser.BPM_MIN) bpm *= 2;
    while (bpm >= Analyser.BPM_MAX) bpm /= 2;
    this.rawBpmLast = bpm;

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
    // UPPVARMNING FORE FORSTA LASET. Tidigare togs laset pa det ALLRA forsta
    // estimatet, nar tempogrammet sett ~0.5 s och ar omoget -- och sedan stanger
    // commiten (24 estimat) oktav- och grannrattningen, sa ett daligt initiallas
    // satt kvar hela laten. Det var orsaken till 4/3-felen.
    // MATT pa 7 Ledin-latar med publicerat referens (SongBPM):
    //   utan uppvarmning  4/7 ratt, snitt 56.2 %, TVA 4/3-fel
    //   WARM_N = 24       6/7 ratt, snitt 78.5 %, NOLL 4/3-fel
    //   "En del av mitt hjarta" 130 -> 99 (referens 98)
    //   "Hon gor allt..."       137 -> 105 (referens 104)
    // Kostar 240 ms laslatens (499 -> 739 ms). Syntetsviten oforandrad 7/10.
    if (!Analyser.EVIDLOCK_ON && !Analyser.HMM_ON) {   // ── LASAPPARATEN (rost-median, glid, oktavroster, grannrattning, latbytesvakt) ──
    if (this.localBpm === 0 && this.warmCalls++ < Analyser.WARM_N) return;
    // ── EVIDENSOMLASNING (2026-09-19) ─────────────────────────────────────────
    // Korbanken visade ra-estimatet RATT i 8/8 med evidensvalet (92,3 for 92, 122,4 for 123 ...) medan det
    // LASTA vardet satt kvar pa det forsta felet (133 vid t=5 s): commiten stanger oktav-/grannrattningen
    // och "overwhelming" mater tempogrammets HOJD, inte slagpoangen. Har: ihallande (EVID_RELOCK_N anrop),
    // sammanhallen (inom 4 %) och tydlig (poang >= 1,15 x tvaan) evidens for ett annat tempo (> 11 % fran
    // laset) laser om - aven efter commit. Flat basring (breakdown, inga kickar) ger ingen marginal -> ingen
    // omlasning; lasets egen historik toms sa medianen inte drar tillbaka.
    if (Analyser.EVIDENCE_ON && this.localBpm > 0 && this.evidenceCands >= 1) {
      // Kandidaterna ar oftast GRANNAR till ratt tempo (89-107 med poang 2,0-2,5), sa marginalen mellan dem
      // sager lite. Jamfor i stallet vinnaren med LASETS egen slagpoang: ar laset en fantom (133 mot 92)
      // traffar dess slag kickarna tva ganger av tre och far klart lagre poang.
      const off = Math.abs(bpm / this.localBpm - 1) > 0.11;
      let worse = false;
      if (off) {
        const lockLag = Math.round((HZ * 60) / this.localBpm);
        const ls = this.alignScore(this.envBassRing, N, lockLag).score;
        this.evidenceLockScore = ls;
        worse = this.evidenceScore >= ls * 1.25;
      }
      if (worse && (this.evidRelockBpm === 0 || Math.abs(bpm / this.evidRelockBpm - 1) <= 0.04)) {
        this.evidRelockBpm = this.evidRelockBpm === 0 ? bpm : this.evidRelockBpm + (bpm - this.evidRelockBpm) * 0.3;
        if (++this.evidRelockVotes >= Analyser.EVID_RELOCK_N) {
          this._why = "EVIDENCE";
          this.localBpm = Math.round(this.evidRelockBpm);
          this.bpmHistLen = 0; this.bpmHistPos = 0;
          this.nearVote = 0; this.nearChallenger = 0; this.octaveVote = 0; this.bpmStable = 0; this.newSongVote = 0;
          this.evidRelockVotes = 0; this.evidRelockBpm = 0; this.evidenceRelocks++;
        }
      } else if (this.evidRelockVotes > 0) { this.evidRelockVotes = Math.max(0, this.evidRelockVotes - 2); if (this.evidRelockVotes === 0) this.evidRelockBpm = 0; }
    }
    if (this.localBpm === 0) {
      this._why = "FIRST";
      this.localBpm = Math.round(med);
      this.octaveVote = 0;
      this.bpmStable = 0;
    } else {
      // SJÄLVRÄTTANDE OKTAV: håll nuvarande takt för stabilitet, MEN om estimaten
      // ihållande pekar på en annan oktav (½× eller 2×) → byt efter ~2s bevis, så
      // en halvtempo-låsning "ökar" till rätt takt istället för att fastna. Ett
      // enstaka breakdown hinner inte nå tröskeln → ingen flimrig växling.
      // COMMIT: efter ~6s STABIL lås (24 finjusterings-estimat @4Hz) LÅSES oktaven —
      // bara finjustering tillåts, aldrig ½×/2× mitt i en låt (en låt byter inte
      // oktav; halvering nollade takt-gridet & bröt beat-synken).
      // OBS: fönstret för självrättning är nu ~6s, inte 15s. Ett felaktigt initiallås
      // som INTE ligger i glid-bandet hinner alltså inte alltid rättas här — därför
      // är `committedNow` (låtbytesvakten) sänkt till SAMMA 24. Annars uppstod ett
      // dödläge: oktav-/grannrättning stängd vid 24 medan `bpmStable` bara växer i
      // glid-grenen ⇒ ett lås 33 % fel (t.ex. 90 mot verkligt 120) kunde inte lämnas
      // förrän tystnad. Konfidenssläppningen sist i denna metod är andra utvägen.
      const committed = this.bpmStable >= Analyser.BPM_COMMIT;
      const ratio = med / this.localBpm;
      const _lockLag = Math.round((HZ * 60) / this.localBpm);
      const overwhelming = _lockLag >= lagMin && _lockLag <= lagMax
        && bestVal > tg[_lockLag] * Analyser.RELOCK_K;
      if (ratio >= 0.9 && ratio <= 1.11) {
        this.nearVote = 0; this.nearChallenger = 0;                                 // samma takt → inget grann-fel
        this._why = "glide";
        this.localBpm = Math.round(this.localBpm + (med - this.localBpm) * 0.35);   // samma takt → glid
        this.octaveVote *= 0.5;
        // Referens för hur STARK takten är när allt är gott — låtbytesgrinden nedan
        // jämför mot den (ett breakdown har svag takt, en ny låt en full).
        this.lockPeak = this.lockPeak > 0 ? this.lockPeak + (bestVal - this.lockPeak) * 0.05 : bestVal;
        // HALL COMMITEN OPPEN TILLS ONSET-RINGEN AR REN.
        // Ringen ar ENV_LEN = 500 @ 100 Hz = 5 SEKUNDER lang, sa direkt efter ett
        // latbyte bestar halva autokorrelationen av FORRA laten. `committed`
        // (bpmStable >= 24, ca 6 s) stanger oktav- och grannrattningen ungefar
        // samtidigt som ringen blir ren -- ett las taget pa orenad data hann alltsa
        // aldrig rattas.
        // Att fordroja LASET provades och lamnar lampan osynkad flera sekunder.
        // Att fordroja COMMITEN ger tvartom omedelbart las som anda far rattas.
        // MATT pa 12 latovergangar: overhangets kostnad 60.7 -> 72.0 %.
        // "Snart tystnar musiken" gick 0 -> 79 %. Stabil plata 50..400, alltsa
        // ingen knivsegg -- 50 valt som kortaste vardet som nar platan.
        // Laslatens oforandrad (739 ms), syntetsviten oforandrad 7/10.
        if (this.holdCalls < Analyser.HOLD_N) this.holdCalls++;
        else if (this.bpmStable < 100000) this.bpmStable++;                              // stabil tid ackumuleras
      // Overvaldigande HELHETSBEVIS far bryta commiten. Manga latar byter
      // trumkomp mellan avsnitt -- MATT pa "Where the Wild Things Are" (referens 117):
      // bevisen vaxlar 115-115-115-78-78-117-78x8-79-117-117, och 78 ar exakt
      // 117 * 2/3. Analysatorn har inte fel i de avsnitten; ljudet HAR den
      // periodiciteten. Felet var att laset foljde AVSNITTET i stallet for LATEN.
      // Tempogrammet ackumulerar over hela laten och ar darfor latens svar.
      // MATT: slutlaset (det varde som galler resten av laten) 109/110 -> 110/110.
      } else if ((!committed || overwhelming) && ratio > 1.4) {
        this.octaveVote = Math.max(0, this.octaveVote) + 1;                          // estimaten HÖGRE oktav
        if (this.octaveVote >= Analyser.OCT_UP) { this._why = "OCT-UP"; this.localBpm = Math.round(med); this.octaveVote = 0; this.bpmStable = 0; }
      } else if ((!committed || overwhelming) && ratio < 0.7) {
        this.octaveVote = Math.min(0, this.octaveVote) - 1;                          // estimaten LÄGRE oktav
        if (this.octaveVote <= -(this.subhSuspect(med) ? Analyser.OCT_DOWN * SUBH_MULT : Analyser.OCT_DOWN)) { this._why = "OCT-DOWN"; this.localBpm = Math.round(med); this.octaveVote = 0; this.bpmStable = 0; }

      } else if (!committed) {
        // GRANNRÄTTNING: ett tidigt lås från 0.5 s fönster kan hamna 10-20 % fel
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
        // INGEN riktnings-asymmetri här (till skillnad från OCT_UP/OCT_DOWN):
        // PROVAT 2026-08-30 att kräva dubbla röster nedåt (och 1.5×). Det är ett
        // GRANN-fel på 10–30 %, inte ett oktavfel — den vanligaste nedåträttningen är
        // "122 låst mot verkligt 136", alltså precis den rättning vi vill ha. MÄTT
        // över 8 seeder: dubbla röster nedåt sänkte brusigt rum 45 % → 31 % och
        // shuffle 29 % → 16 %, utan att ge något tillbaka (OCT_DOWN ensamt räddade
        // både svag bas 132 och breakdown 142). Symmetriskt behålls.
        const reacq = voteNow < this.reacqUntilMs;
        if (conf < (reacq ? 0.55 : 0.75)) {
          this.nearVote = 0; this.nearChallenger = 0;
        } else if (this.nearChallenger > 0 && Math.abs(bpm / this.nearChallenger - 1) <= 0.04) {
          this.nearChallenger += (bpm - this.nearChallenger) * 0.3;
          this.nearVote++;
          // HARMONI-VETO. Grann-bandet [1.11,1.4] rymmer 4/3 = 1.333, och [0.7,0.9]
          // rymmer 3/4 = 0.75 -- alltsa gar en TRIOLTOPP in genom halet som ar avsett
          // for grannfel, pa atta roster. Och `conf` stoppar den inte: den mater
          // tempogrammets SKARPA, inte dess korrekthet, och ar 1.00 aven vid 32 % fel.
          // MATT pa utandig.wav (Ricky Rose, referens 90 BPM): laset satt RATT i 20 s,
          // gick sedan 90 -> 118 och kom aldrig tillbaka. Vetot: 25.0 % -> 70.6 %
          // ratt, median 119 -> 89. Ovriga tva klipp ororda, syntetsviten identisk.
          // Straffet platar vid 4; 6 ar mitten av platan 4-10.
          // 3/2 och 2/3 behovs inte har -- de ligger utanfor bandet (oktavgrenarna).
          const _harm = Math.abs(ratio * 0.75 - 1) <= Analyser.HARM_TOL
                     || Math.abs(ratio / 0.75 - 1) <= Analyser.HARM_TOL;
          if (this.nearVote >= (reacq ? NEAR_REACQ : 8) * (_harm ? Analyser.HARM_PENALTY : 1) * (this.subhSuspect(med) ? SUBH_MULT : 1)) {
            this._why = "NEAR";
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
      // SAMMA tröskel som oktav-commiten: låtbytesvakten måste öppna i exakt samma
      // stund som oktav-/grannrättningen stänger, annars finns ett fönster där låset
      // inte kan lämnas alls (se dödlägesnoten vid `committed` ovan).
      const committedNow = this.bpmStable >= Analyser.BPM_COMMIT;
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
        // HAR SATT TIDIGARE ETT HARMONI-VETO. BORTTAGET 2026-09-01.
        // Det mattes till NOLL effekt nar det lades in, och visade sig sedan vara
        // aktivt skadligt: "LINEDANCE" (referens 145) har 26 s tvetydigt intro dar
        // bevisen pekar pa 90-100 och laset committar pa 96; forst vid 28 s
        // framtrader ratt tempo (146.3 @0.77, 3.5x starkare an 96.8). Kvoten
        // 146/96 = 1.52 ligger 1.3 % fran 3/2, sa vetot hojde beviskravet fran
        // 4 s till 24 s -- omojligt att na. Vetot i GRANNRATTNINGEN ar validerat
        // (+45 procentenheter) och star kvar; bara den har vagen tas bort.
        const needMs0 = rival > 2.5 ? 1500 : rival > 1.6 ? 4000 : 25000;
        // Provrattar (inerta i standard): DEADBEAT = dott las (ra ac vid lasets lag < DEADBEAT_TH) slapps pa DEADBEAT_MS,
        // CONFBLEED = lag konfidens halverar 25 s-kravet, SUBH_GUARD = 2/3-kandidat kraver 4x, GHOST_WAIT = 2/3-fantom vantar.
        let needMs1 = needMs0;
        const rawLockNow = (lockLag >= lagMin && lockLag <= lagMax) ? this.acScratch[lockLag] : 0;
        if (DEADBEAT && needMs1 === 25000 && rawLockNow < DEADBEAT_TH) needMs1 = DEADBEAT_MS;
        if (CONFBLEED && needMs1 === 25000 && this.localBpmConfidence < 0.6) needMs1 = 12500;
        if (BPM_TRACE && this.traceWin())
          console.log(`[ns] t=${this.traceT().toFixed(1)} lock=${this.localBpm} ch=${this.challengerBpm.toFixed(0)} rival=${rival.toFixed(2)} rawLock=${rawLockNow.toFixed(3)} conf=${this.localBpmConfidence.toFixed(2)} nsv=${this.newSongVote.toFixed(0)} needMs=${needMs1}`);
        let needMs = this.subhSuspect(this.challengerBpm) ? needMs1 * 4 : needMs1;
        const ghostRef = (GHOST_LASTGOOD && this.lastGoodBpm > 0) ? this.lastGoodBpm : this.localBpm;
        if (GHOST_WAIT && ghostRef > 0) {
          const gr = this.challengerBpm / ghostRef;
          if (Math.abs(gr - 2 / 3) < 0.04 || (GHOST_34 && Math.abs(gr - 0.75) < 0.04)) needMs = rival > 3.0 ? GHOST_MS : 25000;
        }
        const dtVote = this.lastSongVoteMs > 0 ? Math.min(200, voteNow - this.lastSongVoteMs) : 0;
        this.lastSongVoteMs = voteNow;
        this.newSongVote += dtVote;
        // ── RÅ-AC-VETO MOT SUBHARMONIKER ────────────────────────────────────────
        // MEKANISMEN: `rival` mäts i tempoGram, som är comb-filtrerat
        // (ac[L] + ½·ac[2L] + ⅓·ac[3L]). En 2/3-kandidat ligger på lag 1.5P där den
        // RÅA autokorrelationen är svag — slagen möts inte — men ac[3P] träffar
        // perfekt och comb-filtret adderar den med vikt 0,5. Comb-filtret är alltså
        // självt orsaken: subharmoniken har ingen egen självlikhet, den lånar sin
        // styrka från sin egen tredje harmonisk. Därför duger INTE `scoreBass` som
        // diskriminator (samma out[]-formel ⇒ ärver exakt samma fel) — bara den råa
        // `acScratch` (helbandet, scoreEnv körde sist) skiljer dem.
        // ASYMMETRI: en subharmonisk är alltid LÅNGSAMMARE än låset. Åt det hållet
        // krävs egen självlikhet i nivå med låsets; uppåt (äkta snabbare låt, eller
        // ett lås som fastnat på en subharmonisk) hålls kravet lågt så omlåsningen
        // inte bromsas. Noll ny kostnad: två array-uppslagningar.
        const chLag = Math.round((HZ * 60) / this.challengerBpm);
        let vetoed = false;
        if (chLag >= lagMin && chLag <= lagMax && lockLag >= lagMin && lockLag <= lagMax) {
          const rawCh = this.acScratch[chLag];
          const rawLock = this.acScratch[lockLag];
          const slower = this.challengerBpm < this.localBpm;
          const need = slower ? 0.95 : 0.55;
          vetoed = rawLock > 0 && rawCh < rawLock * need;
          const pCh = this.pulseScratch[chLag], pLock = this.pulseScratch[lockLag];
          if (PULSE_VETO) vetoed = pLock > PULSE_VETO_MIN && pCh < pLock * PULSE_VETO_R;
          if (BPM_TRACE && this.newSongVote >= needMs * 0.85)
            console.log(`[veto] t=${this.traceT().toFixed(1)} lock=${this.localBpm} ch=${this.challengerBpm.toFixed(0)} rawCh=${rawCh.toFixed(3)} rawLock=${rawLock.toFixed(3)} kvot=${(rawLock > 0 ? rawCh / rawLock : 0).toFixed(2)} need=${need} pCh=${pCh.toFixed(4)} pLock=${pLock.toFixed(4)} pKvot=${(pLock > 0 ? pCh / pLock : 0).toFixed(2)} vetoed=${vetoed} rival=${rival.toFixed(2)} needMs=${needMs} nsv=${this.newSongVote.toFixed(0)}`);
        }
        if (vetoed) {
          this.newSongVote *= 0.7;   // vädra ut beviset, precis som en osund ruta
          if (this.newSongVote < 0.5) { this.newSongVote = 0; this.challengerBpm = 0; }
        } else if (this.newSongVote >= needMs) {
          // Lås på UTMANAREN, inte medianen, och kasta historiken: ett medianfönster
          // halvfullt av förra låtens tempo kostade flera sekunder till rätt takt.
          this._why = "NEWSONG";
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
    } else if (Analyser.HMM_ON) {
      // ── TEMPOFOLJARE MED TILLSTAND (2026-09-20) ──────────────────────────────
      // Observation over tillstanden 56..185 BPM (ingen vikning): tempogrammets varde vid tillstandets lag
      // (linjart interpolerat, normaliserat), slagpoang-stod +-3 % kring kandidattopparna, och halvslagsbevis
      // som stod for DUBBLA tempot (PC-referensens regel: kvot >= 0,6). Foljaren (Viterbi i logdomanen) ager laset.
      if (this.localBpm === 0 && this.hmmLastLocal > 0) this.tracker.reset();          // tystnad/latbyte nollade laset
      if (this.reacqUntilMs > 0 && this.reacqUntilMs !== this.hmmReacqStamp && voteNow < this.reacqUntilMs) { this.hmmReacqStamp = this.reacqUntilMs; this.tracker.reset(); }
      const T = this.tracker, tgO = this.trkTg, alO = this.trkAlign, hfO = this.trkHalf;
      let tgMax = 0;
      for (let s2 = 0; s2 < T.n; s2++) {
        const lagF = (HZ * 60) / T.bpmOf[s2]; let v = 0;
        if (lagF >= lagMin && lagF <= lagMax) { const l0 = Math.floor(lagF), l1 = Math.min(lagMax, l0 + 1), f = lagF - l0; v = tg[l0] * (1 - f) + tg[l1] * f; }
        tgO[s2] = v > 0 ? v : 0; if (tgO[s2] > tgMax) tgMax = tgO[s2];
        alO[s2] = 0; hfO[s2] = 0;
      }
      if (tgMax > 0) for (let s2 = 0; s2 < T.n; s2++) tgO[s2] /= tgMax;
      const nc = this.evidenceCands; let sMax = 0;
      for (let i = 0; i < nc; i++) if (this.candScore[i] > sMax) sMax = this.candScore[i];
      if (nc > 0 && sMax > 0) for (let s2 = 0; s2 < T.n; s2++) {
        const lagS = (HZ * 60) / T.bpmOf[s2];
        for (let i = 0; i < nc; i++) {
          const L = this.candLag[i];
          if (Math.abs(lagS / L - 1) <= 0.03) { const a = this.candScore[i] / sMax; if (a > alO[s2]) alO[s2] = a; }
          if (Math.abs(lagS / (L / 2) - 1) <= 0.03 && this.candHalf[i] >= TempoTracker.HALF_THR) { const h = Math.min(1, (this.candHalf[i] - TempoTracker.HALF_THR) / (1 - TempoTracker.HALF_THR)); if (h > hfO[s2]) hfO[s2] = h; }
        }
      }
      const r = T.update({ tg: tgO, align: alO, half: hfO }, voteNow);
      if (r) {
        this.hmmBpm = r.bpm; this.hmmStable = r.stable; this.hmmConf = r.conf;
        if (this.localBpm > 0 || r.stable >= 2 || r.conf >= 0.3) { this.localBpm = Math.round(r.bpm); this.lockPeak = bestVal; }
      }
      this.hmmLastLocal = this.localBpm;
    } else {
      // ── EVIDENSLAS (2026-09-19) ─────────────────────────────────────────────
      // Korbanken: evidensestimatet (kandidater + slagpoang pa basonseten) ar ratt i 8/8 syntetfall,
      // medan den gamla lasapparaten tog sitt forsta las pa 0,75 s data och sedan forsvarade det
      // (commit, oktavroster, grannrattning med 11 %-band, "overwhelming" pa tempogramhojd) - 3/10
      // ratt pa bankmaterial. Har ager evidensen laset: en rost var 250 ms, laset = median over 3 s,
      // forsta las vid 8 roster (2 s), byte efter 6 samstammiga roster (1,5 s; 3 under latbyteshint)
      // som ligger > 3 % fran laset OCH dar vinnarens slagpoang slar lasets (annars ar det ett break
      // utan kickar). Innanfor 3 % glider laset med flyttal (rundningen at annars sista stegen).
      if (this.localBpm === 0 && this.evidLastLocal > 0) {                  // laset aterstallt utifran (tystnad/latbyte)
        this.evidHistLen = 0; this.evidHistPos = 0; this.evidChangeBpm = 0; this.evidChangeVotes = 0; this.localBpmF = 0;
      }
      this.evidLastLocal = this.localBpm;
      let added = false;
      if (this.evidHistLen === 0 || voteNow - this.evidLastVoteMs >= 250) {
        this.evidLastVoteMs = voteNow; this.evidHist[this.evidHistPos] = bpm; this.evidHistPos = (this.evidHistPos + 1) % 12;
        if (this.evidHistLen < 12) this.evidHistLen++; added = true;
      }
      if (added) {
        const n = this.evidHistLen; const sc = this.evidSort2;
        for (let i = 0; i < n; i++) sc[i] = this.evidHist[(this.evidHistPos - n + i + 12) % 12];
        for (let i = 1; i < n; i++) { const v = sc[i]; let j = i - 1; while (j >= 0 && sc[j] > v) { sc[j + 1] = sc[j]; j--; } sc[j + 1] = v; }
        const em = sc[n >> 1];
        if (this.localBpm === 0) {
          if (n >= 8) { this.localBpm = Math.round(em); this.localBpmF = em; this.lockPeak = bestVal; this.evidChangeVotes = 0; this.evidChangeBpm = 0; }
        } else if (Math.abs(em / this.localBpm - 1) <= 0.03) {
          this.localBpmF = this.localBpmF > 0 ? this.localBpmF + (em - this.localBpmF) * 0.3 : em;
          this.localBpm = Math.round(this.localBpmF);
          this.evidChangeVotes = 0; this.evidChangeBpm = 0;
        } else {
          const lockLag = Math.round((HZ * 60) / this.localBpm);
          const ls = this.alignScore(this.envBassRing, N, lockLag).score; this.evidenceLockScore = ls;
          const better = this.evidenceScore >= ls * 1.1;
          if (better && this.evidChangeBpm > 0 && Math.abs(em / this.evidChangeBpm - 1) <= 0.03) {
            const need = voteNow < this.reacqUntilMs ? 3 : 6;
            if (++this.evidChangeVotes >= need) {
              this.localBpm = Math.round(em); this.localBpmF = em; this.lockPeak = bestVal;
              this.evidChangeVotes = 0; this.evidChangeBpm = 0; this.evidenceRelocks++;
            }
          } else if (better) { this.evidChangeBpm = em; this.evidChangeVotes = 1; }
          else { this.evidChangeVotes = 0; this.evidChangeBpm = 0; }
        }
      }
    }
    const dt = this.lastConfMs > 0 ? Math.min(0.5, (voteNow - this.lastConfMs) / 1000) : 0.01;
    this.lastConfMs = voteNow;
    if (this.bpmStable >= Analyser.BPM_COMMIT) this.lastGoodBpm = this.localBpm;
    if (BPM_TRACE && this.localBpm !== _b0) console.log(`[bpmchg] t=${this.traceT().toFixed(1)} ${this._why || "?"} ${_b0}->${this.localBpm} stable=${this.bpmStable} nsv=${this.newSongVote.toFixed(0)} ch=${this.challengerBpm} oct=${this.octaveVote} near=${this.nearVote} conf=${this.localBpmConfidence.toFixed(2)}`);
    const confUse = Analyser.HMM_ON ? this.hmmConf : conf;
    const cA = this.localBpmConfidence;
    const aC = 1 - Math.exp(-dt / (confUse > cA ? 0.025 : 0.120));
    this.localBpmConfidence = cA + (confUse - cA) * aC;
    // ── KONFIDENSBASERAD LÅSSLÄPPNING ─────────────────────────────────────────
    // Sista utvägen ur ett fel lås. Oktav- och grannrättning stänger vid
    // BPM_COMMIT, och låtbytesvakten kräver FRISK takt (conf ≥ 0.9) — ett lås som
    // är fel och där takten aldrig blir frisk hade därför ingen väg ut alls, utom
    // 350 ms tystnad. Håller konfidensen sig under 0.3 i 8 s är låset i praktiken
    // inte längre en beskrivning av musiken: släpp det MJUKT (behåll tempot som
    // startgissning, töm historik och röster, vidga sökningen) i stället för hårt.
    // KVARSTÅENDE HÅL: ett SJÄLVSÄKERT men felaktigt lås (conf ≥ 0.3) fyrar inte
    // här. Det är därför `committedNow` sänktes till samma 24 som `committed`.
    if (this.localBpmConfidence >= 0.3) {
      this.lowConfSinceMs = voteNow;
    } else if (this.lowConfSinceMs > 0 && voteNow - this.lowConfSinceMs > 8000) {
      this.lowConfSinceMs = voteNow;
      this.hintTrackChange(5000);
    } else if (this.lowConfSinceMs === 0) {
      this.lowConfSinceMs = voteNow;
    }
  }

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
    this.barAcc.fill(0); this.barCount = 0;
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
  hintTrackChange(windowMs = 5000): void {
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
    this.barAcc.fill(0); this.barCount = 0;
    // NY LAT = NY STRUKTUR. Tempot bars over (se ovan), men sektionshistoriken tillhor forra laten och maste bort:
    // annars rangordnas nya laten mot gamla block och 'intro' intraffar aldrig. sectionReset() ar samma nollning
    // som 10 s tystnad redan gor - enda skillnaden ar att vi nu ocksa litar pa latbytes-signalen.
    if (Analyser.SECTION_ON_HINT) this.sectionReset();
  }

  /** Nollställ lås-/röst-ackumulatorerna — gemensam kärna för resetTempo/hintTrackChange/
   *  silens, så de tre inte kan divergera (jfr A5-buggen som var just en divergens). */
  private clearLockVotes(): void {
    if (HIGH_CLEAR && HIGH_ON) { this.envHighRing.fill(0); this.envHighAccum = 0; }
    this.warmCalls = 0; this.holdCalls = 0;
    this.octaveVote = 0; this.nearVote = 0; this.nearChallenger = 0; this.bpmStable = 0;
    this.newSongVote = 0; this.challengerBpm = 0; this.lastSongVoteMs = 0; this.lockPeak = 0;
  }

  /** Taktfasen är applicerad av motorn (ankaret flyttat) → börja om räkningen. */
  resetBar(): void { this.flagSlow(F_RESET_BAR); this.barAcc.fill(0); this.barCount = 0; }

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
  private virtualMs: number | null = null;
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
    const jump = ms === null || prev === null || ms < prev || ms - prev > 1000;
    this.virtualMs = ms;
    if (!jump) return;
    this.lastKick = 0;
    this.pendingKickMs = 0;
    this.lastVoteMs = 0;
    this.lastConfMs = 0;
    this.lastSongVoteMs = 0;
    this.reacqUntilMs = 0;
    this.beatAnchorMs = 0; this.beatPhaseMs = 0; this.beatPhaseConf = 0; this.phaseLastBeatMs = 0; this.phaseAnti = 0; this.phaseTrimN = 0; this.sectionReset();
    this.lastT = 0;
  }
  /** KORBANK (09-20): flytta bara den virtuella klockan, utan att nolla nagra ankare. setVirtualClock() ar ett
   *  LAGESBYTE (nollar lastT/lastKick/pendingKickMs/lastVoteMs...) och far bara anropas en gang - anropad per hop
   *  fros AGC:n (dt=0), kickar forfinades aldrig (0 kickar) och rosterna foll varje anrop. */
  advanceVirtualClock(ms: number): void { this.virtualMs = ms; }
  private perfNow(): number { return this.virtualMs ?? performance.now(); }
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
    if (this.virtualMs !== null) return this.virtualEpoch + this.virtualMs;
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

  setBeatGrid(grid: BeatGrid | null): void { this.beatSrc.beat = grid; }

  constructor(cfgIn: AnalyserConfig, splitIn?: SplitInit) {
    this.role = splitIn?.role ?? cfgIn.role ?? 'all';
    const splitBuf = splitIn?.split ?? cfgIn.split;
    if (this.role !== 'all') {
      if (!splitBuf) throw new Error('Analyser: roll ' + this.role + ' kraver split-buffertar');
      const v = viewsOf(splitBuf); this.splitCtrl = v.ctrl; this.splitRing = v.ring; this.splitState = v.state;
      // resumeSeq (full JS-seq) fran index.ts: slow = senast lasta record (omstart av workern fortsatter dar den dog,
      // drainRecords klipper backloggen till RING_N-RING_MARGIN); C_READ ar bara 32 laga bitar och duger inte ensamt.
      this.recSeq = splitIn?.resumeSeq ?? cfgIn.resumeSeq ?? 0;
      if (this.role === 'slow') {
        this.slowGap = true;   // forsta recordet: okand forhistoria -> raknarna tas som utgangspunkt
        // Seqlock-paritet: dog forra workern MITT I stateWrite (terminate/OOM) star C_STATE_SEQ udda for alltid och varje
        // stateRead pa snabba sidan misslyckas — aven mot den nya workern (som skulle skriva udda→jamn→udda). En skribent
        // i taget, sa det ar sakert att jamna till har.
        const sq = Atomics.load(v.ctrl, C_STATE_SEQ); if (sq & 1) Atomics.store(v.ctrl, C_STATE_SEQ, sq + 1);
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
      dropCount: 0, miniDropCount: 0, bodyDb: 0, midHiDb: -120, inZone: false, breaking: false, buildUp: 0, inRiser: false, profile: this.outProfile, beatAnchorMs: 0,
      kickAtMs: 0, barShift: -1, beatPhaseMs: 0, beatPhaseConf: 0, section: 'intro', sectionAgeMs: 0, sectionIndex: 0, sectionTier: 1, repeatSim: 0, repeatAgoMs: 0, repeatSection: '', expectHighInMs: -1, prevSection: '', levelVsHighDb: 0, sectionBars: 0,
      spec: this.outSpec, specAbs: this.outSpecAbs, onset: this.outOnset, drum: this.outDrum,
    };
  }

  /** Feed a hop-sized chunk of mono samples, get a frame back. */
  process(samples: Float32Array): Frame {
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
    const kickBins = Math.min(1, half);                             // ENBART bin 0 ≈ 0–94 Hz (bastrummans transient, inte basgången)
    const enhancedOnset = this.cfg.onset.enhancements;

    // Ljusets nivå använder fortfarande rå magnitud. Onset-vägen kan däremot
    // komprimeras och vitbalanseras per FFT-bin, så en högljudd/tonal källa inte
    // sväljer svagare transienter i tempogrammet.
    for (let i = 0; i < half; i++) {
      const re = spectrum[2 * i];
      const im = spectrum[2 * i + 1];
      const p = re * re + im * im;
      if (i < bassBins) {
        const m = Math.sqrt(p);
        bassEnergy += m;
        let onsetMag = m;
        if (enhancedOnset) {
          // Log-kompression före differensen + SuperFlux-liknande långsam
          // per-bin-whitening. Peak uppdateras före division så varje bin börjar
          // på en stabil skala även när signalen startar från tystnad.
          const compressed = Math.log1p(m);
          let peak = this.onsetPeak[i] * this.onsetPeakDecay;
          if (compressed > peak) peak = compressed;
          this.onsetPeak[i] = peak;
          onsetMag = this.onsetPeakReady ? compressed / Math.max(Analyser.ONSET_PEAK_FLOOR, peak) : 0;
        }
        mag[i] = m;
        const dd = onsetMag - this.onsetPrev[i];
        this.onsetPrev[i] = onsetMag;
        if (dd > 0) { flux += dd; if (i < kickBins) kickFlux += dd; }   // half-wave rectified
      }
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
    if (!this.gainLocked && rms > d.noiseFloor) {
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
    this.dbgKick = { flux: kickFlux, thresh: kickThresh, med: this.kickMed, mad: this.kickMad, energy, gain: this.gain, rms: this.dbgRms, env: this.envelope, locked: this.gainLocked };   // korbank-telemetri
    // ms → hindrar sub-beat-dubbelfyr. 0 i ratten = tempoanpassad (0,6 slag, minst 170 ms, nar tempot ar kant).
    const KICK_COOLDOWN = Analyser.KICK_COOLDOWN_MS > 0 ? Analyser.KICK_COOLDOWN_MS : (this.localBpm > 40 ? Math.max(170, (60000 / this.localBpm) * 0.6) : 170);
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
    if (above && grid && grid.bpm > 40 && this.localBpmConfidence > 0.5) {
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

    // Hoppets längd i ms. (Tva stallen nedan raknar fortfarande `dtHop * 1000`
    // for hand i stallet for att lasa den har — numeriskt identiskt, men
    // pastaendet "en enda forberaknad konstant" var inte sant.)
    const hopMs = this.hopMs;
    // Tystnad → nollställ BPM-klockan så beat-effekter inte fortsätter i fantom-takt.
    if (rms < this.cfg.detection.noiseFloor * 1.5) {
      this.silentMs += hopMs;
      // FLANKTRIGGAT: hela reseten kördes förut VARJE tyst hop efter 350 ms —
      // tempoGram.fill(0) är 500 skrivningar × 375 Hz i tystnad, och localBpm=0
      // gjorde återinlåsningen dyrare än den behövde vara (olåst stride = 100 Hz).
      // Nu: en gång på flanken. Tempot BEHÅLLS som startgissning (låst stride ⇒
      // billigt, och de flesta tystnader är en paus i samma låt), tempogrammet
      // halveras i stället för att nollas, konfidensen nollas så beat-effekter inte
      // fortsätter i fantom-takt. Full släppning först efter 10 s tystnad — då är
      // det en ny låt/nytt set och historiken är värdelös.
      if (this.silentMs > 350 && !this.silenceArmed) {
        if (BPM_TRACE) console.log(`[bpmrst] t=${this.traceT().toFixed(1)} SILENCE bpm=${this.localBpm}`);
        this.silenceArmed = true;
        this.localBpmConfidence = 0;
        this.clearLockVotes();
        this.envFilled = 0; this.beatAnchorMs = 0; if (SIL_CLEAR_PENDING) this.pendingKickMs = 0; this.beatPhaseMs = 0; this.beatPhaseConf = 0; this.phaseLastBeatMs = 0; this.phaseAnti = 0;   // sektionerna nollas INTE har (350 ms-flanken = paus i samma lat; egen 10 s-regel i sectionHop) this.pendingKickMs = 0;
        this.bpmHistLen = 0; this.bpmHistPos = 0; this.lastVoteMs = 0;
        for (let i = 0; i < this.tempoGram.length; i++) this.tempoGram[i] *= 0.5;
        this.envBassAccum = 0;
        if (HIGH_ON) this.envHighAccum = 0;
        this.barAcc.fill(0); this.barCount = 0;
        this.flagSlow(F_SIL350);
      } else if (this.silenceArmed && this.silentMs > 10000 && this.localBpm !== 0) {
        this.localBpm = 0;
        this.tempoGram.fill(0);
        this.flagSlow(F_SIL10);
      }
    } else {
      this.silentMs = 0;
      this.silenceArmed = false;
    }
    // --- Onset-envelope → lokal BPM (nedsamplad till 100 Hz) ---

    this.envAccum = Math.max(this.envAccum, fluxNorm);
    // Basbandets egen envelope (kick-flux) — samma raster, oberoende signal.
    const bassFluxNorm = Math.min(1, kickFlux * (this.cfg.onset.enhancements ? 0.5 : 0.02));
    if (bassFluxNorm > this.envBassAccum) this.envBassAccum = bassFluxNorm;
    // TYDLIG BASGANG: basnivans topp per env-sampel + senaste kick (se stepBassline).
    { const bl = this.bandLvl[1] + this.bandLvl[2]; if (bl > this.blAccum) this.blAccum = bl; if (this.kickHit >= 1) this.blKickSeq = this.envSeq; }
    if (HIGH_ON) { const hi = this.bandOn[6] > this.bandOn[7] ? this.bandOn[6] : this.bandOn[7]; if (hi > this.envHighAccum) this.envHighAccum = hi; }
    this.envAccumT += hopMs;
    if (this.envAccumT >= 1000 / Analyser.ENV_HZ) {
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
      this.stepBassline();
      if (HIGH_ON) this.envHighRing[this.envPos] = _h;
      this.envPos = (this.envPos + 1) % Analyser.ENV_LEN;
      if (Analyser.GRID_PHASE_ON) this.envLastWallMs = this.wallNow();
      this.envFilled = Math.min(this.envFilled + 1, Analyser.ENV_LEN);
      this.envAccum = 0;
      this.envBassAccum = 0;
      if (HIGH_ON) this.envHighAccum = 0;
      // Sektionens blocksummor levereras per ENV-SAMPEL i bada rollerna (SECTION_AGG 'env': samma kodvag -> delad och odelad
      // analysator ar bit-identiska). SECTION_AGG 'hop': odelad analysator kor sectionHop per hop sist i process().
      if (this.role === 'fast') { this.pushSlowRecord(_e, _b, _h); } else { this.envStep(); if (!SECTION_AGG_HOP) this.sectionFlushAgg(); }
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
      if (Analyser.GRID_PHASE_TRIM_ON) this.phaseTrimSample(kickAtMs);
      // TAKTFAS: bokför slagets tyngd på sin plats i fyrtakten. Vikten är slagets
      // EGEN styrka (ABSOLUT flux — kvoten mot troskeln mattade — kvadrerad sa
      // skillnaden mellan ettans
      // tunga och mellanslagens lätta trumma verkligen separerar). Bandenergin gick
      // inte att använda: den är utjämnad över ~100 ms och gav alla fyra platser
      // samma vikt ⇒ ingen marginal, ingen taktfas (MÄTT 2026-08-23).
      const g = this.beatSrc.beat;
      if (g && g.bpm > 40 && this.localBpmConfidence > 0.5) {
        const bMs = 60000 / g.bpm;
        const slot = Math.round((kickAtMs - g.anchorMs) / bMs) & 3;
        this.barAcc[slot] += this.pendingKickW * this.pendingKickW;
        if (this.barCount < 1000) this.barCount++;
        // GLOMSKAN AR ~83 TAKTER, INTE 4. Raden korr en gang per DETEKTERAT SLAG,
        // sa 0.997 ger tidskonstanten 1/0.003 = 333 slag = ~83 takter = ~2,5 min.
        // Kommentaren sa forut "~4 takters glomska" — fel med faktor 20, och en
        // tuningfalla: taktfasen bars over latgranser utom dar barAcc nollas explicit.
        for (let i = 0; i < 4; i++) this.barAcc[i] *= 0.997;
        // VINNANDE PLATS räknas ut HÄR, inte varje hop: barAcc ändras bara när ett
        // slag bokförs, så mellanliggande hops gav exakt samma svar. Vinsten är
        // dessutom att förslaget kommer högst en gång per slag i stället för i varje
        // ruta fram till att motorn hunnit flytta ankaret.
        // Kravet: TYDLIG marginal (35 %) och nog med bevis (~16 slag). Annars -1 —
        // bättre ingen taktfas än en som sitter en åtta bort.
        // `second` raknas om i sin egen loop nedan over alla i != bi, sa att satta
        // den har var en dod tilldelning (och startvardet -1 alltid overskrivet).
        let bi = 0, best = this.barAcc[0], second = 0;
        for (let i = 1; i < 4; i++) if (this.barAcc[i] > best) { best = this.barAcc[i]; bi = i; }
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
    for (let i = 0; i < this.bufferBig.length; i++) this.windowedBig[i] = this.bufferBig[i] * this.windowBig[i];
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
    this.specSink?.(this.magBigView, this.cfg.audio.rate / this.bufferBig.length);
    const gated = rms > this.cfg.detection.noiseFloor * 1.5;

    // Signal i rad? Räknaren driver ONSET_WARM ovan.

    if (gated) this.onsetWarm++; else this.onsetWarm = 0;

    // Samma hissning som magnitud-loopen: pekarna ut ur this före det inre varvet.
    const bandLo = this.bandLo, bandHi = this.bandHi;
    const prevMagBig = this.prevMagBig;
    if (Analyser.SECTION_ON) {
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
    }   // slut på decimerad stor-FFT
    // TRUM-KIT peak-hold-envelopes PÅ HOP-TAKT (var 2.7ms) → fångar varje anslag,
    // aldrig missat mellan två render-frames (100Hz). tau bevarade från effects.ts:
    // hat 60ms (treble+air-onset O[6]/O[7]) / snare 110ms (highMid-onset O[5]) / kick 150ms
    // (ENBART diskret kick — se nedan). bass = spec.bass-NIVÅ (L[2], ingen envelope).
    // Hi-hats/sizzle i modern EDM/trap ligger ofta >10 kHz, så hat får lyssna på både
    // treble (3,5–10 kHz) och air (10–16 kHz) och ta den starkaste transienten.
    const hatOnset = this.bandOn[6] > this.bandOn[7] ? this.bandOn[6] : this.bandOn[7];
    this.hatHit = Math.max(this.hatHit * this.dHat, hatOnset);
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

    // TRE villkor, inte tva: utover hysteresen (85 % in / 70 % ut) finns ett
    // ABSOLUT golv pa 0.65 som saknar motsvarighet pa vagen ut. Det kan ensamt
    // halla inZone falsk genom en hel tyst lat. Odokumenterat tidigare.
    if (this.lvlSmooth > this.levelCeil * 0.85 && this.lvlSmooth > 0.65) this.inZoneState = true;
    else if (this.lvlSmooth < this.levelCeil * 0.70) this.inZoneState = false;
    const inZone = this.inZoneState;
    // BASKROPPEN — drop-detektionens egen signal (tak + frånvaro + stigningstakt).
    // `inZone` lämnas orörd: effektlagret använder den som "musiken ligger högt".

    const bodyNow = (this.bandDbRaw[0] + this.bandDbRaw[1] + this.bandDbRaw[2]) / 3;   // ra dB
    this.bodyEnv += (bodyNow - this.bodyEnv) * Math.min(1, dtHop / 0.35);
    this.bodyFast += (bodyNow - this.bodyFast) * Math.min(1, dtHop / BODY_FAST_S);
    let bodyPeek = this.bodyFast;
    if (DROP_PEEK) {   // villkoren far se ra-kanten efter DROP_PEEK_MS (lopande min), inte efter filtret
      const n = Math.min(63, Math.max(1, Math.round(DROP_PEEK_MS / (dtHop * 1000)) + 1));
      this.peekRing[this.peekPos] = bodyNow; this.peekPos = (this.peekPos + 1) & 63;
      let mn = Infinity; for (let k = 1; k <= n; k++) { const v = this.peekRing[(this.peekPos - k) & 63]; if (v < mn) mn = v; }
      bodyPeek = Math.max(this.bodyFast, mn);
    }   // 0.06 testat men gav falsklarm live utan att fixa beat-lagget (det sitter i lamp-vagen/energin, inte har)
    // TAKET SJUNKER I dB PER SEKUND, inte i procent. Kroppen ar nu ett dB-tal
    // (negativt), och "1,5 % av ett negativt tal" gor taket STORRE, inte mindre —
    // den gamla raden var matematiskt omvand sa fort skalan blev logaritmisk.
    this.bodyCeil = Math.max(this.bodyEnv, this.bodyCeil - dtHop * BODY_CEIL_DB_S);
    this.bodyPeak = Math.max(this.bodyEnv, this.bodyPeak - dtHop * 0.04);   // ~0.04 dB/s ≈ haller loud-referensen i minuter

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
    } else { if (this.bodyGoneMs > 0) this.lastGoneSpanMs = this.bodyGoneMs; this.bodyGoneMs = 0; }
    // STIGNINGSTAKT över 0.5 s (ringbuffert, ingen allokering).
    const hist = this.bodyHist, HL = hist.length;
    const oldest = hist[(this.bodyHistPos + HL - this.bodyHistLen) % HL];
    let riseRef = oldest;
    if (DROP_RISE_MIN) { let mn = oldest; for (let k = 1; k <= this.bodyHistLen; k++) { const v = hist[(this.bodyHistPos + HL - k) % HL]; if (v < mn) mn = v; } riseRef = mn; }
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
    const upgrade = DROP_UPGRADE_DB > 0 && sinceDrop > 1500 && (this.bodyPeak - bodyPeek) < this.lastDropUnderPeak - DROP_UPGRADE_DB;
    const dropSpacingOk = sinceDrop > DROP_LONG_MS || (sinceDrop > DROP_SHORT_MS && stronger) || upgrade;
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
    // FORSTA KICKEN efter en gone-episod (spar + KICK-FIRST). Pa mjuka drops sveller basen over en
    // hel takt: kick & allt annat slar pa takt 1, baskroppen fyller i forst till takt 2 → kropps-
    // detektorn fyrar takten efter oavsett troskel (ladan 2026-09-04: rise 12 med underPeak 2.5).
    const goneRecentK = nowWallA - this.lastBodyGoneMs < 6000;
    if (kick && goneRecentK && this.goneEpisodeMs !== this.kickSeenGoneMs) {
      this.kickSeenGoneMs = this.goneEpisodeMs;
      if (DROP_TRACE) console.log(`[firstkick] wall ${this.wallNow()} rise ${bodyRise.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s`);
    }
    // DROP_KICK_FIRST=1: fyra pa forsta KVALIFICERADE kicken (kroppen borjat lyfta ≥ KICK_FIRST_RISE dB)
    // efter en gone-episod — en gang per episod; kroppsfyrningen sparras sedan for episoden.
    const kickFirstOk = DROP_KICK_FIRST && kick && goneRecentK && this.goneEpisodeMs !== this.dropKickGoneMs
      && bodyRise > KICK_FIRST_RISE && dropSpacingOk && this.activeMs > 2000;
    if (kickFirstOk) {
      this.dropKickGoneMs = this.goneEpisodeMs; this.dropArmUntil = 0;
      this.dropCount++; this.lastDropMs = nowWallA; this.lastDropRise = bodyRise;
      console.log(`[dropfire] wall ${this.wallNow()} KICKFIRST rise ${bodyRise.toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s`);
    }
    // MINIDROP-lyftet (se MINI_*). Egen svacka-raknare (kortare/grundare an gone) och egen flank.
    if (MINI_SPACING_MS > 0) {
      if (this.bodyEnv < this.bodyCeil - MINI_GONE_DB) { this.miniGoneMs += dtHop * 1000; if (this.miniGoneMs >= MINI_GONE_MS) this.lastMiniGoneMs = nowWallA; }
      else this.miniGoneMs = 0;
      let mnRef = oldest; for (let k = 1; k <= this.bodyHistLen; k++) { const v = hist[(this.bodyHistPos + HL - k) % HL]; if (v < mnRef) mnRef = v; }
      const miniOnset = (bodyPeek - mnRef) > MINI_RISE_DB && bodyPeek > this.bodyPeak - MINI_PEAK_DB && nowWallA - this.lastMiniGoneMs < 4000;
      const miniEdge = miniOnset && !this.wasMiniOnset; this.wasMiniOnset = miniOnset;
      if (miniEdge && this.activeMs > 2000 && nowWallA - this.lastDropMs > MINI_SPACING_MS && nowWallA - this.lastMiniMs > MINI_SPACING_MS) {
        this.miniDropCount++; this.lastMiniMs = nowWallA;
        if (DROP_TRACE) console.log(`[minidrop] wall ${this.wallNow()} rise ${(bodyPeek - mnRef).toFixed(1)} underPeak ${(this.bodyPeak - bodyPeek).toFixed(1)} goneAgo ${((nowWallA - this.lastMiniGoneMs)/1000).toFixed(1)}s`);
      }
    }
    const fullSlam = this.bodyPeak - bodyPeek < DROP_QUALITY_DB;
    // DMX_DROP_TRACE=1: logga KONSUMERADE edges (kandidat som INTE fyrade) — var ligger kroppen vid
    // forsta takten? Matdata for DROP_QUALITY_DB pa mjukare material (pop) dar inget referens finns.
    if (DROP_TRACE && bodyOnsetEdge && !(dropSpacingOk && fullSlam)) console.log(`[dropedge] rise ${bodyRise.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s spacingOk ${dropSpacingOk} sinceDrop ${(sinceDrop/1000).toFixed(1)}s`);
    if (kick) this.lastKickWallMs = nowWallA;
    let fireNow = dropSpacingOk && armed && this.activeMs > 2000 && fullSlam && this.goneEpisodeMs !== this.dropKickGoneMs;
    let fireTag = '';
    const underNow = this.bodyPeak - bodyPeek;
    // LUGN-SEKTIONS-GRINDEN (se DROP_CALM_GATE). Domen tas per kandidat-hop; den hallna kandidaten (DROP_CALM_LAND_MS) foljs nedan.
    if (DROP_CALM_GATE && fireNow) {
      const calm = (Analyser.SECTION_ON && (this.section === 'low' || this.section === 'intro')) || this.levelVsHighDb <= -DROP_CALM_DB;
      const strong = this.buildUp >= DROP_CALM_BUILD || underNow < DROP_CALM_Q || bodyRise >= BODY_RISE_DB + DROP_CALM_RISE_DB;
      if (calm && !strong) {
        fireNow = false;
        if (DROP_CALM_LAND_MS > 0 && this.calmHoldStart === 0) { this.calmHoldStart = nowWallA; this.calmHoldRise = bodyRise; }
        if (DROP_TRACE && bodyOnsetEdge) console.log(`[dropcalm] wall ${this.wallNow()} ${DROP_CALM_LAND_MS > 0 ? 'HALLS' : 'NEKAD'} sect ${this.section} lvh ${this.levelVsHighDb.toFixed(1)} build ${this.buildUp.toFixed(2)} underPeak ${underNow.toFixed(1)} rise ${bodyRise.toFixed(1)}`);
      }
    }
    if (this.calmHoldStart > 0) {   // verifierad landning: kroppen maste ligga kvar vid toppen hela DROP_CALM_LAND_MS
      if (!fullSlam) { if (DROP_TRACE) console.log(`[dropcalm] wall ${this.wallNow()} SLAPPT efter ${(nowWallA - this.calmHoldStart).toFixed(0)} ms (underPeak ${underNow.toFixed(1)})`); this.calmHoldStart = 0; }
      else if (fireNow) this.calmHoldStart = 0;   // fyrar anda (starkare bevis kom)
      else if (nowWallA - this.calmHoldStart >= DROP_CALM_LAND_MS && dropSpacingOk) { fireNow = true; fireTag = ` CALMLAND +${(nowWallA - this.calmHoldStart).toFixed(0)}ms`; bodyRise = Math.max(bodyRise, this.calmHoldRise); this.calmHoldStart = 0; }
    }
    // KICK-LASET (se DROP_KICK_LOCK_MS): kandidaten vantar in forsta kicken, hogst en halv takt / DROP_KICK_LOCK_MS.
    if (DROP_KICK_LOCK_MS > 0) {
      if (fireNow && this.dropPendAt === 0) {
        if (kick || nowWallA - this.lastKickWallMs <= DROP_KICK_RECENT_MS) fireTag += ` KICK ${kick ? 0 : (nowWallA - this.lastKickWallMs).toFixed(0)}ms`;
        else {
          let wait = DROP_KICK_LOCK_MS; if (this.localBpm > 0) wait = Math.min(wait, 30000 / this.localBpm);
          let target = nowWallA + wait; this.dropPendGrid = false;
          if (DROP_KICK_LOCK_GRID && this.beatPhaseConf >= 2 && this.localBpm > 0 && this.beatPhaseMs > 0) {
            const per = 60000 / this.localBpm; let nb = this.beatPhaseMs; while (nb < nowWallA + 5) nb += per;
            if (nb - nowWallA <= wait) { target = nb; this.dropPendGrid = true; }
          }
          this.dropPendAt = target; this.dropPendStart = nowWallA; this.dropPendRise = bodyRise; fireNow = false;
          if (DROP_TRACE) console.log(`[dropkick] wall ${this.wallNow()} vantar ${(target - nowWallA).toFixed(0)} ms (${this.dropPendGrid ? 'raster' : 'timeout'}) sedan kick ${(nowWallA - this.lastKickWallMs).toFixed(0)} ms`);
        }
      } else if (fireNow) fireNow = false;   // redan en vantande kandidat
      if (this.dropPendAt > 0 && (kick || nowWallA >= this.dropPendAt)) {
        fireNow = true; fireTag = ` KICKLOCK +${(nowWallA - this.dropPendStart).toFixed(0)}ms ${kick ? 'kick' : this.dropPendGrid ? 'raster' : 'timeout'}`;
        bodyRise = Math.max(bodyRise, this.dropPendRise); this.dropPendAt = 0;
      }
    }
    if (fireNow) {
      this.dropArmUntil = 0; this.calmHoldStart = 0;
      this.dropCount++; this.lastDropMs = nowWallA; this.lastDropRise = bodyRise; this.lastDropUnderPeak = underNow;
      console.log(`[dropfire] wall ${this.wallNow()}${fireTag} rise ${bodyRise.toFixed(1)} fast ${this.bodyFast.toFixed(1)} peak ${this.bodyPeak.toFixed(1)} ceil ${this.bodyCeil.toFixed(1)} underPeak ${(this.bodyPeak - this.bodyFast).toFixed(1)} sinceDrop ${(sinceDrop/1000).toFixed(1)}s goneAgo ${((nowWallA - this.lastBodyGoneMs)/1000).toFixed(1)}s goneSpan ${(this.lastGoneSpanMs/1000).toFixed(1)}s edgeAgo ${(nowWallA - this.dropArmAt).toFixed(0)}ms`);
    }


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
    // punch drivs av den dedikerade kick-detektorn (renare transient än bandOn[1],
    // som ligger i 60–120 Hz och drunknar i rullande bas) plus snare/hat-anslag.
    const punchNow = Math.min(1, (this.kickHit + this.bandOn[5] + this.bandOn[6]) * 0.6);  // kick+snare+hat
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
    this.outProfile.bassline = this.profBassline;


    const L = this.bandLvl, A = this.bandAbs, O = this.bandOn;
    const spec = this.outSpec, specAbs = this.outSpecAbs, onset = this.outOnset;
    spec.sub = L[0]; spec.kick = L[1]; spec.bass = L[2]; spec.lowMid = L[3]; spec.mid = L[4]; spec.highMid = L[5]; spec.treble = L[6]; spec.air = L[7];
    specAbs.sub = A[0]; specAbs.kick = A[1]; specAbs.bass = A[2]; specAbs.lowMid = A[3]; specAbs.mid = A[4]; specAbs.highMid = A[5]; specAbs.treble = A[6]; specAbs.air = A[7];
    onset.sub = O[0]; onset.kick = O[1]; onset.bass = O[2]; onset.lowMid = O[3]; onset.mid = O[4]; onset.highMid = O[5]; onset.treble = O[6]; onset.air = O[7];
    const dr = this.outDrum;
    dr.kick = this.kickHit; dr.snare = this.snareHit; dr.hat = this.hatHit; dr.bass = L[2];

    // Mutera det återanvända Frame:t (spec/onset pekar redan på outSpec/outOnset).
    const f = this.outFrame;
    f.level = this.lvlSmooth; f.levelRaw = level; f.levelVU = this.lvlVU;
    f.energy = this.engSmooth;
    f.centroid = this.centSmooth; f.flux = fluxNorm; f.kick = kick; f.gain = this.gain;
    f.bpm = this.localBpm; f.bpmConfidence = this.localBpmConfidence; f.intensity = intensity; f.beatAnchorMs = this.beatAnchorMs;
    f.bodyDb = bodyNow;
    { let s2 = 1e-12; for (let b = 3; b < 8; b++) { const lin = Math.pow(10, this.bandDbRaw[b] / 20); s2 += lin * lin; } f.midHiDb = 20 * Math.log10(Math.sqrt(s2)); }
    f.dropCount = this.dropCount; f.miniDropCount = this.miniDropCount; f.inZone = inZone; f.breaking = breaking; f.buildUp = this.buildUp; f.inRiser = inRiser;
    f.kickAtMs = kickAtMs; f.barShift = barShift;
    // Gridfasen ut: konstant offset (detektorns slap) och/eller trim. Bada 0/av som standard => oforandrad fas.
    f.beatPhaseMs = this.beatPhaseMs > 0 ? this.beatPhaseMs - Analyser.GRID_PHASE_OFFSET_MS + (Analyser.GRID_PHASE_TRIM_ON ? this.phaseTrimMs() : 0) : this.beatPhaseMs;
    f.beatPhaseConf = this.beatPhaseConf;
    if (Analyser.SECTION_ON) {
      if (SECTION_AGG_HOP) {
        // Aldre vagen: bandens magnitud ur band-dB; odelad analysator kor sectionHop per hop, snabba sidan aggregerar.
        const sp = this.secSpecHop; for (let i = 0; i < 8; i++) sp[i] = Math.pow(10, this.bandDbRaw[i] / 20);
        if (this.role === 'fast') {
          const g = this.secAgg; g.n++; g.int += intensity; if (kick) g.kicks++; g.rms2 += rms * rms; g.cent += this.centSmooth; g.dt += this.dtHop * 1000;
          g.breaking = breaking ? 1 : 0; g.wall = this.wallNow(); g.drops = this.dropCount; g.active = this.activeMs; g.build = this.buildUp;
          for (let i = 0; i < 8; i++) g.spec[i] += sp[i];
        } else this.sectionHop(1, intensity, kick ? 1 : 0, breaking, this.wallNow(), this.dtHop * 1000, rms * rms, this.centSmooth, sp);
      } else {
        const g = this.secAgg; g.n++; g.int += intensity; if (kick) g.kicks++; if (breaking) g.breaking = 1; g.rms2 += rms * rms; g.cent += this.centSmooth; g.dt += dtHop * 1000; g.wall = nowWallA;
        for (let i = 0; i < 8; i++) g.spec[i] += this.bandAbs[i];
        g.bon += this.bassOnRing[(this.bassOnN - 1 + Analyser.BASSON_LEN) % Analyser.BASSON_LEN]; if (this.bassOnPeak) { g.bpk++; this.bassOnPeak = false; } g.flux += fluxNorm; g.rms4 += rms * rms * rms * rms;
      }
    }
    const nowS = SECTION_AGG_HOP ? this.wallNow() : nowWallA;
    f.section = this.section; f.sectionAgeMs = this.sectionStartMs > 0 ? nowS - this.sectionStartMs : 0; f.sectionIndex = this.sectionIndex; f.sectionTier = this.sectionTier;
    f.repeatSim = this.repeatSim; f.repeatAgoMs = this.repeatAgoMs; f.repeatSection = this.repeatSection;
    f.expectHighInMs = this.section === 'high' ? 0 : this.expectHighMs > 0 ? Math.max(0, this.expectHighMs - nowS) : -1;
    f.prevSection = this.prevSection; f.levelVsHighDb = this.levelVsHighDb;
    f.sectionBars = this.localBpm > 0 && this.sectionStartMs > 0 ? (nowS - this.sectionStartMs) / (240000 / this.localBpm) : 0;
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
 */
export function createAnalyser(cfg: AnalyserConfig): Analyser {
  const mode = sysEnv('ANALYSER_SPLIT');
  if (mode !== 'worker' && mode !== 'inline') return new Analyser(cfg);
  const buffers = createSplitBuffers();
  const fast = new Analyser(cfg, { role: 'fast', split: buffers });
  if (mode === 'inline') { fast.setInlinePeer(new Analyser(cfg, { role: 'slow', split: buffers })); return fast; }
  // Worker: SAB:arna delas via workerData (structured clone DELAR SharedArrayBuffer). cfg ar ren data och klonas.
  // Importen ar dynamisk sa modulen fortfarande laddar i miljoer utan worker_threads (bank, webblasare).
  import('node:worker_threads').then(({ Worker }) => {
    let stopped = false;
    const attempts: number[] = [];   // tidpunkter for omstarter inom fonstret
    const start = (resumeSeq: number, why: string) => {
      const data: WorkerData = { cfg: { ...cfg }, buffers, resumeSeq };
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
        const t = setTimeout(() => { if (stopped) return; fast.splitRestarts++; start(fast.fastReadSeq(), 'omstart'); }, delay);
        t.unref();
      });
      w.unref();
      (fast as unknown as { __worker: unknown }).__worker = w;
      console.log(`[analyser-split] langsam analysator i worker startad (tempo/gridfas/sektion) — ${why}, fran record ${resumeSeq}`);
    };
    (fast as unknown as { __stopWorker: () => void }).__stopWorker = () => {
      stopped = true;
      (fast as unknown as { __worker?: { postMessage: (m: unknown) => void } }).__worker?.postMessage({ type: 'stop' });
    };
    start(0, 'start');
  }).catch((e) => console.error('[analyser-split] kunde inte starta worker:', e?.message ?? e));
  return fast;
}
