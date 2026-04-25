import { useEffect, useRef, useState } from "react";
import { apiBase } from "@/lib/apiBase";

/**
 * LiveStrip — kompakt realtids-display av engine-state.
 * Visar (i ordning): Input level, Output level, BLE-kö, Palette (nu/nästa), Sonos-låt.
 * Pollar /api/status @ 4 Hz. Tyst vid fel (UI får inte spamma vid disconnect).
 */
type RGB = [number, number, number];

type StatusLive = {
  inputLevel: number;            // 0..1 (engine energyNorm, matchar output-domänen)
  outputBrightness: number;      // 0..1
  paletteCurrent: RGB[] | null;  // Sonos-palette för nuvarande låt
  paletteNext: RGB[] | null;     // Pre-cached palette för nästa låt
  track: string | null;
  artist: string | null;
  queue: number;
};

export function LiveStrip() {
  const [live, setLive] = useState<StatusLive | null>(null);
  const [stale, setStale] = useState(false);
  const lastOk = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const r = await fetch(`${apiBase}/api/status`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (cancelled) return;
        if (j?.live) {
          setLive(j.live as StatusLive);
          lastOk.current = Date.now();
          setStale(false);
        }
      } catch {
        if (!cancelled && Date.now() - lastOk.current > 4000) setStale(true);
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, 250);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div
      className={`rounded-xl border border-border bg-card/60 p-3 text-xs space-y-2 transition-opacity ${
        stale ? "opacity-50" : "opacity-100"
      }`}
      aria-label="Live engine metrics"
    >
      <Row label="Input" value={fmtPct(live?.inputLevel)}>
        <Bar value={live?.inputLevel ?? 0} />
      </Row>

      <Row label="Output" value={fmtPct(live?.outputBrightness)}>
        <Bar value={live?.outputBrightness ?? 0} />
      </Row>

      <Row label="Kö" value={String(live?.queue ?? 0)} />

      <Row label="Nu">
        <PaletteSwatch palette={live?.paletteCurrent ?? null} />
      </Row>

      <Row label="Nästa">
        <PaletteSwatch palette={live?.paletteNext ?? null} />
      </Row>

      <Row label="Låt">
        <span className="truncate text-foreground/90">
          {live?.track
            ? `${live.track}${live.artist ? " — " + live.artist : ""}`
            : <span className="text-muted-foreground">—</span>}
        </span>
      </Row>
    </div>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
      {value !== undefined && (
        <span className="ml-auto tabular-nums text-foreground/80">{value}</span>
      )}
    </div>
  );
}

function Bar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-2 flex-1 rounded bg-muted overflow-hidden">
      <div
        className="h-full bg-primary transition-[width] duration-150"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function PaletteSwatch({ palette }: { palette: [number, number, number][] | null }) {
  if (!palette || palette.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  // Visa upp till 5 färger som horisontella rutor — ren input-vy från Sonos.
  const slice = palette.slice(0, 5);
  return (
    <div className="flex h-4 gap-1">
      {slice.map(([r, g, b], i) => (
        <div
          key={i}
          className="h-4 w-6 rounded border border-border"
          style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }}
          title={`rgb(${r}, ${g}, ${b})`}
        />
      ))}
    </div>
  );
}

function fmtPct(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}
