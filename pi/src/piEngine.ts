/**
 * PiLightEngine — headless audio→light pipeline for Raspberry Pi.
 * 
 * EVENT-DRIVEN ARCHITECTURE:
 * Instead of a timer polling latestBands, the ALSA mic fires onFFTReady
 * which triggers the engine immediately (if tickMs has elapsed).
 * This eliminates up to tickMs of latency from the mic→BLE path.
 * 
 * Pipeline: Mic PCM → FFT → [event] → Engine tick → BLE write
 * Latency: ~5.8ms (audio buffer) + <1ms (processing) + ~25ms (BLE) ≈ 31ms
 * 
 * Takt: band-events (och därmed motorn) körs i 75 Hz — FRAME_MS = 13.33 ms
 * (BAND_EVERY_HOPS=5 × ANALYSER_HOP=128 @ 48 kHz = 640 sampel).
 * tickMs pacar BARA BLE-slot-leasen, inte tick-takten (tick-gaten är borta).

 */

import { SongClock } from './songClock.js';
import { renderShow, lastRenderedColors, DEFAULT_SHOW, SHOW_STEP_MS } from './showRenderer.js';
import { getLatestBands, getLatestFrame, getLatestFrameAt, resetFluxState, onFFTReady, onFluxReady, stopMic, setBeatCutoffHz, setAnalyserBeatGrid, hintAnalyserTrackChange, FRAME_MS, getLightRawRms, audioClockMs, onLandmarks as micOnLandmarks, resetLandmarks, startFineEnergy, stopFineEnergy, getRecentKicks, getLatestKickAt } from './alsaMic.js';
import type { Frame } from './audio-analyser/index.js';
import { hasBeat, beatIndex, beatPhase, nextBeatIn, MIN_BEAT_CONFIDENCE, type Beat } from './audio-analyser/beatClock.js';
import { sendToBLE, clearQueuedWrite, flushQueuedWriteNow, hasQueuedWrite, setIdleColor, setSlotLeaseMs, startKeepAlive, stopKeepAlive } from './ble-driver/protocol.js';
import type { WriteResult } from './ble-driver/protocol.js';
import { bleStats as bleStatsState } from './ble-driver/state.js';
import { triggerIdleDisconnect, getHardcodedConnected } from './ble-driver/connect.js';
import { isControllerDrainAttached, getOutstandingPackets } from './ble-driver/controllerDrain.js';
import { nextRasterEventAt, getRasterStats, resetRasterWindow, NOMINAL_PERIOD_MS } from './ble-driver/raster.js';
import { PulseTrack, pulseEnvelope, pulseAmpFor, pulseSplit, trustRaw, trustSmooth, ceilingFrom, composeEnergy, toNormalized, type PulseShapeParams } from './heartbeat/heartbeat.js';

/**
 * TICK-SYNK (2026-09-21, opt-in LOTUS_TICK_SYNC=1): motorn tickar i fas med radions
 * anslutningshändelser (raster.ts) i stället för på band-ramen. Varje tick räknas klart
 * TICK_SYNC_GUARD_MS före nästa förutsagda radiohändelse på färskaste analysatorstate, så
 * paketet lämnar Pi:n utan att ligga och vänta 0–intervall. Band-ramen (BAND_EVERY_HOPS)
 * uppdaterar då bara bands; sätt LOTUS_BAND_EVERY_HOPS lågt (3 = 8 ms) så underlaget är färskt.
 * Tickperioden är då rastret (nominellt intervall × 1,25 ms); tickInners egna filter (nivå-EMA, ankare, shape)
 * räknas på TICK_PERIOD_MS. OBS: processOnset (puls: rise/hold/decay, refraktär) körs per BAND-RAM via onFluxReady
 * och ska räknas på FRAME_MS (8 ms vid BAND_EVERY_HOPS 3) — 09-21-buggen: 17,5 på 8 ms-ramar gav 2,2× för snabb fade.
 */
export const TICK_SYNC = process.env.LOTUS_TICK_SYNC === '1';
const TICK_SYNC_GUARD_MS = Math.max(1, Math.min(16, Number(process.env.LOTUS_TICK_SYNC_GUARD_MS) || 4));
/** Självsökande guard (LOTUS_TICK_SYNC_ADAPT=0 stänger av): bergsklättring 1 ms/2 s-fönster på write→kvitto p50.
 *  Kurvan är en sågtand — för liten guard missar radiohändelsen och paketet tar nästa (+intervall). */
const TICK_SYNC_ADAPT = process.env.LOTUS_TICK_SYNC_ADAPT !== '0';
export const TICK_PERIOD_MS = TICK_SYNC ? NOMINAL_PERIOD_MS : FRAME_MS;
/**
 * PREDIKTIV PULS (2026-09-21, opt-in LOTUS_PULSE_PREDICT=1, kräver TICK_SYNC). Gridpulsen tändes förut i band-ramen (8 ms) och
 * plockades upp av nästa tick (0–17,5 ms) = upp till ~25 ms jitter per pulstopp. Nu: ramen fattar alla BESLUT (subdiv, oktav,
 * accent, PLL) men sätter inte pulsen; varje slag blir en händelse {t = slagets väggtid − lead, amp} och ticken räknar pulsens
 * värde ANALYTISKT vid paketets visningsögonblick (nästa radiohändelse + LOTUS_PULSE_LAMP_MS). Ticken ser också slag som ramen
 * ännu inte hunnit se (look-ahead inom ett paket). Pulsloggen (notePulse) får slagets exakta tid → PC-facit mäter −lead exakt.
 */
export const PULSE_PREDICT = TICK_SYNC && process.env.LOTUS_PULSE_PREDICT === '1';
/** Sektionsminnets konsumenter (2026-09-21, se steg 6 i tick): forvarning fore refrang och dynamik mot latens egen refrang. */
const EXPECT_LIFT_MS = Math.max(0, Number(process.env.LOTUS_EXPECT_LIFT_MS ?? 3000) || 0);
const SECTION_DYN_DB = Math.max(0, Number(process.env.LOTUS_SECTION_DYN_DB ?? 12) || 0);
const SECTION_DYN_FLOOR = Math.min(1, Math.max(0.1, Number(process.env.LOTUS_SECTION_DYN_FLOOR ?? 0.45) || 0.45));
const PULSE_LAMP_MS = Math.max(0, Math.min(200, Number(process.env.LOTUS_PULSE_LAMP_MS) || 0));
import { getItem, setItem, DATA_DIR } from './storage.js';
import { resetSubsystem } from './ble/subsystem-state.js';
import { writeFile, appendFileSync, writeFileSync } from 'node:fs';
import { PerformanceObserver } from 'node:perf_hooks';
import type { Landmark } from './fingerprint.js';
import { SongLock } from './songLock.js';

/** Synkprovets logg. En rad per 100 ms: latposition <TAB> ra mic-RMS. */
/**
 * Matkedjans egen fordrojning, ms.
 *
 * Mic-RMS:et som jamfors ar en ~130 ms EMA, och till det kommer ALSA-buffert
 * och ljudets gang genom rummet. Signalen vi laser BESKRIVER darfor ljud som
 * lat en stund sedan. Utan den har kompensationen skulle motorn kalibrera bort
 * sin egen matfordrojning och lagga ljuset lika mycket FOR SENT.
 *
 * Konstanten gar inte att mata isar fran synkfelet med den har metoden -- den
 * ar en skattning, och den ar samma for alla latar.
 */
const MIC_PIPELINE_MS = 150;
/**
 * Hur mycket battre toppen maste vara an basta varde UTANFOR sin narhet.
 *
 * Musik upprepar sig. En lat i 136 BPM har en tvataktsfras var 3,5:e sekund, och
 * korskorrelationen kan da hitta en nastan lika bra topp en hel fras fel -- inom
 * sokfonstret pa +/-3 s. En sadan matning ser overtygande ut (hog r) men ar en
 * hel fras bredvid.
 *
 * Misstanken vacktes av att "Mary Lou" matte +570 ms nar alla andra latar lag
 * negativt. Alla inspelningar arver sitt fel fran samma mekanism och borde luta
 * at samma hall.
 *
 * Ar toppen inte tydligt bast kastas matningen hellre an skrivs till fil -- den
 * hamnar i latminnet och anvands vid varje framtida uppspelning.
 */
const SYNC_PEAK_MARGIN = 0.08;
/** Hur nara toppen som raknas som samma topp. */
const SYNC_PEAK_NEAR_MS = 400;
/** Under sa svag korrelation ar toppen brus och matningen kastas. */
const SYNC_MIN_R = 0.40;
/**
 * Sa manga par kravs innan en matning gors (10 Hz -> 40 s).
 *
 * Var 600 (60 s) forst, men da hann matningen sallan lo sut: uppmatt fick
 * latarna bara 373-486 par innan de tog slut, eftersom klockan behover nagra
 * sekunder pa sig och latbytet nollstaller. Den oberoende matningen gav r=0.73
 * pa 373 par, sa 400 racker gott.
 */
const SYNC_MIN_SAMPLES = 400;
/** Vanta pa sa manga par till innan nasta matning. */
const SYNC_RETRY_STEP = 400;
/**
 * Hur manga matningar per uppspelning.
 *
 * En matning pa 40 s ljud raknar fram ett trovardigt varde (r=0.78) men
 * spridningen mellan tva sadana matningar pa SAMMA lat blev ett par hundra ms:
 * "Vad gor du med mig" gav -670 ms en gang och -170 ms nasta. Mer ljud ger
 * stadigare svar, sa matningen gors om medan laten fortsatter och det svar med
 * STARKAST korrelation far galla.
 */
const SYNC_MAX_TRIES = 3;
/** Storsta korrigering vi tror pa. Mer an sa ar nagot annat fel. */
const SYNC_MAX_MS = 3000;

/**
 * Synkprovets logg ar AVSTANGD SOM STANDARD.
 *
 * Motorn kalibrerar sig sjalv ur minnesbufferten och behover inte filen; den
 * finns bara for att kunna kontrollera kalibreringen utifran med ett fristaende
 * skript.
 *
 * `appendFileSync` ar en BLOCKERANDE skrivning, och den lag i ljudslingan tio
 * ganger i sekunden. Diagnostik far aldrig sta i vagen for uppspelningen --
 * satt LOTUS_SYNC_PROBE=1 nar den behovs.
 */
const SYNC_PROBE_ON = process.env.LOTUS_SYNC_PROBE === '1';
/** OPT-IN (LOTUS_PLL_RING=1): PLL:en fasar mot kick-RINGEN (analysatorns sub-hop-tid per slag) i stallet for
 *  motorns egen onset vid ticktid. MATT 09-18: ringens kickar ar GRINDADE mot vart eget grid i analysatorn
 *  (+-max(30, 0,15*slag) ms runt attondelslinjerna) och forsta transienten efter att fonstret oppnar rapporteras
 *  -> PLL:en jagar sin egen grindkant: err = -0,9 x tolerans i alla lagen (-65 @130, -75..-80 @105-113,
 *  -7..-20 @224) oavsett gain och tempo, ankaret drev -20 ms/slag, och integratorn tolkade jakten som
 *  snabbare tempo (skenade till 2x). Motorns onset vid ticktid har i stallet en KONSTANT fordrojning
 *  (err -5..-35 @124, drift = bara analysatorns heltalskvantisering) som beatLeadMs absorberar. */
const PLL_RING_ON = process.env.LOTUS_PLL_RING === '1';
/** GRIDFAS-FOLJARE (2026-09-20, opt-in LOTUS_PHASE_FOLLOW=1): analysatorns beatPhaseMs (fasanalys pa bas- + helbandsringen,
 *  LOTUS_GRID_PHASE=1) styr gridets fas i stallet for enskilda kickar. Korpusens handelseloggar: pulserna i motfas (lampan pa
 *  off-beaten) i 9 av 39 latar med ratt tempo - kick-PLL:en slapper bara in kickar inom +-1/4 slag och bekraftar darfor ett
 *  grid pa attondelsbasen for alltid. Foljaren tillater fel upp till ett halvt slag (tva raka matningar med kvot >= 1,3
 *  flyttar fasen), annars sma steg (0,3 av felet per ny matning, 4 Hz). Kick-PLL:en ar AV nar foljaren ar pa. */
const PHASE_FOLLOW_ON = process.env.LOTUS_PHASE_FOLLOW === '1';
const PHASE_TRACE = process.env.LOTUS_PHASE_TRACE === '1';   // tillfallig sparlogg (4 Hz, forsta 400 matningarna)
/** Halvslagsflip i foljaren: kvot >= 2,0 i 4 raka matningar (1 s). Var 1,3/2 - 903 flippar pa 2 h. Korbank f3 (1,6/4) = f1 i fas, sa strangt kostar inget. */
const PHASE_FLIP_CONF = Number(process.env.LOTUS_PHASE_FLIP_CONF) || 2.0;
const PHASE_FLIP_VOTES = Number(process.env.LOTUS_PHASE_FLIP_VOTES) || 4;
/** Live 15:14-15:45: pulserna lag KONSTANT 50-100 ms fel per lat (Status del tva +96 ms, IQR 15) = gridets tempo (12 s-median)
 *  slapar 1-2 % efter analysatorns -> foljaren jagar med konstant slap (err_ss = drift/kP). Integralterm: bpm foljer fasdriften,
 *  klampad till +-4 % av analysatorns bpm. Bias: analysatorns fasmatning ligger 20 ms sen mot Beat This! (bank, 136 latar). */
const PHASE_KP_HI = Number(process.env.LOTUS_PHASE_KP_HI) || 0.4;
const PHASE_KP_LO = Number(process.env.LOTUS_PHASE_KP_LO) || 0.2;
const PHASE_KI_BPM = Number(process.env.LOTUS_PHASE_KI_BPM) || 0.8;      // BPM per slag fasfel per matning (4 Hz)
const PHASE_BIAS_MS = Number(process.env.LOTUS_PHASE_BIAS_MS ?? 20);

/**
 * Var landmarkena for en pagaende inspelning laggs.
 *
 * Motorn ager bade micen och FFT:n, sa den kan producera landmarkena med EXAKT
 * samma kod som sedan matchar dem. Den symmetrin ar viktigare an den ser ut:
 * en offline-berakning ur WAV-filen hade anvant en annan FFT, andra bandgranser
 * och en annan forstarkning, och da matchar inte hasharna.
 *
 * Filen plockas upp av refinern, som lagger till samma inspelningsoffset som den
 * redan lagger pa slag, delar och drops — sa landmarkena hamnar i SAMMA
 * tidslinje som showen renderas i.
 */
// Motorns systemd-sandlada gor /home/pi SKRIVSKYDDAT: forsta forsoket gav
// "EROFS: read-only file system". Landmarkena laggs darfor i motorns egen
// datakatalog — samma som latminnet, dit den bevisligen far skriva, och dit
// refinern redan har vagen.
const LM_DIR = process.env.LOTUS_LM_DIR || '/var/lib/pi-control-center/apps/lotus-light';
const SYNC_PROBE_FILE = (process.env.PCC_LOG_DIR || '/tmp') + '/syncprobe.tsv';
import { join } from 'node:path';
import { dlog } from "./debugLog.js";
import { noteTick } from './runtimeHealth.js';


// ── Inline engine math (avoid complex path aliasing to browser engine) ──

// AGC borttaget 2026-04-20: Sonos-volym → mic-gain-kalibrering (auto-gain)
// hanterar nu nivåskalningen. Ingen behov av en till normaliseringsloop.
// Bands från ALSA är redan rätt-skalade när de når engine.

// EN ÄRLIG GAIN (2026-08-23): den dolda RAW_SCALE=5 är borta. Den mättade
// signalen redan vid RMS 0.2 → drop/breakdown-detektorn såg ingen äkta tystnad.
// Ljusstyrka är nu en LINJÄR funktion av den gain:ade rå-inputen; enda
// känslighets-kontrollen är tvåpunkts-gain-kurvan mot Sonos-volym (~5× högre tal).
// OBS: tickEnergyFloor/onsetEnergyFloor jämförs mot RÅ bands-RMS → orörda.
export function normalizeFixed(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}



// --- Precomputed tick constants ---
export interface TickConstants {
  refractoryFrames: number;
  onsetDecayFft: number;
  gammaIsUnity: boolean;
  brightnessFloor: number;
  transientGain: number;
  beatDepth: number;
  lutR: Uint8Array;
  lutG: Uint8Array;
  lutB: Uint8Array;
}

export function computeTickConstants(tickMs: number, cal: LightCalibration): TickConstants {
  // fftMs = FRAME_MS: onset-alforna körs nu på sann 75 Hz-takt (var felaktigt hårdkodad 10 = 100 Hz-antagande).
  const fftMs = FRAME_MS;   // processOnset kors per BAND-RAM (onFluxReady), inte per tick - 09-21-buggen: 17,5 pa 8 ms-ramar = fade 2,2x for snabb


  const fftRatio = fftMs / 125;
  const fftSecRatio = fftMs / 1000;


  const gammaIsUnity = cal.gammaR === 1.0 && cal.gammaG === 1.0 && cal.gammaB === 1.0;

  const lutR = new Uint8Array(256);
  const lutG = new Uint8Array(256);
  const lutB = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    if (gammaIsUnity) {
      lutR[i] = Math.max(0, Math.min(255, (i + cal.offsetR + 0.5) | 0));
      lutG[i] = Math.max(0, Math.min(255, (i + cal.offsetG + 0.5) | 0));
      lutB[i] = Math.max(0, Math.min(255, (i + cal.offsetB + 0.5) | 0));
    } else {
      const n = i / 255;
      lutR[i] = Math.max(0, Math.min(255, (Math.pow(n, cal.gammaR) * 255 + cal.offsetR + 0.5) | 0));
      lutG[i] = Math.max(0, Math.min(255, (Math.pow(n, cal.gammaG) * 255 + cal.offsetG + 0.5) | 0));
      lutB[i] = Math.max(0, Math.min(255, (Math.pow(n, cal.gammaB) * 255 + cal.offsetB + 0.5) | 0));
    }
  }

  return {
    refractoryFrames: Math.max(1, Math.round(cal.onsetRefractoryMs / FRAME_MS)),
    onsetDecayFft: Math.pow(0.04, fftSecRatio),
    gammaIsUnity,
    brightnessFloor: cal.brightnessFloor,
    transientGain: cal.transientGain,
    beatDepth: Math.max(0, Math.min(1, cal.beatDepth ?? 0.45)),

    lutR,
    lutG,
    lutB,
  };
}


// --- Calibration ---

export interface LightCalibration {
  gammaR: number; gammaG: number; gammaB: number;
  offsetR: number; offsetG: number; offsetB: number;
  /** HEARTBEAT: snabb attack (snäpper på rise). 1.0 = full snap. */
  attackAlpha: number;
  /** HEARTBEAT: mjuk release (softness-slidern). */
  releaseAlpha: number;
  /** BEAT-detektion: bas-vikt i onset-källan (ej ljusstyrka). */
  bassWeight: number;
  punchWhiteThreshold: number;
  /** Golv i procent — ljuset går aldrig under detta under play. Default 25. */
  brightnessFloor: number;
  /** RAW-/onset-vägen: 0 = av (ingen boost), 0.4 = default. OBS: skalar sedan
   *  2026-08-28 INTE längre ljuspulsen — dirigenten normaliserar pulsen mot dess
   *  nominella mål (0.45) och styr djupet med beatDepth. */
  transientGain: number;
  /** Onset-tröskel: flux > median * onsetThreshold + 0.008 (1.3 = känslig, 2.5 = strikt). UI-default 1.8. */
  onsetThreshold: number;
  /** Minsta gap mellan onsets i ms — räknas om till frames via FRAME_MS (sann 75 Hz). UI-default 110ms. */
  onsetRefractoryMs: number;
   /** Anti-fladder: deadband i normaliserad enhet (0–0.08). Output ändras inte om |Δ| under detta. Skalas perceptuellt med nivå. */
   flickerDeadband: number;
   /** Attack-mjukhet vid låg energi (0–1). Lågt brus snäpper inte → inget flimmer; full snap vid hög energi. Default 0.25. */
   lowSoftFloor: number;
  /** BAS-AVBRUS: input-EMA tidskonstant på ljus-signalen (ms). Kort EMA före dB-mappning tar bort frame-brus utan att sakta riktiga stegringar. Default 35. */
  lightSmoothMs: number;
  /** Absolut energy-gate (totalRms) under vilken onset-detektorn inte processar.
   *  Förhindrar att den adaptiva tröskeln skalar ner till brus och flashar i tysta partier.
   *  0 = av, 0.05 = default, 0.20 = bara stark musik räknas. */
  onsetEnergyFloor: number;
  /** Tystnads-gate i tickInner: under detta är input rumsbrus, inte musik.
   *  0 = av, 0.01 = default. */
  tickEnergyFloor: number;
  /** Beat-källa för onset: 'bass' = endast kick/bas (<150Hz), 'full' = hela spektrumet. Legacy — ersatt av beatCutoffHz. */
  beatSource: 'bass' | 'full';
  /** Lågpass-brytfrekvens (Hz) för beat-detektionen: onset lyssnar på flux UNDER denna frekvens. Default 150 Hz. */
  beatCutoffHz: number;
  /** Drop-detektor på/av. Default true. */
  dropEnabled: boolean;
  /** Drop-känslighet 0.5–3.0 (lägre = lättare att trigga). Default 1.0. */
  dropSensitivity: number;
  /** Varaktighet (ms) för drop-blixten. Default 320. */
  dropFlashMs: number;
  /** Grid-driven puls: när takten är låst fyras pulsen av taktklockan i stället
   *  för av onseten. Default true. */
  beatGridPulse: boolean;
  /** Försprång (ms) på grid-pulsen — kompenserar BLE-skrivlatens (~40–60 ms). */
  beatLeadMs: number;
  /** Mätt kedjelatens ljud→ljus (ms), bara dokumentation/rapport — kompenseras inte. */
  chainLatencyMs?: number;
  /** PLL:ens tempo-integrator: BPM-korrigering per accepterat slag och enhet fasfel (slag). 0 = av. */
  beatBpmGain: number;
  /** Analysator-BPM-hopp mindre an denna ANDEL (0,25 = 25 %) behaller PLL:ens forfinade tempo; samma andel klampar integratorn runt analysatorns varde (utesluter 2x, 3/2, 4/3). */
  beatBpmKeep: number;
  /** PLL: andel av fasfelet som korrigeras per kick (0 = av). */
  beatSyncStrength: number;
  /** Drop-källa: 'analyser' = analysatorns novelty/kropp-baserade dropCount (faller
   *  tillbaka på bas-svackan när takten inte är låst), 'bass' = bara egen svacka. */
  dropSource: 'analyser' | 'bass';
  /** Extra pulsstyrka på ettan när taktfasen (barShift) är känd. 1.0 = av. */
  barAccent: number;
  /** Onset-envelopens stigtid i ms. 0 = instant attack, >0 = EMA (default 40). */
  onsetRiseMs: number;
  /** RISE_HOLD: håll onsetTarget stilla i onsetRiseMs × denna faktor medan boosten
   *  klättrar. Utan hållet jagar boosten ett fallande mål och når bara ~22 % av
   *  full puls — vilket i den multiplikativa kedjan strypte energikopplingen. */
  onsetRiseHoldK: number;
  /** TRUST-RAMP: confidence under detta ger trust 0 (ingen grid-modulation). */
  beatTrustLoConf: number;
  /** Trust-utjamning nedat (ms), asymmetrisk mot beatTrustSmoothMs uppat. */
  beatTrustDownMs?: number;
  /** TRUST-RAMP: confidence över detta ger trust 1 (fullt pulsdjup). */
  beatTrustHiConf: number;
  /** Tidskonstant (ms) på trust-EMA:n — conf kan falla 0.79 → 0.00 mellan två ramar. */
  beatTrustSmoothMs: number;
  /** Golv på trust: låter modulationen leva på FAKTISKA transienter när takten är
   *  otydlig. Utan golv blir energyForm = ceil rakt av — lugnt men dött. */
  beatTrustFloor: number;
  /** MÄTVERKTYG: spela in N faktiskt skickade BLE-ramar till frames.csv.
   *  Triggas genom att sätta fältet till ett NYTT värde. 0 = av. */
  recordFrames: number;
  /**
   * Ska nya latar spelas in? AV = insamlaren later bli, minnet vaxer inte.
   * Redan lagrade latar paverkas inte.
   */
  recordEnabled: boolean;
  /**
   * Ska en lagrad inspelning anvandas for uppspelning? AV = motorn kor
   * realtidsvagen aven for latar den kanner igen.
   *
   * Verkar DIREKT, utan att invanta ett latbyte — den finns for att kunna
   * jamfora de tva vagarna mot samma lat.
   */
  useRecording: boolean;
  /** FACIT, inte styrning (09-18): katalogtempot (Deezer via Sonos artist+titel) doms alltid mot analysatorn och
   *  loggas per lat i tempo-cache.json; bara med true far det DRIVA gridet (testlage). Lampan ska ga pa var analysator. */
  useMetaTempo: boolean;
  /** Sekunder for det konfidensviktade median-tempot som driver gridet (analysatorns ogonblicksvarde hoppar +-5 %). 0 = av. */
  beatTempoSmoothS: number;
  /** OKTAVREGEL ur kick-ringen (09-19): ~4 regelbundna transienter per gridslag vid grid < 100 BPM => presentera 2x. */
  beatOctaveRule: boolean;


  /** DYNAMIK: nedre input-tröskel som fraktion av gainens primärpunkt. level under
   *  inLowFrac × point1.gain → golv. Används BARA i fast-läge (adaptiveCeiling=false). */
  inLowFrac: number;
  /** DYNAMIK: övre input-tröskel som fraktion av gainens primärpunkt. level över
   *  inHighFrac × point1.gain → full. Används BARA i fast-läge. */
  inHighFrac: number;
  /** DYNAMIK: exponent på den expanderade formen. 1.0 = linjär, >1 = mer kontrast. */
  shapeExpand: number;
  /** ADAPTIVT TAK: låt inLow/inHigh följa en långsam medelnivå av level → varje låt
   *  normaliseras till sin egen energi. Default true. */
  adaptiveCeiling: boolean;
  /** Tidskonstant (ms) för det adaptiva takets EMA. Default 7000. */
  ceilFollowMs: number;
  /** Golv på medelnivån → en tyst låt drar inte upp taket på brus. Default 0.12. */
  ceilFloor: number;
  /** Multiplikator medelnivå → inLow. Default 0.55. */
  ceilLowMul: number;
  /** Multiplikator medelnivå → inHigh. Default 1.35. */
  ceilHighMul: number;
  /** DYNAMIK v3: frekvensviktad, FAST dB-mappning. false = gamla adaptiva taket. */
  dbWindow: boolean;
  /** Vikt på midHiRms i den viktade nivån (dB-vägen). Default 1.0. */
  lightHiWeight: number;
  /** Vikt på bassRms i den viktade nivån — höj för mer "kropp". Default 0.0. */
  lightBassWeight: number;
  /** wdb (dB) som mappar till 100 %. Kalibreras live. Default -10. */
  anchorDb: number;
  /** dB-fönstrets bredd: 12 = mer kontrast, 30 = mjukare. Default 18. */
  windowDb: number;
  /** PRE-DROP: hur mycket analysatorns buildUp-tension lyfter ljuset in i droppen. */
  buildUpGain: number;
  /** DIRIGENT: 0..1, hur djupt takten modulerar INOM taket. Default 0.45.
   *  0.70 gav en 2.7× luminanspuls 2.2 ggr/s = strobe; under 0.38 inverteras
   *  "djupet växer med energin". Smakintervall 0.38–0.55. */
  beatDepth: number;
  /** DIRIGENT: 0..1, hur mycket ettan höjer TAKET. Default 0.30.
   *  Inert tills analysatorns barShift faktiskt beräknas. */
  barAccentLift: number;
  /** AUTO-DUBBEL: pulsa i halvslag när låtens takt är under detta (BPM).
   *  0 = av. Default 105 — en lampa som pulsar <105/min känns trög. */
  beatDoubleBelowBpm: number;
  /** Manuell puls-multiplikator (1 = låtens takt, 2 = halvslag). Default 1. */
  beatMultiplier: number;
  /** Energin väljer ½× / 1× / 2× pulsning på gridet. */
  energySubdiv: number;
  subdivHiOn: number; subdivHiOff: number;
  subdivLoOn: number; subdivLoOff: number;
  subdivMinHoldMs: number;
  /** Takt-baserad halvering: pulsa halva takten över detta BPM (0 = av). */
  subdivHalveAboveBpm: number;
  subdivHalveHystBpm: number;
  /** Energiberoende fade-skalning (1.0 = neutral/av). */
  fadeEnergyCalm: number;
  fadeEnergyIntense: number;
  /** Mode B: release-tau skalas med effektivt grid-intervall. */
  fadeMode: number;
  fadeIntervalK: number;
  fadeTauMin: number;
  fadeTauMax: number;
  /** Långsam automatisk centrering av dB-ankaret. */
  autoAnchor: number;
  autoAnchorSec: number;
  anchorOffsetDb: number;
  /** Asymmetrisk input-attack och separat formjämning. */
  lightRiseMs: number;
  shapeSmoothUpMs: number;
  shapeSmoothDownMs: number;

  /** FÄRG-TILT: hur mycket spektralbalansen får värma/kyla palett-färgen.
   *  0 = ren palett, 0.25 = default mild. Påverkar ALDRIG brightness. */
  colorSpectralTilt: number;
  [key: string]: any;
}

const DEFAULT_CAL: LightCalibration = {
  gammaR: 1.0, gammaG: 1.0, gammaB: 1.0,
  offsetR: 0, offsetG: 0, offsetB: 0,
  attackAlpha: 1.0,          // SNABB attack — beats får inte missas
  releaseAlpha: 0.396,       // mjuk fade-out
  bassWeight: 0.95,
  punchWhiteThreshold: 100,
  brightnessFloor: 18,       // verifierat ljusgolv — håller strobe-dalar synliga
  transientGain: 0.45,       // beat-punch (0.2 gav osynlig modulation) — parad med windowDb 18
  onsetThreshold: 2.0,
  onsetRefractoryMs: 200,
  flickerDeadband: 0,        // >0 kvantiserar fade:n till procentsteg = hackigt
  lowSoftFloor: 0.3,
  onsetEnergyFloor: 0.01,
  tickEnergyFloor: 0.01,
  beatSource: 'bass',
  beatCutoffHz: 150,
  dropEnabled: false,
  dropSensitivity: 1.0,
  dropFlashMs: 320,
  beatGridPulse: true,
  beatLeadMs: 72,            // = FADE-IN (2 x onsetRiseMs), inget annat (2026-09-21). Kedjans latens kompenseras INTE: nivakanalen ar
                             // reaktiv och landar beat + chainLatencyMs, pulsens topp ska landa pa samma stalle sa de staplar.
  chainLatencyMs: 30,        // MATT 2026-09-21 (klapp-lage + 240 fps-video): ljud i mic -> ljus = 29-33 ms, LED < 4 ms. Dokumenterad
                             // konstant, andras bara efter ny matning. Hela ljuset ligger alltsa ~30 ms efter musiken - kant och accepterat.
  beatBpmGain: 0,            // 09-18: AV. Tecknet var inverterat (bpm sjonk till -4-klampen, konstant slap 50-80 ms); med ratt tecken
                             // skenade den anda till 2x pa attondelskickar (grindkant-jakten ovan). Tempot ar analysatorns tills en
                             // kick-baserad tempoestimator finns. 1-2 med klamp +-3 % ar nasta forsok (tar bort heltalskvantiseringen).
  beatBpmKeep: 0,            // 09-18: 0 = analysatorns varde tas rakt av vid varje hopp (ursprungsbeteendet). Andel: 0,25 lat integratorn
                             // skena till 224 BPM; OBS tick-sparningen skriver hela cal-objektet, sa ett semantikbyte (BPM -> andel)
                             // forgiftas av den sparade filen (20 lastes som 2000 %).
  beatSyncStrength: 0.2,     // 09-18: 0,1 (k 0,17) holl inte emot tempodriften; 0,2 (k 0,34) med I-gain 8 (var 0.10)
  dropSource: 'analyser',
  barAccent: 1.6,            // ettans accent
  onsetRiseMs: 40,           // 0 gav uppsteg median 26 enheter = strobe; 40 → median 2
  onsetRiseHoldK: 2.0,       // håll målet stilla medan boosten klättrar (bunden hålltid)
  beatTrustLoConf: 0.30,
  beatTrustHiConf: 0.70,
  beatTrustSmoothMs: 400,
  beatTrustFloor: 0.35,      // golvet är den viktiga halvan: modulation på transienter
  recordFrames: 0,
  recordEnabled: true,
  useRecording: true,
  useMetaTempo: false,       // 09-18: FACIT-lage. Katalogen (Deezer) doms mot analysatorn och loggas; true = lat den driva (test)
  beatTempoSmoothS: 12,      // 09-19: "Kla av mig": ogonblicksvardet 97-108 pa 45 s, medianen 101 hela tiden -> 8 om-ankringar blev 0
  beatOctaveRule: true,      // 09-19: "Ego" (Assergard): ring 174 ms x3,96/slag reg 0,84, analysatorn 87, orat: for langsamt -> 2x

  inLowFrac: 0.022,
  inHighFrac: 0.075,
  shapeExpand: 2.0,
  adaptiveCeiling: false,
  ceilFollowMs: 7000,
  ceilFloor: 0.12,
  ceilLowMul: 0.55,
  ceilHighMul: 1.35,
  dbWindow: true,
  lightHiWeight: 1.3,       // mer dynamiskt mid/hi-band utan att ändra beat-vägen
  lightBassWeight: 0.25,    // kropp utan att låsa ljusnivån till basen
  anchorDb: -4,
  windowDb: 10,              // LÅST — ett reglage här förstör hela tuningen
  lightSmoothMs: 350,        // release pa nivavagen ~ett slag (2026-09-20, anvandaren: "attack 0, slapp nastan hela slaget") - 55 ms lat ljuset rita av sangens stavelser; attacken (lightRiseMs 0) ar orord sa slagen landar direkt

  buildUpGain: 0.25,
  beatDepth: 0.62,           // intrimmat 2026-08-30
  barAccentLift: 0.30,
  beatDoubleBelowBpm: 0,     // AV: dubblade i lugna partier kring 105-tröskeln
  beatMultiplier: 1,
  energySubdiv: 1,           // grinden är RELATIV (shapeRel) → ingen fladder
  subdivHiOn: 2,             // utom räckhåll: dubblering AV (2×-grenen fladdrade)
  subdivHiOff: 1.9,
  subdivLoOn: 0.42,
  subdivLoOff: 0.60,
  subdivMinHoldMs: 12000,
  // AV som default (2026-08-31). En hard BPM-grans ger ett KLIPP: 144 BPM pulsade
  // pa 144, 146 pa 73 -- samma latmaterial, halva takten, for en skillnad pa 2 BPM.
  // Anvandaren: "varfor halveras alla med bpm over en viss grans?" Reglaget finns
  // kvar for den som vill ha lugnare puls i snabb musik, men ska inte vara pafors.
  subdivHalveAboveBpm: 0,    // dirigenten väljer presentationstakt, analysen ger tempot
  subdivHalveHystBpm: 15,
  fadeEnergyCalm: 1.0,       // 1.0/1.0 = neutral; aggressivare värden backades av användaren
  fadeEnergyIntense: 1.0,
  fadeMode: 2,
  fadeIntervalK: 0.35,
  fadeTauMin: 0.12,
  fadeTauMax: 1.2,
  autoAnchor: 1,
  autoAnchorSec: 60,
  anchorOffsetDb: 4.5,       // (p95−p50) + 0.08×windowDb, korrigerat mot uppmätt p50
  lightRiseMs: 0,
  shapeSmoothUpMs: 25,       // känsligaste ratten: 250 kväver allt, 15 → strobe, 0 → fladder
  shapeSmoothDownMs: 150,
  colorSpectralTilt: 0.25,
};



/** Rensa bort borttagna legacy-fält ur sparade inställningar (2026-08-25:
 *  Dirigenten omskriven — dynamicCenter/dynamics/perceptual-kurvan/profiler
 *  finns inte längre).
 *  LÄRDOM 2026-08-28: återanvänd ALDRIG ett namn som ligger i denna lista för en
 *  ny funktion. 'lightBassWeight' återinfördes i FIX 3 som ett nytt fält och
 *  raderades vid varje loadCalibration() → bas-viktningen var aldrig aktiv. */
const DROPPED_CAL_KEYS = [
  'transientBoost', 'perceptualCurve', 'perceptualGamma',
  'dynamicDamping', 'dynamicsEnabled', 'intensityInfluence',
  'lightScale', 'centerAdaptSeconds',
  'maxRisePerSec', 'maxFallPerSec', 'saturation',
  'peakBoost',
];


function migrateLegacyCalibration(cal: any): any {
  if (!cal || typeof cal !== 'object') return cal;
  const out = { ...cal };
  // transientBoost: true → 1.0, false → 0
  if (typeof out.transientBoost === 'boolean' && out.transientGain == null) {
    out.transientGain = out.transientBoost ? 1.0 : 0;
  }
  // beatSource: 'full' → hög cutoff (hela spektrumet), 'bass' → 150 Hz. Bara om beatCutoffHz saknas.
  if (out.beatCutoffHz == null && typeof out.beatSource === 'string') {
    out.beatCutoffHz = out.beatSource === 'full' ? 15000 : 150;
  }
  for (const k of DROPPED_CAL_KEYS) delete out[k];
  return out;
}


function loadCalibration(): LightCalibration {
  try {
    const raw = getItem('light-calibration');
    if (raw) {
      const parsed = migrateLegacyCalibration(JSON.parse(raw));
      // C1: null/undefined i en sparad profil får INTE skugga DEFAULT_CAL —
      // annars föll het-pathen tillbaka på divergerande inline-literaler.
      const clean = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null));
      return { ...DEFAULT_CAL, ...clean } as LightCalibration;
    }
  } catch {}
  return { ...DEFAULT_CAL };
}


function saveCalibration(cal: LightCalibration): void {
  setItem('light-calibration', JSON.stringify(cal));
}

/** TV-kalibrering: overlay pa bas-kalibreringen nar Sonos spelar TV (htastream).
 *  Defaults = augusti-trimningen (tight-follow v7/v8: bas 0.5 sa dialog syns,
 *  tystnadsgolv under lugn TV, snabb release, inga drops). Persisteras separat
 *  under 'tv-calibration' sa musikens 'light-calibration' aldrig fororenas. */
export const TV_CAL_DEFAULTS: Partial<LightCalibration> = {
  bassWeight: 0.5, releaseAlpha: 0.85, attackAlpha: 1.0, tickEnergyFloor: 0.0008,
  transientGain: 1.0, flickerDeadband: 0.004, dropEnabled: false,
  punchWhiteThreshold: 100, brightnessFloor: 40,
};
export function loadTvCalibration(): Partial<LightCalibration> {
  try { const raw = getItem('tv-calibration'); if (raw) return { ...TV_CAL_DEFAULTS, ...JSON.parse(raw) }; } catch {}
  return { ...TV_CAL_DEFAULTS };
}

// Cached idle color — only re-parsed when changed via API
let _cachedIdleColor: [number, number, number] = [255, 60, 0];
let _idleColorLoaded = false;

function loadIdleColor(): [number, number, number] {
  if (_idleColorLoaded) return _cachedIdleColor;
  try {
    const raw = getItem('idle-color');
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length === 3) { _cachedIdleColor = p as [number, number, number]; } }
  } catch {}
  _idleColorLoaded = true;
  return _cachedIdleColor;
}

/** Invalidate cached idle color (call after API update) */
export function invalidateIdleColorCache(): void {
  _idleColorLoaded = false;
}

/** Fast color calibration — offset/gamma only.
 *  Saturation/vit-rensning borttagen 2026-04-25: användaren trimmar färgen
 *  i Sonos i stället, så palette-färgen ska komma orörd genom engine.
 *  cal.saturation läses inte längre — fältet bevaras i typen för
 *  bakåtkompatibilitet med sparade profiler. */
function applyColorCalibrationFast(r: number, g: number, b: number, tc: TickConstants): void {
  // Clamp input values quickly and use LUT
  let ri = (r + 0.5) | 0;
  ri = ri < 0 ? 0 : ri > 255 ? 255 : ri;
  let gi = (g + 0.5) | 0;
  gi = gi < 0 ? 0 : gi > 255 ? 255 : gi;
  let bi = (b + 0.5) | 0;
  bi = bi < 0 ? 0 : bi > 255 ? 255 : bi;

  _finalColor[0] = tc.lutR[ri];
  _finalColor[1] = tc.lutG[gi];
  _finalColor[2] = tc.lutB[bi];
}

// Reusable static arrays — zero-alloc
const _finalColor: [number, number, number] = [0, 0, 0];
const _blendColor: [number, number, number] = [0, 0, 0];

// ── Diagnostics snapshot — mutated in-place every tick, zero-alloc ──
export interface DiagSnapshot {
  rawRms: number;
  bassRms: number;
  midHiRms: number;
  bassNorm: number;
  midHiNorm: number;
  /** ABSOLUT amplitud från INPUT (rå RMS × tvåpunktsGain) */
  level: number;
  /** Långsam envelope av level — rå loudness-källa */
  ampEnv: number;
  /** SEKTIONSENERGI från analysatorn, efter heartbeat-smoothing (0..1) */
  shape: number;
  /** Loudness-viktat max för energyForm (floorN..1) */
  ceiling: number;
  /** Loudness-skala från rå amplitud-envelope (0..1) */
  loudness: number;
  /** Slutlig form från intensity + onset-punch (0..1) */
  energyForm: number;
  energyNorm: number;
  onsetBoost: number;
  brightnessPct: number;
  bleScaleRaw: number;
  finalR: number; finalG: number; finalB: number;
  tickCount: number;
  lastTickUs: number;
  inSilence: boolean;
  tickSilenceCount: number;
  /** Frekvensviktad nivå (dB-vägen) */
  wlevel?: number;
  /** 20·log10(wlevel) — mät detta live för att sätta anchorDb */
  wdb?: number;
  /** Långsam EMA av wdb — ankarets underlag (mät wdb/wdbSlow/anchorDb i 2 Hz) */
  wdbSlow?: number;
  /** wdbSlow + anchorOffsetDb — fönstrets ÖVERKANT */
  anchorDb?: number;
}

const _diag: DiagSnapshot = {
  rawRms: 0, bassRms: 0, midHiRms: 0,
  bassNorm: 0, midHiNorm: 0,
  level: 0, ampEnv: 0, shape: 0, ceiling: 0, loudness: 0, energyForm: 0,
  energyNorm: 0, onsetBoost: 0,
  brightnessPct: 0, bleScaleRaw: 0,
  finalR: 0, finalG: 0, finalB: 0,
  tickCount: 0, lastTickUs: 0,
  inSilence: false, tickSilenceCount: 0,
};


// Reusable TickData — mutated in place
const _tickData: TickData = {
  brightness: 0,
  color: [0, 0, 0],
  bassLevel: 0,
  midHiLevel: 0,
  isPlaying: false,
  tickMs: 0,
};

// ── Engine ──

export interface TickData {
  brightness: number;
  color: [number, number, number];
  bassLevel: number;
  midHiLevel: number;
  isPlaying: boolean;
  tickMs: number;
}

export type TickCallback = (data: TickData) => void;

export class PiLightEngine {
  private color: [number, number, number] = [255, 80, 0];
  // Fade-mål: setColor/setPalette sätter detta; tick-loopen tweenar `color` hit
  // över `colorFadeMs` så att lampan inte hoppar när paletten uppdateras sent.
  private colorTarget: [number, number, number] = [255, 80, 0];
  private colorFadeMs = 3000;
  private volume: number | undefined;
  private playing = false;
  private tickMs: number;

  // LOUDNESS: långsam envelope av den ABSOLUTA amplituden (level). Attack ~300ms,
  // release ~2.5s. Den bär inte musikdynamiken; den skalar bara tyst/låg volym.
  private ampEnv = 0;
  private smoothed = 0;  // heartbeat-EMA (snabb attack / mjuk release) @ tick-takt

  // Anti-flicker: senast skickad brightness (post-slew, pre-gamma, 0..1)
  private lastBrightness = 0;
  // Anti-flicker: senast UI-/BLE-rapporterad pct (för deadband-jämförelse)
  private lastSentPct = -1;

  // ── Auto-tune sampler ──
  // När aktiv: sparar varje tick (postSlew, preDeadband) som rå pct (0..100)
  // tillsammans med tickMs. Används av analyzeAutoTuneSamples() för att
  // föreslå maxFallPerSec och flickerDeadband. Ringbuffer med fast tak.
  private autoTuneActive = false;
  private autoTuneStartedAt = 0;
  private autoTuneDurationMs = 0;
  private autoTuneSamples: Float32Array = new Float32Array(0);
  private autoTuneTickMs: Float32Array = new Float32Array(0);
  private autoTunePos = 0;
  private autoTuneCount = 0;
  private autoTuneCap = 0;

  /** Långsam EMA av level — driver det adaptiva taket (per-låt-normalisering). */
  private _slowMean?: number;
  /** BAS-AVBRUS: asymmetrisk EMA av frekvensviktad nivå före dB-mappning. */
  private _wlevelSm?: number;
  /** Synkprov: nar vi senast skrev en rad (throttlas till 10 Hz). */
  private _syncLogAt = 0;
  /** Parade matpunkter for synkkalibreringen: latposition + ra mic-RMS. */
  private _syncPos: number[] = [];
  private _syncRms: number[] = [];
  /** Uppmatt korrigering som laggs pa showuppslaget, ms. */
  private _showOffsetMs = 0;
  private _syncR = 0;
  private _syncDone = false;
  /** Antal par da nasta matningsforsok far goras. */
  private _syncNextAt = SYNC_MIN_SAMPLES;
  /** Antal gjorda matningar och basta korrelation hittills for den har uppspelningen. */
  private _syncTries = 0;
  private _syncBestR = 0;
  private _songArtist = '';
  private _songTitle = '';
  private _songSaveOffset: ((artist: string, title: string, ms: number) => void) | null = null;
  /** KATALOGTEMPO (09-18): publicerat BPM for aktuell lat (Deezer), 0 = inget. Se setMetaTempo + updateBeatClock. */
  private _metaBpm = 0; private _metaSource = ''; private _metaRatio = 0; private _metaVerdict = ''; private _metaDrives = false;
  private _metaVerdictSaver: ((artist: string, title: string, verdict: string, analyserBpm: number, ratio: number) => void) | null = null;
  /** INLARNING (09-18): per lat samlas analysatorns bpm/konfidens (1 Hz) och kick-ringens intervall (var 5 s) och
   *  skrivs vid latbyte till katalogcachen bredvid facit-tempot. Sa lar vi analysatorn - vi ersatter den inte. */
  private _learnBpm: number[] = []; private _learnConf: number[] = []; private _learnRing = new Map<number, number>();
  private _learnLastAt = 0; private _learnLastRingAt = 0; private _learnLastKick = 0; private _learnStartAt = 0;
  private _learnSaver: ((artist: string, title: string, summary: Record<string, number>) => void) | null = null;
  /** TEMPOSTABILITET (09-19): 1 Hz-fonster av analysatorns (bpm, conf); gridet far den viktade medianen. */
  private _tempoWin: Array<{ t: number; bpm: number; conf: number }> = [];
  private _tempoWinLastAt = 0; private _tempoSm = 0;
  /** Oktavregelns senaste ringmatt (per slag) + rakning for inlarningsraden. */
  private _octRingMs = 0; private _octPerBeat = 0; private _octReg = 0; private _octOn = false; private _octBeats = 0; private _octBeatsTotal = 0;
  /** AUTOMATISK OKTAVLEDTRAD (09-19): lard ur facit vid forra spelningen av samma lat (2 = analysatorn en oktav under, 0.5 = over, 1 = ratt/okand). */
  private _octHint = 1;
  /** TEMPOLEDTRAD (09-19): lard klass (facit/analysator) fran forra spelningen av samma lat, med analysatorns median da. */
  private _tempoHintRatio = 1; private _tempoHintAnBpm = 0; private _tempoHintApplied = false;
  /** Gridpulsernas fyrtider (Date.now vid ticken), ring 256 - for PC-analysens slagfas (events.pulses). */
  private _pulseRing = new Float64Array(256); private _pulsePos = 0;
  /** Pagaende landmarkes-inspelning: bas i ljudklockan, slut, och det som samlats. */
  private _capBaseMs = -1;
  private _capUntilMs = -1;
  private _capLabel = '';
  /** Landmarkeslaset — exakt position i den lagrade tidslinjen. */
  private _lock = new SongLock();
  private _lockResolveAt = 0;
  /** Drev showen ljuset den senaste ticken? Utan detta gar det inte att se. */
  private _showDrove = false;
  private _capHash: number[] = [];
  private _capTime: number[] = [];
  /** Långsamt dB-ankare; följer uppåt tre gånger långsammare. */
  private _wdbSlow?: number;
  /** Takjämning före heartbeat-smoothing. */
  private _shapeSm?: number;
  private _shapeSlow?: number;      // ~8 s energi-envelope (grind för pulsdelning)
  private _shapeSlowMax?: number;   // låtens egen topp, 60 s minne
  private _shapeRel = 1;            // _shapeSlow normaliserad mot topp → 0..1


  // Onset detection state — zero-alloc insertion-sort median
  private onsetBuffer: Float64Array;
  private onsetSorted: Float64Array;
  private onsetPos = 0;
  private onsetSize = 0;
  private onsetPrevFlux = 0;
  private onsetBoost = 0;
  private onsetTarget = 0;
  private _prevTarget = 0;
  private _riseHold = 0;
  /** Utjämnad trust (0..1) — ersätter det binära hasBeat-beslutet. */
  private _trustSm?: number;
  // FRAME_RECORDER — mätverktyget: en rad per faktiskt skickad BLE-ram.
  private _recBuf: string[] = [];
  private _recTarget = 0;
  private _recT0 = 0;

  // Refractory period — minimum gap between onsets, räknat i frames (FRAME_MS ≈ 13.33 ms)
  private onsetFrameCounter = 0;
  private onsetLastFrameIdx = -1000;
  // Refractory räknas dynamiskt från cal.onsetRefractoryMs / FRAME_MS (sann takt 75 Hz)

  // ── Drop-detektor (lång tidshorisont, @75Hz på bas-energi) ──
  // Drops är en struktur över sekunder: breakdown/uppbyggnad → plötslig bas-explosion.
  /** B4: återanvänd grid-objekt (enkeltrådad JS → säkert att mutera). */
  private _gridScratch = { bpm: 0, anchorMs: 0 };
  private bassFast = 0;          // EMA ~150ms — aktuell bas-nivå
  private bassSlow = 0;          // EMA ~2.5s — baslinje
  private breakdownFrames = 0;   // antal frames bassFast legat lågt (i förhållande till baslinjen)
  private dropFrameCounter = 0;   // räknar varje processDrop-anrop (@75Hz)
  private dropLastFrameIdx = -100000; // refractory-räknare (frames @75Hz)
  private dropFlashUntil = 0;    // performance.now()-tidsstämpel då vit blixt slutar
  private _analyserDropCount = -1;         // flankreferens mot frame.dropCount (-1 = ej seedad)
  private _dropSourceActive: 'analyser' | 'bass' = 'bass';   // telemetri: vem triggade senast

  // ── Taktklocka (beatClock) + PLL ──
  private _beat: Beat | null = null;   // fas + tempo, knuffad av verkliga kicks
  private _beatDetBpm = 0;             // senast om-ankrat BPM från analysatorn
  private _beatErr = 0;                // utsmetat fasfel (endast telemetri)
  private _pllLastKick = 0;            // senaste ring-kick PLL:en konsumerat (LOTUS_PLL_RING)
  private _phaseLastMs = 0; private _phaseFlipVotes = 0; private _phaseFlips = 0; private _phaseTraceN = 0;   // gridfas-foljaren (LOTUS_PHASE_FOLLOW)
  private _lastGridIdx = -1;           // senaste taktnummer som fyrade en puls
  private _lastGridIdxH = -1;          // senaste HALVSLAG som fyrade en puls (auto-dubbel)
  private _subdivLevel = 0;             // -1 = ½×, 0 = 1×, 1 = 2×
  private _subdivChangedAt = 0;
  private _pulseIntervalMs = 0;
  private _gridPulseCount = 0;
  private _reacqUntil = 0;             // vidgat re-lås-fönster efter låtbyte
  private _beatConfidentAt = 0;        // senast takten var pålitlig (coast-timeout)
  private _beatWasLocked = false;      // har låset varit bekräftat i denna låt?

  private cal: LightCalibration;

  // Precomputed tick constants — refreshed only when tickMs or cal changes
  private tc!: TickConstants;

  private _running = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private ownerTimer: NodeJS.Timeout | null = null;

  private callbacks: TickCallback[] = [];

  // Palette state — endast lagring för API/UI; färgen sätts via setColor vid låtbyte
  private _palette: [number, number, number][] = [];
  private _paletteVersion = 0;
  private _lastSeenPaletteVersion = -1;
  private _lastColorIdx = -1;

  // Raw mode — disables all processors for gain calibration
  private _rawMode = false;
  private _savedCal: Partial<LightCalibration> | null = null;
  // TV-soft mode — bright, gentle band profile for TV/SPDIF playback
  // Dirty-flag for calibration save — avoids unnecessary disk writes
  private _calDirty = false;
  // TV-lage: this.cal ar da bas + TV-overlay. Persisteras ALDRIG som musik.
  private _tvMode = false;

  // ── Frame/analys-taps (valfria observatörer) ──
  // Frame-tap: anropas i reaktiv tickInner med den färg+brightness som accepterats
  // till BLE-writerns 1-slot (faktisk leverans kan droppa äldre frames).
  private _frameTap: ((pct: number, r: number, g: number, b: number) => void) | null = null;
  // Analys-tap: anropas per FFT-frame (~75Hz) med RÅ band/flux FÖRE ljus-estetik.
  private _analysisTap: ((bassRms: number, midHiRms: number, totalRms: number, flux: number) => void) | null = null;
  // Offline-playback/auto-sync borttaget (2026-06): allt körs realtime.

  constructor(tickMs = 25) {
    this.tickMs = tickMs;
    this.cal = loadCalibration();
    setBeatCutoffHz(this.cal.beatCutoffHz);
    this.onsetBuffer = new Float64Array(7);
    this.onsetSorted = new Float64Array(7);
    this.initOnsetBuffer();
    this.tc = computeTickConstants(tickMs, this.cal);
    setSlotLeaseMs(TICK_SYNC ? Math.round(TICK_PERIOD_MS * 0.6) : this.tickMs); // synk: leasen får aldrig blockera nästa rasterfasade write
    // Ankaret fran forra korningen (09-21): yngre an 2 h -> ta det, annars sadd ur signal som forr.
    try {
      const st = JSON.parse(getItem('anchor-state') || 'null');
      if (st && typeof st.wdbSlow === 'number' && Date.now() - (st.at || 0) < 2 * 3600e3) { this._wdbSlow = st.wdbSlow; this._anchorSaved = st.wdbSlow; dlog(`[Engine] ankare aterstallt: ${st.wdbSlow.toFixed(1)} dB (${Math.round((Date.now() - st.at) / 60000)} min gammalt)`); }
    } catch { /* inget sparat */ }
  }
  private _anchorSaved?: number;
  private _anchorFastUntil = 0; private _clipRunMs = 0; private _lastShape?: number;   // ankaret foljer med tau/10 fram till denna tid (play-start/anslutning)

  getPalette(): [number, number, number][] { return this._palette; }
  setVolume(vol: number | undefined) { this.volume = vol; }
  getTickMs(): number { return this.tickMs; }

  setTickMs(ms: number) {
    this.tickMs = ms;
    this.initOnsetBuffer();
    this.tc = computeTickConstants(ms, this.cal);
    setSlotLeaseMs(TICK_SYNC ? Math.round(TICK_PERIOD_MS * 0.6) : this.tickMs);
  }

  setColor(rgb: [number, number, number]) {
    this.colorTarget = [rgb[0], rgb[1], rgb[2]];
  }

  setPalette(palette: [number, number, number][]) {
    if (palette.length > 0) {
      const p = palette[0];
      this.colorTarget = [p[0], p[1], p[2]];
    }
    this._palette = palette;
    this._paletteVersion++;
  }

  /** Justera fade-tid i ms för övergången mellan gammal och ny palette-färg. */
  setColorFadeMs(ms: number) {
    this.colorFadeMs = Math.max(0, ms | 0);
    this.tc = computeTickConstants(this.tickMs, this.cal);
  }

  // ── Record / Playback API ──

  /** Sätt frame-tap (eller null för att koppla bort). */
  setFrameTap(cb: ((pct: number, r: number, g: number, b: number) => void) | null) {
    this._frameTap = cb;
  }

  /** Sätt analys-tap (rå band/flux per FFT-frame), eller null för att koppla bort. */
  setAnalysisTap(cb: ((bassRms: number, midHiRms: number, totalRms: number, flux: number) => void) | null) {
    this._analysisTap = cb;
  }



  private initOnsetBuffer(): void {
    // ~175 ms median-fönster på den SANNA frame-takten (75 Hz) ≈ 13 frames.
    // Tidigare kopplat till tickMs, som inte längre styr frame-takten (gav ~93 ms).
    this.onsetSize = Math.max(3, Math.round(175 / FRAME_MS));

    if (this.onsetBuffer.length < this.onsetSize) {
      this.onsetBuffer = new Float64Array(this.onsetSize);
      this.onsetSorted = new Float64Array(this.onsetSize);
    } else {
      this.onsetBuffer.fill(0);
      this.onsetSorted.fill(0);
    }
    this.onsetPos = 0;
    this.onsetPrevFlux = 0;
    this.onsetBoost = 0;
    this.onsetTarget = 0;
    this.onsetFrameCounter = 0;
    this.onsetLastFrameIdx = -1000;
    this._wlevelSm = undefined;
    this._wdbSlow = undefined;
    this._shapeSm = undefined;
    this._shapeSlow = undefined;
    this._shapeSlowMax = undefined;
    this._shapeRel = 1;
    this._subdivLevel = 0;
    this._subdivChangedAt = 0;
    this._pulseIntervalMs = 0;
    // Drop-detektor-state
    this.bassFast = 0;
    this.bassSlow = 0;
    this.breakdownFrames = 0;
    this.dropFrameCounter = 0;
    this.dropLastFrameIdx = -100000;
    this.dropFlashUntil = 0;
    this._analyserDropCount = -1;   // ny flankreferens mot analysatorns dropCount
  }

  /** Zero-alloc onset detection using precomputed constants.
   *  Triggers a strong, short pulse on each detected transient (kick/snare),
   *  with refractory period to avoid flutter on sustained loud passages. */
  private processOnset(flux: number, allowTrigger = true): boolean {
    const tc = this.tc;
    this.onsetBuffer[this.onsetPos] = flux;
    this.onsetPos = (this.onsetPos + 1) % this.onsetSize;

    // Insertion-sort in-place (N≤7, ~20 comparisons max)
    const n = this.onsetSize;
    const s = this.onsetSorted;
    for (let i = 0; i < n; i++) s[i] = this.onsetBuffer[i];
    for (let i = 1; i < n; i++) {
      const v = s[i];
      let j = i - 1;
      while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; }
      s[j + 1] = v;
    }

    const mid = n >> 1;
    const med = (n & 1) ? s[mid] : (s[mid - 1] + s[mid]) * 0.5;
    // Stricter threshold (cal.onsetThreshold × median + floor) → only real beats trigger, not noise
    // Adaptiv suppression: vid uthålligt hög amplitud (ampEnv > 0.5) höj tröskeln
    // upp till +75% så flux-jitter på "fulla" mixar inte staplar pulser.
    const dc = this.ampEnv;
    const suppression = dc > 0.5 ? 1 + (dc - 0.5) * 1.5 : 1;
    const threshold = med * this.cal.onsetThreshold * suppression + 0.008;

    // False-positive-skydd (2026-06-02):
    //  1) ABS_FLUX_FLOOR — i tystnad/brus faller median mot 0 och tröskeln
    //     kollapsar till +0.008; ett absolut golv hindrar flimmer i tysta partier.
    //  2) PROMINENCE — kräv att flux sticker ut TYDLIGT över median (×1.6),
    //     inte bara passerar den adaptiva tröskeln. Sållar bort sustain-jitter.
    const ABS_FLUX_FLOOR = 0.045;
    const PROMINENCE = 1.6;
    const isCandidate =
      flux > threshold &&
      flux >= this.onsetPrevFlux &&
      flux >= ABS_FLUX_FLOOR &&
      flux >= med * PROMINENCE;
    this.onsetPrevFlux = flux;


    // Refractory gate: minimum gap mellan onsets, i frames på sann takt (hoistad till tc)
    const refractoryFrames = this.tc.refractoryFrames;
    this.onsetFrameCounter++;
    let fired = false;
    if (isCandidate && (this.onsetFrameCounter - this.onsetLastFrameIdx) >= refractoryFrames) {
      fired = true;
      this.onsetLastFrameIdx = this.onsetFrameCounter;
      // strong pulse — clearly visible "in the beat". Hoppas över när gridet driver.
      if (allowTrigger) this.onsetTarget = 0.45;
    }

    // Targeten släpps exakt en gång per frame. I Mode B skalar tau med grid-intervallet
    // så en halv-/dubbelpuls hinner tona ut lagom långt, utan att attacken fördröjs.
    let decay = tc.onsetDecayFft;
    if ((this.cal.fadeMode ?? 0) === 2 && this._pulseIntervalMs > 0) {
      // Energiberoende fade: ett lugnt parti och ett drop i samma låt ska kunna få
      // olika tau. Default 1.0/1.0 = neutral (bara tempot styr).
      const _rel = Math.min(1, Math.max(0, this._shapeRel ?? 1));
      const _fCalm = this.cal.fadeEnergyCalm ?? 1.0;
      const _fInt = this.cal.fadeEnergyIntense ?? 1.0;
      const _fE = _fCalm + (_fInt - _fCalm) * _rel;
      const tau = Math.max(this.cal.fadeTauMin ?? 0.12, Math.min(
        this.cal.fadeTauMax ?? 1.2,
        (this.cal.fadeIntervalK ?? 0.35) * (this._pulseIntervalMs / 1000) * _fE,
      ));
      decay = Math.exp(-(Math.log(tc.onsetDecayFft) / Math.log(0.04)) / tau);
    }
    // RISE_HOLD: med en rise jagade boosten ett FALLANDE mål (decay kördes i samma
    // ram som uppgången) → boost p50 0.10 av 0.45. Håll målet stilla medan boosten
    // klättrar. Hålltiden MÅSTE vara bunden — en EMA når aldrig riktigt fram.
    const _riseMs = this.cal.onsetRiseMs ?? 0;
    if (_riseMs > 0) {
      if (this.onsetTarget > (this._prevTarget ?? 0) + 1e-6)
        this._riseHold = Math.ceil((_riseMs * (this.cal.onsetRiseHoldK ?? 2.0)) / FRAME_MS);   // band-ramar (8 ms vid BAND_EVERY_HOPS 3)
      if (this._riseHold > 0) this._riseHold--;
      else this.onsetTarget *= decay;
    } else {
      this.onsetTarget *= decay;
    }
    this._prevTarget = this.onsetTarget;


    if (this.onsetBoost < this.onsetTarget) {
      // INSTANT ATTACK: pulsen ska landa PÅ slaget, inte krypa dit. Samma princip som
      // attackAlpha=1.0 på ljus-vägen. Stigtiden var uppmätt ~79 ms = hela beat-latensen.
      // onsetRiseMs > 0 ger EMA-beteende igen (bakåtkompatibelt), 0 = instant.
      const riseMs = this.cal.onsetRiseMs ?? 0;
      if (riseMs <= 0) {
        this.onsetBoost = this.onsetTarget;
      } else {
        const a = 1 - Math.exp(-FRAME_MS / riseMs);
        this.onsetBoost += a * (this.onsetTarget - this.onsetBoost);
      }
    } else {
      this.onsetBoost *= decay;
    }


    if (this.onsetBoost < 0.001) { this.onsetBoost = 0; this.onsetTarget = 0; }
    return fired;
  }

  /**
   * TAKTKLOCKAN — tempo från analysatorn, fas låst mot verkliga trumslag (PLL).
   *
   * Tempot om-ankras bara när det avviker >2 BPM (annars ankrar varje litet
   * BPM-hopp om klockan och pulsen läses som stroboskop). Vid om-ankring bevaras
   * fasen. PLL:en knuffar sedan ankaret cal.beatSyncStrength (10 %) av fasfelet
   * per kick, adaptivt skalat med bpmConfidence, och en PI-frekvensterm nollar
   * det permanenta laget när BPM-siffran ligger ett snäpp fel (bunden ±4 BPM).
   */
  /**
   * LÅTBYTE (Sonos trackName ändrades, debouncat i index.ts).
   * En HINT, inte en reset: gatewayen kan rapportera 1-2 s sent och ett byte
   * betyder inte alltid nytt tempo. Nuvarande BPM behålls som startgissning
   * medan tempo-sökningen vidgas i ~5 s, och lås-hållningen (coast) släpps så
   * en verkligt ny takt får ta över direkt.
   */
  /**
   * Slår upp en låt i minnet. Sätts av index.ts; utan den beter sig motorn
   * exakt som förr. Minnet är ett TILLÄGG, aldrig ett krav.
   */
  private _songLookup: ((artist: string, title: string) => any | null) | null = null;
  /**
   * SEKTIONSBETEENDE. Vilket ljus varje del av en lat ska ha.
   *
   * Tabellen kommer fran agarens egen tidigare kod (sectionLighting.ts) och ar
   * konsumentsidan av det strukturmodellen producerar: modellen sager VAD som
   * borjar, tabellen sager vad ljuset ska gora at det.
   *
   * Modellens vokabular ar intro/verse/chorus/bridge/break/inst/solo/outro.
   * `drop` och `build_up` finns INTE dar — de kommer fran dropslistan, som
   * raknas ur ljudets egen energikurva.
   *
   * scale = tak pa ljusstyrkan, pulse = hur djupt takten far modulera.
   */
  private static readonly SECTION: Record<string, { scale: number; pulse: number }> = {
    intro:  { scale: 0.55, pulse: 0.45 },
    verse:  { scale: 0.75, pulse: 0.70 },
    chorus: { scale: 1.00, pulse: 1.00 },
    bridge: { scale: 0.65, pulse: 0.55 },
    break:  { scale: 0.40, pulse: 0.25 },
    inst:   { scale: 0.85, pulse: 0.85 },
    solo:   { scale: 0.90, pulse: 0.90 },
    outro:  { scale: 0.55, pulse: 0.45 },
  };
  /**
   * Hur snabbt sektionsbytet far slaa igenom. Ett hopp i ljusstyrka vid en
   * sektionsgrans syns som ett fel aven nar tidpunkten ar ratt — darfor glidning.
   * 2 s ar ungefar en fras och kanns som en medveten overgang.
   */
  private _secScale = 1;
  private _secPulse = 1;
  /** Normalisering sa latens starkaste sektion ger 1.0. Se notisen i notifyTrackChange. */
  private _secNormS = 1;
  private _secNormP = 1;

  /**
   * UPPSPELNING: latens EGEN energikurva driver ljuset.
   *
   * Utan det har ar minnet bara ett utbytt tempo — ljusstyrkan, formen och
   * dynamiken kommer fortfarande fran micen, och da ar resultatet per definition
   * inte battre an realtidslaget. Anvandaren: "vid inspelning borde ENBART
   * inspelningen atergе ljuset, annars ar det ju meningslost". Precis sa.
   *
   * OCH DET AR BATTRE AN MICEN, inte bara annorlunda: offline ar HELA latens
   * dynamik kand. Realtidsvagen maste gissa var taket ligger utifran de senaste
   * sekunderna (`anchorOffsetDb`/`windowDb` som glider), medan uppspelningen kan
   * satta fonstret exakt mot latens egen 95-percentil — en gang, korrekt.
   */
  /**
   * DEN FARDIGRENDERADE SHOWEN. Ljusstyrka i procent per SHOW_STEP_MS.
   *
   * Nar den finns SLAR motorn bara upp positionen och laser ett tal. Ingen
   * berakning per ram, alltsa ingenting for micens grindar, PLL-drift eller
   * dubbelraknad uppbyggnad att forstora — de kodvagarna kors inte alls.
   *
   * Renderas vid latstart ur den LAGRADE analysen, inte vid inspelning: analysen
   * ar ravara och dyr, renderingen ar presentation och gratis. Sa kan showens
   * uttryck andras utan att en enda lat behover spelas in pa nytt.
   */
  private _show: Uint8Array | null = null;
  /** Palettindex per showsteg. Samma langd som `_show`. */
  private _showColor: Uint8Array | null = null;

  private _pbEnergy: number[] | null = null;   // 0..255, 100 ms-raster
  private _pbRef = 0;                          // latens 95-percentil, 0..255
  private _pbShape = 0;                        // utjamnad form, 0..1

  /**
   * DROPS UR MINNET, FYRADE I FORVAG.
   *
   * Det har ar det enda realtidsanalysen ALDRIG kan gora. Den upptacker en drop
   * forst nar energin redan stigit, och da ar lampan sen — plus BLE-latensen.
   * Med en tidslinje ar dropen kand i forvag och kan fyras FORE.
   *
   * 120 ms ar samma varde systerprojektet pi-dmx kommit fram till for samma sak.
   */
  private static readonly DROP_PRE_MS = 120;
  /**
   * FORVANTAN — det ENDA realtidsanalysen aldrig kan gora.
   *
   * En realtidsmotor upptacker en drop nar energin redan stigit; da ar lampan
   * per definition sen. Med en tidslinje ar dropen kand i forvag, och ljuset kan
   * BYGGA UPP mot den — vilket ar skillnaden mellan att folja musiken och att
   * gestalta den. Det ar hela poangen med att spela in laten.
   *
   * Formen ar den klassiska: en DIPP forst, sedan en stigning. Utan dippen
   * marks inte uppbyggnaden — ljuset maste ge plats at det som ska komma.
   */
  private static readonly BUILD_MS = 5000;   // ~4 takter i 120 BPM
  private static readonly BUILD_DIP = 0.45;  // hur djupt det sjunker vid start
  private static readonly BUILD_TOP = 0.35;  // hur hogt det ar precis fore dropen

  /**
   * PROVAT OCH BORTTAGET 2026-09-02: dubbla presentationstakten nar det lagrade
   * tempot var langsamt (78.9 -> 158).
   *
   * Infordes for att laga "blinkar inte" — men den VERKLIGA orsaken till det var
   * sektionsbuggen: en lat vars enda sektion hette `intro` dampades permanent
   * till 0.55 ljus och 0.45 pulsdjup. Dubblingen var alltsa en fix ovanpa en
   * feldiagnos.
   *
   * Och den gjorde AKTIV SKADA: modellens slaglista for "Stora tuttar" ligger pa
   * 760 ms mellanrum (79 BPM). Pulsas det pa 158 hamnar VARANNAN puls MELLAN
   * slagen, utan musikaliskt stod. Anvandaren: "bara fladdrig, inte alls trevlig
   * att titta pa" — vilket ar precis vad off-beat-pulser ser ut som.
   *
   * LAXA: minnet lagrar det tempo modellen faktiskt hittade slagen pa. Att
   * presentera i ett annat tempo an slagen ligger pa ar att kasta bort det enda
   * minnet vet sakert.
   */

  private _dropIdx = 0;
  private _dropBoost = 0;

  /** Latklockan: var i laten vi ar, pa millisekunden. Se songClock.ts. */
  private _clock = new SongClock();
  /** Hela minnesposten for laten som spelas — sektioner, drops, slag. */
  private _songEntry: any = null;
  /** Tempot vi VET att låten går i, eller 0 om låten är okänd. */
  private _songBpm = 0;

  setSongLookup(fn: ((artist: string, title: string) => { bpm: number } | null) | null): void {
    this._songLookup = fn;
  }

  /**
   * En rainspelning har just borjat. Landmarkena samlas parallellt med ljudet
   * och skrivs till en sidofil nar fonstret stangs.
   */
  notifyCaptureStart(seconds: number, label: string): void {
    const now = audioClockMs();
    this._capBaseMs = now;
    this._capUntilMs = now + Math.max(1, seconds) * 1000;
    this._capLabel = label || '';
    this._capHash = [];
    this._capTime = [];
    startFineEnergy();          // energikurvan i showens egen takt
    dlog('beat', `Landmarken: samlar ${seconds} s for "${label}"`);
  }

  /**
   * Landmarken fran micen. Tva mottagare:
   *   under inspelning  -> samlas till sidofilen (tid RELATIVT inspelningsstart)
   *   alltid            -> matchas mot den spelande latens lagrade landmarken
   */
  private onLandmarks(lms: Landmark[]): void {
    const now = audioClockMs();
    if (this._lock.loaded) {
      for (const lm of lms) this._lock.feed(lm.hash, lm.t);
      // `feed` ar het (en binarsokning per landmarke), `resolve` ar det inte —
      // rakna ihop rosterna en gang i sekunden i stallet for tjugo.
      if (now - this._lockResolveAt >= 1000) { this._lockResolveAt = now; this._lock.resolve(now); }
    }
    if (this._capBaseMs >= 0) {
      if (now > this._capUntilMs) { this.flushCapture(); }
      else {
        for (const lm of lms) {
          if (!lm.store) continue;
          this._capHash.push(lm.hash);
          this._capTime.push(Math.round(lm.t - this._capBaseMs));
        }
      }
    }
  }

  /** Skriv det insamlade och sluta samla. */
  private flushCapture(): void {
    const n = this._capHash.length;
    const label = this._capLabel;
    this._capBaseMs = -1; this._capUntilMs = -1; this._capLabel = '';
    const hash = this._capHash, time = this._capTime;
    this._capHash = []; this._capTime = [];
    const fine = stopFineEnergy();
    if (n < 100 || !label) { dlog('beat', `Landmarken: for fa (${n}) — skippar`); return; }
    // Samma slug-regel som insamlarskriptet ger WAV-filen, sa refinern hittar paret.
    const slug = label.toLowerCase()
      .replace(/[åä]/g, 'a').replace(/ö/g, 'o')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58);
    try {
      // Energikurvan foljer med i samma fil: bada kommer ur SAMMA inspelning och
      // maste dela tidslinje, annars beskriver de olika ogonblick.
      writeFileSync(`${LM_DIR}/${slug}.lm.json`, JSON.stringify({
        label, hash, time,
        energy: fine ? fine.energy : undefined,
        energyStepMs: fine ? fine.stepMs : undefined,
      }));
      dlog('beat', `Landmarken: ${n} skrivna till ${slug}.lm.json`);
    } catch (e: any) { console.warn('[landmarks] kunde inte skriva:', e?.message ?? e); }
  }

  /** Dar en uppmatt synkkorrigering ska sparas. */
  setMetaVerdictSaver(fn: ((artist: string, title: string, verdict: string, analyserBpm: number, ratio: number) => void) | null): void {
    this._metaVerdictSaver = fn;
  }
  setLearnSaver(fn: ((artist: string, title: string, summary: Record<string, number>) => void) | null): void {
    this._learnSaver = fn;
  }
  /** Oktavledtrad for aktuell lat, lard automatiskt ur facit (index.ts). Ignoreras om laten redan bytt. */
  /** Tempoledtrad for aktuell lat (index.ts ur cachen). Grid = analysator x ratio nar analysatorn beter sig som forra gangen. */
  setTempoHint(ratio: number, anBpm: number, artist: string, title: string): void {
    if ((artist || '') !== this._songArtist || (title || '') !== this._songTitle) return;
    this._tempoHintRatio = ratio > 0 ? ratio : 1; this._tempoHintAnBpm = anBpm; this._tempoHintApplied = false;
    if (this._tempoHintRatio !== 1) console.log(`[takt] tempoledtrad x${this._tempoHintRatio.toFixed(3)} for "${title}" (galler nar analysatorn ligger nara ${anBpm})`);
  }
  setOctaveHint(hint: number, artist: string, title: string): void {
    if ((artist || '') !== this._songArtist || (title || '') !== this._songTitle) return;
    this._octHint = hint === 2 || hint === 0.5 ? hint : 1;
    if (this._octHint !== 1) console.log(`[takt] oktavledtrad ${this._octHint}x for "${title}" (lard ur facit vid forra spelningen)`);
  }
  /** 1 Hz: analysatorns bpm/konfidens. Var 5 s: nya kick-intervall ur ringen till ett 5 ms-histogram. */
  private learnSample(frame: { bpm?: number; bpmConfidence?: number } | null): void {
    const now = Date.now();
    if (now - this._learnLastAt < 1000) return;
    this._learnLastAt = now;
    if (!this._learnStartAt) this._learnStartAt = now;
    const b = frame?.bpm ?? 0, c = frame?.bpmConfidence ?? 0;
    if (!this._tvMode && b > 0 && this._learnBpm.length < 900) { this._learnBpm.push(b); this._learnConf.push(c); }   // TV-lage lar inte (09-20)
    if (now - this._learnLastRingAt >= 5000) {
      this._learnLastRingAt = now;
      const ks = getRecentKicks();
      for (let i = 1; i < ks.length; i++) {
        if (ks[i] <= this._learnLastKick) continue;               // redan raknat
        const dt = ks[i] - ks[i - 1];
        if (dt > 0 && dt < 2000) { const bin = Math.round(dt / 5) * 5; this._learnRing.set(bin, (this._learnRing.get(bin) ?? 0) + 1); }
      }
      if (ks.length) this._learnLastKick = ks[ks.length - 1];
    }
  }
  /** Facit-raden: vad analysatorn sa under laten och hur kick-strommen sag ut. ringPerBeat = 4 betyder
   *  fyra regelbundna transienter per analysatorslag ("Ego": analysatorn 86, ringen 172 ms => 4 => 172 BPM). */
  private learnSummary(): Record<string, number> {
    const med = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const bpmMed = med(this._learnBpm);
    let mode = 0, modeN = 0, total = 0;
    for (const [bin, n] of this._learnRing) { total += n; if (n > modeN) { modeN = n; mode = bin; } }
    let wsum = 0, wn = 0;
    for (const [bin, n] of this._learnRing) if (mode > 0 && Math.abs(bin / mode - 1) <= 0.1) { wsum += bin * n; wn += n; }
    const ringMs = wn ? wsum / wn : 0;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    return {
      samples: this._learnBpm.length, durationS: Math.round((Date.now() - this._learnStartAt) / 1000),
      bpmMedian: bpmMed, bpmMin: this._learnBpm.length ? Math.min(...this._learnBpm) : 0, bpmMax: this._learnBpm.length ? Math.max(...this._learnBpm) : 0,
      confMedian: r2(med(this._learnConf)),
      ringIntervalMs: Math.round(ringMs * 10) / 10, ringRegular: total ? r2(wn / total) : 0, ringN: total,
      ringPerBeat: ringMs > 0 && bpmMed > 0 ? r2((60000 / bpmMed) / ringMs) : 0,
      octave2x: this._octBeatsTotal ? r2(this._octBeats / this._octBeatsTotal) : 0,   // andel slag dar oktavregeln presenterade 2x
    };
  }
  private learnReset(): void {
    this._learnBpm = []; this._learnConf = []; this._learnRing = new Map();
    this._learnLastAt = 0; this._learnLastRingAt = 0; this._learnLastKick = 0; this._learnStartAt = 0;
  }
  /** Katalogtempo for aktuell lat (async uppslag: ignoreras om laten redan bytt). Domen faller i
   *  updateBeatClock nar analysatorn har ett sakert varde; tills dess galler katalogen provisoriskt. */
  setMetaTempo(bpm: number, source: string, artist: string, title: string): void {
    if ((artist || '') !== this._songArtist || (title || '') !== this._songTitle) {
      console.log(`[tempo] katalogsvar for annan lat ignoreras (${artist} - ${title})`); return;
    }
    this._metaBpm = bpm > 0 ? bpm : 0; this._metaSource = source; this._metaRatio = 0; this._metaVerdict = bpm > 0 ? 'vantar' : '';
    if (bpm > 0) console.log(`[tempo] katalog ${source}: ${bpm.toFixed(1)} BPM for "${title}" (analysatorn just nu ${getLatestFrame()?.bpm ?? 0})`);
  }
  /** Gridpulser fyrade sedan sinceMs, kronologiskt. Fyrtiden ar ticken; lampan lyser ~beatLeadMs + BLE-latens senare. */
  getRecentPulses(sinceMs: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < 256; i++) { const t = this._pulseRing[i]; if (t >= sinceMs) out.push(t); }
    return out.sort((a, b) => a - b);
  }
  private notePulse(atMs = Date.now()): void { this._pulseRing[this._pulsePos] = atMs; this._pulsePos = (this._pulsePos + 1) & 255; }
  // Prediktiv puls: de senaste slagen som händelser (väggtid för pulsstart = slag − lead, amplitud). Nyckel = slagindex (dedupe ram/tick).
  // HEART-BEAT (2026-09-23): pulsringen och pulsens form bor i heartbeat/heartbeat.ts (PulseTrack, pulseEnvelope, pulseAmpFor) —
  // utbrutet VERBATIM, bevisat bit-identiskt i pi/scripts/heartbeatProof.mjs. Motorn äger bara tidsbaserna och kalibreringen.
  private _pp = new PulseTrack();
  private _ppLastIdxTick = -1e9; private _ppOut = 0;
  private ppPush(idxKey: number, tMs: number, amp: number): void { this._pp.push(idxKey, tMs, amp); }
  private pulseParams(): PulseShapeParams {
    return { riseMs: this.cal.onsetRiseMs ?? 0, riseHoldK: this.cal.onsetRiseHoldK ?? 2.0, fadeMode: this.cal.fadeMode ?? 0, pulseIntervalMs: this._pulseIntervalMs,
      shapeRel: this._shapeRel ?? 1, fadeEnergyCalm: this.cal.fadeEnergyCalm ?? 1.0, fadeEnergyIntense: this.cal.fadeEnergyIntense ?? 1.0,
      fadeTauMin: this.cal.fadeTauMin ?? 0.12, fadeTauMax: this.cal.fadeTauMax ?? 1.2, fadeIntervalK: this.cal.fadeIntervalK ?? 0.35 };
  }
  // KLAPP-LAGE (2026-09-21, matning ljud->ljus): bredbands-onset (flux) -> vit 100 % i 150 ms, annars 5 %. Inga grindar,
  // ingen takt, ingen nivakanal. Slow-mo-video av en klapp ger da: hander mots (bild) vs ljudspik (A/V-offset) vs lampans blixt.
  private _clapMode = false; private _clapLastMs = 0; private _clapAvg = 0;
  setClapMode(on: boolean): void {
    this._clapMode = on; this._clapLastMs = 0; this._clapAvg = 0; this.lastSentPct = -1; console.log(`[klapp] lage ${on ? 'PA' : 'AV'}`);
    // Musiken far vara stoppad: klapp-laget haller motorn i aktivt lage (setPlaying(false) ignoreras sa lange laget ar pa).
    if (on && !this.playing) this.setPlaying(true);
  }
  isClapMode(): boolean { return this._clapMode; }
  private clapDetect(flux: number): void {
    const now = Date.now();
    if (flux > Math.max(0.01, 4 * this._clapAvg) && now - this._clapLastMs > 250) { this._clapLastMs = now; console.log(`[klapp] onset flux ${flux.toFixed(3)} (medel ${this._clapAvg.toFixed(3)})`); }
    this._clapAvg += (flux - this._clapAvg) * 0.02;
  }
  private ppClear(): void { this._pp.clear(); this._ppOut = 0; this._ppLastIdxTick = -1e9; }
  /** Pulsens envelope vid dt ms efter pulsstart: EMA-stigning (onsetRiseMs) mot amp i hold = riseHoldK×rise, sedan exp-avklingning
   *  med samma tau som processOnset (fadeMode 2: fadeIntervalK × pulsintervall, annars 0,04 per s). */
  private ppEnv(dt: number, amp: number): number { return pulseEnvelope(dt, amp, this.pulseParams()); }
  /** Amplitud för slag idx enligt samma regler som ramen (fireBase/accent/subdiv) — 0 = inget slag presenteras. */
  private ppAmpFor(idx: number): number {
    return pulseAmpFor(idx, this._subdivLevel, this.cal.barAccent ?? 1, (getLatestFrame() as any)?.barShift ?? -1);
  }
  /** Ticken (synk): pulsvärdet vid paketets visningsögonblick + look-ahead på slag ramen inte sett än. */
  private ppTick(): void {
    if (!hasBeat(this._beat) || !this.playing) { this._ppOut = 0; return; }
    const lead = this.cal.beatLeadMs; const perfNow = performance.now();
    const tDisp = Date.now() + (nextRasterEventAt(perfNow, this._guardMs) - perfNow) + PULSE_LAMP_MS;
    const per = 60000 / this._beat.bpm; const nowMs = tDisp + lead;
    const idx = beatIndex(this._beat, nowMs);
    if (idx > this._ppLastIdxTick) {
      // Look-ahead: slaget faller inom detta paket men ramen har (kanske) inte sett det – syntetisera med nuvarande beslut.
      this._ppLastIdxTick = idx;
      const amp = this.ppAmpFor(idx); if (amp > 0) this.ppPush(idx, this._beat.anchorMs + idx * per - lead, amp);
    }
    this._ppOut = this._pp.valueAt(tDisp, this.pulseParams());
  }
  /** For /api/status: vad katalogen sa, hur det stamde med analysatorn, och om det driver gridet. */
  get metaTempo(): { bpm: number; source: string; ratio: number; verdict: string; drives: boolean; tempoHint: number; tempoHintApplied: boolean } {
    return { bpm: this._metaBpm, source: this._metaSource, ratio: this._metaRatio, verdict: this._metaVerdict, drives: this._metaDrives, tempoHint: this._tempoHintRatio, tempoHintApplied: this._tempoHintApplied };
  }
  setSongOffsetSaver(fn: ((artist: string, title: string, ms: number) => void) | null): void {
    this._songSaveOffset = fn;
  }

  /** Koppla in landmarkesvagen. Utan detta anrop kostar den ingenting alls. */
  enableLandmarks(on: boolean): void {
    micOnLandmarks(on ? (lms: Landmark[]) => this.onLandmarks(lms) : null);
  }

  /** Vad minnet gav för den låt som spelas nu — för status/UI. */
  get songBpm(): number { return this._songBpm; }

  /**
   * Sonos rapporterade position. Matas sa ofta det gar — klockan anvander bara
   * FORANDRINGAR (flankarna), for vardet sjalvt ar kvantiserat till hela
   * sekunder och darmed ±500 ms. Flanken daremot ar skarp.
   */
  onSonosPosition(posMs: number | null): void {
    this._clock.onPosition(posMs, Date.now());
  }

  /**
   * MAT DET EGNA SYNKFELET och rakna ut korrigeringen.
   *
   * `clockErrorMs` duger inte till detta: den mater forutsagd mot rapporterad
   * position vid varje flank, alltsa klockans KONSEKVENS med sig sjalv. Ligger
   * bade forutsagelsen och referensen en sekund fel blir det mattet noll.
   *
   * Har jamfors i stallet den LAGRADE energikurvan mot vad micen FAKTISKT hor.
   * Toppen i korskorrelationen ar den verkliga forskjutningen. Grov svepning
   * forst, sedan fin kring toppen -- 72 utvarderingar i stallet for 301.
   */
  private _calibrateSync(): void {
    // Matningen gors om nar mer ljud hunnit passera — bade for att ett tyst
    // parti i borjan inte ska doma ut hela laten, och for att mer ljud ger ett
    // stadigare svar. Se SYNC_MAX_TRIES.
    this._syncNextAt = this._syncPos.length + SYNC_RETRY_STEP;
    if (++this._syncTries >= SYNC_MAX_TRIES) this._syncDone = true;
    const ent: any = this._songEntry;
    const e: number[] | undefined = ent?.energy;
    if (!e || e.length < 50) return;
    const rec: number = ent.recordedFromMs || 0;
    const pos = this._syncPos, rms = this._syncRms;

    let mn = Infinity, mx = -Infinity;
    for (const v of rms) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!(mx - mn > 1e-9)) return;
    const span = mx - mn;

    const corrAt = (lag: number): number => {
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let i = 0; i < pos.length; i++) {
        const k = Math.floor((pos[i] + lag - rec) / 100);
        if (k < 0 || k >= e.length) continue;
        const x = e[k] / 255, y = (rms[i] - mn) / span;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      }
      if (n < 200) return -2;
      const cx = sxx - sx * sx / n, cy = syy - sy * sy / n;
      if (cx <= 0 || cy <= 0) return -2;
      return (sxy - sx * sy / n) / Math.sqrt(cx * cy);
    };

    // Grov svepning, sedan fin kring toppen — 72 utvarderingar i stallet for 301.
    const coarse: Array<[number, number]> = [];
    let bestLag = 0, bestR = -2;
    for (let lag = -SYNC_MAX_MS; lag <= SYNC_MAX_MS; lag += 100) {
      const r = corrAt(lag);
      coarse.push([lag, r]);
      if (r > bestR) { bestR = r; bestLag = lag; }
    }
    for (let lag = bestLag - 100; lag <= bestLag + 100; lag += 20) {
      const r = corrAt(lag); if (r > bestR) { bestR = r; bestLag = lag; }
    }
    this._syncR = bestR;
    // Bara ett BATTRE svar an det vi redan har far ersatta det.
    if (bestR <= this._syncBestR) {
      dlog('beat', `Synkmatning kastad: r=${bestR.toFixed(2)} inte battre an ${this._syncBestR.toFixed(2)}`);
      return;
    }
    if (bestR < SYNC_MIN_R) {
      dlog('beat', `Synkmatning kastad: r=${bestR.toFixed(2)} for svag — forsoker igen`);
      return;
    }
    // Ar toppen entydig? Se SYNC_PEAK_MARGIN.
    let rival = -2;
    for (const [lag, r] of coarse) {
      if (Math.abs(lag - bestLag) <= SYNC_PEAK_NEAR_MS) continue;
      if (r > rival) rival = r;
    }
    if (bestR - rival < SYNC_PEAK_MARGIN) {
      dlog('beat', `Synkmatning kastad: toppen otydlig (${bestR.toFixed(2)} mot ${rival.toFixed(2)}) — forsoker igen`);
      return;
    }
    this._syncBestR = bestR;
    // Matpunkterna ar tagna mot RA klockposition, sa svaret ar den ABSOLUTA
    // korrigeringen -- oberoende av vad som redan lag pastalld.
    let want = bestLag + MIC_PIPELINE_MS;
    if (want > SYNC_MAX_MS) want = SYNC_MAX_MS;
    if (want < -SYNC_MAX_MS) want = -SYNC_MAX_MS;
    this._showOffsetMs = want;
    dlog('beat', `Synk kalibrerad: ${want > 0 ? '+' : ''}${want} ms (r=${bestR.toFixed(2)})`);
    try { this._songSaveOffset?.(this._songArtist, this._songTitle, want); } catch { /* minnet far aldrig falla motorn */ }
  }

  /** Latklockans tillstand — for status/UI och for sektionsuppslag. */
  songClockState() { return this._clock.state(Date.now()); }

  /** Var i laten vi ar just nu, ms. null = klockan vet inte an. */
  get songPositionMs(): number | null { return this._clock.state(Date.now()).positionMs; }

  /** Vilken sektion vi ar i just nu, eller '' om okand. For status/UI. */
  get songSection(): string {
    const parts = this._songEntry?.parts;
    if (!parts || !parts.length) return '';
    const pos = this._clock.state(Date.now()).positionMs;
    if (pos == null) return '';
    for (let i = parts.length - 1; i >= 0; i--) if (pos >= parts[i].t) return parts[i].label;
    return '';
  }

  /** Diagnostik for UI: hela minnes-/klocktillstandet i ett svep. */
  get memoryStatus() {
    const c = this._clock.state(Date.now());
    const _lkSt = this._lock.state(audioClockMs());
    return {
      bpm: this._songBpm,
      positionMs: c.positionMs == null ? null : Math.round(c.positionMs),
      /** Uppmatt synkkorrigering och hur stark matningen var. */
      syncOffsetMs: Math.round(this._showOffsetMs),
      syncR: Math.round(this._syncR * 100) / 100,
      /** Landmarkeslaset: roster, hur tydlig toppen ar, och om det haller. */
      /** Finns en renderad show, och drev den ljuset? Utan detta gick det inte
       *  att skilja "kor pa minne" (bara tempot) fran "kor showen". */
      showSteps: this._show ? this._show.length : 0,
      showDrove: this._showDrove,
      /** Senaste 64 slagens rå kickAtMs, kronologiskt. */
      kicks: getRecentKicks(),
      lockVotes: _lkSt.votes,
      lockMargin: _lkSt.margin,
      locked: _lkSt.showMs != null,
      clockEdges: c.edges,
      clockDriftPpm: c.driftPpm,
      clockErrorMs: c.lastErrorMs,
      section: this.songSection,
      sectionScale: Math.round(this._secScale * 100) / 100,
      dropsTotal: this._songEntry?.drops?.length ?? 0,
      dropsFired: this._dropIdx,
      dropBoost: Math.round(this._dropBoost * 100) / 100,
    };
  }

  notifyTrackChange(artist?: string | null, title?: string | null): void {
    // Synkprovet galler EN lat. Nollstall, annars korskorreleras nasta lat mot
    // slutet av den forra och svaret blir brus.
    if (SYNC_PROBE_ON) {
      try {
      writeFileSync(SYNC_PROBE_FILE, '# ' + (artist || '?') + ' - ' + (title || '?') + '\n');
      } catch { /* diagnostik far aldrig stora uppspelningen */ }
    }
    // KÄNT TEMPO SLÅR GISSAT. Realtidsanalysen är kausal och måste prediktera
    // nästa slag; en analys i efterhand har sett hela låten. UPPMÄTT mot
    // Spotify-oberoende facit: LINEDANCE 145 (motorn 96, minnet 146),
    // I'm In a Hurry 129 (motorn 86, minnet 129).
    // OCH minnet har ingen vikning: "Snart tystnar musiken" går i 76 BPM, vilket
    // motorn MÅSTE rapportera som 152 eftersom fönstret är [80,160). Lampan kan
    // därmed äntligen pulsa i låtens eget tempo i stället för dubbelt.
    // INLARNING: forra latens facit-rad skrivs innan allt nollas (minst 10 s data).
    if (this._songTitle && this._learnBpm.length >= 10) {
      try { this._learnSaver?.(this._songArtist, this._songTitle, this.learnSummary()); } catch { /* cachen far aldrig falla motorn */ }
    }
    this.learnReset();
    this._octOn = false; this._octBeats = 0; this._octBeatsTotal = 0; this._octRingMs = 0; this._octPerBeat = 0; this._octReg = 0; this._octHint = 1;
    this._tempoHintRatio = 1; this._tempoHintAnBpm = 0; this._tempoHintApplied = false;
    this._tempoWin = []; this._tempoWinLastAt = 0; this._tempoSm = 0;   // nytt fonster for ny lat (re-acq kor ra i 5 s)
    this._songBpm = 0;
    this._songEntry = null;
    this._metaBpm = 0; this._metaSource = ''; this._metaRatio = 0; this._metaVerdict = ''; this._metaDrives = false;
    // Klockan nollas: ingenting fran forra laten galler. Driften behalls dock —
    // klockfelet tillhor hardvaran, inte laten.
    this._clock.reset();
    this._secScale = 1; this._secPulse = 1;
    this._secNormS = 1; this._secNormP = 1;
    this._pbEnergy = null; this._pbRef = 0; this._pbShape = 0;
    this._show = null; this._showColor = null; this._lastColorIdx = -1;
    this._dropIdx = 0; this._dropBoost = 0;
    this._syncPos = []; this._syncRms = []; this._syncDone = false; this._syncR = 0;
    this._syncNextAt = SYNC_MIN_SAMPLES; this._syncTries = 0; this._syncBestR = 0;
    this._lock.clear(); this._lockResolveAt = 0;
    resetLandmarks();                       // inga par over latgransen
    this._showOffsetMs = 0;
    this._songArtist = artist || ''; this._songTitle = title || '';
    if (this._songLookup && artist && title) {
      try {
        const hit = this._songLookup(artist, title);
        if (hit && hit.bpm > 0) {
          this._songBpm = hit.bpm;
          this._songEntry = hit;
          // Redan uppmatt for den har laten? Da ar den ratt fran forsta sekunden.
          if (typeof hit.syncOffsetMs === 'number') this._showOffsetMs = hit.syncOffsetMs;
          // Landmarken, om laten har nagra. De ar bade skarpare an energikurvan och
          // oberoende av Sonos-positionen — se songLock.ts.
          this._lock.load(hit.lmHash, hit.lmTime,
                          (hit.recordedFromMs || 0) + (hit.analysedSeconds || 0) * 1000);
          // NORMALISERA SEKTIONERNA MOT LATENS EGEN TOPP.
          // Varden ur tabellen ar RELATIVA, inte absoluta nivaer. "Status behov"
          // har EN sektion och den heter `intro` -> hela laten hamnade pa 0.55
          // ljus och 0.45 pulsdjup, alltsa permanent dampad. Anvandaren:
          // "mindre show an nar vi kor live... mycket besviken". Helt riktigt.
          // Den STARKASTE sektion en lat har ska alltid ge fullt ljus; tabellen
          // beskriver bara forhallandet MELLAN delarna.
          let mS = 0, mP = 0;
          for (const p of (hit.parts ?? [])) {
            const sp = PiLightEngine.SECTION[p.label];
            if (sp) { if (sp.scale > mS) mS = sp.scale; if (sp.pulse > mP) mP = sp.pulse; }
          }
          this._secNormS = mS > 0 ? 1 / mS : 1;
          this._secNormP = mP > 0 ? 1 / mP : 1;
          // Referensniva ur latens EGEN fordelning. 95-percentilen och inte
          // maxvardet: ett enda anslag ska inte definiera vad "fullt" betyder.
          const e: number[] | undefined = hit.energy;
          if (e && e.length > 50) {
            const srt = [...e].sort((x, y) => x - y);
            this._pbRef = srt[Math.floor(srt.length * 0.95)] || 0;
            this._pbEnergy = this._pbRef > 0 ? e : null;
          } else { this._pbEnergy = null; this._pbRef = 0; }
          // Rendera hela showen en gang. Kraver slag ELLER energikurva — utan
          // nagot av dem finns inget att gestalta och realtidsvagen far ta over.
          this._show = null; this._showColor = null;
          try {
            if ((hit.beats && hit.beats.length > 4) || (hit.energy && hit.energy.length > 20)) {
              this._show = renderShow({
                bpm: hit.bpm, beats: hit.beats, beatPositions: hit.beatPositions,
                downbeats: hit.downbeats, parts: hit.parts, drops: hit.drops,
                energy: hit.energy, analysedSeconds: hit.analysedSeconds,
                recordedFromMs: hit.recordedFromMs,
              }, { ...DEFAULT_SHOW, floorPct: this.cal.brightnessFloor ?? 18,
                    beatDepth: this.cal.beatDepth ?? 0.62 });
              this._showColor = lastRenderedColors();
              dlog('beat', `Show renderad: ${this._show.length} steg (${Math.round(this._show.length * SHOW_STEP_MS / 1000)} s)`);
            }
          } catch { this._show = null; }
          dlog('beat', `Låtminne: ${artist} – ${title} = ${hit.bpm} BPM` +
' (känt)');
        }
      } catch { /* minnet får aldrig fälla motorn */ }
    }

    const now = Date.now();
    this._reacqUntil = now + 5000;
    this._beatWasLocked = false;      // coast gäller inom EN låt
    this._beatConfidentAt = now;      // ge nya låten full coast-budget
    this._beatDetBpm = 0;             // nästa analysator-BPM får om-ankra direkt
    hintAnalyserTrackChange(5000);
    dlog('beat', `Track change → re-acquisition window 5s (guess ${Math.round(this._beat?.bpm ?? 0)} BPM)`);
  }

  private updateBeatClock(kick: boolean): void {
    const frame = getLatestFrame();
    // KÄNT TEMPO SLÅR ANALYSATORNS. Fasen kommer fortfarande från micen — den är
    // BRA på fas (uppmätt −8 ms) och dålig på tempo, och det är precis tempot
    // minnet tar över. Sonos egen position duger inte till fas: den är
    // kvantiserad till hela sekunder (uppmätt), alltså ±500 ms = ett helt slag.
    // Samma reglage galler tempot: ar inspelningen avstangd ska INGET komma ur
    // minnet, annars vore jamforelsen mot realtid inte arlig.
    const _useRec = this.cal.useRecording !== false;
    let _memBpm = _useRec ? this._songBpm : 0;
    // KATALOGTEMPO (09-18): nar latminnet inte driver far ett publicerat BPM (Deezer via Sonos
    // artist+titel) gora det — men bara om det stammer med analysatorn: kvot 1/2, 1, 2
    // (analysatorns fonster [80,160) viker oktaver) eller 2/3, 3/2 (dess kanda fantomer), inom
    // +-5 %. En felmatchad lat far aldrig styra ljuset. Tills analysatorn har ett sakert varde
    // galler katalogen provisoriskt (battre an ingenting). Domen sparas i katalogcachen.
    // FACIT-LAGE (09-18, anvandarens beslut): domen falls ALLTID (det ar lardatan), men katalogen far
    // driva gridet bara med useMetaTempo=true. Lampan ska ga pa var analysator - katalogen lar den.
    this._metaDrives = false;
    if (this._metaBpm > 0 && this._metaVerdict === 'vantar') {
      const an = frame?.bpm ?? 0, ac = frame?.bpmConfidence ?? 0;
      if (an > 40 && ac >= 0.6) {
        const r = this._metaBpm / an;
        const cls = [0.5, 1, 2, 2 / 3, 1.5, 4 / 3, 0.75].find((x) => Math.abs(r / x - 1) < 0.05);   // 4/3, 3/4 tillagda 09-19 (rapporten: 2 av 10 latar)
        this._metaRatio = r;
        this._metaVerdict = cls === undefined ? 'avvisat' : ((cls === 0.5 || cls === 1 || cls === 2) ? 'ok' : 'ok-fantom');
        console.log(`[tempo] facit ${this._metaBpm.toFixed(1)} vs analysatorn ${an}: ${this._metaVerdict} (kvot ${r.toFixed(2)})`);
        try { this._metaVerdictSaver?.(this._songArtist, this._songTitle, this._metaVerdict, an, r); } catch { /* cachen far aldrig falla motorn */ }
      }
    }
    if (_memBpm <= 0 && this._metaBpm > 0 && this.cal.useMetaTempo === true && this._metaVerdict !== 'avvisat') { _memBpm = this._metaBpm; this._metaDrives = true; }
    this.learnSample(frame);
    const nowMs = Date.now();
    const reacq = nowMs < this._reacqUntil;
    // TEMPOSTABILITET (09-19): analysatorns ogonblicksvarde hoppade 97-108 pa 45 s ("Kla av mig",
    // conf 0,5-0,96) -> atta om-ankringar och fasfel -50..+38 vid varje. Medianen over samma 45 s
    // var 101 hela tiden. Gridet far darfor ett konfidensviktat median-tempo over de senaste
    // beatTempoSmoothS sekunderna (1 Hz-sampel, conf >= 0,5); ra-vardet bara under re-acquisition
    // (ny lat) och tills fonstret har 5 sampel. Reagerar pa ett riktigt tempobyte pa ~halva fonstret.
    const rawBpm = frame?.bpm ?? 0, rawConf = frame?.bpmConfidence ?? 0;
    const smoothS = this.cal.beatTempoSmoothS ?? 12;
    if (smoothS > 0 && nowMs - this._tempoWinLastAt >= 1000) {
      this._tempoWinLastAt = nowMs;
      if (rawBpm > 40) this._tempoWin.push({ t: nowMs, bpm: rawBpm, conf: rawConf });
      while (this._tempoWin.length && nowMs - this._tempoWin[0].t > smoothS * 1000) this._tempoWin.shift();
      const good = this._tempoWin.filter((x) => x.conf >= 0.5);
      if (good.length >= 5) {
        const sorted = [...good].sort((a, b) => a.bpm - b.bpm);
        const tot = sorted.reduce((s, x) => s + x.conf, 0); let acc = 0; let m = sorted[0].bpm;
        for (const x of sorted) { acc += x.conf; if (acc >= tot / 2) { m = x.bpm; break; } }
        this._tempoSm = m;
      } else this._tempoSm = 0;
    }
    let anBpm = (!reacq && smoothS > 0 && this._tempoSm > 0) ? this._tempoSm : rawBpm;
    // TEMPOLEDTRAD (09-19, rapporten "Tio latar mot facit"): analysatorn hade ratt tempo i 3 av 10, fantom 3/2
    // eller 4/3 i 4, halva i 1. Domen vid latslut sparas som klass pa laten; nasta spelning multipliceras
    // analysatorns (medianade) varde med klassen - men bara nar analysatorn ligger inom +-8 % av vad den
    // sa forra gangen, sa en analysator som denna gang har ratt inte forstors. Inlarning tillampad,
    // inte katalogstyrning: fasen och tempot kommer fortfarande ur ljudet.
    if (!reacq && this._tempoHintRatio !== 1 && anBpm > 0 && this._tempoHintAnBpm > 0 && Math.abs(anBpm / this._tempoHintAnBpm - 1) < 0.08) {
      anBpm *= this._tempoHintRatio;
      if (!this._tempoHintApplied) { this._tempoHintApplied = true; console.log(`[takt] tempoledtrad tillampad: analysatorn ${(anBpm / this._tempoHintRatio).toFixed(1)} -> grid ${anBpm.toFixed(1)}`); }
    }
    const bpm = _memBpm > 0 ? _memBpm : anBpm;
    // Ett känt tempo är inte en gissning — låt inte en svag mic sänka förtroendet.
    const conf = _memBpm > 0 ? Math.max(rawConf, 0.9) : rawConf;

    if (bpm > 40) {
      // Under re-acquisition räcker 0.5 BPM avvikelse för att om-ankra (annars 2),
      // så en ny takt landar utan att glida in via PLL:en.
      if (!this._beat || Math.abs(bpm - this._beatDetBpm) > (reacq ? 0.5 : 2)) {
        this._beatDetBpm = bpm;
        let anchor = frame?.beatAnchorMs || nowMs;
        let bpmNew = bpm;
        if (this._beat) {
          // TEMPO (09-18): analysatorns BPM ar HELTAL och hoppade 105-114 pa en lat vars
          // kick-ring gav 110,8 (parsummor av attondelsintervall). Varje hopp >2 satte
          // gridets bpm till ett fel heltal, klampen +-4 runt det nadde inte ens ratt
          // tempo, och P-steget stod i jamvikt mot driften pa -75 ms ("takten kanns
          // efter"). Sma hopp behaller darfor PLL:ens forfinade bpm; bara ett riktigt
          // tempobyte (>= beatBpmKeep) eller re-acquisition tar analysatorns varde.
          if (!reacq && Math.abs(bpm - this._beat.bpm) < bpm * (this.cal.beatBpmKeep ?? 0.25)) bpmNew = this._beat.bpm;
          // Bevara nuvarande fas vid tempoändring så pulsen inte hoppar.
          const oldMs = 60000 / this._beat.bpm, newMs = 60000 / bpmNew;
          // Bevara slagindex + fas (k = (now - anchor)/period), inte bara fasen - annars nollstalls beatIndex och gridpulsen fyrar (17:15)
          const kk = (nowMs - this._beat.anchorMs) / oldMs;
          anchor = nowMs - kk * newMs;
        }
        this._beat = { anchorMs: anchor, bpm: bpmNew, confidence: conf };
      } else {
        this._beat.confidence = conf;
      }
    }

    // ── COAST: håll låset genom breakdowns ──
    // Inom SAMMA låt (ingen track-change-hint) och när låset en gång varit
    // bekräftat: en confidence-dipp får inte tappa taktlåset — då flappar
    // grid-pulserna av/på i varje tyst parti. Vi behåller tempo+fas och låter
    // PLL:en re-synka mjukt när slagen kommer tillbaka. Låset släpps bara vid
    // faktiskt låtbyte eller >8 s helt utan pålitlig takt.
    if (this._beat) {
      if ((this._beat.confidence ?? 0) >= MIN_BEAT_CONFIDENCE) {
        this._beatConfidentAt = nowMs;
        this._beatWasLocked = true;
      } else if (this._beatWasLocked && !reacq && nowMs - this._beatConfidentAt < 8000) {
        this._beat.confidence = MIN_BEAT_CONFIDENCE;    // coasta på rutnätet
      } else if (this._beatWasLocked && nowMs - this._beatConfidentAt >= 8000) {
        this._beatWasLocked = false;                    // långvarig taktlöshet → släpp
      }
    }

    // Ge analysatorn vårt grid: den grindar kick-kandidater mot takten och kan
    // räkna taktfas (barShift). Utan grid faller den tillbaka på ogrindad flux.
    // B4: scratch-objekt i stället för nyallokering var frame (~75 Hz) — enda
    // kvarvarande per-frame-heap-allokeringen i den heta loopen (matade GC-pausen).
    if (this._beat) {
      this._gridScratch.bpm = this._beat.bpm;
      this._gridScratch.anchorMs = this._beat.anchorMs;
      setAnalyserBeatGrid(this._gridScratch);
    } else {
      setAnalyserBeatGrid(null);
    }

    if (!this._beat) return;

    // RINGEN, INTE TICKEN (09-18): frame.kickAtMs ar nollskild pa EN hop per slag,
    // sa ticken (1 av 7-9 hoppar) sag den nastan aldrig och foll tillbaka pa sin
    // egen Date.now() = onset-detektorn pa bandtakt + tickkvantisering. Uppmatt
    // (histogram ring-kick mot grid, 143 kickar, P=9): gridet 52 ms SENT, IQR 42 ms,
    // och det fick beatLeadMs (132 = 87 stigtid + 45 utlatens) aldrig kompensera.
    // Ringen bar analysatorns sub-hop-tid (+-1,3 ms) for VARJE slag; hogst ett nytt
    // per tick (slag >=100 ms isar). LOTUS_PLL_RING=0 ger gamla vagen for A/B.
    if (PHASE_FOLLOW_ON) {
      const pm = frame?.beatPhaseMs ?? 0;
      if (pm <= 0 || pm === this._phaseLastMs) return;            // ingen ny fasmatning (4 Hz) - kickar styr inte
      this._phaseLastMs = pm;
      // SAMMA TEMPO (15:10, live-spar): vid latbyten ligger gridet kvar pa forra tempot (150 mot analysatorns 101) i
      // sekunder - fasfelet ar da meningslost och flyttade ankaret slumpmassigt (flip var 0,75 s). Folj bara nar
      // analysatorns tempo = gridets (+-4 %); annars hall.
      const anB = frame?.bpm ?? 0;
      if (anB <= 0 || Math.abs(anB / this._beat.bpm - 1) >= 0.04) { this._phaseFlipVotes = 0; return; }
      const beatMsNow = 60000 / this._beat.bpm;
      const ph = ((((pm - PHASE_BIAS_MS - this._beat.anchorMs) % beatMsNow) + beatMsNow) % beatMsNow) / beatMsNow;
      const err = ph < 0.5 ? ph : ph - 1;                          // -0,5..0,5 slag: + = analysatorns slag ligger EFTER gridet
      const pconf = frame?.beatPhaseConf ?? 1;
      this._beatErr = this._beatErr * 0.85 + err * 0.15;
      if (PHASE_TRACE && this._phaseTraceN < 400) { this._phaseTraceN++; console.log(`[fasspar] now ${nowMs} pm ${Math.round(pm)} anchor ${Math.round(this._beat.anchorMs)} bpm ${this._beat.bpm.toFixed(2)} anBpm ${frame?.bpm} err ${err.toFixed(3)} conf ${pconf.toFixed(2)} kick ${Math.round(frame?.beatAnchorMs ?? 0)}`); }
      if (Math.abs(err) > 0.35) {
        if (pconf >= PHASE_FLIP_CONF && ++this._phaseFlipVotes >= PHASE_FLIP_VOTES) {
          // KICKARNA SOM DOMARE (09-21, "dubbelblink"): analysatorns fas flyttade gridet 0,4 slag fram och tillbaka inom en
          // minut (kvot 3,2/6,0) pa 16-delsbas -> pulsen mellan kickarna medan energin foljer kickarna = tva bumpar per slag.
          // Flytta bara om de senaste ~8 slagens riktiga kickar ligger tydligt narmare den nya fasen an den gamla.
          const ks = getRecentKicks(); const since = nowMs - 8 * beatMsNow; let n = 0, sCur = 0, sNew = 0;
          const newAnchor = this._beat.anchorMs + err * beatMsNow;
          for (let i = ks.length - 1; i >= 0 && ks[i] >= since; i--) {
            const k = ks[i]; n++;
            const pc = ((((k - this._beat.anchorMs) % beatMsNow) + beatMsNow) % beatMsNow) / beatMsNow;
            const pn = ((((k - newAnchor) % beatMsNow) + beatMsNow) % beatMsNow) / beatMsNow;
            sCur += Math.cos(2 * Math.PI * pc); sNew += Math.cos(2 * Math.PI * pn);
          }
          const ok = n < 6 || (sNew / n) > (sCur / n) + 0.15;
          this._phaseFlipVotes = 0;
          if (ok) {
            this._beat.anchorMs = newAnchor; this._phaseFlips++;
            console.log(`[takt] gridfas: fasen flyttad ${Math.round(err * beatMsNow)} ms (kvot ${pconf.toFixed(2)}, byte ${this._phaseFlips}, kickar ${n}: ny ${n ? (sNew / n).toFixed(2) : '-'} mot ${n ? (sCur / n).toFixed(2) : '-'})`);
          } else {
            this._phaseFlipDenied++;
            if (this._phaseFlipDenied <= 3 || this._phaseFlipDenied % 20 === 0) console.log(`[takt] gridfas: flytt ${Math.round(err * beatMsNow)} ms NEKAD av kickarna (${n} st: ny ${(sNew / n).toFixed(2)} mot nu ${(sCur / n).toFixed(2)}, kvot ${pconf.toFixed(2)}, nekade ${this._phaseFlipDenied})`);
          }
        }
        return;
      }
      this._phaseFlipVotes = 0;
      const kf = pconf >= 1.3 ? PHASE_KP_HI : PHASE_KP_LO;
      this._beat.anchorMs += err * beatMsNow * kf;
      this._clock.trimToBeat(-err * beatMsNow * kf, beatMsNow);
      // INTEGRAL: ihallande fel at samma hall = tempofel. err > 0 = analysatorns slag ligger EFTER gridet = gridet gar for fort -> bpm ner.
      if (PHASE_KI_BPM > 0) {
        const lo = anB * 0.96, hi = anB * 1.04; let nb = this._beat.bpm - err * PHASE_KI_BPM;
        if (nb < lo) nb = lo; else if (nb > hi) nb = hi;
        // SPOKPULSER (17:15): 'nowMs - fas*period' nollstallde slagINDEXET (beatIndex) vid varje tempobyte (4 Hz) -> gridpulsen
        // fyrade pa index-hoppet: 2,47 pulser/s pa 95 BPM (1,59 slag/s). Bevara hela k = index + fas.
        if (nb !== this._beat.bpm) { const kk = (nowMs - this._beat.anchorMs) / beatMsNow; this._beat.bpm = nb; this._beat.anchorMs = nowMs - kk * (60000 / nb); }
      }
      return;
    }
    let nowRef: number;
    if (PLL_RING_ON) {
      const rk = getLatestKickAt();
      if (rk <= 0 || rk === this._pllLastKick) return;      // inget nytt slag sedan sist
      this._pllLastKick = rk;
      if (nowMs - rk > 200) return;                          // gammalt (paus/omstart) - hoppa
      nowRef = rk;
    } else {
      if (!kick) return;
      // Fasen mäts helst mot analysatorns FÄRDIGMÄTTA slagtid (sub-hop, ±1.3 ms).
      // Date.now() här bär ALSA-leveransens jitter. Bara färska värden duger.
      const kickAt = frame?.kickAtMs ?? 0;
      nowRef = kickAt > 0 && nowMs - kickAt < 60 ? kickAt : nowMs;
    }

    const k0 = this.cal.beatSyncStrength;
    const beatMsNow = 60000 / this._beat.bpm;
    const ph = ((((nowRef - this._beat.anchorMs) % beatMsNow) + beatMsNow) % beatMsNow) / beatMsNow;

    const err = ph < 0.5 ? ph : ph - 1;    // -0.5..0.5 av ett taktslag
    if (Math.abs(err) >= 0.25) return;     // off-beat/synkoperade slag räknas ej
    this._beatErr = this._beatErr * 0.85 + err * 0.15;   // ihållande lag för UI
    if (k0 <= 0) return;

    let k = k0 * (0.3 + 1.4 * conf);       // tydlig takt → snabbare inlåsning
    if (k > 0.4) k = 0.4; else if (k < 0.03) k = 0.03;
    this._beat.anchorMs += err * beatMsNow * k;
    // SISTA TRIMNINGEN. PLL:ens fasfel ar redan uppmatt har — mata in det i
    // latklockan sa den far millisekundsupplosning ur micen. Klockan begransar
    // sjalv till ett halvt slag, sa en granne-beat kan aldrig dra den en hel takt.
    this._clock.trimToBeat(-err * beatMsNow, beatMsNow);
    if (conf > 0.4) {
      // TECKNET (09-18): err<0 = kicken kom FORE gridlinjen = gridet gar for langsamt
      // -> bpm ska UPP. Med '+=' sjonk bpm i stallet monotont till -4-klampen (uppmatt
      // 105,7 -> 104,1 pa 23 s mot analysatorns 108) och P-steget fick halla ett
      // konstant slap pa 50-80 ms - "takten kanns efter". Gain som kal-falt for live-A/B.
      this._beat.bpm -= err * (this.cal.beatBpmGain ?? 0.35) * conf;
      // Klampen ar ett OKTAVSKYDD (2x laser ocksa perfekt pa attondelskickar), inte en tempokalla:
      // +-25 % av analysatorns varde. +-4/+-8/+-20 BPM nadde inte sant tempo (analysatorn 105-114 mot 123, 130 mot ~156).
      const _kf = this.cal.beatBpmKeep ?? 0.25;
      const lo = this._beatDetBpm * (1 - _kf), hi = this._beatDetBpm * (1 + _kf);
      if (this._beat.bpm < lo) this._beat.bpm = lo;
      else if (this._beat.bpm > hi) this._beat.bpm = hi;
    }
  }

  /** Taktklockans tillstånd — för /api/status och UI. */
  getBeatInfo(): {
    locked: boolean; bpm: number; confidence: number; phase: number;
    nextBeatMs: number; beatErr: number; gridPulses: number; leadMs: number; chainMs: number;
    subdivLevel: number; octave: { on: boolean; hint: number; ringMs: number; perBeat: number; reg: number }; energySm: number; trust: number; shapeSm?: number; shapeSlow?: number; shapeRel: number;
    dropSrc: 'analyser' | 'bass'; coasting: boolean; reacquiring: boolean;
  } {
    const now = Date.now();
    const lead = this.cal.beatLeadMs;
    return {
      locked: hasBeat(this._beat),
      bpm: this._beat?.bpm ?? 0,
      confidence: this._beat?.confidence ?? 0,
      phase: beatPhase(this._beat, now, lead),
      nextBeatMs: hasBeat(this._beat) ? nextBeatIn(this._beat, now, lead) : 0,
      beatErr: this._beatErr,
      gridPulses: this._gridPulseCount,
      subdivLevel: this._subdivLevel,
      octave: { on: this._octOn, hint: this._octHint, ringMs: Math.round(this._octRingMs), perBeat: Math.round(this._octPerBeat * 100) / 100, reg: Math.round(this._octReg * 100) / 100 },
      trust: Math.max(this.cal.beatTrustFloor ?? 0.35, this._trustSm ?? 0),
      energySm: this.smoothed,
      shapeSm: this._shapeSm,
      shapeSlow: this._shapeSlow,
      shapeRel: this._shapeRel,
      leadMs: lead,
      chainMs: this.cal.chainLatencyMs ?? 30,
      dropSrc: this._dropSourceActive,
      coasting: this._beatWasLocked && (getLatestFrame()?.bpmConfidence ?? 0) < MIN_BEAT_CONFIDENCE,
      reacquiring: now < this._reacqUntil,
    };
  }

  /**
   * Drop-detektor @75Hz på bas-energi. Drops är en lång-horisont-struktur:
   * breakdown/uppbyggnad (lugnt parti) → plötslig bas-explosion. Skiljer sig
   * från onset (70ms-transient) genom att kräva ett föregående nedbrutet parti.
   * Triggar en stor vit punch-blixt (dropFlashUntil) som overridas i tickInner.
   */
  private processDrop(bassRms: number, frame: Frame | null): void {
    if (!this.cal.dropEnabled) return;
    // KOR EN FORINSPELAD SHOW? Da ager showen ljuset, hela vagen.
    //
    // Livedetektorn gjorde en EXPRESS-SKRIVNING till BLE med full styrka sa
    // fort micen horde en drop, och tvingade sedan pct=100 i dropFlashMs —
    // forbi showen, som satts EFTERAT i tickInner och alltsa forlorade.
    //
    // Resultatet var precis vad agaren rapporterade: showen svartar ner strax
    // FORE dropen, och landar livedetektorns blixt i den svartningen far man en
    // full ljuspuff nagra hundra ms for tidigt. Det lases som "dropen kom for
    // tidigt", och morkret som blir ljust lases som "ljusstyrkan ar inverterad".
    //
    // Tva sanningar om samma dropp kan inte bada galla. Den inspelade ar den
    // battre: den VET nar dropen kommer och kan bygga upp mot den, medan
    // livedetektorn per definition upptacker den forst efterat.
    // (grindas nedan vid AVFYRNINGEN, inte har — detektorns glidande medel
    //  maste halla sig varma sa den inte fyrar falskt nar en OKAND lat tar vid.)
    this.dropFrameCounter++;

    // Tidsbaserade EMA:er (dt-konstanterna är 100 Hz-kalibrerade, se M4): fast ~150ms, slow ~2.5s.
    const FAST_ALPHA = 0.064;
    const SLOW_ALPHA = 0.004;
    if (this.bassSlow <= 0) {
      this.bassFast = bassRms;
      this.bassSlow = bassRms;
    } else {
      this.bassFast += FAST_ALPHA * (bassRms - this.bassFast);
      this.bassSlow += SLOW_ALPHA * (bassRms - this.bassSlow);
    }

    const sens = this.cal.dropSensitivity > 0 ? this.cal.dropSensitivity : 1.0;
    const BREAKDOWN_RATIO = 0.6;          // bassFast < 60% av baslinjen = lugnt parti
    const MIN_BREAKDOWN_FRAMES = 40;      // ≥400ms lugnt innan ett drop kan triggas
    const JUMP_FACTOR = 1.8 * sens;       // bassFast måste överstiga baslinjen så mycket
    const ABS_BASS_FLOOR = 0.06;          // absolut energi → ingen drop i tystnad
    const REFRACTORY_FRAMES = 400;        // ~4s mellan drops

    // Spåra/erodera breakdown-minnet (också när analysatorn driver dropen — den
    // egna detektorn måste vara varm den sekund taktlåset tappas).
    if (this.bassFast < this.bassSlow * BREAKDOWN_RATIO) {
      if (this.breakdownFrames < 1000) this.breakdownFrames++;
    } else if (this.breakdownFrames > 0) {
      this.breakdownFrames -= 2; // erodera över ~1s när det blir högt igen
      if (this.breakdownFrames < 0) this.breakdownFrames = 0;
    }

    // ANALYSATORNS DROP (steg 1): dropCount är MONOTON, så en flankjämförelse mot
    // vårt eget senaste värde kan aldrig missa ett drop även om vi läser glesare.
    // Den detektorn är novelty/kropp-baserad och ser drops utan bastapp, vilket
    // bas-svackan nedan per definition inte gör. Kräver taktlås — utan bpm är
    // analysatorns strukturlogik inte varm, och då är bas-svackan bättre än inget.
    const analyserOwns = this.cal.dropSource !== 'bass' && frame != null && frame.bpm > 40;
    let isDrop: boolean;
    if (analyserOwns) {
      const dc = frame!.dropCount;
      if (this._analyserDropCount < 0) { this._analyserDropCount = dc; }
      isDrop = dc > this._analyserDropCount &&
        (this.dropFrameCounter - this.dropLastFrameIdx) >= REFRACTORY_FRAMES;
      this._analyserDropCount = dc;
    } else {
      this._analyserDropCount = -1;   // ny flankreferens när/om analysatorn tar över igen
      isDrop =
        this.breakdownFrames >= MIN_BREAKDOWN_FRAMES &&
        this.bassFast >= ABS_BASS_FLOOR &&
        this.bassFast >= this.bassSlow * JUMP_FACTOR &&
        (this.dropFrameCounter - this.dropLastFrameIdx) >= REFRACTORY_FRAMES;
    }
    this._dropSourceActive = analyserOwns ? 'analyser' : 'bass';

    if (isDrop && !this._show) {
      this.dropLastFrameIdx = this.dropFrameCounter;
      this.breakdownFrames = 0;
      const _now = performance.now();
      // White INSTANTLY on drop — no black dip first (no dip branch exists).
      this.dropFlashUntil = _now + (this.cal.dropFlashMs);
      bleStatsState.dropCount++;
      // Express-write: max brightness omedelbart, behåll palette-färgen
      // (2026-07-22: ingen vit tvingning — drop förstärker aktuell färg).
      if (this._bleOwner === 'active') {
        const r = this.color[0] | 0, g = this.color[1] | 0, b = this.color[2] | 0;
        const result = sendToBLE(r, g, b, 100);
        if (result === 'sent') this.lastSentPct = 100;
      }
    }
  }


  private forceIdleNow(): void {
    const idle = loadIdleColor();
    const r = idle[0] | 0, g = idle[1] | 0, b = idle[2] | 0;
    setIdleColor(r, g, b);
    // Reflektera idle-färgen i diagnostics så /api/live visar rätt
    // färg i UI:t. tickInner uppdaterar bara _diag i playing-mode, så utan
    // detta visar UI:t 0,0,0 (svart) hela tiden lampan står i idle.
    _diag.finalR = r;
    _diag.finalG = g;
    _diag.finalB = b;
    _diag.brightnessPct = 100;
    _tickData.color[0] = r;
    _tickData.color[1] = g;
    _tickData.color[2] = b;
    _tickData.brightness = 100;
  }

  // ── BLE owner-switch ──
  // EN väg åt gången: 'idle' (keep-alive @200ms bär idle-färg + länk),
  // 'active' (sendToBLE per FFT-tick under play), eller 'none' (BLE ej ansluten).
  // Övergångar sker via onBleConnected/onBleDisconnected/setPlaying.
  // tickInner returnerar tidigt om owner !== 'active' (skydd mot sen FFT-frame
  // som försöker skriva efter pause).
  private _bleOwner: 'idle' | 'active' | 'none' = 'none';

  /** True om BLE är ansluten (owner !== 'none'). */
  private get _bleConnected(): boolean { return this._bleOwner !== 'none'; }

  // ── Idle-disconnect (2 min utan musik → koppla från lampan + stoppa ALSA) ──
  // Sparar ~20-25% CPU på Pi Zero 2 W under långa pauser. Reconnect triggas
  // enbart av Sonos PLAYING-event (audio-wake medvetet uteslutet pga rumssamtal).
  // Se mem://pi/runtime/idle-disconnect-policy.
  private _idleDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleEnteredAt: number | null = null;
  private _idleColorPending = false;
  private _micPausedForIdle = false;
  private _lastPlayingChangeAt = 0;
  private static readonly IDLE_DISCONNECT_MS = 2 * 60 * 1000;
  private static readonly PLAYING_DEBOUNCE_MS = 500;

  /** Status-getter för /api/status. Null om ingen idle-timer aktiv. */
  getIdleEnteredAt(): number | null { return this._idleEnteredAt; }
  isMicPausedForIdle(): boolean { return this._micPausedForIdle; }

  private clearIdleDisconnectTimer(): void {
    if (this._idleDisconnectTimer) {
      clearTimeout(this._idleDisconnectTimer);
      this._idleDisconnectTimer = null;
    }
    this._idleEnteredAt = null;
  }

  /** Publik nedrivning som lifecycle anropar vid PAUSED→IGNITION-övergång.
   *  Skickar idle-färg @ 100%, drainar HCI, stoppar keep-alive, BLE off, mic stop.
   *  Mid-flight aborts om this.playing flippar tillbaka. */
  async shutdownToIgnition(): Promise<void> { return this.handleIdleDisconnect(); }

  private async handleIdleDisconnect(): Promise<void> {
    this._idleDisconnectTimer = null;
    if (this._bleOwner === 'none') {
      this._idleColorPending = true;
      this._idleEnteredAt = null;
      dlog('[Engine] shutdownToIgnition: BLE nere — idle-färg schemalagd till nästa connect');
      return;
    }
    this._idleColorPending = false;
    dlog('[Engine] Idle-disconnect: idle-färg @ 100% → drain HCI → BLE off → ALSA stop');

    // 1. Sista write: idle-färg @ full ljusstyrka så lampan står lyst efter disconnect.
    const idle = loadIdleColor();
    try { sendToBLE(idle[0], idle[1], idle[2], 100); } catch (e: any) {
      dlog(`[Engine] sendIdleFullBrightness failed: ${e?.message ?? e}`);
    }
    flushQueuedWriteNow();

    // 2. Vänta tills 1-slot + HCI-kön är tom så paketet faktiskt går iväg (max 500ms).
    const deadline = Date.now() + 500;
    while (hasQueuedWrite() || (isControllerDrainAttached() && getOutstandingPackets() > 0)) {
      if (Date.now() > deadline) {
        dlog('[Engine] Outstanding-wait timeout — fortsätter ändå');
        break;
      }
      await new Promise(r => setTimeout(r, 20));
      // Mid-flight abort: Sonos PLAYING kan komma in under drain-fönstret.
      // Då har wake-pathen i index.ts redan kallat alsaMic.startMic() och
      // ev. connectHardcoded() — vi får INTE fortsätta riva ner.
      if (this.playing) {
        dlog('[Engine] Idle-disconnect avbruten under drain — Sonos PLAYING kom emellan');
        this._idleEnteredAt = null;
        return;
      }
    }

    // 3. Stoppa keep-alive innan disconnect (förhindrar race med write-failure).
    stopKeepAlive();

    // 4. Disconnect (markeras som auto → Sonos PLAYING får reconnecta senare).
    try { await triggerIdleDisconnect(); } catch (e: any) {
      dlog(`[Engine] triggerIdleDisconnect failed: ${e?.message ?? e}`);
    }

    // Mid-flight abort #2: även efter triggerIdleDisconnect kan PLAYING ha
    // landat. Skippa stopMic så wake-pathens startMic() inte direkt dödas.
    if (this.playing) {
      dlog('[Engine] Idle-disconnect: BLE redan disconnectad men PLAYING kom — hoppar över stopMic');
      this._idleEnteredAt = null;
      return;
    }

    // 5. Stoppa ALSA-mic → ~20-25% CPU-besparing under idle.
    try {
      stopMic();
      // STATUSEN MASTE FOLJA VERKLIGHETEN (2026-09-22): subsystemet stod kvar pa 'ready' efter stopMic(), och da hoppade
      // bade lifecycle:s toMotorOn och POST /api/subsystem/mic/start over starten -> ALSA oppnades aldrig igen. Ljuset frots
      // pa sista bandvardet i 45 min (bara gridpulsen rorde sig). 'idle' = micen ar nere och far startas om.
      resetSubsystem('mic');
      this._micPausedForIdle = true;
      dlog('[Engine] ALSA-mic stoppad (subsystem → idle) — väntar på Sonos PLAYING-event');
    } catch (e: any) {
      dlog(`[Engine] stopMic failed: ${e?.message ?? e}`);
    }

    this._idleEnteredAt = null;
  }

  /** Anropas av connect-hardcoded EFTER lyckad anchor write.
   *  Keep-alive kör BARA i idle-mode. Under playing räcker FFT-write-kedjan
   *  (med min 5 pkt/s garanti via stale-write-force i protocol.ts) för att
   *  hålla länken vid liv. Det hindrar att keep-alive bygger kö parallellt
   *  med active path. */
  onBleConnected(): void {
    if (this._bleOwner !== 'none') return;
    this._bleOwner = this.playing ? 'active' : 'idle';
    // Färsk session — rensa ev. pending idle-disconnect-timer + mic-paus-flagga.
    this.clearIdleDisconnectTimer();
    this._micPausedForIdle = false;
    if (!this.playing) {
      if (this._idleColorPending) {
        this._idleColorPending = false;
        dlog('[Engine] pending idle-färg → skickar direkt vid connect');
      }
      this.forceIdleNow();
      clearQueuedWrite();
      startKeepAlive();
      dlog(`[Engine] BLE connected → idle mode (keep-alive PÅ)`);
    } else {
      // Ren start: rensa onset så första riktiga beat ger en tydlig
      // puls istället för att blandas med stale state från senaste sessionen.
      this.onsetBoost = 0;
      this.onsetTarget = 0;
      this.smoothed = 0;
      this.ppClear();
      this._wlevelSm = undefined;
      // ANKARET BEHALLS (09-21): _wdbSlow = undefined har gav en ny sadd + 6 min klattring (autoAnchorSec x3) vid varje
      // paus/anslutning/omstart = ljuset klippt mot taket utan dynamik. Ankaret ar en langsam nivaskattning av musiken
      // och ska overleva; volymbyten foljs av tau/farAbove-logiken. Sparas aven till disk (anchor-state.json).
      this._shapeSm = undefined;
      this.lastBrightness = 0;
      this.lastSentPct = -1;
      this._lastTickAtForFade = 0;  // första fade efter play ska börja från noll-elapsed
      this._lastSmoothAt = 0;       // återställ tidsbaserad EMA-klocka
      stopKeepAlive();
      dlog(`[Engine] BLE connected → active mode (keep-alive AV — FFT-writes håller länken)`);
    }
  }

  /** Anropas av connect-hardcoded vid disconnect (peripheral.disconnect-event). */
  onBleDisconnected(): void {
    if (this._bleOwner === 'none') return;
    this._bleOwner = 'none';
    clearQueuedWrite();
    stopKeepAlive();
    // Rensa idle-timer (kan vara pending om disconnect kom innan timeout fyrade).
    this.clearIdleDisconnectTimer();
    dlog('[Engine] BLE disconnected → owner=none, keep-alive STOPPAD');
  }

  setPlaying(playing: boolean): void {
    if (!playing && this._clapMode) { dlog('[klapp] setPlaying(false) ignoreras i klapp-lage'); return; }
    const now = Date.now();
    const wasPlaying = this.playing;
    if (playing === wasPlaying) return;

    // Anti-flap debounce: Sonos kan rapportera PLAYING→STOPPED→PLAYING
    // inom <1s vid trackbyte. 500ms guard filtrerar bort snabba PAUSED-flaps.
    // VIKTIGT: debouncen gäller ENBART PLAYING→PAUSED. PLAYING måste alltid
    // släppas igenom omedelbart — annars riskerar vi att engine fastnar i
    // idle om en spurious PAUSED kom precis innan riktig PLAYING.
    //
    // BUGFIX 2026-05-02: tidigare returnerade vi UTAN att schemalägga
    // re-check, vilket innebar att PAUSED-eventet tappades för gott
    // (nästa poll såg playing===wasPlaying och tog tidig return). Det
    // gjorde att idle-disconnect aldrig triggade om paus skedde nära ett
    // trackbyte. Nu schemalägger vi en deferred re-call så state följer
    // verkligheten även när första PAUSED-flippen kommer för tidigt.
    if (!playing && now - this._lastPlayingChangeAt < PiLightEngine.PLAYING_DEBOUNCE_MS) {
      const remaining = PiLightEngine.PLAYING_DEBOUNCE_MS - (now - this._lastPlayingChangeAt);
      dlog(`[Engine] setPlaying(false) debounced — re-checkar om ${remaining}ms`);
      setTimeout(() => {
        // Vid re-check: om engine fortfarande tror att vi spelar OCH
        // ingen ny PLAYING har kommit emellan → applicera PAUSED nu.
        if (this.playing) this.setPlaying(false);
      }, remaining + 10);
      return;
    }
    this._lastPlayingChangeAt = now;

    this.playing = playing;
    dlog(`[Engine] setPlaying(${playing}) — wasPlaying=${wasPlaying}, owner=${this._bleOwner}`);

    if (playing) this._idleColorPending = false;

    if (!playing) {
      // active → idle: reset onset + force idle-färg, starta keep-alive.
      this.onsetBoost = 0;
      this.onsetTarget = 0;
      this.smoothed = 0;
      this.ppClear();
      this._wlevelSm = undefined;
      // ANKARET BEHALLS (09-21): _wdbSlow = undefined har gav en ny sadd + 6 min klattring (autoAnchorSec x3) vid varje
      // paus/anslutning/omstart = ljuset klippt mot taket utan dynamik. Ankaret ar en langsam nivaskattning av musiken
      // och ska overleva; volymbyten foljs av tau/farAbove-logiken. Sparas aven till disk (anchor-state.json).
      this._shapeSm = undefined;
      this.lastBrightness = 0;
      this.lastSentPct = -1;
      this._lastTickAtForFade = 0;
      this._lastSmoothAt = 0;
      this.stopLoop();
      if (this._bleOwner !== 'none') {
        this._bleOwner = 'idle';
        clearQueuedWrite();
        this.forceIdleNow();
        startKeepAlive();
        dlog('[Engine] → idle mode (owner=idle, keep-alive PÅ — väntar på lifecycle.shutdownToIgnition)');
        // Lifecycle (engineLifecycle.ts) schemalägger shutdownToIgnition()
        // efter IGNITION_REENTRY_GRACE_MS och cancellerar om PLAYING kommer tillbaka.
      } else {
        dlog('[Engine] → idle mode (BLE ej ansluten)');
      }
    } else {
      // idle → active: stoppa keep-alive (FFT-writes tar över), starta loop.
      // Keep-alive får ALDRIG köra parallellt med active path — det skulle
      // bygga kö i HCI-lagret.
      this.clearIdleDisconnectTimer();
      this._anchorFastUntil = Date.now() + 20_000;   // volymen kan ha bytts under pausen
      this.startLoop();
      if (this._bleOwner !== 'none') {
        this._bleOwner = 'active';
        stopKeepAlive();
        dlog('[Engine] → active mode (owner=active, keep-alive AV, FFT-writes håller länken)');
      } else {
        dlog('[Engine] → active mode (BLE ej ansluten, loop startad men inga writes)');
      }
    }
  }

  reloadCalibration(): void {
    this.applyCal();
    this._calDirty = true; // mark for next save cycle
  }

  /** Bas-kalibrering + ev. TV-overlay + ev. raw-override -> this.cal + tc.
   *  Enda vagen som satter this.cal, sa alla lagen komponeras pa samma satt. */
  private applyCal(): void {
    const base = loadCalibration();
    this.cal = this._tvMode ? ({ ...base, ...loadTvCalibration() } as LightCalibration) : base;
    setBeatCutoffHz(this.cal.beatCutoffHz);
    if (this._rawMode) this.cal.transientGain = 0;
    this.tc = computeTickConstants(this.tickMs, this.cal);
  }

  /** TV-lage pa/av (Sonos spelar htastream). Aterstallning = samma reload fran persisterat. */
  setTvMode(on: boolean): void {
    if (on === this._tvMode) return;
    this._tvMode = on;
    // TV-LAGE LAR INTE (2026-09-20, anvandaren): TV har inget latnamn, sa notifyTrackChange kors aldrig och forra latens
    // larackumulatorer skulle annars fyllas med TV-ljud tills nasta riktiga lat (och dess dom/facit-rad forgiftas).
    // Vid TV-start skrivs forra latens rad (om >= 10 s data) och allt nollas; under TV ackumuleras inget (se learnPush).
    // Fangster/facit/katalog ar redan gatade: TV = tomt namn = inget latbyte (index.ts noteTrackName).
    if (on) {
      if (this._songTitle && this._learnBpm.length >= 10) {
        try { this._learnSaver?.(this._songArtist, this._songTitle, this.learnSummary()); } catch { /* cachen far aldrig falla motorn */ }
      }
      this.learnReset();
    }
    this.applyCal();
    console.log(`[Engine] TV-kalibrering ${on ? 'PA' : 'AV'} (bassWeight=${this.cal.bassWeight}, tickEnergyFloor=${this.cal.tickEnergyFloor}, floor=${this.cal.brightnessFloor})`);
  }
  isTvMode(): boolean { return this._tvMode; }
  /** PUT /api/tv-calibration: aterapplicera om TV-laget ar aktivt. */
  reloadTvCalibration(): void { if (this._tvMode) this.applyCal(); }

  /** Enable raw mode — disables all processors for gain calibration */
  setRawMode(on: boolean): void {
    if (on && !this._rawMode) {
      this._rawMode = true;
      this._savedCal = {
        transientGain: this.cal.transientGain,
      };
      this.cal.transientGain = 0;
      this.tc = computeTickConstants(this.tickMs, this.cal);
      dlog('[Engine] Raw mode ON — all processors disabled');
    } else if (!on && this._rawMode) {
      this._rawMode = false;
      if (this._savedCal) {
        Object.assign(this.cal, this._savedCal);
        this._savedCal = null;
      }
      this.tc = computeTickConstants(this.tickMs, this.cal);
      dlog('[Engine] Raw mode OFF — processors restored');
    }
  }

  isRawMode(): boolean { return this._rawMode; }


  /** Initialize engine — call once at boot. Loop only starts when setPlaying(true). */
  start(): void {
    if (this._running) return;
    this._running = true;

    // Register for FFT-driven ticks (event-driven, not polling)
    onFFTReady(() => this.onFFTFrame());
    onFluxReady((flux) => {
      if (this._clapMode) this.clapDetect(flux);
      if (this._loopActive && this.playing && this._bleOwner === 'active') {
        // Energy gate (2026-05-02): låt inte den adaptiva tröskeln skala ner
        // till brusgolvet och flasha i tysta partier. Hämtar bands EN gång
        // och delar med dynamicCenter-uppdateringen nedan.
        const bands = getLatestBands();
        // Analysatorns frame används bara när den är FÄRSK (<60 ms, samma guard
        // som PLL:en). Är den gammal faller varje steg nedan tillbaka på den
        // egna FFT-vägen i stället för att styra ljuset på inaktuell struktur.
        const frame = Date.now() - getLatestFrameAt() < 60 ? getLatestFrame() : null;
        const energyFloor = this.cal.onsetEnergyFloor;
        const peakBand = bands ? Math.max(bands.bassRms, bands.midHiRms) : 0;
        const passesEnergyGate =
          energyFloor <= 0 ||
          (bands != null && Number.isFinite(peakBand) && peakBand >= energyFloor);
        // Grid-driven puls (taktklockan) tar över pulsen när takten är låst OCH
        // pålitlig; annars driver den verkliga onseten pulsen som förut.
        const gridDrives = this.cal.beatGridPulse !== false && hasBeat(this._beat);
        let kickFired = false;
        if (passesEnergyGate) {
          // Lågpass-onset: bassFlux är analysatorns per-band-onsets under
          // cal.beatCutoffHz (setBeatCutoffHz) — kick skild från basgång redan
          // vid källan. Faller tillbaka på bredbands-flux om bands saknas.
          const beatFlux = bands ? bands.bassFlux : flux;

          // Onset-detektionen körs ALLTID (PLL:en behöver flankerna) — men den får
          // bara sätta pulsen när gridet inte driver den.
          kickFired = this.processOnset(beatFlux, !gridDrives);
        }
        // Taktklocka: tempo från analysatorn, fas låst mot verkliga kicks (PLL).
        this.updateBeatClock(kickFired);
        // Grid-pulsen med leadMs försprång → toppen landar PÅ slaget trots BLE-latensen.
        if (gridDrives && passesEnergyGate) {
          const nowMs = Date.now() + this.cal.beatLeadMs;
          const idx = beatIndex(this._beat, nowMs);
          const bpmNow = this._beat?.bpm ?? 0;
          const baseIntervalMs = bpmNow > 0 ? 60000 / bpmNow : 0;
          const energySubdiv = (this.cal.energySubdiv ?? 0) > 0;
          // GRINDEN MÅSTE VARA RELATIV: this.smoothed är per-slag-enveloppen (faller
          // mot noll MELLAN slagen) och _shapeSm är för snabb → grinden växlade i takt
          // med slagen (4–5 Hz fladder). Egen ~8 s-envelope normaliserad mot låtens
          // EGEN topp (60 s minne) — en fast tröskel kan aldrig fungera eftersom
          // shapeSlow-medianen flyttar sig med materialet (0.480 → 0.232).
          const _shRaw = (this._shapeSm ?? this.smoothed);
          const _aSlow = Math.min(1, (this.tickMs || 18) / 8000);
          this._shapeSlow = this._shapeSlow == null ? _shRaw : this._shapeSlow + (_shRaw - this._shapeSlow) * _aSlow;
          const _decay = (this.tickMs || 18) / 60000;
          this._shapeSlowMax = this._shapeSlowMax == null ? this._shapeSlow
            : Math.max(this._shapeSlow, this._shapeSlowMax - this._shapeSlowMax * _decay);
          // Under 0.02 finns ingen meningsfull topp (tystnad) → 1, så vi INTE halverar på brus.
          const energy = this._shapeSlowMax > 0.02 ? Math.min(1, this._shapeSlow / this._shapeSlowMax) : 1;
          this._shapeRel = energy;
          const current = this._subdivLevel;

          if (idx !== this._lastGridIdx) {
            let next = current;
            // Takt-baserad halvering FÖRST: den energistyrda grinden fyrar bara i
            // genuint lugna partier, så en 157-BPM-låt pulsade i 2.6 Hz utan detta.
            // FÖRETRÄDE: takt-regeln är auktoritativ. Två separata if-block utan
            // else lät energiblocket skriva över takt-beslutet → fyrkantsvåg
            // (2.30 ↔ 1.15 Hz var 12:e sekund).
            const _halveAbove = this.cal.subdivHalveAboveBpm ?? 0;
            let _bpmWants: number | null = null;
            if (_halveAbove > 0 && bpmNow > 0) {
              const _back = _halveAbove - (this.cal.subdivHalveHystBpm ?? 15);
              if (bpmNow > _halveAbove) _bpmWants = -1;
              else if (bpmNow < _back) _bpmWants = 0;
            }
            // OKTAVREGEL UR RINGEN (09-19, forsta regeln ur facit-lardatan): analysatorns fonster
            // [80,160) viker oktaver, och pa "Ego" (Assergard) gav den 86/87 medan kick-ringen hade
            // 174 ms-transienter x3,96 per gridslag med regelbundenhet 0,84 - och orat sa "for
            // langsamt". Ovriga Assergard-latar: x3,3 reg 0,3-0,5 -> ingen dubbling. Regeln laser
            // ringen en gang per slag (senaste 64 kickar ~18 s): ~4 regelbundna per slag vid grid
            // < 100 BPM => presentera 2x (samma vag som energySubdiv). Hysteres + 10 s hallning.
            let _octWants: number | null = null;
            if (this.cal.beatOctaveRule !== false && bpmNow > 0) {
              const ks = getRecentKicks(); const bins = new Map<number, number>(); let n = 0;
              for (let i = 1; i < ks.length; i++) { const dt = ks[i] - ks[i - 1]; if (dt > 40 && dt < 2000) { const b = Math.round(dt / 10) * 10; bins.set(b, (bins.get(b) ?? 0) + 1); n++; } }
              let mode = 0, modeN = 0; for (const [b, c] of bins) if (c > modeN) { modeN = c; mode = b; }
              let ws = 0, wn = 0; for (const [b, c] of bins) if (mode > 0 && Math.abs(b / mode - 1) <= 0.1) { ws += b * c; wn += c; }
              this._octRingMs = wn ? ws / wn : 0; this._octReg = n ? wn / n : 0;
              this._octPerBeat = this._octRingMs > 0 ? baseIntervalMs / this._octRingMs : 0;
              const pb = this._octPerBeat, rg = this._octReg;
              const onCond = n >= 20 && bpmNow < 100 && pb >= 3.7 && pb <= 4.3 && rg >= 0.7;
              const holdCond = n >= 12 && bpmNow < 105 && pb >= 3.4 && pb <= 4.6 && rg >= 0.5;
              if (!this._octOn && onCond) { this._octOn = true; console.log(`[takt] oktavregel 2x PA: ring ${this._octRingMs.toFixed(0)} ms x${pb.toFixed(2)}/slag reg ${rg.toFixed(2)} (grid ${bpmNow.toFixed(1)})`); }
              else if (this._octOn && !holdCond) { this._octOn = false; console.log(`[takt] oktavregel 2x AV: ring ${this._octRingMs.toFixed(0)} ms x${pb.toFixed(2)}/slag reg ${rg.toFixed(2)} (grid ${bpmNow.toFixed(1)})`); }
              if (this._octOn) _octWants = 1;
              this._octBeatsTotal++; if (this._octOn) this._octBeats++;
            } else this._octOn = false;
            // LARD LEDTRAD gar fore ringregeln: facit vid forra spelningen sa att analysatorn ligger en
            // oktav under (2) eller over (0.5) pa just den har laten. Analysatorn ger fortfarande fas
            // och tempo - bara presentationens oktav rattas, den kan analysatorn inte avgora sjalv.
            if (this._octHint === 2) _octWants = 1; else if (this._octHint === 0.5) _octWants = -1;
            if (_bpmWants !== null) next = _bpmWants;
            else if (_octWants !== null) next = _octWants;
            else if (energySubdiv) {
              if (current <= 0 && energy > (this.cal.subdivHiOn ?? 2)) next = 1;
              else if (current === 1 && energy < (this.cal.subdivHiOff ?? 1.9)) next = 0;
              else if (current >= 0 && energy < (this.cal.subdivLoOn ?? 0.42)) next = -1;
              else if (current === -1 && energy > (this.cal.subdivLoOff ?? 0.60)) next = 0;
            }
            // Villkoret är NÖDVÄNDIGT: ett obetingat "else next = 0" slog ut
            // takthalveringen så fort energySubdiv var 0.
            else if (_halveAbove <= 0) next = 0;
            if (next !== current) {
              const holdMs = this.cal.subdivMinHoldMs ?? 10000;
              if (this._subdivChangedAt > 0 && Date.now() - this._subdivChangedAt < holdMs) next = current;
              else this._subdivChangedAt = Date.now();
            }
            this._subdivLevel = next;
            this._lastGridIdx = idx;

            const mult = this.cal.beatMultiplier ?? 1;
            const dblBelow = this.cal.beatDoubleBelowBpm ?? 105;
            const wantDbl = next !== -1 && (mult >= 2 || (dblBelow > 0 && bpmNow > 0 && bpmNow < dblBelow));
            const doubled = next === 1 || wantDbl;
            const fireBase = next !== -1 || ((((idx % 2) + 2) % 2) === 0);
            const accent = this.cal.barAccent ?? 1;
            const shift = frame?.barShift ?? -1;
            const onOne = fireBase && accent > 1 && shift >= 0 && ((((idx + shift) % 4) + 4) % 4) === 0;
            if (fireBase) {
              const ampG = onOne ? Math.min(1, 0.45 * accent) : 0.45;
              const tG = this._beat!.anchorMs + idx * baseIntervalMs - this.cal.beatLeadMs;   // pulsstart = slaget − lead, exakt
              if (PULSE_PREDICT) this.ppPush(idx, tG, ampG); else this.onsetTarget = ampG;
              this._gridPulseCount++; this.notePulse(PULSE_PREDICT ? tG : Date.now());
            }
            const ppb = doubled ? 2 : (next === -1 ? 0.5 : 1);
            this._pulseIntervalMs = baseIntervalMs > 0 ? baseIntervalMs / ppb : 0;
          }

          // 2× pulses land on the half-grid. They are extra pulses, never one-accented.
          const presentationDouble = this._subdivLevel === 1 || (
            this._subdivLevel !== -1 && (
              (this.cal.beatMultiplier ?? 1) >= 2 ||
              ((this.cal.beatDoubleBelowBpm ?? 105) > 0 && bpmNow > 0 && bpmNow < (this.cal.beatDoubleBelowBpm ?? 105))
            )
          );
          if (presentationDouble && bpmNow > 0) {
            const halfMs = 30000 / bpmNow;
            const idxH = beatIndex(this._beat, nowMs + halfMs);
            if (idxH !== this._lastGridIdxH) {
              this._lastGridIdxH = idxH;
              const tH = this._beat!.anchorMs + idxH * (60000 / bpmNow) - halfMs - this.cal.beatLeadMs;
              if (PULSE_PREDICT) this.ppPush(idxH + 0.5, tH, 0.45); else this.onsetTarget = 0.45;
              this._gridPulseCount++; this.notePulse(PULSE_PREDICT ? tH : Date.now());
            }
          }
        }
        // Drop-detektor @75Hz (analysatorns dropCount med bas-svackan som fallback).
        if (bands) this.processDrop(bands.bassRms, frame);
        // (Dirigenten v2 2026-08-25: inget dynamicCenter. Brightness-formen
        //  kommer från analyser-intensity; rå amplitud är bara loudness-skala.)

        // Analys-tap: rapportera RÅ band/flux (oförvrängd källa) @75Hz till recorder.
        if (this._analysisTap && bands) {
          this._analysisTap(bands.bassRms, bands.midHiRms, bands.totalRms, flux);
        }
      }
    });
    // Always start the loop — CPU is negligible
    this.startLoop();
    // Keep-alive och idle-heartbeat startar INTE här — de startas först när
    // BLE faktiskt är ansluten (via onBleConnected från connect-hardcoded).
    // Annars spammar writeAsync mot null-device innan användaren tryckt connect.

    this.saveTimer = setInterval(() => {
      // I TV-lage ar this.cal bas+overlay — persistera det ALDRIG som musik.
      if (this._calDirty && !this._tvMode) {
        saveCalibration(this.cal);
        this._calDirty = false;
      }
      // Ankaret till disk nar det flyttat > 0,1 dB (liten fil, atomisk setItem).
      if (this._wdbSlow !== undefined && Math.abs(this._wdbSlow - (this._anchorSaved ?? -999)) > 0.1) {
        this._anchorSaved = this._wdbSlow;
        const body = JSON.stringify({ wdbSlow: Math.round(this._wdbSlow * 100) / 100, at: Date.now() });
        import('node:fs/promises').then(async (fsp) => { const f = `${DATA_DIR}/anchor-state.json`; await fsp.writeFile(f + '.tmp', body); await fsp.rename(f + '.tmp', f); }).catch(() => { /* aldrig falla motorn */ });
      }
    }, 10_000);
    // GC-mätare (09-21, stall-jakten): V8:s GC-pauser via perf_hooks — --trace-gc gar inte via NODE_OPTIONS.
    // Loggar pauser >= 20 ms (max 1 rad/s) och summerar per 10 s i [gc]-raden. kind: 1 scavenge, 2 mark-sweep-compact, 4 incremental, 8 weak.
    try {
      let gcN = 0, gcMs = 0, gcMax = 0, gcBig = 0, gcLogAt = 0, gcRepAt = Date.now();
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const d = e.duration; gcN++; gcMs += d; if (d > gcMax) gcMax = d;
          const kind = (e as any).detail?.kind ?? (e as any).kind ?? 0;
          if (d >= 20) { gcBig++; if (Date.now() - gcLogAt > 1000) { gcLogAt = Date.now(); console.log(`[gc] paus ${d.toFixed(0)} ms kind ${kind}`); } }
        }
        if (Date.now() - gcRepAt >= 10_000) {
          console.log(`[gc] 10 s: ${gcN} pauser, summa ${gcMs.toFixed(0)} ms, max ${gcMax.toFixed(0)} ms, >=20 ms: ${gcBig}`);
          gcRepAt = Date.now(); gcN = 0; gcMs = 0; gcMax = 0; gcBig = 0;
        }
      });
      obs.observe({ entryTypes: ['gc'] });
    } catch (e) { console.log('[gc] matare kunde inte startas:', (e as Error).message); }
    // Raster-mätaren (alltid): write→kvitto p50/p90 = hur gammalt paketet är när det lämnar Pi:n.
    // Loggas bara när det finns skrivningar i fönstret (spelning). Synk-läget lägger till tick-jitter.
    let _rasterLogAt = 0;
    setInterval(() => {
      try {
        const r = getRasterStats();
        if (r.w2n.n < 20) return;
        const now = Date.now();
        // GUARD-SVEP (deterministiskt, 2026-09-21): håll guard 1..period−1 i tre 2 s-fönster var, median-p50 per guard,
        // välj minimum. Kurvan är en sågtand: för liten guard → paketet missar händelsen och w2n ≈ intervall; vid
        // catch-punkten faller w2n till ≈ guard. Svepet körs vid lås och görs om var 10:e minut (driftkontroll).
        if (TICK_SYNC && TICK_SYNC_ADAPT && r.locked && r.w2n.n >= 40) {
          const lim = Math.max(2, Math.floor(r.periodMs - 1));
          if (this._sweepG === 0 && now - this._sweepDoneAt > 600_000) { this._sweepG = 1; this._sweepWin = []; this._sweepRes = []; this._guardMs = 1; }
          if (this._sweepG > 0) {
            this._sweepWin.push(r.w2n.p50Ms);
            if (this._sweepWin.length >= 3) {
              const w = [...this._sweepWin].sort((a, b) => a - b); this._sweepRes[this._sweepG] = w[1]; this._sweepWin = [];
              if (this._sweepG < lim) { this._sweepG++; this._guardMs = this._sweepG; }
              else {
                let best = 1; for (let g = 1; g <= lim; g++) if (this._sweepRes[g] != null && this._sweepRes[g] < this._sweepRes[best]) best = g;
                // Minimum ligger PÅ sågtandens kant (12:23: g8 20,8 → g10 10,9) och pendlar då 10/21 mellan fönstren
                // — lägg 2 ms marginal ovanför kanten så paketet alltid hinner med händelsen.
                const chosen = Math.min(lim, best + 2);
                this._guardMs = chosen; this._sweepG = 0; this._sweepDoneAt = now;
                console.log(`[raster] guard-svep: ${this._sweepRes.map((v, g) => (g > 0 && v != null ? `g${g} ${v.toFixed(1)}` : '')).filter(Boolean).join(' · ')} → min g${best}, vald ${chosen} ms`);
              }
            }
          }
        }
        const logNow = now - _rasterLogAt >= 10_000;
        if (logNow) {
          _rasterLogAt = now;
          const s = TICK_SYNC ? ` | synk ticks ${this._syncTicks} sena ${this._syncLate} (max ${this._syncLateMax.toFixed(1)} ms) guard ${this._guardMs}` : '';
          console.log(`[raster] period ${r.periodMs} ms jitter ${r.jitterMs} ms kvitton ${r.events} las ${r.locked ? 1 : 0} | write→kvitto p50 ${r.w2n.p50Ms} p90 ${r.w2n.p90Ms} max ${r.w2n.maxMs} ms (n ${r.w2n.n})${s}`);
          this._syncLate = 0; this._syncLateMax = 0;
        }
        resetRasterWindow();
      } catch { /* mätaren får aldrig falla motorn */ }
    }, 2_000);

    // _bleOwner sätts normalt på flanker. Reparera bara när avvikelsen varit
    // stabil i 3s — BLE-status kan pendla legitimt under ett connect-försök.
    let ownerMismatch: 'connected' | 'disconnected' | null = null;
    let ownerMismatchSince = 0;
    this.ownerTimer = setInterval(() => {
      try {
        const connected = getHardcodedConnected().connected;
        const mismatch = connected && this._bleOwner === 'none'
          ? 'connected'
          : (!connected && this._bleOwner !== 'none' ? 'disconnected' : null);
        if (!mismatch) {
          ownerMismatch = null;
          ownerMismatchSince = 0;
          return;
        }
        if (mismatch !== ownerMismatch) {
          ownerMismatch = mismatch;
          ownerMismatchSince = Date.now();
          return;
        }
        if (Date.now() - ownerMismatchSince < 3000) return;
        ownerMismatch = null;
        ownerMismatchSince = 0;
        if (mismatch === 'connected') {
          console.warn('[Engine] owner-repair: BLE ansluten men owner=none → onBleConnected()');
          this.onBleConnected();
        } else {
          console.warn('[Engine] owner-repair: BLE nere men owner≠none → onBleDisconnected()');
          this.onBleDisconnected();
        }
      } catch {}
    }, 1000);



    dlog(`[Engine] Initialized (${this.tickMs}ms, loop always active, idle heartbeat until playback)`);
  }

  // ── Event-driven tick scheduling ──
  // Band-events fyras 75 ggr/sek (FRAME_MS = 13.33 ms). tickMs pacar bara BLE-slot-leasen,
  // inte tick-takten (tick-gaten är borta). Vi kör tickInner när
  // förflutit — ALLTID med den färska FFT-framen i handen. Tidigare schemalades
  // en setTimeout för "remaining ms" när FFT kom för tidigt, vilket innebar
  // att tickInner körde mot en GAMMAL getLatestBands() (upp till tickMs sen).
  // Det gav smygande audio-latens utan att synas i pkt/s. Borttaget.
  private _lastTickTime = 0;
  private _lastTickAtForFade = 0;
  private _lastSmoothAt = 0;   // för tidsbaserad EMA-alpha (robust mot hoppade ticks)
  private _loopActive = false;
  private _nextTickDeadline = 0;
  /** Called by ALSA FFT callback — runs in the audio data handler context */
  private _phaseFlipDenied = 0;
  private _syncTimer: NodeJS.Timeout | null = null;
  private _guardMs = TICK_SYNC_GUARD_MS;
  private _sweepG = 0;            // 0 = inget svep pågår; annars guard som provas
  private _sweepWin: number[] = [];   // p50 per 2 s-fönster för aktuell guard
  private _sweepRes: number[] = [];   // median-p50 per guard (index = guard)
  private _sweepDoneAt = 0;
  private _syncTicks = 0;
  private _lateLogAt = 0;
  private _syncLate = 0;       // ticks som kom > 2 ms efter mål (timerjitter/GC)
  private _syncLateMax = 0;
  /** Synk-tick: kör tickInner strax före nästa radiohändelse och boka nästa. */
  private syncTick(target: number): void {
    this._syncTimer = null;
    if (!this._loopActive) return;
    const now = performance.now();
    const late = now - target;
    if (late > 2) { this._syncLate++; if (late > this._syncLateMax) this._syncLateMax = late; }
    // Stall-jakt (09-21): en sen tick > 40 ms loggas med tid (max 1/s) sa den kan korreleras med raden fore i loggen.
    if (late > 40 && Date.now() - this._lateLogAt > 1000) { this._lateLogAt = Date.now(); console.log(`[synk] sen tick ${late.toFixed(0)} ms (event-loop-stall)`); }
    this._syncTicks++;
    this._nextTickDeadline = now + TICK_PERIOD_MS;
    this._lastTickTime = now;
    try { this.tickInner(); } finally { this.scheduleSyncTick(); }
  }
  private scheduleSyncTick(): void {
    if (this._syncTimer || !this._loopActive) return;
    const now = performance.now();
    // Mål = förutsagd radiohändelse − guard; minst 1 ms fram så vi aldrig snurrar.
    const target = Math.max(now + 1, nextRasterEventAt(now + 1, this._guardMs) - this._guardMs);
    this._syncTimer = setTimeout(() => this.syncTick(target), Math.max(1, Math.round(target - now)));
  }
  getSyncDiag(): { on: boolean; guardMs: number; ticks: number; late: number; lateMaxMs: number; raster: ReturnType<typeof getRasterStats> } {
    return { on: TICK_SYNC, guardMs: this._guardMs, ticks: this._syncTicks, late: this._syncLate, lateMaxMs: Math.round(this._syncLateMax * 10) / 10, raster: getRasterStats() };
  }

  private onFFTFrame(): void {
    if (!this._loopActive) return;
    if (TICK_SYNC) return;   // synk: band-ramen uppdaterar bara bands; ticken går på rastret

    // EN tick för hela compute-kedjan: ljus-beslutet körs på VARJE FFT-frame
    // (~75 Hz) — ingen nedsampling, ingen aliasing, beslutet alltid ≤13.33ms
    // färskt. BLE-leveransen är frikopplad (1-plats-slot), så radions
    // conn-interval styr sändtakten, inte compute-takten.
    const now = performance.now();
    this._nextTickDeadline = now + this.tickMs;
    this._lastTickTime = now;
    this.tickInner();
  }

  private startLoop(): void {
    if (this._loopActive) return;
    this._loopActive = true;
    const now = performance.now();
    this._lastTickTime = now;
    this._nextTickDeadline = now + this.tickMs;
    if (TICK_SYNC) this.scheduleSyncTick();
  }

  private stopLoop(): void {
    this._loopActive = false;
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
  }

  stop(): void {
    this._running = false;
    this.stopLoop();
    clearQueuedWrite();
    stopKeepAlive();
    onFFTReady(null); // unregister callback
    onFluxReady(null);
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    if (this.ownerTimer) { clearInterval(this.ownerTimer); this.ownerTimer = null; }

    dlog('[Engine] Stopped');
  }

  /** Suspend engine output (for BLE tests etc.) — stops loop + keep-alive */
  suspend(): void {
    this.stopLoop();
    clearQueuedWrite();
    stopKeepAlive();
    dlog('[Engine] Suspended (BLE test mode)');
  }

  /** Resume engine output after suspend */
  resume(): void {
    this.startLoop();
    if (!this.playing && this._bleOwner !== 'none') {
      this._bleOwner = 'idle';
      this.forceIdleNow();
      startKeepAlive();
    }
    dlog(`[Engine] Resumed (${this.playing ? 'active' : 'idle'})`);
  }

  /** Restart tick scheduling — preserves all smoothing state */
  restartTimer(): void {
    this.stopLoop();
    if (this.playing) this.startLoop();
    dlog(`[Engine] Timer restarted (${this.tickMs}ms min interval = ${(1000 / this.tickMs + 0.5) | 0} Hz max, ${this.playing ? 'active' : 'idle'})`);
  }

  /** Guard against NaN/Infinity corrupting smoothing state */
  private sanitizeState(): void {
    if (!Number.isFinite(this.ampEnv)) this.ampEnv = 0;
    if (!Number.isFinite(this.smoothed)) this.smoothed = 0;
    if (!Number.isFinite(this._wlevelSm)) this._wlevelSm = undefined;
    if (!Number.isFinite(this.onsetBoost)) { this.onsetBoost = 0; this.onsetTarget = 0; }
    if (!Number.isFinite(this.lastBrightness)) this.lastBrightness = 0;
    if (!Number.isFinite(this.lastSentPct)) this.lastSentPct = -1;
    // A4: drop-EMA:erna kunde låsa till NaN permanent (togs inte av saneraren).
    if (!Number.isFinite(this.bassFast)) this.bassFast = 0;
    if (!Number.isFinite(this.bassSlow)) this.bassSlow = 0;
  }

  getDiagnostics(): DiagSnapshot { return _diag; }
  getCalibration(): LightCalibration { return this.cal; }

  // ── Mic-safe-mode (FIX 15) ──
  // Sätts när mic-återställningens steg är uttömda: lampan låses på idle-färg
  // och tickInner skriver inte längre från fruset mic-underlag.
  private _micSafeMode = false;
  setMicSafeMode(on: boolean): void {
    if (this._micSafeMode === on) return;
    this._micSafeMode = on;
    if (on) this.forceIdleNow();
  }
  isMicSafeMode(): boolean { return this._micSafeMode; }


  // ── Auto-tune API ──
  /** Starta sampling av rå pct (post-slew, pre-deadband) i `durationMs`.
   *  Endast en session i taget — ny start avbryter pågående. */
  startAutoTune(durationMs: number): { ok: boolean; durationMs: number; capacity: number } {
    const dur = Math.max(2000, Math.min(120_000, durationMs | 0));
    // Kapacitet: tickMs (min 5ms) → reservera dur/tickMs + 20% safety
    const tm = Math.max(5, this.tickMs);
    const cap = Math.ceil((dur / tm) * 1.2) + 64;
    this.autoTuneSamples = new Float32Array(cap);
    this.autoTuneTickMs = new Float32Array(cap);
    this.autoTunePos = 0;
    this.autoTuneCount = 0;
    this.autoTuneCap = cap;
    this.autoTuneDurationMs = dur;
    this.autoTuneStartedAt = Date.now();
    this.autoTuneActive = true;
    return { ok: true, durationMs: dur, capacity: cap };
  }

  cancelAutoTune(): void {
    this.autoTuneActive = false;
    this.autoTuneSamples = new Float32Array(0);
    this.autoTuneTickMs = new Float32Array(0);
    this.autoTuneCount = 0;
    this.autoTunePos = 0;
    this.autoTuneCap = 0;
  }

  getAutoTuneStatus(): {
    active: boolean;
    elapsedMs: number;
    durationMs: number;
    sampleCount: number;
    progress: number; // 0..1
    done: boolean;
    suggestion?: {
      tickEnergyFloor: number;
      onsetEnergyFloor: number;
      silenceRms: number;
      musicRms: number;
      silenceRatio: number;        // andel ticks tolkade som tysta (0..1)
      separation: number;          // music/silence-ratio, högt = tydligt gap
      samplesUsed: number;
      sampleRateHz: number;
      isPlaying: boolean;
      hasSilentSection: boolean;   // true om vi sett < 0.02 i någon del
    };
    current?: { tickEnergyFloor: number; onsetEnergyFloor: number };
  } {
    const elapsed = this.autoTuneStartedAt ? Date.now() - this.autoTuneStartedAt : 0;
    const dur = this.autoTuneDurationMs || 1;
    const progress = Math.max(0, Math.min(1, elapsed / dur));
    const inProgress = this.autoTuneActive && elapsed < dur;

    if (this.autoTuneActive && elapsed >= dur) {
      this.autoTuneActive = false;
    }

    const result: any = {
      active: inProgress,
      elapsedMs: elapsed,
      durationMs: dur,
      sampleCount: this.autoTuneCount,
      progress,
      done: !this.autoTuneActive && this.autoTuneCount > 0,
      current: {
        tickEnergyFloor: this.cal.tickEnergyFloor,
        onsetEnergyFloor: this.cal.onsetEnergyFloor,
      },
    };
    if (!this.autoTuneActive && this.autoTuneCount > 32) {
      const s = this.analyzeAutoTuneSamples();
      result.suggestion = { ...s, isPlaying: this.playing };
    }
    return result;
  }

  /** Analys: hittar tystnads-partier (brusgolv) och musik-nivå i mic-RMS-loggen.
   *  - silenceRms = p10 av samples (representerar tysta partier / mellan-låt-glapp)
   *  - musicRms   = p70 av samples (representerar typisk musik-nivå)
   *  - tickEnergyFloor föreslås halvvägs mellan dem (geometriskt medel) men aldrig
   *    > 80% av musicRms — så musik aldrig gatas bort.
   *  - onsetEnergyFloor sätts något högre (×1.4) — beat-detektorn är känsligare.
   *  - hasSilentSection = true om vi sett samples ≤ 0.015 (rumsbrus-nivå). */
  private analyzeAutoTuneSamples(): {
    tickEnergyFloor: number;
    onsetEnergyFloor: number;
    silenceRms: number;
    musicRms: number;
    silenceRatio: number;
    separation: number;
    samplesUsed: number;
    sampleRateHz: number;
    hasSilentSection: boolean;
  } {
    const N = this.autoTuneCount;
    const cap = this.autoTuneCap;
    const buf = this.autoTuneSamples;
    const tms = this.autoTuneTickMs;
    const start = N < cap ? 0 : this.autoTunePos;
    const lin = new Float32Array(N);
    let totalDt = 0;
    for (let i = 0; i < N; i++) {
      const idx = (start + i) % cap;
      lin[i] = buf[idx];
      totalDt += tms[idx];
    }
    // Hoppa warmup (första 5 samples), sortera resten
    const skip = Math.min(5, N - 1);
    const sorted = Array.from(lin.slice(skip)).sort((a, b) => a - b);
    const pctile = (arr: number[], p: number): number =>
      arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];

    const silenceRms = pctile(sorted, 0.10);
    const musicRms = pctile(sorted, 0.70);

    // Geometriskt medel mellan brusgolv och musik = robust separator.
    // Faller tillbaka till silenceRms*1.5 om gap saknas (ingen tystnad samplad).
    const gm = silenceRms > 0 && musicRms > silenceRms
      ? Math.sqrt(silenceRms * musicRms)
      : silenceRms * 1.5;
    const cap80 = musicRms * 0.8;
    const tickRaw = Math.min(gm, cap80);
    const tickEnergyFloor = Math.round(Math.max(0.005, Math.min(0.20, tickRaw)) * 1000) / 1000;
    const onsetRaw = tickEnergyFloor * 1.4;
    const onsetEnergyFloor = Math.round(Math.max(0.005, Math.min(0.20, onsetRaw)) * 1000) / 1000;

    // Andel samples under tickEnergyFloor (= det som skulle ha gatats)
    let belowCount = 0;
    for (let i = skip; i < N; i++) if (lin[i] < tickEnergyFloor) belowCount++;
    const silenceRatio = N > skip ? belowCount / (N - skip) : 0;

    const separation = silenceRms > 0 ? Math.round((musicRms / silenceRms) * 10) / 10 : 0;
    const hasSilentSection = silenceRms <= 0.015 || sorted[0] <= 0.010;

    const avgDt = N > 0 ? totalDt / N : this.tickMs;
    const sampleRateHz = avgDt > 0 ? Math.round(10000 / avgDt) / 10 : 0;

    return {
      tickEnergyFloor,
      onsetEnergyFloor,
      silenceRms: Math.round(silenceRms * 1000) / 1000,
      musicRms: Math.round(musicRms * 1000) / 1000,
      silenceRatio: Math.round(silenceRatio * 100) / 100,
      separation,
      samplesUsed: N - skip,
      sampleRateHz,
      hasSilentSection,
    };
  }

  /** Intern: kallas från tickInner med bands.totalRms (rå mic-energi). */
  private recordAutoTuneSample(rms: number): void {
    if (!this.autoTuneActive) return;
    const elapsed = Date.now() - this.autoTuneStartedAt;
    if (elapsed >= this.autoTuneDurationMs) {
      this.autoTuneActive = false;
      return;
    }
    const cap = this.autoTuneCap;
    if (cap === 0) return;
    this.autoTuneSamples[this.autoTunePos] = rms;
    this.autoTuneTickMs[this.autoTunePos] = this.tickMs;
    this.autoTunePos = (this.autoTunePos + 1) % cap;
    if (this.autoTuneCount < cap) this.autoTuneCount++;
  }


  /** Hot path — zero-allocation, precomputed constants, event-driven from FFT */
  tickInner(): void {
    // Liveness, inte leverans: en stängd playing/BLE-grind är korrekt vila och
    // får inte tolkas som en wedgad motor av Playback-Watchdog.
    const _tickStart = performance.now();
    noteTick(_tickStart, this.tickMs);

    // Mic-safe-mode: stegen är uttömda och micen är död. Lampan står i idle-färg
    // och får inte pulsa på fruset underlag.
    if (this._micSafeMode) return;

    // Skip processing när engine inte spelar ELLER när vi inte är BLE-active-owner.
    // Sista guard mot sen FFT-frame som anländer efter setPlaying(false) → annars
    // kan en mic-write krocka med keep-alive som just tagit över.
    if (!this.playing || this._bleOwner !== 'active') return;


    // Offline-playback borttaget (2026-06-02): allt körs reaktivt/realtime.



    try {
      const cal = this.cal;
      const tc = this.tc;
      const bands = getLatestBands();
      // Steg 1 i hard-fail-pipelinen: har vi en mic-frame att jobba med?
      if (!bands || !Number.isFinite(bands.totalRms)) {
        bleStatsState.tickAbortNoMicCount++;
        return;
      }

      // ── 1. INPUT-SYNC: formen ÄR den råa, gain-satta inputen ──
      // level/shape = bands.totalRms (lightRawRms × tvåpunktsGain, ingen AGC).
      // frame.intensity (bands.shape) är sektions-relativ och används BARA till
      // topp-boosten nedan — aldrig som form-källa.
      const level = Math.max(0, Math.min(1, bands.totalRms));   // behålls: silence-gate + diagnostik
      let shape: number;
      if (cal.dbWindow !== false) {
        // FREKVENSVIKTAD dB-MAPPNING: bredbandssignalen är i praktiken en basmätare
        // (3.9 dB dynamik) — mid/diskant bär ~3× mer. Vikta dit så dynamiken finns
        // i mätsignalen innan mappningen.
        const wlevelRaw = bands.midHiRms * (cal.lightHiWeight ?? 1.0)
                        + bands.bassRms  * (cal.lightBassWeight ?? 0.0);
        // AVBRUSA BASEN: kort EMA (~lightSmoothMs) tar bort frame-brus utan att sakta
        // riktiga stegringar märkbart. Beat-punchen (fluxBoost nedan) är oberörd → attacken
        // kan vara instant och ljuset stiger fort, men grundnivån slutar flimra.
        const downMs = Math.max(1, cal.lightSmoothMs ?? 60);
        const upMs = cal.lightRiseMs ?? 0;
        const rising = this._wlevelSm !== undefined && wlevelRaw > this._wlevelSm;
        const aSm = rising && upMs <= 0 ? 1 : 1 - Math.exp(-TICK_PERIOD_MS / (rising ? Math.max(1, upMs) : downMs));
        this._wlevelSm = this._wlevelSm === undefined
          ? wlevelRaw
          : this._wlevelSm + (wlevelRaw - this._wlevelSm) * aSm;
        const wlevel = this._wlevelSm;
        const wdb = 20 * Math.log10(Math.max(wlevel, 1e-4));
        let anchorDb = cal.anchorDb ?? -4;
        if ((cal.autoAnchor ?? 0) > 0) {
          // ANKARET SAS BARA UR SIGNAL (2026-09-20 17:00): efter omstart/paus saddes wdbSlow fran forsta ramen = tystnad (-80 dB)
          // och klattrade sedan med tau x3 (6 min) - ljuset lag klippt mot taket (shape 1,0 i 56 % av ramarna, 72-100 %) i
          // over en kvart ("lite dynamik"). Nu: ingen uppdatering under tystnadsgrinden, forsta sadd = forsta ram med signal,
          // och ligger signalen > windowDb over ankaret (helt utanfor fonstret) snapper ankaret med tau/10.
          const tauMs = Math.max(1000, (cal.autoAnchorSec ?? 60) * 1000);
          const tickFloorA = cal.tickEnergyFloor ?? 0;
          const silentA = tickFloorA > 0 && level < tickFloorA;
          if (!silentA) {
            const anchorUp = this._wdbSlow !== undefined && wdb > this._wdbSlow;
            const winDb = Math.max(1, cal.windowDb ?? 18);
            // SNABBT LAGE (09-21): signalen helt utanfor fonstret at NAGOT hall, eller forsta 20 s efter play-start/anslutning
            // (volymen kan ha bytts under pausen - ankaret overlever pauser sedan 09-21, sa det maste kunna hinna ikapp).
            const farAbove = this._wdbSlow !== undefined && wdb - this._wdbSlow > winDb;
            const farBelow = this._wdbSlow !== undefined && this._wdbSlow - wdb > winDb;
            // Klippt (>= 98 %) eller slackt (<= 2 %) i > 10 s i strack = volymen har bytts: folj snabbt tills vi ar i fonstret igen.
            const prevShape = this._lastShape ?? 0.5;
            if (prevShape >= 0.98 || prevShape <= 0.02) { this._clipRunMs += TICK_PERIOD_MS; if (this._clipRunMs > 10_000) this._anchorFastUntil = Date.now() + 5_000; }
            else this._clipRunMs = 0;
            const fast = farAbove || farBelow || Date.now() < this._anchorFastUntil;
            const anchorAlpha = 1 - Math.exp(-TICK_PERIOD_MS / (fast ? tauMs / 10 : anchorUp ? tauMs * 3 : tauMs));
            this._wdbSlow = this._wdbSlow === undefined ? wdb : this._wdbSlow + anchorAlpha * (wdb - this._wdbSlow);
          }
          anchorDb = (this._wdbSlow ?? wdb) + (cal.anchorOffsetDb ?? 4);
          _diag.wdbSlow = this._wdbSlow;
          _diag.anchorDb = anchorDb;
        }
        // FAST dB-fönster; auto-ankaret följer långsamt så sektionsdynamiken bevaras.
        const windowDb = Math.max(1, cal.windowDb ?? 18);
        shape = (wdb - (anchorDb - windowDb)) / windowDb;
        shape = shape < 0 ? 0 : shape > 1 ? 1 : shape;
        this._lastShape = shape;
        _diag.wlevel = wlevel; _diag.wdb = wdb;  // för live-kalibrering av anchorDb
      } else {
        // ── FALLBACK (dbWindow=false): gamla adaptiva taket + expansion ──
        let inLow: number, inHigh: number;
        if (cal.adaptiveCeiling !== false) {
          if (this._slowMean === undefined) this._slowMean = 0.4;
          this._slowMean += (level - this._slowMean) * (TICK_PERIOD_MS / (cal.ceilFollowMs ?? 7000));
          const m = Math.max(cal.ceilFloor ?? 0.12, this._slowMean);
          inLow = m * (cal.ceilLowMul ?? 0.55);
          inHigh = m * (cal.ceilHighMul ?? 1.35);
        } else {
          const gRef = (cal.gainCalibration?.point1?.gain as number) || 20;
          inLow = (cal.inLowFrac ?? 0.022) * gRef;
          inHigh = (cal.inHighFrac ?? 0.075) * gRef;
        }
        let e = (level - inLow) / Math.max(1e-6, inHigh - inLow);
        e = e < 0 ? 0 : e > 1 ? 1 : e;
        const sx = cal.shapeExpand ?? 1.0;
        shape = sx === 1 ? e : Math.pow(e, sx);
      }




      _diag.bassNorm = normalizeFixed(bands.bassRms);
      _diag.midHiNorm = normalizeFixed(bands.midHiRms);

      // ── 2. Tystnads-gate ──
      // När absolut amplitud < tickEnergyFloor är input rumsbrus, inte musik:
      // shape forceras till 0 och brightness sjunker mot golvet.
      const tickFloor = cal.tickEnergyFloor;
      const inSilence = !this._clapMode && tickFloor > 0 && level < tickFloor;
      if (inSilence) shape = 0;

      // Takjämning före heartbeat-smoothing: shape uppdateras ~15 Hz medan motorn
      // renderar ~75 Hz, så stora enstaka hopp fördelas över flera frames.
      const shapeUpMs = cal.shapeSmoothUpMs ?? 300;
      const shapeDownMs = cal.shapeSmoothDownMs ?? 120;
      if (shapeUpMs > 0 || shapeDownMs > 0) {
        if (this._shapeSm === undefined) this._shapeSm = shape;
        else {
          const shapeMs = shape > this._shapeSm ? shapeUpMs : shapeDownMs;
          const shapeAlpha = shapeMs > 0 ? 1 - Math.exp(-TICK_PERIOD_MS / shapeMs) : 1;
          this._shapeSm += shapeAlpha * (shape - this._shapeSm);
        }
        shape = this._shapeSm;
      }

      // ── 3. Långsam amplitud-envelope → LOUDNESS ──
      // Rå amplitud är uppmätt för platt inom låt. Den används därför inte som
      // dynamikbärare, utan bara för att tyst/låg volym ska lysa svagare.
      const _envElapsed = this._lastSmoothAt > 0
        ? Math.min(250, _tickStart - this._lastSmoothAt)
        : this.tickMs;
      const envUp = 1 - Math.exp(-_envElapsed / 300);
      const envDown = 1 - Math.exp(-_envElapsed / 2500);
      const envA = level > this.ampEnv ? envUp : envDown;
      this.ampEnv += envA * (level - this.ampEnv);
      const ampEnv = this.ampEnv;
      const floor = tc.brightnessFloor;
      const floorN = floor / 100;
      // EN mappning: tvåpunkts-gainen mot Sonos-volymen ger amplituden 0..1,
      // som mappas rakt in i golv..100 %. Loudness-golvet är enda ratten.
      // loudness ≡ ampEnv (clampen bet aldrig) — bara diagnostik.
      _diag.loudness = ampEnv;
      _diag.ceiling = floorN + (1 - floorN) * ampEnv;

      // ── 4. HEARTBEAT: snabb attack, mjuk release på shape ──
      // Tidsbaserad alpha så fade-takten blir identisk även när BLE hoppar frames.
      this._lastSmoothAt = _tickStart;
      const _eRatio = _envElapsed / 125;
      if (shape < this.smoothed) {
        const alpha = 1 - Math.pow(1 - cal.releaseAlpha, _eRatio);
        // Logaritmisk release: jämn, perceptuell fade (konstant ratio/tick).
        const _lo = 1e-4;
        const _c = this.smoothed < _lo ? _lo : this.smoothed;
        const _t = shape < _lo ? _lo : shape;
        this.smoothed = _c * Math.pow(_t / _c, alpha);
      } else {
        const alpha = 1 - Math.pow(1 - cal.attackAlpha, _eRatio);
        // MJUK attack vid låg energi (brus snäpper inte → inget flimmer),
        // full SNAP vid hög energi.
        const _softFloor = cal.lowSoftFloor;
        const _softK = _softFloor + (1 - _softFloor) * Math.min(1, shape / 0.5);
        this.smoothed += alpha * _softK * (shape - this.smoothed);
      }
      let shapeSm = this.smoothed;
      if (shapeSm < 0) shapeSm = 0;
      if (shapeSm > 1) shapeSm = 1;

      // ── 5. Puls-envelopen förfaller i tystnad (transientGain skalar inte längre
      // ljuspulsen — se dirigenten nedan; fältet lever kvar för raw-/onset-vägen) ──
      if (inSilence) {
        this.onsetBoost *= 0.5;
        if (this.onsetBoost < 0.001) { this.onsetBoost = 0; this.onsetTarget = 0; }
      }


      // ── 6. BRIGHTNESS — TAKTEN ÄR GRUNDEN, ENERGIN SÄTTER TAKET (multiplikativ).
      // Pulsen normaliseras mot sitt NOMINELLA mål (0.45) i stället för att klampas:
      // additivt klampade både vanligt slag och ettan till ~1.0 och accenten försvann.
      // (heartbeat.ts) pulsen normeras mot sitt nominella mål 0,45: pn = djupet inom taket, one = ettans överskott
      if (PULSE_PREDICT) { if (inSilence) this.ppClear(); else this.ppTick(); }
      const { p, pn, one } = pulseSplit(this.onsetBoost, this._ppOut, cal.barAccent ?? 1);
      void p;

      // buildUp OCH ettan höjer TAKET (adderas inte ovanpå — då klampar de bort pulsen)
      const _f = getLatestFrame();
      let bu = (_f && (_f as any).buildUp) ? (_f as any).buildUp : 0;
      // FORVARNING (2026-09-21, workerns sektionsminne): expectHighInMs = ms tills nasta refrang vantas (frasgitter fran senaste
      // high-starten + stigande energi; bank 11/22 inom +-2 s, 2,8 falska/min). De sista EXPECT_LIFT_MS lyfts taket som en riser
      // (samma vag som buildUp, max av de tva) sa ljuset "gasar" IN i refrangen i stallet for 1-2 s efter den. LOTUS_EXPECT_LIFT_MS=0 = av.
      const _ex = _f ? ((_f as any).expectHighInMs ?? -1) : -1;
      if (EXPECT_LIFT_MS > 0 && _ex > 0 && _ex <= EXPECT_LIFT_MS) { const l = 1 - _ex / EXPECT_LIFT_MS; if (l > bu) bu = l; }
      // ── UPPSPELNING: taket ur latens egen energikurva ────────────────────
      // Ersatter micens `shapeSm` helt nar bade kurvan och positionen finns.
      // Faller tillbaka pa micen sa fort klockan tappar — aldrig ett svart hopp.
      let shapeUse = shapeSm;
      if (this._pbEnergy) {
        const _p = this._clock.state(Date.now()).positionMs;
        if (_p != null && _p >= 0) {
          // INTERPOLERA MELLAN FACKEN. Kurvan har 100 ms upplosning; utan
          // interpolation hoppar ljuset i TRAPPSTEG tio ganger i sekunden, och
          // genom ett 10 dB-fonster syns varje steg. Det var fladdret.
          // (Utjamningen ensam raddade det inte: med tickMs 18 och
          // shapeSmoothUpMs 25 blir EMA-alfan 0.72, alltsa nastan ingen
          // utjamning alls — den slapper igenom hela steget pa en ram.)
          const fi = _p / 100;
          const i = Math.floor(fi);
          if (i >= 0 && i + 1 < this._pbEnergy.length) {
            const fr = fi - i;
            const e0 = this._pbEnergy[i], e1 = this._pbEnergy[i + 1];
            const v = (e0 + (e1 - e0) * fr) / this._pbRef;
            const db = 20 * Math.log10(Math.max(v, 1e-4));
            const win = Math.max(1, cal.windowDb ?? 10);
            let sh = (db + win) / win;
            if (sh < 0) sh = 0; else if (sh > 1) sh = 1;
            // Egen tidskonstant, inte micens. Micens 25 ms ar satt for att folja
            // en RA signal snabbt; har ar signalen redan slat och interpolerad,
            // sa 80 ms tar bort resterande kantighet utan att gora ljuset trogt.
            const a2 = Math.min(1, (this.tickMs || 18) / 80);
            this._pbShape += (sh - this._pbShape) * a2;
            shapeUse = this._pbShape;
          }
        }
      }
      // TAKET (heartbeat.ts ceilingFrom): nivåform × uppbyggnad, ettan lyfter, sedan SEKTIONSDYNAMIK (2026-09-21): levelVsHighDb =
      // blockets dB mot senaste refrangens medel — LATENS EGEN referens, inte dB-ankaret (som sjunker i lugna partier; agaren i ladan:
      // "lyser mycket aven om laten blir tystare"). Tystare an refrangen -> taket × (1 + dB/SECTION_DYN_DB), golv SECTION_DYN_FLOOR. 0 = av.
      const _lv = _f ? ((_f as any).levelVsHighDb ?? 0) : 0;
      const ceil = ceilingFrom(shapeUse, bu, cal.buildUpGain ?? 0, one, cal.barAccentLift ?? 0.30, _lv, SECTION_DYN_DB, SECTION_DYN_FLOOR);

      // TRUST — mjuk ramp i stället för binärt. MIN_BEAT_CONFIDENCE är bara 0.20,
      // så det binära beslutet gav FULLT pulsdjup på mycket svag takt, och snäppte
      // av/på när konfidensen vandrade kring tröskeln (locked flippade 4×/3 min).
      // Golvet låter modulationen leva på FAKTISKA transienter när takten är otydlig.
      const _c = this._beat?.confidence ?? 0;
      const _lo = this.cal.beatTrustLoConf ?? 0.30;
      const _hi = this.cal.beatTrustHiConf ?? 0.70;
      const _tRaw = trustRaw(_c, hasBeat(this._beat), _lo, _hi);
      // Rampen ensam räcker inte: conf kan falla 0.79 → 0.00 mellan två ramar.
      // ASYMMETRISK (09-21): snabbt upp (beatTrustSmoothMs 400), langsamt ner (beatTrustDownMs 3000) - en 3-5 s konfidensdipp
      // (fill/break) slackte pulsen till 25 % djup pa 0,4 s = "nastan konstant ljus" (sampler 15:41: trust 0,41-0,45 = plattast).
      const _up = this.cal.beatTrustSmoothMs ?? 400, _down = this.cal.beatTrustDownMs ?? 3000;
      this._trustSm = trustSmooth(_tRaw, this._trustSm, TICK_PERIOD_MS, _up, _down);
      const trust = Math.max(this.cal.beatTrustFloor ?? 0.35, this._trustSm);

      // ── SEKTIONSBETEENDE ────────────────────────────────────────────────
      // Kraver att vi VET var i laten vi ar. Klockan sager null tills den har
      // underlag (tre Sonos-flankar), och da galler tabellens neutrala 1/1 —
      // alltsa exakt samma ljus som forr. Sektioner ar ett TILLAGG.
      let _tgtScale = 1, _tgtPulse = 1;
      const _parts = this._songEntry?.parts;
      if (_parts && _parts.length) {
        const _pos = this._clock.state(Date.now()).positionMs;
        if (_pos != null) {
          let _lab = '';
          for (let i = _parts.length - 1; i >= 0; i--) {
            if (_pos >= _parts[i].t) { _lab = _parts[i].label; break; }
          }
          const _sp = PiLightEngine.SECTION[_lab];
          if (_sp) {
            _tgtScale = Math.min(1, _sp.scale * this._secNormS);
            _tgtPulse = Math.min(1, _sp.pulse * this._secNormP);
          }
        }
      }
      // Glid, hoppa inte: ett steg i ljusstyrka vid en sektionsgrans laser som
      // ett fel aven nar tidpunkten ar ratt. ~2 s = ungefar en fras.
      const _secA = Math.min(1, (this.tickMs || 18) / 2000);
      this._secScale += (_tgtScale - this._secScale) * _secA;
      this._secPulse += (_tgtPulse - this._secPulse) * _secA;

      // ── DROPS UR MINNET ─────────────────────────────────────────────────
      // Fyras DROP_PRE_MS fore sin tidpunkt. Index gar bara framat; hoppar
      // positionen bakat (seek) sokas det om, annars skulle en spolning
      // antingen missa alla drops eller fyra dem i klump.
      const _drops = this._songEntry?.drops;
      if (_drops && _drops.length) {
        const _pos = this._clock.state(Date.now()).positionMs;
        if (_pos != null) {
          if (this._dropIdx > 0 && _drops[this._dropIdx - 1] && _pos < _drops[this._dropIdx - 1].t - 2000) {
            this._dropIdx = 0;                       // spolat bakat
            while (this._dropIdx < _drops.length && _drops[this._dropIdx].t + PiLightEngine.DROP_PRE_MS < _pos) this._dropIdx++;
          }
          while (this._dropIdx < _drops.length && _pos >= _drops[this._dropIdx].t - PiLightEngine.DROP_PRE_MS) {
            const _d = _drops[this._dropIdx++];
            // Bara om vi ar NARA i tiden. En klocka som just hittat ratt far
            // inte spela upp hela latens drops pa en gang.
            if (Math.abs(_pos - _d.t) < 1500) this._dropBoost = Math.max(this._dropBoost, _d.s ?? 0.5);
          }
        }
      }
      // ── FORVANTAN: bygg upp mot nasta drop ──────────────────────────────
      // Kraver inget nytt tillstand — nasta drop ar helt enkelt `_dropIdx`.
      let _build = 1;
      if (_drops && this._dropIdx < _drops.length) {
        const _p2 = this._clock.state(Date.now()).positionMs;
        if (_p2 != null) {
          const _dt = _drops[this._dropIdx].t - _p2;
          if (_dt > 0 && _dt < PiLightEngine.BUILD_MS) {
            const _u = 1 - _dt / PiLightEngine.BUILD_MS;      // 0 vid start, 1 vid dropen
            // Dipp forst, stigning sedan: ljuset ger plats at det som kommer.
            const _sh = _drops[this._dropIdx].s ?? 0.5;
            _build = 1 - PiLightEngine.BUILD_DIP * _sh * (1 - _u)
                       + PiLightEngine.BUILD_TOP * _sh * (_u * _u);
          }
        }
      }

      // Avklingning: ~350 ms till halva. Kort nog att kannas som en traff,
      // langt nog att inte bli ett flimmer.
      if (this._dropBoost > 0) {
        this._dropBoost *= Math.exp(-(this.tickMs || 18) / 500);
        if (this._dropBoost < 0.01) this._dropBoost = 0;
      }

      const bd    = tc.beatDepth * trust * this._secPulse;

      // KOMPOSITION (heartbeat.ts composeEnergy): tak × sektionsskala × förväntan × ((1−bd) + bd·pn); dropen lyfter MOT taket
      // i stället för att adderas — kan aldrig klippa och betyder mest när ljuset är lågt. toNormalized = golv..1 (output-lagrets steg).
      const energyForm = composeEnergy(ceil, this._secScale, _build, bd, pn, this._dropBoost);
      const outN = toNormalized(energyForm, floorN);

      _diag.energyNorm = outN;
      let pct = outN * 100;

      // ── FARDIG SHOW: bara slaa upp ────────────────────────────────────────
      // Allt ovanfor har raknats men kastas nar showen finns. Det ar med flit:
      // de raderna ar realtidsvagen, och den ska vara orord som fallback nar
      // laten ar okand eller klockan tappar. Uppspelningen far INTE bero pa dem.
      // Reglaget "Anvand inspelning" — gallret ligger HAR och inte vid latbytet,
      // sa det gar att sla om mitt i en lat och se skillnaden direkt.
      if (this._show && this.cal.useRecording !== false) {
        // VAR I SHOWEN AR VI? Tva kallor, och landmarkena gar fore.
        //
        //   laset    matchar det micen HOR mot inspelningens landmarken. Ligger
        //            redan i showens tidslinje, sa ingen korrigering behovs.
        //   klockan  Sonos-position plus uppmatt korrigering. Reserv nar laset inte
        //            hunnit greppa, eller nar laten saknar landmarken.
        const _lk = this._lock.state(audioClockMs());
        let _sp: number | null = _lk.showMs;
        if (_sp == null) {
          const _cp0 = this._clock.state(Date.now()).positionMs;
          _sp = _cp0 == null ? null : _cp0 + this._showOffsetMs;
        }
        if (_sp != null && _sp >= 0) {
          // TRE termer, och de tacker tre OLIKA saker:
          //   _sp              var klockan tror att vi ar i laten
          //   _showOffsetMs    uppmatt fel i den lagrade tidslinjen (MATNINGEN)
          //   beatLeadMs       hur sent ljuset faktiskt kommer (UTGANGEN)
          //
          // Den sista saknades. Det ar latt att tro att en forinspelad show inte
          // behover nagot forsprang — ingen forutsagelse kravs ju nar framtiden
          // redan ar kand. Men beatLeadMs ar inte forutsagelse: 87 ms av det ar
          // remsans uppmatta STIGTID och ~45 ms utsignalslatens. Lampan lyser lika
          // sent oavsett om vardet raknades fram nyss eller for en timme sedan.
          // Skillnaden ar att kompensationen HAR blir trivial: vi laser langre fram
          // i arrayen i stallet for att extrapolera.
          const _lead = this.cal.beatLeadMs ?? 0;
          // _sp ar redan korrigerad i bada grenarna — bara utgangslatensen aterstar.
          const _k = Math.round((_sp + _lead) / SHOW_STEP_MS);
          if (_k >= 0 && _k < this._show.length) { pct = this._show[_k]; this._showDrove = true; }
          else this._showDrove = false;

          // SYNKPROV. Klockan sager var i laten vi tror att vi ar; micen sager
          // vad som faktiskt later just da. Loggas parat -- utan HTTP mellan sig
          // -- sa att korskorrelationen mater showens tidsforskjutning och inte
          // natverkets jitter. 10 Hz, samma raster som energikurvan.
          const _now = Date.now();
          if (_now - this._syncLogAt >= 100) {
            this._syncLogAt = _now;
            // Matpunkterna tas mot RA klockposition, utan korrigeringen — annars
            // skulle matningen jaga sin egen svans.
            // Sluta samla nar matningarna ar gjorda — bufferten fyller annars
            // pa hela laten utan att nagon laser den.
            if (!this._syncDone) {
              this._syncPos.push(_sp);
              this._syncRms.push(getLightRawRms());
              if (this._syncPos.length >= this._syncNextAt) this._calibrateSync();
            }
            if (SYNC_PROBE_ON) {
              try {
              appendFileSync(SYNC_PROBE_FILE, Math.round(_sp) + '\t' + getLightRawRms().toFixed(6) + '\n');
              } catch { /* diagnostik far aldrig stora uppspelningen */ }
            }
          }
        }
      }

      // Fast round + clamp
      pct = (pct + 0.5) | 0;
      if (pct > 100) pct = 100;
      if (pct < floor) pct = floor;

      // Auto-tune sampler: registrera RÅ mic-RMS (innan smoothing) så analysen
      // kan separera tysta partier (rumsbrus) från musik-nivå.
      if (this.autoTuneActive) this.recordAutoTuneSample(bands.totalRms);








      // ── 7b. Anti-flicker perceptuell deadband (Weber-Fechner) ──
      // Ögat märker större relativ förändring vid låg ljusstyrka, mindre vid hög.
      // deadbandPct skalas: ~0.5×base vid pct=0, ~1.5×base vid pct=100.
      // Om |pct - lastSentPct| under tröskeln → behåll lastSentPct (eliminerar mikrojitter).
      // Stale-write-mekanismen i protocol.ts håller fortfarande BLE-länken vid liv.
      if (this.lastSentPct >= 0 && cal.flickerDeadband > 0) {
        const deadbandPct = cal.flickerDeadband * 100 * (1.6 - 1.4 * (pct / 100));
        if (Math.abs(pct - this.lastSentPct) < deadbandPct) {
          pct = this.lastSentPct;
          bleStatsState.deadbandBlockedCount++;
        }
      }
      this.lastSentPct = pct;

      // ── Color fade-tween (mjuk övergång till nytt palette-mål) ──
      // Läs alltid palette[0] löpande som mål — så att sena palette-uppdateringar
      // från gateway syns direkt utan att kräva setPalette-call varje gång.
      // ── SHOWEN VALJER FARG ────────────────────────────────────────────────
      // Motorn anvande bara palette[0]; tre av albumets fyra farger lag oanvanda.
      // Nu bestammer showen vilken plats som galler: refrangen far omslagets
      // dominerande farg, verserna en annan, lugna delar en tredje, och dropen
      // en kontrastfarg som utropstecken.
      // Bytet sker BARA vid sektionsgranser och den befintliga 3-sekundersfaden
      // gor overgangen mjuk — aldrig ett hopp mitt i en fras.
      // Showen sager hur mycket fargen ska dras MOT VITT. Huen behalls fran
      // paletten — ett hue-byte per sektion blev disko, och albumpaletterna har
      // ofta bara en distinkt farg anda.
      let _wash = -1;
      if (this._showColor) {
        const _lc = this._lock.state(audioClockMs());
        let _cp: number | null = _lc.showMs;
        if (_cp == null) {
          const _p0 = this._clock.state(Date.now()).positionMs;
          _cp = _p0 == null ? null : _p0 + this._showOffsetMs;
        }
        if (_cp != null && _cp >= 0) {
          // SAMMA tre termer som ljuset. Farg och ljus far aldrig lasa ur olika
          // punkter i showen — da beskriver de olika ogonblick av samma lat.
          const _ck = Math.round((_cp + (this.cal.beatLeadMs ?? 0)) / SHOW_STEP_MS);
          if (_ck >= 0 && _ck < this._showColor.length) _wash = this._showColor[_ck] / 255;
        }
      }
      if (_wash >= 0 && this._palette.length > 0) {
        const pc = this._palette[0];
        this.colorTarget[0] = pc[0] + (255 - pc[0]) * _wash;
        this.colorTarget[1] = pc[1] + (255 - pc[1]) * _wash;
        this.colorTarget[2] = pc[2] + (255 - pc[2]) * _wash;
        this._lastSeenPaletteVersion = this._paletteVersion;
      } else if (this._paletteVersion !== this._lastSeenPaletteVersion && this._palette.length > 0) {
        const p0 = this._palette[0];
        this.colorTarget[0] = p0[0];
        this.colorTarget[1] = p0[1];
        this.colorTarget[2] = p0[2];
        this._lastSeenPaletteVersion = this._paletteVersion;
        this._lastColorIdx = 0;
      }
      // Time-based fade: använd faktisk elapsed sedan förra tick istället för
      // precomputed alpha (som antog exakt tickMs-intervall). Skyddar mot
      // jitter (sen FFT-frame, GC-paus) som annars hade gett ojämn fade-takt.
      const _prevFadeAt = this._lastTickAtForFade || _tickStart;
      const k = this.colorFadeMs > 0
        ? Math.min(1, (_tickStart - _prevFadeAt) / this.colorFadeMs)
        : 1;
      this._lastTickAtForFade = _tickStart;
      if (k < 1) {
        const c = this.color; const t = this.colorTarget;
        // Energibevarande tween: linjär sRGB-lerp går rött → grönt via smutsgult.
        const ik = 1 - k;
        c[0] = Math.sqrt(ik * c[0] * c[0] + k * t[0] * t[0]);
        c[1] = Math.sqrt(ik * c[1] * c[1] + k * t[1] * t[1]);
        c[2] = Math.sqrt(ik * c[2] * c[2] + k * t[2] * t[2]);
      } else {
        this.color[0] = this.colorTarget[0];
        this.color[1] = this.colorTarget[1];
        this.color[2] = this.colorTarget[2];
      }

      // ── Color calibration ──
      // Drop-flash: medan dropFlashUntil är aktiv forceras full vit punch (pct=100)
      // som overridar normal output, sen decay tillbaka till grund nästa tick.
      // Samma regel har: en blixt som hann sattas innan showen laddades far inte
      // overrida den efterat.
      const dropFlash = !this._show && this.dropFlashUntil > _tickStart;
      if (dropFlash) {
        pct = 100;
        this.lastSentPct = 100; // bypassa deadband så blixten alltid skickas
      }
      // Drop längre ger max brightness men behåller palette-färg — bara
      // punchWhiteThreshold (peak-detektorn) tvingar vit.
      let isPunch = (cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold);
      if (this._clapMode) {
        const age = _tickStart >= 0 ? Date.now() - this._clapLastMs : 1e9;
        const on = this._clapLastMs > 0 && age < 150;
        pct = on ? 100 : 5; isPunch = on; this.lastSentPct = -1;   // ingen deadband: varje tick skickas
      }

      // ── FÄRG-TILT på spektralbalans (helt oberoende av brightness) ──
      // bas-tung mix → varmare (rött upp, blått ner), diskant-tung → svalare.
      const tilt = cal.colorSpectralTilt;
      let cr = this.color[0], cg = this.color[1], cb = this.color[2];
      if (tilt > 0 && !inSilence) {
        // -1 (helt diskant) .. +1 (helt bas)
        const balance = (bands.bassShare ?? 0.5) * 2 - 1;
        const warm = 1 + balance * tilt;
        const cool = 1 - balance * tilt;
        cr = Math.min(255, cr * warm);
        cb = Math.min(255, cb * cool);
      }
      applyColorCalibrationFast(cr, cg, cb, tc);


      // ── BLE output (asynkron 1-slot delivery) ──
      // sendToBLE returnerar direkt efter enqueue. Writern levererar senaste
      // frame när BLE kan; busy leverans får aldrig stoppa tick/beat/smoothing.
      const writeResult: WriteResult = isPunch
        ? sendToBLE(255, 255, 255, pct)
        : sendToBLE(_finalColor[0], _finalColor[1], _finalColor[2], pct);
      switch (writeResult) {
        case 'sent':         bleStatsState.tickOkCount++; break;
        case 'no-device':    bleStatsState.tickAbortNoDeviceCount++; break;
      }

      // ── Frame-tap: rapportera queued färg+brightness till observer ──
      if (this._frameTap && writeResult === 'sent') {
        if (isPunch) this._frameTap(pct, 255, 255, 255);
        else this._frameTap(pct, _finalColor[0], _finalColor[1], _finalColor[2]);
      }

      // ── FRAME_RECORDER — sann utsignal, en rad per faktiskt skickad ram (~53 Hz).
      // HTTP-pollning duger inte: för glest samplat för pulsformen, OCH 33 Hz-polling
      // belastar Zero 2W:n så mycket att den försämrar det den mäter.
      if (writeResult === 'sent') {
        const _rf = this.cal.recordFrames ?? 0;
        if (_rf > 0) {
          if (this._recTarget !== _rf) { this._recTarget = _rf; this._recBuf = []; this._recT0 = performance.now(); }
          if (this._recBuf.length < _rf) {
            const _hb = hasBeat(this._beat);
            const _ph = _hb ? beatPhase(this._beat, Date.now() + (this.cal.beatLeadMs ?? 0)) : -1;
            this._recBuf.push([Math.round(performance.now() - this._recT0), pct, _ph,
                               this._beat?.bpm ?? 0, this._trustSm ?? 0, this._shapeSm ?? 0,
                               this.onsetBoost ?? 0].join(','));
            if (this._recBuf.length === _rf) {
              const _csv = 'tms,pct,phase,bpm,trust,shape,boost\n' + this._recBuf.join('\n') + '\n';
              writeFile(join(DATA_DIR, 'frames.csv'), _csv, () => {});
            }
          }
        }
      }



      // ── Diagnostics ──
      _diag.rawRms = bands.totalRms;
      _diag.bassRms = bands.bassRms;
      _diag.midHiRms = bands.midHiRms;
      _diag.level = level;
      _diag.ampEnv = ampEnv;
      _diag.shape = shapeSm;
      _diag.energyForm = energyForm;

      _diag.onsetBoost = Math.max(this.onsetBoost, this._ppOut);
      _diag.brightnessPct = pct;
      _diag.bleScaleRaw = pct / 100;
      _diag.finalR = isPunch ? 255 : _finalColor[0];
      _diag.finalG = isPunch ? 255 : _finalColor[1];
      _diag.finalB = isPunch ? 255 : _finalColor[2];
      _diag.tickCount++;
      _diag.lastTickUs = ((performance.now() - _tickStart) * 1000 + 0.5) | 0;
      _diag.inSilence = inSilence;
      if (inSilence) _diag.tickSilenceCount++;

      // ── Emit ──
      const td = _tickData;
      td.brightness = pct;
      td.color[0] = _finalColor[0]; td.color[1] = _finalColor[1]; td.color[2] = _finalColor[2];
      td.bassLevel = bands.bassRms;
      td.midHiLevel = bands.midHiRms;
      td.isPlaying = this.playing;
      td.tickMs = this.tickMs;
      
      const cbs = this.callbacks;
      for (let i = 0, len = cbs.length; i < len; i++) cbs[i](td);

    } catch (e) {
      console.error('[Engine] tick error (recovering):', e);
      this.sanitizeState();
    }
  }
}
