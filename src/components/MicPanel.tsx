import { useEffect, useRef } from "react";
import { sendColor, sendBrightness } from "@/lib/bledom";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/drawChart";
import { getCalibration, applyColorCalibration } from "@/lib/lightCalibration";

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

  useEffect(() => { colorRef.current = currentColor; }, [currentColor]);
  useEffect(() => {
    charRef.current = char;
    if (char) {
      const [r, g, b] = colorRef.current;
      sendColor(char, r, g, b).catch(() => {});
    }
  }, [char]);

  useEffect(() => {
    let stopped = false;

    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;

        const audioCtx = new AudioContext();
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

          const cal = getCalibration();

          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);

          const prev = smoothedRef.current;
          const alpha = rms > prev ? cal.attackAlpha : cal.releaseAlpha;
          const smoothed = prev + alpha * (rms - prev);
          smoothedRef.current = smoothed;

          const normalized = Math.min(1, smoothed / 0.25);
          const pct = Math.round(cal.minBrightness + normalized * (cal.maxBrightness - cal.minBrightness));

          // White kick
          const now = performance.now();
          const inWhiteKick = now < whiteKickUntilRef.current;
          if (pct >= cal.whiteKickThreshold && !inWhiteKick) {
            whiteKickUntilRef.current = now + cal.whiteKickMs;
          }
          const isWhite = now < whiteKickUntilRef.current;

          const c = charRef.current;
          if (c) {
            if (isWhite) {
              sendColor(c, 255, 255, 255).then(() => sendBrightness(c, 100)).catch(() => {});
            } else {
              const calibrated = applyColorCalibration(...colorRef.current, cal);
              sendColor(c, ...calibrated).then(() => sendBrightness(c, pct)).catch(() => {});
            }
          }

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
          const canvas = canvasRef.current;
          if (canvas) {
            drawIntensityChart(canvas, samplesRef.current, HISTORY_LEN, 0, 0, false, 1);
          }
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
