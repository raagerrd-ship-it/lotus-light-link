import { useState, useEffect, useRef, useCallback } from "react";

// Local proxy URL — auto-fallback to localhost if localStorage key is missing
const DEFAULT_LOCAL_PROXY_URL = "http://localhost:3000/api/sonos";

function normalizeProxyUrl(url: string): string {
  return url.trim().replace(/\/status\/?$/, "").replace(/\/$/, "");
}

function getLocalProxyUrl(): string {
  try {
    const stored = localStorage.getItem("sonosLocalProxy");
    const normalized = normalizeProxyUrl(stored || DEFAULT_LOCAL_PROXY_URL);
    if (!stored) localStorage.setItem("sonosLocalProxy", normalized);
    return normalized;
  } catch {
    return normalizeProxyUrl(DEFAULT_LOCAL_PROXY_URL);
  }
}

export interface SonosNowPlaying {
  trackName: string | null;
  artistName: string | null;
  albumName: string | null;
  albumArtUrl: string | null;
  playbackState: string;
  durationMs: number | null;
  positionMs: number | null;
  receivedAt: number;
  smoothedRtt: number;
  nextTrackName: string | null;
  nextArtistName: string | null;
  nextAlbumArtUrl: string | null;
  mediaType: 'radio' | 'track' | null;
  volume: number | null;
  source: 'local';
  isTvMode: boolean;
}

export function useSonosNowPlaying() {
  const [data, setData] = useState<SonosNowPlaying | null>(null);
  const dataRef = useRef<SonosNowPlaying | null>(null);
  const prevArtRef = useRef<string | null>(null);

  const getPosition = useCallback((): { positionMs: number; receivedAt: number } | null => {
    const cur = dataRef.current;
    if (!cur || cur.positionMs == null) return null;
    return { positionMs: cur.positionMs, receivedAt: cur.receivedAt };
  }, []);

  useEffect(() => {
    const proxyUrl = getLocalProxyUrl();

    const apply = (next: SonosNowPlaying) => {
      dataRef.current = next;
      setData(next);
    };

    let smoothedRtt = 10;

    // Decode XML entities that may leak from DIDL parsing
    const decodeEntities = (s: string | null | undefined): string | null => {
      if (!s) return null;
      return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    };

    // Build art URL from Cast Away payloads (supports multiple field/key variants)
    const resolveAlbumArtUri = (s: any): string | null => {
      const nested = s?.currentTrack ?? s?.track ?? s?.mediaInfo ?? s?.metadata ?? null;
      return (
        s?.albumArtUri ??
        s?.albumArtURI ??
        s?.albumArtUrl ??
        s?.album_art_uri ??
        nested?.albumArtUri ??
        nested?.albumArtURI ??
        nested?.albumArtUrl ??
        nested?.album_art_uri ??
        null
      );
    };

    const buildArtUrl = (uriRaw: string | null | undefined): string | null => {
      if (!uriRaw) return null;
      const uri = decodeEntities(String(uriRaw).trim()) ?? '';
      if (!uri) return null;

      if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;

      const proxyOrigin = new URL(proxyUrl).origin;

      // Keep proxy host intact (especially localhost), otherwise album art can break
      // and palette extraction fails due inaccessible/tainted URLs.
      if (uri.startsWith('/api/sonos/')) return `${proxyOrigin}${uri}`;
      if (uri.startsWith('/getaa')) return `${proxyUrl}${uri}`;
      if (uri.startsWith('getaa')) return `${proxyUrl}/${uri}`;
      if (uri.startsWith('/')) return `${proxyOrigin}${uri}`;
      return `${proxyUrl}/${uri}`;
    };

    const applyStatus = (s: any, rtt: number) => {
      if (!s?.ok) return;

      // Position-tick payloads (source='position-tick') carry no trackName/playbackState
      // — merge them into existing state without triggering TV/idle detection
      // If position is advancing, infer PLAYING (catches missed UPnP play events)
      if (s.source === 'position-tick') {
        const prev = dataRef.current;
        if (!prev) return;
        const newPos = s.positionMillis != null ? (s.positionMillis + rtt / 2) : prev.positionMs;
        const posAdvancing = newPos != null && prev.positionMs != null && newPos > prev.positionMs + 50;
        const inferredState = posAdvancing && prev.playbackState !== 'PLAYBACK_STATE_PLAYING'
          ? 'PLAYBACK_STATE_PLAYING'
          : prev.playbackState;
        apply({
          ...prev,
          playbackState: inferredState,
          positionMs: newPos,
          durationMs: s.durationMillis ?? prev.durationMs,
          volume: s.volume ?? prev.volume,
          receivedAt: performance.now(),
          smoothedRtt: rtt,
          mediaType: s.mediaType === 'radio' ? 'radio' : s.mediaType === 'track' ? 'track' : prev.mediaType,
        });
        return;
      }

      // No trackName — check for TV-mode (PLAYING + no metadata)
      if (!s.trackName) {
        const isPlaying = (s.playbackState ?? '').includes('PLAYING');
        const autoTv = localStorage.getItem('auto-tv-mode') === 'true';
        
        if (autoTv && isPlaying) {
          // TV-mode: keep PLAYING state, set isTvMode
          const prev = dataRef.current;
          apply({
            trackName: null,
            artistName: null,
            albumName: null,
            albumArtUrl: null,
            playbackState: s.playbackState ?? 'PLAYBACK_STATE_PLAYING',
            durationMs: null,
            positionMs: null,
            receivedAt: performance.now(),
            smoothedRtt: rtt,
            nextTrackName: null,
            nextArtistName: null,
            nextAlbumArtUrl: null,
            mediaType: null,
            volume: s.volume ?? prev?.volume ?? null,
            source: 'local',
            isTvMode: true,
          });
        } else {
          // Original behavior: force PAUSED
          const forcedState = 'PLAYBACK_STATE_PAUSED';
          const prev = dataRef.current;
          if (prev && (prev.playbackState !== forcedState || prev.isTvMode)) {
            apply({
              ...prev,
              playbackState: forcedState,
              volume: s.volume ?? prev.volume,
              receivedAt: performance.now(),
              smoothedRtt: rtt,
              isTvMode: false,
            });
          }
        }
        return;
      }

      const prev = dataRef.current;
      const isTrackChange = !prev || s.trackName !== prev.trackName;
      const localArt = buildArtUrl(resolveAlbumArtUri(s));

      // Resolve next track art URL from proxy payload
      const nextArtRaw = s?.nextAlbumArtUri ?? s?.nextAlbumArtURI ?? s?.nextAlbumArtUrl ?? s?.next_album_art_uri ?? null;
      const nextArt = buildArtUrl(nextArtRaw);

      if (isTrackChange) {
        apply({
          trackName: decodeEntities(s.trackName),
          artistName: decodeEntities(s.artistName),
          albumName: decodeEntities(s.albumName) ?? prev?.albumName ?? null,
          albumArtUrl: localArt,
          playbackState: s.playbackState ?? "PLAYBACK_STATE_PLAYING",
          durationMs: s.durationMillis ?? null,
          positionMs: (s.positionMillis ?? 0) + rtt / 2,
          receivedAt: performance.now(),
          smoothedRtt: rtt,
          nextTrackName: decodeEntities(s.nextTrackName),
          nextArtistName: decodeEntities(s.nextArtistName),
          nextAlbumArtUrl: nextArt,
          mediaType: s.mediaType === 'radio' ? 'radio' : s.mediaType === 'track' ? 'track' : null,
          volume: s.volume ?? prev?.volume ?? null,
          source: 'local',
          isTvMode: false,
        });
        return;
      }

      // For non-track-change updates: interpolate position if not provided
      const prevPos = prev!.positionMs ?? 0;
      const timeSinceLastUpdate = performance.now() - prev!.receivedAt;
      const hasNewPosition = s.positionMillis != null;
      const interpolatedPos = hasNewPosition
        ? (s.positionMillis + rtt / 2)
        : (prevPos + timeSinceLastUpdate);

      apply({
        ...prev!,
        playbackState: s.playbackState ?? prev!.playbackState,
        positionMs: interpolatedPos,
        durationMs: s.durationMillis ?? prev!.durationMs,
        albumArtUrl: localArt ?? prev!.albumArtUrl,
        receivedAt: performance.now(),
        smoothedRtt: rtt,
        nextTrackName: decodeEntities(s.nextTrackName) ?? prev!.nextTrackName ?? null,
        nextArtistName: decodeEntities(s.nextArtistName) ?? prev!.nextArtistName ?? null,
        nextAlbumArtUrl: nextArt ?? prev!.nextAlbumArtUrl ?? null,
        mediaType: s.mediaType === 'radio' ? 'radio' : s.mediaType === 'track' ? 'track' : prev!.mediaType ?? null,
        volume: s.volume ?? prev!.volume ?? null,
        source: 'local',
        isTvMode: false,
      });
    };

    // --- SSE connection (primary) ---
    let es: EventSource | null = null;
    let sseAlive = false;
    let lastSseMessage = Date.now();

    const connectSSE = () => {
      es = new EventSource(`${proxyUrl}/events`);
      es.onmessage = (e) => {
        sseAlive = true;
        lastSseMessage = Date.now();
        try {
          const s = JSON.parse(e.data);
          // SSE has ~0 RTT since it's push-based
          applyStatus(s, 2);
        } catch { /* ignore parse errors */ }
      };
      es.onerror = () => {
        sseAlive = false;
        // EventSource auto-reconnects
      };
    };

    connectSSE();

    // --- Fallback poll every 5s to catch missed state changes (pause/stop) ---
    const pollStatus = async () => {
      try {
        const t0 = performance.now();
        const res = await fetch(`${proxyUrl}/status`, { signal: AbortSignal.timeout(4000) });
        const rtt = performance.now() - t0;
        smoothedRtt = smoothedRtt * 0.7 + rtt * 0.3;
        if (res.ok) {
          const s = await res.json();
          applyStatus(s, smoothedRtt);
        }
      } catch { /* ignore poll errors */ }
    };

    // Always poll /status every 5s to catch missed state changes (play/pause)
    // Position-ticks via SSE don't carry playbackState, so SSE alone can't fix stale state
    const pollId = setInterval(pollStatus, 2000);

    return () => {
      if (es) { es.close(); es = null; }
      clearInterval(pollId);
    };
  }, []);

  const artChanged = data?.albumArtUrl !== prevArtRef.current;
  prevArtRef.current = data?.albumArtUrl ?? null;

  return { nowPlaying: data, artChanged, smoothedRtt: data?.smoothedRtt ?? 10, getPosition };
}
