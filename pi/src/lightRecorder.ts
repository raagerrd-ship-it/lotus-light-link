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


function ensureDir(): void {
  if (!existsSync(SEQ_DIR)) mkdirSync(SEQ_DIR, { recursive: true });
}

function seqPath(key: string): string {
  return join(SEQ_DIR, `${key}.json`);
}

function loadSequence(key: string): number[][] | null {
  try {
    const raw = readFileSync(seqPath(key), 'utf-8');
    const parsed = JSON.parse(raw);
    const frames = parsed?.frames;
    return Array.isArray(frames) && frames.length > 0 ? frames : null;
  } catch {
    return null;
  }
}

function finalizeRecording(): void {
  if (!recording || !currentKey || buffer.length < MIN_FRAMES_TO_SAVE) {
    buffer = [];
    return;
  }
  try {
    ensureDir();
    const existing = loadSequence(currentKey);
    // Skriv bara om vi inte har en sekvens, eller om den nya är minst lika komplett.
    if (!existing || buffer.length >= existing.length) {
      const payload = {
        key: currentKey,
        durationMs: buffer[buffer.length - 1][0],
        frames: buffer,
        updatedAt: Date.now(),
      };
      writeFileSync(seqPath(currentKey), JSON.stringify(payload), 'utf-8');
      console.log(`[lightRecorder] Sparade sekvens "${currentKey}" (${buffer.length} frames)`);
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

/** Anropas vid varje Sonos-uppdatering från index.ts. */
export function onSonosUpdate(state: {
  trackName: string | null;
  artistName: string | null;
  playbackState: string;
  positionMs: number | null;
  isTvMode: boolean;
}): void {
  if (!engine) return;

  // Ankra position löpande (för både inspelning och uppspelning).
  if (state.positionMs != null) {
    posAnchorMs = state.positionMs;
    posAnchorClock = Date.now();
    if (pbActive) engine.updatePlaybackPosition(state.positionMs);
  }

  const playing = state.playbackState === 'PLAYING' && !state.isTvMode;
  const key = playing ? songKeyFromSonos(state.trackName, state.artistName) : null;

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

  // Låtbyte: avsluta gammal inspelning, sätt upp nya läget.
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

export function getRecorderState(): { recording: boolean; autoPlay: boolean; currentKey: string | null; playingBack: boolean } {
  return { recording, autoPlay, currentKey, playingBack: pbActive };
}

export function listSequences(): Array<{ key: string; frames: number; durationMs: number; updatedAt: number }> {
  try {
    ensureDir();
    return readdirSync(SEQ_DIR)
      .filter((f) => f.endsWith('.json'))
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
    if (key === currentKey) {
      pbActive = false;
      engine?.setPlaybackSequence(null);
    }
    return true;
  } catch {
    return false;
  }
}
