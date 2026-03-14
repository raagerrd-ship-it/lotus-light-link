import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Play, Square, Check, RefreshCw } from "lucide-react";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { useSongEnergyCurve } from "@/hooks/useSongEnergyCurve";
import { interpolateSample, curvePeakRms } from "@/lib/energyInterpolate";
import { nearestBeat } from "@/lib/bpmEstimate";
import { getBleConnection } from "@/lib/bleStore";
import { sendColorAndBrightness } from "@/lib/bledom";
import { getCalibration, applyColorCalibration } from "@/lib/lightCalibration";

interface ChainSyncTabProps {
  onSave: (chainLatencyMs: number) => void;
  currentChainLatencyMs: number;
}

/**
 * Chain Sync Calibration: measures total latency from Sonos timestamp → visible light.
 *
 * Flow:
 * 1. Play a recorded song on Sonos (system detects it automatically)
 * 2. System drives lamp from saved energy curve (WITHOUT chainLatencyMs compensation)
 * 3. User taps screen in sync with lamp flashes/beats
 * 4. System compares tap timestamps with curve beat positions
 * 5. Difference = total chain latency
 */
export default function ChainSyncTab({ onSave, currentChainLatencyMs }: ChainSyncTabProps) {
  const { nowPlaying, getPosition } = useSonosNowPlaying();
  const track = nowPlaying?.trackName && nowPlaying?.artistName
    ? { trackName: nowPlaying.trackName, artistName: nowPlaying.artistName }
    : null;
  const { curve, beatGrid, bpm } = useSongEnergyCurve(track);

  const [phase, setPhase] = useState<'idle' | 'tapping' | 'done'>('idle');
  const [taps, setTaps] = useState<number[]>([]);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [result, setResult] = useState<number | null>(null);

  const hasCurve = Array.isArray(curve) && curve.length > 10;
  const hasBeats = beatGrid && beatGrid.beats.length > 10;
  const isPlaying = nowPlaying?.playbackState?.includes('PLAYING');

  // Refs for the lamp-driving rAF loop
  const curveRef = useRef(curve);
  const getPositionRef = useRef(getPosition);
  const smoothedRef = useRef(0);
  const rafRef = useRef(0);
  const lampActiveRef = useRef(false);

  useEffect(() => { curveRef.current = curve; }, [curve]);
  useEffect(() => { getPositionRef.current = getPosition; }, [getPosition]);

  // --- Lamp-driving rAF loop ---
  // Drives the BLE lamp from the energy curve WITHOUT chainLatencyMs compensation
  // so the user can measure the actual delay by tapping.
  useEffect(() => {
    const shouldDrive = hasCurve && isPlaying && (phase === 'tapping' || phase === 'idle');
    lampActiveRef.current = shouldDrive;
    if (!shouldDrive) return;

    const cal = getCalibration();

    const loop = () => {
      if (!lampActiveRef.current) return;

      const conn = getBleConnection();
      const c = conn?.characteristic;
      const crv = curveRef.current;
      const gp = getPositionRef.current;

      if (c && crv && crv.length > 10 && gp) {
        const pos = gp();
        if (pos) {
          const elapsed = performance.now() - pos.receivedAt;
          // NO chainLatencyMs here — that's what we're measuring!
          const posSec = (pos.positionMs + elapsed) / 1000;
          const sample = interpolateSample(crv, posSec);

          // Simple smoothing
          const prev = smoothedRef.current;
          const alpha = sample.e > prev ? cal.attackAlpha : cal.releaseAlpha;
          const smoothed = prev + alpha * (sample.e - prev);
          smoothedRef.current = smoothed;

          const pct = Math.round(cal.minBrightness + smoothed * (cal.maxBrightness - cal.minBrightness));
          const clampedPct = Math.max(0, Math.min(100, pct));

          const baseColor: [number, number, number] = [255, 180, 100];
          const calibrated = applyColorCalibration(...baseColor, cal);
          sendColorAndBrightness(c, ...calibrated, clampedPct);
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      lampActiveRef.current = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [hasCurve, isPlaying, phase]);

  const getSongPosSec = useCallback((): number | null => {
    const pos = getPosition();
    if (!pos) return null;
    const elapsed = performance.now() - pos.receivedAt;
    return (pos.positionMs + elapsed) / 1000;
  }, [getPosition]);

  const startTapping = useCallback(() => {
    setPhase('tapping');
    setTaps([]);
    setOffsets([]);
    setResult(null);
    smoothedRef.current = 0;
  }, []);

  const handleTap = useCallback(() => {
    if (phase !== 'tapping') return;
    const posSec = getSongPosSec();
    if (posSec == null || !hasBeats) return;

    const tapTime = posSec;
    const nearBeat = nearestBeat(beatGrid!.beats, tapTime);
    if (nearBeat == null) return;

    // Positive means user tapped late = light is late = need more look-ahead
    const offsetMs = (tapTime - nearBeat) * 1000;
    if (Math.abs(offsetMs) > 500) return;

    const newTaps = [...taps, tapTime];
    const newOffsets = [...offsets, offsetMs];
    setTaps(newTaps);
    setOffsets(newOffsets);

    if (newTaps.length >= 16) {
      finishTapping(newOffsets);
    }
  }, [phase, getSongPosSec, hasBeats, beatGrid, taps, offsets]);

  const finishTapping = useCallback((offs: number[]) => {
    if (offs.length < 4) {
      setPhase('idle');
      return;
    }
    const mean = offs.reduce((a, b) => a + b, 0) / offs.length;
    const std = Math.sqrt(offs.reduce((a, b) => a + (b - mean) ** 2, 0) / offs.length);
    const filtered = std > 0 ? offs.filter(o => Math.abs(o - mean) <= 2 * std) : offs;

    const finalMean = filtered.length > 0
      ? filtered.reduce((a, b) => a + b, 0) / filtered.length
      : mean;

    const chainMs = Math.round(finalMean);
    setResult(chainMs);
    setPhase('done');
  }, []);

  const stopTapping = useCallback(() => {
    finishTapping(offsets);
  }, [offsets, finishTapping]);

  const handleSave = useCallback(() => {
    if (result != null) {
      onSave(result);
    }
  }, [result, onSave]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Mäter total fördröjning från Sonos-tidsstämpel till synligt ljus. Spela en <span className="font-semibold text-foreground">inspelad låt</span> på Sonos och tappa i takt med lampans beats.
      </p>

      {/* Status indicators */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className={`w-1.5 h-1.5 rounded-full ${isPlaying ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
          <span className="text-muted-foreground">Sonos:</span>
          <span className={isPlaying ? 'text-foreground' : 'text-muted-foreground'}>
            {nowPlaying?.trackName ? `${nowPlaying.trackName}` : 'Ingen låt'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className={`w-1.5 h-1.5 rounded-full ${hasCurve ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
          <span className="text-muted-foreground">Kurva:</span>
          <span className={hasCurve ? 'text-foreground' : 'text-muted-foreground'}>
            {hasCurve ? `${curve!.length} samples` : 'Ej inspelad'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className={`w-1.5 h-1.5 rounded-full ${hasBeats ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
          <span className="text-muted-foreground">Beat grid:</span>
          <span className={hasBeats ? 'text-foreground' : 'text-muted-foreground'}>
            {hasBeats ? `${beatGrid!.beats.length} beats (${bpm} BPM)` : 'Saknas'}
          </span>
        </div>
        {hasCurve && isPlaying && (
          <div className="flex items-center gap-2 text-[10px] font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span className="text-primary">Lampan drivs från kurvan (utan kompensation)</span>
          </div>
        )}
      </div>

      {!hasCurve && isPlaying && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
          <p className="text-[10px] text-destructive">
            Den här låten har ingen inspelad energikurva. Spela en låt som redan spelats in (se "Inspelningar"-fliken).
          </p>
        </div>
      )}

      {!hasBeats && hasCurve && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-md px-3 py-2">
          <p className="text-[10px] text-yellow-400">
            Beat grid saknas för den här låten. Beats beräknas automatiskt — prova en annan inspelad låt.
          </p>
        </div>
      )}

      {/* Tapping UI */}
      {phase === 'idle' && (
        <Button
          size="sm"
          onClick={startTapping}
          disabled={!hasCurve || !hasBeats || !isPlaying}
          className="gap-1.5 text-xs"
        >
          <Play className="w-3 h-3" /> Starta tapping
        </Button>
      )}

      {phase === 'tapping' && (
        <div className="space-y-3">
          <button
            onClick={handleTap}
            className="w-full py-12 bg-primary/20 border-2 border-primary/40 rounded-xl text-center active:bg-primary/40 transition-colors touch-manipulation"
          >
            <p className="text-lg font-bold text-primary">TAP</p>
            <p className="text-xs text-muted-foreground mt-1">
              Tappa i takt med lampans beats
            </p>
            <p className="text-[10px] font-mono text-foreground/50 mt-2">
              {taps.length} taps {taps.length >= 4 ? '(min 4)' : `(behöver ${4 - taps.length} till)`}
            </p>
          </button>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={stopTapping}
              disabled={taps.length < 4}
              className="gap-1 text-xs"
            >
              <Square className="w-3 h-3" /> Stoppa ({taps.length} taps)
            </Button>
          </div>

          {/* Live offset display */}
          {offsets.length > 0 && (
            <div className="text-[10px] font-mono text-muted-foreground space-y-0.5">
              {offsets.slice(-6).map((o, i) => (
                <span key={i} className="mr-2">
                  {o > 0 ? '+' : ''}{o.toFixed(0)}ms
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {phase === 'done' && result != null && (
        <div className="space-y-3">
          <div className="bg-primary/10 border border-primary/20 rounded-md px-3 py-2">
            <p className="text-xs font-bold text-primary">
              Kedjelatens: <span className="font-mono">{result}ms</span>
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Baserat på {offsets.length} taps. {result > 0 ? 'Lampan släpar — look-ahead appliceras.' : result < 0 ? 'Lampan är före — negativ kompensation.' : 'Perfekt synk!'}
            </p>
          </div>

          {currentChainLatencyMs !== 0 && (
            <p className="text-[10px] font-mono text-muted-foreground">
              Nuvarande: {currentChainLatencyMs}ms → Nytt: {result}ms
            </p>
          )}

          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} className="text-xs gap-1">
              <Check className="w-3 h-3" /> Spara ({result}ms)
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setPhase('idle'); setTaps([]); setOffsets([]); setResult(null); }} className="text-xs gap-1">
              <RefreshCw className="w-3 h-3" /> Kör om
            </Button>
          </div>

          {/* Raw data */}
          <details className="text-[10px]">
            <summary className="text-muted-foreground cursor-pointer">Visa rådata</summary>
            <div className="font-mono text-foreground/50 mt-1 space-y-0.5">
              {offsets.map((o, i) => (
                <div key={i} className="flex justify-between">
                  <span>Tap {i + 1}</span>
                  <span className={Math.abs(o) > 200 ? 'text-yellow-400' : ''}>{o > 0 ? '+' : ''}{o.toFixed(1)}ms</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Current value */}
      {currentChainLatencyMs !== 0 && phase === 'idle' && (
        <div className="border border-border/30 rounded-md px-3 py-2">
          <p className="text-[10px] font-mono text-muted-foreground">
            Sparad kedjelatens: <span className="text-foreground font-bold">{currentChainLatencyMs}ms</span>
          </p>
        </div>
      )}
    </div>
  );
}
