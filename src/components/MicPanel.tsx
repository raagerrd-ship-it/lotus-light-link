import { useEffect, useRef } from "react";
import { sendToBLE, setActiveChar } from "@/lib/bledom";
import { setPipelineTimings } from "@/lib/pipelineTimings";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/drawChart";
import { pushChartSample } from "@/lib/chartStore";
import { getCalibration, saveCalibration, applyColorCalibration, getActiveDeviceName, getIdleColor, type LightCalibration } from "@/lib/lightCalibration";
import { computeBands } from "@/lib/audioAnalysis";
import { createAgcState, rescaleAgc, updateGlobalAgc, updateBandAgc, getEffectiveMax, normalizeBand, type AgcState } from "@/lib/agc";
import { smooth, computeBrightnessPct } from "@/lib/brightnessEngine";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  sonosVolume?: number;
  isPlaying?: boolean;
  trackName?: string | null;
  historyLen?: number;
  tickMs?: number;
  onLiveStatus?: (status: { brightness: number; color: [number, number, number]; bassLevel: number; midHiLevel: number; bleSentColor?: [number, number, number]; bleSentBright?: number; bleColorSource?: 'normal' | 'idle'; micRms?: number; isPlayingState?: boolean }) => void;
}

const HISTORY_LEN = 120;

const AGC_LEARN_DURATION_MS = 20_000;

const MicPanel = ({ char, currentColor, sonosVolume, isPlaying = true, trackName, historyLen: historyLenProp, tickMs = 125, onLiveStatus }: MicPanelProps) => {
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
  
  const rafIdRef = useRef(0);
  const lastSampleTimeRef = useRef(0);

  const initCal = calRef.current;
  const agcRef = useRef<AgcState>(createAgcState(initCal.agcMax, initCal.agcMin));
  const smoothedBassRef = useRef(0);
  const smoothedMidHiRef = useRef(0);
  const dynamicCenterRef = useRef(0.5);
  const lastVolumeRef = useRef(sonosVolume);
  const agcSaveTimerRef = useRef(0);
  const idleCleanupRef = useRef<(() => void) | null>(null);
  const hiShelfRef = useRef<BiquadFilterNode | null>(null);
  const onLiveStatusRef = useRef(onLiveStatus);
  const isPlayingRef = useRef(isPlaying);
  const containerRef = useRef<HTMLDivElement>(null);

  // AGC learn-then-lock state
  const agcLockedRef = useRef(false);
  const trackStartTimeRef = useRef(0);
  const lastTrackNameRef = useRef<string | null>(null);

  // ── Prop sync effects ──
  useEffect(() => { onLiveStatusRef.current = onLiveStatus; }, [onLiveStatus]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    if (isPlaying && workerRef.current) workerRef.current.postMessage('start');
  }, [isPlaying]);
  useEffect(() => { workerRef.current?.postMessage(tickMs); }, [tickMs]);
  useEffect(() => { colorRef.current = currentColor; }, [currentColor]);
  useEffect(() => { volumeRef.current = sonosVolume; }, [sonosVolume]);
  useEffect(() => {
    charRef.current = char;
    if (char) setActiveChar(char);
  }, [char]);

  // ── Track change → reset AGC scaled to current volume, then learn 20s ──
  useEffect(() => {
    if (!trackName || trackName === lastTrackNameRef.current) return;
    lastTrackNameRef.current = trackName;

    const cal = calRef.current;
    const currentVol = volumeRef.current;
    const savedVol = cal.agcVolume;
    const savedMax = cal.agcMax > 0 ? cal.agcMax : 0.01;
    const savedMin = cal.agcMin;

    // Scale saved AGC baseline by volume ratio so we start proportionally
    let startMax = savedMax;
    let startMin = savedMin;
    if (currentVol != null && currentVol > 0 && savedVol != null && savedVol > 0) {
      const ratio = currentVol / savedVol;
      startMax = Math.max(0.01, savedMax * ratio);
      startMin = Math.max(0, savedMin * ratio);
    }

    agcRef.current = createAgcState(startMax, startMin);
    smoothedBassRef.current = 0;
    smoothedMidHiRef.current = 0;
    dynamicCenterRef.current = 0.5;
    agcLockedRef.current = false;
    trackStartTimeRef.current = performance.now();
    lastVolumeRef.current = currentVol;
    console.log('[AGC] Track change → vol-scaled start (max=', startMax.toFixed(5), 'vol=', currentVol, '):', trackName);
  }, [trackName]);

  // ── Calibration reload ──
  useEffect(() => {
    const reload = () => {
      calRef.current = getCalibration();
      if (hiShelfRef.current) hiShelfRef.current.gain.value = calRef.current.hiShelfGainDb;
    };
    const onStorage = (e: StorageEvent) => { if (e.key === 'light-calibration') reload(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('calibration-changed', reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('calibration-changed', reload);
    };
  }, []);

  // ── Chart rendering via rAF — smooth scrolling between ticks ──
  useEffect(() => {
    const drawLoop = (now: number) => {
      const canvas = canvasRef.current;
      if (canvas) {
        const elapsed = now - lastSampleTimeRef.current;
        const scrollFraction = Math.min(1, elapsed / tickMs);
        drawIntensityChart(canvas, samplesRef.current, effectiveHistoryLen, scrollFraction);
      }
      rafIdRef.current = requestAnimationFrame(drawLoop);
    };
    rafIdRef.current = requestAnimationFrame(drawLoop);
    return () => cancelAnimationFrame(rafIdRef.current);
  }, [tickMs]);

  // ── Main audio pipeline ──
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

          // ── Idle mode ──
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
          const agc = agcRef.current;

          // ── FFT ──
          const bands = computeBands(an, freqBuf);
          const rmsEnd = performance.now();

          // ── Smoothing with reactivity scaling ──
          const prevAbsFactor = agc.peakMax > 0 ? Math.min(1, agc.max / agc.peakMax) : 1;
          const reactivity = 1 + (1 - prevAbsFactor) * 2;
          const attackA = Math.min(1.0, cal.attackAlpha * reactivity);
          const releaseA = Math.min(0.5, cal.releaseAlpha * reactivity);
          smoothedRef.current = smooth(smoothedRef.current, bands.totalRms, attackA, releaseA);

          // ── Volume-proportional AGC rescaling ──
          const vol = volumeRef.current;
          const prevVol = lastVolumeRef.current;
          if (prevVol != null && vol != null && Math.abs(vol - prevVol) > 2) {
            const strength = cal.volCompensation / 100;
            const rawRatio = prevVol > 0 ? (vol / prevVol) : 1;
            rescaleAgc(agc, 1 + (rawRatio - 1) * strength);
            lastVolumeRef.current = vol;
          } else if (prevVol == null && vol != null) {
            lastVolumeRef.current = vol;
          }

          // ── Check if learning window has elapsed → lock AGC ──
          if (!agcLockedRef.current && trackStartTimeRef.current > 0 && (performance.now() - trackStartTimeRef.current) > AGC_LEARN_DURATION_MS) {
            agcLockedRef.current = true;
            console.log('[AGC] Locked after 20s learning. max=', agc.max.toFixed(5), 'bassMax=', agc.bassMax.toFixed(5));
          }

          // ── Global + per-band AGC (skip if locked) ──
          if (!agcLockedRef.current) {
            updateGlobalAgc(agc, smoothedRef.current);
            updateBandAgc(bands.bassRms, agc, 'bass', cal.bandAgcAttack, cal.bandAgcDecay);
            updateBandAgc(bands.midHiRms, agc, 'midHi', cal.bandAgcAttack, cal.bandAgcDecay);
          }

          const rawBassNorm = normalizeBand(bands.bassRms, agc, 'bass');
          const rawMidHiNorm = normalizeBand(bands.midHiRms, agc, 'midHi');
          const effectiveMax = getEffectiveMax(agc);

          const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;
          const rawEnergyPct = Math.round(((rawEnergy * effectiveMax) / 100) * 100);

          // ── Per-band smoothing ──
          smoothedBassRef.current = smooth(smoothedBassRef.current, rawBassNorm, attackA, releaseA);
          smoothedMidHiRef.current = smooth(smoothedMidHiRef.current, rawMidHiNorm, attackA, releaseA);

          // ── Brightness ──
          const { pct, newCenter } = computeBrightnessPct(
            smoothedBassRef.current, smoothedMidHiRef.current,
            effectiveMax, dynamicCenterRef.current, cal,
          );
          dynamicCenterRef.current = newCenter;
          const smoothEnd = performance.now();

          // ── BLE output ──
          const c = charRef.current;
          const isPunch = cal.punchWhiteThreshold > 0 && pct >= cal.punchWhiteThreshold;
          let bleSentR = 0, bleSentG = 0, bleSentB = 0;
          const bleSentBr = pct;
          if (c) {
            if (isPunch) {
              bleSentR = 255; bleSentG = 255; bleSentB = 255;
              lastBaseColorRef.current = [255, 255, 255];
              sendToBLE(255, 255, 255, pct);
            } else {
              const finalColor = applyColorCalibration(...colorRef.current, cal);
              bleSentR = finalColor[0]; bleSentG = finalColor[1]; bleSentB = finalColor[2];
              lastBaseColorRef.current = [bleSentR, bleSentG, bleSentB];
              sendToBLE(...finalColor, pct);
            }
          }
          const bleEnd = performance.now();

          // ── Chart ──
          const base = lastBaseColorRef.current;
          const sample: ChartSample = {
            pct: bleSentBr,
            r: Math.max(bleSentR, 20), g: Math.max(bleSentG, 20), b: Math.max(bleSentB, 20),
            rawPct: rawEnergyPct,
            baseR: base[0], baseG: base[1], baseB: base[2],
          };
          samplesRef.current.push(sample);
          lastSampleTimeRef.current = performance.now();
          pushChartSample(sample);
          if (samplesRef.current.length > effectiveHistoryLen) {
            samplesRef.current = samplesRef.current.slice(-effectiveHistoryLen);
          }
          

          // ── Status callback ──
          onLiveStatusRef.current?.({
            brightness: bleSentBr,
            color: [bleSentR, bleSentG, bleSentB],
            bassLevel: bands.bassRms,
            midHiLevel: bands.midHiRms,
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
          const agc = agcRef.current;
          const updated = { ...calRef.current, agcMin: agc.min, agcMax: agc.max, agcVolume: volumeRef.current ?? null };
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

  // ── Canvas resize ──
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
