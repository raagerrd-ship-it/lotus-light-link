import { useEffect, useRef } from "react";
import { sendColorAndBrightness, setActiveChar, setPipelineTimings, onBleWrite, sendColor } from "@/lib/bledom";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/drawChart";
import { getCalibration, saveCalibration, applyColorCalibration, type LightCalibration } from "@/lib/lightCalibration";
import { getActiveDeviceName } from "@/lib/lightCalibration";
import { interpolateEnergy } from "@/lib/energyInterpolate";
import type { EnergySample } from "@/lib/energyInterpolate";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  sonosVolume?: number; // 0–100
  /** If set, provides the current playback position for curve-driven mode */
  getPosition?: () => { positionMs: number; receivedAt: number } | null;
  /** Pre-recorded energy curve for the current song (null = first listen, record mode) */
  energyCurve?: EnergySample[] | null;
  /** Callback to save recorded energy samples when song ends / changes */
  onSaveEnergyCurve?: (samples: EnergySample[], volume: number | null) => void;
  /** Volume the saved curve was recorded at (for compensation) */
  recordedVolume?: number | null;
}

const HISTORY_LEN = 120;

// Learned AGC: adapts to song dynamics
const AGC_MAX_DECAY = 0.995;
const AGC_MIN_RISE = 0.9999;
const AGC_ATTACK = 0.1;
const AGC_FLOOR = 0.002;
const PEAK_MAX_DECAY = 0.9998;

// Energy curve recording interval (~100ms)
const CURVE_RECORD_INTERVAL_MS = 100;

const MicPanel = ({ char, currentColor, sonosVolume, getPosition, energyCurve, onSaveEnergyCurve }: MicPanelProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const smoothedRef = useRef(0);
  const samplesRef = useRef<ChartSample[]>([]);
  const colorRef = useRef(currentColor);
  const charRef = useRef(char);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const whiteKickUntilRef = useRef(0);
  const volumeRef = useRef(sonosVolume);
  const calRef = useRef<LightCalibration>(getCalibration());
  const lastColorStateRef = useRef<'normal' | 'white'>('normal');
  const lastBaseColorRef = useRef<[number, number, number]>(currentColor);
  const chartDirtyRef = useRef(false);
  const rafIdRef = useRef(0);
  const initCal = calRef.current;
  const agcMaxRef = useRef(initCal.agcMax > 0 ? initCal.agcMax : 0.01);
  const agcMinRef = useRef(initCal.agcMin);
  const lastVolumeRef = useRef(sonosVolume);
  const agcSaveTimerRef = useRef(0);
  const agcPeakMaxRef = useRef(initCal.agcMax > 0 ? initCal.agcMax : 0.01);

  // Energy curve refs
  const energyCurveRef = useRef(energyCurve);
  const getPositionRef = useRef(getPosition);
  const recordedSamplesRef = useRef<EnergySample[]>([]);
  const lastRecordTimeRef = useRef(0);
  const onSaveCurveRef = useRef(onSaveEnergyCurve);

  useEffect(() => { energyCurveRef.current = energyCurve; }, [energyCurve]);
  useEffect(() => { getPositionRef.current = getPosition; }, [getPosition]);
  useEffect(() => { onSaveCurveRef.current = onSaveEnergyCurve; }, [onSaveEnergyCurve]);

  // When energy curve changes (new song with saved curve, or first song without),
  // flush previously recorded samples
  useEffect(() => {
    const prev = recordedSamplesRef.current;
    if (prev.length > 10 && onSaveCurveRef.current) {
      onSaveCurveRef.current(prev, volumeRef.current ?? null);
    }
    recordedSamplesRef.current = [];
    lastRecordTimeRef.current = 0;
  }, [energyCurve]);

  useEffect(() => {
    colorRef.current = currentColor;
    lastBaseColorRef.current = currentColor;
    lastColorStateRef.current = 'normal';
    agcMaxRef.current = Math.max(agcMaxRef.current * 0.5, 0.01);
    agcMinRef.current = 0;
    samplesRef.current = [];
    resetChartScaler();
  }, [currentColor]);

  useEffect(() => { volumeRef.current = sonosVolume; }, [sonosVolume]);

  useEffect(() => {
    charRef.current = char;
    if (char) {
      setActiveChar(char);
      const [r, g, b] = colorRef.current;
      sendColor(char, r, g, b);
    }
  }, [char]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'light-calibration') {
        calRef.current = getCalibration();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Decoupled chart rendering via rAF
  useEffect(() => {
    const drawLoop = () => {
      if (chartDirtyRef.current) {
        chartDirtyRef.current = false;
        const canvas = canvasRef.current;
        if (canvas) {
          drawIntensityChart(canvas, samplesRef.current, HISTORY_LEN, 0, 0, false, 1);
        }
      }
      rafIdRef.current = requestAnimationFrame(drawLoop);
    };
    rafIdRef.current = requestAnimationFrame(drawLoop);
    return () => cancelAnimationFrame(rafIdRef.current);
  }, []);

  /**
   * Get the current song position in seconds, compensating for network latency.
   */
  const getSongPositionSec = (): number | null => {
    const gp = getPositionRef.current;
    if (!gp) return null;
    const pos = gp();
    if (!pos) return null;
    const elapsed = performance.now() - pos.receivedAt;
    return (pos.positionMs + elapsed) / 1000;
  };

  useEffect(() => {
    let stopped = false;

    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;

        const audioCtx = new AudioContext({ latencyHint: 'interactive' });
        ctxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);

        const hiShelf = audioCtx.createBiquadFilter();
        hiShelf.type = 'highshelf';
        hiShelf.frequency.value = 2000;
        hiShelf.gain.value = 6;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0;
        source.connect(hiShelf);
        hiShelf.connect(analyser);
        analyserRef.current = analyser;

        const worker = new Worker("/tick-worker.js");
        workerRef.current = worker;
        const buf = new Float32Array(analyser.fftSize);

        worker.onmessage = () => {
          if (stopped) return;
          const an = analyserRef.current;
          if (!an) return;

          const tickStart = performance.now();
          const cal = calRef.current;
          const curve = energyCurveRef.current;
          const hasCurve = Array.isArray(curve) && curve.length > 10;

          let rms: number;
          let rmsEnd: number;

          if (hasCurve) {
            // ── Curve-driven mode: interpolate pre-recorded energy ──
            const posSec = getSongPositionSec();
            if (posSec != null) {
              rms = interpolateEnergy(curve!, posSec);
              // Scale to match mic RMS range using AGC state
              rms *= Math.max(0.01, agcMaxRef.current);
            } else {
              rms = 0;
            }
            rmsEnd = performance.now();

            // Also read mic for curve improvement (merge)
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const micRms = Math.sqrt(sum / buf.length);
            // Record mic samples for curve merge if we have position
            if (posSec != null && micRms > 0.001) {
              const now = performance.now();
              if (now - lastRecordTimeRef.current >= CURVE_RECORD_INTERVAL_MS) {
                lastRecordTimeRef.current = now;
                // Normalize mic RMS to 0-1 using current AGC
                const range = Math.max(AGC_FLOOR, agcMaxRef.current - agcMinRef.current);
                const normMic = Math.min(1, Math.max(0, (micRms - agcMinRef.current) / range));
                // Find existing energy at this time
                const existingE = interpolateEnergy(curve!, posSec);
                // Blend: 80% old curve, 20% new mic data
                const blended = existingE * 0.8 + normMic * 0.2;
                recordedSamplesRef.current.push({ t: posSec, e: blended });
              }
            }
          } else {
            // ── Mic-driven mode: standard RMS ──
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            rms = Math.sqrt(sum / buf.length);
            rmsEnd = performance.now();

            // Record samples for energy curve (first listen)
            const posSec = getSongPositionSec();
            if (posSec != null) {
              const now = performance.now();
              if (now - lastRecordTimeRef.current >= CURVE_RECORD_INTERVAL_MS) {
                lastRecordTimeRef.current = now;
                // We'll normalize after AGC below
              }
            }
          }

          // Step 2: Smoothing + normalization (same for both modes)
          const prevAbsFactor = agcPeakMaxRef.current > 0
            ? Math.min(1, agcMaxRef.current / agcPeakMaxRef.current)
            : 1;
          const reactivity = 1 + (1 - prevAbsFactor) * 2;
          const prev = smoothedRef.current;
          const attackA = Math.min(0.9, cal.attackAlpha * reactivity);
          const releaseA = Math.min(0.5, cal.releaseAlpha * reactivity);
          const alpha = rms > prev ? attackA : releaseA;
          const smoothed = prev + alpha * (rms - prev);
          smoothedRef.current = smoothed;

          // Learned AGC
          const vol = volumeRef.current;
          const prevVol = lastVolumeRef.current;
          if (prevVol != null && vol != null && Math.abs(vol - prevVol) > 3) {
            agcMaxRef.current = smoothed + 0.01;
            agcMinRef.current = smoothed;
            lastVolumeRef.current = vol;
          } else if (prevVol == null && vol != null) {
            lastVolumeRef.current = vol;
          }

          if (smoothed > agcMaxRef.current) {
            agcMaxRef.current += (smoothed - agcMaxRef.current) * AGC_ATTACK;
          } else {
            agcMaxRef.current *= AGC_MAX_DECAY;
          }

          if (smoothed < agcMinRef.current || agcMinRef.current === 0) {
            agcMinRef.current = smoothed;
          } else {
            agcMinRef.current += (smoothed - agcMinRef.current) * (1 - AGC_MIN_RISE);
          }

          const range = Math.max(AGC_FLOOR, agcMaxRef.current - agcMinRef.current);
          const normalized = Math.min(1, Math.max(0, (smoothed - agcMinRef.current) / range));

          if (agcMaxRef.current > agcPeakMaxRef.current) {
            agcPeakMaxRef.current = agcMaxRef.current;
          } else {
            agcPeakMaxRef.current *= PEAK_MAX_DECAY;
          }

          const absoluteFactor = Math.min(1, Math.max(0.08, agcMaxRef.current / agcPeakMaxRef.current));
          const effectiveMax = cal.minBrightness + (cal.maxBrightness - cal.minBrightness) * absoluteFactor;
          const pct = Math.round(cal.minBrightness + normalized * (effectiveMax - cal.minBrightness));

          // Record energy sample for first-listen curve (after AGC normalization)
          if (!hasCurve) {
            const posSec = getSongPositionSec();
            if (posSec != null) {
              const now = performance.now();
              // Check if enough time has passed (re-check since we computed above)
              const lastRec = recordedSamplesRef.current;
              const lastT = lastRec.length > 0 ? lastRec[lastRec.length - 1].t : -1;
              if (posSec - lastT >= CURVE_RECORD_INTERVAL_MS / 1000) {
                lastRecordTimeRef.current = now;
                recordedSamplesRef.current.push({ t: posSec, e: normalized });
              }
            }
          }

          // White kick
          const now = performance.now();
          const inWhiteKick = now < whiteKickUntilRef.current;
          if (pct > 95 && !inWhiteKick) {
            whiteKickUntilRef.current = now + cal.whiteKickMs;
          }
          const isWhite = now < whiteKickUntilRef.current;
          const smoothEnd = performance.now();

          // Step 3: BLE commands
          const c = charRef.current;
          if (c) {
            if (isWhite) {
              sendColorAndBrightness(c, 255, 255, 255, 100);
              lastColorStateRef.current = 'white';
            } else {
              const calibrated = applyColorCalibration(...colorRef.current, cal);
              sendColorAndBrightness(c, ...calibrated, pct);
              lastColorStateRef.current = 'normal';
            }
          }
          const bleEnd = performance.now();

          setPipelineTimings({
            rmsMs: rmsEnd - tickStart,
            smoothMs: smoothEnd - rmsEnd,
            bleCallMs: bleEnd - smoothEnd,
            totalTickMs: bleEnd - tickStart,
          });

          // Save AGC state every 10 seconds
          const nowMs = performance.now();
          if (nowMs - agcSaveTimerRef.current > 10_000) {
            agcSaveTimerRef.current = nowMs;
            const updated = { ...calRef.current, agcMin: agcMinRef.current, agcMax: agcMaxRef.current, agcVolume: volumeRef.current ?? null };
            calRef.current = updated;
            saveCalibration(updated, getActiveDeviceName() ?? undefined);
          }
        };

        onBleWrite((bright, r, g, b) => {
          if (stopped) return;
          const scale = bright / 100;
          samplesRef.current.push({
            pct: bright,
            r: Math.round(r * scale),
            g: Math.round(g * scale),
            b: Math.round(b * scale),
          });
          if (samplesRef.current.length > HISTORY_LEN) {
            samplesRef.current = samplesRef.current.slice(-HISTORY_LEN);
          }
          chartDirtyRef.current = true;
        });

        worker.postMessage("start");
      } catch (e) {
        console.error("[MicPanel] mic init failed", e);
      }
    };

    init();

    return () => {
      stopped = true;
      // Save any recorded energy samples on unmount
      const recorded = recordedSamplesRef.current;
      if (recorded.length > 10 && onSaveCurveRef.current) {
        onSaveCurveRef.current(recorded);
      }
      onBleWrite(null);
      workerRef.current?.postMessage("stop");
      workerRef.current?.terminate();
      streamRef.current?.getTracks().forEach(t => t.stop());
      ctxRef.current?.close().catch(() => {});
      resetChartScaler();
    };
  }, []);

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = window.innerWidth * devicePixelRatio;
      canvas.height = window.innerHeight * devicePixelRatio;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const [r, g, b] = currentColor;

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ opacity: 0.6 }}
      />
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none transition-all duration-100"
        style={{
          width: 120,
          height: 120,
          background: `radial-gradient(circle, rgba(${r},${g},${b},0.4) 0%, transparent 70%)`,
          boxShadow: `0 0 60px rgba(${r},${g},${b},0.3)`,
        }}
      />
    </div>
  );
};

export default MicPanel;
