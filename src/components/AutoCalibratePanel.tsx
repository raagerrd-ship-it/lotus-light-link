import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Play, Square, Check, AlertTriangle } from "lucide-react";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { supabase } from "@/integrations/supabase/client";
import {
  runAutoCalibration,
  type EnergySample,
  type MicSample,
  type CalibrationResult,
} from "@/lib/autoCalibrate";
import {
  getCalibration,
  saveCalibration,
  type LightCalibration,
} from "@/lib/lightCalibration";

type Phase = "idle" | "fetching" | "ready" | "listening" | "analyzing" | "done" | "error";

interface AutoCalibratePanelProps {
  cal: LightCalibration;
  onUpdate: (patch: Partial<LightCalibration>) => void;
}

export default function AutoCalibratePanel({ cal, onUpdate }: AutoCalibratePanelProps) {
  const { nowPlaying } = useSonosNowPlaying();
  const [phase, setPhase] = useState<Phase>("idle");
  const [energyCurve, setEnergyCurve] = useState<EnergySample[] | null>(null);
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [micSamples, setMicSamples] = useState<MicSample[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const samplesRef = useRef<MicSample[]>([]);
  const startTimeRef = useRef(0);
  const songStartSecRef = useRef(0);

  const LISTEN_DURATION_SEC = 30;

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const track = nowPlaying?.trackName;
  const artist = nowPlaying?.artistName;

  // Fetch energy curve from edge function
  const fetchEnergyCurve = useCallback(async () => {
    if (!track) return;
    setPhase("fetching");
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("song-analysis", {
        body: { track, artist: artist || "", includeEnergyCurve: true },
      });
      if (fnErr) throw new Error(fnErr.message);
      if (!data?.energy_curve || !Array.isArray(data.energy_curve)) {
        throw new Error("Ingen energikurva returnerad från AI");
      }
      setEnergyCurve(data.energy_curve as EnergySample[]);
      setPhase("ready");
    } catch (e: any) {
      setError(e.message || "Kunde inte hämta energikurva");
      setPhase("error");
    }
  }, [track, artist]);

  // Stop listening
  const stopListening = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close();
    streamRef.current = null;
    ctxRef.current = null;
  }, []);

  // Start listening
  const startListening = useCallback(async () => {
    if (!energyCurve || !nowPlaying) return;
    setPhase("listening");
    setProgress(0);
    samplesRef.current = [];
    setMicSamples([]);

    // Calculate current song position
    const posMs = nowPlaying.positionMs ?? 0;
    const elapsed = (performance.now() - nowPlaying.receivedAt);
    const currentPosSec = (posMs + elapsed) / 1000;
    songStartSecRef.current = currentPosSec;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 8000 });
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);

      streamRef.current = stream;
      ctxRef.current = ctx;
      startTimeRef.current = performance.now();

      const td = new Uint8Array(analyser.fftSize);
      const sampleInterval = 50; // ms between samples
      let lastSampleTime = 0;

      const tick = () => {
        const now = performance.now();
        const elapsedMs = now - startTimeRef.current;
        const elapsedSec = elapsedMs / 1000;

        setProgress(Math.min(1, elapsedSec / LISTEN_DURATION_SEC));

        if (elapsedSec >= LISTEN_DURATION_SEC) {
          stopListening();
          const samples = samplesRef.current;
          setMicSamples(samples);
          // Analyze
          setPhase("analyzing");
          setTimeout(() => {
            const res = runAutoCalibration(energyCurve, samples);
            setResult(res);
            setPhase("done");
          }, 100);
          return;
        }

        // Sample RMS
        if (now - lastSampleTime >= sampleInterval) {
          lastSampleTime = now;
          analyser.getByteTimeDomainData(td);
          let sum = 0;
          for (let i = 0; i < td.length; i++) {
            const v = (td[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / td.length);
          const songT = songStartSecRef.current + elapsedSec;
          samplesRef.current.push({ t: songT, rms });
        }

        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    } catch {
      setError("Kunde inte starta mikrofonen");
      setPhase("error");
    }
  }, [energyCurve, nowPlaying, stopListening]);

  // Apply result
  const applyResult = useCallback(() => {
    if (!result) return;
    onUpdate({
      latencyOffsetMs: result.latencyMs,
      attackAlpha: result.attackAlpha,
      releaseAlpha: result.releaseAlpha,
      dynamicDamping: result.dynamicDamping,
    });
    setPhase("idle");
  }, [result, onUpdate]);

  // Draw graph
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!energyCurve || energyCurve.length === 0) return;

    const maxT = energyCurve[energyCurve.length - 1].t;
    if (maxT <= 0) return;

    // Draw energy curve (gray)
    ctx.beginPath();
    ctx.strokeStyle = "hsl(var(--muted-foreground) / 0.5)";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < energyCurve.length; i++) {
      const x = (energyCurve[i].t / maxT) * w;
      const y = h - energyCurve[i].e * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw mic samples (green)
    if (micSamples.length > 0) {
      // Normalize mic RMS
      let maxRms = 0;
      for (const s of micSamples) if (s.rms > maxRms) maxRms = s.rms;
      if (maxRms < 0.001) maxRms = 1;

      ctx.beginPath();
      ctx.strokeStyle = "hsl(var(--primary))";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < micSamples.length; i++) {
        const x = (micSamples[i].t / maxT) * w;
        const y = h - (micSamples[i].rms / maxRms) * h;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [energyCurve, micSamples]);

  // Cleanup on unmount
  useEffect(() => () => { stopListening(); }, [stopListening]);

  return (
    <div className="space-y-4">
      {/* Current song */}
      <div className="bg-secondary/50 rounded-lg p-3">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Nu spelas</span>
        {track ? (
          <div className="mt-1">
            <p className="text-sm font-bold text-foreground truncate">{track}</p>
            {artist && <p className="text-xs text-muted-foreground truncate">{artist}</p>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground mt-1">Ingen låt identifierad — spela musik via Sonos</p>
        )}
      </div>

      {/* Graph */}
      <div className="bg-secondary/30 rounded-lg p-2">
        <canvas
          ref={canvasRef}
          width={600}
          height={120}
          className="w-full h-20 rounded"
        />
        <div className="flex justify-between mt-1">
          <span className="text-[9px] font-mono text-muted-foreground">
            <span className="inline-block w-2 h-0.5 bg-muted-foreground mr-1 align-middle" /> AI-kurva
          </span>
          <span className="text-[9px] font-mono text-primary">
            <span className="inline-block w-2 h-0.5 bg-primary mr-1 align-middle" /> Mikrofon
          </span>
        </div>
      </div>

      {/* Progress bar during listening */}
      {phase === "listening" && (
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-200 rounded-full"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {(phase === "idle" || phase === "error") && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!track}
            onClick={fetchEnergyCurve}
            className="text-xs flex-1"
          >
            Hämta energikurva
          </Button>
        )}

        {phase === "fetching" && (
          <Button size="sm" variant="secondary" disabled className="text-xs flex-1">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Hämtar…
          </Button>
        )}

        {phase === "ready" && (
          <Button size="sm" onClick={startListening} className="text-xs flex-1">
            <Play className="w-3 h-3 mr-1" /> Starta kalibrering ({LISTEN_DURATION_SEC}s)
          </Button>
        )}

        {phase === "listening" && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => { stopListening(); setPhase("ready"); }}
            className="text-xs flex-1"
          >
            <Square className="w-3 h-3 mr-1" /> Avbryt
          </Button>
        )}

        {phase === "analyzing" && (
          <Button size="sm" disabled className="text-xs flex-1">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Analyserar…
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="w-3 h-3" /> {error}
        </div>
      )}

      {/* Results */}
      {phase === "done" && result && (
        <div className="space-y-3">
          <div className="bg-secondary/50 rounded-lg p-3 space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground font-mono">Korrelation</span>
              <span className={`font-bold ${result.correlation > 0.5 ? 'text-primary' : 'text-destructive'}`}>
                {(result.correlation * 100).toFixed(0)}%
              </span>
            </div>
            <ResultRow label="Latens-offset" value={`${result.latencyMs}ms`} current={`${cal.latencyOffsetMs}ms`} />
            <ResultRow label="Attack" value={result.attackAlpha.toFixed(2)} current={cal.attackAlpha.toFixed(2)} />
            <ResultRow label="Release" value={result.releaseAlpha.toFixed(3)} current={cal.releaseAlpha.toFixed(3)} />
            <ResultRow label="Dämpning" value={`${result.dynamicDamping.toFixed(1)}x`} current={`${cal.dynamicDamping.toFixed(1)}x`} />
          </div>

          <div className="flex gap-2">
            <Button size="sm" onClick={applyResult} className="flex-1 text-xs">
              <Check className="w-3 h-3 mr-1" /> Applicera
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setPhase("ready"); setResult(null); }}
              className="text-xs"
            >
              Kör om
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultRow({ label, value, current }: { label: string; value: string; current: string }) {
  const changed = value !== current;
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground font-mono">{label}</span>
      <span className="font-mono">
        {changed ? (
          <>
            <span className="text-muted-foreground line-through mr-2">{current}</span>
            <span className="text-primary font-bold">{value}</span>
          </>
        ) : (
          <span className="text-foreground">{value}</span>
        )}
      </span>
    </div>
  );
}
