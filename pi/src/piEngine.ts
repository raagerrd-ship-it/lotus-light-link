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
import { getLatestBands, getLatestFrame, getLatestFrameAt, resetFluxState, onFFTReady, onFluxReady, stopMic, setBeatCutoffHz, setAnalyserBeatGrid, hintAnalyserTrackChange, FRAME_MS, getLightRawRms, audioClockMs, onLandmarks as micOnLandmarks, resetLandmarks, startFineEnergy, stopFineEnergy } from './alsaMic.js';
import type { Frame } from './audio-analyser/index.js';
import { hasBeat, beatIndex, beatPhase, nextBeatIn, MIN_BEAT_CONFIDENCE, type Beat } from './audio-analyser/beatClock.js';
import { sendToBLE, clearQueuedWrite, flushQueuedWriteNow, hasQueuedWrite, setIdleColor, setSlotLeaseMs, startKeepAlive, stopKeepAlive } from './ble-driver/protocol.js';
import type { WriteResult } from './ble-driver/protocol.js';
import { bleStats as bleStatsState } from './ble-driver/state.js';
import { triggerIdleDisconnect, getHardcodedConnected } from './ble-driver/connect.js';
import { isControllerDrainAttached, getOutstandingPackets } from './ble-driver/controllerDrain.js';
import { getItem, setItem, DATA_DIR } from './storage.js';
import { writeFile, appendFileSync, writeFileSync } from 'node:fs';
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
  const fftMs = FRAME_MS;


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
  beatLeadMs: 132,           // 87 ms uppmätt toppfördröjning (rise) + ~45 ms utsignalslatens
  beatSyncStrength: 0.10,    // PLL:ens fas-ankarknuff, INTE ljus-modulation
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
  lightSmoothMs: 55,         // release-avbrusning på energivägen

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
    setSlotLeaseMs(this.tickMs); // 1:1 med engine-ticken
  }

  getPalette(): [number, number, number][] { return this._palette; }
  setVolume(vol: number | undefined) { this.volume = vol; }
  getTickMs(): number { return this.tickMs; }

  setTickMs(ms: number) {
    this.tickMs = ms;
    this.initOnsetBuffer();
    this.tc = computeTickConstants(ms, this.cal);
    setSlotLeaseMs(this.tickMs); // 1:1 med engine-ticken
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
        this._riseHold = Math.ceil((_riseMs * (this.cal.onsetRiseHoldK ?? 2.0)) / FRAME_MS);
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
    this._songBpm = 0;
    this._songEntry = null;
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
    const _memBpm = _useRec ? this._songBpm : 0;
    const bpm = _memBpm > 0 ? _memBpm : (frame?.bpm ?? 0);
    // Ett känt tempo är inte en gissning — låt inte en svag mic sänka förtroendet.
    const conf = _memBpm > 0 ? Math.max(frame?.bpmConfidence ?? 0, 0.9) : (frame?.bpmConfidence ?? 0);
    const nowMs = Date.now();
    const reacq = nowMs < this._reacqUntil;

    if (bpm > 40) {
      // Under re-acquisition räcker 0.5 BPM avvikelse för att om-ankra (annars 2),
      // så en ny takt landar utan att glida in via PLL:en.
      if (!this._beat || Math.abs(bpm - this._beatDetBpm) > (reacq ? 0.5 : 2)) {
        this._beatDetBpm = bpm;
        let anchor = frame?.beatAnchorMs || nowMs;
        if (this._beat) {
          // Bevara nuvarande fas vid tempoändring så pulsen inte hoppar.
          const oldMs = 60000 / this._beat.bpm, newMs = 60000 / bpm;
          const ph = ((((nowMs - this._beat.anchorMs) % oldMs) + oldMs) % oldMs) / oldMs;
          anchor = nowMs - ph * newMs;
        }
        this._beat = { anchorMs: anchor, bpm, confidence: conf };
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

    if (!kick || !this._beat) return;

    const k0 = this.cal.beatSyncStrength;
    const beatMsNow = 60000 / this._beat.bpm;
    // Fasen mäts helst mot analysatorns FÄRDIGMÄTTA slagtid (sub-hop, ±1.3 ms).
    // Date.now() här bär ALSA-leveransens jitter. Bara färska värden duger.
    const kickAt = frame?.kickAtMs ?? 0;
    const nowRef = kickAt > 0 && nowMs - kickAt < 60 ? kickAt : nowMs;
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
      this._beat.bpm += err * 0.35 * conf;
      const lo = this._beatDetBpm - 4, hi = this._beatDetBpm + 4;
      if (this._beat.bpm < lo) this._beat.bpm = lo;
      else if (this._beat.bpm > hi) this._beat.bpm = hi;
    }
  }

  /** Taktklockans tillstånd — för /api/status och UI. */
  getBeatInfo(): {
    locked: boolean; bpm: number; confidence: number; phase: number;
    nextBeatMs: number; beatErr: number; gridPulses: number; leadMs: number;
    subdivLevel: number; energySm: number; trust: number; shapeSm?: number; shapeSlow?: number; shapeRel: number;
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
      trust: Math.max(this.cal.beatTrustFloor ?? 0.35, this._trustSm ?? 0),
      energySm: this.smoothed,
      shapeSm: this._shapeSm,
      shapeSlow: this._shapeSlow,
      shapeRel: this._shapeRel,
      leadMs: lead,
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
      this._micPausedForIdle = true;
      dlog('[Engine] ALSA-mic stoppad — väntar på Sonos PLAYING-event');
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
      this._wlevelSm = undefined;
      this._wdbSlow = undefined;
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
      this._wlevelSm = undefined;
      this._wdbSlow = undefined;
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
    this.cal = loadCalibration();
    setBeatCutoffHz(this.cal.beatCutoffHz);
    this._calDirty = true; // mark for next save cycle
    // Re-apply raw mode overrides if active
    if (this._rawMode) {
      this.cal.transientGain = 0;
    }
    this.tc = computeTickConstants(this.tickMs, this.cal);
  }

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
            if (_bpmWants !== null) next = _bpmWants;
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
              this.onsetTarget = onOne ? Math.min(1, 0.45 * accent) : 0.45;
              this._gridPulseCount++;
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
              this.onsetTarget = 0.45;
              this._gridPulseCount++;
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
      if (this._calDirty) {
        saveCalibration(this.cal);
        this._calDirty = false;
      }
    }, 10_000);

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
  private onFFTFrame(): void {
    if (!this._loopActive) return;

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
  }

  private stopLoop(): void {
    this._loopActive = false;
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
        const aSm = rising && upMs <= 0 ? 1 : 1 - Math.exp(-FRAME_MS / (rising ? Math.max(1, upMs) : downMs));
        this._wlevelSm = this._wlevelSm === undefined
          ? wlevelRaw
          : this._wlevelSm + (wlevelRaw - this._wlevelSm) * aSm;
        const wlevel = this._wlevelSm;
        const wdb = 20 * Math.log10(Math.max(wlevel, 1e-4));
        let anchorDb = cal.anchorDb ?? -4;
        if ((cal.autoAnchor ?? 0) > 0) {
          const tauMs = Math.max(1000, (cal.autoAnchorSec ?? 60) * 1000);
          const anchorUp = this._wdbSlow !== undefined && wdb > this._wdbSlow;
          const anchorAlpha = 1 - Math.exp(-FRAME_MS / (anchorUp ? tauMs * 3 : tauMs));
          this._wdbSlow = this._wdbSlow === undefined ? wdb : this._wdbSlow + anchorAlpha * (wdb - this._wdbSlow);
          anchorDb = this._wdbSlow + (cal.anchorOffsetDb ?? 4);
          _diag.wdbSlow = this._wdbSlow;
          _diag.anchorDb = anchorDb;
        }
        // FAST dB-fönster; auto-ankaret följer långsamt så sektionsdynamiken bevaras.
        const windowDb = Math.max(1, cal.windowDb ?? 18);
        shape = (wdb - (anchorDb - windowDb)) / windowDb;
        shape = shape < 0 ? 0 : shape > 1 ? 1 : shape;
        _diag.wlevel = wlevel; _diag.wdb = wdb;  // för live-kalibrering av anchorDb
      } else {
        // ── FALLBACK (dbWindow=false): gamla adaptiva taket + expansion ──
        let inLow: number, inHigh: number;
        if (cal.adaptiveCeiling !== false) {
          if (this._slowMean === undefined) this._slowMean = 0.4;
          this._slowMean += (level - this._slowMean) * (FRAME_MS / (cal.ceilFollowMs ?? 7000));
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
      const inSilence = tickFloor > 0 && level < tickFloor;
      if (inSilence) shape = 0;

      // Takjämning före heartbeat-smoothing: shape uppdateras ~15 Hz medan motorn
      // renderar ~75 Hz, så stora enstaka hopp fördelas över flera frames.
      const shapeUpMs = cal.shapeSmoothUpMs ?? 300;
      const shapeDownMs = cal.shapeSmoothDownMs ?? 120;
      if (shapeUpMs > 0 || shapeDownMs > 0) {
        if (this._shapeSm === undefined) this._shapeSm = shape;
        else {
          const shapeMs = shape > this._shapeSm ? shapeUpMs : shapeDownMs;
          const shapeAlpha = shapeMs > 0 ? 1 - Math.exp(-FRAME_MS / shapeMs) : 1;
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
      const NOM = 0.45;                                   // grid-pulsens nominella onsetTarget
      const p   = this.onsetBoost / NOM;                  // 1.0 på vanligt slag, upp till barAccent på ettan
      const pn  = p < 1 ? p : 1;                          // djupet INOM taket
      const acc = Math.max(1, cal.barAccent ?? 1);
      const one = acc > 1 ? Math.min(1, Math.max(0, p - 1) / (acc - 1)) : 0;   // 1 på ettan

      // buildUp OCH ettan höjer TAKET (adderas inte ovanpå — då klampar de bort pulsen)
      const _f = getLatestFrame();
      const bu = (_f && (_f as any).buildUp) ? (_f as any).buildUp : 0;
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
      let ceil = shapeUse * (1 + bu * (cal.buildUpGain ?? 0));
      ceil += (1 - ceil) * one * (cal.barAccentLift ?? 0.30);
      if (ceil > 1) ceil = 1;

      // TRUST — mjuk ramp i stället för binärt. MIN_BEAT_CONFIDENCE är bara 0.20,
      // så det binära beslutet gav FULLT pulsdjup på mycket svag takt, och snäppte
      // av/på när konfidensen vandrade kring tröskeln (locked flippade 4×/3 min).
      // Golvet låter modulationen leva på FAKTISKA transienter när takten är otydlig.
      const _c = this._beat?.confidence ?? 0;
      const _lo = this.cal.beatTrustLoConf ?? 0.30;
      const _hi = this.cal.beatTrustHiConf ?? 0.70;
      const _tRaw = hasBeat(this._beat) ? Math.min(1, Math.max(0, (_c - _lo) / Math.max(1e-6, _hi - _lo))) : 0;
      // Rampen ensam räcker inte: conf kan falla 0.79 → 0.00 mellan två ramar.
      const _tA = Math.min(1, (this.tickMs || 18) / (this.cal.beatTrustSmoothMs ?? 400));
      this._trustSm = (this._trustSm == null) ? _tRaw : this._trustSm + (_tRaw - this._trustSm) * _tA;
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

      let energyForm = ceil * this._secScale * _build * ((1 - bd) + bd * pn);
      // Dropen lyfter MOT taket i stallet for att adderas — sa den aldrig kan
      // klippa, och sa den betyder mest nar ljuset ar lagt (vilket ar precis
      // dar en drop gor storst intryck).
      if (this._dropBoost > 0) energyForm += this._dropBoost * (1 - energyForm);
      if (energyForm > 1) energyForm = 1;
      let outN = floorN + energyForm * (1 - floorN);
      if (outN < floorN) outN = floorN;
      if (outN > 1) outN = 1;

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
      const isPunch = (cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold);

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

      _diag.onsetBoost = this.onsetBoost;
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
