import { useState, useRef, useCallback, useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { sendBrightness, sendColor } from "@/lib/bledom";
import { Activity } from "lucide-react";

interface MicPanelProps {
  char: any;
  currentColor: [number, number, number];
  externalBpm?: number | null;
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

export default function MicPanel({ char, currentColor, externalBpm }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const [punchWhite, setPunchWhite] = useState(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);
  const colorThrottleRef = useRef<number>(0);
  const colorBoostedRef = useRef(false);
  const bleQueueRef = useRef<ReturnType<typeof createBleQueue> | null>(null);
  const punchWhiteRef = useRef(true);
  useEffect(() => { punchWhiteRef.current = punchWhite; }, [punchWhite]);

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

  // Improved BPM detection refs
  const onsetTimesRef = useRef<number[]>([]);
  const lastOnsetRef = useRef(0);
  const bpmRef = useRef(0);
  const bpmConfidenceRef = useRef(0); // 0-1 confidence
  const silenceStartRef = useRef(0);
  
  // Auto-correlation BPM: track energy history for spectral tempo
  const energyHistoryRef = useRef<number[]>([]);
  const energyHistoryMaxLen = 256; // ~4s at 60fps

  const bpmDisplayRef = useRef<HTMLSpanElement>(null);

  // Apply external BPM from Sonos lookup as a strong prior
  const externalBpmRef = useRef<number | null>(null);
  useEffect(() => {
    externalBpmRef.current = externalBpm ?? null;
    if (externalBpm && externalBpm >= 40 && externalBpm <= 220) {
      bpmRef.current = externalBpm;
      bpmConfidenceRef.current = 0.8;
      const beatMs = 60000 / externalBpm;
      framesPerBeatRef.current = (beatMs / 1000) * 60;
      if (bpmDisplayRef.current) {
        bpmDisplayRef.current.textContent = `${Math.round(externalBpm)} BPM 🎵`;
      }
    }
  }, [externalBpm]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intensityHistoryRef = useRef<{ pct: number; r: number; g: number; b: number }[]>([]);
  const canvasFrameRef = useRef(0);
  const HISTORY_LEN = 300; // 5s × 60fps

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
    prevSampleRef.current = 0;
    agcAvgRef.current = 0.01;
    beatPhaseRef.current = 1;
    framesPerBeatRef.current = 60;
    adaptiveThreshRef.current = 0.15;
    transientAvgRef.current = 0.1;
    onsetTimesRef.current = [];
    lastOnsetRef.current = 0;
    bpmRef.current = 0;
    bpmConfidenceRef.current = 0;
    energyHistoryRef.current = [];
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

  useEffect(() => {
    if (!active || !lowAnalyserRef.current || !midAnalyserRef.current || !bleQueueRef.current) return;

    const lowAnalyser = lowAnalyserRef.current;
    const midAnalyser = midAnalyserRef.current;
    const ble = bleQueueRef.current;
    const lowTD = new Uint8Array(32);
    const midTD = new Uint8Array(32);

    const FLOOR = 0.05;

    // Auto-correlation BPM estimation from energy history
    const estimateBpmFromHistory = () => {
      const history = energyHistoryRef.current;
      if (history.length < 120) return; // need ~2s minimum

      const len = history.length;
      // Calculate mean
      let mean = 0;
      for (let i = 0; i < len; i++) mean += history[i];
      mean /= len;

      // Auto-correlation for lags corresponding to 60-200 BPM
      // At 60fps: 60BPM = lag 60, 200BPM = lag 18
      const minLag = 18; // 200 BPM
      const maxLag = Math.min(90, len - 1); // 40 BPM
      let bestLag = 30;
      let bestCorr = -1;

      for (let lag = minLag; lag <= maxLag; lag++) {
        let corr = 0;
        let norm1 = 0;
        let norm2 = 0;
        const n = len - lag;
        for (let i = 0; i < n; i++) {
          const a = history[i] - mean;
          const b = history[i + lag] - mean;
          corr += a * b;
          norm1 += a * a;
          norm2 += b * b;
        }
        const denom = Math.sqrt(norm1 * norm2);
        if (denom > 0) corr /= denom;

        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
        }
      }

      // Only use if correlation is strong enough
      if (bestCorr > 0.15) {
        const autoBpm = (60 * 60) / bestLag; // 60fps * 60s / lag
        return { bpm: autoBpm, confidence: bestCorr };
      }
      return null;
    };

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

      // Track energy history for auto-correlation BPM
      const hist = energyHistoryRef.current;
      hist.push(energy);
      if (hist.length > energyHistoryMaxLen) hist.shift();

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

      // Sub-threshold "micro-pulse": softer transients still nudge brightness up to ~40%
      const isMicroHit = !isSilence && !isOnset && transient > adaptiveThreshRef.current * 0.3 && beatPhaseRef.current > 0.15;
      if (isMicroHit) {
        // Nudge phase back proportionally – smaller hit = smaller nudge
        const strength = transient / adaptiveThreshRef.current; // 0.3–1.0 range
        const nudge = strength * 0.4; // max 40% phase reset
        beatPhaseRef.current = Math.min(beatPhaseRef.current, 1 - nudge);
      }

      if (isOnset) {
        beatPhaseRef.current = 0;

        if (lastOnsetRef.current > 0) {
          const interval = now - lastOnsetRef.current;
          const onsets = onsetTimesRef.current;
          onsets.push(interval);
          if (onsets.length > 24) onsets.shift(); // larger window for stability

          if (onsets.length >= 4) {
            // Multi-method BPM: onset intervals + auto-correlation
            const sorted = [...onsets].sort((a, b) => a - b);
            const q1 = sorted[Math.floor(sorted.length * 0.2)];
            const q3 = sorted[Math.floor(sorted.length * 0.8)];
            const filtered = sorted.filter(v => v >= q1 * 0.7 && v <= q3 * 1.3);
            
            let onsetBpm = 0;
            let onsetConf = 0;
            if (filtered.length >= 3) {
              // Weighted median – center values get more weight
              const mid = filtered[Math.floor(filtered.length / 2)];
              onsetBpm = 60000 / mid;
              // Confidence: low variance = high confidence
              const variance = filtered.reduce((s, v) => s + (v - mid) ** 2, 0) / filtered.length;
              onsetConf = Math.max(0, 1 - Math.sqrt(variance) / mid);
            }

            // Auto-correlation BPM
            const autoBpmResult = estimateBpmFromHistory();
            
            let finalBpm = onsetBpm;
            let finalConf = onsetConf;

            if (autoBpmResult && autoBpmResult.bpm >= 60 && autoBpmResult.bpm <= 200) {
              // Blend: if both agree (within 10%), high confidence
              if (onsetBpm > 0) {
                const ratio = autoBpmResult.bpm / onsetBpm;
                if (ratio > 0.9 && ratio < 1.1) {
                  // Strong agreement – average and boost confidence
                  finalBpm = (onsetBpm * onsetConf + autoBpmResult.bpm * autoBpmResult.confidence) / (onsetConf + autoBpmResult.confidence);
                  finalConf = Math.min(1, (onsetConf + autoBpmResult.confidence) * 0.7);
                } else if (autoBpmResult.confidence > onsetConf) {
                  // Auto-corr wins
                  finalBpm = autoBpmResult.bpm;
                  finalConf = autoBpmResult.confidence * 0.8;
                }
                // Check for half/double time agreement
                if (ratio > 1.8 && ratio < 2.2) {
                  finalBpm = onsetBpm; // onset is likely correct, auto-corr found half-time
                  finalConf = Math.max(onsetConf, autoBpmResult.confidence * 0.6);
                } else if (ratio > 0.45 && ratio < 0.55) {
                  finalBpm = autoBpmResult.bpm; // auto-corr found double-time
                  finalConf = autoBpmResult.confidence * 0.7;
                }
              } else {
                finalBpm = autoBpmResult.bpm;
                finalConf = autoBpmResult.confidence * 0.6;
              }
            }

            if (finalBpm >= 60 && finalBpm <= 200 && finalConf > 0.1) {
              // If we have an external BPM, only allow small drift corrections
              const hasExternal = externalBpmRef.current !== null && externalBpmRef.current > 0;
              
              if (hasExternal) {
                // Only nudge slightly toward local detection if it agrees
                const extBpm = externalBpmRef.current!;
                const diff = Math.abs(finalBpm - extBpm);
                if (diff < 8) {
                  // Local agrees with external — tiny correction
                  bpmRef.current += (finalBpm - bpmRef.current) * 0.05;
                }
                // Otherwise ignore local — trust the external source
              } else if (bpmRef.current > 0) {
                const diff = Math.abs(finalBpm - bpmRef.current);
                if (diff < 5) {
                  bpmRef.current += (finalBpm - bpmRef.current) * 0.15;
                } else if (diff < 15) {
                  bpmRef.current += (finalBpm - bpmRef.current) * 0.3;
                } else {
                  if (finalConf > 0.4) {
                    bpmRef.current = finalBpm;
                  }
                }
              } else {
                bpmRef.current = finalBpm;
              }
              
              bpmConfidenceRef.current = finalConf;
              const beatMs = 60000 / bpmRef.current;
              framesPerBeatRef.current = (beatMs / 1000) * 60;
              
              if (bpmDisplayRef.current) {
                const hasExt = externalBpmRef.current !== null && externalBpmRef.current > 0;
                const indicator = hasExt ? '🎵' : (finalConf > 0.6 ? '●●●' : finalConf > 0.3 ? '●●○' : '●○○');
                bpmDisplayRef.current.textContent = `${Math.round(bpmRef.current)} BPM ${indicator}`;
              }
            }
          }
        }
        lastOnsetRef.current = now;
      }

      const phase = beatPhaseRef.current;
      const pulse = Math.pow(1 - phase, 2.5);
      // Scale peak by how strong the onset actually was (transient 0-1)
      // Weak hits peak at ~50-65%, only hard hits reach 90-100%
      const onsetStrength = isOnset ? Math.min(1, transient / (adaptiveThreshRef.current * 2.5)) : 0;
      const peakLevel = beatPhaseRef.current < 0.02
        ? Math.max(0.45, Math.min(1, 0.45 + onsetStrength * 0.55))
        : (pulseMaxRef.current ?? 0.6);
      if (beatPhaseRef.current < 0.02) pulseMaxRef.current = peakLevel;
      const linear = FLOOR + (peakLevel - FLOOR) * pulse;
      // Logarithmic curve: lifts low values so subtle sounds are visible, 
      // but only the strongest hits reach max
      const curved = Math.pow(linear, 0.55);

      const pct = Math.max(3, Math.round(curved * 100));

      if (vizRef.current) {
        const s = vizRef.current.style;
        s.transform = `scale(${1 + curved * 0.25})`;
        s.boxShadow = `0 0 ${curved * 80}px ${curved * 25}px hsl(var(--foreground) / ${curved * 0.4})`;
      }
      if (barRef.current) barRef.current.style.width = `${pct}%`;
      if (pctRef.current) pctRef.current.textContent = `${pct}%`;

      // Compute the actual output color (with white boost if applicable)
      const baseColor = currentColorRef.current;
      let outR = baseColor[0], outG = baseColor[1], outB = baseColor[2];
      if (punchWhiteRef.current && curved > 0.85) {
        // Blend toward white based on intensity
        const t = Math.min(1, (curved - 0.85) / 0.15);
        outR = Math.round(outR + (255 - outR) * t);
        outG = Math.round(outG + (255 - outG) * t);
        outB = Math.round(outB + (255 - outB) * t);
      }

      // Push to intensity history with actual color
      const hist2 = intensityHistoryRef.current;
      hist2.push({ pct, r: outR, g: outG, b: outB });
      if (hist2.length > HISTORY_LEN) hist2.shift();

      // Draw canvas chart every 3rd frame (~20fps)
      canvasFrameRef.current++;
      if (canvasFrameRef.current % 3 === 0 && canvasRef.current) {
        const canvas = canvasRef.current;
        const ctx2d = canvas.getContext('2d');
        if (ctx2d) {
          const w = canvas.width;
          const h = canvas.height;
          const samples = hist2;
          const len2 = samples.length;

          ctx2d.clearRect(0, 0, w, h);

          if (len2 > 1) {
            const step = w / (HISTORY_LEN - 1);
            const offsetX = (HISTORY_LEN - len2) * step;

            // Draw per-segment with actual color
            for (let i = 1; i < len2; i++) {
              const x0 = offsetX + (i - 1) * step;
              const x1 = offsetX + i * step;
              const s0 = samples[i - 1];
              const s1 = samples[i];
              const y0 = h - (s0.pct / 100) * h;
              const y1 = h - (s1.pct / 100) * h;

              // Filled area segment
              const grad = ctx2d.createLinearGradient(0, 0, 0, h);
              grad.addColorStop(0, `rgba(${s1.r}, ${s1.g}, ${s1.b}, 0.3)`);
              grad.addColorStop(1, `rgba(${s1.r}, ${s1.g}, ${s1.b}, 0.02)`);
              ctx2d.fillStyle = grad;
              ctx2d.beginPath();
              ctx2d.moveTo(x0, h);
              ctx2d.lineTo(x0, y0);
              ctx2d.lineTo(x1, y1);
              ctx2d.lineTo(x1, h);
              ctx2d.closePath();
              ctx2d.fill();

              // Line segment
              ctx2d.beginPath();
              ctx2d.moveTo(x0, y0);
              ctx2d.lineTo(x1, y1);
              ctx2d.strokeStyle = `rgba(${s1.r}, ${s1.g}, ${s1.b}, 0.8)`;
              ctx2d.lineWidth = 1.5;
              ctx2d.stroke();
            }
          }
        }
      }

      if (now - throttleRef.current >= 25) {
        throttleRef.current = now;
        ble.brightness(pct);
      }

      const color = currentColorRef.current;
      const beatMs = bpmRef.current > 0 ? 60000 / bpmRef.current : 500;
      const colorFadeMs = Math.max(50, beatMs * 0.15);
      if (punchWhiteRef.current && curved > 0.98 && beatPhaseRef.current < 0.1 && now - colorThrottleRef.current >= colorFadeMs) {
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

          <div className="flex justify-between items-center">
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={punchWhite}
                onCheckedChange={(v) => setPunchWhite(!!v)}
              />
              <span className="text-xs text-muted-foreground">Vit kick</span>
            </label>
            <span ref={bpmDisplayRef} className="text-xs font-mono text-foreground">— BPM</span>
          </div>

          {/* Intensity history chart */}
          <div className="rounded-lg overflow-hidden" style={{ background: 'hsl(0 0% 15% / 0.3)' }}>
            <canvas
              ref={canvasRef}
              width={320}
              height={80}
              className="w-full h-20"
            />
          </div>
        </div>
      )}

      {!active && (
        <p className="text-xs text-muted-foreground text-center max-w-xs">
          Isolerar basfrekvenser och styr ljusstyrkan efter kickdrum/bas. Välj färg först.
        </p>
      )}
    </div>
  );
}
