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
  return () => listeners.delete(fn);
}

// ── Stability: consecutive confirmation + position inference ──

/** How many consecutive polls must agree before we flip playback state */
const CONFIRM_COUNT = 2;
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
    next.isTvMode !== currentState.isTvMode;
  currentState = next;
  if (changed) listeners.forEach(fn => fn(next));
}

/**
 * Confirmed state transition: only flip playbackState after CONFIRM_COUNT
 * consecutive polls agree on the new state. This prevents flicker from
 * transient gateway responses.
 */
function confirmedApply(next: SonosState): void {
  const candidateState = next.playbackState;
  const currentPlayback = currentState.playbackState;

  // Boot phase: first real status → apply immediately (no waiting for confirmation)
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

  // Same direction as current → apply immediately (no flip)
  if (candidateState === currentPlayback) {
    pendingState = null;
    pendingCount = 0;
    apply(next);
    return;
  }

  // Different state → accumulate confirmation
  if (candidateState === pendingState) {
    pendingCount++;
  } else {
    pendingState = candidateState;
    pendingCount = 1;
  }

  if (pendingCount >= CONFIRM_COUNT) {
    // Confirmed! Flip state
    console.log(`[Sonos] State confirmed: ${currentPlayback} → ${candidateState} (after ${pendingCount} polls)`);
    pendingState = null;
    pendingCount = 0;
    apply(next);
  } else {
    // Not yet confirmed — apply metadata/volume updates but keep current playbackState
    apply({ ...next, playbackState: currentPlayback });
  }
}

function parseStatus(s: any): void {
  if (!s?.ok) return;
  lastResponseTime = Date.now();

  // ── Position-tick (high frequency, partial update) ──
  if (s.source === 'position-tick') {
    const newPos = s.positionMillis ?? currentState.positionMs;
    
    // Position-based inference: if position is advancing, confirm PLAYING
    const positionImpliesPlaying = inferPlayingFromPosition(newPos);
    updatePositionTracking(newPos);
    
    let playbackState = currentState.playbackState;
    if (positionImpliesPlaying && !isPlaying(playbackState)) {
      // Position moving → override to PLAYING (self-healing)
      console.log('[Sonos] Position advancing → infer PLAYING');
      playbackState = 'PLAYBACK_STATE_PLAYING';
      pendingState = null;
      pendingCount = 0;
    }

    apply({
      ...currentState,
      positionMs: newPos,
      durationMs: s.durationMillis ?? currentState.durationMs,
      volume: s.volume ?? currentState.volume,
      playbackState,
    });
    return;
  }

  // ── Full status update ──
  updatePositionTracking(s.positionMillis ?? null);

  if (!s.trackName) {
    const reportedPlaying = isPlaying(s.playbackState ?? '');
    if (autoTvModeEnabled && reportedPlaying) {
      // TV/SPDIF source: no metadata but playing → TV-mode
      confirmedApply({
        ...currentState,
        playbackState: s.playbackState ?? 'PLAYBACK_STATE_PLAYING',
        volume: s.volume ?? currentState.volume,
        isTvMode: true,
      });
    } else {
      // No track + not playing → PAUSED, but only with staleness guard
      const isStale = (Date.now() - lastResponseTime) > STALE_THRESHOLD_MS;
      if (!isStale) {
        confirmedApply({ 
          ...currentState, 
          playbackState: 'PLAYBACK_STATE_PAUSED', 
          isTvMode: false 
        });
      }
    }
    return;
  }

  // Parse palette from gateway response (array of [r,g,b] tuples)
  const gwPalette: [number, number, number][] | null =
    Array.isArray(s.palette) && s.palette.length > 0
      ? s.palette.filter((c: any) => Array.isArray(c) && c.length >= 3)
      : null;

  confirmedApply({
    trackName: s.trackName ?? null,
    artistName: s.artistName ?? null,
    albumArtUrl: s.albumArtUri ?? s.albumArtURI ?? s.albumArtUrl ?? null,
    playbackState: s.playbackState ?? 'PLAYBACK_STATE_PLAYING',
    volume: s.volume ?? currentState.volume,
    positionMs: s.positionMillis ?? null,
    durationMs: s.durationMillis ?? null,
    isTvMode: false,
    palette: gwPalette ?? currentState.palette,
  });
}

let pollTimer: NodeJS.Timeout | null = null;
let sseCleanup: (() => void) | null = null;
let activeConfig: SonosPollerConfig | null = null;

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

  // SSE connection (unless disabled)
  if (!disableSSE) {
    try {
      const mod = await import('eventsource');
      const ESClass = (mod as any).default ?? mod;
      const sseUrl = `${baseUrl}${ssePath}`;
      const es = new ESClass(sseUrl);
      es.onmessage = (e: any) => {
        try { parseStatus(JSON.parse(e.data)); } catch {}
      };
      es.onerror = () => {}; // auto-reconnects
      sseCleanup = () => es.close();
      console.log(`[Sonos] SSE connected → ${sseUrl}`);
    } catch {
      console.log('[Sonos] No SSE support, using poll-only mode');
    }
  }

  // Initial status fetch — bootPhase flag ensures immediate apply
  const statusUrl = `${baseUrl}${statusPath}`;
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(pollTimeout) });
    if (res.ok) parseStatus(await res.json());
  } catch {}

  // Fallback poll
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(statusUrl, { signal: AbortSignal.timeout(pollTimeout) });
      if (res.ok) parseStatus(await res.json());
    } catch {}
  }, pollMs);

  console.log(`[Sonos] Poller started → ${baseUrl} (poll: ${pollMs}ms, SSE: ${disableSSE ? 'off' : ssePath}, confirm: ${CONFIRM_COUNT})`);
}

export function stopSonosPoller(): void {
  sseCleanup?.();
  sseCleanup = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  activeConfig = null;
  pendingState = null;
  pendingCount = 0;
}

export function getPollerConfig(): SonosPollerConfig | null {
  return activeConfig;
}
