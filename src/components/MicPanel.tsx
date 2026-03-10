import { useState, useRef, useCallback, useEffect } from "react";
import { sendBrightness, sendColor } from "@/lib/bledom";
import { Activity, Music } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

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

interface SongInfo {
  title: string;
  artist: string;
  bpm: number | null;
}

export default function MicPanel({ char, currentColor }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const [songInfo, setSongInfo] = useState<SongInfo | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);
  const colorThrottleRef = useRef<number>(0);
  const colorBoostedRef = useRef(false);
  const bleQueueRef = useRef<ReturnType<typeof createBleQueue> | null>(null);

  // Ref for currentColor so the rAF loop never restarts on color change
  const currentColorRef = useRef(currentColor);
  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

  // Direct DOM refs to avoid React re-renders in hot loop
  const vizRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<SVGSVGElement>(null);

  // Envelope follower state
  const prevSampleRef = useRef(0);
  const agcAvgRef = useRef(0.01);

  // Beat-phase pulse model
  const beatPhaseRef = useRef(1);
  const framesPerBeatRef = useRef(60);
  const adaptiveThreshRef = useRef(0.15);
  const pulseMaxRef = useRef(0.7);
  const transientAvgRef = useRef(0.1);

  // BPM detection refs
  const onsetTimesRef = useRef<number[]>([]);
  const lastOnsetRef = useRef(0);
  const bpmRef = useRef(0);
  const silenceStartRef = useRef(0);
  const acrBpmRef = useRef<number | null>(null); // ACRCloud exact BPM
  
  const bpmDisplayRef = useRef<HTMLSpanElement>(null);

  // Audio nodes
  const lowAnalyserRef = useRef<AnalyserNode | null>(null);
  const midAnalyserRef = useRef<AnalyserNode | null>(null);

  // Song identification
  const identifyIntervalRef = useRef<number>(0);
  const recorderStreamRef = useRef<MediaStream | null>(null);

  const identifySong = useCallback(async () => {
    if (!streamRef.current || identifying) return;
    setIdentifying(true);

    try {
      // Record at 16kHz for smaller payload while still good enough for ACRCloud
      const recCtx = new AudioContext({ sampleRate: 16000 });
      const source = recCtx.createMediaStreamSource(streamRef.current);
      const processor = recCtx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      let sampleCount = 0;
      const targetSamples = 16000 * 4; // 4 seconds at 16kHz

      await new Promise<void>((resolve) => {
        processor.onaudioprocess = (e) => {
          const data = e.inputBuffer.getChannelData(0);
          chunks.push(new Float32Array(data));
          sampleCount += data.length;
          if (sampleCount >= targetSamples) {
            source.disconnect();
            processor.disconnect();
            resolve();
          }
        };
        source.connect(processor);
        processor.connect(recCtx.destination);
      });

      await recCtx.close();

      // Convert Float32 to Int16 PCM
      const totalSamples = Math.min(sampleCount, targetSamples);
      const pcm = new Int16Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        for (let i = 0; i < chunk.length && offset < totalSamples; i++, offset++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          pcm[offset] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
      }

      // Encode to base64
      const pcmBytes = new Uint8Array(pcm.buffer);
      let binary = '';
      for (let i = 0; i < pcmBytes.length; i++) {
        binary += String.fromCharCode(pcmBytes[i]);
      }
      const base64Audio = btoa(binary);

      // Call edge function
      const { data, error } = await supabase.functions.invoke('identify-song', {
        body: { audio: base64Audio, sampleRate: 16000, channels: 1 },
      });

      if (error) {
        console.error('Song identification error:', error);
      } else if (data?.identified) {
        const info: SongInfo = {
          title: data.title,
          artist: data.artist,
          bpm: data.bpm,
        };
        setSongInfo(info);

        if (data.bpm && data.bpm >= 60 && data.bpm <= 200) {
          acrBpmRef.current = data.bpm;
          const beatMs = 60000 / data.bpm;
          framesPerBeatRef.current = (beatMs / 1000) * 60;
          bpmRef.current = data.bpm;
          if (bpmDisplayRef.current) {
            bpmDisplayRef.current.textContent = `${Math.round(data.bpm)} BPM ♪`;
          }
        }
      } else {
        // No match - keep using onset detection
        console.log('Song not identified:', data?.message);
      }
    } catch (err) {
      console.error('Identification failed:', err);
    } finally {
      setIdentifying(false);
    }
  }, [identifying]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (identifyIntervalRef.current) clearInterval(identifyIntervalRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    lowAnalyserRef.current = null;
    midAnalyserRef.current = null;
    streamRef.current = null;
    bleQueueRef.current = null;
    setActive(false);
    setSongInfo(null);
    prevSampleRef.current = 0;
    agcAvgRef.current = 0.01;
    beatPhaseRef.current = 1;
    framesPerBeatRef.current = 60;
    adaptiveThreshRef.current = 0.15;
    transientAvgRef.current = 0.1;
    onsetTimesRef.current = [];
    lastOnsetRef.current = 0;
    bpmRef.current = 0;
    acrBpmRef.current = null;
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 8000 });
      const source = ctx.createMediaStreamSource(stream);

      const lowFilter = ctx.createBiquadFilter();
      lowFilter.type = "bandpass";
      lowFilter.frequency.value = 60;
      lowFilter.Q.value = 1.2;

      const midFilter = ctx.createBiquadFilter();
      midFilter.type = "bandpass";
      midFilter.frequency.value = 130;
      midFilter.Q.value = 0.6;

      const lowAnalyser = ctx.createAnalyser();
      lowAnalyser.fftSize = 32;
      lowAnalyser.smoothingTimeConstant = 0;

      const midAnalyser = ctx.createAnalyser();
      midAnalyser.fftSize = 32;
      midAnalyser.smoothingTimeConstant = 0;

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

  // Periodically try to identify the song (every 30s)
  useEffect(() => {
    if (!active) return;

    // First identification after 3s
    const initialTimeout = setTimeout(() => {
      identifySong();
    }, 3000);

    // Then every 30s
    identifyIntervalRef.current = window.setInterval(() => {
      identifySong();
    }, 30000);

    return () => {
      clearTimeout(initialTimeout);
      if (identifyIntervalRef.current) clearInterval(identifyIntervalRef.current);
    };
  }, [active, identifySong]);

  useEffect(() => {
    if (!active || !lowAnalyserRef.current || !midAnalyserRef.current || !bleQueueRef.current) return;

    const lowAnalyser = lowAnalyserRef.current;
    const midAnalyser = midAnalyserRef.current;
    const ble = bleQueueRef.current;
    const lowTD = new Uint8Array(32);
    const midTD = new Uint8Array(32);

    const FLOOR = 0.05;

    const loop = () => {
      lowAnalyser.getByteTimeDomainData(lowTD);
      midAnalyser.getByteTimeDomainData(midTD);

      let lowSum = 0, lowMax = 0, midSum = 0, midMax = 0;
      for (let i = 0; i < 32; i++) {
        const lv = (lowTD[i] - 128) / 128;
        lowSum += lv * lv;
        const la = lv < 0 ? -lv : lv;
        if (la > lowMax) lowMax = la;

        const mv = (midTD[i] - 128) / 128;
        midSum += mv * mv;
        const ma = mv < 0 ? -mv : mv;
        if (ma > midMax) midMax = ma;
      }
      const lowRms = Math.sqrt(lowSum * 0.03125);
      const midRms = Math.sqrt(midSum * 0.03125);

      const rawEnergy = lowRms * 0.3 + midRms * 0.1 + lowMax * 0.45 + midMax * 0.15;

      const isSilence = rawEnergy < 0.015;
      if (!isSilence) {
        const agcAlpha = rawEnergy > agcAvgRef.current ? 0.05 : 0.002;
        agcAvgRef.current += (rawEnergy - agcAvgRef.current) * agcAlpha;
      }
      const agcGain = agcAvgRef.current > 0.0001 ? 0.35 / agcAvgRef.current : 1;
      const energy = rawEnergy * Math.min(agcGain, 30);

      const delta = energy - prevSampleRef.current;
      prevSampleRef.current = isSilence ? energy * 0.5 + prevSampleRef.current * 0.5 : energy;
      const transient = isSilence ? 0 : (delta > 0 ? Math.min(1, delta * 6) : 0);

      if (!isSilence) {
        transientAvgRef.current += (transient - transientAvgRef.current) * 0.008;
        adaptiveThreshRef.current = Math.max(0.10, transientAvgRef.current * 3.0);
      }

      const phaseStep = isSilence ? 0.08 : (1 / framesPerBeatRef.current);
      beatPhaseRef.current = Math.min(1, beatPhaseRef.current + phaseStep);

      if (isSilence) {
        if (silenceStartRef.current === 0) silenceStartRef.current = performance.now();
        if (performance.now() - silenceStartRef.current > 10000 && bpmRef.current > 0) {
          if (bpmDisplayRef.current) bpmDisplayRef.current.textContent = '— BPM';
        }
      } else {
        silenceStartRef.current = 0;
      }

      const now = performance.now();
      const isOnset = !isSilence && transient > adaptiveThreshRef.current && now - lastOnsetRef.current > 250;

      if (isOnset) {
        beatPhaseRef.current = 0;

        // If we have ACRCloud BPM, use it as ground truth and only reset phase on onset
        if (acrBpmRef.current) {
          // Don't update framesPerBeat – ACRCloud BPM is authoritative
          if (bpmDisplayRef.current) {
            bpmDisplayRef.current.textContent = `${Math.round(acrBpmRef.current)} BPM ♪`;
          }
        } else if (lastOnsetRef.current > 0) {
          const interval = now - lastOnsetRef.current;
          const onsets = onsetTimesRef.current;
          onsets.push(interval);
          if (onsets.length > 16) onsets.shift();

          if (onsets.length >= 4 && onsets.length % 4 === 0) {
            const sorted = [...onsets].sort((a, b) => a - b);
            const q1 = sorted[Math.floor(sorted.length * 0.25)];
            const q3 = sorted[Math.floor(sorted.length * 0.75)];
            const filtered = sorted.filter(v => v >= q1 * 0.7 && v <= q3 * 1.3);
            if (filtered.length >= 3) {
              const mid = filtered[Math.floor(filtered.length / 2)];
              const bpmRaw = 60000 / mid;
              if (bpmRaw >= 60 && bpmRaw <= 200) {
                bpmRef.current = bpmRaw;
                framesPerBeatRef.current = (mid / 1000) * 60;
                if (bpmDisplayRef.current) bpmDisplayRef.current.textContent = `${Math.round(bpmRaw)} BPM`;
              }
            }
          }
        }
        lastOnsetRef.current = now;
      }

      const phase = beatPhaseRef.current;
      const pulse = Math.pow(1 - phase, 2.5);
      const onsetStrength = Math.min(1, (transient / adaptiveThreshRef.current - 1) * 2.5);
      const peakLevel = beatPhaseRef.current < 0.02
        ? Math.max(0.75, Math.min(1, 0.75 + onsetStrength * 0.25))
        : (pulseMaxRef.current ?? 0.85);
      if (beatPhaseRef.current < 0.02) pulseMaxRef.current = peakLevel;
      const curved = FLOOR + (peakLevel - FLOOR) * pulse;

      const pct = Math.max(3, Math.round(curved * 100));

      if (vizRef.current) {
        const s = vizRef.current.style;
        s.transform = `scale(${1 + curved * 0.25})`;
        s.boxShadow = `0 0 ${curved * 80}px ${curved * 25}px hsl(var(--foreground) / ${curved * 0.4})`;
      }
      if (barRef.current) barRef.current.style.width = `${pct}%`;
      if (pctRef.current) pctRef.current.textContent = `${pct}%`;

      if (now - throttleRef.current >= 25) {
        throttleRef.current = now;
        ble.brightness(pct);
      }

      const color = currentColorRef.current;
      const beatMs = bpmRef.current > 0 ? 60000 / bpmRef.current : 500;
      const colorFadeMs = Math.max(50, beatMs * 0.15);
      if (curved > 0.98 && beatPhaseRef.current < 0.1 && now - colorThrottleRef.current >= colorFadeMs) {
        colorThrottleRef.current = now;
        colorBoostedRef.current = true;
        const [cr, cg, cb] = color;
        const boost = (curved - 0.98) * 25;
        ble.color(
          Math.round(cr + (255 - cr) * boost),
          Math.round(cg + (255 - cg) * boost),
          Math.round(cb + (255 - cb) * boost),
        );
      } else if (curved <= 0.95 && colorBoostedRef.current && now - colorThrottleRef.current >= colorFadeMs) {
        colorThrottleRef.current = now;
        colorBoostedRef.current = false;
        ble.color(color[0], color[1], color[2]);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  useEffect(() => stop, [stop]);

  // Auto-start when char becomes available
  useEffect(() => {
    if (char && !active) {
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [char]);

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

      {/* Song info */}
      {active && songInfo && (
        <div className="flex items-center gap-2 text-center">
          <Music className="w-4 h-4 text-muted-foreground shrink-0" />
          <div className="text-sm">
            <span className="font-medium text-foreground">{songInfo.title}</span>
            <span className="text-muted-foreground"> — {songInfo.artist}</span>
          </div>
        </div>
      )}

      {active && identifying && !songInfo && (
        <div className="text-xs text-muted-foreground animate-pulse">
          Identifierar låt...
        </div>
      )}

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
              {acrBpmRef.current ? 'Exakt BPM · ACRCloud' : 'Dual-band · BPM-synk · 40Hz BLE'}
            </span>
            <span ref={bpmDisplayRef} className="text-xs font-mono text-foreground">— BPM</span>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-xs">
        {active
          ? songInfo
            ? `Spelar: ${songInfo.title} · Exakt BPM från ACRCloud`
            : "Ljuset pulserar med basslaget – identifierar låten..."
          : "Isolerar basfrekvenser och styr ljusstyrkan efter kickdrum/bas. Välj färg först."
        }
      </p>
    </div>
  );
}
