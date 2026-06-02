/**
 * lightRecorder — spelar in enginens ljus-output per låt och spelar upp den
 * exakt-synkat när samma låt återkommer.
 *
 * Inspelning: prenumererar på enginens frame-tap (färg+brightness som FAKTISKT
 * skickades till BLE) och buffrar nedsamplat till ~25 Hz, positionsankrat mot
 * Sonos positionMs. Vid låtbyte/paus sparas bufferten till DATA_DIR/light-seq/.
 *
 * Uppspelning: när en känd sekvens finns och auto-play är på sätts enginen i
 * playback-mode (setPlaybackSequence) och matas med positionMs-ankare.
 *
 * Ingen extra FFT, ingen rå-ljud-upload — vi buffrar bara värden enginen redan
 * räknat ut. ~30 KB per 4-minuterslåt.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { DATA_DIR, getItem, setItem } from './storage.js';
import { songKeyFromSonos, identifyViaAcr } from './songIdentity.js';
import { analyze, polish, type SeqAnalysis } from './seqPolish.js';
import { renderLightFromAnalysis } from './seqRender.js';
import type { LightCalibration } from './piEngine.js';

interface EngineLike {
  setFrameTap(cb: ((pct: number, r: number, g: number, b: number) => void) | null): void;
  setAnalysisTap(cb: ((bassRms: number, midHiRms: number, totalRms: number, flux: number) => void) | null): void;
  getCalibration(): LightCalibration;
  setPlaybackSequence(frames: number[][] | null, rawRef?: number[][] | null, warmup?: boolean): void;
  updatePlaybackPosition(positionMs: number): void;
  setPlaybackSyncMs(ms: number): void;
}

interface MicLike {
  startAcrCapture(): void;
  stopAcrCapture(): void;
  getAcrCaptureWav(): Buffer | null;
}

const SEQ_DIR = join(DATA_DIR, 'light-seq');
const MIN_FRAMES_TO_SAVE = 50;   // ignorera korta/avbrutna takes
const MAX_FRAMES = 80000;        // ~13 min @100Hz, skydd mot runaway
const ANALYSIS_SCALE = 10000;    // RMS/flux lagras som heltal (×1e4) för kompakthet

const ACR_CAPTURE_MS = 10500;    // ~10s capture + marginal
const ACR_COOLDOWN_MS = 30000;   // undvik att spamma ACRCloud vid okänd källa

let engine: EngineLike | null = null;
let mic: MicLike | null = null;
let recording = getItem('record-enabled') === 'true';
let autoPlay = getItem('autoplay-enabled') === 'true';
let acrEnabled = getItem('acr-enabled') === 'true';

let currentKey: string | null = null;
let pbActive = false;            // enginen kör uppspelning för currentKey
// Analys-buffert @100Hz: [tMs, bass*S, midHi*S, total*S, flux*S, r, g, b]
let analysisBuf: number[][] = [];
let lastColor: [number, number, number] = [255, 255, 255];
let posAnchorMs = 0;
let posAnchorClock = 0;

// ACR-state
let acrActiveKey: string | null = null;
let acrInFlight = false;
let acrCooldownUntil = 0;
let lastIdentified: { artist: string; track: string; key: string; at: number } | null = null;

// Preview-lås: under förhandsgranskning ignoreras Sonos-uppdateringar så att
// uppspelningen inte avbryts mitt i.
let previewUntil = 0;

// ── Manuell sync-offset (ms): positivt = ljuset ligger FÖRE ljudet ──
const SYNC_MS_MAX = 1000;
function clampSync(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return ms < -SYNC_MS_MAX ? -SYNC_MS_MAX : ms > SYNC_MS_MAX ? SYNC_MS_MAX : Math.round(ms);
}
const DEFAULT_LEAD_MS = 100;
const storedSync = getItem('pb-sync-ms');
let syncMs = storedSync != null ? clampSync(parseInt(storedSync, 10)) : DEFAULT_LEAD_MS;

// ── Auto-synk ──
// Kör reaktiv ALSA-mic ~5s i början av en känd låt, korskorrelerar live-ljus-
// enveloppen mot RÅ-inspelningen och låser en auto-offset ovanpå manuell lead.
let autoSync = getItem('autosync-enabled') !== 'false'; // default på
const SYNC_WINDOW_MS = 5000;
const SYNC_SEARCH_MS = 150;
const SYNC_STEP_MS = 20;
const SYNC_CENTER_BIAS = 0.0006;  // favorisera lag nära 0 (undvik grann-beat)
const SYNC_MIN_SAMPLES = 40;
const SYNC_MAX_SAMPLES = 400;
const SYNC_MIN_SCORE = 0.25;

let syncing = false;
let syncSamples: Array<[number, number]> = []; // [posMs, pct]
let syncDeadline = 0;                            // 0 = ej startat
let syncHardCap = 0;
let syncCorrSeq: number[][] | null = null;       // RÅ-referens för korrelation
let syncPlaySeq: number[][] | null = null;       // polerad sekvens som ska spelas
let lastSyncOffsetMs = 0;
let lastSyncScore = 0;

let lastAnchorPos = -1;



function ensureDir(): void {
  if (!existsSync(SEQ_DIR)) mkdirSync(SEQ_DIR, { recursive: true });
}

function seqPath(key: string): string {
  return join(SEQ_DIR, `${key}.json`);
}

function rawPath(key: string): string {
  return join(SEQ_DIR, `${key}.raw.json`);
}

function analysisPath(key: string): string {
  return join(SEQ_DIR, `${key}.analysis.json`);
}

function loadFramesFrom(path: string): number[][] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const frames = parsed?.frames;
    return Array.isArray(frames) && frames.length > 0 ? frames : null;
  } catch {
    return null;
  }
}

function loadSequence(key: string): number[][] | null {
  return loadFramesFrom(seqPath(key));
}

function loadRawSequence(key: string): number[][] | null {
  return loadFramesFrom(rawPath(key));
}

/** Läs lagrade (skalade) analys-frames och unscale till råa RMS/flux-värden. */
function loadAnalysis(key: string): number[][] | null {
  const raw = loadFramesFrom(analysisPath(key));
  if (!raw) return null;
  const S = ANALYSIS_SCALE;
  return raw.map((f) => [f[0], f[1] / S, f[2] / S, f[3] / S, f[4] / S, f[5], f[6], f[7]]);
}

/** Rendera den OPOLERADE ljus-sekvensen ur analysen (≈ enginens reaktiva output
 *  @100Hz). Faller tillbaka på legacy .raw.json om analys saknas. */
function renderRawFromAnalysis(key: string): number[][] | null {
  const a = loadAnalysis(key);
  if (a && engine) {
    try {
      return renderLightFromAnalysis(a, engine.getCalibration());
    } catch (e: any) {
      console.error('[lightRecorder] Rendering ur analys misslyckades:', e?.message ?? e);
    }
  }
  return loadRawSequence(key);
}

function writeFrames(path: string, key: string, frames: number[][]): void {
  const payload = {
    key,
    durationMs: frames.length ? frames[frames.length - 1][0] : 0,
    frames,
    updatedAt: Date.now(),
  };
  writeFileSync(path, JSON.stringify(payload), 'utf-8');
}

function finalizeRecording(): void {
  if (!recording || !currentKey || analysisBuf.length < MIN_FRAMES_TO_SAVE) {
    analysisBuf = [];
    return;
  }
  try {
    ensureDir();
    const existing = loadAnalysis(currentKey) ?? loadSequence(currentKey);
    // Skriv bara om vi inte har en sekvens, eller om den nya är minst lika komplett.
    if (!existing || analysisBuf.length >= existing.length) {
      // Spara den oförvrängda analysen (för ångra/om-trimning) och rendera +
      // finslipa en uppspelnings-version.
      writeFrames(analysisPath(currentKey), currentKey, analysisBuf);
      const raw = renderRawFromAnalysis(currentKey) ?? [];
      // Finslipning får aldrig blockera sparningen: faller den så spelas den
      // renderade rå-versionen upp i stället.
      let playable: number[][] = raw;
      try {
        if (raw.length >= 2) playable = polish(raw);
      } catch (e: any) {
        console.error('[lightRecorder] Finslipning misslyckades, sparar rå:', e?.message ?? e);
      }
      writeFrames(seqPath(currentKey), currentKey, playable);
      console.log(`[lightRecorder] Sparade "${currentKey}" (${analysisBuf.length} analys → ${playable.length} frames)`);
    }
  } catch (e: any) {
    console.error('[lightRecorder] Kunde inte spara sekvens:', e?.message ?? e);
  }
  analysisBuf = [];
}

/** Engine frame-tap (50Hz) — driver auto-synk och håller senaste färgen. */
function onFrame(pct: number, r: number, g: number, b: number): void {
  lastColor[0] = r; lastColor[1] = g; lastColor[2] = b;

  const tMs = posAnchorMs + (Date.now() - posAnchorClock);

  // Auto-synk: samla live-ljusenveloppen under ett 5s-fönster och korrelera
  // mot RÅ-referensen. Fönstret startar vid FÖRSTA live-framen (mic-warmup).
  if (syncing) {
    if (syncDeadline === 0) {
      syncDeadline = Date.now() + SYNC_WINDOW_MS;
      syncHardCap = Date.now() + SYNC_WINDOW_MS * 2;
    }
    syncSamples.push([tMs | 0, pct]);
    if (
      syncSamples.length >= SYNC_MAX_SAMPLES ||
      Date.now() >= syncDeadline ||
      Date.now() >= syncHardCap
    ) {
      finalizeSync();
    }
    return;
  }
}

/** Engine analys-tap (100Hz) — spelar in oförvrängda FFT-band + flux. */
function onAnalysis(bassRms: number, midHiRms: number, totalRms: number, flux: number): void {
  if (syncing || !recording || pbActive || !currentKey) return;
  if (analysisBuf.length >= MAX_FRAMES) return;
  const tMs = posAnchorMs + (Date.now() - posAnchorClock);
  const S = ANALYSIS_SCALE;
  analysisBuf.push([
    tMs | 0,
    Math.round(bassRms * S), Math.round(midHiRms * S),
    Math.round(totalRms * S), Math.round(flux * S),
    lastColor[0], lastColor[1], lastColor[2],
  ]);
}

export function attachEngine(e: EngineLike): void {
  engine = e;
  e.setFrameTap(onFrame);
  e.setAnalysisTap(onAnalysis);
  e.setPlaybackSyncMs(syncMs);
}

export function attachMic(m: MicLike): void {
  mic = m;
}

/** Interpolerar pct ur en [tMs,pct,...]-sekvens vid given position. */
function seqValueAt(seq: number[][], posMs: number): number {
  const n = seq.length;
  if (n === 0) return 0;
  if (posMs <= seq[0][0]) return seq[0][1];
  if (posMs >= seq[n - 1][0]) return seq[n - 1][1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (seq[mid][0] <= posMs) lo = mid; else hi = mid;
  }
  const a = seq[lo], b = seq[hi];
  const dt = b[0] - a[0];
  const t = dt > 0 ? (posMs - a[0]) / dt : 0;
  return a[1] + (b[1] - a[1]) * t;
}

/**
 * Pearson-korskorrelation mellan live-samples och referenssekvensen över lag
 * ±150 ms i 20 ms-steg. score = corr − bias·|lag| (favoriserar lag nära 0 så vi
 * inte låser på en grann-beat). Returnerar bästa {lagMs, score} eller null.
 */
function bestSyncLag(
  samples: Array<[number, number]>,
  seq: number[][],
): { lagMs: number; score: number } | null {
  if (samples.length < SYNC_MIN_SAMPLES || seq.length < 2) return null;
  // Förberäkna live-medel/variation.
  let sx = 0;
  for (const s of samples) sx += s[1];
  const mx = sx / samples.length;
  let varX = 0;
  for (const s of samples) { const dx = s[1] - mx; varX += dx * dx; }
  if (varX <= 1e-6) return null; // platt live → ingen info

  let best: { lagMs: number; score: number } | null = null;
  for (let lag = -SYNC_SEARCH_MS; lag <= SYNC_SEARCH_MS; lag += SYNC_STEP_MS) {
    let sy = 0;
    const ys: number[] = new Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const y = seqValueAt(seq, samples[i][0] + lag);
      ys[i] = y; sy += y;
    }
    const my = sy / samples.length;
    let cov = 0, varY = 0;
    for (let i = 0; i < samples.length; i++) {
      const dx = samples[i][1] - mx;
      const dy = ys[i] - my;
      cov += dx * dy; varY += dy * dy;
    }
    if (varY <= 1e-6) continue;
    const corr = cov / Math.sqrt(varX * varY);
    const score = corr - SYNC_CENTER_BIAS * Math.abs(lag);
    if (!best || score > best.score) best = { lagMs: lag, score: corr };
  }
  return best;
}

/** Avbryt pågående auto-synk och nollställ state. */
function cancelSync(): void {
  syncing = false;
  syncSamples = [];
  syncDeadline = 0;
  syncHardCap = 0;
  syncCorrSeq = null;
  syncPlaySeq = null;
}

/** Mät offset, applicera och växla till uppspelning. */
function finalizeSync(): void {
  if (!engine || !syncPlaySeq) { cancelSync(); return; }
  const playSeq = syncPlaySeq;
  const corrSeq = syncCorrSeq ?? playSeq;
  const res = bestSyncLag(syncSamples, corrSeq);
  let autoOffset = 0;
  if (res && res.score >= SYNC_MIN_SCORE) {
    autoOffset = res.lagMs;
    lastSyncScore = res.score;
    console.log(`[lightRecorder] ✓ Auto-synk: offset ${autoOffset}ms (score ${res.score.toFixed(2)})`);
  } else {
    lastSyncScore = res ? res.score : 0;
    console.log('[lightRecorder] Auto-synk: ingen säker matchning, behåller manuell lead.');
  }
  lastSyncOffsetMs = autoOffset;
  engine.setPlaybackSyncMs(syncMs + autoOffset);

  const elapsed = Date.now() - posAnchorClock;
  engine.setPlaybackSequence(playSeq, null, false);
  engine.updatePlaybackPosition(posAnchorMs + elapsed);
  pbActive = true;

  syncing = false;
  syncSamples = [];
  syncDeadline = 0;
  syncHardCap = 0;
  syncCorrSeq = null;
  syncPlaySeq = null;
}

/** Växla currentKey och sätt upp record/replay för den. */
function applyKeyTransition(key: string): void {
  if (!engine || key === currentKey) return;
  cancelSync();
  finalizeRecording();
  currentKey = key;
  lastAnchorPos = -1;

  const saved = autoPlay ? loadSequence(key) : null;
  if (saved && autoSync) {
    // Starta auto-synk: kör reaktivt (live mic) tills offseten låst.
    engine.setPlaybackSyncMs(syncMs);
    engine.setPlaybackSequence(null);
    pbActive = false;
    syncing = true;
    syncSamples = [];
    syncDeadline = 0;
    syncHardCap = 0;
    syncCorrSeq = renderRawFromAnalysis(key) ?? saved;
    syncPlaySeq = saved;
    console.log(`[lightRecorder] ◐ Auto-synkar "${key}" mot rå-inspelningen…`);
  } else if (saved) {
    engine.setPlaybackSyncMs(syncMs);
    engine.setPlaybackSequence(saved, null, false);
    engine.updatePlaybackPosition(posAnchorMs);
    pbActive = true;
    console.log(`[lightRecorder] ▶ Spelar upp lärd sekvens "${key}" (${saved.length} frames)`);
  } else {
    engine.setPlaybackSequence(null);
    pbActive = false;
    if (recording) console.log(`[lightRecorder] ● Spelar in "${key}"`);
  }
}

/** Starta ~10s ACR-capture och identifiera. Respekterar cooldown/in-flight. */
function maybeStartAcr(): void {
  if (!mic || acrInFlight || acrActiveKey) return;
  if (Date.now() < acrCooldownUntil) return;
  acrInFlight = true;
  mic.startAcrCapture();
  console.log('[lightRecorder] ♪ ACR: spelar in ~10s för igenkänning…');
  setTimeout(async () => {
    try {
      const wav = mic!.getAcrCaptureWav();
      if (!wav) { return; }
      const res = await identifyViaAcr(wav);
      acrCooldownUntil = Date.now() + ACR_COOLDOWN_MS;
      if (res) {
        acrActiveKey = res.key;
        lastIdentified = { artist: res.artist, track: res.track, key: res.key, at: Date.now() };
        console.log(`[lightRecorder] ✓ ACR-träff: ${res.artist} — ${res.track} (${res.key})`);
        applyKeyTransition(res.key);
      } else {
        console.log('[lightRecorder] ACR: ingen träff.');
      }
    } catch (e: any) {
      acrCooldownUntil = Date.now() + ACR_COOLDOWN_MS;
      console.warn('[lightRecorder] ACR-fel:', e?.message ?? e);
    } finally {
      acrInFlight = false;
    }
  }, ACR_CAPTURE_MS);
}

/** Anropas vid varje Sonos-uppdatering från index.ts. */
export function onSonosUpdate(state: {
  trackName: string | null;
  artistName: string | null;
  playbackState: string;
  positionMs: number | null;
  isTvMode: boolean;
}): void {
  if (!engine) return;

  // Under förhandsgranskning: lämna uppspelningen ifred tills previewen är klar.
  if (Date.now() < previewUntil) return;

  // FRI-LÖPANDE POSITIONSANKRING: Sonos positionMs är ~1 s-kvantiserad och
  // uppdateras ojämnt. Ankra EN gång och låt den lokala klockan löpa fritt;
  // om-ankra bara vid verklig seek (avvikelse > tröskel).
  if (state.positionMs != null) {
    const RESYNC_THRESHOLD_MS = 1500;
    const RESTART_THRESHOLD_MS = 3000; // bakåt-hopp ⇒ låten började om
    const reported = state.positionMs;
    const extrapolated = posAnchorMs + (Date.now() - posAnchorClock);
    const firstAnchor = lastAnchorPos < 0;

    // Samma låt har loopats/spelats om medan vi spelar in → avsluta nuvarande
    // take (sparas bara om den är minst lika komplett) och börja en ny buffer,
    // så att varv 2 inte läggs ovanpå varv 1.
    if (!firstAnchor && recording && !pbActive && currentKey &&
        (extrapolated - reported) > RESTART_THRESHOLD_MS) {
      finalizeRecording();           // sparar ev. det fulla varvet, tömmer analysisBuf
      posAnchorMs = reported;
      posAnchorClock = Date.now();
      lastAnchorPos = reported;
      return;                        // resten av denna uppdatering hoppas över
    }

    if (firstAnchor || Math.abs(reported - extrapolated) > RESYNC_THRESHOLD_MS) {
      posAnchorMs = reported;
      posAnchorClock = Date.now();
      if (pbActive) engine.updatePlaybackPosition(reported);
    }
    lastAnchorPos = reported;
  }

  const isPlaying = typeof state.playbackState === 'string' && state.playbackState.includes('PLAYING');
  const playing = isPlaying && !state.isTvMode;
  const sourceActive = isPlaying || state.isTvMode;
  const sonosKey = playing ? songKeyFromSonos(state.trackName, state.artistName) : null;

  // ACR-läge: källa aktiv men ingen Sonos-metadata → identifiera via mic.
  if (!sonosKey && sourceActive && acrEnabled) {
    maybeStartAcr();
  } else {
    // Sonos har metadata, eller källa inaktiv → släpp ev. ACR-nyckel.
    acrActiveKey = null;
  }

  // Sonos-metadata vinner; annars ACR-nyckel om källan är aktiv.
  const key = sonosKey ?? (sourceActive ? acrActiveKey : null);

  if (!key) {
    // Inget spelar / okänd källa → avsluta ev. inspelning, tillbaka till reaktivt.
    if (currentKey) {
      cancelSync();
      finalizeRecording();
      currentKey = null;
      pbActive = false;
      lastAnchorPos = -1;
      engine.setPlaybackSequence(null);
    }
    return;
  }

  if (key === currentKey) return; // samma låt, inget byte

  applyKeyTransition(key);
}

export function setRecording(on: boolean): void {
  recording = on;
  setItem('record-enabled', String(on));
  if (!on) finalizeRecording();
}

export function setAutoPlay(on: boolean): void {
  autoPlay = on;
  setItem('autoplay-enabled', String(on));
  if (!on && (pbActive || syncing)) {
    cancelSync();
    pbActive = false;
    engine?.setPlaybackSequence(null);
  }
}

export function setAutoSync(on: boolean): void {
  autoSync = on;
  setItem('autosync-enabled', String(on));
  if (!on) cancelSync();
}

/** Sätt manuell sync-offset (ms). Returnerar applicerat (clampat) värde. */
export function setSyncOffset(ms: number): number {
  syncMs = clampSync(ms);
  setItem('pb-sync-ms', String(syncMs));
  engine?.setPlaybackSyncMs(syncMs + lastSyncOffsetMs);
  return syncMs;
}

export function getSyncOffset(): number {
  return syncMs;
}

export function setAcrMode(on: boolean): void {
  acrEnabled = on;
  setItem('acr-enabled', String(on));
  if (!on) {
    acrActiveKey = null;
    if (acrInFlight) { mic?.stopAcrCapture(); acrInFlight = false; }
  }
}

export function getAcrState(): {
  acrEnabled: boolean;
  lastIdentified: { artist: string; track: string; key: string; at: number } | null;
} {
  return { acrEnabled, lastIdentified };
}

export function getRecorderState(): {
  recording: boolean; autoPlay: boolean; currentKey: string | null; playingBack: boolean;
  syncMs: number; autoSync: boolean; syncing: boolean; lastSyncOffsetMs: number; lastSyncScore: number;
} {
  return {
    recording, autoPlay, currentKey, playingBack: pbActive,
    syncMs, autoSync, syncing, lastSyncOffsetMs, lastSyncScore,
  };
}

export function listSequences(): Array<{ key: string; frames: number; durationMs: number; updatedAt: number }> {
  try {
    ensureDir();
    return readdirSync(SEQ_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.raw.json') && !f.endsWith('.analysis.json'))
      .map((f) => {
        const key = f.slice(0, -5);
        try {
          const parsed = JSON.parse(readFileSync(join(SEQ_DIR, f), 'utf-8'));
          return {
            key,
            frames: Array.isArray(parsed?.frames) ? parsed.frames.length : 0,
            durationMs: parsed?.durationMs ?? 0,
            updatedAt: parsed?.updatedAt ?? statSync(join(SEQ_DIR, f)).mtimeMs,
          };
        } catch {
          return { key, frames: 0, durationMs: 0, updatedAt: 0 };
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function deleteSequence(key: string): boolean {
  try {
    unlinkSync(seqPath(key));
    try { unlinkSync(analysisPath(key)); } catch { /* ingen analys-kopia */ }
    try { unlinkSync(rawPath(key)); } catch { /* ingen legacy rå-kopia */ }
    if (key === currentKey) {
      pbActive = false;
      engine?.setPlaybackSequence(null);
    }
    return true;
  } catch {
    return false;
  }
}

/** Analys av rå (renderad ur analysen) och polerad (uppspelad) version för Låt-studion. */
export function getSequence(key: string): { raw: SeqAnalysis | null; polished: SeqAnalysis | null } {
  const raw = renderRawFromAnalysis(key);
  const polished = loadSequence(key);
  return {
    raw: raw ? analyze(raw) : null,
    polished: polished ? analyze(polished) : null,
  };
}

/** Spela upp vald variant på slingan, oberoende av Sonos, under sekvensens längd. */
export function previewSequence(key: string, variant: 'raw' | 'polished'): boolean {
  if (!engine) return false;
  const frames = variant === 'raw' ? renderRawFromAnalysis(key) : loadSequence(key);
  if (!frames || frames.length === 0) return false;
  finalizeRecording();
  currentKey = null;
  engine.setPlaybackSequence(frames, null, false); // preview: spela direkt, ingen warm-up
  engine.updatePlaybackPosition(0);
  pbActive = true;
  const durationMs = frames[frames.length - 1][0];
  previewUntil = Date.now() + durationMs + 500;
  return true;
}

/** Återställ uppspelnings-versionen genom att rendera + finslipa om ur analysen. */
export function revertSequence(key: string): boolean {
  const raw = renderRawFromAnalysis(key);
  if (!raw || raw.length === 0) return false;
  let playable = raw;
  try {
    if (raw.length >= 2) playable = polish(raw);
  } catch (e: any) {
    console.error('[lightRecorder] Finslipning misslyckades vid ångra, använder rå:', e?.message ?? e);
  }
  try {
    writeFrames(seqPath(key), key, playable);
    return true;
  } catch {
    return false;
  }
}

