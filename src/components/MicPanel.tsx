import { useEffect, useRef } from "react";
import { refineKicks } from "@/lib/kickRefine";
import { sendColorAndBrightness, setActiveChar, setPipelineTimings, onBleWrite, sendColor } from "@/lib/bledom";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/drawChart";
import { getCalibration, saveCalibration, applyColorCalibration, type LightCalibration } from "@/lib/lightCalibration";
import { getActiveDeviceName } from "@/lib/lightCalibration";
import { hasKickNear, interpolateSample } from "@/lib/energyInterpolate";
import type { EnergySample, AgcState } from "@/lib/energyInterpolate";
import { getSectionLighting, beatPulse, getCurrentBeatStrength, getTransitionParams, getCurrentSection, type SongSection } from "@/lib/sectionLighting";
import type { DynamicRange, Transition } from "@/lib/songAnalysis";
import { isInDrop, getBuildUpIntensity, type Drop } from "@/lib/dropDetect";
import { beatGridPhase, type BeatGrid } from "@/lib/bpmEstimate";
import { reportLiveOnset, tickAutoSync, getAutoSyncDriftMs, resetAutoSync } from "@/lib/autoSync";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  palette?: [number, number, number][];
  sonosVolume?: number;
  sonosRtt?: number;
  isPlaying?: boolean;
  durationMs?: number | null;
  getPosition?: () => { positionMs: number; receivedAt: number } | null;
  energyCurve?: EnergySample[] | null;
  onSaveEnergyCurve?: (
    samples: EnergySample[],
    volume: number | null,
    agcState?: AgcState | null,
    trackOverride?: { trackName: string; artistName: string } | null,
  ) => void;
  recordedVolume?: number | null;
  savedAgcState?: AgcState | null;
  bpm?: number | null;
  beatGrid?: BeatGrid | null;
  sections?: SongSection[] | null;
  drops?: Drop[] | null;
  dynamicRange?: DynamicRange | null;
  transitions?: Transition[] | null;
  beatStrengths?: number[] | null;
  trackName?: string | null;
  artistName?: string | null;
  onLiveStatus?: (status: { brightness: number; color: [number, number, number]; sectionType?: string; isWhiteKick: boolean }) => void;
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

const MicPanel = ({ char, currentColor, palette, sonosVolume, sonosRtt, isPlaying = true, durationMs, getPosition, energyCurve, recordedVolume, savedAgcState, bpm, beatGrid, sections, drops, dynamicRange, transitions, beatStrengths, trackName, artistName, onSaveEnergyCurve, onLiveStatus }: MicPanelProps) => {
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
  const dynamicRangeRef = useRef(dynamicRange);
  const transitionsRef = useRef(transitions);
  const beatStrengthsRef = useRef(beatStrengths);
  const sonosRttRef = useRef(sonosRtt);
  const onLiveStatusRef = useRef(onLiveStatus);
  const isPlayingRef = useRef(isPlaying);
  const durationMsRef = useRef(durationMs);
  const recordingStartPosRef = useRef<number | null>(null); // position when recording started
  const recordingDurationMsRef = useRef<number | null>(null);
  const currentTrackRef = useRef<{ trackName: string; artistName: string } | null>(null);
  const recordingTrackRef = useRef<{ trackName: string; artistName: string } | null>(null);
  const pipelineSumRef = useRef(0);
  const pipelineCountRef = useRef(0);
  const paletteRef = useRef(palette);
  const paletteColorIndexRef = useRef(0);
  const lastSectionTypeRef = useRef<string | null>(null);
  const strobeUntilRef = useRef(0);
  const bassRef = useRef(0);
  const brightPctRef = useRef(0);
  const sunRef = useRef<HTMLDivElement>(null);

  useEffect(() => { energyCurveRef.current = energyCurve; }, [energyCurve]);
  useEffect(() => { getPositionRef.current = getPosition; }, [getPosition]);
  useEffect(() => { onSaveCurveRef.current = onSaveEnergyCurve; }, [onSaveEnergyCurve]);
  useEffect(() => { recordedVolumeRef.current = recordedVolume; }, [recordedVolume]);
  useEffect(() => { savedAgcStateRef.current = savedAgcState; }, [savedAgcState]);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { beatGridRef.current = beatGrid; }, [beatGrid]);
  useEffect(() => { sectionsRef.current = sections; }, [sections]);
  useEffect(() => { dropsRef.current = drops; }, [drops]);
  useEffect(() => { dynamicRangeRef.current = dynamicRange; }, [dynamicRange]);
  useEffect(() => { transitionsRef.current = transitions; }, [transitions]);
  useEffect(() => { beatStrengthsRef.current = beatStrengths; }, [beatStrengths]);
  useEffect(() => { sonosRttRef.current = sonosRtt; }, [sonosRtt]);
  useEffect(() => { onLiveStatusRef.current = onLiveStatus; }, [onLiveStatus]);
  useEffect(() => { durationMsRef.current = durationMs; }, [durationMs]);
  useEffect(() => { paletteRef.current = palette; }, [palette]);
  useEffect(() => {
    currentTrackRef.current = trackName && artistName ? { trackName, artistName } : null;
  }, [trackName, artistName]);

  // Restore AGC from saved state when curve loads
  useEffect(() => {
    if (savedAgcState) {
      agcMaxRef.current = savedAgcState.agcMax;
      agcMinRef.current = savedAgcState.agcMin;
      agcPeakMaxRef.current = savedAgcState.agcPeakMax;
      console.log('[MicPanel] restored AGC from saved state', savedAgcState);
    }
  }, [savedAgcState]);

  const touchRecordingContext = () => {
    const dur = durationMsRef.current;
    if (typeof dur === 'number' && dur > 0) {
      recordingDurationMsRef.current = Math.max(recordingDurationMsRef.current ?? 0, dur);
    }
    if (!recordingTrackRef.current && currentTrackRef.current) {
      recordingTrackRef.current = currentTrackRef.current;
    }
  };

  const flushRecordedSamples = (reason: 'track-change' | 'playback-stop' | 'unmount') => {
    const prev = recordedSamplesRef.current;
    const saveCurve = onSaveCurveRef.current;
    const recordingTrack = recordingTrackRef.current;
    if (prev.length > 10 && saveCurve) {
      const dur = recordingDurationMsRef.current ?? durationMsRef.current;
      const firstT = prev[0].t;
      const lastT = prev[prev.length - 1].t;
      const durationSec = dur ? dur / 1000 : 0;
      // Complete = started within first 15s AND reached last 15s of song
      const startedEarly = firstT < 15;
      const finishedLate = durationSec > 0 && lastT > (durationSec - 15);
      const isComplete = startedEarly && finishedLate;

      if (isComplete) {
        // Post-process: refine kicks with contrast filtering, debouncing & beat-snap
        refineKicks(prev, beatGridRef.current);
        const agc: AgcState = {
          agcMin: agcMinRef.current,
          agcMax: agcMaxRef.current,
          agcPeakMax: agcPeakMaxRef.current,
          avgPipelineMs: pipelineCountRef.current > 0 ? pipelineSumRef.current / pipelineCountRef.current : undefined,
        };
        console.log(`[MicPanel] ✓ complete recording (${reason})`, prev.length, 'samples,', firstT.toFixed(1), '-', lastT.toFixed(1), 's of', durationSec.toFixed(0), 's',
          'kicks:', prev.filter(s => s.kick).length, '/', prev.length);
        saveCurve(prev, volumeRef.current ?? null, agc, recordingTrack);
      } else {
        console.log(`[MicPanel] ✗ discarding incomplete recording (${reason})`, prev.length, 'samples,', firstT.toFixed(1), '-', lastT.toFixed(1), 's of', durationSec.toFixed(0), 's');
      }
    }
    recordedSamplesRef.current = [];
    recordingStartPosRef.current = null;
    recordingDurationMsRef.current = null;
    recordingTrackRef.current = null;
    lastRecordTimeRef.current = 0;
  };

  // Flush on playback stop (not just on track-name changes)
  useEffect(() => {
    const wasPlaying = isPlayingRef.current;
    isPlayingRef.current = isPlaying;
    if (wasPlaying && !isPlaying) {
      flushRecordedSamples('playback-stop');
    }
  }, [isPlaying]);

  // Flush recorded samples on track change
  useEffect(() => {
    flushRecordedSamples('track-change');
  }, [trackName, artistName]);
  useEffect(() => {
    colorRef.current = currentColor;
    lastBaseColorRef.current = currentColor;
    lastColorStateRef.current = 'normal';
    agcMaxRef.current = Math.max(agcMaxRef.current * 0.5, 0.01);
    agcMinRef.current = 0;
    samplesRef.current = [];
    resetChartScaler();
    resetAutoSync();
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
      // Animate sun — glow intensity + size driven by brightness pct
      const sun = sunRef.current;
      if (sun) {
        const b = brightPctRef.current / 100; // 0–1 normalized brightness
        const [cr, cg, cb] = colorRef.current;
        
        // Glow size and brightness scale with overall light output
        const ringSpread = 2 + b * 40;
        const outerGlow = 30 + b * 300;
        const farGlow = 60 + b * 400;
        const ringAlpha = 0.05 + b * 0.7;
        const outerAlpha = 0.03 + b * 0.4;
        const farAlpha = 0.01 + b * 0.2;
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

  const getSongPositionSec = (): number | null => {
    const gp = getPositionRef.current;
    if (!gp) return null;
    const pos = gp();
    if (!pos) return null;
    const elapsed = performance.now() - pos.receivedAt;
    const cal = calRef.current;
    const hasCurve = Array.isArray(energyCurveRef.current) && energyCurveRef.current.length > 10;
    // In curve mode: add chainLatencyMs as look-ahead + autoSync drift
    // In mic mode: add bleLatencyMs only (mic already hears the delayed audio)
    const lookAheadMs = hasCurve ? cal.chainLatencyMs : cal.bleLatencyMs;
    const driftMs = hasCurve ? getAutoSyncDriftMs() : 0;
    return (pos.positionMs + elapsed + lookAheadMs + driftMs) / 1000;
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
          if (!isPlayingRef.current) return; // Don't process when paused
          const an = analyserRef.current;
          if (!an) return;

          const tickStart = performance.now();
          const cal = calRef.current;
          const curve = energyCurveRef.current;
          const hasCurve = Array.isArray(curve) && curve.length > 10;

          let rms: number = 0;
          let rmsEnd: number;
          let curveKick = false;
          let curveLo = 0, curveMid = 0, curveHi = 0;
          let pct: number;

          if (hasCurve) {
            // ── Curve mode: deterministic brightness, mic only for sync ──
            const posSec = getSongPositionSec();
            rmsEnd = performance.now();

            // Read mic solely for auto-sync beat correlation
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const micRms = Math.sqrt(sum / buf.length);

            if (posSec != null) {
              reportLiveOnset(micRms, smoothedRef.current, posSec, curve!);
            }
            tickAutoSync();
            // Keep smoothedRef updated for onset baseline
            smoothedRef.current = micRms;

            // Brightness from saved curve — no AGC
            let normalized = 0;
            if (posSec != null) {
              const sample = interpolateSample(curve!, posSec);
              normalized = sample.e;
              curveKick = hasKickNear(curve!, posSec);
              curveLo = sample.lo ?? 0;
              curveMid = sample.mid ?? 0;
              curveHi = sample.hi ?? 0;

              // Volume compensation
              const recVol = recordedVolumeRef.current;
              const curVol = volumeRef.current;
              if (recVol != null && recVol > 0 && curVol != null && curVol > 0) {
                normalized *= (curVol / recVol);
                normalized = Math.min(1, normalized);
              }
            }

            // Dynamic damping
            if (cal.dynamicDamping !== 1.0) {
              normalized = Math.pow(normalized, cal.dynamicDamping);
            }

            pct = Math.round(cal.minBrightness + normalized * (cal.maxBrightness - cal.minBrightness));
            // Update bass ref for sun pulse
            bassRef.current = curveLo;
          } else {
            // ── Mic mode: read mic + full AGC pipeline ──
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            rms = Math.sqrt(sum / buf.length);
            rmsEnd = performance.now();

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
            pct = Math.round(cal.minBrightness + normalized * (effectiveMax - cal.minBrightness));
            // Update bass ref for sun pulse (compute bands from mic)
            const micBands = computeBands(an, freqBuf);
            bassRef.current = micBands.lo;
          }

          // Section-aware adjustments — concert effects only for analyzed songs
          const posSec2 = getSongPositionSec();
          const sectionParams = getSectionLighting(sectionsRef.current, posSec2 ?? 0, dynamicRangeRef.current);

          if (hasCurve) {
            // ── Deep section dynamics (only with saved analysis) ──
            pct = Math.round(pct * sectionParams.brightnessScale);

            // ── Palette rotation on section changes ──
            const currentSections = sectionsRef.current;
            if (currentSections && posSec2 != null) {
              const curSection = getCurrentSection(currentSections, posSec2);
              const curType = curSection?.type ?? null;
              if (curType && curType !== lastSectionTypeRef.current) {
                lastSectionTypeRef.current = curType;
                const pal = paletteRef.current;
                if (pal && pal.length > 1) {
                  paletteColorIndexRef.current = (paletteColorIndexRef.current + 1) % pal.length;
                  colorRef.current = pal[paletteColorIndexRef.current];
                }
              }
            }

            // ── Blackout before drops: last 10% of build-up → dim to near-zero ──
            const currentDrops2 = dropsRef.current;
            const buildUp2 = currentDrops2 && posSec2 != null ? getBuildUpIntensity(currentDrops2, posSec2) : 0;
            if (buildUp2 > 0.9) {
              const blackoutProgress = (buildUp2 - 0.9) / 0.1;
              pct = Math.round(pct * (1 - blackoutProgress * 0.85));
            }

            // ── Beat-synced pulse — concert-level (×30) with strobe ──
            const currentBpm = bpmRef.current;
            const grid = beatGridRef.current;
            if (currentBpm && currentBpm > 0 && posSec2 != null && sectionParams.beatPulseStrength > 0) {
              const phase = grid ? beatGridPhase(grid, posSec2) : ((posSec2 * currentBpm / 60) % 1);
              const bs = getCurrentBeatStrength(beatStrengthsRef.current, grid?.beats ?? null, posSec2);
              const pulse = beatPulse(posSec2, currentBpm, bs);
              const pulseBoost = pulse * sectionParams.beatPulseStrength * 30;
              pct = Math.min(100, Math.round(pct + pulseBoost));

              // Strobe on beat in drops: 40ms white flash per beat
              if (sectionParams.strobeOnBeat && phase < 0.08 && performance.now() > strobeUntilRef.current + 60) {
                strobeUntilRef.current = performance.now() + 40;
              }
            }

            // ── Hard transition flash: 80ms white burst ──
            const transParams = getTransitionParams(transitionsRef.current, posSec2 ?? 0);
            if (transParams.active && transParams.type === 'hard') {
              if (transParams.progress < 0.15) {
                pct = Math.min(100, pct + 30);
                strobeUntilRef.current = Math.max(strobeUntilRef.current, performance.now() + 80);
              }
            }
          } else {
            // ── Mic-mode: subtle beat pulse only (×15) ──
            const currentBpm = bpmRef.current;
            const grid = beatGridRef.current;
            if (currentBpm && currentBpm > 0 && posSec2 != null) {
              const pulse = beatPulse(posSec2, currentBpm);
              const pulseBoost = pulse * 15;
              pct = Math.min(100, Math.round(pct + pulseBoost));
            }
          }

          // Track pipeline latency
          const tickTotal = performance.now() - tickStart;
          pipelineSumRef.current += tickTotal;
          pipelineCountRef.current++;

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
                // Don't mark kicks during recording — they'll be computed post-recording with global peak
                touchRecordingContext();
                recordedSamplesRef.current.push({
                  t: posSec,
                  rawRms: rms,
                  lo: bands.lo,
                  mid: bands.mid,
                  hi: bands.hi,
                });
              }
            }
          }

          // White kick & strobe logic
          const now = performance.now();
          const inWhiteKick = now < whiteKickUntilRef.current;
          const inStrobe = now < strobeUntilRef.current;
          const currentDrops = dropsRef.current;
          const inDropZone = currentDrops && posSec2 != null ? isInDrop(currentDrops, posSec2) : false;
          const buildUp = currentDrops && posSec2 != null ? getBuildUpIntensity(currentDrops, posSec2) : 0;

          // During build-up (before blackout zone): gradually increase brightness
          if (buildUp > 0 && buildUp <= 0.9) {
            pct = Math.min(100, Math.round(pct + buildUp * 20));
          }

          if (hasCurve) {
            const effectiveKickEnabled = inDropZone || sectionParams.kickEnabled;
            if (curveKick && !inWhiteKick && effectiveKickEnabled) {
              whiteKickUntilRef.current = now + (inDropZone ? cal.whiteKickMs * 0.7 : cal.whiteKickMs);
            }
          } else {
            const effectiveThreshold = inDropZone ? Math.min(sectionParams.kickThreshold, 88) : sectionParams.kickThreshold;
            if (pct > effectiveThreshold && !inWhiteKick && sectionParams.kickEnabled) {
              whiteKickUntilRef.current = now + cal.whiteKickMs;
            }
          }
          const isWhite = now < whiteKickUntilRef.current || inStrobe;
          const smoothEnd = performance.now();

          // BLE commands
          const c = charRef.current;
          if (c) {
            if (isWhite) {
              sendColorAndBrightness(c, 255, 255, 255, 100);
              lastColorStateRef.current = 'white';
            } else {
              const calibrated = applyColorCalibration(...colorRef.current, cal);
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
            saveCalibration(updated, getActiveDeviceName() ?? undefined, { localOnly: true });
          }
        };

        onBleWrite((bright, r, g, b) => {
          if (stopped) return;
          // Use raw RGB for color (so the line matches the hue sent to the lamp)
          // pct = brightness for Y-axis positioning
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

          // Notify live session
          onLiveStatusRef.current?.({
            brightness: bright,
            color: [r, g, b],
            sectionType: undefined,
            isWhiteKick: performance.now() < whiteKickUntilRef.current,
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
      flushRecordedSamples('unmount');
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
