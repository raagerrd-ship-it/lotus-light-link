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
 * pct is clamped to 0–100 to prevent drawing outside the chart area.
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
  ctx.globalAlpha = 1;

  const chartHeight = h * 0.92;
  const chartTop = (h - chartHeight) / 2;
  const step = w / (historyLen - 1);
  const offsetX = (historyLen - len) * step;
  const dotRadius = Math.max(1, Math.min(step * 0.35, 4));
  const lineWidth = Math.max(1, Math.min(dotRadius * 1.5, 3));

  const clampPct = (p: number) => Math.max(0, Math.min(100, p));
  const yForPct = (p: number) => chartTop + chartHeight - (clampPct(p) / 100) * chartHeight;

  // Build path for fill + line
  const points: { x: number; y: number; color: string }[] = [];
  for (let i = 0; i < len; i++) {
    points.push({
      x: offsetX + i * step,
      y: yForPct(samples[i].pct),
      color: `rgb(${samples[i].r}, ${samples[i].g}, ${samples[i].b})`,
    });
  }

  // Fill under line: gradient from line color at top → transparent at bottom
  if (points.length >= 2) {
    const lastSample = samples[len - 1];
    // Find the highest point (min y) to anchor gradient from data, not chart top
    const minY = Math.min(...points.map(p => p.y));
    const bottom = chartTop + chartHeight;
    const fillGrad = ctx.createLinearGradient(0, minY, 0, bottom);
    fillGrad.addColorStop(0, `rgba(${lastSample.r}, ${lastSample.g}, ${lastSample.b}, 0.45)`);
    fillGrad.addColorStop(1, `rgba(0, 0, 0, 0)`);

    ctx.beginPath();
    ctx.moveTo(points[0].x, bottom);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[points.length - 1].x, bottom);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();
  }

  // Line + dots
  for (let i = 0; i < points.length; i++) {
    const { x, y, color } = points[i];

    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(x, y);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

/**
 * Draw sync diagnostic chart: two overlaid lines (mic = orange, curve = green).
 * Both arrays hold brightness % values (0–100).
 */
export function drawSyncChart(
  canvas: HTMLCanvasElement,
  micHistory: number[],
  curveHistory: number[],
  historyLen: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const chartHeight = h * 0.88;
  const chartTop = (h - chartHeight) / 2;
  const step = w / (historyLen - 1);

  const yForPct = (p: number) => chartTop + chartHeight - (Math.max(0, Math.min(100, p)) / 100) * chartHeight;

  const drawLine = (data: number[], color: string, lw: number) => {
    if (data.length < 2) return;
    const offsetX = (historyLen - data.length) * step;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < data.length; i++) {
      const x = offsetX + i * step;
      const y = yForPct(data[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  // Curve first (behind), then mic on top
  drawLine(curveHistory, '#22c55e', 2.5); // green
  drawLine(micHistory, '#f97316', 2);     // orange

  // Labels
  ctx.globalAlpha = 0.7;
  ctx.font = `${Math.max(10, h * 0.04)}px monospace`;
  ctx.fillStyle = '#22c55e';
  ctx.fillText('kurva', 6, chartTop + 14);
  ctx.fillStyle = '#f97316';
  ctx.fillText('mic', 6, chartTop + 28);

  ctx.globalAlpha = 1;
}

/**
 * Simple cross-correlation: find the shift (in samples) that best aligns
 * micHistory to curveHistory. Returns offset in samples (positive = mic is behind).
 * Searches ±maxShift samples.
 */
export function crossCorrelate(
  mic: number[],
  curve: number[],
  maxShift: number = 30,
): number {
  const len = Math.min(mic.length, curve.length);
  if (len < 10) return 0;

  // Use last `len` samples of each
  const m = mic.slice(-len);
  const c = curve.slice(-len);

  let bestShift = 0;
  let bestScore = -Infinity;

  for (let shift = -maxShift; shift <= maxShift; shift++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < len; i++) {
      const ci = i + shift;
      if (ci < 0 || ci >= len) continue;
      sum += m[i] * c[ci];
      count++;
    }
    const score = count > 0 ? sum / count : 0;
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }

  return bestShift;
}
