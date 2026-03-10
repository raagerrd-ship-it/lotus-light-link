import { useState, useRef, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { sendBrightness, sendColor } from "@/lib/bledom";
import { Activity } from "lucide-react";

interface MicPanelProps {
  char: any;
  currentColor: [number, number, number];
}

// Priority-aware BLE command queue
function createBleQueue(char: any) {
  let busy = false;
  let pendingBrightness: (() => Promise<void>) | null = null;
  let pendingColor: (() => Promise<void>) | null = null;

  const process = async () => {
    if (busy) return;
    // Brightness takes priority
    const cmd = pendingBrightness || pendingColor;
    if (!cmd) return;
    if (pendingBrightness) pendingBrightness = null;
    else pendingColor = null;
    busy = true;
    try { await cmd(); } catch {}
    busy = false;
    process();
  };

  return {
    brightness(val: number) {
      pendingBrightness = () => sendBrightness(char, val);
      process();
    },
    color(r: number, g: number, b: number) {
      pendingColor = () => sendColor(char, r, g, b);
      process();
    },
  };
}

export default function MicPanel({ char, currentColor }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const [volume, setVolume] = useState(0);
  const [sensitivity, setSensitivity] = useState(70); // 0-100
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

  // Auto-calibration with separate percentile tracking
  const historyRef = useRef<Float32Array>(new Float32Array(180)); // ~3s at 60fps
  const historyIndexRef = useRef(0);
  const historyFilledRef = useRef(0);

  // Audio nodes
  const analyserRef = useRef<AnalyserNode | null>(null);
  const lowFilterRef = useRef<BiquadFilterNode | null>(null);
  const midFilterRef = useRef<BiquadFilterNode | null>(null);
  const lowAnalyserRef = useRef<AnalyserNode | null>(null);
  const midAnalyserRef = useRef<AnalyserNode | null>(null);

  // Sensitivity ref for use in loop
  const sensitivityRef = useRef(sensitivity);
  sensitivityRef.current = sensitivity;

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    lowFilterRef.current = null;
    midFilterRef.current = null;
    lowAnalyserRef.current = null;
    midAnalyserRef.current = null;
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

      // Dual-band: sub-bass (30-80Hz) for kick, low-mid (80-200Hz) for bass guitar
      const lowFilter = ctx.createBiquadFilter();
      lowFilter.type = "bandpass";
      lowFilter.frequency.value = 55;
      lowFilter.Q.value = 0.8;

      const midFilter = ctx.createBiquadFilter();
      midFilter.type = "bandpass";
      midFilter.frequency.value = 130;
      midFilter.Q.value = 0.6;

      // Compressor to even out dynamic range before analysis
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -30;
      compressor.knee.value = 10;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.1;

      const lowAnalyser = ctx.createAnalyser();
      lowAnalyser.fftSize = 256; // Smaller = faster
      lowAnalyser.smoothingTimeConstant = 0.15;

      const midAnalyser = ctx.createAnalyser();
      midAnalyser.fftSize = 256;
      midAnalyser.smoothingTimeConstant = 0.15;

      source.connect(compressor);
      compressor.connect(lowFilter);
      compressor.connect(midFilter);
      lowFilter.connect(lowAnalyser);
      midFilter.connect(midAnalyser);

      audioContextRef.current = ctx;
      lowAnalyserRef.current = lowAnalyser;
      midAnalyserRef.current = midAnalyser;
      lowFilterRef.current = lowFilter;
      midFilterRef.current = midFilter;
      streamRef.current = stream;
      bleQueueRef.current = createBleQueue(char);
      setActive(true);
    } catch {
      // Mic access denied
    }
  }, [char]);

  useEffect(() => {
    if (!active || !lowAnalyserRef.current || !midAnalyserRef.current || !bleQueueRef.current) return;

    const lowAnalyser = lowAnalyserRef.current;
    const midAnalyser = midAnalyserRef.current;
    const ble = bleQueueRef.current;
    const lowTD = new Uint8Array(lowAnalyser.fftSize);
    const midTD = new Uint8Array(midAnalyser.fftSize);
    const history = historyRef.current;

    // RMS helper for more accurate energy measurement
    const rms = (data: Uint8Array) => {
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / data.length);
    };

    // Peak helper
    const peak = (data: Uint8Array) => {
      let max = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > max) max = v;
      }
      return max;
    };

    const loop = () => {
      lowAnalyser.getByteTimeDomainData(lowTD);
      midAnalyser.getByteTimeDomainData(midTD);

      // Dual-band energy: combine RMS + peak for both bands
      const lowRms = rms(lowTD);
      const midRms = rms(midTD);
      const lowPeak = peak(lowTD);
      const midPeak = peak(midTD);

      // Weight sub-bass more, use peak for transients
      const energy = lowRms * 0.5 + midRms * 0.2 + lowPeak * 0.2 + midPeak * 0.1;

      // Apply sensitivity: higher = more responsive to quiet sounds
      const sens = sensitivityRef.current / 100;
      const gain = 1 + sens * 4; // 1x to 5x gain
      const amplified = Math.min(1, energy * gain);

      // Envelope follower: instant attack, variable release
      const prev = envelopeRef.current;
      const releaseRate = 0.85 + (1 - sens) * 0.1; // 0.85 - 0.95
      const envelope = amplified > prev
        ? amplified
        : prev * releaseRate;
      envelopeRef.current = envelope;

      // Transient detection with derivative
      const delta = Math.max(0, amplified - prevSampleRef.current);
      prevSampleRef.current = amplified;
      const transientBoost = Math.min(1, delta * 6);

      // Combine
      const combined = Math.min(1, envelope * 0.65 + transientBoost * 0.35);

      // Auto-calibrate with rolling percentile
      const idx = historyIndexRef.current;
      history[idx] = combined;
      historyIndexRef.current = (idx + 1) % history.length;
      if (historyFilledRef.current < history.length) historyFilledRef.current++;

      const count = historyFilledRef.current;
      // Use 5th and 95th percentile for robust normalization
      let sorted: number[] = [];
      for (let i = 0; i < count; i++) sorted.push(history[i]);
      sorted.sort();
      const p5 = sorted[Math.floor(count * 0.05)];
      const p95 = sorted[Math.max(0, Math.ceil(count * 0.95) - 1)];
      const range = Math.max(0.005, p95 - p5);
      const normalized = Math.max(0, Math.min(1, (combined - p5) / range));

      // Apply curve for punchier feel (slight exponential)
      const curved = normalized * normalized * (3 - 2 * normalized); // smoothstep

      setVolume(curved);

      // Send brightness at ~18Hz (every 55ms)
      const now = Date.now();
      if (now - throttleRef.current >= 55) {
        throttleRef.current = now;
        ble.brightness(Math.round(curved * 100));
      }

      // Color boost at peaks >80%, restore at <70%
      if (curved > 0.8 && now - colorThrottleRef.current >= 120) {
        colorThrottleRef.current = now;
        colorBoostedRef.current = true;
        const [cr, cg, cb] = currentColor;
        const boost = (curved - 0.8) / 0.2 * 0.35;
        const r = Math.round(cr + (255 - cr) * boost);
        const g = Math.round(cg + (255 - cg) * boost);
        const b = Math.round(cb + (255 - cb) * boost);
        ble.color(r, g, b);
      } else if (curved <= 0.7 && colorBoostedRef.current && now - colorThrottleRef.current >= 80) {
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
    <div className="flex flex-col items-center justify-center h-full gap-5 px-4">
      {/* Bass pulse visualizer */}
      <div
        className="w-32 h-32 rounded-full border-2 flex items-center justify-center"
        style={{
          borderColor: active ? "hsl(var(--foreground))" : "hsl(var(--border))",
          boxShadow: active
            ? `0 0 ${volume * 80}px ${volume * 25}px hsl(var(--foreground) / ${volume * 0.4})`
            : "none",
          transform: `scale(${1 + volume * 0.25})`,
          transition: "transform 40ms, box-shadow 40ms",
        }}
      >
        <Activity
          className="w-12 h-12"
          style={{
            opacity: active ? 0.4 + volume * 0.6 : 0.3,
            transition: "opacity 40ms",
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
        <div className="w-full max-w-xs space-y-4">
          {/* Volume bar */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-xs text-muted-foreground">Ljusstyrka</span>
              <span className="text-xs font-mono text-foreground">{Math.round(volume * 100)}%</span>
            </div>
            <div className="h-3 rounded-full bg-secondary overflow-hidden">
              <div
                className="h-full bg-foreground rounded-full"
                style={{
                  width: `${volume * 100}%`,
                  transition: "width 40ms",
                }}
              />
            </div>
          </div>

          {/* Sensitivity slider */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-xs text-muted-foreground">Känslighet</span>
              <span className="text-xs font-mono text-foreground">{sensitivity}%</span>
            </div>
            <Slider
              value={[sensitivity]}
              onValueChange={([v]) => setSensitivity(v)}
              min={10}
              max={100}
              step={5}
              className="w-full"
            />
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Dual-band 30–200Hz · RMS+Peak · Kompressor · Smoothstep
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