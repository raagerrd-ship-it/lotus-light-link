import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { AgcState, EnergySample } from "@/lib/energyInterpolate";
import type { BeatGrid } from "@/lib/bpmEstimate";
import type { SongSection } from "@/lib/sectionLighting";
import type { Drop } from "@/lib/dropDetect";
import type { DynamicRange, Transition } from "@/lib/songAnalysis";

export type { EnergySample };

interface TrackKey {
  trackName: string;
  artistName: string;
}

interface SongEnergyCurveResult {
  curve: EnergySample[] | null;
  recordedVolume: number | null;
  savedAgcState: AgcState | null;
  bpm: number | null;
  beatGrid: BeatGrid | null;
  sections: SongSection[] | null;
  drops: Drop[] | null;
  dynamicRange: DynamicRange | null;
  transitions: Transition[] | null;
  beatStrengths: number[] | null;
  processing: boolean;
  loading: boolean;
  saveCurve: (
    samples: EnergySample[],
    volume: number | null,
    agcState?: AgcState | null,
    trackOverride?: TrackKey | null,
  ) => void;
}

interface CacheEntry {
  curve: EnergySample[] | null;
  vol: number | null;
  agc: AgcState | null;
  bpm: number | null;
  beatGrid: BeatGrid | null;
  sections: SongSection[] | null;
  drops: Drop[] | null;
  dynamicRange: DynamicRange | null;
  transitions: Transition[] | null;
  beatStrengths: number[] | null;
  songId: string | null;
}

const curveCache = new Map<string, CacheEntry>();

function cacheKey(t: TrackKey): string {
  return `${t.trackName}|${t.artistName}`;
}

/** Clear cache for a specific track (call after deleting a recording) */
export function clearCurveCache(trackName: string, artistName: string) {
  const key = `${trackName}|${artistName}`;
  curveCache.delete(key);
  window.dispatchEvent(new CustomEvent('curve-cache-clear', { detail: key }));
}

/** Clear entire curve cache */
export function clearAllCurveCache() {
  curveCache.clear();
  window.dispatchEvent(new CustomEvent('curve-cache-clear', { detail: '*' }));
}

// DB columns to select
const SELECT_COLS = "id, energy_curve, recorded_volume, agc_state, bpm, sections, drops, beat_grid, dynamic_range, transitions, beat_strengths";

function parseRow(data: any): Omit<CacheEntry, 'songId'> & { songId: string | null } {
  const parsed = data?.energy_curve as unknown as EnergySample[] | null;
  const valid = Array.isArray(parsed) && parsed.length > 10 ? parsed : null;
  return {
    curve: valid,
    vol: (data?.recorded_volume as number | null) ?? null,
    agc: (data?.agc_state as AgcState | null) ?? null,
    bpm: (data?.bpm as number | null) ?? null,
    beatGrid: (data?.beat_grid as BeatGrid | null) ?? null,
    sections: (data?.sections as unknown as SongSection[] | null) ?? null,
    drops: (data?.drops as unknown as Drop[] | null) ?? null,
    dynamicRange: (data?.dynamic_range as DynamicRange | null) ?? null,
    transitions: (data?.transitions as Transition[] | null) ?? null,
    beatStrengths: (data?.beat_strengths as number[] | null) ?? null,
    songId: data?.id ?? null,
  };
}

export function useSongEnergyCurve(track: TrackKey | null): SongEnergyCurveResult {
  const [curve, setCurve] = useState<EnergySample[] | null>(null);
  const [recordedVolume, setRecordedVolume] = useState<number | null>(null);
  const [savedAgcState, setSavedAgcState] = useState<AgcState | null>(null);
  const [bpm, setBpm] = useState<number | null>(null);
  const [beatGrid, setBeatGrid] = useState<BeatGrid | null>(null);
  const [sections, setSections] = useState<SongSection[] | null>(null);
  const [drops, setDrops] = useState<Drop[] | null>(null);
  const [dynamicRange, setDynamicRange] = useState<DynamicRange | null>(null);
  const [transitions, setTransitions] = useState<Transition[] | null>(null);
  const [beatStrengths, setBeatStrengths] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [cacheVersion, setCacheVersion] = useState(0);
  const trackRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for cache invalidation events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const currentKey = track ? cacheKey(track) : null;
      if (detail === '*' || detail === currentKey) {
        trackRef.current = null; // force re-fetch
        setCacheVersion(v => v + 1);
      }
    };
    window.addEventListener('curve-cache-clear', handler);
    return () => window.removeEventListener('curve-cache-clear', handler);
  }, [track?.trackName, track?.artistName]);

  // Apply a cache entry to state
  const applyEntry = useCallback((entry: CacheEntry) => {
    setCurve(entry.curve);
    setRecordedVolume(entry.vol);
    setSavedAgcState(entry.agc);
    setBpm(entry.bpm);
    setBeatGrid(entry.beatGrid);
    setSections(entry.sections);
    setDrops(entry.drops);
    setDynamicRange(entry.dynamicRange);
    setTransitions(entry.transitions);
    setBeatStrengths(entry.beatStrengths);
  }, []);

  // Check if a song still needs server-side processing
  const needsProcessing = useCallback((entry: CacheEntry): boolean => {
    if (!entry.curve) return false;
    return !entry.bpm || !entry.beatGrid || !entry.sections || !entry.dynamicRange || !entry.drops;
  }, []);

  // Poll for server-side analysis results
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback((key: string, songId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      if (attempts > 36) { // 3 minutes max
        if (pollRef.current) clearInterval(pollRef.current);
        return;
      }
      try {
        const { data } = await supabase
          .from("song_analysis")
          .select(SELECT_COLS)
          .eq("id", songId)
          .maybeSingle();
        if (!data) return;
        const parsed = parseRow(data);
        const entry: CacheEntry = { ...parsed };
        curveCache.set(key, entry);
        // Update state if still on same track
        if (trackRef.current === key) applyEntry(entry);
        // Stop polling if fully processed
        if (!needsProcessing(entry)) {
          if (pollRef.current) clearInterval(pollRef.current);
          console.log("[EnergyCurve] server analysis complete for", key);
        }
      } catch (_) { /* ignore */ }
    }, 5000); // poll every 5s
  }, [applyEntry, needsProcessing]);

  useEffect(() => {
    if (!track) {
      setCurve(null); setRecordedVolume(null); setSavedAgcState(null);
      setBpm(null); setBeatGrid(null); setSections(null);
      setDrops(null); setDynamicRange(null); setTransitions(null); setBeatStrengths(null);
      trackRef.current = null;
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    const key = cacheKey(track);
    if (key === trackRef.current) return;
    trackRef.current = key;
    if (pollRef.current) clearInterval(pollRef.current);

    if (curveCache.has(key)) {
      const cached = curveCache.get(key)!;
      applyEntry(cached);
      // If still incomplete, start polling
      if (needsProcessing(cached) && cached.songId) {
        startPolling(key, cached.songId);
      }
      return;
    }

    setLoading(true);
    supabase
      .from("song_analysis")
      .select(SELECT_COLS)
      .eq("track_name", track.trackName)
      .eq("artist_name", track.artistName)
      .maybeSingle()
      .then(({ data }) => {
        if (trackRef.current !== key) return;
        const parsed = parseRow(data);
        const entry: CacheEntry = { ...parsed };
        curveCache.set(key, entry);
        applyEntry(entry);
        setLoading(false);

        // If analysis is incomplete, start polling for server results
        if (needsProcessing(entry) && entry.songId) {
          startPolling(key, entry.songId);
        }
      });
  }, [track?.trackName, track?.artistName, cacheVersion, applyEntry, needsProcessing, startPolling]);

  const saveCurve = useCallback(
    (
      samples: EnergySample[],
      volume: number | null,
      agcState?: AgcState | null,
      trackOverride?: TrackKey | null,
    ) => {
      const targetTrack = trackOverride ?? track;
      if (!targetTrack || samples.length < 10) return;
      setProcessing(true);

      const key = cacheKey(targetTrack);
      const cached = curveCache.get(key);

      // Update cache immediately with raw data (no heavy analysis)
      const entry: CacheEntry = {
        curve: samples,
        vol: volume,
        agc: agcState ?? null,
        bpm: cached?.bpm ?? null,
        beatGrid: cached?.beatGrid ?? null,
        sections: cached?.sections ?? null,
        drops: cached?.drops ?? null,
        dynamicRange: cached?.dynamicRange ?? null,
        transitions: cached?.transitions ?? null,
        beatStrengths: cached?.beatStrengths ?? null,
        songId: cached?.songId ?? null,
      };
      curveCache.set(key, entry);

      const currentKey = track ? cacheKey(track) : null;
      if (!currentKey || currentKey === key) {
        setCurve(samples);
        setRecordedVolume(volume);
        if (agcState) setSavedAgcState(agcState);
      }

      // Save to DB — server cron will handle all analysis
      const payload = {
        energy_curve: samples as any,
        recorded_volume: volume,
        ...(agcState ? { agc_state: agcState as any } : {}),
      } as any;

      supabase
        .from("song_analysis")
        .select("id")
        .eq("track_name", targetTrack.trackName)
        .eq("artist_name", targetTrack.artistName)
        .maybeSingle()
        .then(({ data: existing }) => {
          if (existing) {
            supabase
              .from("song_analysis")
              .update({
                ...payload,
                // Clear computed fields so server re-processes
                bpm: null, beat_grid: null, drops: null,
                dynamic_range: null, transitions: null,
                beat_strengths: null, sections: null,
              })
              .eq("id", existing.id)
              .then(() => {
                console.log("[EnergyCurve] saved raw data for", targetTrack.trackName, "— server will process");
                curveCache.set(key, { ...entry, songId: existing.id });
                startPolling(key, existing.id);
                setProcessing(false);
              })
              .catch(() => setProcessing(false));
          } else {
            supabase
              .from("song_analysis")
              .insert({
                track_name: targetTrack.trackName,
                artist_name: targetTrack.artistName,
                ...payload,
              })
              .select("id")
              .single()
              .then(({ data: inserted }) => {
                console.log("[EnergyCurve] inserted raw data for", targetTrack.trackName, "— server will process");
                if (inserted?.id) {
                  curveCache.set(key, { ...entry, songId: inserted.id });
                  startPolling(key, inserted.id);
                }
                setProcessing(false);
              })
              .catch(() => setProcessing(false));
          }
        });
    },
    [track, startPolling],
  );

  return { curve, recordedVolume, savedAgcState, bpm, beatGrid, sections, drops, dynamicRange, transitions, beatStrengths, processing, loading, saveCurve };
}
