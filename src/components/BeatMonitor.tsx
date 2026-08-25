import { useEffect, useRef, useState } from "react";
import { useLiveFeed } from "@/lib/liveFeed";

type BeatInfo = {
  locked: boolean;
  bpm: number;
  confidence: number;
  nextBeatMs: number;
  beatErr: number;
  gridPulses: number;
  leadMs: number;
};

/**
 * Beat-monitor: visar om taktklockan låser rätt BPM och att ljuset skickas
 * leadMs FÖRE det hörbara slaget. Serverklockan hämtas 1 Hz och extrapoleras
 * lokalt så att markörerna rör sig mjukt mellan pollningarna.
 */
export function BeatMonitor({ piBase, onTapBpm }: { piBase: string; onTapBpm?: (bpm: number) => void }) {
  const [beat, setBeat] = useState<BeatInfo | null>(null);
  const clock = useRef<{ nextOutAt: number; periodMs: number } | null>(null);
  const [phase, setPhase] = useState(0);
  const [outFlash, setOutFlash] = useState(false);
  const [beatFlash, setBeatFlash] = useState(false);
  const [tapBpm, setTapBpm] = useState<number | null>(null);
  const taps = useRef<number[]>([]);

  // Serverklocka via den delade /api/live-pollern (1 Hz)
  const live = useLiveFeed();
  useEffect(() => {
    const b = live.data?.beat ?? null;
    if (!b) return;
    setBeat(b);
    if (b.locked && b.bpm > 40) {
      clock.current = { nextOutAt: performance.now() + b.nextBeatMs, periodMs: 60000 / b.bpm };
    } else {
      clock.current = null;
    }
  }, [live]);

  // Lokal extrapolering + blink
  useEffect(() => {
    let raf = 0;
    const lead = beat?.leadMs ?? 0;
    const tick = () => {
      const c = clock.current;
      if (c) {
        const now = performance.now();
        while (now >= c.nextOutAt) c.nextOutAt += c.periodMs;
        const untilOut = c.nextOutAt - now;
        setPhase(1 - untilOut / c.periodMs);
        setOutFlash(untilOut > c.periodMs - 90);
        const untilBeat = (untilOut + lead) % c.periodMs;
        setBeatFlash(untilBeat > c.periodMs - 90);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [beat?.leadMs]);

  const tap = () => {
    const now = performance.now();
    const t = taps.current.filter((x) => now - x < 3000);
    t.push(now);
    taps.current = t;
    if (t.length >= 3) {
      const bpm = 60000 / ((t[t.length - 1] - t[0]) / (t.length - 1));
      setTapBpm(bpm);
      onTapBpm?.(bpm);
    }
  };

  const bpm = beat?.bpm ?? 0;
  const lead = beat?.leadMs ?? 0;
  const period = bpm > 40 ? 60000 / bpm : 0;
  const leadFrac = period ? Math.min(0.9, lead / period) : 0;
  const diff = tapBpm && bpm ? tapBpm - bpm : null;

  return (
    <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="label-eyebrow">Beat-lås</span>
        <span className={`font-mono text-[10px] font-semibold ${beat?.locked ? "text-ok" : "text-muted-foreground"}`}>
          {beat?.locked ? `LÅST · ${Math.round((beat.confidence ?? 0) * 100)} %` : "SÖKER"}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xl font-bold tabular-nums text-primary">
          {bpm > 40 ? bpm.toFixed(1) : "—"}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">BPM</span>
      </div>

      {/* Takt-linje: ljuset (rosa) skickas leadMs före slaget (vitt) */}
      <div className="relative h-10 rounded-lg bg-background/60 overflow-hidden">
        {[0, 0.25, 0.5, 0.75].map((p) => (
          <div key={p} className="absolute top-0 bottom-0 w-px bg-border/70" style={{ left: `${p * 100}%` }} />
        ))}
        {/* Ljus-ut markör */}
        <div
          className="absolute top-1 bottom-1 w-[3px] rounded bg-primary shadow-[0_0_10px_hsl(var(--primary))]"
          style={{ left: `${phase * 100}%` }}
        />
        {/* Hörbart slag = ljuset + lead */}
        <div
          className="absolute top-2 bottom-2 w-px bg-foreground/60"
          style={{ left: `${Math.min(99, (phase + leadFrac) * 100)}%` }}
        />
        <span className="absolute left-1.5 bottom-0.5 text-[9px] font-mono text-muted-foreground">ljus ut</span>
        <span className="absolute right-1.5 bottom-0.5 text-[9px] font-mono text-muted-foreground">slag</span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className={`w-2.5 h-2.5 rounded-full transition-opacity ${outFlash ? "bg-primary opacity-100 shadow-[0_0_10px_hsl(var(--primary))]" : "bg-primary/20 opacity-60"}`} />
          <span className="text-[10px] text-muted-foreground">Ljus ut</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-2.5 h-2.5 rounded-full transition-opacity ${beatFlash ? "bg-foreground opacity-100" : "bg-foreground/20 opacity-60"}`} />
          <span className="text-[10px] text-muted-foreground">Slag (+{Math.round(lead)} ms)</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="font-mono text-xs font-semibold tabular-nums">{beat ? `${beat.beatErr >= 0 ? "+" : ""}${beat.beatErr.toFixed(0)}` : "—"}</div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">fasfel ms</div>
        </div>
        <div>
          <div className="font-mono text-xs font-semibold tabular-nums">{beat?.gridPulses ?? "—"}</div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">grid-pulser</div>
        </div>
        <div>
          <div className="font-mono text-xs font-semibold tabular-nums">{Math.round(lead)}</div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">lead ms</div>
        </div>
      </div>

      {/* Tap-tempo: verifiera att motorns BPM stämmer med musiken */}
      <div className="flex items-center gap-2">
        <button
          onClick={tap}
          className="h-9 flex-1 rounded-lg border border-border bg-secondary/60 text-[11px] font-semibold active:scale-95 transition-transform"
        >
          Tappa takten
        </button>
        <div className="w-[104px] text-right">
          {tapBpm ? (
            <>
              <div className="font-mono text-xs font-semibold tabular-nums">{tapBpm.toFixed(1)} BPM</div>
              <div className={`text-[9px] ${diff !== null && Math.abs(diff) < 2 ? "text-ok" : "text-warn"}`}>
                {diff !== null ? `${diff >= 0 ? "+" : ""}${diff.toFixed(1)} vs motor` : ""}
              </div>
            </>
          ) : (
            <div className="text-[9px] text-muted-foreground">tryck 4 slag</div>
          )}
        </div>
      </div>
    </div>
  );
}
