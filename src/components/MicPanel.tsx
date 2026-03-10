import { useState, useRef, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { sendBrightness, sendColor } from "@/lib/bledom";
import { Activity } from "lucide-react";

interface MicPanelProps {
  char: any;
  currentColor: [number, number, number];
}

export default function MicPanel({ char, currentColor }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const [volume, setVolume] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);
  const smoothedRef = useRef(0);

  // Rolling history for auto-calibration (~3s at 60fps)
  const historyRef = useRef<Float32Array>(new Float32Array(180));
  const historyIndexRef = useRef(0);
  const historyFilledRef = useRef(0);

  // Transient detection
  const prevEnergyRef = useRef(0);
  const envelopeRef = useRef(0);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
    setActive(false);
    setVolume(0);
    historyRef.current.fill(0);
    historyIndexRef.current = 0;
    historyFilledRef.current = 0;
    smoothedRef.current = 0;
    prevEnergyRef.current = 0;
    envelopeRef.current = 0;
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048; // More frequency resolution for bass detection
      analyser.smoothingTimeConstant = 0.2; // Low smoothing = faster transient response
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
    const sampleRate = audioContextRef.current?.sampleRate || 44100;
    const binSize = sampleRate / analyser.fftSize;

    // Calculate how many bins cover bass frequencies (20-250Hz)
    const bassMaxBin = Math.min(Math.ceil(250 / binSize), dataArray.length);
    const subBassMaxBin = Math.min(Math.ceil(80 / binSize), dataArray.length);

    const loop = () => {
      analyser.getByteFrequencyData(dataArray);

      // Bass energy: weighted toward sub-bass (20-80Hz) and bass (80-250Hz)
      let subBassSum = 0;
      let bassSum = 0;
      for (let i = 1; i < bassMaxBin; i++) {
        const val = dataArray[i] / 255;
        if (i < subBassMaxBin) {
          subBassSum += val * val;
        } else {
          bassSum += val * val;
        }
      }
      const subBassRms = subBassMaxBin > 1 ? Math.sqrt(subBassSum / (subBassMaxBin - 1)) : 0;
      const bassRms = bassMaxBin > subBassMaxBin ? Math.sqrt(bassSum / (bassMaxBin - subBassMaxBin)) : 0;

      // Weighted blend: sub-bass counts more for kick detection
      const bassEnergy = subBassRms * 0.7 + bassRms * 0.3;

      // Transient detection: compare current energy to previous
      const prevEnergy = prevEnergyRef.current;
      const delta = bassEnergy - prevEnergy;
      prevEnergyRef.current = bassEnergy;

      // If energy jumps up = bass hit → spike the envelope
      const envelope = envelopeRef.current;
      let newEnvelope: number;
      if (delta > 0.02) {
        // Bass hit detected! Spike up fast
        newEnvelope = Math.min(1, envelope + delta * 4);
      } else {
        // Decay quickly for punchy response
        newEnvelope = envelope * 0.85;
      }
      envelopeRef.current = newEnvelope;

      // Combine: steady bass level + transient spikes
      const combined = Math.min(1, bassEnergy * 0.4 + newEnvelope * 0.6);

      // Store in rolling history for auto-calibration
      const idx = historyIndexRef.current;
      history[idx] = combined;
      historyIndexRef.current = (idx + 1) % history.length;
      if (historyFilledRef.current < history.length) historyFilledRef.current++;

      // Percentile-based auto-calibration
      const count = historyFilledRef.current;
      const samples: number[] = [];
      for (let i = 0; i < count; i++) samples.push(history[i]);
      samples.sort((a, b) => a - b);

      const floor = samples[Math.floor(count * 0.05)] || 0;
      const ceiling = samples[Math.floor(count * 0.98)] || 0.01;
      const range = Math.max(0.005, ceiling - floor);

      const normalized = Math.max(0, Math.min(1, (combined - floor) / range));

      // Smooth: very fast attack for bass hits, medium-fast release
      const prev = smoothedRef.current;
      const smoothed = normalized > prev
        ? prev + (normalized - prev) * 0.85  // instant-ish attack
        : prev + (normalized - prev) * 0.3;  // quick release for punchy feel
      smoothedRef.current = smoothed;

      const output = Math.min(1, Math.max(0, smoothed));
      setVolume(output);

      // Send commands – throttle to avoid BLE overload
      const now = Date.now();
      if (now - throttleRef.current >= 60) {
        throttleRef.current = now;

        // Always send brightness based on output
        const brightnessVal = Math.round(output * 100);
        sendBrightness(char, brightnessVal).catch(() => {});

        // Only boost color toward white above 80% – extra kick
        const [cr, cg, cb] = currentColor;
        if (output > 0.8) {
          const boost = (output - 0.8) / 0.2 * 0.3;
          const r = Math.round(cr + (255 - cr) * boost);
          const g = Math.round(cg + (255 - cg) * boost);
          const b = Math.round(cb + (255 - cb) * boost);
          sendColor(char, r, g, b).catch(() => {});
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, char, currentColor]);

  useEffect(() => stop, [stop]);

  const handleToggle = async (on: boolean) => {
    if (on) {
      await start();
    } else {
      stop();
      if (char) {
        // Restore original color and full brightness
        const [cr, cg, cb] = currentColor;
        await sendColor(char, cr, cg, cb).catch(() => {});
        await sendBrightness(char, 100).catch(() => {});
      }
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
      {/* Bass pulse visualizer */}
      <div
        className="w-32 h-32 rounded-full border-2 flex items-center justify-center transition-all duration-75"
        style={{
          borderColor: active ? "hsl(var(--foreground))" : "hsl(var(--border))",
          boxShadow: active
            ? `0 0 ${volume * 80}px ${volume * 25}px hsl(var(--foreground) / ${volume * 0.4})`
            : "none",
          transform: `scale(${1 + volume * 0.2})`,
        }}
      >
        <Activity
          className="w-12 h-12 transition-all duration-75"
          style={{ opacity: active ? 0.4 + volume * 0.6 : 0.3 }}
        />
      </div>

      {/* Toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Baspuls</span>
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
            Reagerar på basslag · Kalibrerar automatiskt
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-xs">
        {active
          ? "Ljuset pulserar med basslaget – din färg behålls"
          : "Lyssnar efter basfrekvenser och simulerar slag med ljusstyrkan. Välj färg först."
        }
      </p>
    </div>
  );
}
