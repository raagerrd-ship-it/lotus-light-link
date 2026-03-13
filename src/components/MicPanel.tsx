import { useEffect, useRef } from "react";
import { sendColor, sendBrightness, setActiveChar, setPipelineTimings } from "@/lib/bledom";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/drawChart";
import { getCalibration, applyColorCalibration, type LightCalibration } from "@/lib/lightCalibration";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  sonosVolume?: number; // 0–100
}

const HISTORY_LEN = 120;

const MicPanel = ({ char, currentColor, sonosVolume }: MicPanelProps) => {
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
  // Cached calibration — read once, update on storage change
  const calRef = useRef<LightCalibration>(getCalibration());
  // Track last sent color state to avoid redundant color writes
  const lastColorStateRef = useRef<'normal' | 'white'>('normal');
  const lastBaseColorRef = useRef<[number, number, number]>(currentColor);
  // Flag for chart: new sample ready
  const chartDirtyRef = useRef(false);
  const rafIdRef = useRef(0);

  useEffect(() => {
    colorRef.current = currentColor;
    // Color changed → force a color send on next tick
    lastBaseColorRef.current = currentColor;
    lastColorStateRef.current = 'normal'; // reset to trigger re-send
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

  // Listen for calibration changes (from Calibrate page)
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

  useEffect(() => {
    let stopped = false;

    const init = async () => {
      try {
        // Low-latency mic: disable all processing
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
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
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

          // Step 1: RMS calculation
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          const rmsEnd = performance.now();

          // Step 2: Smoothing + normalization
          const prev = smoothedRef.current;
          const alpha = rms > prev ? cal.attackAlpha : cal.releaseAlpha;
          const smoothed = prev + alpha * (rms - prev);
          smoothedRef.current = smoothed;

          const vol = volumeRef.current;
          const rmsDivisor = vol != null ? Math.max(0.01, 0.25 * (vol / 100)) : 0.25;
          const normalized = Math.min(1, smoothed / rmsDivisor);
          const pct = Math.round(cal.minBrightness + normalized * (cal.maxBrightness - cal.minBrightness));

          // White kick detection
          const now = performance.now();
          const wasWhite = lastColorStateRef.current === 'white';
          const inWhiteKick = now < whiteKickUntilRef.current;
          if (pct >= cal.whiteKickThreshold && !inWhiteKick) {
            whiteKickUntilRef.current = now + cal.whiteKickMs;
          }
          const isWhite = now < whiteKickUntilRef.current;
          const smoothEnd = performance.now();

          // Step 3: BLE commands
          const c = charRef.current;
          if (c) {
            if (isWhite && !wasWhite) {
              sendColor(c, 255, 255, 255);
              lastColorStateRef.current = 'white';
            } else if (!isWhite && wasWhite) {
              const calibrated = applyColorCalibration(...colorRef.current, cal);
              sendColor(c, ...calibrated);
              lastColorStateRef.current = 'normal';
            }
            sendBrightness(c, isWhite ? 100 : pct);
          }
          const bleEnd = performance.now();

          // Report pipeline timings
          setPipelineTimings({
            rmsMs: rmsEnd - tickStart,
            smoothMs: smoothEnd - rmsEnd,
            bleCallMs: bleEnd - smoothEnd,
            totalTickMs: bleEnd - tickStart,
          });

          // Push sample for chart (rAF loop will draw)
          const [cr2, cg2, cb2] = isWhite ? [255, 255, 255] as const : colorRef.current;
          const scale = pct / 100;
          samplesRef.current.push({
            pct,
            r: Math.round(cr2 * scale),
            g: Math.round(cg2 * scale),
            b: Math.round(cb2 * scale),
          });
          if (samplesRef.current.length > HISTORY_LEN) {
            samplesRef.current = samplesRef.current.slice(-HISTORY_LEN);
          }
          chartDirtyRef.current = true;
        };

        worker.postMessage("start");
      } catch (e) {
        console.error("[MicPanel] mic init failed", e);
      }
    };

    init();

    return () => {
      stopped = true;
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
