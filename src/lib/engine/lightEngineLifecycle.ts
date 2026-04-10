/**
 * LightEngine — lifecycle management (start/stop/destroy).
 * Handles mic acquisition, audio graph setup, worker, and cleanup.
 */

import { getCalibration, saveCalibration, getActiveDeviceName } from "./lightCalibration";
import { volumeToBucket, getFloorForVolume, createAgcState } from "./agc";
import { listenIdleColorChanges } from "./idleManager";
import { resetEngineState, refreshTickConstants, type EngineState } from "./lightEngineState";
import { runTick } from "./lightEngineTickPipeline";

/** Initialize mic, audio pipeline, and start the tick loop.
 *  Safe to call multiple times — stops previous instance first. */
export async function startEngine(s: EngineState): Promise<void> {
  if (s.worker || s.stream) stopEngine(s);
  s.stopped = false;

  // Listen for calibration changes
  const reloadCal = () => {
    s.cal = getCalibration();
    refreshTickConstants(s);
    if (s.hiShelf) s.hiShelf.gain.value = 6;
  };
  const onStorage = (e: StorageEvent) => { if (e.key === 'light-calibration') reloadCal(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener('calibration-changed', reloadCal);
  s.calCleanup = () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('calibration-changed', reloadCal);
  };

  // Listen for idle color changes
  s.idleCleanup = listenIdleColorChanges(s.idle);

  // Set initial AGC floor from volume table
  const bucket = volumeToBucket(s.volume);
  const floor = getFloorForVolume(s.volumeTable, bucket);
  s.agc = createAgcState(floor);
  s.lastBucket = bucket;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    if (s.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
    s.stream = stream;

    const audioCtx = new AudioContext({ latencyHint: 'interactive' });
    s.audioCtx = audioCtx;
    const { debugData } = await import('@/lib/ui/debugStore');
    debugData.micBufferMs = Math.round((audioCtx.baseLatency ?? 0) * 1000);
    const source = audioCtx.createMediaStreamSource(stream);

    const hiShelf = audioCtx.createBiquadFilter();
    hiShelf.type = 'highshelf';
    hiShelf.frequency.value = 2000;
    hiShelf.gain.value = 6;
    s.hiShelf = hiShelf;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0;
    source.connect(hiShelf);
    hiShelf.connect(analyser);
    s.analyser = analyser;
    s.freqBuf = new Float32Array(analyser.frequencyBinCount);

    const worker = new Worker("/tick-worker.js");
    s.worker = worker;

    worker.onmessage = () => { runTick(s); };

    // Save volume table periodically
    s.agcSaveTimer = window.setInterval(() => {
      if (s.stopped) return;
      const updated = { ...s.cal, agcVolumeTable: { ...s.volumeTable } };
      s.cal = updated;
      saveCalibration(updated, getActiveDeviceName() ?? undefined, { localOnly: true });
    }, 10_000);

    worker.postMessage(s.tickMs);
    worker.postMessage("start");
  } catch (e) {
    console.error("[LightEngine] mic init failed", e);
  }
}

/** Stop everything and release resources. */
export function stopEngine(s: EngineState): void {
  s.stopped = true;
  s.idleCleanup?.();
  s.calCleanup?.();
  s.idleCleanup = null;
  s.calCleanup = null;
  if (s.agcSaveTimer) { clearInterval(s.agcSaveTimer); s.agcSaveTimer = 0; }
  s.worker?.postMessage("stop");
  s.worker?.terminate();
  s.worker = null;
  s.stream?.getTracks().forEach(t => t.stop());
  s.stream = null;
  s.audioCtx?.close().catch(() => {});
  s.audioCtx = null;
  s.analyser = null;
  s.freqBuf = null;
  s.hiShelf = null;
}

/** Full teardown — stop + reset all state. Instance is unusable after this. */
export function destroyEngine(s: EngineState): void {
  stopEngine(s);
  resetEngineState(s);
}
