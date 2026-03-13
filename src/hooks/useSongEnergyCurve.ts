import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { AgcState } from "@/lib/energyInterpolate";

export interface EnergySample {
  t: number;
  e: number;
  kick?: boolean;
  lo?: number;
  mid?: number;
  hi?: number;
}

interface TrackKey {
  trackName: string;
  artistName: string;
}

interface SongEnergyCurveResult {
  curve: EnergySample[] | null;
  recordedVolume: number | null;
  savedAgcState: AgcState | null;
  loading: boolean;
  saveCurve: (samples: EnergySample[], volume: number | null, agcState?: AgcState | null) => void;
}

const curveCache = new Map<string, { curve: EnergySample[] | null; vol: number | null; agc: AgcState | null }>();

function cacheKey(t: TrackKey): string {
  return `${t.trackName}|${t.artistName}`;
}

export function useSongEnergyCurve(track: TrackKey | null): SongEnergyCurveResult {
  const [curve, setCurve] = useState<EnergySample[] | null>(null);
  const [recordedVolume, setRecordedVolume] = useState<number | null>(null);
  const [savedAgcState, setSavedAgcState] = useState<AgcState | null>(null);
  const [loading, setLoading] = useState(false);
  const trackRef = useRef<string | null>(null);

  useEffect(() => {
    if (!track) {
      setCurve(null);
      setRecordedVolume(null);
      setSavedAgcState(null);
      trackRef.current = null;
      return;
    }

    const key = cacheKey(track);
    if (key === trackRef.current) return;
    trackRef.current = key;

    if (curveCache.has(key)) {
      const cached = curveCache.get(key)!;
      setCurve(cached.curve);
      setRecordedVolume(cached.vol);
      setSavedAgcState(cached.agc);
      return;
    }

    setLoading(true);
    supabase
      .from("song_analysis")
      .select("energy_curve, recorded_volume, agc_state")
      .eq("track_name", track.trackName)
      .eq("artist_name", track.artistName)
      .maybeSingle()
      .then(({ data }) => {
        if (trackRef.current !== key) return;
        const parsed = data?.energy_curve as unknown as EnergySample[] | null;
        const valid = Array.isArray(parsed) && parsed.length > 10 ? parsed : null;
        const vol = (data as any)?.recorded_volume as number | null;
        const agc = (data as any)?.agc_state as AgcState | null;
        curveCache.set(key, { curve: valid, vol: vol ?? null, agc: agc ?? null });
        setCurve(valid);
        setRecordedVolume(vol ?? null);
        setSavedAgcState(agc ?? null);
        setLoading(false);
      });
  }, [track?.trackName, track?.artistName]);

  const saveCurve = useCallback(
    (samples: EnergySample[], volume: number | null, agcState?: AgcState | null) => {
      if (!track || samples.length < 10) return;
      const key = cacheKey(track);
      curveCache.set(key, { curve: samples, vol: volume, agc: agcState ?? null });
      setCurve(samples);
      setRecordedVolume(volume);
      if (agcState) setSavedAgcState(agcState);

      supabase
        .from("song_analysis")
        .select("id")
        .eq("track_name", track.trackName)
        .eq("artist_name", track.artistName)
        .maybeSingle()
        .then(({ data: existing }) => {
          const payload = {
            energy_curve: samples as any,
            recorded_volume: volume,
            ...(agcState ? { agc_state: agcState as any } : {}),
          } as any;
          if (existing) {
            supabase
              .from("song_analysis")
              .update(payload)
              .eq("id", existing.id)
              .then(() => console.log("[EnergyCurve] updated", track.trackName));
          } else {
            supabase
              .from("song_analysis")
              .insert({
                track_name: track.trackName,
                artist_name: track.artistName,
                ...payload,
              })
              .then(() => console.log("[EnergyCurve] inserted", track.trackName));
          }
        });
    },
    [track?.trackName, track?.artistName],
  );

  return { curve, recordedVolume, savedAgcState, loading, saveCurve };
}
