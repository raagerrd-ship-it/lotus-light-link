import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// brew-monitor-tv Supabase (public SELECT policy on sonos_now_playing)
const BREW_URL = "https://plwchuzidrjgyuepwdcl.supabase.co";
const BREW_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsd2NodXppZHJqZ3l1ZXB3ZGNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk0ODUyOTIsImV4cCI6MjA3NTA2MTI5Mn0.p9giTnFOK-b0NqrB4ZqN-3CJEaAqMNy-KYvRZ6P_qS0";

const brewSupabase = createClient(BREW_URL, BREW_ANON, {
  auth: { storageKey: 'brew-monitor-auth', persistSession: false },
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

export function useSonosNowPlaying() {
  const [data, setData] = useState<SonosNowPlaying | null>(null);
  const prevArtRef = useRef<string | null>(null);
  const lastUpdatedAtRef = useRef<string | null>(null);
  const fastPollRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNowPlaying = async () => {
    const { data: rows } = await brewSupabase
      .from("sonos_now_playing")
      .select("track_name, artist_name, album_name, album_art_url, playback_state, duration_ms, position_ms, updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (rows && rows.length > 0) {
      const row = rows[0];
      const changed = row.updated_at !== lastUpdatedAtRef.current;
      lastUpdatedAtRef.current = row.updated_at;

      setData({
        trackName: row.track_name,
        artistName: row.artist_name,
        albumName: row.album_name,
        albumArtUrl: row.album_art_url,
        playbackState: row.playback_state,
        durationMs: row.duration_ms,
        positionMs: row.position_ms,
        receivedAt: performance.now(),
      });

      // If we were in fast-poll mode and got a new update, slow back down
      if (changed && fastPollRef.current) {
        fastPollRef.current = false;
        setPollInterval(1500);
      }
    } else {
      setData(null);
    }
  };

  const setPollInterval = (ms: number) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchNowPlaying, ms);
  };

  // Detect when track is near its end and switch to fast polling
  useEffect(() => {
    if (!data || !data.durationMs || !data.positionMs) return;
    if (data.playbackState !== "PLAYBACK_STATE_PLAYING") return;

    const elapsed = performance.now() - data.receivedAt;
    const estimatedPos = data.positionMs + elapsed;
    const remaining = data.durationMs - estimatedPos;

    if (remaining < 15000 && !fastPollRef.current) {
      // Track ending soon — poll every 500ms to catch the change quickly
      fastPollRef.current = true;
      setPollInterval(500);
    }
  });

  useEffect(() => {
    fetchNowPlaying();

    const channel = brewSupabase
      .channel("sonos-now-playing-remote")
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "sonos_now_playing" },
        () => {
          fetchNowPlaying();
        }
      )
      .subscribe();

    setPollInterval(1500);

    return () => {
      channel.unsubscribe();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const artChanged = data?.albumArtUrl !== prevArtRef.current;
  prevArtRef.current = data?.albumArtUrl ?? null;

  return { nowPlaying: data, artChanged };
}
