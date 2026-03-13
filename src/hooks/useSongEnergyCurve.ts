import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface EnergySample {
  t: number; // seconds from song start
  e: number; // 0.0–1.0 normalized energy
}

interface TrackKey {
  trackName: string;
  artistName: string;
}

interface SongEnergyCurveResult {
  /** Saved curve from DB, or null if first listen */
  curve: EnergySample[] | null;
  /** Volume (0-100) the curve was recorded at, or null */
  recordedVolume: number | null;
  /** True while fetching */
  loading: boolean;
  /** Save/update the energy curve for the current track */
  saveCurve: (samples: EnergySample[], volume: number | null) => void;
}

// In-memory cache: "track|artist" → curve or null
const curveCache = new Map<string, EnergySample[] | null>();

function cacheKey(t: TrackKey): string {
  return `${t.trackName}|${t.artistName}`;
}

export function useSongEnergyCurve(track: TrackKey | null): SongEnergyCurveResult {
  const [curve, setCurve] = useState<EnergySample[] | null>(null);
  const [recordedVolume, setRecordedVolume] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const trackRef = useRef<string | null>(null);

  useEffect(() => {
    if (!track) {
      setCurve(null);
      setRecordedVolume(null);
      trackRef.current = null;
      return;
    }

    const key = cacheKey(track);
    if (key === trackRef.current) return; // same track
    trackRef.current = key;

    // Check cache first
    if (curveCache.has(key)) {
      setCurve(curveCache.get(key) ?? null);
      return;
    }

    // Fetch from DB
    setLoading(true);
    supabase
      .from("song_analysis")
      .select("energy_curve, recorded_volume")
      .eq("track_name", track.trackName)
      .eq("artist_name", track.artistName)
      .maybeSingle()
      .then(({ data }) => {
        if (trackRef.current !== key) return;
        const parsed = data?.energy_curve as unknown as EnergySample[] | null;
        const valid = Array.isArray(parsed) && parsed.length > 10 ? parsed : null;
        const vol = (data as any)?.recorded_volume as number | null;
        curveCache.set(key, valid);
        setCurve(valid);
        setRecordedVolume(vol ?? null);
        setLoading(false);
      });
  }, [track?.trackName, track?.artistName]);

  const saveCurve = useCallback(
    (samples: EnergySample[]) => {
      if (!track || samples.length < 10) return;
      const key = cacheKey(track);
      curveCache.set(key, samples);
      setCurve(samples);

      // Upsert: check if row exists, then insert or update
      supabase
        .from("song_analysis")
        .select("id")
        .eq("track_name", track.trackName)
        .eq("artist_name", track.artistName)
        .maybeSingle()
        .then(({ data: existing }) => {
          if (existing) {
            supabase
              .from("song_analysis")
              .update({ energy_curve: samples as any })
              .eq("id", existing.id)
              .then(() => console.log("[EnergyCurve] updated", track.trackName));
          } else {
            supabase
              .from("song_analysis")
              .insert({
                track_name: track.trackName,
                artist_name: track.artistName,
                energy_curve: samples as any,
              })
              .then(() => console.log("[EnergyCurve] inserted", track.trackName));
          }
        });
    },
    [track?.trackName, track?.artistName],
  );

  return { curve, loading, saveCurve };
}
