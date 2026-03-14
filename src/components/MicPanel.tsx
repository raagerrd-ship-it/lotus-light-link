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
  loudness?: string | null;      // e.g. "-5 dB"
  historyLen?: number;           // override chart history length (default 120)
  onLiveStatus?: (status: { brightness: number; color: [number, number, number]; isWhiteKick: boolean; isDrop: boolean; bassLevel: number; midHiLevel: number }) => void;
  onColorChange?: (color: [number, number, number]) => void;
}

/** Parse loudness string like "-5 dB" to a number. Returns null if unparseable. */
function parseLoudnessDb(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/**
 * Convert loudness (LUFS/dB, typically -3 to -20) to an AGC scaling factor.
 * Loud masters (-3 to -6 dB) → factor ~1.3-1.5 (expect higher RMS)
 * Normal (-8 to -10 dB) → factor ~1.0
 * Quiet (-14 to -20 dB) → factor ~0.5-0.7 (expect lower RMS)
 */
function loudnessToAgcFactor(db: number): number {
  // Reference point: -9 dB is "normal" → factor 1.0
  // Each dB above -9 adds ~6% to expected RMS
  // Each dB below -9 reduces ~6%
  const refDb = -9;
  const diff = db - refDb; // positive = louder than ref
  return Math.max(0.4, Math.min(2.0, 1.0 + diff * 0.06));
}

const HISTORY_LEN = 120;

// Learned AGC
const AGC_MAX_DECAY = 0.995;
const AGC_MIN_RISE = 0.9999;
const AGC_ATTACK = 0.1;
const AGC_FLOOR = 0.002;
const PEAK_MAX_DECAY = 0.9998;

// FFT band boundaries — returns both normalized (for color) and raw RMS (for brightness/drop)
interface BandResult {
  lo: number; mid: number; hi: number;       // normalized 0-1 (relative)
  bassRms: number; midHiRms: number;          // raw RMS values for AGC
  totalRms: number;                           // total RMS from freq domain
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

  const loAvg = loCount > 0 ? Math.sqrt(loSum / loCount) : 0;
  const midAvg = midCount > 0 ? Math.sqrt(midSum / midCount) : 0;
  const hiAvg = hiCount > 0 ? Math.sqrt(hiSum / hiCount) : 0;
  const totalRms = bins > 0 ? Math.sqrt(totalSum / bins) : 0;

  const bassRms = loAvg;
  const midHiRms = Math.sqrt((midSum + hiSum) / Math.max(1, midCount + hiCount));

  const maxBand = Math.max(loAvg, midAvg, hiAvg, 0.0001);
  return {
    lo: Math.min(1, loAvg / maxBand),
    mid: Math.min(1, midAvg / maxBand),
    hi: Math.min(1, hiAvg / maxBand),
    bassRms,
    midHiRms,
    totalRms,
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

const ROTATION_INTERVAL_MS = 20_000; // rotate palette every 20s
const CROSSFADE_ALPHA = 0.008;      // per-frame lerp → ~3-5s fade at 60fps

const MicPanel = ({ char, currentColor, palette, sonosVolume, isPlaying = true, bpm, energy, danceability, happiness, loudness, historyLen: historyLenProp, onLiveStatus, onColorChange }: MicPanelProps) => {
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
  // whiteKickUntilRef removed — drops handle white kicks now
  const volumeRef = useRef(sonosVolume);
  const calRef = useRef<LightCalibration>(getCalibration());
  const lastColorStateRef = useRef<'normal' | 'white'>('normal');
  const chartDirtyRef = useRef(false);
  const rafIdRef = useRef(0);
  const initCal = calRef.current;
  const agcMaxRef = useRef(initCal.agcMax > 0 ? initCal.agcMax : 0.01);
  const agcMinRef = useRef(initCal.agcMin);
  // Per-band AGC for frequency-based brightness
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
  const onLiveStatusRef = useRef(onLiveStatus);
  const isPlayingRef = useRef(isPlaying);
  const bassRef = useRef(0);
  const midHiRef = useRef(0);
  const brightPctRef = useRef(0);
  const sunRef = useRef<HTMLDivElement>(null);
  const bpmRef = useRef(bpm);
  const energyRef = useRef(energy);
  const danceabilityRef = useRef(danceability);
  const happinessRef = useRef(happiness);
  const loudnessDbRef = useRef(parseLoudnessDb(loudness));
  // beatPhaseRef and lastBeatTimeRef removed — unused dead code
  // Drop detection state — now tracks bassRms only
  const bassHistoryRef = useRef<number[]>([]);
  const dropActiveUntilRef = useRef(0);
  const lastDropTimeRef = useRef(0);

  // Palette rotation + crossfade
  const paletteRef = useRef(palette ?? []);
  const paletteIndexRef = useRef(0);
  const targetColorRef = useRef<[number, number, number]>(currentColor);
  const blendedColorRef = useRef<[number, number, number]>(currentColor);
  const onColorChangeRef = useRef(onColorChange);
  const rotationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { onLiveStatusRef.current = onLiveStatus; }, [onLiveStatus]);
  useEffect(() => { onColorChangeRef.current = onColorChange; }, [onColorChange]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { energyRef.current = energy; }, [energy]);
  useEffect(() => { danceabilityRef.current = danceability; }, [danceability]);
  useEffect(() => { happinessRef.current = happiness; }, [happiness]);
  useEffect(() => { loudnessDbRef.current = parseLoudnessDb(loudness); }, [loudness]);

  // When currentColor changes externally, update colorRef but DON'T snap blended
  // (blended is driven by crossfade; snapping happens only on palette change)
  useEffect(() => {
    colorRef.current = currentColor;
  }, [currentColor]);

  // Sync palette ref and snap rotation when palette changes (new album art)
  useEffect(() => {
    paletteRef.current = palette ?? [];
    paletteIndexRef.current = 0;
    if (palette && palette.length > 0) {
      targetColorRef.current = palette[0];
      blendedColorRef.current = palette[0];
      colorRef.current = palette[0];
    }
    // Reset AGC on new palette
    lastColorStateRef.current = 'normal';
    agcMaxRef.current = Math.max(agcMaxRef.current * 0.5, 0.01);
    agcMinRef.current = 0;
    samplesRef.current = [];
    resetChartScaler();
  }, [palette]);

  // Rotation timer: advance palette index every ROTATION_INTERVAL_MS
  useEffect(() => {
    if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
    rotationTimerRef.current = setInterval(() => {
      const p = paletteRef.current;
      if (p.length <= 1) return;
      const nextIdx = (paletteIndexRef.current + 1) % p.length;
      paletteIndexRef.current = nextIdx;
      targetColorRef.current = p[nextIdx];
    }, ROTATION_INTERVAL_MS);
    return () => {
      if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
    };
  }, []);

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
    const reload = () => {
      calRef.current = getCalibration();
      console.log('[MicPanel] cal updated:', { attack: calRef.current.attackAlpha.toFixed(3), release: calRef.current.releaseAlpha.toFixed(4), damping: calRef.current.dynamicDamping.toFixed(1) });
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

  // Decoupled chart rendering + sun pulse via rAF
  useEffect(() => {
    const drawLoop = () => {
      if (chartDirtyRef.current) {
        chartDirtyRef.current = false;
        const canvas = canvasRef.current;
        if (canvas) {
          drawIntensityChart(canvas, samplesRef.current, effectiveHistoryLen, 0, 0, false, 1);
        }
      }
      // Crossfade blendedColor toward targetColor
      const [br, bg, bb] = blendedColorRef.current;
      const [tr, tg, tb] = targetColorRef.current;
      const a = CROSSFADE_ALPHA;
      const nr = br + (tr - br) * a;
      const ng = bg + (tg - bg) * a;
      const nb = bb + (tb - bb) * a;
      blendedColorRef.current = [nr, ng, nb];
      colorRef.current = [Math.round(nr), Math.round(ng), Math.round(nb)];
      // Notify parent of color change (throttled: only when integer values change)
      const rounded: [number, number, number] = [Math.round(nr), Math.round(ng), Math.round(nb)];
      if (rounded[0] !== Math.round(br) || rounded[1] !== Math.round(bg) || rounded[2] !== Math.round(bb)) {
        onColorChangeRef.current?.(rounded);
      }

      // Animate sun
      const sun = sunRef.current;
      if (sun) {
        const b = brightPctRef.current / 100;
        const [cr, cg, cb] = rounded;
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
        const freqBuf = new Float32Array(analyser.frequencyBinCount);

        worker.onmessage = () => {
          if (stopped) return;
          if (!isPlayingRef.current) return;
          const an = analyserRef.current;
          if (!an) return;

          const tickStart = performance.now();
          const cal = calRef.current;

          // ── Frequency bands (also computes RMS from freq domain) ──
          const micBands = computeBands(an, freqBuf);
          const rms = micBands.totalRms;
          const rmsEnd = performance.now();

          const prevAbsFactor = agcPeakMaxRef.current > 0
            ? Math.min(1, agcMaxRef.current / agcPeakMaxRef.current) : 1;
          const reactivity = 1 + (1 - prevAbsFactor) * 2;
          const prev = smoothedRef.current;
          const attackA = Math.min(1.0, cal.attackAlpha * reactivity);
          // Scale release by BPM: reference 160 BPM = full speed, lower = longer fade
          // But respect user's setting — don't scale below their chosen value
          const currentBpm = bpmRef.current;
          const bpmReleaseFactor = currentBpm && currentBpm > 0
            ? Math.max(0.5, Math.min(1.0, currentBpm / 160))
            : 0.8;
          const releaseA = Math.min(0.5, cal.releaseAlpha * reactivity * bpmReleaseFactor);
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

          // dynamicDamping now applied to final brightness below, not here
          // normalized is used only for AGC tracking
          // Loudness-aware AGC: scale peakMax expectation based on master loudness
          const loudDb = loudnessDbRef.current;
          const loudFactor = loudDb != null ? loudnessToAgcFactor(loudDb) : 1.0;

          if (agcMaxRef.current > agcPeakMaxRef.current) {
            agcPeakMaxRef.current = agcMaxRef.current;
          } else {
            agcPeakMaxRef.current *= PEAK_MAX_DECAY;
          }

          const absoluteFactor = Math.min(1, Math.max(0.08, (agcMaxRef.current * loudFactor) / agcPeakMaxRef.current));
          const effectiveMax = cal.minBrightness + (cal.maxBrightness - cal.minBrightness) * absoluteFactor;

          // micBands already computed above
          bassRef.current = micBands.lo;
          midHiRef.current = micBands.midHiRms;

          // ── Per-band AGC for frequency-based brightness ──
          const BAND_AGC_ATTACK = 0.15;
          const BAND_AGC_DECAY = 0.997;

          // Bass AGC
          if (micBands.bassRms > bassAgcMaxRef.current) {
            bassAgcMaxRef.current += (micBands.bassRms - bassAgcMaxRef.current) * BAND_AGC_ATTACK;
          } else {
            bassAgcMaxRef.current *= BAND_AGC_DECAY;
          }
          if (micBands.bassRms < bassAgcMinRef.current || bassAgcMinRef.current === 0) {
            bassAgcMinRef.current = micBands.bassRms;
          } else {
            bassAgcMinRef.current += (micBands.bassRms - bassAgcMinRef.current) * 0.001;
          }

          // MidHi AGC
          if (micBands.midHiRms > midHiAgcMaxRef.current) {
            midHiAgcMaxRef.current += (micBands.midHiRms - midHiAgcMaxRef.current) * BAND_AGC_ATTACK;
          } else {
            midHiAgcMaxRef.current *= BAND_AGC_DECAY;
          }
          if (micBands.midHiRms < midHiAgcMinRef.current || midHiAgcMinRef.current === 0) {
            midHiAgcMinRef.current = micBands.midHiRms;
          } else {
            midHiAgcMinRef.current += (micBands.midHiRms - midHiAgcMinRef.current) * 0.001;
          }

          // Normalize each band 0-1
          const bassRange = Math.max(AGC_FLOOR, bassAgcMaxRef.current - bassAgcMinRef.current);
          const rawBassNorm = Math.min(1, Math.max(0, (micBands.bassRms - bassAgcMinRef.current) / bassRange));

          const midHiRange = Math.max(AGC_FLOOR, midHiAgcMaxRef.current - midHiAgcMinRef.current);
          const rawMidHiNorm = Math.min(1, Math.max(0, (micBands.midHiRms - midHiAgcMinRef.current) / midHiRange));

          // Apply user's attack/release smoothing to band values
          const prevBass = smoothedBassRef.current;
          const bassAlpha = rawBassNorm > prevBass ? attackA : releaseA;
          const bassNorm = prevBass + bassAlpha * (rawBassNorm - prevBass);
          smoothedBassRef.current = bassNorm;

          const prevMidHi = smoothedMidHiRef.current;
          const midHiAlpha = rawMidHiNorm > prevMidHi ? attackA : releaseA;
          const midHiNorm = prevMidHi + midHiAlpha * (rawMidHiNorm - prevMidHi);
          smoothedMidHiRef.current = midHiNorm;

          // ── Frequency-based brightness ──
          // Blend bass (weight 0.7) and mid/hi (weight 0.3) for overall energy
          let energyNorm = bassNorm * 0.7 + midHiNorm * 0.3;

          // Adaptive center so dynamics still work even if laptop mic compression narrows range
          const center = dynamicCenterRef.current + (energyNorm - dynamicCenterRef.current) * 0.008;
          dynamicCenterRef.current = center;

          // Dynamic control around adaptive center:
          //   <0 = expand contrast (more punch)
          //    0 = neutral
          //   >0 = compress contrast (smoother)
          if (cal.dynamicDamping < 0) {
            const amount = Math.min(1, Math.abs(cal.dynamicDamping) / 2); // -2 => full strength
            const gain = 1 + amount * 10; // max 11x slope around center
            const centered = energyNorm - center;
            const denom = Math.tanh(0.5 * gain) || 1;
            const expanded = center + 0.5 * (Math.tanh(centered * gain) / denom);
            energyNorm = energyNorm * (1 - amount) + expanded * amount;
          } else if (cal.dynamicDamping > 0) {
            const amount = Math.min(1, cal.dynamicDamping / 3); // +3 => full smooth
            const compression = 1 / (1 + amount * 4); // down to 0.2x around center
            energyNorm = center + (energyNorm - center) * compression;
          }

          energyNorm = Math.max(0, Math.min(1, energyNorm));

          const rawPct = (cal.minBrightness + energyNorm * (effectiveMax - cal.minBrightness)) / 100;
          const pct = Math.round(rawPct * 100);

          // ── Drop detection (uses bassRms, not total RMS) ──
          const DROP_HISTORY_LEN = 120;  // ~2s of history
          const DROP_COOLDOWN_MS = 6000;
          const DROP_DURATION_MS = cal.whiteKickMs; // from calibration slider

          const bassHist = bassHistoryRef.current;
          bassHist.push(micBands.bassRms); // bass RMS only!
          if (bassHist.length > DROP_HISTORY_LEN) bassHist.shift();

          const now = tickStart; // reuse cached timestamp
          let isDrop = now < dropActiveUntilRef.current;

          const len = bassHist.length;
          if (len >= 50 && now - lastDropTimeRef.current > DROP_COOLDOWN_MS) {
            // Index-based averaging — no slice allocations
            let recentSum = 0;
            for (let i = len - 8; i < len; i++) recentSum += bassHist[i];
            const recentAvg = recentSum / 8;
            let pastSum = 0;
            const pastStart = len - 60;
            const pastEnd = len - 8;
            for (let i = pastStart; i < pastEnd; i++) pastSum += bassHist[i];
            const pastAvg = pastSum / (pastEnd - pastStart);

            // Much stricter thresholds — drops should be rare and dramatic
            const traitEnergy = (energyRef.current ?? 50) / 100;
            const quietThreshold = bassAgcMaxRef.current * (0.08 + traitEnergy * 0.10);
            const surgeMin = 6.0 - traitEnergy * 2.0;  // need 4-6x surge
            const absMin = bassAgcMaxRef.current * (0.75 - traitEnergy * 0.15);

            const surgeRatio = pastAvg > 0.0001 ? recentAvg / pastAvg : 0;

            if (pastAvg < quietThreshold && surgeRatio > surgeMin && recentAvg > absMin) {
              // Scale drop duration: massive surges (10x+) get full duration, weaker ones get half
              const surgeStrength = Math.min(1, (surgeRatio - surgeMin) / (surgeMin * 1.5));
              const dropDurationMod = 1.0 + traitEnergy * 0.5;
              const dropDur = DROP_DURATION_MS * (0.5 + surgeStrength * 0.5) * dropDurationMod;
              dropActiveUntilRef.current = now + dropDur;
              lastDropTimeRef.current = now;
              isDrop = true;
              console.log('[Drop/bass]', {
                bassPast: pastAvg.toFixed(5),
                bassRecent: recentAvg.toFixed(5),
                ratio: surgeRatio.toFixed(1),
                bassAgcMax: bassAgcMaxRef.current.toFixed(5),
                energy: energyRef.current,
              });
            }
          }

          // ── Track trait modulation ──
          const traitEnergy = (energyRef.current ?? 50) / 100;
          const traitDance = (danceabilityRef.current ?? 50) / 100;
          const traitHappy = (happinessRef.current ?? 50) / 100;

          // White = ONLY on drops (duration already includes traitEnergy from detection above)
          const isWhite = isDrop;
          const smoothEnd = performance.now();

          // BLE commands
          const c = charRef.current;
          if (c) {
            if (isWhite) {
              const warmR = 255;
              const warmG = Math.round(240 + traitHappy * 15);
              const warmB = Math.round(200 + (1 - traitHappy) * 55);
              sendColorAndBrightness(c, warmR, Math.min(255, warmG), warmB, 100);
              lastColorStateRef.current = 'white';
            } else {
              const calibrated = applyColorCalibration(...colorRef.current, cal);
              const modStrength = 0.2 + traitHappy * 0.25;
              const finalColor = modulateColor(...calibrated, micBands.lo, micBands.mid, micBands.hi, modStrength);
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
        };

        onBleWrite((bright, r, g, b) => {
          if (stopped) return;
          samplesRef.current.push({
            pct: bright,
            r: Math.max(r, 20),
            g: Math.max(g, 20),
            b: Math.max(b, 20),
          });
          if (samplesRef.current.length > effectiveHistoryLen) {
            samplesRef.current = samplesRef.current.slice(-effectiveHistoryLen);
          }
          chartDirtyRef.current = true;
          brightPctRef.current = bright;

          onLiveStatusRef.current?.({
            brightness: bright,
            color: [r, g, b],
            isWhiteKick: false,
            isDrop: performance.now() < dropActiveUntilRef.current,
            bassLevel: bassRef.current,
            midHiLevel: midHiRef.current,
          });
        });

        // AGC save on separate interval — out of hot tick path
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
      onBleWrite(null);
      if (agcSaveTimerRef.current) clearInterval(agcSaveTimerRef.current);
      workerRef.current?.postMessage("stop");
      workerRef.current?.terminate();
      streamRef.current?.getTracks().forEach(t => t.stop());
      ctxRef.current?.close().catch(() => {});
      resetChartScaler();
    };
  }, []);

  const isCompact = historyLenProp != null; // calibration mode: fill parent

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = isCompact ? sunRef.current : sunRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth * devicePixelRatio;
      canvas.height = container.clientHeight * devicePixelRatio;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [isCompact]);

  const [r, g, b] = currentColor;

  if (isCompact) {
    // Calibration mode: rectangular chart, no sun glow
    return (
      <div className="absolute inset-0" ref={sunRef}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ opacity: 0.9 }}
        />
      </div>
    );
  }

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
