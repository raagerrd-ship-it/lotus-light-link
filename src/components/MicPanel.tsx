import { useState, useRef, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { sendBrightness } from "@/lib/bledom";
import { Activity } from "lucide-react";

interface MicPanelProps {
  char: any;
}

export default function MicPanel({ char }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const [volume, setVolume] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);
  const smoothedRef = useRef(0);

  // Rolling history for auto-calibration (last ~3 seconds at 60fps)
  const historyRef = useRef<Float32Array>(new Float32Array(180));
  const historyIndexRef = useRef(0);
  const historyFilledRef = useRef(0);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
    setActive(false);
    setVolume(0);
    // Reset calibration
    historyRef.current.fill(0);
    historyIndexRef.current = 0;
    historyFilledRef.current = 0;
    smoothedRef.current = 0;
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.4;
      analyser.minDecibels = -70;
      analyser.maxDecibels = -10;
      source.connect(analyser);

      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      streamRef.current = stream;
      setActive(true);
    } catch {
      // Mic access denied
    }
  }, []);

  useEffect(() => {
    if (!active || !analyserRef.current || !char) return;

    const analyser = analyserRef.current;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const history = historyRef.current;

    const loop = () => {
      analyser.getByteFrequencyData(dataArray);

      // RMS level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length) / 255;

      // Store in rolling history
      const idx = historyIndexRef.current;
      history[idx] = rms;
      historyIndexRef.current = (idx + 1) % history.length;
      if (historyFilledRef.current < history.length) historyFilledRef.current++;

      // Calculate percentile-based floor and ceiling from history
      const count = historyFilledRef.current;
      const samples: number[] = [];
      for (let i = 0; i < count; i++) samples.push(history[i]);
      samples.sort((a, b) => a - b);

      // Floor = 10th percentile, Ceiling = 95th percentile
      const floor = samples[Math.floor(count * 0.10)] || 0;
      const ceiling = samples[Math.floor(count * 0.95)] || 0.01;
      const range = Math.max(0.005, ceiling - floor);

      // Normalize current RMS into 0-1 using the adaptive range
      const raw = (rms - floor) / range;
      const clamped = Math.max(0, Math.min(1, raw));

      // Smooth: fast attack, moderate release
      const prev = smoothedRef.current;
      const smoothed = clamped > prev
        ? prev + (clamped - prev) * 0.7
        : prev + (clamped - prev) * 0.25;
      smoothedRef.current = smoothed;

      const output = Math.min(1, Math.max(0, smoothed));
      setVolume(output);

      // Send brightness 0-100
      const now = Date.now();
      if (now - throttleRef.current >= 50) {
        throttleRef.current = now;
        sendBrightness(char, Math.round(output * 100)).catch(() => {});
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, char]);

  useEffect(() => stop, [stop]);

  const handleToggle = async (on: boolean) => {
    if (on) {
      await start();
    } else {
      stop();
      if (char) await sendBrightness(char, 80).catch(() => {});
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
      {/* Volume visualizer */}
      <div
        className="w-32 h-32 rounded-full border-2 flex items-center justify-center transition-all duration-100"
        style={{
          borderColor: active ? "hsl(var(--foreground))" : "hsl(var(--border))",
          boxShadow: active ? `0 0 ${volume * 60}px ${volume * 20}px hsl(var(--foreground) / ${volume * 0.3})` : "none",
          transform: `scale(${1 + volume * 0.15})`,
        }}
      >
        <Activity
          className="w-12 h-12 transition-all"
          style={{ opacity: active ? 0.5 + volume * 0.5 : 0.3 }}
        />
      </div>

      {/* Toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Ljuspuls</span>
        <Switch checked={active} onCheckedChange={handleToggle} />
        <span className="text-sm font-bold">{active ? "PÅ" : "AV"}</span>
      </div>

      {active && (
        <div className="w-full max-w-xs">
          <div className="flex justify-between mb-1">
            <span className="text-xs text-muted-foreground">Ljusstyrka</span>
            <span className="text-xs font-mono text-foreground">{Math.round(volume * 100)}%</span>
          </div>
          <div className="h-3 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-foreground rounded-full transition-all duration-75"
              style={{ width: `${volume * 100}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Kalibrerar automatiskt efter volymnivån
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-xs">
        {active
          ? "Ljusstyrkan anpassas dynamiskt 0–100% efter musiken. Din färg behålls."
          : "Lyssnar via telefonens mikrofon och styr ljusstyrkan automatiskt. Välj färg först."
        }
      </p>
    </div>
  );
}
