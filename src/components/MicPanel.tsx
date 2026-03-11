import { useState, useRef, useCallback, useEffect } from "react";
import { sendBrightness, sendColor } from "@/lib/bledom";
import { Activity } from "lucide-react";

interface MicPanelProps {
  char: any;
  currentColor: [number, number, number];
  externalBpm?: number | null;
  sonosPosition?: { positionMs: number; receivedAt: number } | null;
  durationMs?: number | null;
  punchWhite: boolean;
  onBpmChange?: (bpm: number | null) => void;
}

// Priority-aware BLE command queue
function createBleQueue(charRef: { current: any }) {
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
      const c = charRef.current;
      if (!c) return;
      pendingBrightness = () => sendBrightness(c, val);
      process();
    },
    color(r: number, g: number, b: number) {
      const c = charRef.current;
      if (!c) return;
      pendingColor = () => sendColor(c, r, g, b);
      process();
    },
  };
}

export default function MicPanel({ char, currentColor, externalBpm, sonosPosition, durationMs, punchWhite, onBpmChange }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);
  const colorThrottleRef = useRef<number>(0);
  const colorBoostedRef = useRef(false);
  const boostStartRef = useRef<number>(0);
  const boostColorRef = useRef<[number, number, number]>([255, 255, 255]);
  const bleQueueRef = useRef<ReturnType<typeof createBleQueue> | null>(null);
  const charRef = useRef<any>(char);
  useEffect(() => { charRef.current = char; }, [char]);
  const punchWhiteRef = useRef(true);
  useEffect(() => { punchWhiteRef.current = punchWhite; }, [punchWhite]);

  // Ref for currentColor so the rAF loop never restarts on color change
  const currentColorRef = useRef(currentColor);
  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

  // Direct DOM refs to avoid React re-renders in hot loop
  const vizRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<SVGSVGElement>(null);
  const progressRingRef = useRef<SVGCircleElement>(null);
  const ringWrapRef = useRef<SVGSVGElement>(null);

  // Envelope follower state
  const prevSampleRef = useRef(0);
  const agcAvgRef = useRef(0.01);

  // Beat-phase pulse model
  const beatPhaseRef = useRef(1);
  const framesPerBeatRef = useRef(60);
  const adaptiveThreshRef = useRef(0.15);
  const pulseMaxRef = useRef(0.7);
  const transientAvgRef = useRef(0.1);
  
  // Predictive beat: pre-fire BLE commands to compensate for latency
  const BLE_LATENCY_MS = 50; // pre-fire ms before expected beat
  const predictiveFiredRef = useRef(false);
  const lastBeatTimeRef = useRef(0);

  // Improved BPM detection refs
  const onsetTimesRef = useRef<number[]>([]);
  const lastOnsetRef = useRef(0);
  const bpmRef = useRef(0);
  const bpmConfidenceRef = useRef(0); // 0-1 confidence
  const silenceStartRef = useRef(0);
  
  // Sonos position phase-sync
  const sonosPositionRef = useRef<{ positionMs: number; receivedAt: number } | null>(null);
  const durationMsRef = useRef<number | null | undefined>(durationMs);
  const lastPhaseCorrectionRef = useRef(0);
  useEffect(() => {
    sonosPositionRef.current = sonosPosition ?? null;
  }, [sonosPosition]);
  useEffect(() => { durationMsRef.current = durationMs; }, [durationMs]);

  // Auto-correlation BPM: track energy history for spectral tempo
  const energyHistoryRef = useRef<number[]>([]);
  const energyHistoryMaxLen = 256; // ~4s at 60fps

  const onBpmChangeRef = useRef(onBpmChange);
  useEffect(() => { onBpmChangeRef.current = onBpmChange; }, [onBpmChange]);

  // Apply external BPM from Sonos lookup as a strong prior
  const externalBpmRef = useRef<number | null>(null);
  useEffect(() => {
    externalBpmRef.current = externalBpm ?? null;
    if (externalBpm && externalBpm >= 40 && externalBpm <= 220) {
      bpmRef.current = externalBpm;
      bpmConfidenceRef.current = 0.8;
      const beatMs = 60000 / externalBpm;
      framesPerBeatRef.current = (beatMs / 1000) * 60;
      onBpmChangeRef.current?.(externalBpm);
    }
  }, [externalBpm]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intensityHistoryRef = useRef<{ pct: number; r: number; g: number; b: number; beat?: boolean }[]>([]);
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
      bleQueueRef.current = createBleQueue(charRef);
      setActive(true);
    } catch {
      // Mic access denied
    }
    // charRef (not char) is used inside — keep start stable to avoid re-creating audio pipeline
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active || !lowAnalyserRef.current || !midAnalyserRef.current || !bleQueueRef.current) return;

    const lowAnalyser = lowAnalyserRef.current;
    const midAnalyser = midAnalyserRef.current;
    const ble = bleQueueRef.current;
    const lowTD = new Uint8Array(32);
    const midTD = new Uint8Array(32);

    const FLOOR = 0.10;

    // Auto-correlation BPM estimation from energy history
    const estimateBpmFromHistory = () => {
      const history = energyHistoryRef.current;
      if (history.length < 120) return; // need ~2s minimum

      const len = history.length;
      let mean = 0;
      for (let i = 0; i < len; i++) mean += history[i];
      mean /= len;

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

      if (bestCorr > 0.15) {
        const autoBpm = (60 * 60) / bestLag;
        return { bpm: autoBpm, confidence: bestCorr };
      }
      return null;
    };

    // ─── Sub-function: sample energy from analysers ───
    const sampleEnergy = () => {
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

      return { energy, transient, isSilence, rawEnergy };
    };

    // ─── Sub-function: beat detection, phase tracking, BPM estimation ───
    const detectBeatsAndBpm = (transient: number, isSilence: boolean, now: number) => {
      const phaseStep = isSilence ? 0.08 : (1 / framesPerBeatRef.current);
      const prevPhase = beatPhaseRef.current;
      beatPhaseRef.current = Math.min(1, beatPhaseRef.current + phaseStep);
      // Reset predictive flag when phase wraps (beat passed without onset)
      if (prevPhase < 0.5 && beatPhaseRef.current >= 0.5) {
        predictiveFiredRef.current = false;
      }

      // Sonos position phase correction
      const sonosPos = sonosPositionRef.current;
      if (sonosPos && bpmRef.current > 0 && now - lastPhaseCorrectionRef.current > 500) {
        lastPhaseCorrectionRef.current = now;
        const elapsed = now - sonosPos.receivedAt;
        const estimatedMs = sonosPos.positionMs + elapsed;
        const beatIntervalMs = 60000 / bpmRef.current;
        const sonosPhase = (estimatedMs % beatIntervalMs) / beatIntervalMs;
        const currentPhase = beatPhaseRef.current;
        let phaseDiff = sonosPhase - currentPhase;
        if (phaseDiff > 0.5) phaseDiff -= 1;
        if (phaseDiff < -0.5) phaseDiff += 1;
        if (Math.abs(phaseDiff) > 0.05) {
          beatPhaseRef.current = ((currentPhase + phaseDiff * 0.15) % 1 + 1) % 1;
        }
      }

      if (isSilence) {
        if (silenceStartRef.current === 0) silenceStartRef.current = now;
        if (now - silenceStartRef.current > 10000 && bpmRef.current > 0) {
          onBpmChangeRef.current?.(null);
        }
      } else {
        silenceStartRef.current = 0;
      }

      const isOnset = !isSilence && transient > adaptiveThreshRef.current && now - lastOnsetRef.current > 250;

      // Sub-threshold micro-pulse
      const isMicroHit = !isSilence && !isOnset && transient > adaptiveThreshRef.current * 0.3 && beatPhaseRef.current > 0.15;
      if (isMicroHit) {
        const strength = transient / adaptiveThreshRef.current;
        const nudge = strength * 0.4;
        beatPhaseRef.current = Math.min(beatPhaseRef.current, 1 - nudge);
      }

      if (isOnset) {
        beatPhaseRef.current = 0;
        predictiveFiredRef.current = false;

        if (lastOnsetRef.current > 0) {
          const interval = now - lastOnsetRef.current;
          const onsets = onsetTimesRef.current;
          onsets.push(interval);
          if (onsets.length > 24) onsets.shift();

          if (onsets.length >= 4) {
            const sorted = [...onsets].sort((a, b) => a - b);
            const q1 = sorted[Math.floor(sorted.length * 0.2)];
            const q3 = sorted[Math.floor(sorted.length * 0.8)];
            const filtered = sorted.filter(v => v >= q1 * 0.7 && v <= q3 * 1.3);

            let onsetBpm = 0;
            let onsetConf = 0;
            if (filtered.length >= 3) {
              const mid = filtered[Math.floor(filtered.length / 2)];
              onsetBpm = 60000 / mid;
              const variance = filtered.reduce((s, v) => s + (v - mid) ** 2, 0) / filtered.length;
              onsetConf = Math.max(0, 1 - Math.sqrt(variance) / mid);
            }

            const autoBpmResult = estimateBpmFromHistory();

            let finalBpm = onsetBpm;
            let finalConf = onsetConf;

            if (autoBpmResult && autoBpmResult.bpm >= 60 && autoBpmResult.bpm <= 200) {
              if (onsetBpm > 0) {
                const ratio = autoBpmResult.bpm / onsetBpm;
                if (ratio > 0.9 && ratio < 1.1) {
                  finalBpm = (onsetBpm * onsetConf + autoBpmResult.bpm * autoBpmResult.confidence) / (onsetConf + autoBpmResult.confidence);
                  finalConf = Math.min(1, (onsetConf + autoBpmResult.confidence) * 0.7);
                } else if (autoBpmResult.confidence > onsetConf) {
                  finalBpm = autoBpmResult.bpm;
                  finalConf = autoBpmResult.confidence * 0.8;
                }
                if (ratio > 1.8 && ratio < 2.2) {
                  finalBpm = onsetBpm;
                  finalConf = Math.max(onsetConf, autoBpmResult.confidence * 0.6);
                } else if (ratio > 0.45 && ratio < 0.55) {
                  finalBpm = autoBpmResult.bpm;
                  finalConf = autoBpmResult.confidence * 0.7;
                }
              } else {
                finalBpm = autoBpmResult.bpm;
                finalConf = autoBpmResult.confidence * 0.6;
              }
            }

            if (finalBpm >= 60 && finalBpm <= 200 && finalConf > 0.1) {
              const hasExternal = externalBpmRef.current !== null && externalBpmRef.current > 0;

              if (hasExternal) {
                const extBpm = externalBpmRef.current!;
                const diff = Math.abs(finalBpm - extBpm);
                if (diff < 8) {
                  bpmRef.current += (finalBpm - bpmRef.current) * 0.05;
                }
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

              onBpmChangeRef.current?.(Math.round(bpmRef.current));
            }
          }
        }
        lastOnsetRef.current = now;
      }

      return isOnset;
    };

    // ─── Sub-function: compute brightness from beat phase ───
    const computeBrightness = (isOnset: boolean, transient: number) => {
      const phase = beatPhaseRef.current;
      const pulse = Math.pow(1 - phase, 2.5);
      const onsetStrength = isOnset ? Math.min(1, transient / (adaptiveThreshRef.current * 2.5)) : 0;
      const peakLevel = beatPhaseRef.current < 0.02
        ? Math.max(0.45, Math.min(1, 0.45 + onsetStrength * 0.55))
        : (pulseMaxRef.current ?? 0.6);
      if (beatPhaseRef.current < 0.02) pulseMaxRef.current = peakLevel;
      const linear = peakLevel * pulse;
      const curved = Math.pow(linear, 0.55);

      let finalCurved = curved;
      if (bpmRef.current > 0 && curved < 0.25) {
        const bpmPulse = Math.pow(1 - phase, 2.0);
        const synthCurved = 0.15 + bpmPulse * 0.35;
        finalCurved = Math.max(curved, synthCurved);
      }

      const floored = Math.max(FLOOR, finalCurved);
      const pct = Math.max(3, Math.round(floored * 100));

      return { phase, curved, finalCurved, pct };
    };

    // ─── Sub-function: update DOM visuals (glow, ring, canvas) ───
    const updateVisuals = (finalCurved: number, pct: number, isOnset: boolean, now: number) => {
      if (vizRef.current) {
        const s = vizRef.current.style;
        const [cr, cg, cb] = currentColorRef.current;
        const lift = 0.5;
        const gr = Math.round(cr + (255 - cr) * lift);
        const gg = Math.round(cg + (255 - cg) * lift);
        const gb = Math.round(cb + (255 - cb) * lift);
        s.transform = `translate(-50%, -50%) scale(${1 + finalCurved * 0.32})`;
        s.opacity = String(0.35 + finalCurved * 0.9);
        s.background = `radial-gradient(circle, rgba(${gr}, ${gg}, ${gb}, ${0.25 + finalCurved * 0.4}) 0%, rgba(${gr}, ${gg}, ${gb}, ${0.12 + finalCurved * 0.28}) 38%, rgba(${cr}, ${cg}, ${cb}, ${0.04 + finalCurved * 0.1}) 58%, rgba(${cr}, ${cg}, ${cb}, 0) 78%)`;
        s.boxShadow = `0 0 ${22 + finalCurved * 80}px ${8 + finalCurved * 30}px rgba(${gr}, ${gg}, ${gb}, ${0.22 + finalCurved * 0.55})`;
      }
      if (ringWrapRef.current) {
        const ringStyle = ringWrapRef.current.style;
        const [cr2, cg2, cb2] = currentColorRef.current;
        const gr2 = Math.round(cr2 + (255 - cr2) * 0.4);
        const gg2 = Math.round(cg2 + (255 - cg2) * 0.4);
        const gb2 = Math.round(cb2 + (255 - cb2) * 0.4);
        ringStyle.transform = `scale(${1 + finalCurved * 0.12}) rotate(-90deg)`;
        ringStyle.filter = `drop-shadow(0 0 ${6 + finalCurved * 18}px rgba(${gr2}, ${gg2}, ${gb2}, ${0.4 + finalCurved * 0.5}))`;
      }
      const sPos = sonosPositionRef.current;
      const dur = durationMsRef.current;
      if (progressRingRef.current && sPos && dur && dur > 0) {
        const elapsed = now - sPos.receivedAt;
        const currentPos = Math.min(sPos.positionMs + elapsed, dur);
        const fraction = currentPos / dur;
        const circumference = 2 * Math.PI * 60;
        progressRingRef.current.style.strokeDashoffset = String(circumference * (1 - fraction));
      }

      // Store base color for chart
      const baseColor = currentColorRef.current;
      const hist2 = intensityHistoryRef.current;
      hist2.push({ pct, r: baseColor[0], g: baseColor[1], b: baseColor[2], beat: isOnset });
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
          const threshold = 85;

          const chartHeight = h * 0.7;
          const chartTop = (h - chartHeight) / 2;
          const yThresh = chartTop + chartHeight - (threshold / 100) * chartHeight;

          ctx2d.clearRect(0, 0, w, h);

          const futureFrames = bpmRef.current > 0 ? Math.round(framesPerBeatRef.current * 2) : 0;
          const totalFrames = HISTORY_LEN + futureFrames;

          if (len2 > 1) {
            const step = w / (totalFrames - 1);
            const offsetX = (HISTORY_LEN - len2) * step;

            for (let i = 1; i < len2; i++) {
              const x0 = offsetX + (i - 1) * step;
              const x1 = offsetX + i * step;
              const s0 = samples[i - 1];
              const s1 = samples[i];
              const y0 = chartTop + chartHeight - (s0.pct / 100) * chartHeight;
              const y1 = chartTop + chartHeight - (s1.pct / 100) * chartHeight;
              const chartBottom = chartTop + chartHeight;
              const cr = s1.r, cg = s1.g, cb = s1.b;
              const avgPct = (s0.pct + s1.pct) / 2;
              const brightFactor = Math.max(0.15, avgPct / 100);
              const lift = brightFactor * 0.6;
              const lr = Math.round(cr + (255 - cr) * lift);
              const lg = Math.round(cg + (255 - cg) * lift);
              const lb = Math.round(cb + (255 - cb) * lift);

              const grad = ctx2d.createLinearGradient(x0, y1, x0, chartBottom);
              grad.addColorStop(0, `rgba(${lr}, ${lg}, ${lb}, ${0.15 + brightFactor * 0.4})`);
              grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0.03)`);
              ctx2d.fillStyle = grad;
              ctx2d.beginPath();
              ctx2d.moveTo(x0, chartBottom);
              ctx2d.lineTo(x0, y0);
              ctx2d.lineTo(x1, y1);
              ctx2d.lineTo(x1, chartBottom);
              ctx2d.closePath();
              ctx2d.fill();

              if (punchWhiteRef.current && (s0.pct > threshold || s1.pct > threshold)) {
                const clipY0 = Math.min(y0, yThresh);
                const clipY1 = Math.min(y1, yThresh);
                const whiteT = Math.min(1, (avgPct - threshold) / (100 - threshold));
                const fillGrad = ctx2d.createLinearGradient(0, yThresh, 0, Math.min(clipY0, clipY1));
                fillGrad.addColorStop(0, `rgba(255, 255, 255, 0.05)`);
                fillGrad.addColorStop(1, `rgba(255, 255, 255, ${0.1 + whiteT * 0.4})`);
                ctx2d.fillStyle = fillGrad;
                ctx2d.beginPath();
                ctx2d.moveTo(x0, yThresh);
                ctx2d.lineTo(x0, clipY0);
                ctx2d.lineTo(x1, clipY1);
                ctx2d.lineTo(x1, yThresh);
                ctx2d.closePath();
                ctx2d.fill();
              }

              const lineAlpha = 0.4 + brightFactor * 0.6;
              ctx2d.beginPath();
              ctx2d.moveTo(x0, Math.max(y0, yThresh));
              ctx2d.lineTo(x1, Math.max(y1, yThresh));
              ctx2d.strokeStyle = `rgba(${lr}, ${lg}, ${lb}, ${lineAlpha})`;
              ctx2d.lineWidth = 2.5;
              ctx2d.stroke();

              if (punchWhiteRef.current && (s0.pct > threshold || s1.pct > threshold)) {
                const aboveY0 = Math.min(y0, yThresh);
                const aboveY1 = Math.min(y1, yThresh);
                const whiteT = Math.min(1, (avgPct - threshold) / (100 - threshold));
                ctx2d.beginPath();
                ctx2d.moveTo(x0, aboveY0);
                ctx2d.lineTo(x1, aboveY1);
                ctx2d.strokeStyle = `rgba(255, 255, 255, ${0.3 + whiteT * 0.6})`;
                ctx2d.lineWidth = 2.5;
                ctx2d.stroke();
              }
            }
          }
        }
      }
    };

    // ─── Sub-function: unified BLE dispatch (predictive + normal + kick) ───
    const dispatchBle = (pct: number, curved: number, now: number) => {
      // Predictive pre-fire: send early to compensate for BLE latency
      if (bpmRef.current > 0 && bpmConfidenceRef.current > 0.3 && !predictiveFiredRef.current) {
        const beatMs = 60000 / bpmRef.current;
        const phaseMs = beatPhaseRef.current * beatMs;
        const msUntilBeat = beatMs - phaseMs;
        if (msUntilBeat <= BLE_LATENCY_MS && msUntilBeat > 0) {
          predictiveFiredRef.current = true;
          const predictedPct = Math.max(60, Math.round((pulseMaxRef.current ?? 0.7) * 100));
          ble.brightness(predictedPct);
          if (punchWhiteRef.current && predictedPct > 85) {
            const color = currentColorRef.current;
            const [cr, cg, cb] = color;
            const boost = Math.min(1, (predictedPct - 85) / 15);
            ble.color(
              Math.round(cr + (255 - cr) * boost),
              Math.round(cg + (255 - cg) * boost),
              Math.round(cb + (255 - cb) * boost),
            );
            colorBoostedRef.current = true;
            boostStartRef.current = now;
            boostColorRef.current = [
              Math.round(cr + (255 - cr) * boost),
              Math.round(cg + (255 - cg) * boost),
              Math.round(cb + (255 - cb) * boost),
            ];
          }
          return; // predictive handled this frame
        }
      }

      // Skip normal brightness + kick if predictive already fired for this beat
      const predictiveActive = predictiveFiredRef.current && beatPhaseRef.current < 0.15;

      // Normal brightness (throttled)
      if (!predictiveActive && now - throttleRef.current >= 25) {
        throttleRef.current = now;
        ble.brightness(pct);
      }

      // Color kick / fade-back
      const color = currentColorRef.current;
      const beatMs = bpmRef.current > 0 ? 60000 / bpmRef.current : 500;
      const colorFadeMs = Math.max(50, beatMs * 0.15);

      if (!predictiveActive && punchWhiteRef.current && curved > 0.98 && beatPhaseRef.current < 0.1 && now - colorThrottleRef.current >= colorFadeMs) {
        colorThrottleRef.current = now;
        colorBoostedRef.current = true;
        boostStartRef.current = now;
        const [cr, cg, cb] = color;
        const boost = (curved - 0.98) * 25;
        const br = Math.round(cr + (255 - cr) * boost);
        const bg = Math.round(cg + (255 - cg) * boost);
        const bb = Math.round(cb + (255 - cb) * boost);
        boostColorRef.current = [br, bg, bb];
        ble.color(br, bg, bb);
      } else if (colorBoostedRef.current && now - colorThrottleRef.current >= colorFadeMs) {
        // Logarithmic fade-out from boost color back to base color
        const fadeDuration = Math.max(80, beatMs * 0.6);
        const elapsed = now - boostStartRef.current;
        const tLinear = Math.min(elapsed / fadeDuration, 1);
        const tLog = 1 - Math.pow(1 - tLinear, 3);

        const [br, bg, bb] = boostColorRef.current;
        const fr = Math.round(br + (color[0] - br) * tLog);
        const fg = Math.round(bg + (color[1] - bg) * tLog);
        const fb = Math.round(bb + (color[2] - bb) * tLog);

        colorThrottleRef.current = now;
        ble.color(fr, fg, fb);

        if (tLinear >= 1) {
          colorBoostedRef.current = false;
        }
      }
    };

    // ─── Main loop: orchestrates sub-functions ───
    const loop = () => {
      const now = performance.now();
      const { transient, isSilence } = sampleEnergy();
      const isOnset = detectBeatsAndBpm(transient, isSilence, now);
      const { curved, finalCurved, pct } = computeBrightness(isOnset, transient);
      updateVisuals(finalCurved, pct, isOnset, now);
      dispatchBle(pct, curved, now);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  useEffect(() => stop, [stop]);

  // Auto-start when char becomes available.
  // charRef keeps the rAF loop connected to the current BLE characteristic,
  // so reconnects work implicitly without restarting the audio pipeline.
  useEffect(() => {
    if (char && !active) {
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [char]);

    return (
    <div className="flex flex-col items-center justify-center h-full px-4 overflow-hidden">
      {/* Bass pulse visualizer — fills available space */}
      <div className="relative aspect-square w-full max-w-[min(80vw,80vh)] flex items-center justify-center overflow-visible">
        <div
          ref={vizRef}
          className="absolute left-1/2 top-1/2 w-[90%] h-[90%] -translate-x-1/2 -translate-y-1/2 rounded-full will-change-transform pointer-events-none"
          style={{
            background: `radial-gradient(circle, rgba(${currentColor[0]}, ${currentColor[1]}, ${currentColor[2]}, 0.28) 0%, rgba(${currentColor[0]}, ${currentColor[1]}, ${currentColor[2]}, 0.14) 38%, rgba(${currentColor[0]}, ${currentColor[1]}, ${currentColor[2]}, 0.04) 58%, rgba(${currentColor[0]}, ${currentColor[1]}, ${currentColor[2]}, 0) 78%)`,
            filter: "blur(22px)",
            opacity: active ? 0.7 : 0.35,
            boxShadow: active
              ? `0 0 60px rgba(${currentColor[0]}, ${currentColor[1]}, ${currentColor[2]}, 0.45)`
              : undefined,
          }}
        />
        <svg
          ref={ringWrapRef}
          viewBox="0 0 140 140"
          className="absolute w-[85%] h-[85%]"
          style={{ overflow: 'visible', transform: 'rotate(-90deg)' }}
        >
          {/* Background track */}
          <circle
            cx="70" cy="70" r="60"
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth="2"
            opacity="0.3"
          />
          {/* Progress ring */}
          <circle
            ref={progressRingRef}
            cx="70" cy="70" r="60"
            fill="none"
            stroke={`rgb(${currentColor[0]}, ${currentColor[1]}, ${currentColor[2]})`}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={String(2 * Math.PI * 60)}
            strokeDashoffset={String(2 * Math.PI * 60)}
            className="transition-[stroke] duration-500"
            style={{ filter: `drop-shadow(0 0 10px rgba(${currentColor[0]}, ${currentColor[1]}, ${currentColor[2]}, 0.75))` }}
          />
        </svg>
        {/* Center content: circular-masked chart inside the ring */}
        <div className="absolute inset-0 flex items-center justify-center z-10">
          {active ? (
            <div className="w-[72%] h-[72%] rounded-full overflow-hidden flex items-center justify-center">
              <canvas
                ref={canvasRef}
                width={400}
                height={400}
                className="w-full h-full"
              />
            </div>
          ) : (
            <Activity
              ref={iconRef}
              className="w-14 h-14"
              style={{
                opacity: 0.3,
                color: undefined,
              }}
            />
          )}
        </div>
      </div>

      {!active && (
        <p className="text-xs text-muted-foreground text-center max-w-xs mt-4">
          Isolerar basfrekvenser och styr ljusstyrkan efter kickdrum/bas. Välj färg först.
        </p>
      )}
    </div>
  );
}
