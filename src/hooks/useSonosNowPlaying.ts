import { useState, useEffect, useRef, useCallback } from "react";

// Local proxy URL — set via localStorage("sonosLocalProxy") e.g. "http://192.168.1.100:3000/api/sonos"
function getLocalProxyUrl(): string | null {
  try { return localStorage.getItem("sonosLocalProxy"); } catch { return null; }
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
  source: 'local';
}

export function useSonosNowPlaying() {
  const [data, setData] = useState<SonosNowPlaying | null>(null);
  const [debugLog, setDebugLog] = useState<string>("init");
  const dataRef = useRef<SonosNowPlaying | null>(null);
  const prevArtRef = useRef<string | null>(null);

  // Expose a getter for real-time position reading without requiring React re-render
  const getPosition = useCallback((): { positionMs: number; receivedAt: number } | null => {
    const cur = dataRef.current;
    if (!cur || cur.positionMs == null) return null;
    return { positionMs: cur.positionMs, receivedAt: cur.receivedAt };
  }, []);

  useEffect(() => {
    // Apply new data — always update ref and trigger render
    const apply = (next: SonosNowPlaying) => {
      dataRef.current = next;
      setData(next);
    };

    // RTT smoothing via EMA
    let smoothedRtt = 10;

    const fetchLocal = async () => {
      const proxyUrl = getLocalProxyUrl();
      if (!proxyUrl) { console.warn("[sonos] no sonosLocalProxy in localStorage"); return; }

      try {
        const t0 = performance.now();
        const url = `${proxyUrl}/status`;
        const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1000) });
        const rtt = performance.now() - t0;
        smoothedRtt = smoothedRtt * 0.5 + rtt * 0.5;
        if (!res.ok) { console.warn("[sonos] fetch not ok", res.status); return; }
        const s = await res.json();
        console.log("[sonos] response", s);
        if (!s?.ok || !s.trackName) { console.warn("[sonos] no ok/trackName", s); return; }

        const prev = dataRef.current;
        const isTrackChange = !prev || s.trackName !== prev.trackName;

        // Build album art URL from local proxy if available
        const localArt = s.albumArtUri
          ? (s.albumArtUri.startsWith('http') ? s.albumArtUri : `${proxyUrl}${s.albumArtUri}`)
          : null;

        if (isTrackChange) {
          apply({
            trackName: s.trackName,
            artistName: s.artistName ?? null,
            albumName: s.albumName ?? prev?.albumName ?? null,
            albumArtUrl: localArt,
            playbackState: s.playbackState ?? "PLAYBACK_STATE_PLAYING",
            durationMs: s.durationMillis ?? null,
            positionMs: (s.positionMillis ?? 0) + smoothedRtt / 2,
            receivedAt: performance.now(),
            smoothedRtt,
            nextTrackName: s.nextTrackName ?? null,
            nextArtistName: s.nextArtistName ?? null,
            source: 'local',
          });
          return;
        }

        // Same track — update position + metadata
        apply({
          ...prev!,
          playbackState: s.playbackState ?? prev!.playbackState,
          positionMs: (s.positionMillis ?? prev!.positionMs ?? 0) + smoothedRtt / 2,
          durationMs: s.durationMillis ?? prev!.durationMs,
          albumArtUrl: localArt ?? prev!.albumArtUrl,
          receivedAt: performance.now(),
          smoothedRtt,
          nextTrackName: s.nextTrackName ?? prev!.nextTrackName ?? null,
          nextArtistName: s.nextArtistName ?? prev!.nextArtistName ?? null,
          source: 'local',
        });
      } catch { /* local proxy unavailable — no data */ }
    };

    // Poll at 200ms
    let pollTimer: ReturnType<typeof setTimeout>;
    const schedulePoll = () => {
      pollTimer = setTimeout(async () => {
        await fetchLocal();
        schedulePoll();
      }, 200);
    };
    fetchLocal().then(schedulePoll);

    return () => {
      clearTimeout(pollTimer);
    };
  }, []);

  const artChanged = data?.albumArtUrl !== prevArtRef.current;
  prevArtRef.current = data?.albumArtUrl ?? null;

  return { nowPlaying: data, artChanged, smoothedRtt: data?.smoothedRtt ?? 10, getPosition };
}
