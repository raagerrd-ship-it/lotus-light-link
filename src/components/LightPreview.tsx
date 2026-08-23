import { useEffect, useRef } from "react";

/**
 * Live-simulering av ljusomvandlingen — visar hur reglagen påverkar utsignalen.
 * Ren presentation: ingen kontakt med motorn, ett syntetiskt beat matas genom
 * samma kedja (attack/release → dynamik → golv) som piEngine använder.
 */
export function LightPreview({
  softness, brightnessFloor, dynamicDamping, beatCutoffHz,
}: {
  softness: number;
  brightnessFloor: number;
  dynamicDamping: number;
  beatCutoffHz: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const params = useRef({ softness, brightnessFloor, dynamicDamping, beatCutoffHz });
  params.current = { softness, brightnessFloor, dynamicDamping, beatCutoffHz };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const N = 140;
    const hist = new Float32Array(N);
    const raw = new Float32Array(N);
    let level = 0;
    let raf = 0;
    const t0 = performance.now();
    const BEAT_MS = 500;

    const tick = () => {
      const p = params.current;
      const t = performance.now() - t0;

      // Syntetisk källa: kick-transient + mellanregister som släpps in av cutoff.
      const phase = t % BEAT_MS;
      const kick = Math.exp(-phase / 90);
      const mid = 0.35 * (0.5 + 0.5 * Math.sin(t / 130)) * Math.exp(-(phase % 250) / 160);
      const melodyMix = Math.min(1, Math.max(0, (p.beatCutoffHz - 60) / 1940));
      let x = (1 - melodyMix * 0.55) * kick + melodyMix * mid;

      // Attack direkt, release mjuknar exponentiellt med softness.
      const release = 0.6 * Math.pow(0.04, p.softness / 100);
      level = x > level ? x : level + (x - level) * release;

      // Dynamik: expansion/utjämning kring rörligt center.
      let out = 0.45 + (level - 0.45) * (1 + p.dynamicDamping * 0.5);
      out = Math.min(1, Math.max(0, out));

      // Ljusgolv.
      const floor = p.brightnessFloor / 100;
      out = floor + (1 - floor) * out;

      hist.copyWithin(0, 1); hist[N - 1] = out;
      raw.copyWithin(0, 1); raw[N - 1] = Math.min(1, x);

      ctx.clearRect(0, 0, w, h);

      // Golvlinje
      const floorY = h - 2 - (h - 6) * floor;
      ctx.strokeStyle = "hsl(var(--muted-foreground) / 0.35)";
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, floorY); ctx.lineTo(w, floorY); ctx.stroke();
      ctx.setLineDash([]);

      // Insignal (svag)
      ctx.strokeStyle = "hsl(var(--muted-foreground) / 0.4)";
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const px = (i / (N - 1)) * w, py = h - 2 - (h - 6) * raw[i];
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();

      // Utsignal (fylld)
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "hsl(var(--primary) / 0.45)");
      grad.addColorStop(1, "hsl(var(--primary) / 0.02)");
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < N; i++) {
        ctx.lineTo((i / (N - 1)) * w, h - 2 - (h - 6) * hist[i]);
      }
      ctx.lineTo(w, h); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();

      ctx.strokeStyle = "hsl(var(--primary))";
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
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-border p-2.5">
      <div className="flex items-center gap-3">
        <div className="relative w-10 h-10 shrink-0 flex items-center justify-center">
          <div
            ref={orbRef}
            className="w-8 h-8 rounded-full bg-primary shadow-[0_0_22px_hsl(var(--primary)/0.7)]"
          />
        </div>
        <canvas ref={canvasRef} className="h-14 flex-1 w-full" />
      </div>
      <p className="mt-1.5 text-[9px] uppercase tracking-[0.18em] text-muted-foreground/50">
        Simulerat beat · grå = insignal, rosa = lampan
      </p>
    </div>
  );
}
