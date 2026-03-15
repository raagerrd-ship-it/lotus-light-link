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
  baseR?: number;  // base color before brightness pre-multiplication
  baseG?: number;
  baseB?: number;
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
  const lineWidth = Math.max(1.5, Math.min(step * 0.6, 3));

  // Resolve base color for line (un-brightness-compensated)
  const lastSample = samples[len - 1];
  const baseR = lastSample.baseR ?? lastSample.r;
  const baseG = lastSample.baseG ?? lastSample.g;
  const baseB = lastSample.baseB ?? lastSample.b;
  const lineColor = `rgb(${baseR}, ${baseG}, ${baseB})`;

  // Build path points
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < len; i++) {
    points.push({
      x: offsetX + i * step,
      y: yForPct(samples[i].pct),
    });
  }

  // Fill under line: gradient with base color, 100% at top → 0% at bottom
  if (points.length >= 2) {
    const bottom = chartTop + chartHeight;
    const fillGrad = ctx.createLinearGradient(0, chartTop, 0, bottom);
    fillGrad.addColorStop(0, `rgba(${baseR}, ${baseG}, ${baseB}, 0.5)`);
    fillGrad.addColorStop(1, `rgba(${baseR}, ${baseG}, ${baseB}, 0)`);

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

  // Main line (base color, no dots)
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.globalAlpha = 1;
}
