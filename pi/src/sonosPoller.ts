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
}

type Listener = (state: SonosState) => void;

const listeners = new Set<Listener>();
let autoTvModeEnabled = false;

export function setAutoTvMode(enabled: boolean): void {
  autoTvModeEnabled = enabled;
  console.log(`[Sonos] Auto TV-mode: ${enabled ? 'ON' : 'OFF'}`);
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
};

export function getSonosState(): SonosState {
  return currentState;
}

export function onSonosChange(fn: Listener): () => void {
  listeners.add(fn);
  // Replay current state immediately so late subscribers don't miss boot-time PLAYING
  fn(currentState);
  return () => listeners.delete(fn);
}

// ── Stability: consecutive confirmation + position inference ──

/** How many consecutive polls must agree before we flip playback state.
 *  Sänkt från 2 → 1: BLE owner-switch (active→idle) + keep-alive @200ms bär
 *  idle-färgen direkt vid pause, så vi vinner ~2-4s pause-latens utan flicker. */
const CONFIRM_COUNT = 1;
/** Max age (ms) of last successful response before we consider data stale */
const STALE_THRESHOLD_MS = 8000;

let pendingState: string | null = null;   // candidate playback state
let pendingCount = 0;                      // consecutive polls matching candidate
let lastResponseTime = 0;                  // timestamp of last successful parse
let lastPositionMs: number | null = null;  // for position-based inference
let lastPositionTime = 0;                  // when we recorded lastPositionMs
let bootPhase = true;                      // bypass confirmation on first response

function isPlaying(state: string): boolean {
  return state.includes('PLAYING');
}

function readPlaybackState(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Infer playing from position movement: if position advanced >50ms in a reasonable window */
function inferPlayingFromPosition(newPos: number | null): boolean {
  if (newPos == null || lastPositionMs == null) return false;
  const posDelta = newPos - lastPositionMs;
  const timeDelta = Date.now() - lastPositionTime;
  // Position moved forward 50–10000ms within a credible time window
  return posDelta > 50 && posDelta < 10000 && timeDelta > 0 && timeDelta < 6000;
}

function updatePositionTracking(pos: number | null): void {
  if (pos != null) {
    lastPositionMs = pos;
    lastPositionTime = Date.now();
  }
}

function apply(next: SonosState): void {
  const changed =
    next.playbackState !== currentState.playbackState ||
    next.trackName !== currentState.trackName ||
    next.volume !== currentState.volume ||
    next.isTvMode !== currentState.isTvMode ||
    next.albumArtUrl !== currentState.albumArtUrl;
  currentState = next;
  if (changed) listeners.forEach(fn => fn(next));
}

/**
 * Watchdog: om vi inte fått någon status (varken SSE eller poll) på
 * STALE_PLAYING_THRESHOLD_MS OCH currentState säger PLAYING → tvinga PAUSED.
 * Skyddar mot att engine fastnar i PLAYING när Sonos-gateway tappar kontakten,
 * SSE dör eller pause-eventet aldrig nådde fram.
 */
const STALE_PLAYING_THRESHOLD_MS = 10_000;
let watchdogTimer: NodeJS.Timeout | null = null;

function startStaleWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!isPlaying(currentState.playbackState)) return;
    const last = Math.max(lastResponseTime, lastSuccessfulPollAt ?? 0);
    if (last === 0) return;
    const age = Date.now() - last;
    if (age > STALE_PLAYING_THRESHOLD_MS) {
      console.warn(`[Sonos] Watchdog: ingen status på ${(age/1000).toFixed(1)}s i PLAYING — tvingar PAUSED`);
      pendingState = null;
      pendingCount = 0;
      apply({ ...currentState, playbackState: 'PLAYBACK_STATE_PAUSED' });
    }
  }, 2000);
}

function stopStaleWatchdog(): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

/**
 * Confirmed state transition: only flip playbackState after CONFIRM_COUNT
 * consecutive polls agree on the new state. This prevents flicker from
 * transient gateway responses.
 */
function confirmedApply(next: SonosState): void {
  const candidateState = next.playbackState;
  const currentPlayback = currentState.playbackState;

  // Boot phase: first real status → apply immediately
  if (bootPhase) {
    bootPhase = false;
    pendingState = null;
    pendingCount = 0;
    if (candidateState !== currentPlayback) {
      console.log(`[Sonos] Boot: ${currentPlayback} → ${candidateState} (immediate)`);
    }
    apply(next);
    return;
  }

  // Same direction as current → apply immediately
  if (candidateState === currentPlayback) {
    pendingState = null;
    pendingCount = 0;
    apply(next);
    return;
  }

  // PLAYING → apply immediately (no confirmation needed — idle heartbeat keeps lamp safe)
  if (isPlaying(candidateState)) {
    console.log(`[Sonos] ${currentPlayback} → ${candidateState} (immediate)`);
    pendingState = null;
    pendingCount = 0;
    apply(next);
    return;
  }

  // PAUSED/IDLE → require confirmation to avoid flicker
  if (candidateState === pendingState) {
    pendingCount++;
  } else {
    pendingState = candidateState;
    pendingCount = 1;
  }

  if (pendingCount >= CONFIRM_COUNT) {
    console.log(`[Sonos] State confirmed: ${currentPlayback} → ${candidateState} (after ${pendingCount} polls)`);
    pendingState = null;
    pendingCount = 0;
    apply(next);
  } else {
    // Not yet confirmed — apply metadata/volume but keep current playbackState
    apply({ ...next, playbackState: currentPlayback });
  }
}

function parseStatus(s: any): void {
  if (!s?.ok) return;
  lastResponseTime = Date.now();

  // ENKEL REGEL: lita på gatewayens playbackState. Inga inferenser från
  // position, tystnad, eller saknad trackName. Är status PLAYING → output på.
  // Är status PAUSED/IDLE → output av. Punkt.
  const reportedPlaybackState = readPlaybackState(s.playbackState);

  // ── Position-tick (high frequency, partial update) ──
  if (s.source === 'position-tick') {
    apply({
      ...currentState,
      positionMs: s.positionMillis ?? currentState.positionMs,
      durationMs: s.durationMillis ?? currentState.durationMs,
      volume: s.volume ?? currentState.volume,
      playbackState: reportedPlaybackState ?? currentState.playbackState,
    });
    return;
  }

  // ── Full status update ──
  // Parse palette from gateway response (array of [r,g,b] tuples)
  const gwPalette: [number, number, number][] | null =
    Array.isArray(s.palette) && s.palette.length > 0
      ? s.palette.filter((c: any) => Array.isArray(c) && c.length >= 3)
      : null;

  // Auto TV-mode: PLAYING + ingen trackName → TV/SPDIF
  const reportedPlaying = isPlaying(reportedPlaybackState ?? '');
  const isTvMode = autoTvModeEnabled && reportedPlaying && !s.trackName;

  apply({
    trackName: s.trackName ?? null,
    artistName: s.artistName ?? null,
    albumArtUrl: s.albumArtUri ?? s.albumArtURI ?? s.albumArtUrl ?? null,
    playbackState: reportedPlaybackState ?? currentState.playbackState,
    volume: s.volume ?? currentState.volume,
    positionMs: s.positionMillis ?? null,
    durationMs: s.durationMillis ?? null,
    isTvMode,
    palette: gwPalette ?? currentState.palette,
  });
}

let pollTimer: NodeJS.Timeout | null = null;
let sseCleanup: (() => void) | null = null;
let activeConfig: SonosPollerConfig | null = null;
let lastSuccessfulPollAt: number | null = null;

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

  // Reset stability state
  pendingState = null;
  pendingCount = 0;
  lastPositionMs = null;
  lastPositionTime = 0;
  bootPhase = true;

  const statusUrl = `${baseUrl}${statusPath}`;

  // SSE connection (unless disabled). När SSE är ANSLUTEN pausar vi
  // pollTimer för att undvika redundanta parseStatus-anrop var 2:a sekund
  // (sparar CPU + nätverk på Pi Zero 2W). Vid SSE-error startar vi om pollen.
  let sseActive = false;

  const startPollTimer = () => {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(statusUrl, { signal: AbortSignal.timeout(pollTimeout) });
        if (res.ok) { parseStatus(await res.json()); lastSuccessfulPollAt = Date.now(); }
      } catch {}
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
          console.log(`[Sonos] SSE active — pollTimer paused`);
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
      console.log(`[Sonos] SSE connecting → ${sseUrl}`);
    } catch {
      console.log('[Sonos] No SSE support, using poll-only mode');
    }
  }

  // Initial status fetch — bootPhase flag ensures immediate apply
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(pollTimeout) });
    if (res.ok) { parseStatus(await res.json()); lastSuccessfulPollAt = Date.now(); }
  } catch {}

  // Starta pollen som fallback — SSE.onopen pausar den när den ansluter
  startPollTimer();
  startStaleWatchdog();

  console.log(`[Sonos] Poller started → ${baseUrl} (poll: ${pollMs}ms, SSE: ${disableSSE ? 'off' : ssePath}, confirm: ${CONFIRM_COUNT}, stale-watchdog: ${STALE_PLAYING_THRESHOLD_MS}ms)`);
}

export function stopSonosPoller(): void {
  sseCleanup?.();
  sseCleanup = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  stopStaleWatchdog();
  activeConfig = null;
  pendingState = null;
  pendingCount = 0;
}

export function getPollerConfig(): SonosPollerConfig | null {
  return activeConfig;
}

export function getLastSuccessfulPollAt(): number | null {
  return lastSuccessfulPollAt;
}
