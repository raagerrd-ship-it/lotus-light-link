import { liftColor } from "./colorUtils";

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
  globalBrightness: number = 1, // 0-1, fades entire chart opacity
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const len = samples.length;
  const threshold = 85;

  const chartHeight = h * 0.95;
  const chartTop = (h - chartHeight) / 2;
  const yThresh = chartTop + chartHeight - (threshold / 100) * chartHeight;

  ctx.clearRect(0, 0, w, h);

  // Apply global brightness as canvas opacity multiplier
  const gb = Math.max(0, Math.min(1, globalBrightness));
  ctx.globalAlpha = 0.15 + gb * 0.85; // floor at 15% so chart never fully vanishes
  const totalFrames = historyLen;

  if (len <= 1) return;

  // Decaying peak-hold normalization: preserves dynamics across sections
  let maxPct = 0;
  for (let i = 0; i < len; i++) {
    if (samples[i].pct > maxPct) maxPct = samples[i].pct;
  }
  heldMax = Math.max(heldMax * 0.997, maxPct, 30);
  const scale = heldMax > 5 ? 100 / heldMax : 1;

  const step = w / (totalFrames - 1);
  const offsetX = (historyLen - len) * step;

  // Draw each sample as a dot at its BLE brightness, in its BLE color
  const dotRadius = Math.max(1.5, step * 0.45);

  for (let i = 0; i < len; i++) {
    const x = offsetX + i * step;
    const s = samples[i];
    const p = Math.min(100, s.pct * scale);
    const y = chartTop + chartHeight - (p / 100) * chartHeight;
    const { r: cr, g: cg, b: cb } = s;

    // Vertical fill from bottom to dot (subtle glow)
    const brightFactor = Math.max(0.1, p / 100);
    const [lr, lg, lb] = liftColor([cr, cg, cb], brightFactor * 0.5);
    const grad = ctx.createLinearGradient(x, y, x, chartTop + chartHeight);
    grad.addColorStop(0, `rgba(${lr}, ${lg}, ${lb}, ${0.08 + brightFactor * 0.18})`);
    grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0.01)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x - step * 0.4, y, step * 0.8, chartTop + chartHeight - y);

    // Connecting line to previous sample
    if (i > 0) {
      const prevS = samples[i - 1];
      const prevP = Math.min(100, prevS.pct * scale);
      const prevX = offsetX + (i - 1) * step;
      const prevY = chartTop + chartHeight - (prevP / 100) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(x, y);
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.2 + brightFactor * 0.3})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // The dot — exact BLE color, size proportional to brightness
    const radius = dotRadius * (0.6 + brightFactor * 0.6);

    // Punch-white: if above threshold, dot goes white
    const isPunch = punchWhite && s.pct > threshold;
    if (isPunch) {
      const whiteT = Math.min(1, (s.pct - threshold) / (100 - threshold));
      const wr = Math.round(cr + (255 - cr) * whiteT);
      const wg = Math.round(cg + (255 - cg) * whiteT);
      const wb = Math.round(cb + (255 - cb) * whiteT);
      ctx.beginPath();
      ctx.arc(x, y, radius * 1.3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${wr}, ${wg}, ${wb}, ${0.7 + whiteT * 0.3})`;
      ctx.fill();
      // Glow
      ctx.beginPath();
      ctx.arc(x, y, radius * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + whiteT * 0.15})`;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${0.5 + brightFactor * 0.5})`;
      ctx.fill();
    }

    // Beat marker — slightly brighter ring
    if (s.beat) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${lr}, ${lg}, ${lb}, 0.6)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
