import type { ChartSample } from "./drawChart";

/** Shared chart samples — written by MicPanel, read by CalibrationOverlay */
let samples: ChartSample[] = [];
const MAX_LEN = 200;

export function pushChartSample(s: ChartSample) {
  samples.push(s);
  if (samples.length > MAX_LEN) samples = samples.slice(-MAX_LEN);
}

export function getChartSamples(): ChartSample[] {
  return samples;
}

export function clearChartSamples() {
  samples = [];
}
