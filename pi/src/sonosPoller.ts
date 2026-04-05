/**
 * Sonos status poller — fetches now-playing from Cast Away bridge.
 * Uses SSE (primary) + fallback HTTP poll, same logic as the React hook.
 */

// EventSource polyfill for Node
import { EventSource } from 'eventsource' as any;

export interface SonosState {
  trackName: string | null;
  artistName: string | null;
  albumArtUrl: string | null;
  playbackState: string;
  volume: number | null;
  positionMs: number | null;
  durationMs: number | null;
}

type Listener = (state: SonosState) => void;

const listeners = new Set<Listener>();
let currentState: SonosState = {
  trackName: null,
  artistName: null,
  albumArtUrl: null,
  playbackState: 'PLAYBACK_STATE_IDLE',
  volume: null,
  positionMs: null,
  durationMs: null,
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

  // Position-tick: only update position
  if (s.source === 'position-tick') {
    apply({
      ...currentState,
      positionMs: s.positionMillis ?? currentState.positionMs,
      durationMs: s.durationMillis ?? currentState.durationMs,
      volume: s.volume ?? currentState.volume,
    });
    return;
  }

  // No track = TV/idle
  if (!s.trackName) {
    if (currentState.playbackState !== 'PLAYBACK_STATE_PAUSED') {
      apply({ ...currentState, playbackState: 'PLAYBACK_STATE_PAUSED' });
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
  });
}

let es: any = null;
let pollTimer: NodeJS.Timeout | null = null;

export function startSonosPoller(bridgeUrl = 'http://localhost:3000/api/sonos'): void {
  // SSE connection
  const connectSSE = () => {
    try {
      es = new EventSource(`${bridgeUrl}/events`);
      es.onmessage = (e: any) => {
        try { parseStatus(JSON.parse(e.data)); } catch {}
      };
      es.onerror = () => {
        // EventSource auto-reconnects
      };
    } catch (err: any) {
      console.error('[Sonos] SSE connect failed:', err.message);
    }
  };

  connectSSE();

  // Fallback poll every 2s
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${bridgeUrl}/status`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) parseStatus(await res.json());
    } catch {}
  }, 2000);

  console.log(`[Sonos] Poller started → ${bridgeUrl}`);
}

export function stopSonosPoller(): void {
  if (es) { es.close(); es = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
