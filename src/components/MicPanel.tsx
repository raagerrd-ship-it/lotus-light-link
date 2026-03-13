import { useEffect, useRef } from "react";
import { sendColorAndBrightness, setActiveChar, setPipelineTimings, onBleWrite, sendColor } from "@/lib/bledom";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/drawChart";
import { getCalibration, saveCalibration, applyColorCalibration, type LightCalibration } from "@/lib/lightCalibration";
import { getActiveDeviceName } from "@/lib/lightCalibration";
import { interpolateEnergy, hasKickNear, interpolateSample } from "@/lib/energyInterpolate";
import type { EnergySample, AgcState } from "@/lib/energyInterpolate";
import { getSectionLighting, beatPulse, type SongSection } from "@/lib/sectionLighting";
import { isInDrop, getBuildUpIntensity, type Drop } from "@/lib/dropDetect";
import { beatGridPhase, type BeatGrid } from "@/lib/bpmEstimate";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  sonosVolume?: number;
  sonosRtt?: number;
  getPosition?: () => { positionMs: number; receivedAt: number } | null;
  energyCurve?: EnergySample[] | null;
  onSaveEnergyCurve?: (samples: EnergySample[], volume: number | null, agcState?: AgcState | null) => void;
  recordedVolume?: number | null;
  savedAgcState?: AgcState | null;
  bpm?: number | null;
  beatGrid?: BeatGrid | null;
  sections?: SongSection[] | null;
  drops?: Drop[] | null;
}

const HISTORY_LEN = 120;

// Learned AGC
const AGC_MAX_DECAY = 0.995;
const AGC_MIN_RISE = 0.9999;
const AGC_ATTACK = 0.1;
const AGC_FLOOR = 0.002;
const PEAK_MAX_DECAY = 0.9998;

const CURVE_RECORD_INTERVAL_MS = 100;

// FFT band boundaries (bin indices for 512-point FFT at 48kHz)
// Each bin = sampleRate / fftSize ≈ 93.75 Hz
// Low: 0-300 Hz → bins 0-3, Mid: 300-2000 Hz → bins 3-21, Hi: 2000+ Hz → bins 21+
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
    // Convert from dB to linear power
    const power = Math.pow(10, freqData[i] / 10);
    if (i < loCut) { loSum += power; loCount++; }
    else if (i < midCut) { midSum += power; midCount++; }
    else { hiSum += power; hiCount++; }
  }

  const loAvg = loCount > 0 ? Math.sqrt(loSum / loCount) : 0;
  const midAvg = midCount > 0 ? Math.sqrt(midSum / midCount) : 0;
  const hiAvg = hiCount > 0 ? Math.sqrt(hiSum / hiCount) : 0;

  // Normalize: scale so max across bands ≈ 1
  const maxBand = Math.max(loAvg, midAvg, hiAvg, 0.0001);
  return {
    lo: Math.min(1, loAvg / maxBand),
    mid: Math.min(1, midAvg / maxBand),
    hi: Math.min(1, hiAvg / maxBand),
  };
}

/**
 * Modulate color based on frequency bands.
 * High lo → warmer (shift toward red/orange)
 * High hi → cooler/whiter (shift toward white)
 */
function modulateColor(
  baseR: number, baseG: number, baseB: number,
  lo: number, mid: number, hi: number,
  strength: number = 0.3
): [number, number, number] {
  // hi-band: blend toward white
  const whiteBlend = hi * strength * 0.5;
  let r = baseR + (255 - baseR) * whiteBlend;
  let g = baseG + (255 - baseG) * whiteBlend;
  let b = baseB + (255 - baseB) * whiteBlend;

  // lo-band: warm shift (boost red, reduce blue)
  const warmBlend = lo * strength * 0.4;
  r = Math.min(255, r + (255 - r) * warmBlend);
  b = Math.max(0, b - b * warmBlend * 0.5);

  return [Math.round(r), Math.round(g), Math.round(b)];
}

const MicPanel = ({ char, currentColor, sonosVolume, sonosRtt, getPosition, energyCurve, recordedVolume, savedAgcState, bpm, beatGrid, sections, drops, onSaveEnergyCurve }: MicPanelProps) => {
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
  const recordedVolumeRef = useRef(recordedVolume);
  const savedAgcStateRef = useRef(savedAgcState);
  const bpmRef = useRef(bpm);
  const beatGridRef = useRef(beatGrid);
  const sectionsRef = useRef(sections);
  const dropsRef = useRef(drops);
  const sonosRttRef = useRef(sonosRtt);
  const pipelineSumRef = useRef(0);
  const pipelineCountRef = useRef(0);

  useEffect(() => { energyCurveRef.current = energyCurve; }, [energyCurve]);
  useEffect(() => { getPositionRef.current = getPosition; }, [getPosition]);
  useEffect(() => { onSaveCurveRef.current = onSaveEnergyCurve; }, [onSaveEnergyCurve]);
  useEffect(() => { recordedVolumeRef.current = recordedVolume; }, [recordedVolume]);
  useEffect(() => { savedAgcStateRef.current = savedAgcState; }, [savedAgcState]);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { beatGridRef.current = beatGrid; }, [beatGrid]);
  useEffect(() => { sectionsRef.current = sections; }, [sections]);
  useEffect(() => { dropsRef.current = drops; }, [drops]);
  useEffect(() => { sonosRttRef.current = sonosRtt; }, [sonosRtt]);

  // Restore AGC from saved state when curve loads
  useEffect(() => {
    if (savedAgcState) {
      agcMaxRef.current = savedAgcState.agcMax;
      agcMinRef.current = savedAgcState.agcMin;
      agcPeakMaxRef.current = savedAgcState.agcPeakMax;
      console.log('[MicPanel] restored AGC from saved state', savedAgcState);
    }
  }, [savedAgcState]);

  // Flush recorded samples on curve change
  useEffect(() => {
    const prev = recordedSamplesRef.current;
    if (prev.length > 10 && onSaveCurveRef.current) {
      const agc: AgcState = {
        agcMin: agcMinRef.current,
        agcMax: agcMaxRef.current,
        agcPeakMax: agcPeakMaxRef.current,
      };
      onSaveCurveRef.current(prev, volumeRef.current ?? null, agc);
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
        const freqBuf = new Float32Array(analyser.frequencyBinCount);

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
          let curveKick = false;
          let curveLo = 0, curveMid = 0, curveHi = 0;

          if (hasCurve) {
            // ── Curve-driven mode ──
            const posSec = getSongPositionSec();
            if (posSec != null) {
              const sample = interpolateSample(curve!, posSec);
              let e = sample.e;

              // Volume compensation
              const recVol = recordedVolumeRef.current;
              const curVol = volumeRef.current;
              if (recVol != null && recVol > 0 && curVol != null && curVol > 0) {
                e *= (curVol / recVol);
                e = Math.min(1, e);
              }

              rms = e * Math.max(0.01, agcMaxRef.current);
              curveKick = hasKickNear(curve!, posSec);
              curveLo = sample.lo ?? 0;
              curveMid = sample.mid ?? 0;
              curveHi = sample.hi ?? 0;
            } else {
              rms = 0;
            }
            rmsEnd = performance.now();

            // Also read mic for curve improvement
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const micRms = Math.sqrt(sum / buf.length);
            const bands = computeBands(an, freqBuf);

            if (posSec != null && micRms > 0.001) {
              const now = performance.now();
              if (now - lastRecordTimeRef.current >= CURVE_RECORD_INTERVAL_MS) {
                lastRecordTimeRef.current = now;
                const range = Math.max(AGC_FLOOR, agcMaxRef.current - agcMinRef.current);
                const normMic = Math.min(1, Math.max(0, (micRms - agcMinRef.current) / range));
                const existingE = interpolateEnergy(curve!, posSec);
                const blended = existingE * 0.8 + normMic * 0.2;
                recordedSamplesRef.current.push({
                  t: posSec,
                  e: blended,
                  lo: bands.lo,
                  mid: bands.mid,
                  hi: bands.hi,
                });
              }
            }
          } else {
            // ── Mic-driven mode ──
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            rms = Math.sqrt(sum / buf.length);
            rmsEnd = performance.now();
          }

          // Smoothing + normalization
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
          let pct = Math.round(cal.minBrightness + normalized * (effectiveMax - cal.minBrightness));

          // Section-aware adjustments
          const posSec2 = getSongPositionSec();
          const sectionParams = getSectionLighting(sectionsRef.current, posSec2 ?? 0);
          pct = Math.round(pct * sectionParams.brightnessScale);

          // Beat-synced pulse
          const currentBpm = bpmRef.current;
          if (currentBpm && currentBpm > 0 && posSec2 != null && sectionParams.beatPulseStrength > 0) {
            const pulse = beatPulse(posSec2, currentBpm);
            const pulseBoost = pulse * sectionParams.beatPulseStrength * 15; // max ~15% brightness boost
            pct = Math.min(100, Math.round(pct + pulseBoost));
          }

          // Record energy sample for first-listen curve
          if (!hasCurve) {
            const posSec = getSongPositionSec();
            if (posSec != null) {
              const now = performance.now();
              const lastRec = recordedSamplesRef.current;
              const lastT = lastRec.length > 0 ? lastRec[lastRec.length - 1].t : -1;
              if (posSec - lastT >= CURVE_RECORD_INTERVAL_MS / 1000) {
                lastRecordTimeRef.current = now;
                // Compute frequency bands
                const bands = computeBands(an, freqBuf);
                const isKick = pct > sectionParams.kickThreshold;
                recordedSamplesRef.current.push({
                  t: posSec,
                  e: normalized,
                  kick: isKick || undefined,
                  lo: bands.lo,
                  mid: bands.mid,
                  hi: bands.hi,
                });
              }
            }
          }

          // White kick logic
          const now = performance.now();
          const inWhiteKick = now < whiteKickUntilRef.current;
          const currentDrops = dropsRef.current;
          const inDropZone = currentDrops && posSec2 != null ? isInDrop(currentDrops, posSec2) : false;
          const buildUp = currentDrops && posSec2 != null ? getBuildUpIntensity(currentDrops, posSec2) : 0;

          // During build-up: gradually increase brightness
          if (buildUp > 0) {
            pct = Math.min(100, Math.round(pct + buildUp * 20));
          }

          if (hasCurve) {
            // Curve mode: use saved kick timestamps, gated by section
            // In drop zone: lower kick threshold for more frequent kicks
            const effectiveKickEnabled = inDropZone || sectionParams.kickEnabled;
            if (curveKick && !inWhiteKick && effectiveKickEnabled) {
              whiteKickUntilRef.current = now + (inDropZone ? cal.whiteKickMs * 0.7 : cal.whiteKickMs);
            }
          } else {
            // Mic mode: use section-aware threshold
            const effectiveThreshold = inDropZone ? Math.min(sectionParams.kickThreshold, 88) : sectionParams.kickThreshold;
            if (pct > effectiveThreshold && !inWhiteKick && sectionParams.kickEnabled) {
              whiteKickUntilRef.current = now + cal.whiteKickMs;
            }
          }
          const isWhite = now < whiteKickUntilRef.current;
          const smoothEnd = performance.now();

          // BLE commands
          const c = charRef.current;
          if (c) {
            if (isWhite) {
              sendColorAndBrightness(c, 255, 255, 255, 100);
              lastColorStateRef.current = 'white';
            } else {
              const calibrated = applyColorCalibration(...colorRef.current, cal);
              // Apply frequency-based color modulation with section-aware strength
              let finalColor: [number, number, number] = calibrated;
              const modStrength = inDropZone ? Math.min(0.6, sectionParams.colorModStrength + 0.2) : sectionParams.colorModStrength;
              if (hasCurve && (curveLo > 0 || curveHi > 0)) {
                finalColor = modulateColor(...calibrated, curveLo, curveMid, curveHi, modStrength);
              }
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
      const recorded = recordedSamplesRef.current;
      if (recorded.length > 10 && onSaveCurveRef.current) {
        const agc: AgcState = {
          agcMin: agcMinRef.current,
          agcMax: agcMaxRef.current,
          agcPeakMax: agcPeakMaxRef.current,
        };
        onSaveCurveRef.current(recorded, volumeRef.current ?? null, agc);
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
