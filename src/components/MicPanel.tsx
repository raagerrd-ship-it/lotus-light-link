import { useState, useRef, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { sendBrightness } from "@/lib/bledom";
import { Activity } from "lucide-react";

interface MicPanelProps {
  char: any;
}

export default function MicPanel({ char }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const [volume, setVolume] = useState(0);
  const [sensitivity, setSensitivity] = useState(80);
  const [minBrightness, setMinBrightness] = useState(0);
  const [maxBrightness, setMaxBrightness] = useState(100);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
    setActive(false);
    setVolume(0);
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      analyser.minDecibels = -90;
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

    const loop = () => {
      analyser.getByteFrequencyData(dataArray);

      // Peak-based detection for more dynamic response
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        if (dataArray[i] > peak) peak = dataArray[i];
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;
      // Blend peak and average for punchy but smooth response
      const blend = peak * 0.6 + avg * 0.4;
      const sensitivityMultiplier = sensitivity / 40;
      const normalized = Math.min(1, Math.pow(blend / 200, 0.8) * sensitivityMultiplier);
      setVolume(normalized);

      const now = Date.now();
      if (now - throttleRef.current >= 50) {
        throttleRef.current = now;
        const brightness = Math.round(minBrightness + normalized * (maxBrightness - minBrightness));
        sendBrightness(char, brightness).catch(() => {});
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, char, sensitivity, minBrightness, maxBrightness]);

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
        <div className="w-full max-w-xs flex flex-col gap-4">
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-xs text-muted-foreground">Känslighet</span>
              <span className="text-xs font-mono text-muted-foreground">{sensitivity}%</span>
            </div>
            <Slider value={[sensitivity]} onValueChange={(v) => setSensitivity(v[0])} min={5} max={200} step={5} />
          </div>
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-xs text-muted-foreground">Min ljusstyrka</span>
              <span className="text-xs font-mono text-muted-foreground">{minBrightness}%</span>
            </div>
            <Slider value={[minBrightness]} onValueChange={(v) => setMinBrightness(v[0])} min={0} max={50} step={5} />
          </div>
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-xs text-muted-foreground">Max ljusstyrka</span>
              <span className="text-xs font-mono text-muted-foreground">{maxBrightness}%</span>
            </div>
            <Slider value={[maxBrightness]} onValueChange={(v) => setMaxBrightness(v[0])} min={50} max={100} step={5} />
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-xs">
        {active
          ? "Ljusstyrkan pulserar med musiken – din valda färg behålls"
          : "Lyssnar via telefonens mikrofon och styr bara ljusstyrkan. Välj färg under Färg-fliken först."
        }
      </p>
    </div>
  );
}
