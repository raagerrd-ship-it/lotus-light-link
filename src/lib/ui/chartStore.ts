import type { ChartSample } from "./drawChart";

/**
 * Zero-allocation ring buffer for chart samples.
 * Single source of truth — written by MicPanel tick, read by drawChart & CalibrationOverlay.
 */
const MAX_LEN = 96; // ~12s at 8Hz
const slots: (ChartSample | null)[] = new Array(MAX_LEN).fill(null);
let cursor = 0;
let count = 0;

export function pushChartSample(s: ChartSample) {
  slots[cursor] = s;
  cursor = (cursor + 1) % MAX_LEN;
  if (count < MAX_LEN) count++;
}

/** Return samples in chronological order (oldest → newest). Reuses a module-level array. */
const outBuf: ChartSample[] = [];

export function getChartSamples(maxLen?: number): ChartSample[] {
  const len = Math.min(count, maxLen ?? count);
  outBuf.length = len;
  const start = (cursor - len + MAX_LEN) % MAX_LEN;
  for (let i = 0; i < len; i++) {
    outBuf[i] = slots[(start + i) % MAX_LEN] as ChartSample;
  }
  return outBuf;
}

export function clearChartSamples() {
  cursor = 0;
  count = 0;
  // No need to null-out slots — count guards reads
}
