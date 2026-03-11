import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// brew-monitor-tv backend (public SELECT policy on sonos_now_playing)
const BREW_URL = "https://plwchuzidrjgyuepwdcl.supabase.co";
const BREW_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsd2NodXppZHJqZ3l1ZXB3ZGNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk0ODUyOTIsImV4cCI6MjA3NTA2MTI5Mn0.p9giTnFOK-b0NqrB4ZqN-3CJEaAqMNy-KYvRZ6P_qS0";

const brewSupabase = createClient(BREW_URL, BREW_ANON, {
  auth: {
    storageKey: "brew-monitor-auth",
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export interface SonosNowPlaying {
  trackName: string | null;
  artistName: string | null;
  albumName: string | null;
  albumArtUrl: string | null;
  playbackState: string;
  durationMs: number | null;
  positionMs: number | null;
  /** When we received this position data (performance.now()) */
  receivedAt: number;
}

interface SonosPlaybackStatusResponse {
  ok?: boolean;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  albumArtUrl?: string;
  playbackState?: string;
  durationMillis?: number;
  positionMillis?: number;
}

export function useSonosNowPlaying() {
  const [data, setData] = useState<SonosNowPlaying | null>(null);
  const prevArtRef = useRef<string | null>(null);
  const lastUpdatedAtRef = useRef<string | null>(null);
  const lastDbWriteAtMsRef = useRef<number>(0);
  const fastPollRef = useRef(false);
  const watchdogTrackRef = useRef<string | null>(null); // track applied by watchdog ahead of DB
  const dbIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dataRef = useRef<SonosNowPlaying | null>(null);

  const setPollInterval = (ms: number) => {
    if (dbIntervalRef.current) clearInterval(dbIntervalRef.current);
    dbIntervalRef.current = setInterval(fetchNowPlayingFromDb, ms);
  };

  const applyNowPlaying = (next: SonosNowPlaying) => {
    const current = dataRef.current;

    if (
      current &&
      current.trackName === next.trackName &&
      current.artistName === next.artistName
    ) {
      const currentEstimated = current.positionMs != null
        ? current.positionMs + (performance.now() - current.receivedAt)
        : null;

      // Keep local timer stable on same track; only hard-correct on very large drift
      if (currentEstimated != null && next.positionMs != null) {
        const drift = Math.abs(next.positionMs - currentEstimated);
        if (drift < 8000) {
          setData({
            ...next,
            positionMs: current.positionMs,
            receivedAt: current.receivedAt,
          });
          return;
        }
      }
    }

    setData(next);
  };

  const fetchNowPlayingFromDb = async () => {
    const { data: rows } = await brewSupabase
      .from("sonos_now_playing")
      .select("track_name, artist_name, album_name, album_art_url, playback_state, duration_ms, position_ms, updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (!rows || rows.length === 0) {
      setData(null);
      return;
    }

    const row = rows[0];
    const changed = row.updated_at !== lastUpdatedAtRef.current;
    if (changed) {
      lastUpdatedAtRef.current = row.updated_at;
      lastDbWriteAtMsRef.current = row.updated_at ? new Date(row.updated_at).getTime() : Date.now();
    }

    // If watchdog already applied a newer track, skip DB data until DB catches up
    if (watchdogTrackRef.current && row.track_name !== watchdogTrackRef.current) {
      return;
    }
    // DB caught up — clear watchdog override
    if (watchdogTrackRef.current && row.track_name === watchdogTrackRef.current) {
      watchdogTrackRef.current = null;
    }

    // Compensate position for time elapsed since DB row was written
    const dbWriteAge = row.updated_at ? Date.now() - new Date(row.updated_at).getTime() : 0;
    const compensatedPosition = row.playback_state === "PLAYBACK_STATE_PLAYING"
      ? Math.min((row.duration_ms ?? Number.MAX_SAFE_INTEGER), (row.position_ms ?? 0) + Math.max(0, dbWriteAge))
      : (row.position_ms ?? 0);

    // Only update position if it wouldn't cause a visible jump backwards
    const currentData = dataRef.current;
    if (currentData && currentData.trackName === row.track_name && currentData.positionMs != null) {
      const currentEstimated = currentData.positionMs + (performance.now() - currentData.receivedAt);
      const diff = Math.abs(compensatedPosition - currentEstimated);
      // Skip if the difference is small (< 3s) — our interpolation is good enough
      if (diff < 3000 && !changed) return;
    }

    applyNowPlaying({
      trackName: row.track_name,
      artistName: row.artist_name,
      albumName: row.album_name,
      albumArtUrl: row.album_art_url,
      playbackState: row.playback_state,
      durationMs: row.duration_ms,
      positionMs: compensatedPosition,
      receivedAt: performance.now(),
    });

    // If we were in fast-poll mode and got a fresh DB write, slow back down.
    if (changed && fastPollRef.current) {
      fastPollRef.current = false;
      setPollInterval(1200);
    }
  };

  const fetchPlaybackStatus = async (): Promise<SonosPlaybackStatusResponse | null> => {
    try {
      const response = await fetch(`${BREW_URL}/functions/v1/sonos-playback-status`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${BREW_ANON}`,
          apikey: BREW_ANON,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      });

      if (!response.ok) return null;
      const result = (await response.json()) as SonosPlaybackStatusResponse;
      if (!result?.ok) return null;
      return result;
    } catch {
      return null;
    }
  };

  // Detect when track is near end and switch DB polling to fast mode.
  useEffect(() => {
    if (!data || !data.durationMs || data.positionMs == null) return;
    if (data.playbackState !== "PLAYBACK_STATE_PLAYING") return;

    const elapsed = performance.now() - data.receivedAt;
    const estimatedPos = data.positionMs + elapsed;
    const remaining = data.durationMs - estimatedPos;

    if (remaining < 15000 && !fastPollRef.current) {
      fastPollRef.current = true;
      setPollInterval(500);
    }
  }, [data]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    fetchNowPlayingFromDb();

    const channel = brewSupabase
      .channel("sonos-now-playing-remote")
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "sonos_now_playing" },
        () => {
          fetchNowPlayingFromDb();
        }
      )
      .subscribe();

    // Baslinjepoll för DB-raden.
    setPollInterval(1200);

    // Watchdog: om DB inte skrivits nyligen, fråga playback-status direkt.
    const watchdog = setInterval(async () => {
      const dbStaleMs = lastDbWriteAtMsRef.current ? Date.now() - lastDbWriteAtMsRef.current : Infinity;
      if (dbStaleMs < 6000 && !fastPollRef.current) return;

      const status = await fetchPlaybackStatus();
      if (!status?.trackName) return;

      const currentData = dataRef.current;
      const shouldApply =
        !currentData ||
        status.trackName !== currentData.trackName ||
        (status.artistName ?? null) !== currentData.artistName ||
        dbStaleMs > 12000;

      if (shouldApply) {
        // Mark watchdog override so DB polls don't flicker back to old track
        if (status.trackName && (!currentData || status.trackName !== currentData.trackName)) {
          watchdogTrackRef.current = status.trackName;
        }
        const newPos = status.positionMillis ?? 0;
        const clampedPos = Math.min(status.durationMillis ?? Number.MAX_SAFE_INTEGER, newPos);

        // Skip position-only updates that would cause small jumps
        const isTrackChange = !currentData || status.trackName !== currentData.trackName;
        if (!isTrackChange && currentData && currentData.positionMs != null) {
          const currentEstimated = currentData.positionMs + (performance.now() - currentData.receivedAt);
          const diff = Math.abs(clampedPos - currentEstimated);
          if (diff < 3000) return; // interpolation is close enough
        }

        applyNowPlaying({
          trackName: status.trackName ?? null,
          artistName: status.artistName ?? null,
          albumName: status.albumName ?? currentData?.albumName ?? null,
          albumArtUrl: status.albumArtUrl ?? currentData?.albumArtUrl ?? null,
          playbackState: status.playbackState ?? currentData?.playbackState ?? "PLAYBACK_STATE_PLAYING",
          durationMs: status.durationMillis ?? currentData?.durationMs ?? null,
          positionMs: clampedPos,
          receivedAt: performance.now(),
        });
      }
    }, 2000);

    return () => {
      channel.unsubscribe();
      if (dbIntervalRef.current) clearInterval(dbIntervalRef.current);
      clearInterval(watchdog);
    };
  }, []);

  const artChanged = data?.albumArtUrl !== prevArtRef.current;
  prevArtRef.current = data?.albumArtUrl ?? null;

  return { nowPlaying: data, artChanged };
}

