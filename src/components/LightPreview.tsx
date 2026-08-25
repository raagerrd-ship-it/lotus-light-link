import { useEffect, useRef } from "react";

/**
 * Live-simulering av ljusomvandlingen — visar hur reglagen påverkar utsignalen.
 * Ren presentation: ingen kontakt med motorn, ett syntetiskt beat matas genom
 * samma kedja (attack/release → dynamik → golv) som piEngine använder.
 */
export function LightPreview({
  softness, brightnessFloor, beatCutoffHz,
}: {
  softness: number;
  brightnessFloor: number;
  beatCutoffHz: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const params = useRef({ softness, brightnessFloor, beatCutoffHz });
  params.current = { softness, brightnessFloor, beatCutoffHz };

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
    let intensitySm = 0.5;
    let ampEnv = 0.2;
    let raf = 0;
    const t0 = performance.now();
    const BEAT_MS = 500;

    const tick = () => {
      const p = params.current;
      const t = performance.now() - t0;

      // Syntetisk källa: intensity-swell + kick-transient, loudness nästan konstant.
      const phase = t % BEAT_MS;
      const kick = Math.exp(-phase / 90);
      const mid = 0.35 * (0.5 + 0.5 * Math.sin(t / 130)) * Math.exp(-(phase % 250) / 160);
      const melodyMix = Math.min(1, Math.max(0, (p.beatCutoffHz - 60) / 1940));
      let x = (1 - melodyMix * 0.55) * kick + melodyMix * mid;
      const swell = 0.5 + 0.5 * Math.sin(t / 6200 - 1.2);
      const intensity = Math.min(1, Math.max(0, 0.22 + swell * 0.72 + kick * 0.08));

      // Attack direkt, release mjuknar exponentiellt med softness.
      const release = 0.6 * Math.pow(0.04, p.softness / 100);
      intensitySm = intensity > intensitySm ? intensity : intensitySm + (intensity - intensitySm) * release;

      // Dirigent v2: rå nivå skalar loudness långsamt; intensity bär formen.
      const amp = Math.min(1, 0.14 + 0.04 * Math.sin(t / 9000));
      ampEnv += (amp - ampEnv) * (amp > ampEnv ? 0.08 : 0.008);

      const floor = p.brightnessFloor / 100;
      const loudness = Math.min(1, Math.max(0, ampEnv));
      const energyForm = Math.min(1, intensitySm + kick * 0.08);
      let out = floor + energyForm * (1 - floor) * loudness;
      out = out <= 0 ? 0 : out >= 1 ? 1 : out;

      hist.copyWithin(0, 1); hist[N - 1] = out;
      raw.copyWithin(0, 1); raw[N - 1] = Math.min(1, x);

      ctx.clearRect(0, 0, w, h);

      // Golvlinje
      const floorY = h - 2 - (h - 6) * floor;
      ctx.strokeStyle = col(muted, 0.35);
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, floorY); ctx.lineTo(w, floorY); ctx.stroke();
      ctx.setLineDash([]);

      // Insignal (svag)
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
        Simulerat beat · grå = insignal, rosa = lampan
      </p>
    </div>
  );
}
