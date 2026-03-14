import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { AgcState, EnergySample } from "@/lib/energyInterpolate";
import { curvePeakRms } from "@/lib/energyInterpolate";
import { estimateBpmFromHistory, extractBeatGrid, type BeatGrid } from "@/lib/bpmEstimate";
import type { SongSection } from "@/lib/sectionLighting";
import { detectDrops, type Drop } from "@/lib/dropDetect";
import { runMultiSongCalibration } from "@/lib/autoCalibrate";
import { getCalibration, saveCalibration, getActiveDeviceName } from "@/lib/lightCalibration";

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
  songId: string | null;
}

const curveCache = new Map<string, CacheEntry>();

function cacheKey(t: TrackKey): string {
  return `${t.trackName}|${t.artistName}`;
}

function estimateBpm(curve: EnergySample[]): number | null {
  if (curve.length < 120) return null;
  const peak = curvePeakRms(curve);
  const history = curve.map(s => peak > 0 ? s.rawRms / peak : 0);
  const result = estimateBpmFromHistory(history);
  return result ? Math.round(result.bpm) : null;
}

function buildBeatGrid(curve: EnergySample[], bpm: number): BeatGrid | null {
  const peak = curvePeakRms(curve);
  return extractBeatGrid(
    curve.map(s => s.t),
    curve.map(s => peak > 0 ? s.rawRms / peak : 0),
    bpm,
  );
}

export function useSongEnergyCurve(track: TrackKey | null): SongEnergyCurveResult {
  const [curve, setCurve] = useState<EnergySample[] | null>(null);
  const [recordedVolume, setRecordedVolume] = useState<number | null>(null);
  const [savedAgcState, setSavedAgcState] = useState<AgcState | null>(null);
  const [bpm, setBpm] = useState<number | null>(null);
  const [beatGrid, setBeatGrid] = useState<BeatGrid | null>(null);
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
      setBeatGrid(null);
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
      setBeatGrid(cached.beatGrid);
      setSections(cached.sections);
      setDrops(cached.drops);
      return;
    }

    setLoading(true);
    supabase
      .from("song_analysis")
      .select("id, energy_curve, recorded_volume, agc_state, bpm, sections, drops, beat_grid")
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
        let savedBeatGrid = (data as any)?.beat_grid as BeatGrid | null;

        // Estimate BPM if not saved yet
        if (!savedBpm && valid) {
          savedBpm = estimateBpm(valid);
          if (savedBpm && songId) {
            supabase.from("song_analysis").update({ bpm: savedBpm } as any).eq("id", songId)
              .then(() => console.log("[EnergyCurve] saved BPM", savedBpm));
          }
        }

        // Extract beat grid if not saved yet
        if (!savedBeatGrid && valid && savedBpm) {
          savedBeatGrid = buildBeatGrid(valid, savedBpm);
          if (savedBeatGrid && songId) {
            supabase.from("song_analysis").update({ beat_grid: savedBeatGrid as any } as any).eq("id", songId)
              .then(() => console.log("[EnergyCurve] saved beat grid", savedBeatGrid!.beats.length, "beats"));
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

        const entry: CacheEntry = {
          curve: valid, vol: vol ?? null, agc: agc ?? null,
          bpm: savedBpm, beatGrid: savedBeatGrid, sections: savedSections,
          drops: savedDrops, songId,
        };
        curveCache.set(key, entry);
        setCurve(valid);
        setRecordedVolume(vol ?? null);
        setSavedAgcState(agc ?? null);
        setBpm(savedBpm);
        setBeatGrid(savedBeatGrid);
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

  const triggerAutoCalibration = async () => {
    try {
      const { data: allSongs } = await supabase
        .from("song_analysis")
        .select("track_name, artist_name, energy_curve")
        .not("energy_curve", "is", null);

      const valid = (allSongs ?? []).filter(
        (s: any) => Array.isArray(s.energy_curve) && s.energy_curve.length > 50,
      );
      if (valid.length === 0) return;

      const inputs = valid.map((s: any) => ({
        trackName: s.track_name,
        artistName: s.artist_name,
        energyCurve: s.energy_curve,
      }));

      const result = runMultiSongCalibration(inputs);
      if (result.perSong.length === 0) return;

      const cal = getCalibration();
      const updated = {
        ...cal,
        attackAlpha: result.attackAlpha,
        releaseAlpha: result.releaseAlpha,
        dynamicDamping: result.dynamicDamping,
      };
      saveCalibration(updated, getActiveDeviceName() ?? undefined);
      console.log('[AutoCalibrate] ✓ dynamics updated from', result.perSong.length, 'songs →',
        'attack:', result.attackAlpha, 'release:', result.releaseAlpha, 'damping:', result.dynamicDamping);
    } catch (e) {
      console.error('[AutoCalibrate] error', e);
    }
  };

  const saveCurve = useCallback(
    (
      samples: EnergySample[],
      volume: number | null,
      agcState?: AgcState | null,
      trackOverride?: TrackKey | null,
    ) => {
      const targetTrack = trackOverride ?? track;
      if (!targetTrack || samples.length < 10) return;

      const key = cacheKey(targetTrack);
      const newBpm = estimateBpm(samples);
      const newDrops = detectDrops(samples);
      const newBeatGrid = newBpm ? buildBeatGrid(samples, newBpm) : null;
      const cached = curveCache.get(key);

      curveCache.set(key, {
        curve: samples, vol: volume, agc: agcState ?? null,
        bpm: newBpm, beatGrid: newBeatGrid, sections: cached?.sections ?? null,
        drops: newDrops.length > 0 ? newDrops : null, songId: cached?.songId ?? null,
      });

      const currentKey = track ? cacheKey(track) : null;
      if (!currentKey || currentKey === key) {
        setCurve(samples);
        setRecordedVolume(volume);
        if (agcState) setSavedAgcState(agcState);
        if (newBpm) setBpm(newBpm);
        if (newBeatGrid) setBeatGrid(newBeatGrid);
        if (newDrops.length > 0) setDrops(newDrops);
      }

      supabase
        .from("song_analysis")
        .select("id")
        .eq("track_name", targetTrack.trackName)
        .eq("artist_name", targetTrack.artistName)
        .maybeSingle()
        .then(({ data: existing }) => {
          const payload = {
            energy_curve: samples as any,
            recorded_volume: volume,
            ...(agcState ? { agc_state: agcState as any } : {}),
            ...(newBpm ? { bpm: newBpm } : {}),
            ...(newDrops.length > 0 ? { drops: newDrops as any } : {}),
            ...(newBeatGrid ? { beat_grid: newBeatGrid as any } : {}),
          } as any;

          if (existing) {
            supabase
              .from("song_analysis")
              .update(payload)
              .eq("id", existing.id)
              .then(() => {
                console.log("[EnergyCurve] updated", targetTrack.trackName);
                if (!cached?.sections) triggerSectionAnalysis(existing.id, key);
                triggerAutoCalibration();
              });
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
                console.log("[EnergyCurve] inserted", targetTrack.trackName);
                if (inserted?.id) {
                  const c = curveCache.get(key);
                  if (c) curveCache.set(key, { ...c, songId: inserted.id });
                  triggerSectionAnalysis(inserted.id, key);
                }
                triggerAutoCalibration();
              });
          }
        });
    },
    [track, triggerSectionAnalysis, triggerAutoCalibration],
  );

  return { curve, recordedVolume, savedAgcState, bpm, beatGrid, sections, drops, loading, saveCurve };
}
