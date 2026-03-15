import { useEffect, useRef } from "react";
import { sendToBLE, setActiveChar } from "@/lib/bledom";
import { setPipelineTimings } from "@/lib/pipelineTimings";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/drawChart";
import { pushChartSample } from "@/lib/chartStore";
import { getCalibration, saveCalibration, applyColorCalibration, getActiveDeviceName, getIdleColor, type LightCalibration } from "@/lib/lightCalibration";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  sonosVolume?: number;
  isPlaying?: boolean;
  historyLen?: number;
  tickMs?: number;
  onLiveStatus?: (status: { brightness: number; color: [number, number, number]; bassLevel: number; midHiLevel: number; bleSentColor?: [number, number, number]; bleSentBright?: number; bleColorSource?: 'normal' | 'idle'; micRms?: number; isPlayingState?: boolean }) => void;
}

const HISTORY_LEN = 120;

// Learned AGC
const AGC_MAX_DECAY = 0.995;
const AGC_MIN_RISE = 0.9999;
const AGC_ATTACK = 0.1;
const AGC_FLOOR = 0.002;
const PEAK_MAX_DECAY = 0.9998;

interface BandResult {
  bassRms: number; midHiRms: number;
  totalRms: number;
}

function computeBands(analyser: AnalyserNode, freqData: Float32Array<ArrayBuffer>): BandResult {
  analyser.getFloatFrequencyData(freqData);
  const sampleRate = analyser.context.sampleRate;
  const binWidth = sampleRate / analyser.fftSize;
  const loCut = Math.floor(150 / binWidth);
  const midCut = Math.floor(2000 / binWidth);
  const bins = freqData.length;

  let loSum = 0, midSum = 0, hiSum = 0;
  let loCount = 0, midCount = 0, hiCount = 0;
  let totalSum = 0;

  for (let i = 0; i < bins; i++) {
    const power = Math.pow(10, freqData[i] / 10);
    totalSum += power;
    if (i < loCut) { loSum += power; loCount++; }
    else if (i < midCut) { midSum += power; midCount++; }
    else { hiSum += power; hiCount++; }
  }

  const bassRms = loCount > 0 ? Math.sqrt(loSum / loCount) : 0;
  const midHiRms = Math.sqrt((midSum + hiSum) / Math.max(1, midCount + hiCount));
  const totalRms = bins > 0 ? Math.sqrt(totalSum / bins) : 0;

  return { bassRms, midHiRms, totalRms };
}

/** Update a single band's AGC max/min refs */
function updateBandAgc(
  value: number,
  maxRef: React.MutableRefObject<number>,
  minRef: React.MutableRefObject<number>,
  attack: number,
  decay: number
) {
  if (value > maxRef.current) {
    maxRef.current += (value - maxRef.current) * attack;
  } else {
    maxRef.current *= decay;
  }
  if (value < minRef.current || minRef.current === 0) {
    minRef.current = value;
  } else {
    minRef.current += (value - minRef.current) * 0.001;
  }
}


const MicPanel = ({ char, currentColor, sonosVolume, isPlaying = true, historyLen: historyLenProp, tickMs = 125, onLiveStatus }: MicPanelProps) => {
  const effectiveHistoryLen = historyLenProp ?? HISTORY_LEN;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const smoothedRef = useRef(0);
  const samplesRef = useRef<ChartSample[]>([]);
  const colorRef = useRef(currentColor);
  const charRef = useRef(char);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const volumeRef = useRef(sonosVolume);
  const calRef = useRef<LightCalibration>(getCalibration());
  const lastBaseColorRef = useRef<[number, number, number]>([0, 0, 0]);
  const chartDirtyRef = useRef(false);
  const rafIdRef = useRef(0);
  const initCal = calRef.current;
  const agcMaxRef = useRef(initCal.agcMax > 0 ? initCal.agcMax : 0.01);
  const agcMinRef = useRef(initCal.agcMin);
  const bassAgcMaxRef = useRef(0.01);
  const bassAgcMinRef = useRef(0);
  const midHiAgcMaxRef = useRef(0.01);
  const midHiAgcMinRef = useRef(0);
  const smoothedBassRef = useRef(0);
  const smoothedMidHiRef = useRef(0);
  const dynamicCenterRef = useRef(0.5);
  const lastVolumeRef = useRef(sonosVolume);
  const agcSaveTimerRef = useRef(0);
  const agcPeakMaxRef = useRef(initCal.agcMax > 0 ? initCal.agcMax : 0.01);
  const idleCleanupRef = useRef<(() => void) | null>(null);
  const hiShelfRef = useRef<BiquadFilterNode | null>(null);
  const onLiveStatusRef = useRef(onLiveStatus);
  const isPlayingRef = useRef(isPlaying);
  const bassRef = useRef(0);
  const midHiRef = useRef(0);
  const rawEnergyPctRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const rescaleAllAgc = (ratio: number) => {
    agcMaxRef.current = Math.max(AGC_FLOOR, agcMaxRef.current * ratio);
    agcMinRef.current = Math.max(0, agcMinRef.current * ratio);
    agcPeakMaxRef.current = Math.max(agcMaxRef.current, agcPeakMaxRef.current * ratio);
    bassAgcMaxRef.current = Math.max(AGC_FLOOR, bassAgcMaxRef.current * ratio);
    bassAgcMinRef.current = Math.max(0, bassAgcMinRef.current * ratio);
    midHiAgcMaxRef.current = Math.max(AGC_FLOOR, midHiAgcMaxRef.current * ratio);
    midHiAgcMinRef.current = Math.max(0, midHiAgcMinRef.current * ratio);
  };

  useEffect(() => { onLiveStatusRef.current = onLiveStatus; }, [onLiveStatus]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    if (isPlaying && workerRef.current) {
      workerRef.current.postMessage('start');
    }
  }, [isPlaying]);

  useEffect(() => {
    workerRef.current?.postMessage(tickMs);
  }, [tickMs]);

  useEffect(() => {
    colorRef.current = currentColor;
  }, [currentColor]);

  useEffect(() => { volumeRef.current = sonosVolume; }, [sonosVolume]);

  useEffect(() => {
    charRef.current = char;
    if (char) {
      setActiveChar(char);
    }
  }, [char]);

  useEffect(() => {
    const reload = () => {
      calRef.current = getCalibration();
      if (hiShelfRef.current) {
        hiShelfRef.current.gain.value = calRef.current.hiShelfGainDb;
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'light-calibration') reload();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('calibration-changed', reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('calibration-changed', reload);
    };
  }, []);

  // Chart rendering via rAF
  useEffect(() => {
    const drawLoop = () => {
      if (chartDirtyRef.current) {
        chartDirtyRef.current = false;
        const canvas = canvasRef.current;
        if (canvas) {
          drawIntensityChart(canvas, samplesRef.current, effectiveHistoryLen, 0, 0, false, 1);
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
        hiShelf.gain.value = calRef.current.hiShelfGainDb;
        hiShelfRef.current = hiShelf;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0;
        source.connect(hiShelf);
        hiShelf.connect(analyser);
        analyserRef.current = analyser;

        const worker = new Worker("/tick-worker.js");
        workerRef.current = worker;
        const freqBuf = new Float32Array(analyser.frequencyBinCount);

        let idleColor = getIdleColor();
        let idleSent = false;

        const onIdleColorChanged = () => { idleColor = getIdleColor(); idleSent = false; };
        window.addEventListener('idle-color-changed', onIdleColorChanged);
        idleCleanupRef.current = () => window.removeEventListener('idle-color-changed', onIdleColorChanged);

        worker.onmessage = () => {
          if (stopped) return;

          if (!isPlayingRef.current) {
            if (!idleSent && charRef.current) {
              const calibrated = applyColorCalibration(...idleColor);
              sendToBLE(calibrated[0], calibrated[1], calibrated[2], 100);
              idleSent = true;
              onLiveStatusRef.current?.({ brightness: 100, color: idleColor, bassLevel: 0, midHiLevel: 0, bleColorSource: 'idle', micRms: 0, isPlayingState: false });
            }
            worker.postMessage('stop');
            return;
          }
          idleSent = false;
          const an = analyserRef.current;
          if (!an) return;

          const tickStart = performance.now();
          const cal = calRef.current;

          // ── Frequency bands ──
          const micBands = computeBands(an, freqBuf);
          const rms = micBands.totalRms;
          const rmsEnd = performance.now();

          const prevAbsFactor = agcPeakMaxRef.current > 0
            ? Math.min(1, agcMaxRef.current / agcPeakMaxRef.current) : 1;
          const reactivity = 1 + (1 - prevAbsFactor) * 2;
          const prev = smoothedRef.current;
          const attackA = Math.min(1.0, cal.attackAlpha * reactivity);
          const releaseA = Math.min(0.5, cal.releaseAlpha * reactivity);
          const alpha = rms > prev ? attackA : releaseA;
          const smoothed = prev + alpha * (rms - prev);
          smoothedRef.current = smoothed;

          // Volume-proportional AGC rescaling
          const vol = volumeRef.current;
          const prevVol = lastVolumeRef.current;
          if (prevVol != null && vol != null && Math.abs(vol - prevVol) > 2) {
            const strength = cal.volCompensation / 100;
            const rawRatio = prevVol > 0 ? (vol / prevVol) : 1;
            const ratio = 1 + (rawRatio - 1) * strength;
            rescaleAllAgc(ratio);
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

          if (agcMaxRef.current > agcPeakMaxRef.current) {
            agcPeakMaxRef.current = agcMaxRef.current;
          } else {
            agcPeakMaxRef.current *= PEAK_MAX_DECAY;
          }

          const absoluteFactor = Math.min(1, Math.max(0.08, agcMaxRef.current / agcPeakMaxRef.current));
          const effectiveMax = 100 * absoluteFactor;

          bassRef.current = micBands.bassRms;
          midHiRef.current = micBands.midHiRms;

          // ── Per-band AGC ──
          updateBandAgc(micBands.bassRms, bassAgcMaxRef, bassAgcMinRef, cal.bandAgcAttack, cal.bandAgcDecay);
          updateBandAgc(micBands.midHiRms, midHiAgcMaxRef, midHiAgcMinRef, cal.bandAgcAttack, cal.bandAgcDecay);

          const bassRange = Math.max(AGC_FLOOR, bassAgcMaxRef.current - bassAgcMinRef.current);
          const rawBassNorm = Math.min(1, Math.max(0, (micBands.bassRms - bassAgcMinRef.current) / bassRange));

          const midHiRange = Math.max(AGC_FLOOR, midHiAgcMaxRef.current - midHiAgcMinRef.current);
          const rawMidHiNorm = Math.min(1, Math.max(0, (micBands.midHiRms - midHiAgcMinRef.current) / midHiRange));

          const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;
          const rawMapped = (rawEnergy * effectiveMax) / 100;
          rawEnergyPctRef.current = Math.round(rawMapped * 100);

          // Smoothing per band
          const prevBass = smoothedBassRef.current;
          const bassAlpha = rawBassNorm > prevBass ? attackA : releaseA;
          const bassNorm = prevBass + bassAlpha * (rawBassNorm - prevBass);
          smoothedBassRef.current = bassNorm;

          const prevMidHi = smoothedMidHiRef.current;
          const midHiAlpha = rawMidHiNorm > prevMidHi ? attackA : releaseA;
          const midHiNorm = prevMidHi + midHiAlpha * (rawMidHiNorm - prevMidHi);
          smoothedMidHiRef.current = midHiNorm;

          // ── Frequency-weighted brightness ──
          let energyNorm = bassNorm * cal.bassWeight + midHiNorm * (1 - cal.bassWeight);

          // Adaptive center for dynamics
          const center = dynamicCenterRef.current + (energyNorm - dynamicCenterRef.current) * 0.008;
          dynamicCenterRef.current = center;

          if (cal.dynamicDamping < 0) {
            const amount = Math.min(1, Math.abs(cal.dynamicDamping) / 2);
            const gain = 1 + amount * 10;
            const centered = energyNorm - center;
            const denom = Math.tanh(0.5 * gain) || 1;
            const expanded = center + 0.5 * (Math.tanh(centered * gain) / denom);
            energyNorm = energyNorm * (1 - amount) + expanded * amount;
          } else if (cal.dynamicDamping > 0) {
            const amount = Math.min(1, cal.dynamicDamping / 3);
            const compression = 1 / (1 + amount * 4);
            energyNorm = center + (energyNorm - center) * compression;
          }

          energyNorm = Math.max(0, Math.min(1, energyNorm));

          const rawPct = (energyNorm * effectiveMax) / 100;
          const pct = Math.round(rawPct * 100);
          const smoothEnd = performance.now();

          // ── BLE output ──
          const c = charRef.current;
          let bleSentR = 0, bleSentG = 0, bleSentB = 0, bleSentBr = pct;
          if (c) {
            const baseColor = colorRef.current;
            const finalColor = applyColorCalibration(...baseColor, cal);
            bleSentR = finalColor[0]; bleSentG = finalColor[1]; bleSentB = finalColor[2];
            lastBaseColorRef.current = [bleSentR, bleSentG, bleSentB];
            sendToBLE(...finalColor, pct);
          }
          const bleEnd = performance.now();

          // Chart sampling
          const base = lastBaseColorRef.current;
          const sample: ChartSample = {
            pct: bleSentBr,
            r: Math.max(bleSentR, 20),
            g: Math.max(bleSentG, 20),
            b: Math.max(bleSentB, 20),
            rawPct: rawEnergyPctRef.current,
            baseR: base[0],
            baseG: base[1],
            baseB: base[2],
          };
          samplesRef.current.push(sample);
          pushChartSample(sample);
          if (samplesRef.current.length > effectiveHistoryLen) {
            samplesRef.current = samplesRef.current.slice(-effectiveHistoryLen);
          }
          chartDirtyRef.current = true;

          onLiveStatusRef.current?.({
            brightness: bleSentBr,
            color: [bleSentR, bleSentG, bleSentB],
            bassLevel: bassRef.current,
            midHiLevel: midHiRef.current,
            bleSentColor: lastBaseColorRef.current,
            bleSentBright: bleSentBr,
            bleColorSource: 'normal',
            micRms: smoothedRef.current,
            isPlayingState: isPlayingRef.current,
          });

          setPipelineTimings({
            rmsMs: rmsEnd - tickStart,
            smoothMs: smoothEnd - rmsEnd,
            bleCallMs: bleEnd - smoothEnd,
            totalTickMs: bleEnd - tickStart,
          });
        };

        // AGC save on separate interval
        agcSaveTimerRef.current = window.setInterval(() => {
          if (stopped) return;
          const updated = { ...calRef.current, agcMin: agcMinRef.current, agcMax: agcMaxRef.current, agcVolume: volumeRef.current ?? null };
          calRef.current = updated;
          saveCalibration(updated, getActiveDeviceName() ?? undefined, { localOnly: true });
        }, 10_000);

        worker.postMessage("start");
      } catch (e) {
        console.error("[MicPanel] mic init failed", e);
      }
    };

    init();

    return () => {
      stopped = true;
      idleCleanupRef.current?.();
      if (agcSaveTimerRef.current) clearInterval(agcSaveTimerRef.current);
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
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth * devicePixelRatio;
      canvas.height = container.clientHeight * devicePixelRatio;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return (
    <div className="absolute inset-0" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ opacity: 0.9 }}
      />
    </div>
  );
};

export default MicPanel;
