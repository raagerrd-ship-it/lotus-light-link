/**
 * LightEngine — framework-agnostic real-time audio→light pipeline.
 *
 * Thin orchestrator class that delegates to:
 *  - lightEngineState.ts     (state shape + factory)
 *  - lightEngineTickPipeline.ts (per-tick processing)
 *  - lightEngineLifecycle.ts (start/stop/destroy)
 */

import { addActiveChar, removeActiveChar, type DeviceMode } from "./bledom";
import { applyColorCalibration } from "./lightCalibration";
import { sendToBLE } from "./bledom";
import { sendIdleIfNeeded } from "./idleManager";
import { resizeOnsetBuffer } from "./onsetDetector";
import { createEngineState, refreshTickConstants, type EngineState, type TickCallback } from "./lightEngineState";
import { resetSmoothing as resetSmoothingFn, emitTick } from "./lightEngineTickPipeline";
import { startEngine, stopEngine, destroyEngine } from "./lightEngineLifecycle";

// Re-export public types from state module
export { DEFAULT_TICK_MS, type TickData, type TickCallback } from "./lightEngineState";

export class LightEngine {
  private s: EngineState;

  constructor() {
    this.s = createEngineState();
  }

  /** Register a tick callback. Returns unsubscribe function. */
  onTick(cb: TickCallback): () => void {
    this.s.tickCallbacks.push(cb);
    return () => { this.s.tickCallbacks = this.s.tickCallbacks.filter(c => c !== cb); };
  }

  setColor(rgb: [number, number, number]) { this.s.color = rgb; }
  setPalette(colors: [number, number, number][]) { this.s.palette = colors; }
  setVolume(vol: number | undefined) { this.s.volume = vol; }

  setTickMs(ms: number) {
    this.s.tickMs = ms;
    resizeOnsetBuffer(this.s.onset, ms);
    refreshTickConstants(this.s);
    this.s.worker?.postMessage(ms);
  }

  setPlaying(playing: boolean) {
    this.s.playing = playing;

    if (playing) {
      this.s.idle.idleSent = false;
      if (this.s.worker) this.s.worker.postMessage('start');
      return;
    }

    this.s.worker?.postMessage('stop');

    if (this.s.chars.size > 0) {
      const calibrated = applyColorCalibration(...this.s.idle.idleColor, this.s.cal);
      sendToBLE(calibrated[0], calibrated[1], calibrated[2], 100);
    }

    if (!this.s.idle.idleSent) {
      this.s.idle.idleSent = sendIdleIfNeeded(this.s.idle, this.s.cal, this.s.chars.size > 0, d => emitTick(this.s, d));
    }
  }

  /** @deprecated Use addChar/removeChar for multi-device */
  setChar(char: BluetoothRemoteGATTCharacteristic | null) {
    if (char) this.addChar(char);
  }

  addChar(char: BluetoothRemoteGATTCharacteristic, mode: DeviceMode = 'rgb') {
    this.s.chars.add(char);
    addActiveChar(char, mode);
  }

  removeChar(char: BluetoothRemoteGATTCharacteristic) {
    this.s.chars.delete(char);
    removeActiveChar(char);
  }

  hasChars(): boolean {
    return this.s.chars.size > 0;
  }

  /** Reset smoothing state (e.g. on manual recalibration). AGC table persists. */
  resetSmoothing(): void {
    resetSmoothingFn(this.s);
  }

  /** Initialize mic, audio pipeline, and start the tick loop. */
  async start(): Promise<void> {
    return startEngine(this.s);
  }

  /** Stop everything and release resources. */
  stop(): void {
    stopEngine(this.s);
  }

  /** Full teardown — stop + reset all state. Instance is unusable after this. */
  destroy(): void {
    destroyEngine(this.s);
  }
}
