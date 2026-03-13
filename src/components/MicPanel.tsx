import { useState, useRef, useCallback, useEffect } from "react";
import { sendBrightness, sendColor } from "@/lib/bledom";
import { Activity } from "lucide-react";
import { estimateBpmFromHistory } from "@/lib/bpmEstimate";
import { drawIntensityChart, resetChartScaler, type ChartSample } from "@/lib/drawChart";
import { liftColor } from "@/lib/colorUtils";
import { type SongSection, getCurrentSection, getSectionBehavior, getUpcomingDrop } from "@/lib/songSections";

interface MicPanelProps {
  char: any;
  currentColor: [number, number, number];
  externalBpm?: number | null;
  sonosPosition?: { positionMs: number; receivedAt: number } | null;
  getPosition?: () => { positionMs: number; receivedAt: number } | null;
  durationMs?: number | null;
  punchWhite: boolean;
  onBpmChange?: (bpm: number | null) => void;
  songSections?: SongSection[];
  songDrops?: number[];
  syncOffsetMs?: number;
  smoothedRtt?: number;
  onSyncDriftMs?: (driftMs: number) => void;
  onSectionChange?: (section: SongSection | null) => void;
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

export default function MicPanel({ char, currentColor, externalBpm, sonosPosition, getPosition, durationMs, punchWhite, onBpmChange, songSections, songDrops, syncOffsetMs = 0, smoothedRtt = 150, onSyncDriftMs, onSectionChange }: MicPanelProps) {
  const [active, setActive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);
  const bleQueueRef = useRef<ReturnType<typeof createBleQueue> | null>(null);
  const charRef = useRef<any>(char);
  useEffect(() => { charRef.current = char; }, [char]);
  const punchWhiteRef = useRef(true);
  useEffect(() => { punchWhiteRef.current = punchWhite; }, [punchWhite]);

  // Consolidated color boost state
  const colorBoostRef = useRef({
    active: false,
    startTime: 0,
    color: [255, 255, 255] as [number, number, number],
    throttle: 0,
  });

  // Smooth color transition refs
  const currentColorRef = useRef(currentColor);
  const targetColorRef = useRef(currentColor);
  const prevColorRef = useRef(currentColor);
  const colorTransitionStartRef = useRef(0);
  const COLOR_FADE_MS = 500;

  useEffect(() => {
    // When the target color changes, start a fade from current interpolated color
    prevColorRef.current = currentColorRef.current;
    targetColorRef.current = currentColor;
    colorTransitionStartRef.current = performance.now();
    // Reset chart normalization on track/section change
    resetChartScaler();
    // Immediately send new color to BLE (don't wait for audio loop)
    if (bleQueueRef.current) {
      bleQueueRef.current.color(...currentColor);
    }
  }, [currentColor]);

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
  const BLE_LATENCY_MS = 50;
  const predictiveFiredRef = useRef(false);
  const lastBeatTimeRef = useRef(0);

  // Improved BPM detection refs
  const onsetTimesRef = useRef<number[]>([]);
  const lastOnsetRef = useRef(0);
  const bpmRef = useRef(0);
  const bpmConfidenceRef = useRef(0);
  const silenceStartRef = useRef(0);
  
  // Sonos position phase-sync
  const getPositionRef = useRef(getPosition);
  useEffect(() => { getPositionRef.current = getPosition; }, [getPosition]);
  const sonosPositionRef = useRef<{ positionMs: number; receivedAt: number } | null>(null);
  const durationMsRef = useRef<number | null | undefined>(durationMs);
  const lastPhaseCorrectionRef = useRef(0);
  // Update position from getPosition (real-time ref) or fall back to prop
  useEffect(() => { sonosPositionRef.current = sonosPosition ?? null; }, [sonosPosition]);
  useEffect(() => { durationMsRef.current = durationMs; }, [durationMs]);

  // Song section refs
  const songSectionsRef = useRef<SongSection[]>([]);
  const songDropsRef = useRef<number[]>([]);
  const dropFiredRef = useRef<Set<number>>(new Set());
  const syncOffsetMsRef = useRef(syncOffsetMs);
  const smoothedRttRef = useRef(smoothedRtt);
  useEffect(() => { songSectionsRef.current = songSections ?? []; dropFiredRef.current.clear(); }, [songSections]);
  useEffect(() => { songDropsRef.current = songDrops ?? []; dropFiredRef.current.clear(); }, [songDrops]);
  useEffect(() => { syncOffsetMsRef.current = syncOffsetMs; }, [syncOffsetMs]);
  useEffect(() => { smoothedRttRef.current = smoothedRtt; }, [smoothedRtt]);

  // Auto-correlation BPM: track energy history for spectral tempo
  const energyHistoryRef = useRef<number[]>([]);
  const energyHistoryMaxLen = 256;

  const onBpmChangeRef = useRef(onBpmChange);
  useEffect(() => { onBpmChangeRef.current = onBpmChange; }, [onBpmChange]);

  // Auto-calibration: internal autonomous drift accumulator
  const onSyncDriftMsRef = useRef(onSyncDriftMs);
  useEffect(() => { onSyncDriftMsRef.current = onSyncDriftMs; }, [onSyncDriftMs]);
  const internalOffsetRef = useRef(0); // autonomous accumulated offset (ms)
  const driftBufferRef = useRef<number[]>([]);
  const lastDriftReportRef = useRef(0);

  // Section change callback
  const onSectionChangeRef = useRef(onSectionChange);
  useEffect(() => { onSectionChangeRef.current = onSectionChange; }, [onSectionChange]);
  const lastSectionTypeRef = useRef<string | null>(null);

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
  const intensityHistoryRef = useRef<ChartSample[]>([]);
  const canvasFrameRef = useRef(0);
  const HISTORY_LEN = 300;

  // Worker + Wake Lock refs
  const workerRef = useRef<Worker | null>(null);
  const wakeLockRef = useRef<any>(null);

  // Shared state between worker-tick (analysis) and rAF (visuals)
  const lastTickResultRef = useRef<{
    finalCurved: number;
    pct: number;
    isOnset: boolean;
    now: number;
  }>({ finalCurved: 0, pct: 3, isOnset: false, now: 0 });

  // Audio nodes
  const subAnalyserRef = useRef<AnalyserNode | null>(null);
  const lowAnalyserRef = useRef<AnalyserNode | null>(null);
  const midAnalyserRef = useRef<AnalyserNode | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    workerRef.current?.postMessage('stop');
    workerRef.current?.terminate();
    workerRef.current = null;
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    subAnalyserRef.current = null;
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

      // Sub/Kick band: Lowpass 100 Hz
      const subFilter = ctx.createBiquadFilter();
      subFilter.type = "lowpass";
      subFilter.frequency.value = 100;
      subFilter.Q.value = 0.7;

      // Bass band: Bandpass 150 Hz
      const lowFilter = ctx.createBiquadFilter();
      lowFilter.type = "bandpass";
      lowFilter.frequency.value = 150;
      lowFilter.Q.value = 0.8;

      // Low-mid band: Bandpass 350 Hz
      const midFilter = ctx.createBiquadFilter();
      midFilter.type = "bandpass";
      midFilter.frequency.value = 350;
      midFilter.Q.value = 1.0;

      const subAnalyser = ctx.createAnalyser();
      subAnalyser.fftSize = 32;
      subAnalyser.smoothingTimeConstant = 0;

      const lowAnalyser = ctx.createAnalyser();
      lowAnalyser.fftSize = 32;
      lowAnalyser.smoothingTimeConstant = 0;

      const midAnalyser = ctx.createAnalyser();
      midAnalyser.fftSize = 32;
      midAnalyser.smoothingTimeConstant = 0;

      source.connect(subFilter);
      source.connect(lowFilter);
      source.connect(midFilter);
      subFilter.connect(subAnalyser);
      lowFilter.connect(lowAnalyser);
      midFilter.connect(midAnalyser);

      audioContextRef.current = ctx;
      subAnalyserRef.current = subAnalyser;
      lowAnalyserRef.current = lowAnalyser;
      midAnalyserRef.current = midAnalyser;
      streamRef.current = stream;
      bleQueueRef.current = createBleQueue(charRef);
      setActive(true);

      // Wake Lock: keep screen on
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
          // Re-acquire on visibility change
          const reacquire = async () => {
            if (document.visibilityState === 'visible' && !wakeLockRef.current) {
              try {
                wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
              } catch {}
            }
          };
          wakeLockRef.current?.addEventListener('release', () => { wakeLockRef.current = null; });
          document.addEventListener('visibilitychange', reacquire);
        }
      } catch {}
    } catch {
      // Mic access denied
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active || !subAnalyserRef.current || !lowAnalyserRef.current || !midAnalyserRef.current || !bleQueueRef.current) return;

    const subAnalyser = subAnalyserRef.current;
    const lowAnalyser = lowAnalyserRef.current;
    const midAnalyser = midAnalyserRef.current;
    const ble = bleQueueRef.current;
    const subTD = new Uint8Array(32);
    const lowTD = new Uint8Array(32);
    const midTD = new Uint8Array(32);

    

    // ─── Sub-function: sample energy from 3-band analysers ───
    const sampleEnergy = () => {
      subAnalyser.getByteTimeDomainData(subTD);
      lowAnalyser.getByteTimeDomainData(lowTD);
      midAnalyser.getByteTimeDomainData(midTD);

      let subSum = 0, subMax = 0, lowSum = 0, lowMax = 0, midSum = 0, midMax = 0;
      for (let i = 0; i < 32; i++) {
        const sv = (subTD[i] - 128) / 128;
        subSum += sv * sv;
        const sa = sv < 0 ? -sv : sv;
        if (sa > subMax) subMax = sa;

        const lv = (lowTD[i] - 128) / 128;
        lowSum += lv * lv;
        const la = lv < 0 ? -lv : lv;
        if (la > lowMax) lowMax = la;

        const mv = (midTD[i] - 128) / 128;
        midSum += mv * mv;
        const ma = mv < 0 ? -mv : mv;
        if (ma > midMax) midMax = ma;
      }
      const subRms = Math.sqrt(subSum * 0.03125);
      const lowRms = Math.sqrt(lowSum * 0.03125);
      const midRms = Math.sqrt(midSum * 0.03125);

      // 3-band energy with caps: sub 100%, bass 90%, mid 50%
      const subEnergy  = subRms * 0.3 + subMax * 0.7;
      const bassEnergy = (lowRms * 0.3 + lowMax * 0.7) * 0.9;
      const midEnergy  = (midRms * 0.3 + midMax * 0.7) * 0.5;
      const rawEnergy  = subEnergy * 0.55 + bassEnergy * 0.30 + midEnergy * 0.15;
      // Ambient energy: broader frequency mix for the always-on zone
      const ambientEnergy = subEnergy * 0.25 + bassEnergy * 0.35 + midEnergy * 0.40;

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
      // During silence, rapidly decay phase to 1 (= no pulse) instead of cycling
      const silenceDuration = silenceStartRef.current > 0 ? now - silenceStartRef.current : 0;
      const phaseStep = isSilence
        ? (silenceDuration > 300 ? 0.25 : 0.08) // fast fade-out after 300ms silence
        : (1 / framesPerBeatRef.current);
      const prevPhase = beatPhaseRef.current;
      beatPhaseRef.current = Math.min(1, beatPhaseRef.current + phaseStep);
      if (prevPhase < 0.5 && beatPhaseRef.current >= 0.5) {
        predictiveFiredRef.current = false;
      }

      // Sonos position phase correction — read real-time position from ref
      const freshPos = getPositionRef.current?.();
      if (freshPos) sonosPositionRef.current = freshPos;
      const sonosPos = sonosPositionRef.current;
      if (sonosPos && bpmRef.current > 0 && now - lastPhaseCorrectionRef.current > 200) {
        lastPhaseCorrectionRef.current = now;
        const elapsed = now - sonosPos.receivedAt;
        const beatIntervalMs = 60000 / bpmRef.current;
        // Use internal autonomous offset instead of external prop
        const estimatedMs = sonosPos.positionMs + elapsed + internalOffsetRef.current;
        const sonosPhase = (estimatedMs % beatIntervalMs) / beatIntervalMs;
        const currentPhase = beatPhaseRef.current;
        let phaseDiff = sonosPhase - currentPhase;
        if (phaseDiff > 0.5) phaseDiff -= 1;
        if (phaseDiff < -0.5) phaseDiff += 1;

        // Accumulate drift into internal offset for autonomous correction
        const driftMs = phaseDiff * beatIntervalMs;
        driftBufferRef.current.push(driftMs);
        if (driftBufferRef.current.length > 12) driftBufferRef.current.shift();
        
        if (driftBufferRef.current.length >= 4 && now - lastDriftReportRef.current > 500) {
          const buf = driftBufferRef.current;
          // Use median for robustness against outliers
          const sorted = [...buf].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          const variance = buf.reduce((s, v) => s + (v - median) ** 2, 0) / buf.length;
          const stddev = Math.sqrt(variance);
          
          if (stddev < 80) {
            lastDriftReportRef.current = now;
            // Aggressive correction: apply 40% of median drift directly
            const correction = median * 0.4;
            internalOffsetRef.current = Math.max(-500, Math.min(500, internalOffsetRef.current + correction));
            // Report to parent for debug display
            onSyncDriftMsRef.current?.(internalOffsetRef.current);
          }
        }

        // More aggressive phase correction: 25% nudge (was 15%)
        if (Math.abs(phaseDiff) > 0.015) {
          const strength = Math.abs(phaseDiff) > 0.1 ? 0.4 : 0.25;
          beatPhaseRef.current = ((currentPhase + phaseDiff * strength) % 1 + 1) % 1;
        }
      }

      if (isSilence) {
        if (silenceStartRef.current === 0) silenceStartRef.current = now;
        // Clear BPM after 2s silence (was 10s)
        if (now - silenceStartRef.current > 2000 && bpmRef.current > 0) {
          onBpmChangeRef.current?.(null);
        }
      } else {
        silenceStartRef.current = 0;
      }

      // Dynamic min-interval: 55% of current beat interval, clamped to 150ms minimum
      const beatIntervalMs = bpmRef.current > 0 ? 60000 / bpmRef.current : 455;
      const minInterval = Math.max(150, beatIntervalMs * 0.55);

      // Phase-gating: off-beat onsets need 1.3x stronger transient (reduced from 1.6x)
      const phase = beatPhaseRef.current;
      const nearBeat = phase < 0.25 || phase > 0.75;
      const gatedThreshold = nearBeat
        ? adaptiveThreshRef.current
        : adaptiveThreshRef.current * 1.3;

      const isOnset = !isSilence && transient > gatedThreshold && now - lastOnsetRef.current > minInterval;

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

            const autoBpmResult = estimateBpmFromHistory(energyHistoryRef.current);

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
      // Get current section behavior
      let sectionBehavior = { maxBrightness: 1, beatReactivity: 1, breathingMode: false, punchWhiteOverride: null as boolean | null };
      const sonosPos = sonosPositionRef.current;
      let currentSec = 0;
      if (sonosPos) {
        const elapsed = performance.now() - sonosPos.receivedAt;
        currentSec = (sonosPos.positionMs + elapsed + syncOffsetMsRef.current) / 1000;
      }
      let currentSection: SongSection | null = null;
      if (songSectionsRef.current.length > 0) {
        currentSection = getCurrentSection(songSectionsRef.current, currentSec);
        sectionBehavior = getSectionBehavior(currentSection);
        // Report section changes
        const sKey = currentSection?.type ?? null;
        if (sKey !== lastSectionTypeRef.current) {
          lastSectionTypeRef.current = sKey;
          onSectionChangeRef.current?.(currentSection);
        }
      }

      const phase = beatPhaseRef.current;

      // Breathing mode: gentle sine wave
      if (sectionBehavior.breathingMode) {
        const breathe = 0.3 + 0.2 * Math.sin(performance.now() / 1200);
        const pct = Math.round(3 + 97 * breathe * sectionBehavior.maxBrightness);
        return { phase, curved: breathe, finalCurved: breathe, pct, sectionBehavior, currentSec };
      }

      // Asymmetric envelope: instant attack, slow decay
      // phase 0 = beat onset, phase 1 = next beat
      const decay = Math.pow(1 - phase, 1.8); // gentler exponent = longer tail
      const onsetStrength = isOnset ? Math.min(1, transient / (adaptiveThreshRef.current * 2.5)) : 0;
      const peakLevel = beatPhaseRef.current < 0.02
        ? Math.max(0.45, Math.min(1, 0.45 + onsetStrength * 0.55))
        : (pulseMaxRef.current ?? 0.6);
      if (beatPhaseRef.current < 0.02) pulseMaxRef.current = peakLevel;
      const linear = peakLevel * decay * sectionBehavior.beatReactivity;
      const curved = Math.pow(linear, 0.45); // softer curve = more visible tail

      let finalCurved = curved;
      // Synthetic fallback pulse — only when audio is actively playing (not silent)
      const silenceDur = silenceStartRef.current > 0 ? performance.now() - silenceStartRef.current : 0;
      if (bpmRef.current > 0 && curved < 0.25 && silenceDur < 200) {
        const bpmPulse = Math.pow(1 - phase, 2.0);
        const synthCurved = 0.05 + bpmPulse * 0.25 * sectionBehavior.beatReactivity;
        finalCurved = Math.max(curved, synthCurved);
      }

      // Smooth fade-to-dim on silence: ease down to baseline over ~1.5s
      const FADE_DURATION = 1500;
      const BASELINE = 0.06; // ~8% brightness as resting state
      if (silenceDur > 0) {
        const fadeFactor = Math.max(0, 1 - silenceDur / FADE_DURATION);
        finalCurved = BASELINE + (finalCurved - BASELINE) * fadeFactor;
      }

      // Cap by section max brightness
      finalCurved = Math.min(finalCurved, sectionBehavior.maxBrightness);

      const floored = Math.max(BASELINE * (silenceDur > 0 ? 1 : 0), finalCurved);
      const pct = Math.round(3 + 97 * Math.pow(floored, 0.8));

      return { phase, curved, finalCurved, pct, sectionBehavior, currentSec };
    };


    // ─── Sub-function: update DOM visuals (glow, ring, canvas) ───
    const updateVisuals = (finalCurved: number, pct: number, isOnset: boolean, now: number) => {
      if (vizRef.current) {
        const s = vizRef.current.style;
        const [cr, cg, cb] = currentColorRef.current;
        const [gr, gg, gb] = liftColor(currentColorRef.current, 0.5);
        s.transform = `translate(-50%, -50%) scale(${1 + finalCurved * 0.32})`;
        s.opacity = String(0.35 + finalCurved * 0.9);
        s.background = `radial-gradient(circle, rgba(${gr}, ${gg}, ${gb}, ${0.25 + finalCurved * 0.4}) 0%, rgba(${gr}, ${gg}, ${gb}, ${0.12 + finalCurved * 0.28}) 38%, rgba(${cr}, ${cg}, ${cb}, ${0.04 + finalCurved * 0.1}) 58%, rgba(${cr}, ${cg}, ${cb}, 0) 78%)`;
        s.boxShadow = `0 0 ${22 + finalCurved * 80}px ${8 + finalCurved * 30}px rgba(${gr}, ${gg}, ${gb}, ${0.22 + finalCurved * 0.55})`;
      }
      if (ringWrapRef.current) {
        const ringStyle = ringWrapRef.current.style;
        const [gr2, gg2, gb2] = liftColor(currentColorRef.current, 0.4);
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
        // Pass current brightness (finalCurved) to fade chart with the light
        const chartBrightness = silenceStartRef.current > 0
          ? Math.max(0, 1 - (performance.now() - silenceStartRef.current) / 1500)
          : 1;
        drawIntensityChart(
          canvasRef.current,
          hist2,
          HISTORY_LEN,
          framesPerBeatRef.current,
          bpmRef.current,
          punchWhiteRef.current,
          chartBrightness,
        );
      }
    };

    // ─── Sub-function: unified BLE dispatch (predictive + normal + kick) ───
    const dispatchBle = (pct: number, curved: number, now: number, sectionBehavior: { punchWhiteOverride: boolean | null }, currentSec: number) => {
      const boost = colorBoostRef.current;
      const effectivePunchWhite = sectionBehavior.punchWhiteOverride !== null ? sectionBehavior.punchWhiteOverride : punchWhiteRef.current;

      // Predictive drop flash: dynamic lookahead = 100ms + smoothedRtt/2
      const lookaheadSec = 0.1 + (smoothedRttRef.current / 2) / 1000;
      const upcomingDrop = getUpcomingDrop(songDropsRef.current, currentSec, lookaheadSec);
      if (upcomingDrop !== null && !dropFiredRef.current.has(upcomingDrop)) {
        dropFiredRef.current.add(upcomingDrop);
        ble.brightness(100);
        const color = currentColorRef.current;
        const lifted = liftColor(color, 1.0);
        ble.color(...lifted);
        boost.active = true;
        boost.startTime = now;
        boost.color = lifted;
        return;
      }

      // Predictive pre-fire
      if (bpmRef.current > 0 && bpmConfidenceRef.current > 0.3 && !predictiveFiredRef.current) {
        const beatMs = 60000 / bpmRef.current;
        const phaseMs = beatPhaseRef.current * beatMs;
        const msUntilBeat = beatMs - phaseMs;
        if (msUntilBeat <= BLE_LATENCY_MS && msUntilBeat > 0) {
          predictiveFiredRef.current = true;
          const predictedPct = Math.max(40, Math.round((pulseMaxRef.current ?? 0.7) * 100));
          ble.brightness(predictedPct);
          if (effectivePunchWhite && predictedPct > 85) {
            const color = currentColorRef.current;
            const boostFactor = Math.min(1, (predictedPct - 85) / 15);
            const lifted = liftColor(color, boostFactor);
            ble.color(...lifted);
            boost.active = true;
            boost.startTime = now;
            boost.color = lifted;
          }
          return;
        }
      }

      const predictiveActive = predictiveFiredRef.current && beatPhaseRef.current < 0.08;

      // Normal brightness (throttled)
      if (!predictiveActive && now - throttleRef.current >= 25) {
        throttleRef.current = now;
        ble.brightness(pct);
      }

      // Color kick / fade-back
      const color = currentColorRef.current;
      const beatMs = bpmRef.current > 0 ? 60000 / bpmRef.current : 500;
      const colorFadeMs = Math.max(50, beatMs * 0.15);

      if (!predictiveActive && effectivePunchWhite && pct > 85 && beatPhaseRef.current < 0.1 && now - boost.throttle >= colorFadeMs) {
        boost.throttle = now;
        const boostFactor = Math.min(1, (pct - 85) / 15);
        const lifted = liftColor(color, boostFactor);
        boost.active = true;
        boost.startTime = now;
        boost.color = lifted;
        ble.color(...lifted);
      } else if (boost.active && now - boost.throttle >= colorFadeMs) {
        const fadeDuration = Math.max(80, beatMs * 0.6);
        const elapsed = now - boost.startTime;
        const tLinear = Math.min(elapsed / fadeDuration, 1);
        const tLog = 1 - Math.pow(1 - tLinear, 3);

        const [br, bg, bb] = boost.color;
        const fr = Math.round(br + (color[0] - br) * tLog);
        const fg = Math.round(bg + (color[1] - bg) * tLog);
        const fb = Math.round(bb + (color[2] - bb) * tLog);

        boost.throttle = now;
        ble.color(fr, fg, fb);

        if (tLinear >= 1) {
          boost.active = false;
        }
      }
    };

    // ─── Analysis tick (driven by Web Worker — runs in background) ───
    const analysisTick = () => {
      const now = performance.now();

      // Smooth color transition (lerp over COLOR_FADE_MS)
      const tStart = colorTransitionStartRef.current;
      if (tStart > 0) {
        const t = Math.min(1, (now - tStart) / COLOR_FADE_MS);
        const ease = t * (2 - t); // ease-out quadratic
        const prev = prevColorRef.current;
        const target = targetColorRef.current;
        currentColorRef.current = [
          Math.round(prev[0] + (target[0] - prev[0]) * ease),
          Math.round(prev[1] + (target[1] - prev[1]) * ease),
          Math.round(prev[2] + (target[2] - prev[2]) * ease),
        ];
        // Send interpolated color to BLE during fade (throttled ~40ms)
        if (!colorBoostRef.current.active && now - throttleRef.current >= 40) {
          throttleRef.current = now;
          ble.color(...currentColorRef.current);
        }
        if (t >= 1) colorTransitionStartRef.current = 0;
      }

      const { transient, isSilence } = sampleEnergy();
      const isOnset = detectBeatsAndBpm(transient, isSilence, now);
      const { curved, finalCurved, pct, sectionBehavior, currentSec } = computeBrightness(isOnset, transient);
      dispatchBle(pct, curved, now, sectionBehavior, currentSec);

      // Store result for rAF visual loop
      lastTickResultRef.current = { finalCurved, pct, isOnset, now };
    };

    // ─── Visual loop (rAF — pauses when tab hidden, saves battery) ───
    const renderLoop = () => {
      const { finalCurved, pct, isOnset, now } = lastTickResultRef.current;
      updateVisuals(finalCurved, pct, isOnset, now);
      rafRef.current = requestAnimationFrame(renderLoop);
    };

    // Start worker-driven tick
    const worker = new Worker('/tick-worker.js');
    worker.onmessage = () => analysisTick();
    worker.postMessage('start');
    workerRef.current = worker;

    // Start visual render loop
    rafRef.current = requestAnimationFrame(renderLoop);

    return () => {
      worker.postMessage('stop');
      worker.terminate();
      workerRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (char && !active) {
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [char]);

  return (
    <div className="flex flex-col items-center justify-center h-full px-4 overflow-hidden">
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
          <circle cx="70" cy="70" r="60" fill="none" stroke="hsl(var(--border))" strokeWidth="2" opacity="0.3" />
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
        <div className="absolute inset-0 flex items-center justify-center z-10">
          {active ? (
            <div className="w-[72%] h-[72%] rounded-full overflow-hidden flex items-center justify-center">
              <canvas ref={canvasRef} width={400} height={400} className="w-full h-full" />
            </div>
          ) : (
            <Activity
              ref={iconRef}
              className="w-14 h-14 animate-pulse"
              style={{ opacity: 0.4, color: `rgba(${currentColor[0]},${currentColor[1]},${currentColor[2]},0.6)` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
