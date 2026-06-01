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

type Frame = [number, number, number, number, number]; // [tMs, pct, r, g, b]

interface EngineLike {
  setFrameTap(cb: ((pct: number, r: number, g: number, b: number) => void) | null): void;
  setPlaybackSequence(frames: number[][] | null): void;
  updatePlaybackPosition(positionMs: number): void;
}

interface MicLike {
  startAcrCapture(): void;
  stopAcrCapture(): void;
  getAcrCaptureWav(): Buffer | null;
}

const SEQ_DIR = join(DATA_DIR, 'light-seq');
const SAMPLE_INTERVAL_MS = 40;   // ~25 Hz nedsampling
const MIN_FRAMES_TO_SAVE = 50;   // ignorera korta/avbrutna takes
const MAX_FRAMES = 20000;        // ~13 min tak, skydd mot runaway

const ACR_CAPTURE_MS = 10500;    // ~10s capture + marginal
const ACR_COOLDOWN_MS = 30000;   // undvik att spamma ACRCloud vid okänd källa

let engine: EngineLike | null = null;
let mic: MicLike | null = null;
let recording = getItem('record-enabled') === 'true';
let autoPlay = getItem('autoplay-enabled') === 'true';
let acrEnabled = getItem('acr-enabled') === 'true';

let currentKey: string | null = null;
let pbActive = false;            // enginen kör uppspelning för currentKey
let buffer: Frame[] = [];
let lastRecT = -Infinity;
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


function ensureDir(): void {
  if (!existsSync(SEQ_DIR)) mkdirSync(SEQ_DIR, { recursive: true });
}

function seqPath(key: string): string {
  return join(SEQ_DIR, `${key}.json`);
}

function rawPath(key: string): string {
  return join(SEQ_DIR, `${key}.raw.json`);
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
  if (!recording || !currentKey || buffer.length < MIN_FRAMES_TO_SAVE) {
    buffer = [];
    return;
  }
  try {
    ensureDir();
    const existingRaw = loadRawSequence(currentKey) ?? loadSequence(currentKey);
    // Skriv bara om vi inte har en sekvens, eller om den nya är minst lika komplett.
    if (!existingRaw || buffer.length >= existingRaw.length) {
      // Spara råinspelningen (för ångra) och en auto-finslipad version som spelas upp.
      writeFrames(rawPath(currentKey), currentKey, buffer);
      // Finslipning får aldrig blockera sparningen: faller finslipningen så
      // spelas rå-versionen upp i stället (annars saknas <key>.json helt och
      // låten "försvinner" ur listan).
      let playable = buffer;
      try {
        playable = polish(buffer);
      } catch (e: any) {
        console.error('[lightRecorder] Finslipning misslyckades, sparar rå:', e?.message ?? e);
      }
      writeFrames(seqPath(currentKey), currentKey, playable);
      console.log(`[lightRecorder] Sparade "${currentKey}" (${buffer.length} → ${playable.length} frames)`);
    }
  } catch (e: any) {
    console.error('[lightRecorder] Kunde inte spara sekvens:', e?.message ?? e);
  }
  buffer = [];
}

/** Engine frame-tap. */
function onFrame(pct: number, r: number, g: number, b: number): void {
  if (!recording || pbActive || !currentKey) return;
  const tMs = posAnchorMs + (Date.now() - posAnchorClock);
  if (tMs - lastRecT < SAMPLE_INTERVAL_MS) return;
  if (buffer.length >= MAX_FRAMES) return;
  lastRecT = tMs;
  buffer.push([tMs | 0, pct, r, g, b]);
}

export function attachEngine(e: EngineLike): void {
  engine = e;
  e.setFrameTap(onFrame);
}

export function attachMic(m: MicLike): void {
  mic = m;
}

/** Växla currentKey och sätt upp record/replay för den. */
function applyKeyTransition(key: string): void {
  if (!engine || key === currentKey) return;
  finalizeRecording();
  currentKey = key;
  lastRecT = -Infinity;

  const saved = autoPlay ? loadSequence(key) : null;
  if (saved) {
    engine.setPlaybackSequence(saved);
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

  // Ankra position löpande (för både inspelning och uppspelning).
  if (state.positionMs != null) {
    posAnchorMs = state.positionMs;
    posAnchorClock = Date.now();
    if (pbActive) engine.updatePlaybackPosition(state.positionMs);
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
      finalizeRecording();
      currentKey = null;
      pbActive = false;
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
  if (!on && pbActive) {
    pbActive = false;
    engine?.setPlaybackSequence(null);
  }
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

export function getRecorderState(): { recording: boolean; autoPlay: boolean; currentKey: string | null; playingBack: boolean; bufferFrames: number } {
  return { recording, autoPlay, currentKey, playingBack: pbActive, bufferFrames: buffer.length };
}

export function listSequences(): Array<{ key: string; frames: number; durationMs: number; updatedAt: number }> {
  try {
    ensureDir();
    return readdirSync(SEQ_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.raw.json'))
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
    try { unlinkSync(rawPath(key)); } catch { /* ingen rå-kopia */ }
    if (key === currentKey) {
      pbActive = false;
      engine?.setPlaybackSequence(null);
    }
    return true;
  } catch {
    return false;
  }
}

/** Analys av rå (inspelad) och polerad (uppspelad) version för Låt-studion. */
export function getSequence(key: string): { raw: SeqAnalysis | null; polished: SeqAnalysis | null } {
  const raw = loadRawSequence(key);
  const polished = loadSequence(key);
  return {
    raw: raw ? analyze(raw) : null,
    polished: polished ? analyze(polished) : null,
  };
}

/** Spela upp vald variant på slingan, oberoende av Sonos, under sekvensens längd. */
export function previewSequence(key: string, variant: 'raw' | 'polished'): boolean {
  if (!engine) return false;
  const frames = variant === 'raw' ? loadRawSequence(key) : loadSequence(key);
  if (!frames || frames.length === 0) return false;
  finalizeRecording();
  currentKey = null;
  engine.setPlaybackSequence(frames);
  engine.updatePlaybackPosition(0);
  pbActive = true;
  const durationMs = frames[frames.length - 1][0];
  previewUntil = Date.now() + durationMs + 500;
  return true;
}

/** Återställ till råinspelningen och finslipa om från den. */
export function revertSequence(key: string): boolean {
  const raw = loadRawSequence(key);
  if (!raw) return false;
  let playable = raw;
  try {
    playable = polish(raw);
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

