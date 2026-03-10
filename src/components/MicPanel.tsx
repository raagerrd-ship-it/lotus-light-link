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
  const [punchColor, setPunchColor] = useState(true);
  const punchColorRef = useRef(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);
  const colorThrottleRef = useRef<number>(0);
  const colorBoostedRef = useRef(false);
  const bleQueueRef = useRef<ReturnType<typeof createBleQueue> | null>(null);

  // Direct DOM refs to avoid React re-renders in hot loop
  const vizRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<SVGSVGElement>(null);

  // Envelope follower state
  const envelopeRef = useRef(0);
  const prevSampleRef = useRef(0);

  // Running min/max tracker (O(1) per frame, no sorting)
  const runMinRef = useRef(1);
  const runMaxRef = useRef(0);
  const decayCounterRef = useRef(0);

  // BPM detection refs
  const onsetTimesRef = useRef<number[]>([]);
  const lastOnsetRef = useRef(0);
  const wasAboveRef = useRef(false);
  const bpmRef = useRef(0);
  const releaseCoeffRef = useRef(0.985);
  const bpmDisplayRef = useRef<HTMLSpanElement>(null);

  // Audio nodes
  const lowAnalyserRef = useRef<AnalyserNode | null>(null);
  const midAnalyserRef = useRef<AnalyserNode | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    lowAnalyserRef.current = null;
    midAnalyserRef.current = null;
    streamRef.current = null;
    bleQueueRef.current = null;
    setActive(false);
    envelopeRef.current = 0;
    prevSampleRef.current = 0;
    runMinRef.current = 1;
    runMaxRef.current = 0;
    decayCounterRef.current = 0;
    onsetTimesRef.current = [];
    lastOnsetRef.current = 0;
    wasAboveRef.current = false;
    bpmRef.current = 0;
    releaseCoeffRef.current = 0.97;
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext({ latencyHint: "interactive" });
      const source = ctx.createMediaStreamSource(stream);

      // Dual-band filters
      const lowFilter = ctx.createBiquadFilter();
      lowFilter.type = "bandpass";
      lowFilter.frequency.value = 55;
      lowFilter.Q.value = 0.8;

      const midFilter = ctx.createBiquadFilter();
      midFilter.type = "bandpass";
      midFilter.frequency.value = 130;
      midFilter.Q.value = 0.6;

      // Minimal-latency analysers
      const lowAnalyser = ctx.createAnalyser();
      lowAnalyser.fftSize = 128; // Minimum for speed
      lowAnalyser.smoothingTimeConstant = 0;

      const midAnalyser = ctx.createAnalyser();
      midAnalyser.fftSize = 128;
      midAnalyser.smoothingTimeConstant = 0;

      // Skip compressor – it adds ~3ms lookahead latency
      source.connect(lowFilter);
      source.connect(midFilter);
      lowFilter.connect(lowAnalyser);
      midFilter.connect(midAnalyser);

      audioContextRef.current = ctx;
      lowAnalyserRef.current = lowAnalyser;
      midAnalyserRef.current = midAnalyser;
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
    const lowTD = new Uint8Array(128);
    const midTD = new Uint8Array(128);

    const loop = () => {
      lowAnalyser.getByteTimeDomainData(lowTD);
      midAnalyser.getByteTimeDomainData(midTD);

      // Inline peak+RMS in single pass per band (avoid function call overhead)
      let lowSum = 0, lowMax = 0, midSum = 0, midMax = 0;
      for (let i = 0; i < 128; i++) {
        const lv = (lowTD[i] - 128) / 128;
        lowSum += lv * lv;
        const la = lv < 0 ? -lv : lv;
        if (la > lowMax) lowMax = la;

        const mv = (midTD[i] - 128) / 128;
        midSum += mv * mv;
        const ma = mv < 0 ? -mv : mv;
        if (ma > midMax) midMax = ma;
      }
      const lowRms = Math.sqrt(lowSum * 0.0078125); // /128
      const midRms = Math.sqrt(midSum * 0.0078125);

      // Weight sub-bass heavier, peak for transient snap
      const energy = lowRms * 0.45 + midRms * 0.15 + lowMax * 0.3 + midMax * 0.1;

      // Envelope: instant attack, BPM-synced release
      const prev = envelopeRef.current;
      const envelope = energy > prev ? energy : prev * releaseCoeffRef.current;
      envelopeRef.current = envelope;

      // Transient boost
      const delta = energy - prevSampleRef.current;
      prevSampleRef.current = energy;
      const transient = delta > 0 ? Math.min(1, delta * 8) : 0;

      // Use envelope directly for brightness (has instant attack + slow release)
      // Transient is only used for BPM onset detection below
      const combined = envelope;

      // O(1) running min/max with slow decay (replaces O(n log n) sort)
      if (combined < runMinRef.current) runMinRef.current = combined;
      if (combined > runMaxRef.current) runMaxRef.current = combined;
      decayCounterRef.current++;
      if (decayCounterRef.current >= 60) {
        decayCounterRef.current = 0;
        const mid = (runMinRef.current + runMaxRef.current) * 0.5;
        runMinRef.current += (mid - runMinRef.current) * 0.15;
        runMaxRef.current -= (runMaxRef.current - mid) * 0.15;
      }

      const range = Math.max(0.005, runMaxRef.current - runMinRef.current);
      const normalized = Math.max(0, Math.min(1, (combined - runMinRef.current) / range));

      // Smoothstep curve
      const curved = normalized * normalized * (3 - 2 * normalized);

      // --- BPM onset detection (transient-based, more reliable) ---
      const now = Date.now();
      const isOnset = transient > 0.3 && now - lastOnsetRef.current > 180;
      if (isOnset) {
        if (lastOnsetRef.current > 0) {
          const interval = now - lastOnsetRef.current;
          const onsets = onsetTimesRef.current;
          onsets.push(interval);
          if (onsets.length > 12) onsets.shift(); // keep last 12 for stability

          if (onsets.length >= 3) {
            // Median of intervals, filtering outliers
            const sorted = [...onsets].sort((a, b) => a - b);
            // Use interquartile range for robustness
            const q1 = sorted[Math.floor(sorted.length * 0.25)];
            const q3 = sorted[Math.floor(sorted.length * 0.75)];
            const filtered = sorted.filter(v => v >= q1 * 0.7 && v <= q3 * 1.3);
            if (filtered.length >= 2) {
              const mid = filtered[Math.floor(filtered.length / 2)];
              const bpmRaw = 60000 / mid;
              if (bpmRaw >= 60 && bpmRaw <= 200) {
                // Smooth BPM with exponential moving average
                const prevBpm = bpmRef.current;
                const bpm = prevBpm > 0 ? prevBpm * 0.7 + bpmRaw * 0.3 : bpmRaw;
                bpmRef.current = bpm;
                const bpmFactor = (bpm - 60) / 140;
                const targetLevel = 0.15 + bpmFactor * 0.15;
                const spanBeats = 2 + bpmFactor * 2; // 2 beats at 60bpm, 4 at 200bpm
                const totalFrames = (spanBeats * mid / 1000) * 60;
                releaseCoeffRef.current = Math.pow(targetLevel, 1 / totalFrames);
                if (bpmDisplayRef.current) bpmDisplayRef.current.textContent = `${bpm.toFixed(1)} BPM`;
              }
            }
          }
        }
        lastOnsetRef.current = now;
      }

      // Brightness: full range 0-100%, punch hard then fade
      const pct = Math.round(curved * 100);
      if (vizRef.current) {
        const s = vizRef.current.style;
        s.transform = `scale(${1 + curved * 0.25})`;
        s.boxShadow = `0 0 ${curved * 80}px ${curved * 25}px hsl(var(--foreground) / ${curved * 0.4})`;
      }
      if (barRef.current) barRef.current.style.width = `${pct}%`;
      if (pctRef.current) pctRef.current.textContent = `${pct}%`;

      // BLE brightness at ~25Hz (40ms)
      if (now - throttleRef.current >= 40) {
        throttleRef.current = now;
        ble.brightness(pct);
      }

      // Color boost at peaks (BPM-synced fade-back)
      const beatMs = bpmRef.current > 0 ? 60000 / bpmRef.current : 500;
      const colorFadeMs = Math.max(50, beatMs * 0.15); // fade-back at ~15% of beat period
      if (punchColorRef.current && curved > 0.8 && now - colorThrottleRef.current >= colorFadeMs) {
        colorThrottleRef.current = now;
        colorBoostedRef.current = true;
        const [cr, cg, cb] = currentColor;
        const boost = (curved - 0.8) * 1.75;
        ble.color(
          Math.round(cr + (255 - cr) * boost),
          Math.round(cg + (255 - cg) * boost),
          Math.round(cb + (255 - cb) * boost),
        );
      } else if (curved <= 0.7 && colorBoostedRef.current && now - colorThrottleRef.current >= colorFadeMs) {
        colorThrottleRef.current = now;
        colorBoostedRef.current = false;
        ble.color(currentColor[0], currentColor[1], currentColor[2]);
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
        ref={vizRef}
        className="w-32 h-32 rounded-full border-2 flex items-center justify-center will-change-transform"
        style={{
          borderColor: active ? "hsl(var(--foreground))" : "hsl(var(--border))",
        }}
      >
        <Activity
          ref={iconRef}
          className="w-12 h-12"
          style={{ opacity: active ? 0.7 : 0.3 }}
        />
      </div>

      {/* Toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Baspuls</span>
        <Switch checked={active} onCheckedChange={handleToggle} />
        <span className="text-sm font-bold">{active ? "PÅ" : "AV"}</span>
      </div>

      {/* Punch color toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Punch-färg</span>
        <Switch
          checked={punchColor}
          onCheckedChange={(v) => { setPunchColor(v); punchColorRef.current = v; }}
        />
        <span className="text-xs text-muted-foreground">{punchColor ? "Vit kick" : "Av"}</span>
      </div>

      {active && (
        <div className="w-full max-w-xs space-y-4">
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-xs text-muted-foreground">Ljusstyrka</span>
              <span ref={pctRef} className="text-xs font-mono text-foreground">0%</span>
            </div>
            <div className="h-3 rounded-full bg-secondary overflow-hidden">
              <div
                ref={barRef}
                className="h-full bg-foreground rounded-full will-change-[width]"
                style={{ width: "0%" }}
              />
            </div>
          </div>

          <div className="flex justify-between">
            <span className="text-xs text-muted-foreground">
              Dual-band · BPM-synk · 25Hz BLE
            </span>
            <span ref={bpmDisplayRef} className="text-xs font-mono text-foreground">— BPM</span>
          </div>
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