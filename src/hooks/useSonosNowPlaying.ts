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
  volume: number | null;
  source: 'local';
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
      return s?.albumArtUri ?? s?.albumArtURI ?? s?.albumArtUrl ?? s?.album_art_uri ?? null;
    };

    const buildArtUrl = (uriRaw: string | null | undefined): string | null => {
      if (!uriRaw) return null;
      const uri = decodeEntities(String(uriRaw).trim()) ?? '';
      if (!uri) return null;

      if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;

      const proxyOrigin = new URL(proxyUrl).origin;
      // Replace localhost/127.0.0.1 with the actual LAN hostname so other devices can reach it
      const lanOrigin = (proxyOrigin.includes('localhost') || proxyOrigin.includes('127.0.0.1'))
        ? proxyOrigin.replace(/localhost|127\.0\.0\.1/, location.hostname)
        : proxyOrigin;
      const lanProxy = proxyUrl.replace(proxyOrigin, lanOrigin);

      if (uri.startsWith('/api/sonos/')) return `${lanOrigin}${uri}`;
      if (uri.startsWith('/getaa')) return `${lanProxy}${uri}`;
      if (uri.startsWith('getaa')) return `${lanProxy}/${uri}`;
      if (uri.startsWith('/')) return `${lanOrigin}${uri}`;
      return `${lanProxy}/${uri}`;
    };

    const applyStatus = (s: any, rtt: number) => {
      if (!s?.ok || !s.trackName) return;

      const prev = dataRef.current;
      const isTrackChange = !prev || s.trackName !== prev.trackName;
      const localArt = buildArtUrl(resolveAlbumArtUri(s));

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
          volume: s.volume ?? prev?.volume ?? null,
          source: 'local',
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
        volume: s.volume ?? prev!.volume ?? null,
        source: 'local',
      });
    };

    // --- SSE connection (primary) ---
    let es: EventSource | null = null;
    let sseAlive = false;

    const connectSSE = () => {
      es = new EventSource(`${proxyUrl}/events`);
      es.onmessage = (e) => {
        sseAlive = true;
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

    return () => {
      if (es) { es.close(); es = null; }
    };
  }, []);

  const artChanged = data?.albumArtUrl !== prevArtRef.current;
  prevArtRef.current = data?.albumArtUrl ?? null;

  return { nowPlaying: data, artChanged, smoothedRtt: data?.smoothedRtt ?? 10, getPosition };
}
