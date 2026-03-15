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
  rawPct?: number; // raw energy before brightness mapping (0-100)
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
  if (len <= 1) { ctx.clearRect(0, 0, w, h); }

  const chartHeight = h * 0.92;
  const chartTop = (h - chartHeight) / 2;

  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = 1;

  // Grid lines at 0%, 25%, 50%, 75%, 100%
  const gridLevels = [0, 25, 50, 75, 100];
  const clampPct = (p: number) => Math.max(0, Math.min(100, p));
  const yForPct = (p: number) => chartTop + chartHeight - (clampPct(p) / 100) * chartHeight;

  ctx.save();
  for (const level of gridLevels) {
    const y = yForPct(level);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.strokeStyle = level === 0 || level === 100 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();

  if (len <= 1) return;
  const step = w / (historyLen - 1);
  const offsetX = (historyLen - len) * step;
  const dotRadius = Math.max(1, Math.min(step * 0.35, 4));
  const lineWidth = Math.max(1, Math.min(dotRadius * 1.5, 3));

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

  // Raw RMS line (behind the main line)
  const hasRaw = samples.some(s => s.rawPct != null);
  if (hasRaw) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = Math.max(1, lineWidth * 0.8);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < len; i++) {
      const s = samples[i];
      if (s.rawPct == null) continue;
      const x = offsetX + i * step;
      const y = yForPct(s.rawPct);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Line + dots (output brightness)
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
