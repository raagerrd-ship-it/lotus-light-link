import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const BREW_URL = "https://plwchuzidrjgyuepwdcl.supabase.co";
const BREW_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsd2NodXppZHJqZ3l1ZXB3ZGNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk0ODUyOTIsImV4cCI6MjA3NTA2MTI5Mn0.p9giTnFOK-b0NqrB4ZqN-3CJEaAqMNy-KYvRZ6P_qS0";

const brewSupabase = createClient(BREW_URL, BREW_ANON, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

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
}

export function useSonosNowPlaying() {
  const [data, setData] = useState<SonosNowPlaying | null>(null);
  const dataRef = useRef<SonosNowPlaying | null>(null);
  const prevArtRef = useRef<string | null>(null);

  useEffect(() => {
    // Apply new data with drift protection — avoid small position jumps on same track
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
        if (Math.abs(next.positionMs - estimated) < 5000) return; // interpolation is close enough
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
        // DB is stale — only take album art if track matches what we had before
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
      });
    };

    // RTT smoothing via EMA
    let smoothedRtt = 150; // initial estimate in ms

    // Watchdog: direct API call for fresh position + fast track change detection
    const fetchApi = async () => {
      try {
        const t0 = performance.now();
        const res = await fetch(`${BREW_URL}/functions/v1/sonos-playback-status`, {
          headers: { Authorization: `Bearer ${BREW_ANON}`, apikey: BREW_ANON, "Content-Type": "application/json" },
          cache: "no-store",
        });
        const rtt = performance.now() - t0;
        smoothedRtt = smoothedRtt * 0.7 + rtt * 0.3;
        if (!res.ok) return;
        const s = await res.json();
        if (!s?.ok || !s.trackName) return;

        const prev = dataRef.current;
        const isTrackChange = !prev || s.trackName !== prev.trackName;

        // On track change, fetch DB for full metadata (album art URL from Spotify CDN)
        if (isTrackChange) {
          // Apply immediately with what we have, then refresh from DB
          apply({
            trackName: s.trackName,
            artistName: s.artistName ?? null,
            albumName: s.albumName ?? prev?.albumName ?? null,
            albumArtUrl: prev?.albumArtUrl ?? null,
            playbackState: s.playbackState ?? "PLAYBACK_STATE_PLAYING",
            durationMs: s.durationMillis ?? null,
            positionMs: (s.positionMillis ?? 0) + smoothedRtt / 2,
            receivedAt: performance.now(),
            smoothedRtt,
            nextTrackName: s.nextTrackName ?? null,
            nextArtistName: s.nextArtistName ?? null,
          });
          // Fetch DB after short delay to get album art
          setTimeout(fetchDb, 800);
          return;
        }

        // Same track — only correct if big drift
        apply({
          ...prev!,
          playbackState: s.playbackState ?? prev!.playbackState,
          positionMs: (s.positionMillis ?? prev!.positionMs ?? 0) + smoothedRtt / 2,
          durationMs: s.durationMillis ?? prev!.durationMs,
          receivedAt: performance.now(),
          smoothedRtt,
          nextTrackName: s.nextTrackName ?? prev!.nextTrackName ?? null,
          nextArtistName: s.nextArtistName ?? prev!.nextArtistName ?? null,
        });
      } catch { /* network error — ignore */ }
    };

    // Initial load from DB
    fetchDb();

    // Realtime subscription — fetch DB on any change
    const channel = brewSupabase
      .channel("sonos-np")
      .on("postgres_changes" as any, { event: "*", schema: "public", table: "sonos_now_playing" }, fetchDb)
      .subscribe();

    // Watchdog polls API every 2.5s for fresh position data
    const watchdog = setInterval(fetchApi, 1500);

    return () => {
      channel.unsubscribe();
      clearInterval(watchdog);
    };
  }, []);

  const artChanged = data?.albumArtUrl !== prevArtRef.current;
  prevArtRef.current = data?.albumArtUrl ?? null;

  return { nowPlaying: data, artChanged, smoothedRtt: data?.smoothedRtt ?? 150 };
}
