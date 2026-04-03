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
  rawPct?: number; // raw energy before brightness mapping (0-100)
  baseR?: number;  // base color before brightness pre-multiplication
  baseG?: number;
  baseB?: number;
}

// Pre-allocated point buffers to avoid GC pressure at 60fps
const MAX_POINTS = 300;
const pxBuf = new Float64Array(MAX_POINTS); // x coords
const pyBuf = new Float64Array(MAX_POINTS); // y coords
const DASH_PATTERN = [3, 3]; // reuse across frames

/**
 * Draw the intensity chart with smooth sub-sample scrolling.
 * scrollFraction (0–1) = how far we've progressed toward the next sample slot.
 */
export function drawIntensityChart(
  canvas: HTMLCanvasElement,
  samples: ChartSample[],
  historyLen: number,
  scrollFraction: number = 0,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const len = samples.length;
  if (len <= 1) { ctx.clearRect(0, 0, w, h); return; }

  const chartTop = 0;
  const chartHeight = h;
  const bottom = h;
  const scale = chartHeight / 100;

  ctx.clearRect(0, 0, w, h);

  // Grid lines at 0%, 25%, 50%, 75%, 100%
  ctx.lineWidth = 1;
  for (let level = 0; level <= 100; level += 25) {
    const y = bottom - Math.max(0, Math.min(100, level)) * scale;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.strokeStyle = level === 0 || level === 100 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.07)';
    ctx.stroke();
  }

  const step = w / (historyLen - 1);
  const scroll = scrollFraction * step;
  const offsetX = (historyLen - len) * step - scroll;
  const lineWidth = Math.max(1.5, Math.min(step * 0.6, 3));

  // Build point coords into pre-allocated buffers
  for (let i = 0; i < len; i++) {
    pxBuf[i] = offsetX + i * step;
    pyBuf[i] = bottom - Math.max(0, Math.min(100, samples[i].pct)) * scale;
  }

  // Resolve base color for line (un-brightness-compensated)
  const last = samples[len - 1];
  const baseR = last.baseR ?? last.r;
  const baseG = last.baseG ?? last.g;
  const baseB = last.baseB ?? last.b;

  // Fill under line: gradient with base color
  const fillGrad = ctx.createLinearGradient(0, chartTop, 0, bottom);
  fillGrad.addColorStop(0, `rgba(${baseR},${baseG},${baseB},1)`);
  fillGrad.addColorStop(1, `rgba(${baseR},${baseG},${baseB},0)`);

  ctx.beginPath();
  ctx.moveTo(pxBuf[0], bottom);
  for (let i = 0; i < len; i++) ctx.lineTo(pxBuf[i], pyBuf[i]);
  ctx.lineTo(pxBuf[len - 1], bottom);
  ctx.closePath();
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Raw RMS dashed line (check first sample only — if one has it, all do)
  if (samples[0].rawPct != null) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.setLineDash(DASH_PATTERN);
    ctx.lineWidth = Math.max(1, lineWidth * 0.8);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    const y0 = bottom - Math.max(0, Math.min(100, samples[0].rawPct!)) * scale;
    ctx.moveTo(pxBuf[0], y0);
    for (let i = 1; i < len; i++) {
      const raw = samples[i].rawPct;
      if (raw == null) continue;
      ctx.lineTo(pxBuf[i], bottom - Math.max(0, Math.min(100, raw)) * scale);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Main line
  ctx.beginPath();
  ctx.moveTo(pxBuf[0], pyBuf[0]);
  for (let i = 1; i < len; i++) ctx.lineTo(pxBuf[i], pyBuf[i]);
  ctx.strokeStyle = `rgb(${baseR},${baseG},${baseB})`;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}
