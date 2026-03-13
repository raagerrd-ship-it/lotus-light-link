// Module-level decaying peak-hold for chart normalization
let heldMax = 30;

/** Reset peak-hold (call on track/color change) */
export function resetChartScaler() {
  heldMax = 30;
}

export interface ChartSample {
  pct: number;
  r: number;
  g: number;
  b: number;
  beat?: boolean;
}

/**
 * Draw the intensity chart — each dot = exact BLE color at exact BLE brightness %.
 */
export function drawIntensityChart(
  canvas: HTMLCanvasElement,
  samples: ChartSample[],
  historyLen: number,
  _framesPerBeat: number,
  _bpm: number,
  _punchWhite: boolean,
  globalBrightness: number = 1,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const len = samples.length;
  if (len <= 1) return;

  ctx.clearRect(0, 0, w, h);
  const gb = Math.max(0, Math.min(1, globalBrightness));
  ctx.globalAlpha = 0.15 + gb * 0.85;

  const chartHeight = h * 0.92;
  const chartTop = (h - chartHeight) / 2;
  const step = w / (historyLen - 1);
  const offsetX = (historyLen - len) * step;
  const dotRadius = Math.max(1.8, step * 0.5);

  for (let i = 0; i < len; i++) {
    const x = offsetX + i * step;
    const s = samples[i];
    // No normalization — raw pct (0–100) maps directly to height
    const y = chartTop + chartHeight - (s.pct / 100) * chartHeight;

    // Dot in exact BLE color
    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${s.r}, ${s.g}, ${s.b})`;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}
