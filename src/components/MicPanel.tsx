import { useEffect, useRef } from "react";
import { sendColorAndBrightness, setActiveChar, setPipelineTimings, onBleWrite, sendColor } from "@/lib/bledom";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/drawChart";
import { getCalibration, saveCalibration, applyColorCalibration, getActiveDeviceName, type LightCalibration } from "@/lib/lightCalibration";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  palette?: [number, number, number][];
  sonosVolume?: number;
  isPlaying?: boolean;
  bpm?: number | null;
  energy?: number | null;        // 0-100
  danceability?: number | null;  // 0-100
  happiness?: number | null;     // 0-100
  onLiveStatus?: (status: { brightness: number; color: [number, number, number]; isWhiteKick: boolean; isDrop: boolean }) => void;
}

const HISTORY_LEN = 120;

// Learned AGC
const AGC_MAX_DECAY = 0.995;
const AGC_MIN_RISE = 0.9999;
const AGC_ATTACK = 0.1;
const AGC_FLOOR = 0.002;
const PEAK_MAX_DECAY = 0.9998;

// FFT band boundaries
function computeBands(analyser: AnalyserNode, freqData: Float32Array<ArrayBuffer>): { lo: number; mid: number; hi: number } {
  analyser.getFloatFrequencyData(freqData);
  const sampleRate = analyser.context.sampleRate;
  const binWidth = sampleRate / analyser.fftSize;
  const loCut = Math.floor(300 / binWidth);
  const midCut = Math.floor(2000 / binWidth);
  const bins = freqData.length;

  let loSum = 0, midSum = 0, hiSum = 0;
  let loCount = 0, midCount = 0, hiCount = 0;

  for (let i = 0; i < bins; i++) {
    const power = Math.pow(10, freqData[i] / 10);
    if (i < loCut) { loSum += power; loCount++; }
    else if (i < midCut) { midSum += power; midCount++; }
    else { hiSum += power; hiCount++; }
  }

  const loAvg = loCount > 0 ? Math.sqrt(loSum / loCount) : 0;
  const midAvg = midCount > 0 ? Math.sqrt(midSum / midCount) : 0;
  const hiAvg = hiCount > 0 ? Math.sqrt(hiSum / hiCount) : 0;

  const maxBand = Math.max(loAvg, midAvg, hiAvg, 0.0001);
  return {
    lo: Math.min(1, loAvg / maxBand),
    mid: Math.min(1, midAvg / maxBand),
    hi: Math.min(1, hiAvg / maxBand),
  };
}

function modulateColor(
  baseR: number, baseG: number, baseB: number,
  lo: number, _mid: number, hi: number,
  strength: number = 0.3
): [number, number, number] {
  const whiteBlend = hi * strength * 0.5;
  let r = baseR + (255 - baseR) * whiteBlend;
  let g = baseG + (255 - baseG) * whiteBlend;
  let b = baseB + (255 - baseB) * whiteBlend;

  const warmBlend = lo * strength * 0.4;
  r = Math.min(255, r + (255 - r) * warmBlend);
  b = Math.max(0, b - b * warmBlend * 0.5);

  return [Math.round(r), Math.round(g), Math.round(b)];
}

const MicPanel = ({ char, currentColor, palette, sonosVolume, isPlaying = true, bpm, energy, danceability, happiness, onLiveStatus }: MicPanelProps) => {
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
  const chartDirtyRef = useRef(false);
  const rafIdRef = useRef(0);
  const initCal = calRef.current;
  const agcMaxRef = useRef(initCal.agcMax > 0 ? initCal.agcMax : 0.01);
  const agcMinRef = useRef(initCal.agcMin);
  const lastVolumeRef = useRef(sonosVolume);
  const agcSaveTimerRef = useRef(0);
  const agcPeakMaxRef = useRef(initCal.agcMax > 0 ? initCal.agcMax : 0.01);
  const onLiveStatusRef = useRef(onLiveStatus);
  const isPlayingRef = useRef(isPlaying);
  const bassRef = useRef(0);
  const brightPctRef = useRef(0);
  const sunRef = useRef<HTMLDivElement>(null);
  const bpmRef = useRef(bpm);
  const energyRef = useRef(energy);
  const danceabilityRef = useRef(danceability);
  const happinessRef = useRef(happiness);
  const beatPhaseRef = useRef(0);
  const lastBeatTimeRef = useRef(0);
  // Drop detection state
  const rmsHistoryRef = useRef<number[]>([]);
  const dropActiveUntilRef = useRef(0);
  const lastDropTimeRef = useRef(0);

  useEffect(() => { onLiveStatusRef.current = onLiveStatus; }, [onLiveStatus]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);

  useEffect(() => {
    colorRef.current = currentColor;
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

  // Decoupled chart rendering + sun pulse via rAF
  useEffect(() => {
    const drawLoop = () => {
      if (chartDirtyRef.current) {
        chartDirtyRef.current = false;
        const canvas = canvasRef.current;
        if (canvas) {
          drawIntensityChart(canvas, samplesRef.current, HISTORY_LEN, 0, 0, false, 1);
        }
      }
      // Animate sun
      const sun = sunRef.current;
      if (sun) {
        const b = brightPctRef.current / 100;
        const [cr, cg, cb] = colorRef.current;
        const ringSpread = 4 + b * 80;
        const outerGlow = 50 + b * 700;
        const farGlow = 100 + b * 900;
        const ringAlpha = 0.08 + b * 0.8;
        const outerAlpha = 0.05 + b * 0.55;
        const farAlpha = 0.02 + b * 0.3;
        const bgCore = 0.08 + b * 0.35;
        const bgMid = 0.02 + b * 0.15;

        sun.style.transform = 'scale(1)';
        sun.style.boxShadow = [
          `0 0 ${ringSpread}px ${ringSpread}px rgba(${cr},${cg},${cb},${ringAlpha})`,
          `0 0 ${outerGlow}px rgba(${cr},${cg},${cb},${outerAlpha})`,
          `0 0 ${farGlow}px rgba(${cr},${cg},${cb},${farAlpha})`,
        ].join(', ');
        sun.style.background = `radial-gradient(circle, rgba(${cr},${cg},${cb},${bgCore}) 0%, rgba(${cr},${cg},${cb},${bgMid}) 55%, transparent 78%)`;
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
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
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
        const freqBuf = new Float32Array(analyser.frequencyBinCount);

        worker.onmessage = () => {
          if (stopped) return;
          if (!isPlayingRef.current) return;
          const an = analyserRef.current;
          if (!an) return;

          const tickStart = performance.now();
          const cal = calRef.current;

          // ── Live mic mode: read mic + full AGC pipeline ──
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          const rmsEnd = performance.now();

          const prevAbsFactor = agcPeakMaxRef.current > 0
            ? Math.min(1, agcMaxRef.current / agcPeakMaxRef.current) : 1;
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
          let normalized = Math.min(1, Math.max(0, (smoothed - agcMinRef.current) / range));

          if (cal.dynamicDamping !== 1.0) {
            normalized = Math.pow(normalized, cal.dynamicDamping);
          }

          if (agcMaxRef.current > agcPeakMaxRef.current) {
            agcPeakMaxRef.current = agcMaxRef.current;
          } else {
            agcPeakMaxRef.current *= PEAK_MAX_DECAY;
          }

          const absoluteFactor = Math.min(1, Math.max(0.08, agcMaxRef.current / agcPeakMaxRef.current));
          const effectiveMax = cal.minBrightness + (cal.maxBrightness - cal.minBrightness) * absoluteFactor;
          const pct = Math.round(cal.minBrightness + normalized * (effectiveMax - cal.minBrightness));

          // Frequency bands for color modulation
          const micBands = computeBands(an, freqBuf);
          bassRef.current = micBands.lo;

          // ── Drop detection ──
          // Track RMS history (last ~1.5s at ~60fps ≈ 90 samples)
          const DROP_HISTORY_LEN = 90;
          const DROP_COOLDOWN_MS = 3000;
          const DROP_QUIET_THRESHOLD = 0.25; // normalized quiet zone
          const DROP_SURGE_MULTIPLIER = 3.0; // how much louder than recent avg
          const DROP_DURATION_MS = 400; // how long to hold the drop effect

          const rmsHist = rmsHistoryRef.current;
          rmsHist.push(normalized);
          if (rmsHist.length > DROP_HISTORY_LEN) rmsHist.shift();

          const now = performance.now();
          let isDrop = now < dropActiveUntilRef.current;

          // Only check for drops if we have enough history and not in cooldown
          if (rmsHist.length >= 30 && now - lastDropTimeRef.current > DROP_COOLDOWN_MS) {
            // Look at the recent past: was it quiet?
            const recentWindow = rmsHist.slice(-10); // last ~160ms
            const pastWindow = rmsHist.slice(-40, -10); // ~160ms-660ms ago
            const recentAvg = recentWindow.reduce((a, b) => a + b, 0) / recentWindow.length;
            const pastAvg = pastWindow.reduce((a, b) => a + b, 0) / pastWindow.length;

            // Drop = quiet period followed by sudden surge
            if (pastAvg < DROP_QUIET_THRESHOLD && recentAvg > pastAvg * DROP_SURGE_MULTIPLIER && recentAvg > 0.5) {
              dropActiveUntilRef.current = now + DROP_DURATION_MS;
              lastDropTimeRef.current = now;
              isDrop = true;
              console.log('[Drop]', { pastAvg: pastAvg.toFixed(3), recentAvg: recentAvg.toFixed(3) });
            }
          }

          // White kick logic — beat-synced when BPM available
          const currentBpm = bpmRef.current;
          let isWhite = false;

          // Drop overrides normal white kick — force white for longer
          if (isDrop) {
            isWhite = true;
          } else if (currentBpm && currentBpm > 0) {
            // Beat-synced kicks: fire white kick when volume peak aligns with beat phase
            const beatIntervalMs = 60000 / currentBpm;
            const timeSinceLastBeat = now - lastBeatTimeRef.current;

            if (timeSinceLastBeat >= beatIntervalMs * 0.9) {
              if (pct > cal.whiteKickThreshold * 0.7) {
                lastBeatTimeRef.current = now;
                whiteKickUntilRef.current = now + Math.min(cal.whiteKickMs, beatIntervalMs * 0.15);
              }
            }
            isWhite = now < whiteKickUntilRef.current;
          } else {
            // Fallback: original volume-only white kick
            const inWhiteKick = now < whiteKickUntilRef.current;
            if (pct > cal.whiteKickThreshold && !inWhiteKick) {
              whiteKickUntilRef.current = now + cal.whiteKickMs;
            }
            isWhite = now < whiteKickUntilRef.current;
          }
          const smoothEnd = performance.now();

          // BLE commands
          const c = charRef.current;
          if (c) {
            if (isWhite) {
              sendColorAndBrightness(c, 255, 255, 255, 100);
              lastColorStateRef.current = 'white';
            } else {
              const calibrated = applyColorCalibration(...colorRef.current, cal);
              const finalColor = modulateColor(...calibrated, micBands.lo, micBands.mid, micBands.hi, 0.3);
              sendColorAndBrightness(c, ...finalColor, pct);
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
            saveCalibration(updated, getActiveDeviceName() ?? undefined, { localOnly: true });
          }
        };

        onBleWrite((bright, r, g, b) => {
          if (stopped) return;
          samplesRef.current.push({
            pct: bright,
            r: Math.max(r, 20),
            g: Math.max(g, 20),
            b: Math.max(b, 20),
          });
          if (samplesRef.current.length > HISTORY_LEN) {
            samplesRef.current = samplesRef.current.slice(-HISTORY_LEN);
          }
          chartDirtyRef.current = true;
          brightPctRef.current = bright;

          onLiveStatusRef.current?.({
            brightness: bright,
            color: [r, g, b],
            isWhiteKick: performance.now() < whiteKickUntilRef.current,
            isDrop: performance.now() < dropActiveUntilRef.current,
          });
        });

        worker.postMessage("start");
      } catch (e) {
        console.error("[MicPanel] mic init failed", e);
      }
    };

    init();

    return () => {
      stopped = true;
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
      const sun = sunRef.current;
      if (!canvas || !sun) return;
      const size = sun.clientWidth;
      canvas.width = size * devicePixelRatio;
      canvas.height = size * devicePixelRatio;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const [r, g, b] = currentColor;

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div
        ref={sunRef}
        className="rounded-full relative"
        style={{
          width: '55vw',
          height: '55vw',
          maxWidth: '55vh',
          maxHeight: '55vh',
          transform: 'scale(1)',
          willChange: 'transform, box-shadow, background',
          background: `radial-gradient(circle, rgba(${r},${g},${b},0.25) 0%, rgba(${r},${g},${b},0.08) 50%, transparent 72%)`,
          boxShadow: `0 0 40px rgba(${r},${g},${b},0.15), 0 0 8px 8px rgba(${r},${g},${b},0.4), 0 0 80px rgba(${r},${g},${b},0.12)`,
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full rounded-full"
          style={{ opacity: 0.6, clipPath: 'circle(50%)' }}
        />
      </div>
    </div>
  );
};

export default MicPanel;
