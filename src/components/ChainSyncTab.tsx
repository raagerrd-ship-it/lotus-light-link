import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Play, Square, Check, RefreshCw, AlertTriangle } from "lucide-react";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { useSongEnergyCurve } from "@/hooks/useSongEnergyCurve";
import { interpolateSample } from "@/lib/energyInterpolate";
import { nearestBeat } from "@/lib/bpmEstimate";
import { getBleConnection } from "@/lib/bleStore";
import { sendColorAndBrightness } from "@/lib/bledom";
import { getCalibration, applyColorCalibration } from "@/lib/lightCalibration";

interface ChainSyncTabProps {
  onSave: (chainLatencyMs: number) => void;
  currentChainLatencyMs: number;
}

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
  const [saved, setSaved] = useState(false);

  const hasCurve = Array.isArray(curve) && curve.length > 10;
  const hasBeats = beatGrid && beatGrid.beats.length > 10;
  const isPlaying = nowPlaying?.playbackState?.includes('PLAYING');
  const bleConn = getBleConnection();

  // Refs for the lamp-driving rAF loop
  const curveRef = useRef(curve);
  const getPositionRef = useRef(getPosition);
  const smoothedRef = useRef(0);
  const rafRef = useRef(0);
  const lampActiveRef = useRef(false);

  useEffect(() => { curveRef.current = curve; }, [curve]);
  useEffect(() => { getPositionRef.current = getPosition; }, [getPosition]);

  // --- Lamp-driving rAF loop ---
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
          const posSec = (pos.positionMs + elapsed) / 1000;
          const sample = interpolateSample(crv, posSec);

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
    setSaved(false);
    smoothedRef.current = 0;
  }, []);

  const handleTap = useCallback(() => {
    if (phase !== 'tapping') return;
    const posSec = getSongPosSec();
    if (posSec == null || !hasBeats) return;

    const tapTime = posSec;
    const nearBeat = nearestBeat(beatGrid!.beats, tapTime);
    if (nearBeat == null) return;

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

    setResult(Math.round(finalMean));
    setPhase('done');
  }, []);

  const stopTapping = useCallback(() => {
    finishTapping(offsets);
  }, [offsets, finishTapping]);

  const handleSave = useCallback(() => {
    if (result != null) {
      onSave(result);
      setSaved(true);
    }
  }, [result, onSave]);

  // Determine readiness
  const missingBle = !bleConn;
  const missingSonos = !isPlaying;
  const missingCurve = isPlaying && !hasCurve;
  const missingBeats = hasCurve && !hasBeats;
  const ready = !missingBle && !missingSonos && hasCurve && hasBeats;

  return (
    <div className="space-y-4">
      {/* What this step does */}
      <div className="bg-secondary/50 border border-border/30 rounded-lg px-3 py-2.5">
        <p className="text-xs text-foreground/90 leading-relaxed">
          <span className="font-bold">Vad händer?</span> Lampan drivs av en inspelad låts energikurva. 
          Du tappar på skärmen i takt med lampans pulser. Skillnaden mellan dina taps och låtens beats 
          avslöjar hur mycket fördröjning det finns i hela kedjan (Sonos → BLE → lampa).
        </p>
        <p className="text-[10px] text-muted-foreground mt-1.5">
          Resultatet används som "look-ahead" — systemet skickar kommandon i förväg för att kompensera fördröjningen.
        </p>
      </div>

      {/* Prerequisite checklist */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-bold text-foreground/70 uppercase tracking-wider">Förutsättningar</p>

        <ChecklistItem
          done={!missingBle}
          label="BLE-lampa ansluten"
          detail={missingBle ? "Gå tillbaka och anslut lampan via Bluetooth-knappen" : bleConn?.device?.name ?? "Ansluten"}
        />
        <ChecklistItem
          done={!missingSonos}
          label="Sonos spelar musik"
          detail={missingSonos ? "Starta en låt på Sonos" : nowPlaying?.trackName ?? "Spelar"}
        />
        <ChecklistItem
          done={hasCurve}
          label="Inspelad energikurva finns"
          detail={missingCurve ? "Den här låten har inte spelats in ännu. Byt till en inspelad låt." : hasCurve ? `${curve!.length} samples` : "Väntar på låt…"}
          warning={missingCurve}
        />
        <ChecklistItem
          done={hasBeats ?? false}
          label="Beat grid beräknad"
          detail={missingBeats ? "Beats saknas — prova en annan inspelad låt" : hasBeats ? `${beatGrid!.beats.length} beats (${bpm} BPM)` : "Väntar…"}
          warning={missingBeats ?? false}
        />
      </div>

      {/* Lamp status */}
      {hasCurve && isPlaying && phase !== 'done' && (
        <div className="bg-primary/10 border border-primary/20 rounded-lg px-3 py-2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
          <p className="text-[10px] text-primary font-medium">
            Lampan drivs nu av energikurvan — titta på lampan, den blinkar i takt med musiken!
          </p>
        </div>
      )}

      {/* Tapping UI */}
      {phase === 'idle' && (
        <Button
          size="sm"
          onClick={startTapping}
          disabled={!ready}
          className="gap-1.5 text-xs w-full"
        >
          <Play className="w-3.5 h-3.5" /> Starta kalibrering — tappa i takt med lampan
        </Button>
      )}

      {phase === 'tapping' && (
        <div className="space-y-3">
          <button
            onClick={handleTap}
            className="w-full py-14 bg-primary/20 border-2 border-primary/40 rounded-xl text-center active:bg-primary/40 active:scale-[0.98] transition-all touch-manipulation select-none"
          >
            <p className="text-2xl font-black text-primary">TAP</p>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              Tryck varje gång lampan pulserar med ett beat
            </p>
            <div className="mt-3 flex justify-center gap-1">
              {Array.from({ length: Math.min(16, Math.max(4, taps.length + 1)) }).map((_, i) => (
                <span
                  key={i}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    i < taps.length
                      ? 'bg-primary'
                      : i < 4
                      ? 'bg-muted-foreground/30'
                      : 'bg-muted-foreground/10'
                  }`}
                />
              ))}
            </div>
            <p className="text-[10px] font-mono text-foreground/40 mt-2">
              {taps.length}/16 taps {taps.length < 4 ? `(minst ${4 - taps.length} till)` : '— tryck Stoppa när du är nöjd'}
            </p>
          </button>

          <Button
            size="sm"
            variant="secondary"
            onClick={stopTapping}
            disabled={taps.length < 4}
            className="gap-1 text-xs w-full"
          >
            <Square className="w-3 h-3" /> Stoppa och beräkna ({taps.length} taps)
          </Button>

          {/* Live offset display */}
          {offsets.length > 0 && (
            <div className="text-[10px] font-mono text-muted-foreground flex flex-wrap gap-x-2">
              {offsets.slice(-8).map((o, i) => (
                <span key={i} className={Math.abs(o) > 300 ? 'text-yellow-400' : ''}>
                  {o > 0 ? '+' : ''}{o.toFixed(0)}ms
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {phase === 'done' && result != null && (
        <div className="space-y-3">
          {/* Saved confirmation */}
          {saved && (
            <div className="bg-primary/15 border border-primary/30 rounded-lg px-3 py-2.5 flex items-center gap-2">
              <Check className="w-4 h-4 text-primary shrink-0" />
              <div>
                <p className="text-xs font-bold text-primary">Sparat!</p>
                <p className="text-[10px] text-primary/70">Kedjelatens {result}ms sparad. Systemet kompenserar nu automatiskt.</p>
              </div>
            </div>
          )}

          {!saved && (
            <div className="bg-secondary/50 border border-border/30 rounded-lg px-3 py-2.5">
              <p className="text-xs font-bold text-foreground">
                Uppmätt kedjelatens: <span className="font-mono text-primary">{result}ms</span>
              </p>
              <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Baserat på {offsets.length} taps.{' '}
                {result > 0 ? 'Lampan släpar — systemet kommer skicka kommandon i förväg.' : 
                 result < 0 ? 'Lampan är före — negativ kompensation appliceras.' : 
                 'Perfekt synk!'}
              </p>
              {currentChainLatencyMs !== 0 && (
                <p className="text-[10px] font-mono text-muted-foreground mt-1">
                  Tidigare värde: {currentChainLatencyMs}ms → Nytt: {result}ms
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            {!saved && (
              <Button size="sm" onClick={handleSave} className="text-xs gap-1 flex-1">
                <Check className="w-3.5 h-3.5" /> Spara {result}ms
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setPhase('idle'); setTaps([]); setOffsets([]); setResult(null); setSaved(false); }}
              className="text-xs gap-1 flex-1"
            >
              <RefreshCw className="w-3 h-3" /> {saved ? 'Kalibrera om' : 'Kör om'}
            </Button>
          </div>

          {/* Raw data */}
          <details className="text-[10px]">
            <summary className="text-muted-foreground cursor-pointer hover:text-foreground">Visa mätdata</summary>
            <div className="font-mono text-foreground/50 mt-1 space-y-0.5 max-h-40 overflow-y-auto">
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

      {/* Current saved value */}
      {currentChainLatencyMs !== 0 && phase === 'idle' && (
        <div className="bg-primary/5 border border-primary/15 rounded-lg px-3 py-2 flex items-center justify-between">
          <div>
            <p className="text-[10px] text-muted-foreground">Sparad kedjelatens</p>
            <p className="text-xs font-mono font-bold text-foreground">{currentChainLatencyMs}ms</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={startTapping}
            disabled={!ready}
            className="text-[10px] gap-1 h-7"
          >
            <RefreshCw className="w-3 h-3" /> Kalibrera om
          </Button>
        </div>
      )}
    </div>
  );
}

function ChecklistItem({ done, label, detail, warning = false }: { done: boolean; label: string; detail: string; warning?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-[8px] ${
        done ? 'bg-primary/20 text-primary' : warning ? 'bg-yellow-500/20 text-yellow-400' : 'bg-muted-foreground/10 text-muted-foreground/40'
      }`}>
        {done ? '✓' : warning ? '!' : '○'}
      </span>
      <div className="min-w-0">
        <p className={`text-[11px] font-medium ${done ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</p>
        <p className={`text-[10px] ${done ? 'text-muted-foreground' : warning ? 'text-yellow-400/80' : 'text-muted-foreground/60'}`}>{detail}</p>
      </div>
    </div>
  );
}
