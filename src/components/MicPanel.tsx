import { useState, useRef, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { sendBrightness, sendColor } from "@/lib/bledom";
import { Activity } from "lucide-react";

interface MicPanelProps {
  char: any;
  currentColor: [number, number, number];
}

// Simple BLE command queue to prevent collisions
function createBleQueue(char: any) {
  let busy = false;
  const queue: (() => Promise<void>)[] = [];

  const process = async () => {
    if (busy || queue.length === 0) return;
    busy = true;
    const cmd = queue.shift()!;
    try { await cmd(); } catch {}
    busy = false;
    if (queue.length > 0) process();
  };

  return {
    brightness(val: number) {
      // Replace any pending brightness command
      const idx = queue.findIndex((_, i) => i === 0);
      queue.length = 0; // Clear queue, only latest matters
      queue.push(() => sendBrightness(char, val));
      process();
    },
    color(r: number, g: number, b: number) {
      queue.push(() => sendColor(char, r, g, b));
      process();
    },
  };
}

export default function MicPanel({ char, currentColor }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const [volume, setVolume] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);
  const colorThrottleRef = useRef<number>(0);
  const colorBoostedRef = useRef(false);
  const bleQueueRef = useRef<ReturnType<typeof createBleQueue> | null>(null);

  // Envelope follower state
  const envelopeRef = useRef(0);
  const prevSampleRef = useRef(0);

  // Auto-calibration
  const historyRef = useRef<Float32Array>(new Float32Array(120)); // ~2s
  const historyIndexRef = useRef(0);
  const historyFilledRef = useRef(0);

  // Audio nodes
  const analyserRef = useRef<AnalyserNode | null>(null);
  const filterRef = useRef<BiquadFilterNode | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    filterRef.current = null;
    streamRef.current = null;
    bleQueueRef.current = null;
    setActive(false);
    setVolume(0);
    historyRef.current.fill(0);
    historyIndexRef.current = 0;
    historyFilledRef.current = 0;
    envelopeRef.current = 0;
    prevSampleRef.current = 0;
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);

      // Bandpass filter focused on kick drum / bass (30-150Hz)
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 80;
      filter.Q.value = 0.7;

      // Analyser on filtered signal
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;

      source.connect(filter);
      filter.connect(analyser);

      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      filterRef.current = filter;
      streamRef.current = stream;
      bleQueueRef.current = createBleQueue(char);
      setActive(true);
    } catch {
      // Mic access denied
    }
  }, [char]);

  useEffect(() => {
    if (!active || !analyserRef.current || !bleQueueRef.current) return;

    const analyser = analyserRef.current;
    const ble = bleQueueRef.current;
    const timeDomain = new Uint8Array(analyser.fftSize);
    const history = historyRef.current;

    const loop = () => {
      analyser.getByteTimeDomainData(timeDomain);

      // Peak detection on time domain (faster than FFT for transients)
      let maxAmplitude = 0;
      for (let i = 0; i < timeDomain.length; i++) {
        const amplitude = Math.abs(timeDomain[i] - 128) / 128;
        if (amplitude > maxAmplitude) maxAmplitude = amplitude;
      }

      // Envelope follower: very fast attack, controlled release
      const prev = envelopeRef.current;
      const envelope = maxAmplitude > prev
        ? maxAmplitude // instant attack
        : prev * 0.88; // ~60ms release at 60fps
      envelopeRef.current = envelope;

      // Transient boost: reward sudden increases
      const delta = Math.max(0, maxAmplitude - prevSampleRef.current);
      prevSampleRef.current = maxAmplitude;
      const transientBoost = Math.min(1, delta * 5);

      // Combine envelope + transient for extra punch
      const combined = Math.min(1, envelope * 0.7 + transientBoost * 0.3);

      // Auto-calibrate with rolling history
      const idx = historyIndexRef.current;
      history[idx] = combined;
      historyIndexRef.current = (idx + 1) % history.length;
      if (historyFilledRef.current < history.length) historyFilledRef.current++;

      const count = historyFilledRef.current;
      let minVal = 1, maxVal = 0;
      for (let i = 0; i < count; i++) {
        if (history[i] < minVal) minVal = history[i];
        if (history[i] > maxVal) maxVal = history[i];
      }
      const range = Math.max(0.01, maxVal - minVal);
      const normalized = Math.max(0, Math.min(1, (combined - minVal) / range));

      setVolume(normalized);

      // Send brightness
      const now = Date.now();
      if (now - throttleRef.current >= 55) {
        throttleRef.current = now;
        ble.brightness(Math.round(normalized * 100));
      }

      // Color boost at peaks >80%, restore when dropping
      if (normalized > 0.8 && now - colorThrottleRef.current >= 120) {
        colorThrottleRef.current = now;
        colorBoostedRef.current = true;
        const [cr, cg, cb] = currentColor;
        const boost = (normalized - 0.8) / 0.2 * 0.35;
        const r = Math.round(cr + (255 - cr) * boost);
        const g = Math.round(cg + (255 - cg) * boost);
        const b = Math.round(cb + (255 - cb) * boost);
        ble.color(r, g, b);
      } else if (normalized <= 0.7 && colorBoostedRef.current && now - colorThrottleRef.current >= 80) {
        colorThrottleRef.current = now;
        colorBoostedRef.current = false;
        const [cr, cg, cb] = currentColor;
        ble.color(cr, cg, cb);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, currentColor]);

  useEffect(() => stop, [stop]);

  const handleToggle = async (on: boolean) => {
    if (on) {
      await start();
    } else {
      stop();
      if (char) {
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
        className="w-32 h-32 rounded-full border-2 flex items-center justify-center"
        style={{
          borderColor: active ? "hsl(var(--foreground))" : "hsl(var(--border))",
          boxShadow: active
            ? `0 0 ${volume * 80}px ${volume * 25}px hsl(var(--foreground) / ${volume * 0.4})`
            : "none",
          transform: `scale(${1 + volume * 0.2})`,
          transition: "transform 50ms, box-shadow 50ms",
        }}
      >
        <Activity
          className="w-12 h-12"
          style={{
            opacity: active ? 0.4 + volume * 0.6 : 0.3,
            transition: "opacity 50ms",
          }}
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
              className="h-full bg-foreground rounded-full"
              style={{
                width: `${volume * 100}%`,
                transition: "width 50ms",
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Bas-isolering 30–150Hz · Auto-kalibrering · Transient-detection
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-xs">
        {active
          ? "Ljuset pulserar med basslaget – din färg behålls"
          : "Isolerar basfrekvenser och styr ljusstyrkan efter kickdrum/bas. Välj färg först."
        }
      </p>
    </div>
  );
}
