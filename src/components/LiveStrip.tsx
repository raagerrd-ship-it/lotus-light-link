import { useEffect, useRef, useState } from "react";
import { apiBase } from "@/lib/apiBase";

/**
 * LiveStrip — kompakt realtids-display av engine-state.
 * Visar: Input, Output (färgad med aktuell palettfärg), BLE-kö,
 * Status (playback), Nu (färg + låt), Nästa (färg + låt).
 * Pollar /api/status @ 4 Hz. Tyst vid fel.
 */
type RGB = [number, number, number];

type StatusLive = {
  inputLevel: number;
  outputBrightness: number;
  paletteCurrent: RGB[] | null;
  paletteNext: RGB[] | null;
  track: string | null;
  artist: string | null;
  nextTrack: string | null;
  nextArtist: string | null;
  playbackState: string | null;
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

  const currentColor = live?.paletteCurrent?.[0] ?? null;
  const nextColor = live?.paletteNext?.[0] ?? null;

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
        <Bar value={live?.outputBrightness ?? 0} color={currentColor} />
      </Row>

      <Row label="Status" value={fmtPlayback(live?.playbackState)} />

      <Row label="Kö" value={String(live?.queue ?? 0)} />

      <Row label="Nu">
        <Swatch color={currentColor} />
        <span className="truncate text-foreground/90">
          {live?.track
            ? `${live.track}${live.artist ? " — " + live.artist : ""}`
            : <span className="text-muted-foreground">—</span>}
        </span>
      </Row>

      <Row label="Nästa">
        <Swatch color={nextColor} />
        <span className="truncate text-foreground/90">
          {live?.nextTrack
            ? `${live.nextTrack}${live.nextArtist ? " — " + live.nextArtist : ""}`
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

function Bar({ value, color }: { value: number; color?: RGB | null }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const bg = color ? `rgb(${color[0]}, ${color[1]}, ${color[2]})` : undefined;
  return (
    <div className="h-2 flex-1 rounded bg-muted overflow-hidden">
      <div
        className={`h-full transition-[width] duration-150 ${color ? "" : "bg-primary"}`}
        style={{ width: `${pct}%`, backgroundColor: bg }}
      />
    </div>
  );
}

function Swatch({ color }: { color: RGB | null }) {
  if (!color) {
    return (
      <div
        className="h-4 w-6 shrink-0 rounded border border-border bg-muted"
        aria-hidden
      />
    );
  }
  const [r, g, b] = color;
  return (
    <div
      className="h-4 w-6 shrink-0 rounded border border-border"
      style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }}
      title={`rgb(${r}, ${g}, ${b})`}
    />
  );
}

function fmtPct(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

function fmtPlayback(s: string | null | undefined): string {
  if (!s) return "—";
  if (s.includes("PLAYING")) return "Spelar";
  if (s.includes("PAUSED")) return "Pausad";
  if (s.includes("STOPPED")) return "Stoppad";
  if (s.includes("TRANSITION")) return "Byter…";
  if (s.includes("IDLE")) return "Inaktiv";
  return s;
}
