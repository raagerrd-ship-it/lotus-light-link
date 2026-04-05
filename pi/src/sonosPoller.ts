/**
 * Sonos status poller — fetches now-playing from Cast Away bridge.
 * Uses SSE (primary) + fallback HTTP poll, same logic as the React hook.
 */

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

let pollTimer: NodeJS.Timeout | null = null;
let sseCleanup: (() => void) | null = null;

export async function startSonosPoller(bridgeUrl = 'http://localhost:3000/api/sonos'): Promise<void> {
  // Try SSE via eventsource package (optional dep)
  try {
    const mod = await import('eventsource');
    const ESClass = (mod as any).default ?? mod;
    const es = new ESClass(`${bridgeUrl}/events`);
    es.onmessage = (e: any) => {
      try { parseStatus(JSON.parse(e.data)); } catch {}
    };
    es.onerror = () => {}; // auto-reconnects
    sseCleanup = () => es.close();
    console.log(`[Sonos] SSE connected → ${bridgeUrl}/events`);
  } catch {
    console.log('[Sonos] No SSE support, using poll-only mode');
  }

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
  sseCleanup?.();
  sseCleanup = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
