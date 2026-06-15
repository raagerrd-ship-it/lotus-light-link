/**
 * Sonos status poller — fetches now-playing from a Sonos gateway/proxy.
 * Uses SSE (primary) + fallback HTTP poll.
 * 
 * STABILITY FEATURES:
 *   - Consecutive confirmation: state must be consistent for N polls before flip
 *   - Position-based inference: advancing positionMs implies PLAYING
 *   - Staleness guard: no flip to PAUSED if gateway hasn't responded recently
 * 
 * Configurable for any gateway that exposes:
 *   - GET  {baseUrl}/status   → JSON now-playing
 *   - GET  {baseUrl}/events   → SSE stream
 */

import { dlog } from './debugLog.js';

export interface SonosPollerConfig {
  /** Base URL for the Sonos gateway (e.g. "http://localhost:3000/api/sonos") */
  baseUrl: string;
  /** SSE endpoint path appended to baseUrl (default: "/events") */
  ssePath?: string;
  /** Status poll endpoint path appended to baseUrl (default: "/status") */
  statusPath?: string;
  /** Fallback poll interval in ms (default: 2000) */
  pollIntervalMs?: number;
  /** Poll request timeout in ms (default: 4000) */
  pollTimeoutMs?: number;
  /** Disable SSE entirely — poll-only mode (default: false) */
  disableSSE?: boolean;
}

export interface SonosState {
  trackName: string | null;
  artistName: string | null;
  albumArtUrl: string | null;
  playbackState: string;
  volume: number | null;
  positionMs: number | null;
  durationMs: number | null;
  isTvMode: boolean;
  palette: [number, number, number][] | null;
  /** Pre-cached palette för nästa låt — gör att vi kan börja fade direkt vid trackbyte */
  nextPalette: [number, number, number][] | null;
  /** Nästa låt i kön (om gateway skickar) — visas i UI så man ser vad som kommer */
  nextTrackName: string | null;
  nextArtistName: string | null;
}

type Listener = (state: SonosState) => void;

const listeners = new Set<Listener>();
let autoTvModeEnabled = false;

export function setAutoTvMode(enabled: boolean): void {
  autoTvModeEnabled = enabled;
  dlog(`[Sonos] Auto TV-mode: ${enabled ? 'ON' : 'OFF'}`);
  // Re-evaluate immediately so toggling the flag mid-playback flips isTvMode
  // without waiting for a full status update.
  const _tv = enabled && isPlaying(currentState.playbackState ?? '') && !currentState.trackName;
  if (_tv !== currentState.isTvMode) apply({ ...currentState, isTvMode: _tv });
}

export function getAutoTvMode(): boolean {
  return autoTvModeEnabled;
}

let currentState: SonosState = {
  trackName: null,
  artistName: null,
  albumArtUrl: null,
  playbackState: 'PLAYBACK_STATE_IDLE',
  volume: null,
  positionMs: null,
  durationMs: null,
  isTvMode: false,
  palette: null,
  nextPalette: null,
  nextTrackName: null,
  nextArtistName: null,
};

export function getSonosState(): SonosState {
  return currentState;
}

export async function onSonosChange(fn: Listener): Promise<() => void> {
  listeners.add(fn);
  // Race-fix (2026-05-02): den default-IDLE-state som currentState har vid
  // boot kan annars ge subscribern en stale "paused"-bild om den registrerar
  // sig innan första pollen hunnit svara. Hämta fresh status synkront (cap
  // 1500ms) så engine.setPlaying(true) triggas direkt vid boot om Sonos
  // redan spelar. Faller tillbaka på currentState om gateway är slö.
  try {
    const fresh = await Promise.race<any>([
      fetchStatusOnce(),
      new Promise(res => setTimeout(() => res(null), 1500)),
    ]);
    if (fresh) {
      // Apply via parseStatus so listeners-fan-out + heartbeat-bookkeeping
      // körs precis som vid en vanlig poll.
      try { parseStatus(fresh); } catch {}
    }
  } catch {}
  fn(currentState);
  return () => listeners.delete(fn);
}

/** Internal: one-shot status fetch using the active poller config.
 *  Returns parsed JSON or null on any failure. Used by onSonosChange. */
async function fetchStatusOnce(): Promise<any | null> {
  if (!activeConfig) return null;
  const baseUrl = activeConfig.baseUrl.replace(/\/$/, '');
  const statusPath = activeConfig.statusPath ?? DEFAULT_CONFIG.statusPath;
  const timeout = activeConfig.pollTimeoutMs ?? DEFAULT_CONFIG.pollTimeoutMs;
  try {
    const res = await fetch(`${baseUrl}${statusPath}`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Enkel state-tracking — vi litar på gatewayens playbackState rakt av ──

let lastResponseTime = 0; // timestamp of last successful parse

function isPlaying(state: string): boolean {
  return state.includes('PLAYING');
}

function readPlaybackState(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function paletteSig(p: [number, number, number][] | null): string {
  return p ? p.map(c => c.join(',')).join('|') : '';
}

function parsePalette(raw: any): [number, number, number][] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const filtered = raw.filter((c: any) => Array.isArray(c) && c.length >= 3);
  return filtered.length > 0 ? filtered : null;
}

function hasPaletteChanged(next: [number, number, number][] | null, prev: [number, number, number][] | null): boolean {
  if (next === prev) return false;
  if ((next?.length ?? 0) !== (prev?.length ?? 0)) return true;
  return paletteSig(next) !== paletteSig(prev);
}

function apply(next: SonosState): void {
  const significantChanged =
    next.playbackState !== currentState.playbackState ||
    next.trackName !== currentState.trackName ||
    next.volume !== currentState.volume ||
    next.isTvMode !== currentState.isTvMode ||
    next.albumArtUrl !== currentState.albumArtUrl ||
    hasPaletteChanged(next.palette, currentState.palette);
  // Heartbeat (2026-05-02): om engine startat mid-track och missat både
  // initial replay och alla meta-events behöver den ändå få periodiska
  // setPlaying(true)-pings för att kunna recovera (t.ex. starta mic). Vi
  // räknar 10s-bucket-byte på positionMs som heartbeat-trigger.
  const positionHeartbeat =
    next.positionMs != null &&
    currentState.positionMs != null &&
    Math.floor(next.positionMs / 10000) !== Math.floor(currentState.positionMs / 10000);
  currentState = next;
  if (significantChanged || positionHeartbeat) listeners.forEach(fn => fn(next));
}

function parseStatus(s: any): void {
  if (!s?.ok) return;
  lastResponseTime = Date.now();
  staleEmitted = false;

  // ENKEL REGEL: lita på gatewayens playbackState. Inga inferenser från
  // position, tystnad, eller saknad trackName. Är status PLAYING → output på.
  // Är status PAUSED/IDLE → output av. Punkt.
  const reportedPlaybackState = readPlaybackState(s.playbackState);

  // ── Position-tick (high frequency, partial update) ──
  if (s.source === 'position-tick') {
    const _pbs = reportedPlaybackState ?? currentState.playbackState;
    apply({
      ...currentState,
      positionMs: s.positionMillis ?? currentState.positionMs,
      durationMs: s.durationMillis ?? currentState.durationMs,
      volume: s.volume ?? currentState.volume,
      playbackState: _pbs,
      isTvMode: autoTvModeEnabled && isPlaying(_pbs ?? '') && !currentState.trackName,
    });
    return;
  }

  // ── Full status update ──
  // Parse palette from gateway response (array of [r,g,b] tuples).
  // Gateway använder `currentPalette` (aktuell låt) och `nextPalette` (förcache).
  // Vi accepterar även gamla `palette`-fältet som fallback för bakåtkompatibilitet.
  const gwPalette = parsePalette(s.currentPalette) ?? parsePalette(s.palette);
  const gwNextPalette = parsePalette(s.nextPalette);

  // Auto TV-mode: PLAYING + ingen trackName → TV/SPDIF
  const reportedPlaying = isPlaying(reportedPlaybackState ?? '');
  const isTvMode = autoTvModeEnabled && reportedPlaying && !s.trackName;

  // Palette-hantering vid trackbyte:
  //  1. Om gateway redan skickat ny `currentPalette` → använd den.
  //  2. Annars, om vi har `nextPalette` förcachad sedan tidigare → promota den
  //     direkt så fade börjar utan väntetid på extraktion.
  //  3. Annars → null (engine clear:ar och fryser tills något landar).
  const newArtUrl = s.albumArtUri ?? s.albumArtURI ?? s.albumArtUrl ?? null;
  const newTrackName = s.trackName ?? null;
  const trackChanged =
    newArtUrl !== currentState.albumArtUrl ||
    newTrackName !== currentState.trackName;
  const promotedNext = trackChanged && !gwPalette ? currentState.nextPalette : null;
  const nextPaletteForState = gwPalette ?? promotedNext ?? (trackChanged ? null : currentState.palette);

  apply({
    trackName: newTrackName,
    artistName: s.artistName ?? null,
    albumArtUrl: newArtUrl,
    playbackState: reportedPlaybackState ?? currentState.playbackState,
    volume: s.volume ?? currentState.volume,
    positionMs: s.positionMillis ?? null,
    durationMs: s.durationMillis ?? null,
    isTvMode,
    palette: nextPaletteForState,
    // Behåll förcachad nextPalette tills gateway skickar en ny (eller null:ar).
    // Om vi precis promotat den till `palette`, nolla så vi inte återanvänder.
    nextPalette: gwNextPalette ?? (promotedNext ? null : currentState.nextPalette),
    nextTrackName: s.nextTrackName ?? s.nextTrack?.trackName ?? s.nextTrack?.title ?? null,
    nextArtistName: s.nextArtistName ?? s.nextTrack?.artistName ?? s.nextTrack?.artist ?? null,
  });
}

let pollTimer: NodeJS.Timeout | null = null;
let sseCleanup: (() => void) | null = null;
let activeConfig: SonosPollerConfig | null = null;
let lastSuccessfulPollAt: number | null = null;
let staleWatchdogTimer: NodeJS.Timeout | null = null;
let staleEmitted = false;

const STALE_THRESHOLD_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 5_000;

const DEFAULT_CONFIG: Required<Omit<SonosPollerConfig, 'baseUrl'>> = {
  ssePath: '/events',
  statusPath: '/status',
  pollIntervalMs: 2000,
  pollTimeoutMs: 4000,
  disableSSE: false,
};

export async function startSonosPoller(configOrUrl: string | SonosPollerConfig = 'http://localhost:3000/api/sonos'): Promise<void> {
  const cfg: SonosPollerConfig = typeof configOrUrl === 'string'
    ? { baseUrl: configOrUrl }
    : configOrUrl;

  const baseUrl = cfg.baseUrl.replace(/\/$/, '');
  const ssePath = cfg.ssePath ?? DEFAULT_CONFIG.ssePath;
  const statusPath = cfg.statusPath ?? DEFAULT_CONFIG.statusPath;
  const pollMs = cfg.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs;
  const pollTimeout = cfg.pollTimeoutMs ?? DEFAULT_CONFIG.pollTimeoutMs;
  const disableSSE = cfg.disableSSE ?? DEFAULT_CONFIG.disableSSE;

  activeConfig = cfg;

  // Reset response time
  lastResponseTime = 0;


  const statusUrl = `${baseUrl}${statusPath}`;

  // SSE connection (unless disabled). När SSE är ANSLUTEN pausar vi
  // pollTimer för att undvika redundanta parseStatus-anrop var 2:a sekund
  // (sparar CPU + nätverk på Pi Zero 2W). Vid SSE-error startar vi om pollen.
  let sseActive = false;
  let pollInFlight = false;

  const startPollTimer = () => {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const res = await fetch(statusUrl, { signal: AbortSignal.timeout(pollTimeout) });
        if (res.ok) { parseStatus(await res.json()); lastSuccessfulPollAt = Date.now(); }
      } catch {
      } finally {
        pollInFlight = false;
      }
    }, pollMs);
  };

  const stopPollTimer = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  if (!disableSSE) {
    try {
      const mod = await import('eventsource');
      const ESClass = (mod as any).default ?? mod;
      const sseUrl = `${baseUrl}${ssePath}`;
      const es = new ESClass(sseUrl);
      es.onopen = () => {
        if (!sseActive) {
          sseActive = true;
          stopPollTimer();
          dlog(`[Sonos] SSE active — pollTimer paused`);
        }
      };
      es.onmessage = (e: any) => {
        try { parseStatus(JSON.parse(e.data)); } catch {}
      };
      es.onerror = () => {
        if (sseActive) {
          sseActive = false;
          startPollTimer();
          console.warn(`[Sonos] SSE error — pollTimer resumed`);
        }
      };
      sseCleanup = () => es.close();
      dlog(`[Sonos] SSE connecting → ${sseUrl}`);
    } catch {
      dlog('[Sonos] No SSE support, using poll-only mode');
    }
  }

  // Initial status fetch — fire-and-forget så subsystem-start inte blockeras
  // om gateway är otillgänglig. Timer:n picker upp värden vid nästa cykel.
  fetch(statusUrl, { signal: AbortSignal.timeout(pollTimeout) })
    .then(async res => {
      if (res.ok) { parseStatus(await res.json()); lastSuccessfulPollAt = Date.now(); }
    })
    .catch(() => {});

  // Starta pollen som fallback — SSE.onopen pausar den när den ansluter
  startPollTimer();

  // Stale-buddy-detector (FIX 15D): om gateway slutar svara medan vi tror
  // den spelar → emittera syntetisk PAUSED så lifecycle river ner BLE.
  // Bryter WiFi-coex chicken-egg: buddy stale → BLE off → radio fri →
  // WiFi vaknar → buddy fresh igen.
  if (staleWatchdogTimer) clearInterval(staleWatchdogTimer);
  staleWatchdogTimer = setInterval(() => {
    if (staleEmitted) return;
    if (lastResponseTime === 0) return;
    if (!isPlaying(currentState.playbackState)) return;
    const age = Date.now() - lastResponseTime;
    if (age < STALE_THRESHOLD_MS) return;
    console.warn(`[Sonos] Stale state ${age}ms (no fresh poll); emitting synthetic PAUSED`);
    staleEmitted = true;
    apply({ ...currentState, playbackState: 'PLAYBACK_STATE_PAUSED' });
  }, STALE_CHECK_INTERVAL_MS);

  dlog(`[Sonos] Poller started → ${baseUrl} (poll: ${pollMs}ms, SSE: ${disableSSE ? 'off' : ssePath}, mode: trust-gateway-state)`);
}

export function stopSonosPoller(): void {
  sseCleanup?.();
  sseCleanup = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (staleWatchdogTimer) { clearInterval(staleWatchdogTimer); staleWatchdogTimer = null; }
  staleEmitted = false;
  activeConfig = null;
}

export function getPollerConfig(): SonosPollerConfig | null {
  return activeConfig;
}

export function getLastSuccessfulPollAt(): number | null {
  return lastSuccessfulPollAt;
}
