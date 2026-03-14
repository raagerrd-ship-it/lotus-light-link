import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Play, Check, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { runMultiSongCalibration, type SongInput, type MultiSongCalibrationResult } from "@/lib/autoCalibrate";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { useSongEnergyCurve } from "@/hooks/useSongEnergyCurve";
import { interpolateSample } from "@/lib/energyInterpolate";
import { getBleConnection } from "@/lib/bleStore";
import { sendColorAndBrightness } from "@/lib/bledom";
import { getCalibration, type LightCalibration } from "@/lib/lightCalibration";
import { applyColorCalibration } from "@/lib/lightCalibration";

interface SongCalibrationTabProps {
  cal: LightCalibration;
  onSave: (patch: Partial<LightCalibration>) => void;
}

interface RecordedSong {
  id: string;
  track_name: string;
  artist_name: string;
  energy_curve: any;
  recorded_volume: number | null;
}

type FeedbackKey = 'slow' | 'flicker' | 'dark' | 'bright' | 'aggressive';

const FEEDBACK_BUTTONS: { key: FeedbackKey; label: string; desc: string }[] = [
  { key: 'slow', label: '⏳ För långsamt', desc: 'Lampan reagerar för långsamt på beats' },
  { key: 'flicker', label: '⚡ Flimrar', desc: 'Lampan flimrar/blinkar ojämnt' },
  { key: 'dark', label: '🌑 Tysta delar för mörka', desc: 'Lampan är för mörk under lugna delar' },
  { key: 'bright', label: '☀️ Tysta delar för ljusa', desc: 'Lampan är för ljus under lugna delar' },
  { key: 'aggressive', label: '💥 För aggressivt', desc: 'Ljuset hoppar för mycket' },
];

function applyFeedback(
  params: { attackAlpha: number; releaseAlpha: number; minBrightness: number; maxBrightness: number },
  key: FeedbackKey,
): typeof params {
  const p = { ...params };
  switch (key) {
    case 'slow':
      p.attackAlpha = Math.min(0.9, p.attackAlpha + 0.08);
      break;
    case 'flicker':
      p.attackAlpha = Math.max(0.05, p.attackAlpha - 0.08);
      p.releaseAlpha = Math.min(0.3, p.releaseAlpha + 0.02);
      break;
    case 'dark':
      p.minBrightness = Math.min(30, p.minBrightness + 3);
      break;
    case 'bright':
      p.minBrightness = Math.max(0, p.minBrightness - 3);
      break;
    case 'aggressive':
      p.attackAlpha = Math.max(0.05, p.attackAlpha - 0.05);
      p.releaseAlpha = Math.min(0.3, p.releaseAlpha + 0.015);
      break;
  }
  return p;
}

export default function SongCalibrationTab({ cal, onSave }: SongCalibrationTabProps) {
  const [songs, setSongs] = useState<RecordedSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [calibResult, setCalibResult] = useState<MultiSongCalibrationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [showPerSong, setShowPerSong] = useState(false);
  const [saved, setSaved] = useState(false);

  // Live params (adjusted by feedback)
  const [liveParams, setLiveParams] = useState({
    attackAlpha: cal.attackAlpha,
    releaseAlpha: cal.releaseAlpha,
    minBrightness: cal.minBrightness,
    maxBrightness: cal.maxBrightness,
  });
  const liveParamsRef = useRef(liveParams);
  useEffect(() => { liveParamsRef.current = liveParams; }, [liveParams]);

  // Live preview state
  const [previewActive, setPreviewActive] = useState(false);
  const previewActiveRef = useRef(false);
  const rafRef = useRef(0);
  const smoothedRef = useRef(0);

  const { nowPlaying, getPosition } = useSonosNowPlaying();
  const track = nowPlaying?.trackName && nowPlaying?.artistName
    ? { trackName: nowPlaying.trackName, artistName: nowPlaying.artistName }
    : null;
  const { curve } = useSongEnergyCurve(track);
  const curveRef = useRef(curve);
  useEffect(() => { curveRef.current = curve; }, [curve]);
  const getPositionRef = useRef(getPosition);
  useEffect(() => { getPositionRef.current = getPosition; }, [getPosition]);

  const isPlaying = nowPlaying?.playbackState?.includes('PLAYING');
  const hasCurve = Array.isArray(curve) && curve.length > 10;
  const chainMissing = cal.chainLatencyMs === 0;

  // Fetch recorded songs
  useEffect(() => {
    supabase
      .from("song_analysis")
      .select("id, track_name, artist_name, energy_curve, recorded_volume")
      .not("energy_curve", "is", null)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setSongs((data ?? []) as RecordedSong[]);
        setLoading(false);
      });
  }, []);

  // Run offline calibration
  const runCalibration = useCallback(() => {
    if (songs.length === 0) return;
    setRunning(true);
    setSaved(false);

    const run = () => {
      const inputs: SongInput[] = songs
        .filter(s => Array.isArray(s.energy_curve) && s.energy_curve.length > 50)
        .map(s => ({
          trackName: s.track_name,
          artistName: s.artist_name,
          energyCurve: s.energy_curve,
        }));

      const result = runMultiSongCalibration(inputs);
      setCalibResult(result);
      setLiveParams({
        attackAlpha: result.attackAlpha,
        releaseAlpha: result.releaseAlpha,
        minBrightness: cal.minBrightness,
        maxBrightness: cal.maxBrightness,
      });
      setRunning(false);
    };

    if ('requestIdleCallback' in window) {
      requestIdleCallback(run);
    } else {
      setTimeout(run, 50);
    }
  }, [songs, cal.minBrightness, cal.maxBrightness]);

  // Live preview: drive lamp from curve with current liveParams
  useEffect(() => {
    previewActiveRef.current = previewActive;
    if (!previewActive) return;

    const calBase = getCalibration();

    const loop = () => {
      if (!previewActiveRef.current) return;
      const conn = getBleConnection();
      const c = conn?.characteristic;
      const crv = curveRef.current;
      const gp = getPositionRef.current;
      const params = liveParamsRef.current;

      if (c && crv && crv.length > 10 && gp) {
        const pos = gp();
        if (pos) {
          const elapsed = performance.now() - pos.receivedAt;
          const posSec = (pos.positionMs + elapsed + (calBase.chainLatencyMs || 0)) / 1000;
          const sample = interpolateSample(crv, posSec);

          const prev = smoothedRef.current;
          const alpha = sample.e > prev ? params.attackAlpha : params.releaseAlpha;
          const smoothed = prev + alpha * (sample.e - prev);
          smoothedRef.current = smoothed;

          const pct = Math.round(params.minBrightness + smoothed * (params.maxBrightness - params.minBrightness));
          const clampedPct = Math.max(0, Math.min(100, pct));

          const baseColor = [calBase.gammaR !== 1 ? 200 : 255, 150, 80] as [number, number, number];
          const calibrated = applyColorCalibration(...baseColor, calBase);
          sendColorAndBrightness(c, ...calibrated, clampedPct);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [previewActive]);

  const handleFeedback = useCallback((key: FeedbackKey) => {
    setLiveParams(prev => applyFeedback(prev, key));
    setSaved(false);
  }, []);

  const handleSave = useCallback(() => {
    onSave({
      attackAlpha: liveParams.attackAlpha,
      releaseAlpha: liveParams.releaseAlpha,
      minBrightness: liveParams.minBrightness,
      maxBrightness: liveParams.maxBrightness,
      ...(calibResult?.dynamicDamping != null ? { dynamicDamping: calibResult.dynamicDamping } : {}),
    });
    setSaved(true);
    setPreviewActive(false);
  }, [liveParams, calibResult, onSave]);

  const handleReset = useCallback(() => {
    if (calibResult) {
      setLiveParams({
        attackAlpha: calibResult.attackAlpha,
        releaseAlpha: calibResult.releaseAlpha,
        minBrightness: cal.minBrightness,
        maxBrightness: cal.maxBrightness,
      });
      setSaved(false);
    }
  }, [calibResult, cal.minBrightness, cal.maxBrightness]);

  const validSongs = songs.filter(s => Array.isArray(s.energy_curve) && s.energy_curve.length > 50);
  const hasChanges = liveParams.attackAlpha !== cal.attackAlpha || liveParams.releaseAlpha !== cal.releaseAlpha ||
    liveParams.minBrightness !== cal.minBrightness || liveParams.maxBrightness !== cal.maxBrightness;

  return (
    <div className="space-y-4">
      {/* What this step does */}
      <div className="bg-secondary/50 border border-border/30 rounded-lg px-3 py-2.5">
        <p className="text-xs text-foreground/90 leading-relaxed">
          <span className="font-bold">Vad händer?</span> Systemet analyserar alla inspelade låtars energikurvor 
          och beräknar optimala parametrar för hur snabbt lampan ska reagera. Sedan kan du finjustera med 
          live-preview och feedback.
        </p>
      </div>

      {/* Chain latency warning */}
      {chainMissing && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2.5">
          <p className="text-xs text-yellow-400 font-bold">⚠ Kedjelatens ej kalibrerad</p>
          <p className="text-[10px] text-yellow-400/80 mt-0.5 leading-relaxed">
            Gå till <span className="font-bold">Steg 2 (Synk)</span> och kalibrera kedjelatens först — 
            annars kommer live-preview inte vara i takt med lampan.
          </p>
        </div>
      )}

      {/* Step 1: Offline calibration */}
      <div className="space-y-2">
        <p className="text-[10px] font-bold text-foreground/70 uppercase tracking-wider">
          Steg A — Analysera inspelade låtar
        </p>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Beräknar bästa attack/release-parametrar baserat på alla låtars dynamik. Ju fler låtar, desto bättre.
        </p>

        {loading ? (
          <p className="text-xs text-muted-foreground">Laddar inspelade låtar…</p>
        ) : validSongs.length === 0 ? (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2.5">
            <p className="text-xs text-destructive font-medium">Inga inspelade låtar</p>
            <p className="text-[10px] text-destructive/70 mt-0.5">
              Gå tillbaka till huvudvyn och spela musik med mikrofonen aktiv. Energikurvan sparas automatiskt 
              när hela låten har spelats.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[10px] text-muted-foreground">
              {validSongs.length} låt{validSongs.length !== 1 ? 'ar' : ''} redo att analyseras
            </p>
            <Button
              size="sm"
              onClick={runCalibration}
              disabled={running}
              className="gap-1.5 text-xs w-full"
            >
              {running ? (
                <><RefreshCw className="w-3 h-3 animate-spin" /> Analyserar {validSongs.length} låtar…</>
              ) : (
                <><Play className="w-3.5 h-3.5" /> {calibResult ? 'Kör om analys' : 'Analysera alla låtar'}</>
              )}
            </Button>
          </div>
        )}

        {calibResult && (
          <div className="bg-primary/10 border border-primary/20 rounded-lg px-3 py-2.5 space-y-1.5">
            <p className="text-[10px] font-bold text-primary">
              ✓ Beräknade parametrar (median av {calibResult.perSong.length} låtar)
            </p>
            <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
              <div>
                <span className="text-muted-foreground">Attack</span>
                <p className="text-foreground font-bold">{calibResult.attackAlpha}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Release</span>
                <p className="text-foreground font-bold">{calibResult.releaseAlpha}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Damping</span>
                <p className="text-foreground font-bold">{calibResult.dynamicDamping}</p>
              </div>
            </div>

            <button
              onClick={() => setShowPerSong(!showPerSong)}
              className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 mt-1"
            >
              {showPerSong ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Visa per-låt-resultat
            </button>
            {showPerSong && (
              <div className="space-y-0.5 mt-1">
                {calibResult.perSong.map((r, i) => (
                  <div key={i} className="flex justify-between text-[10px] font-mono">
                    <span className="text-foreground/70 truncate flex-1 mr-2">{r.trackName}</span>
                    <span className="text-muted-foreground shrink-0">
                      a:{r.attackAlpha} r:{r.releaseAlpha}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 2: Live preview + feedback */}
      {calibResult && (
        <div className="space-y-3 border-t border-border/20 pt-3">
          <p className="text-[10px] font-bold text-foreground/70 uppercase tracking-wider">
            Steg B — Live-preview & finjustering
          </p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Spela en inspelad låt på Sonos och starta preview. Lampan drivs med de nya parametrarna. 
            Tryck på feedback-knapparna för att finjustera tills du är nöjd.
          </p>

          {/* Current playing status */}
          <div className="flex items-center gap-2 text-[10px] font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${isPlaying && hasCurve ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
            <span className="text-muted-foreground">Sonos:</span>
            <span className={isPlaying ? 'text-foreground' : 'text-muted-foreground'}>
              {nowPlaying?.trackName ?? 'Ingen låt spelar'}
              {isPlaying && !hasCurve && ' (ej inspelad — byt låt)'}
            </span>
          </div>

          <Button
            size="sm"
            variant={previewActive ? 'secondary' : 'default'}
            onClick={() => {
              setPreviewActive(!previewActive);
              smoothedRef.current = 0;
            }}
            disabled={!isPlaying || !hasCurve || chainMissing}
            className="gap-1.5 text-xs w-full"
          >
            {previewActive ? '⏸ Stoppa preview' : '▶ Starta live-preview'}
          </Button>

          {!isPlaying && (
            <p className="text-[10px] text-muted-foreground">
              Starta en inspelad låt på Sonos för att aktivera live-preview.
            </p>
          )}

          {/* Live params display */}
          <div className="bg-secondary/50 border border-border/30 rounded-lg px-3 py-2">
            <p className="text-[10px] font-bold text-foreground/70 mb-1">Aktiva parametrar</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] font-mono">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Attack α</span>
                <span className={liveParams.attackAlpha !== cal.attackAlpha ? 'text-primary font-bold' : 'text-foreground'}>
                  {liveParams.attackAlpha.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Release α</span>
                <span className={liveParams.releaseAlpha !== cal.releaseAlpha ? 'text-primary font-bold' : 'text-foreground'}>
                  {liveParams.releaseAlpha.toFixed(3)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Min ljus</span>
                <span className={liveParams.minBrightness !== cal.minBrightness ? 'text-primary font-bold' : 'text-foreground'}>
                  {liveParams.minBrightness}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Max ljus</span>
                <span className={liveParams.maxBrightness !== cal.maxBrightness ? 'text-primary font-bold' : 'text-foreground'}>
                  {liveParams.maxBrightness}%
                </span>
              </div>
            </div>
          </div>

          {/* Feedback buttons */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold text-foreground/70">Ser det inte bra ut? Tryck på det som stämmer:</p>
            <div className="flex flex-wrap gap-1.5">
              {FEEDBACK_BUTTONS.map(fb => (
                <button
                  key={fb.key}
                  onClick={() => handleFeedback(fb.key)}
                  className="px-2.5 py-1.5 rounded-md text-[10px] font-medium bg-secondary hover:bg-accent text-secondary-foreground transition-colors active:scale-95"
                  title={fb.desc}
                >
                  {fb.label}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-muted-foreground/60">
              Varje tryck justerar parametrarna direkt — du ser effekten live om preview är igång.
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {saved ? (
              <div className="bg-primary/15 border border-primary/30 rounded-lg px-3 py-2.5 flex items-center gap-2 flex-1">
                <Check className="w-4 h-4 text-primary shrink-0" />
                <div>
                  <p className="text-xs font-bold text-primary">Sparat!</p>
                  <p className="text-[10px] text-primary/70">Dynamikparametrarna är uppdaterade.</p>
                </div>
              </div>
            ) : (
              <Button size="sm" onClick={handleSave} className="gap-1 text-xs flex-1" disabled={!hasChanges && !calibResult}>
                <Check className="w-3.5 h-3.5" /> Spara parametrar
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={handleReset} className="gap-1 text-xs" disabled={!calibResult}>
              <RefreshCw className="w-3 h-3" /> Återställ
            </Button>
          </div>

          {saved && hasChanges && (
            <Button size="sm" onClick={handleSave} className="gap-1 text-xs w-full">
              <Check className="w-3.5 h-3.5" /> Spara nya ändringar
            </Button>
          )}

          {/* Comparison */}
          {hasChanges && !saved && (
            <div className="text-[10px] font-mono text-muted-foreground border-t border-border/20 pt-2 space-y-0.5">
              <p className="font-bold text-foreground/70">Ändringar jämfört med sparade värden</p>
              {liveParams.attackAlpha !== cal.attackAlpha && (
                <div className="flex justify-between">
                  <span>Attack α</span>
                  <span>{cal.attackAlpha.toFixed(2)} → <span className="text-primary">{liveParams.attackAlpha.toFixed(2)}</span></span>
                </div>
              )}
              {liveParams.releaseAlpha !== cal.releaseAlpha && (
                <div className="flex justify-between">
                  <span>Release α</span>
                  <span>{cal.releaseAlpha.toFixed(3)} → <span className="text-primary">{liveParams.releaseAlpha.toFixed(3)}</span></span>
                </div>
              )}
              {liveParams.minBrightness !== cal.minBrightness && (
                <div className="flex justify-between">
                  <span>Min ljus</span>
                  <span>{cal.minBrightness}% → <span className="text-primary">{liveParams.minBrightness}%</span></span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
