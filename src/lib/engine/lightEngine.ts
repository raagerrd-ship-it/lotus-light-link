/**
 * LightEngine — framework-agnostic real-time audio→light pipeline.
 *
 * Portable: no DOM access, no React. Copy this folder + tick-worker.js
 * to use in any project.
 */

import { sendToBLE, addActiveChar, removeActiveChar, type DeviceMode } from "./bledom";
import { getCalibration, saveCalibration, applyColorCalibration, getActiveDeviceName, getIdleColor, type LightCalibration } from "./lightCalibration";
import { computeBands, type BandResult } from "./audioAnalysis";
import { createAgcState, rescaleAgc, updateGlobalAgc, updateBandPeaks, getEffectiveMax, normalizeBand, type AgcState } from "./agc";
import { smooth, computeBrightnessPct } from "./brightnessEngine";

const AGC_LEARN_DURATION_MS = 20_000;

export interface TickData {
  brightness: number;
  color: [number, number, number];
  baseColor: [number, number, number];
  bassLevel: number;
  midHiLevel: number;
  rawEnergyPct: number;
  isPunch: boolean;
  bleColorSource: 'normal' | 'idle';
  micRms: number;
  isPlaying: boolean;
  /** Pipeline timing in ms */
  timings: { rmsMs: number; smoothMs: number; bleCallMs: number; totalTickMs: number };
}

export type TickCallback = (data: TickData) => void;

export class LightEngine {
  // --- State ---
  private color: [number, number, number] = [255, 80, 0];
  private volume: number | undefined;
  private playing = true;
  private chars = new Set<BluetoothRemoteGATTCharacteristic>();
  private tickMs = 125;

  // --- Internal ---
  private analyser: AnalyserNode | null = null;
  private freqBuf: Float32Array<ArrayBuffer> | null = null;
  private smoothed = 0;
  private smoothedBass = 0;
  private smoothedMidHi = 0;
  private dynamicCenter = 0.5;
  private agc: AgcState;
  private cal: LightCalibration;
  private lastBaseColor: [number, number, number] = [0, 0, 0];
  private lastVolume: number | undefined;
  private agcLocked = false;
  private trackStartTime = 0;
  
  private idleSent = false;

  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private hiShelf: BiquadFilterNode | null = null;
  private agcSaveTimer = 0;
  private stopped = false;
  private tickCallbacks: TickCallback[] = [];
  private idleColor: [number, number, number];
  private idleCleanup: (() => void) | null = null;
  private calCleanup: (() => void) | null = null;

  constructor() {
    this.cal = getCalibration();
    this.agc = createAgcState(this.cal.agcMax, this.cal.agcMin);
    this.idleColor = getIdleColor();
  }

  /** Register a tick callback. Returns unsubscribe function. */
  onTick(cb: TickCallback): () => void {
    this.tickCallbacks.push(cb);
    return () => { this.tickCallbacks = this.tickCallbacks.filter(c => c !== cb); };
  }

  setColor(rgb: [number, number, number]) { this.color = rgb; }
  setVolume(vol: number | undefined) { this.volume = vol; }
  setTickMs(ms: number) { this.tickMs = ms; this.worker?.postMessage(ms); }

  setPlaying(playing: boolean) {
    this.playing = playing;
    if (playing && this.worker) this.worker.postMessage('start');
  }

  /** @deprecated Use addChar/removeChar for multi-device */
  setChar(char: BluetoothRemoteGATTCharacteristic | null) {
    if (char) this.addChar(char);
  }

  addChar(char: BluetoothRemoteGATTCharacteristic, mode: DeviceMode = 'rgb') {
    this.chars.add(char);
    addActiveChar(char, mode);
  }

  removeChar(char: BluetoothRemoteGATTCharacteristic) {
    this.chars.delete(char);
    removeActiveChar(char);
  }

  hasChars(): boolean {
    return this.chars.size > 0;
  }

  /** Reset AGC — call on track change or other events that invalidate learned levels.
   *  Scales saved AGC baseline by current/saved volume ratio. */
  resetAgc(): void {
    const cal = this.cal;
    const currentVol = this.volume;
    const savedVol = cal.agcVolume;
    const savedMax = cal.agcMax > 0 ? cal.agcMax : 0.01;
    const savedMin = cal.agcMin;

    let startMax = savedMax;
    let startMin = savedMin;
    if (currentVol != null && currentVol > 0 && savedVol != null && savedVol > 0) {
      const ratio = currentVol / savedVol;
      startMax = Math.max(0.01, savedMax * ratio);
      startMin = Math.max(0, savedMin * ratio);
    }

    this.agc = createAgcState(startMax, startMin);
    this.smoothedBass = 0;
    this.smoothedMidHi = 0;
    this.dynamicCenter = 0.5;
    this.agcLocked = false;
    this.trackStartTime = performance.now();
    this.lastVolume = currentVol;
    console.log('[AGC] Reset → vol-scaled start (max=', startMax.toFixed(5), 'vol=', currentVol, ')');
  }

  /** Initialize mic, audio pipeline, and start the tick loop.
   *  Safe to call multiple times — stops previous instance first. */
  async start(): Promise<void> {
    if (this.worker || this.stream) this.stop();
    this.stopped = false;

    // Listen for calibration changes
    const reloadCal = () => {
      this.cal = getCalibration();
      if (this.hiShelf) this.hiShelf.gain.value = this.cal.hiShelfGainDb;
    };
    const onStorage = (e: StorageEvent) => { if (e.key === 'light-calibration') reloadCal(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('calibration-changed', reloadCal);
    this.calCleanup = () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('calibration-changed', reloadCal);
    };

    // Listen for idle color changes
    const onIdleColorChanged = () => { this.idleColor = getIdleColor(); this.idleSent = false; };
    window.addEventListener('idle-color-changed', onIdleColorChanged);
    this.idleCleanup = () => window.removeEventListener('idle-color-changed', onIdleColorChanged);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      if (this.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;

      const audioCtx = new AudioContext({ latencyHint: 'interactive' });
      this.audioCtx = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);

      const hiShelf = audioCtx.createBiquadFilter();
      hiShelf.type = 'highshelf';
      hiShelf.frequency.value = 2000;
      hiShelf.gain.value = this.cal.hiShelfGainDb;
      this.hiShelf = hiShelf;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0;
      source.connect(hiShelf);
      hiShelf.connect(analyser);
      this.analyser = analyser;
      this.freqBuf = new Float32Array(analyser.frequencyBinCount);

      const worker = new Worker("/tick-worker.js");
      this.worker = worker;

      worker.onmessage = () => this.tick();

      // AGC save on separate interval
      this.agcSaveTimer = window.setInterval(() => {
        if (this.stopped) return;
        const agc = this.agc;
        const updated = { ...this.cal, agcMin: agc.min, agcMax: agc.max, agcVolume: this.volume ?? null };
        this.cal = updated;
        saveCalibration(updated, getActiveDeviceName() ?? undefined, { localOnly: true });
      }, 10_000);

      worker.postMessage("start");
    } catch (e) {
      console.error("[LightEngine] mic init failed", e);
    }
  }

  /** Stop everything and release resources */
  stop(): void {
    this.stopped = true;
    this.idleCleanup?.();
    this.calCleanup?.();
    this.idleCleanup = null;
    this.calCleanup = null;
    if (this.agcSaveTimer) { clearInterval(this.agcSaveTimer); this.agcSaveTimer = 0; }
    this.worker?.postMessage("stop");
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analyser = null;
    this.freqBuf = null;
    this.hiShelf = null;
  }

  /** Full teardown — stop + reset all state and callbacks. Instance is unusable after this. */
  destroy(): void {
    this.stop();
    this.tickCallbacks = [];
    this.color = [255, 80, 0];
    this.volume = undefined;
    this.playing = true;
    this.chars.clear();
    this.smoothed = 0;
    this.smoothedBass = 0;
    this.smoothedMidHi = 0;
    this.dynamicCenter = 0.5;
    this.agc = createAgcState(0.01, 0);
    this.lastBaseColor = [0, 0, 0];
    this.lastVolume = undefined;
    this.agcLocked = false;
    this.trackStartTime = 0;
    this.idleSent = false;
    this.idleColor = [255, 60, 0];
  }

  /** Core tick — called by worker */
  private tick(): void {
    if (this.stopped) return;

    // ── Idle mode ──
    if (!this.playing) {
      if (!this.idleSent && this.chars.size > 0) {
        const calibrated = applyColorCalibration(...this.idleColor);
        sendToBLE(calibrated[0], calibrated[1], calibrated[2], 100);
        this.idleSent = true;
        this.emit({
          brightness: 100, color: this.idleColor, baseColor: this.idleColor,
          bassLevel: 0, midHiLevel: 0, rawEnergyPct: 0,
          isPunch: false, bleColorSource: 'idle', micRms: 0, isPlaying: false,
          timings: { rmsMs: 0, smoothMs: 0, bleCallMs: 0, totalTickMs: 0 },
        });
      }
      this.worker?.postMessage('stop');
      return;
    }
    this.idleSent = false;

    const an = this.analyser;
    if (!an || !this.freqBuf) return;

    const tickStart = performance.now();
    const cal = this.cal;
    const agc = this.agc;

    // ── FFT ──
    const bands = computeBands(an, this.freqBuf);
    const rmsEnd = performance.now();

    // ── Smoothing with reactivity scaling ──
    const prevAbsFactor = agc.peakMax > 0 ? Math.min(1, agc.max / agc.peakMax) : 1;
    const reactivity = 1 + (1 - prevAbsFactor) * 2;
    const attackA = Math.min(1.0, cal.attackAlpha * reactivity);
    const releaseA = Math.min(0.5, cal.releaseAlpha * reactivity);
    this.smoothed = smooth(this.smoothed, bands.totalRms, attackA, releaseA);

    // ── Volume-proportional AGC rescaling ──
    const vol = this.volume;
    const prevVol = this.lastVolume;
    if (prevVol != null && vol != null && Math.abs(vol - prevVol) > 2) {
      const strength = cal.volCompensation / 100;
      const rawRatio = prevVol > 0 ? (vol / prevVol) : 1;
      rescaleAgc(agc, 1 + (rawRatio - 1) * strength);
      this.lastVolume = vol;
      if (Math.abs(vol - prevVol) > 5 && this.agcLocked) {
        this.agcLocked = false;
        this.trackStartTime = performance.now();
        console.log('[AGC] Volume change', prevVol, '→', vol, '— re-learning 20s');
      }
    } else if (prevVol == null && vol != null) {
      this.lastVolume = vol;
    }

    // ── Check if learning window has elapsed → lock AGC ──
    if (!this.agcLocked && this.trackStartTime > 0 && (performance.now() - this.trackStartTime) > AGC_LEARN_DURATION_MS) {
      this.agcLocked = true;
      agc.peakMax = agc.max;
      console.log('[AGC] Locked. max=', agc.max.toFixed(5), 'effectiveMax=', getEffectiveMax(agc).toFixed(1));
    }

    // ── Global AGC + band peak tracking ──
    const isLearning = !this.agcLocked;
    if (isLearning) {
      updateGlobalAgc(agc, this.smoothed, true);
      updateBandPeaks(agc, bands.bassRms, bands.midHiRms);
    } else if (this.smoothed > agc.max) {
      // After lock: allow max to grow upward (never shrink)
      agc.max = this.smoothed;
      console.log('[AGC] Post-lock max raised →', agc.max.toFixed(5));
    }

    // Normalize bands
    const rawBassNorm = normalizeBand(bands.bassRms, agc, 'bass');
    const rawMidHiNorm = normalizeBand(bands.midHiRms, agc, 'midHi');
    const effectiveMax = getEffectiveMax(agc);
    const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;
    const rawEnergyPct = Math.round(((rawEnergy * effectiveMax) / 100) * 100);

    // ── Per-band smoothing ──
    this.smoothedBass = smooth(this.smoothedBass, rawBassNorm, attackA, releaseA);
    this.smoothedMidHi = smooth(this.smoothedMidHi, rawMidHiNorm, attackA, releaseA);

    // ── Brightness ──
    const { pct, newCenter } = computeBrightnessPct(
      this.smoothedBass, this.smoothedMidHi,
      effectiveMax, this.dynamicCenter, cal,
    );
    this.dynamicCenter = newCenter;
    const smoothEnd = performance.now();

    // ── Resolve colors ──
    const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;
    const finalColor = applyColorCalibration(...this.color, cal);
    const bleSentR = finalColor[0], bleSentG = finalColor[1], bleSentB = finalColor[2];
    this.lastBaseColor = [bleSentR, bleSentG, bleSentB];

    // ── BLE output ──
    if (this.chars.size > 0) {
      if (isPunch) sendToBLE(255, 255, 255, pct);
      else sendToBLE(bleSentR, bleSentG, bleSentB, pct);
    }
    const bleEnd = performance.now();

    // ── Emit tick data ──
    this.emit({
      brightness: pct,
      color: [bleSentR, bleSentG, bleSentB],
      baseColor: this.lastBaseColor,
      bassLevel: bands.bassRms,
      midHiLevel: bands.midHiRms,
      rawEnergyPct,
      isPunch,
      bleColorSource: 'normal',
      micRms: this.smoothed,
      isPlaying: this.playing,
      timings: {
        rmsMs: rmsEnd - tickStart,
        smoothMs: smoothEnd - rmsEnd,
        bleCallMs: bleEnd - smoothEnd,
        totalTickMs: bleEnd - tickStart,
      },
    });
  }

  private emit(data: TickData) {
    for (const cb of this.tickCallbacks) cb(data);
  }
}
