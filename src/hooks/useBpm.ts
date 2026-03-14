import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface TrackTraits {
  bpm: number | null;
  energy: number | null;       // 0-100
  danceability: number | null; // 0-100
  happiness: number | null;    // 0-100
  loudness: string | null;     // e.g. "-5 dB"
  loading: boolean;
}

// In-memory cache so we don't re-fetch for the same track
const traitsCache = new Map<string, Omit<TrackTraits, 'loading'>>();

export function useBpm(trackName: string | null, artistName: string | null): TrackTraits {
  const [result, setResult] = useState<TrackTraits>({ bpm: null, energy: null, danceability: null, happiness: null, loudness: null, loading: false });
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!trackName || !artistName) {
      setResult({ bpm: null, energy: null, danceability: null, happiness: null, loudness: null, loading: false });
      lastKeyRef.current = null;
      return;
    }

    const key = `${artistName}::${trackName}`.toLowerCase();
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;

    // Check cache
    const cached = traitsCache.get(key);
    if (cached) {
      setResult({ ...cached, loading: false });
      return;
    }

    // Check song_analysis table first
    let cancelled = false;
    setResult(prev => ({ ...prev, loading: true }));

    (async () => {
      // 1. Try local DB
      const { data: dbRow } = await supabase
        .from("song_analysis")
        .select("bpm, energy, danceability, happiness, loudness")
        .eq("track_name", trackName)
        .eq("artist_name", artistName)
        .maybeSingle();

      if (cancelled) return;

      if (dbRow?.bpm) {
        const entry: Omit<TrackTraits, 'loading'> = {
          bpm: dbRow.bpm,
          energy: (dbRow as any).energy ?? null,
          danceability: (dbRow as any).danceability ?? null,
          happiness: (dbRow as any).happiness ?? null,
          loudness: (dbRow as any).loudness ?? null,
        };
        traitsCache.set(key, entry);
        setResult({ ...entry, loading: false });
        return;
      }

      // 2. Call edge function
      try {
        const { data, error } = await supabase.functions.invoke("track-analysis", {
          body: { track: trackName, artist: artistName },
        });

        if (cancelled) return;

        if (error || !data?.success) {
          console.warn("[useBpm] API failed:", error ?? data?.error);
          const entry: Omit<TrackTraits, 'loading'> = { bpm: null, energy: null, danceability: null, happiness: null, loudness: null };
          traitsCache.set(key, entry);
          setResult({ ...entry, loading: false });
          return;
        }

        const raw = data.raw ?? {};
        const entry: Omit<TrackTraits, 'loading'> = {
          bpm: data.bpm ?? null,
          energy: raw.energy ?? data.energy ?? null,
          danceability: raw.danceability ?? data.danceability ?? null,
          happiness: raw.happiness ?? null,
          loudness: raw.loudness ?? null,
        };
        traitsCache.set(key, entry);
        setResult({ ...entry, loading: false });

        // Save to song_analysis for future use
        if (data.bpm) {
          await supabase.from("song_analysis").upsert(
            {
              track_name: trackName,
              artist_name: artistName,
              bpm: Math.round(data.bpm),
              energy: entry.energy != null ? Math.round(entry.energy) : null,
              danceability: entry.danceability != null ? Math.round(entry.danceability) : null,
              happiness: entry.happiness != null ? Math.round(entry.happiness) : null,
              loudness: entry.loudness,
            } as any,
            { onConflict: "track_name,artist_name" }
          ).then(() => {}, () => {});
        }
      } catch (e) {
        if (cancelled) return;
        console.warn("[useBpm] fetch error:", e);
        setResult({ bpm: null, energy: null, danceability: null, happiness: null, loudness: null, loading: false });
      }
    })();

    return () => { cancelled = true; };
  }, [trackName, artistName]);

  return result;
}
