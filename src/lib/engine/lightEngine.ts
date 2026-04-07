/**
 * LightEngine — framework-agnostic real-time audio→light pipeline.
 *
 * Portable: no DOM access, no React. Copy this folder + tick-worker.js
 * to use in any project.
 */

import { sendToBLE, addActiveChar, removeActiveChar, type DeviceMode } from "./bledom";
import { getCalibration, saveCalibration, applyColorCalibration, getActiveDeviceName, type LightCalibration } from "./lightCalibration";
import { computeBands, resetFluxState } from "./audioAnalysis";
import { createAgcState, updateRunningMax, volumeToBucket, updateVolumeTable, getFloorForVolume, normalizeBand, type AgcState, type AgcVolumeTable } from "./agc";
import { smooth, computeBrightnessPct, extraSmooth } from "./brightnessEngine";
import { advancePalette, createPaletteState, type PaletteState } from "./paletteMixer";
import { createIdleState, sendIdleIfNeeded, listenIdleColorChanges, type IdleState } from "./idleManager";
import { createOnsetState, detectOnset, getOnsetBoost, resizeOnsetBuffer, type OnsetState } from "./onsetDetector";

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
  paletteIndex: number;
  /** Pipeline timing in ms */
  timings: { rmsMs: number; smoothMs: number; bleCallMs: number; totalTickMs: number };
}

export type TickCallback = (data: TickData) => void;

export const DEFAULT_TICK_MS = 125;


export class LightEngine {
  // --- State ---
  private color: [number, number, number] = [255, 80, 0];
  private palette: [number, number, number][] = [];
  private paletteState: PaletteState = createPaletteState();
  private volume: number | undefined;
  private playing = true;
  private chars = new Set<BluetoothRemoteGATTCharacteristic>();
  private tickMs = DEFAULT_TICK_MS;

  // --- Internal ---
  private analyser: AnalyserNode | null = null;
  private freqBuf: Float32Array<ArrayBuffer> | null = null;
  private smoothed = 0;
  private smoothedBass = 0;
  private smoothedMidHi = 0;
  private dynamicCenter = 0.5;
  private agc: AgcState;
  private cal: LightCalibration;
  private volumeTable: AgcVolumeTable;
  private lastBaseColor: [number, number, number] = [0, 0, 0];
  private lastBucket: number = 0;
  private extraSmoothPct = 0;
  private lastTickData: TickData | null = null;
  // Onset detection (replaces smoothedFlux)
  private onset: OnsetState;

  private idle: IdleState;

  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private hiShelf: BiquadFilterNode | null = null;
  private agcSaveTimer = 0;
  private stopped = false;
  private tickCallbacks: TickCallback[] = [];
  private idleCleanup: (() => void) | null = null;
  private calCleanup: (() => void) | null = null;

  constructor() {
    this.cal = getCalibration();
    this.volumeTable = { ...this.cal.agcVolumeTable };
    this.agc = createAgcState(0.01);
    this.idle = createIdleState();
    this.onset = createOnsetState();
  }

  /** Register a tick callback. Returns unsubscribe function. */
  onTick(cb: TickCallback): () => void {
    this.tickCallbacks.push(cb);
    return () => { this.tickCallbacks = this.tickCallbacks.filter(c => c !== cb); };
  }

  setColor(rgb: [number, number, number]) { this.color = rgb; }
  setPalette(colors: [number, number, number][]) { this.palette = colors; }
  setVolume(vol: number | undefined) { this.volume = vol; }
  setTickMs(ms: number) { this.tickMs = ms; resizeOnsetBuffer(this.onset, ms); this.worker?.postMessage(ms); }

  setPlaying(playing: boolean) {
    this.playing = playing;

    if (playing) {
      this.idle.idleSent = false;
      if (this.worker) this.worker.postMessage('start');
      return;
    }

    this.worker?.postMessage('stop');

    if (this.chars.size > 0) {
      const calibrated = applyColorCalibration(...this.idle.idleColor, this.cal);
      sendToBLE(calibrated[0], calibrated[1], calibrated[2], 100);
    }

    if (!this.idle.idleSent) {
      this.idle.idleSent = sendIdleIfNeeded(this.idle, this.cal, this.chars.size > 0, d => this.emit(d));
    }
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

  /** Reset smoothing state (e.g. on manual recalibration). AGC table persists. */
  resetSmoothing(): void {
    this.smoothed = 0;
    this.smoothedBass = 0;
    this.smoothedMidHi = 0;
    this.dynamicCenter = 0.5;
    this.extraSmoothPct = 0;
    this.onset = createOnsetState(this.tickMs);
    resetFluxState();
    const bucket = volumeToBucket(this.volume);
    const floor = getFloorForVolume(this.volumeTable, bucket);
    this.agc = createAgcState(floor);
    this.lastBucket = bucket;
  }

  /** Initialize mic, audio pipeline, and start the tick loop.
   *  Safe to call multiple times — stops previous instance first. */
  async start(): Promise<void> {
    if (this.worker || this.stream) this.stop();
    this.stopped = false;

    // Listen for calibration changes
    const reloadCal = () => {
      this.cal = getCalibration();
      if (this.hiShelf) this.hiShelf.gain.value = 6;
    };
    const onStorage = (e: StorageEvent) => { if (e.key === 'light-calibration') reloadCal(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('calibration-changed', reloadCal);
    this.calCleanup = () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('calibration-changed', reloadCal);
    };

    // Listen for idle color changes
    this.idleCleanup = listenIdleColorChanges(this.idle);

    // Set initial AGC floor from volume table
    const bucket = volumeToBucket(this.volume);
    const floor = getFloorForVolume(this.volumeTable, bucket);
    this.agc = createAgcState(floor);
    this.lastBucket = bucket;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      if (this.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;

      const audioCtx = new AudioContext({ latencyHint: 'interactive' });
      this.audioCtx = audioCtx;
      const { debugData } = await import('@/lib/ui/debugStore');
      debugData.micBufferMs = Math.round((audioCtx.baseLatency ?? 0) * 1000);
      const source = audioCtx.createMediaStreamSource(stream);

      const hiShelf = audioCtx.createBiquadFilter();
      hiShelf.type = 'highshelf';
      hiShelf.frequency.value = 2000;
      hiShelf.gain.value = 6;
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

      worker.onmessage = () => { this.tick(); };

      // Save volume table periodically
      this.agcSaveTimer = window.setInterval(() => {
        if (this.stopped) return;
        const updated = { ...this.cal, agcVolumeTable: { ...this.volumeTable } };
        this.cal = updated;
        saveCalibration(updated, getActiveDeviceName() ?? undefined, { localOnly: true });
      }, 10_000);

      worker.postMessage(this.tickMs);
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
    this.palette = [];
    this.paletteState = createPaletteState();
    this.volume = undefined;
    this.playing = true;
    this.chars.clear();
    this.smoothed = 0;
    this.smoothedBass = 0;
    this.smoothedMidHi = 0;
    this.dynamicCenter = 0.5;
    this.extraSmoothPct = 0;
    this.onset = createOnsetState();
    this.agc = createAgcState(0.01);
    this.volumeTable = {};
    this.lastBaseColor = [0, 0, 0];
    this.lastBucket = 0;
    this.idle = createIdleState();
    this.lastTickData = null;
  }

  /** Core tick — called by worker */
  private async tick(): Promise<void> {
    if (this.stopped) return;

    // ── Idle mode ──
    if (!this.playing) {
      if (!this.idle.idleSent) {
        this.idle.idleSent = sendIdleIfNeeded(this.idle, this.cal, this.chars.size > 0, d => this.emit(d));
      }
      this.worker?.postMessage('stop');
      return;
    }
    this.idle.idleSent = false;

    const an = this.analyser;
    if (!an || !this.freqBuf) return;

    const tickStart = performance.now();
    const cal = this.cal;
    const agc = this.agc;

    // ── FFT ──
    const bands = computeBands(an, this.freqBuf);
    const rmsEnd = performance.now();

    // ── Smoothing ──
    this.smoothed = smooth(this.smoothed, bands.totalRms, cal.attackAlpha, cal.releaseAlpha, this.tickMs);

    // ── Volume bucket & AGC update ──
    const bucket = volumeToBucket(this.volume);
    if (bucket !== this.lastBucket) {
      const floor = getFloorForVolume(this.volumeTable, bucket);
      if (floor > agc.max) agc.max = floor;
      this.lastBucket = bucket;
    }
    updateRunningMax(agc, this.smoothed, bands.bassRms, bands.midHiRms, this.tickMs);
    updateVolumeTable(this.volumeTable, bucket, this.smoothed);

    // Normalize bands
    const rawBassNorm = normalizeBand(bands.bassRms, agc, 'bass');
    const rawMidHiNorm = normalizeBand(bands.midHiRms, agc, 'midHi');
    const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;
    const rawEnergyPct = Math.round(rawEnergy * 100);

    // ── Per-band smoothing ──
    this.smoothedBass = smooth(this.smoothedBass, rawBassNorm, cal.attackAlpha, cal.releaseAlpha, this.tickMs);
    this.smoothedMidHi = smooth(this.smoothedMidHi, rawMidHiNorm, cal.attackAlpha, cal.releaseAlpha, this.tickMs);

    // ── Onset detection (peak-picking on spectral flux) ──
    detectOnset(this.onset, bands.flux, this.tickMs);
    const fluxBoost = (cal.transientBoost !== false) ? getOnsetBoost(this.onset) : 0;

    // ── Brightness ──
    let { pct, newCenter } = computeBrightnessPct(
      this.smoothedBass, this.smoothedMidHi,
      100, this.dynamicCenter, cal,
      fluxBoost, this.tickMs,
    );
    this.dynamicCenter = newCenter;

    // ── Extra smoothing ──
    const sm = cal.smoothing ?? 0;
    if (sm > 0) {
      this.extraSmoothPct = extraSmooth(this.extraSmoothPct, pct, sm, this.tickMs);
      pct = this.extraSmoothPct;
    }
    pct = Math.round(pct);

    // ── Palette mode ──
    const pm = cal.paletteMode ?? 'off';
    const paletteResult = advancePalette(
      this.palette, this.paletteState, pm, cal,
      this.smoothedBass, rawEnergy, this.tickMs,
    );
    if (paletteResult) {
      this.color = paletteResult.color;
      this.paletteState = paletteResult.state;
    }

    // ── Resolve colors ──
    const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;
    const finalColor = applyColorCalibration(...this.color, cal);
    const bleSentR = finalColor[0], bleSentG = finalColor[1], bleSentB = finalColor[2];
    this.lastBaseColor = [bleSentR, bleSentG, bleSentB];

    // ── BLE output ──
    const smoothEnd = performance.now();
    if (this.chars.size > 0) {
      if (isPunch) sendToBLE(255, 255, 255, pct);
      else sendToBLE(bleSentR, bleSentG, bleSentB, pct);
    }
    const bleEnd = performance.now();

    // ── Emit tick data ──
    const tickData: TickData = {
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
      paletteIndex: this.paletteState.index,
      timings: {
        rmsMs: rmsEnd - tickStart,
        smoothMs: smoothEnd - rmsEnd,
        bleCallMs: bleEnd - smoothEnd,
        totalTickMs: bleEnd - tickStart,
      },
    };
    this.lastTickData = tickData;
    this.emit(tickData);
  }

  private emit(data: TickData) {
    for (const cb of this.tickCallbacks) cb(data);
  }
}
