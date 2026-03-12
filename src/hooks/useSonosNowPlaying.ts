import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const BREW_URL = "https://plwchuzidrjgyuepwdcl.supabase.co";
const BREW_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsd2NodXppZHJqZ3l1ZXB3ZGNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk0ODUyOTIsImV4cCI6MjA3NTA2MTI5Mn0.p9giTnFOK-b0NqrB4ZqN-3CJEaAqMNy-KYvRZ6P_qS0";

const brewSupabase = createClient(BREW_URL, BREW_ANON, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

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
  source: 'local' | 'cloud';
}

export function useSonosNowPlaying() {
  const [data, setData] = useState<SonosNowPlaying | null>(null);
  const dataRef = useRef<SonosNowPlaying | null>(null);
  const prevArtRef = useRef<string | null>(null);

  useEffect(() => {
    // Apply new data with drift protection — avoid small position jumps on same track
    // Tighter threshold for local proxy (2s) vs cloud (5s)
    const apply = (next: SonosNowPlaying) => {
      const prev = dataRef.current;
      if (
        prev &&
        prev.trackName === next.trackName &&
        prev.artistName === next.artistName &&
        prev.positionMs != null &&
        next.positionMs != null
      ) {
        const estimated = prev.positionMs + (performance.now() - prev.receivedAt);
        const driftThreshold = next.source === 'local' ? 2000 : 5000;
        if (Math.abs(next.positionMs - estimated) < driftThreshold) return;
      }
      dataRef.current = next;
      setData(next);
    };

    // Fetch full metadata from DB (album art, etc)
    const fetchDb = async () => {
      const { data: rows } = await brewSupabase
        .from("sonos_now_playing")
        .select("track_name, artist_name, album_name, album_art_url, playback_state, duration_ms, position_ms, updated_at")
        .order("updated_at", { ascending: false })
        .limit(1);

      if (!rows?.length) { dataRef.current = null; setData(null); return; }
      const row = rows[0];

      const prev = dataRef.current;

      // Guard: if API already set a newer track, don't overwrite with stale DB data
      if (prev && row.track_name && prev.trackName && row.track_name !== prev.trackName) {
        return;
      }

      // Compensate position for time since DB write, capped to duration
      const dbAge = row.updated_at ? Date.now() - new Date(row.updated_at).getTime() : 0;
      const rawPos = row.playback_state === "PLAYBACK_STATE_PLAYING"
        ? (row.position_ms ?? 0) + Math.max(0, Math.min(dbAge, 10000))
        : (row.position_ms ?? 0);
      const pos = row.duration_ms ? Math.min(row.duration_ms, rawPos) : rawPos;

      apply({
        trackName: row.track_name,
        artistName: row.artist_name,
        albumName: row.album_name,
        albumArtUrl: row.album_art_url,
        playbackState: row.playback_state,
        durationMs: row.duration_ms,
        positionMs: pos,
        receivedAt: performance.now(),
        smoothedRtt: prev?.smoothedRtt ?? 0,
        nextTrackName: prev?.nextTrackName ?? null,
        nextArtistName: prev?.nextArtistName ?? null,
        source: 'cloud',
      });
    };

    // RTT smoothing via EMA
    let smoothedRtt = 150;
    let localProxyAvailable = !!getLocalProxyUrl();
    let localFailCount = 0;
    const MAX_LOCAL_FAILS = 3; // Fall back to cloud after N consecutive failures

    // ─── Local UPnP proxy fetch (ultra-low latency) ───
    const fetchLocal = async (): Promise<boolean> => {
      const proxyUrl = getLocalProxyUrl();
      if (!proxyUrl) return false;

      try {
        const t0 = performance.now();
        const res = await fetch(`${proxyUrl}/status`, { cache: "no-store", signal: AbortSignal.timeout(1000) });
        const rtt = performance.now() - t0;
        smoothedRtt = smoothedRtt * 0.5 + rtt * 0.5; // faster convergence for local
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = await res.json();
        if (!s?.ok || !s.trackName) return false;

        localFailCount = 0;
        localProxyAvailable = true;

        const prev = dataRef.current;
        const isTrackChange = !prev || s.trackName !== prev.trackName;

        if (isTrackChange) {
          // Build album art URL from local proxy if available
          const localArt = s.albumArtUri
            ? (s.albumArtUri.startsWith('http') ? s.albumArtUri : `${proxyUrl}${s.albumArtUri}`)
            : null;

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

          // Only fetch DB if local proxy didn't provide album art
          if (!localArt) {
            const tryFetchDb = (attempt: number) => {
              setTimeout(async () => {
                await fetchDb();
                if (!dataRef.current?.albumArtUrl && attempt < 2) tryFetchDb(attempt + 1);
              }, attempt === 0 ? 800 : 2000);
            };
            tryFetchDb(0);
          }
          // Only fetch cloud if local proxy didn't provide next track
          if (!s.nextTrackName) {
            fetchCloud();
          }
          return true;
        }

        // Same track — update position + next track metadata
        apply({
          ...prev!,
          playbackState: s.playbackState ?? prev!.playbackState,
          positionMs: (s.positionMillis ?? prev!.positionMs ?? 0) + smoothedRtt / 2,
          durationMs: s.durationMillis ?? prev!.durationMs,
          receivedAt: performance.now(),
          smoothedRtt,
          nextTrackName: s.nextTrackName ?? prev!.nextTrackName ?? null,
          nextArtistName: s.nextArtistName ?? prev!.nextArtistName ?? null,
          source: 'local',
        });
        return true;
      } catch {
        localFailCount++;
        if (localFailCount >= MAX_LOCAL_FAILS) {
          localProxyAvailable = false;
        }
        return false;
      }
    };

    // ─── Cloud API fetch (fallback) ───
    const fetchCloud = async () => {
      try {
        const t0 = performance.now();
        const res = await fetch(`${BREW_URL}/functions/v1/sonos-playback-status`, {
          headers: { Authorization: `Bearer ${BREW_ANON}`, apikey: BREW_ANON, "Content-Type": "application/json" },
          cache: "no-store",
        });
        const rtt = performance.now() - t0;
        if (!localProxyAvailable) {
          smoothedRtt = smoothedRtt * 0.7 + rtt * 0.3;
        }
        if (!res.ok) return;
        const s = await res.json();
        if (!s?.ok || !s.trackName) return;

        const prev = dataRef.current;
        const isTrackChange = !prev || s.trackName !== prev.trackName;

        if (isTrackChange) {
          apply({
            trackName: s.trackName,
            artistName: s.artistName ?? null,
            albumName: s.albumName ?? prev?.albumName ?? null,
            albumArtUrl: null,
            playbackState: s.playbackState ?? "PLAYBACK_STATE_PLAYING",
            durationMs: s.durationMillis ?? null,
            positionMs: (s.positionMillis ?? 0) + smoothedRtt / 2,
            receivedAt: performance.now(),
            smoothedRtt,
            nextTrackName: s.nextTrackName ?? null,
            nextArtistName: s.nextArtistName ?? null,
            source: 'cloud',
          });
          const tryFetchDb = (attempt: number) => {
            setTimeout(async () => {
              await fetchDb();
              if (!dataRef.current?.albumArtUrl && attempt < 2) tryFetchDb(attempt + 1);
            }, attempt === 0 ? 800 : 2000);
          };
          tryFetchDb(0);
          return;
        }

        // Same track — update position (only if using cloud source or updating next track)
        if (!localProxyAvailable || !prev?.source || prev.source === 'cloud') {
          apply({
            ...prev!,
            playbackState: s.playbackState ?? prev!.playbackState,
            positionMs: (s.positionMillis ?? prev!.positionMs ?? 0) + smoothedRtt / 2,
            durationMs: s.durationMillis ?? prev!.durationMs,
            receivedAt: performance.now(),
            smoothedRtt,
            nextTrackName: s.nextTrackName ?? prev!.nextTrackName ?? null,
            nextArtistName: s.nextArtistName ?? prev!.nextArtistName ?? null,
            source: 'cloud',
          });
        } else {
          // Local is active for position — only update next track metadata from cloud
          if (s.nextTrackName && prev) {
            dataRef.current = { ...prev, nextTrackName: s.nextTrackName, nextArtistName: s.nextArtistName ?? null };
            setData(dataRef.current);
          }
        }
      } catch { /* network error — ignore */ }
    };

    // ─── Combined poll: try local first, fall back to cloud ───
    const poll = async () => {
      if (localProxyAvailable || getLocalProxyUrl()) {
        const localOk = await fetchLocal();
        if (localOk) return;
      }
      await fetchCloud();
    };

    // Initial load from DB
    fetchDb();

    // Realtime subscription — fetch DB on any change
    const channel = brewSupabase
      .channel("sonos-np")
      .on("postgres_changes" as any, { event: "*", schema: "public", table: "sonos_now_playing" }, fetchDb)
      .subscribe();

    // Ultra-fast local poll (200ms) or cloud fallback (1.5s)
    let pollTimer: ReturnType<typeof setTimeout>;
    const schedulePoll = () => {
      const interval = localProxyAvailable ? 200 : 1500;
      pollTimer = setTimeout(async () => {
        await poll();
        schedulePoll();
      }, interval);
    };
    // Initial poll
    poll().then(schedulePoll);

    // Predictive track change: when near end of track, pre-fetch cloud metadata
    const predictiveTimer = setInterval(() => {
      const cur = dataRef.current;
      if (cur && cur.durationMs && cur.positionMs != null && !cur.nextTrackName) {
        const remaining = cur.durationMs - (cur.positionMs + (performance.now() - cur.receivedAt));
        if (remaining > 0 && remaining < 15000) {
          fetchCloud(); // pre-fetch next track metadata before track ends
        }
      }
    }, 3000);

    // Cloud metadata refresh every 5s when local is active (for next track info)
    // Cloud metadata refresh only when local proxy lacks next track info
    const cloudMetaTimer = setInterval(() => {
      if (localProxyAvailable && !dataRef.current?.nextTrackName) fetchCloud();
    }, 5000);

    return () => {
      channel.unsubscribe();
      clearTimeout(pollTimer);
      clearInterval(cloudMetaTimer);
      clearInterval(predictiveTimer);
    };
  }, []);

  const artChanged = data?.albumArtUrl !== prevArtRef.current;
  prevArtRef.current = data?.albumArtUrl ?? null;

  return { nowPlaying: data, artChanged, smoothedRtt: data?.smoothedRtt ?? 150 };
}
