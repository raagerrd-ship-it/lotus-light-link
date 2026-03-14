import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

interface BpmResult {
  bpm: number | null;
  energy: number | null;
  loading: boolean;
}

// In-memory cache so we don't re-fetch for the same track
const bpmCache = new Map<string, { bpm: number | null; energy: number | null }>();

export function useBpm(trackName: string | null, artistName: string | null): BpmResult {
  const [result, setResult] = useState<BpmResult>({ bpm: null, energy: null, loading: false });
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!trackName || !artistName) {
      setResult({ bpm: null, energy: null, loading: false });
      lastKeyRef.current = null;
      return;
    }

    const key = `${artistName}::${trackName}`.toLowerCase();
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;

    // Check cache
    const cached = bpmCache.get(key);
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
        .select("bpm")
        .eq("track_name", trackName)
        .eq("artist_name", artistName)
        .maybeSingle();

      if (cancelled) return;

      if (dbRow?.bpm) {
        const entry = { bpm: dbRow.bpm, energy: null };
        bpmCache.set(key, entry);
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
          const entry = { bpm: null, energy: null };
          bpmCache.set(key, entry);
          setResult({ ...entry, loading: false });
          return;
        }

        const entry = { bpm: data.bpm ?? null, energy: data.energy ?? null };
        bpmCache.set(key, entry);
        setResult({ ...entry, loading: false });

        // Save to song_analysis for future use
        if (data.bpm) {
          await supabase.from("song_analysis").upsert(
            { track_name: trackName, artist_name: artistName, bpm: Math.round(data.bpm) },
            { onConflict: "track_name,artist_name" }
          ).then(() => {}, () => {});
        }
      } catch (e) {
        if (cancelled) return;
        console.warn("[useBpm] fetch error:", e);
        setResult({ bpm: null, energy: null, loading: false });
      }
    })();

    return () => { cancelled = true; };
  }, [trackName, artistName]);

  return result;
}
