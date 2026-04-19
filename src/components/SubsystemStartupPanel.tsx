/**
 * Subsystem startup panel — manuell uppstart av mic + sonos.
 *
 * Avsiktligt MINIMAL i denna iteration: BLE-motor och lamp-anslutning
 * hanteras av BleControlPanel. Här syns bara mic + sonos, och båda är
 * disabled tills BLE-lampan är ansluten (annars saknar de mening).
 *
 * Pollar /api/subsystem/status och triggar /api/subsystem/<id>/start på klick.
 */

import { useCallback, useEffect, useState } from "react";
import { Mic, Music, Loader2, Check, X, Play } from "lucide-react";

type SubsystemId = "mic" | "sonos";
type Status = "idle" | "starting" | "ready" | "error";

interface SubsystemState {
  status: Status;
  startedAt: number | null;
  readyAt: number | null;
  durationMs: number | null;
  error: string | null;
}

interface StatusResp {
  bootPhase: string;
  subsystems: Record<string, SubsystemState>;
}

const ROWS: { id: SubsystemId; label: string; icon: typeof Mic }[] = [
  { id: "mic",   label: "Mikrofon", icon: Mic },
  { id: "sonos", label: "Sonos",    icon: Music },
];

const POLL_MS = 2000;
const START_TIMEOUT_MS = 30_000;

export function SubsystemStartupPanel({ piBase, enabled }: { piBase: string; enabled: boolean }) {
  const [status, setStatus] = useState<StatusResp | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${piBase}/api/subsystem/status`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) setStatus(await r.json());
    } catch {}
  }, [piBase]);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const startOne = useCallback(async (id: SubsystemId) => {
    try {
      await fetch(`${piBase}/api/subsystem/${id}/start`, {
        method: "POST",
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      });
    } catch {}
    await fetchStatus();
  }, [piBase, fetchStatus]);

  return (
    <div className="mb-4 rounded-xl border border-border bg-secondary/40 text-[11px]">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <span className="font-semibold uppercase tracking-wider text-[10px] opacity-70">2. Subsystem</span>
        {!enabled && <span className="text-[9px] opacity-60">— starta BLE-motorn först</span>}
      </div>
      <div className="divide-y divide-border">
        {ROWS.map(row => {
          const Icon = row.icon;
          const sub = status?.subsystems[row.id] ?? { status: "idle" as Status, startedAt: null, readyAt: null, durationMs: null, error: null };
          const dot = sub.status === "ready"
            ? "bg-green-500"
            : sub.status === "starting"
              ? "bg-yellow-400 animate-pulse"
              : sub.status === "error"
                ? "bg-destructive"
                : "bg-muted-foreground/40";
          const disabled = !enabled || sub.status === "starting" || sub.status === "ready";
          return (
            <div key={row.id} className="px-3 py-2.5 flex items-center gap-2.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
              <Icon size={14} className="shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground/90">{row.label}</div>
                {sub.status === "ready" && sub.durationMs != null && (
                  <div className="text-[9px] opacity-50">Redo på {(sub.durationMs / 1000).toFixed(1)}s</div>
                )}
                {sub.status === "starting" && <div className="text-[9px] opacity-60">Startar…</div>}
                {sub.status === "error" && sub.error && (
                  <div className="text-[9px] text-destructive truncate" title={sub.error}>
                    {sub.error.split("\n")[0].slice(0, 60)}
                  </div>
                )}
                {sub.status === "idle" && <div className="text-[9px] opacity-50">Ej startad</div>}
              </div>
              <button
                onClick={() => startOne(row.id)}
                disabled={disabled}
                className="px-2.5 py-1 rounded-md text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-primary/15 hover:bg-primary/25 text-primary flex items-center gap-1"
              >
                {sub.status === "starting" ? <Loader2 size={11} className="animate-spin" />
                  : sub.status === "ready" ? <Check size={11} />
                  : sub.status === "error" ? <X size={11} />
                  : <Play size={11} />}
                {sub.status === "ready" ? "Redo" : sub.status === "starting" ? "Startar" : sub.status === "error" ? "Igen" : "Starta"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
