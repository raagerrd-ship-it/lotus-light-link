import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { AgcState } from "@/lib/energyInterpolate";
import { estimateBpmFromHistory } from "@/lib/bpmEstimate";
import type { SongSection } from "@/lib/sectionLighting";
import { detectDrops, type Drop } from "@/lib/dropDetect";

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
  bpm: number | null;
  sections: SongSection[] | null;
  drops: Drop[] | null;
  loading: boolean;
  saveCurve: (samples: EnergySample[], volume: number | null, agcState?: AgcState | null) => void;
}

interface CacheEntry {
  curve: EnergySample[] | null;
  vol: number | null;
  agc: AgcState | null;
  bpm: number | null;
  sections: SongSection[] | null;
  drops: Drop[] | null;
  songId: string | null;
}

const curveCache = new Map<string, CacheEntry>();

function cacheKey(t: TrackKey): string {
  return `${t.trackName}|${t.artistName}`;
}

function estimateBpm(curve: EnergySample[]): number | null {
  if (curve.length < 120) return null;
  const history = curve.map(s => s.e);
  const result = estimateBpmFromHistory(history);
  return result ? Math.round(result.bpm) : null;
}

export function useSongEnergyCurve(track: TrackKey | null): SongEnergyCurveResult {
  const [curve, setCurve] = useState<EnergySample[] | null>(null);
  const [recordedVolume, setRecordedVolume] = useState<number | null>(null);
  const [savedAgcState, setSavedAgcState] = useState<AgcState | null>(null);
  const [bpm, setBpm] = useState<number | null>(null);
  const [sections, setSections] = useState<SongSection[] | null>(null);
  const [drops, setDrops] = useState<Drop[] | null>(null);
  const [loading, setLoading] = useState(false);
  const trackRef = useRef<string | null>(null);

  useEffect(() => {
    if (!track) {
      setCurve(null);
      setRecordedVolume(null);
      setSavedAgcState(null);
      setBpm(null);
      setSections(null);
      setDrops(null);
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
      setBpm(cached.bpm);
      setSections(cached.sections);
      setDrops(cached.drops);
      return;
    }

    setLoading(true);
    supabase
      .from("song_analysis")
      .select("id, energy_curve, recorded_volume, agc_state, bpm, sections, drops")
      .eq("track_name", track.trackName)
      .eq("artist_name", track.artistName)
      .maybeSingle()
      .then(({ data }) => {
        if (trackRef.current !== key) return;
        const parsed = data?.energy_curve as unknown as EnergySample[] | null;
        const valid = Array.isArray(parsed) && parsed.length > 10 ? parsed : null;
        const vol = (data as any)?.recorded_volume as number | null;
        const agc = (data as any)?.agc_state as AgcState | null;
        const songId = data?.id ?? null;
        let savedBpm = data?.bpm as number | null;
        const savedSections = (data?.sections as unknown as SongSection[] | null) ?? null;
        let savedDrops = (data?.drops as unknown as Drop[] | null) ?? null;

        // Estimate BPM if not saved yet
        if (!savedBpm && valid) {
          savedBpm = estimateBpm(valid);
          if (savedBpm && songId) {
            supabase.from("song_analysis").update({ bpm: savedBpm } as any).eq("id", songId)
              .then(() => console.log("[EnergyCurve] saved BPM", savedBpm));
          }
        }

        // Detect drops if not saved yet
        if (!savedDrops && valid) {
          savedDrops = detectDrops(valid);
          if (savedDrops.length > 0 && songId) {
            supabase.from("song_analysis").update({ drops: savedDrops as any } as any).eq("id", songId)
              .then(() => console.log("[EnergyCurve] saved drops", savedDrops!.length));
          }
        }

        const entry: CacheEntry = { curve: valid, vol: vol ?? null, agc: agc ?? null, bpm: savedBpm, sections: savedSections, drops: savedDrops, songId };
        curveCache.set(key, entry);
        setCurve(valid);
        setRecordedVolume(vol ?? null);
        setSavedAgcState(agc ?? null);
        setBpm(savedBpm);
        setSections(savedSections);
        setDrops(savedDrops);
        setLoading(false);

        // Trigger section analysis if we have curve but no sections
        if (valid && !savedSections && songId) {
          triggerSectionAnalysis(songId, key);
        }
      });
  }, [track?.trackName, track?.artistName]);

  const triggerSectionAnalysis = useCallback(async (songId: string, key: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('analyze-sections', {
        body: { songId },
      });
      if (error) {
        console.error('[sections] analysis failed', error);
        return;
      }
      const newSections = data?.sections as SongSection[] | null;
      if (newSections && newSections.length > 0) {
        console.log('[sections] got', newSections.length, 'sections');
        setSections(newSections);
        const cached = curveCache.get(key);
        if (cached) curveCache.set(key, { ...cached, sections: newSections });
      }
    } catch (e) {
      console.error('[sections] error', e);
    }
  }, []);

  const saveCurve = useCallback(
    (samples: EnergySample[], volume: number | null, agcState?: AgcState | null) => {
      if (!track || samples.length < 10) return;
      const key = cacheKey(track);
      const newBpm = estimateBpm(samples);
      const cached = curveCache.get(key);
      curveCache.set(key, { curve: samples, vol: volume, agc: agcState ?? null, bpm: newBpm, sections: cached?.sections ?? null, songId: cached?.songId ?? null });
      setCurve(samples);
      setRecordedVolume(volume);
      if (agcState) setSavedAgcState(agcState);
      if (newBpm) setBpm(newBpm);

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
            ...(newBpm ? { bpm: newBpm } : {}),
          } as any;
          if (existing) {
            supabase
              .from("song_analysis")
              .update(payload)
              .eq("id", existing.id)
              .then(() => {
                console.log("[EnergyCurve] updated", track.trackName);
                // Trigger section analysis after update
                if (!cached?.sections) triggerSectionAnalysis(existing.id, key);
              });
          } else {
            supabase
              .from("song_analysis")
              .insert({
                track_name: track.trackName,
                artist_name: track.artistName,
                ...payload,
              })
              .select("id")
              .single()
              .then(({ data: inserted }) => {
                console.log("[EnergyCurve] inserted", track.trackName);
                if (inserted?.id) {
                  const k = cacheKey(track);
                  const c = curveCache.get(k);
                  if (c) curveCache.set(k, { ...c, songId: inserted.id });
                  triggerSectionAnalysis(inserted.id, k);
                }
              });
          }
        });
    },
    [track?.trackName, track?.artistName, triggerSectionAnalysis],
  );

  return { curve, recordedVolume, savedAgcState, bpm, sections, loading, saveCurve };
}
