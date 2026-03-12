import { liftColor } from "./colorUtils";

export interface ChartSample {
  pct: number;
  r: number;
  g: number;
  b: number;
  beat?: boolean;
}

/**
 * Draw the intensity chart inside the circular canvas.
 * Extracted from MicPanel to keep DSP logic separate from rendering.
 */
export function drawIntensityChart(
  canvas: HTMLCanvasElement,
  samples: ChartSample[],
  historyLen: number,
  framesPerBeat: number,
  bpm: number,
  punchWhite: boolean,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const len = samples.length;
  const threshold = 85;

  const chartHeight = h * 0.7;
  const chartTop = (h - chartHeight) / 2;
  const yThresh = chartTop + chartHeight - (threshold / 100) * chartHeight;

  ctx.clearRect(0, 0, w, h);

  const totalFrames = historyLen;

  if (len <= 1) return;

  const step = w / (totalFrames - 1);
  const offsetX = (historyLen - len) * step;

  for (let i = 1; i < len; i++) {
    const x0 = offsetX + (i - 1) * step;
    const x1 = offsetX + i * step;
    const s0 = samples[i - 1];
    const s1 = samples[i];
    const y0 = chartTop + chartHeight - (s0.pct / 100) * chartHeight;
    const y1 = chartTop + chartHeight - (s1.pct / 100) * chartHeight;
    const chartBottom = chartTop + chartHeight;
    const { r: cr, g: cg, b: cb } = s1;
    const avgPct = (s0.pct + s1.pct) / 2;
    const brightFactor = Math.max(0.15, avgPct / 100);
    const lift = brightFactor * 0.6;
    const [lr, lg, lb] = liftColor([cr, cg, cb], lift);

    // Fill gradient
    const grad = ctx.createLinearGradient(x0, y1, x0, chartBottom);
    grad.addColorStop(0, `rgba(${lr}, ${lg}, ${lb}, ${0.15 + brightFactor * 0.4})`);
    grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0.03)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x0, chartBottom);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1, chartBottom);
    ctx.closePath();
    ctx.fill();

    // White punch above threshold
    if (punchWhite && (s0.pct > threshold || s1.pct > threshold)) {
      const clipY0 = Math.min(y0, yThresh);
      const clipY1 = Math.min(y1, yThresh);
      const whiteT = Math.min(1, (avgPct - threshold) / (100 - threshold));
      const fillGrad = ctx.createLinearGradient(0, yThresh, 0, Math.min(clipY0, clipY1));
      fillGrad.addColorStop(0, `rgba(255, 255, 255, 0.05)`);
      fillGrad.addColorStop(1, `rgba(255, 255, 255, ${0.1 + whiteT * 0.4})`);
      ctx.fillStyle = fillGrad;
      ctx.beginPath();
      ctx.moveTo(x0, yThresh);
      ctx.lineTo(x0, clipY0);
      ctx.lineTo(x1, clipY1);
      ctx.lineTo(x1, yThresh);
      ctx.closePath();
      ctx.fill();
    }

    // Line below threshold
    const lineAlpha = 0.4 + brightFactor * 0.6;
    ctx.beginPath();
    ctx.moveTo(x0, Math.max(y0, yThresh));
    ctx.lineTo(x1, Math.max(y1, yThresh));
    ctx.strokeStyle = `rgba(${lr}, ${lg}, ${lb}, ${lineAlpha})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // White line above threshold
    if (punchWhite && (s0.pct > threshold || s1.pct > threshold)) {
      const aboveY0 = Math.min(y0, yThresh);
      const aboveY1 = Math.min(y1, yThresh);
      const whiteT = Math.min(1, (avgPct - threshold) / (100 - threshold));
      ctx.beginPath();
      ctx.moveTo(x0, aboveY0);
      ctx.lineTo(x1, aboveY1);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 + whiteT * 0.6})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }
}
