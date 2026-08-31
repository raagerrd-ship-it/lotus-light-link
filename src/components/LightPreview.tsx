import { useEffect, useRef } from "react";

/**
 * Live-simulering av ljusomvandlingen — visar hur reglagen påverkar utsignalen.
 * Speglar piEngine.tickInner: onsetTarget 0.45 på slaget, målet HÅLLS i
 * ceil(onsetRiseMs × onsetRiseHoldK / FRAME_MS) ramar medan boosten klättrar
 * (RISE_HOLD), därefter decayar både mål och boost exponentiellt med
 * tau = clamp(fadeTauMin, fadeTauMax, fadeIntervalK × beatMs). Pulsen modulerar
 * taket med beatDepth, golvet läggs sist.
 */
const FRAME_MS = (128 * 7 / 48000) * 1000;   // ANALYSER_HOP × BAND_EVERY_HOPS
const BEAT_MS = 500;                         // 120 BPM referens
const ONSET_PEAK = 0.45;
const RISE_MS = 40, HOLD_K = 2.0;            // = motorns DEFAULT_CAL


export function LightPreview({
  brightnessFloor, beatDepth, fadeIntervalK,
}: {
  brightnessFloor: number;
  beatDepth: number;
  fadeIntervalK: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const params = useRef({ brightnessFloor, beatDepth, fadeIntervalK });
  params.current = { brightnessFloor, beatDepth, fadeIntervalK };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Canvas 2D förstår inte CSS-variabler — läs ut tokens som konkreta hsl-värden.
    const root = getComputedStyle(document.documentElement);
    const primary = root.getPropertyValue("--primary").trim() || "342 100% 61%";
    const muted = root.getPropertyValue("--muted-foreground").trim() || "0 0% 60%";
    const col = (tok: string, a = 1) => {
      const [hue, sat, light] = tok.split(/\s+/);
      return `hsla(${hue}, ${sat}, ${light}, ${a})`;
    };

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0;
    const resize = () => {
      w = canvas.clientWidth || 240;
      h = canvas.clientHeight || 56;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const N = 140;
    const hist = new Float32Array(N);
    const raw = new Float32Array(N);
    let onsetBoost = 0;
    let lastBeat = -1;
    let raf = 0;
    const t0 = performance.now();

    const tick = () => {
      const p = params.current;
      const t = performance.now() - t0;

      // Slaget: onsetTarget sätts till 0.45 med instant attack, sedan exponentiell
      // release med samma tau-formel som motorn.
      const beatIdx = Math.floor(t / BEAT_MS);
      if (beatIdx !== lastBeat) { lastBeat = beatIdx; onsetBoost = ONSET_PEAK; }
      const tau = Math.max(0.12, Math.min(1.2, p.fadeIntervalK * (BEAT_MS / 1000)));
      onsetBoost *= Math.exp(-(FRAME_MS / 1000) / tau);
      const pn = Math.min(1, onsetBoost / ONSET_PEAK);

      // Taket är den långsamma loudness-envelopen (sektionsdynamik).
      const ceil = Math.min(1, Math.max(0, 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(t / 6200 - 1.2))));
      const depth = p.beatDepth;
      const energyForm = ceil * ((1 - depth) + depth * pn);

      const floor = p.brightnessFloor / 100;
      let out = floor + energyForm * (1 - floor);
      out = out <= 0 ? 0 : out >= 1 ? 1 : out;

      hist.copyWithin(0, 1); hist[N - 1] = out;
      raw.copyWithin(0, 1); raw[N - 1] = ceil;

      ctx.clearRect(0, 0, w, h);

      // Golvlinje
      const floorY = h - 2 - (h - 6) * floor;
      ctx.strokeStyle = col(muted, 0.35);
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, floorY); ctx.lineTo(w, floorY); ctx.stroke();
      ctx.setLineDash([]);

      // Taket (svag)
      ctx.strokeStyle = col(muted, 0.5);
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const px = (i / (N - 1)) * w, py = h - 2 - (h - 6) * raw[i];
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();

      // Utsignal (fylld)
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, col(primary, 0.45));
      grad.addColorStop(1, col(primary, 0.02));
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < N; i++) {
        ctx.lineTo((i / (N - 1)) * w, h - 2 - (h - 6) * hist[i]);
      }
      ctx.lineTo(w, h); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();

      ctx.strokeStyle = col(primary);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const px = (i / (N - 1)) * w, py = h - 2 - (h - 6) * hist[i];
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();

      if (orbRef.current) {
        orbRef.current.style.opacity = String(0.15 + out * 0.85);
        orbRef.current.style.transform = `scale(${0.82 + out * 0.28})`;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-border p-2.5 overflow-hidden">
      <div className="flex items-center gap-3">
        <div className="relative w-10 h-10 shrink-0 flex items-center justify-center">
          <div
            ref={orbRef}
            className="w-8 h-8 rounded-full bg-primary shadow-[0_0_22px_hsl(var(--primary)/0.7)]"
          />
        </div>
        <canvas ref={canvasRef} className="h-14 flex-1 min-w-0 block" />
      </div>
      <p className="mt-1.5 text-[9px] uppercase tracking-[0.18em] text-muted-foreground/50">
        Simulerat slag (120 BPM) · grå = tak, rosa = lampan
      </p>
    </div>
  );
}
