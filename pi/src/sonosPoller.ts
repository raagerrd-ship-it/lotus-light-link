/**
 * Sonos status poller — fetches now-playing from a Sonos gateway/proxy.
 * Uses SSE (primary) + fallback HTTP poll.
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
};

export function getSonosState(): SonosState {
  return currentState;
}

export function onSonosChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function apply(next: SonosState): void {
  const changed =
    next.playbackState !== currentState.playbackState ||
    next.trackName !== currentState.trackName ||
    next.volume !== currentState.volume;
  currentState = next;
  if (changed) listeners.forEach(fn => fn(next));
}

function parseStatus(s: any): void {
  if (!s?.ok) return;

  if (s.source === 'position-tick') {
    apply({
      ...currentState,
      positionMs: s.positionMillis ?? currentState.positionMs,
      durationMs: s.durationMillis ?? currentState.durationMs,
      volume: s.volume ?? currentState.volume,
    });
    return;
  }

  if (!s.trackName) {
    const isPlaying = (s.playbackState ?? '').includes('PLAYING');
    if (autoTvModeEnabled && isPlaying) {
      // TV/SPDIF source: no metadata but playing → TV-mode
      apply({
        ...currentState,
        playbackState: s.playbackState ?? 'PLAYBACK_STATE_PLAYING',
        volume: s.volume ?? currentState.volume,
        isTvMode: true,
      });
    } else {
      // No auto-TV or not playing → treat as paused (original behavior)
      if (currentState.playbackState !== 'PLAYBACK_STATE_PAUSED' || currentState.isTvMode) {
        apply({ ...currentState, playbackState: 'PLAYBACK_STATE_PAUSED', isTvMode: false });
      }
    }
    return;
  }

  apply({
    trackName: s.trackName ?? null,
    artistName: s.artistName ?? null,
    albumArtUrl: s.albumArtUri ?? s.albumArtURI ?? s.albumArtUrl ?? null,
    playbackState: s.playbackState ?? 'PLAYBACK_STATE_PLAYING',
    volume: s.volume ?? currentState.volume,
    positionMs: s.positionMillis ?? null,
    durationMs: s.durationMillis ?? null,
    isTvMode: false,
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
  // Accept simple string (backward-compat) or config object
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

  // Fallback poll
  const statusUrl = `${baseUrl}${statusPath}`;
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(statusUrl, { signal: AbortSignal.timeout(pollTimeout) });
      if (res.ok) parseStatus(await res.json());
    } catch {}
  }, pollMs);

  console.log(`[Sonos] Poller started → ${baseUrl} (poll: ${pollMs}ms, SSE: ${disableSSE ? 'off' : ssePath})`);
}

export function stopSonosPoller(): void {
  sseCleanup?.();
  sseCleanup = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  activeConfig = null;
}

export function getPollerConfig(): SonosPollerConfig | null {
  return activeConfig;
}
