import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Skull, Bug, HelpCircle, Activity } from "lucide-react";

/**
 * RestartHistoryPanel — visar senaste 20 restarts från /api/status.restarts.
 *
 * Syfte: ge synlighet i HUR OFTA och VARFÖR motorn startat om så vi kan
 * tunea (t.ex. CONSECUTIVE_FAIL_LIMIT). Ligger i egen <details> så den
 * är åtkomlig oavsett om Starta-allt är klart eller inte.
 */

type Reason =
  | "ble-consecutive-failures"
  | "uncaught-exception"
  | "unhandled-rejection"
  | "unknown-systemd-restart"
  | "manual-start-all";

interface RestartEntry {
  ts: string;
  reason: Reason;
  detail: string | null;
  uptimeBeforeMs: number | null;
  memoryBeforeMb: number | null;
}

interface SubsystemTransition {
  ts: string;
  id: "mic" | "sonos" | "engine";
  from: "idle" | "starting" | "ready" | "error";
  to: "idle" | "starting" | "ready" | "error";
  error: string | null;
  uptimeMs: number | null;
}

interface Props {
  piBase: string;
}

const REASON_META: Record<
  Reason,
  { label: string; tone: "warn" | "error" | "muted"; Icon: typeof AlertTriangle }
> = {
  "ble-consecutive-failures": {
    label: "BLE-fel × N",
    tone: "warn",
    Icon: RefreshCw,
  },
  "uncaught-exception": { label: "Krasch (exception)", tone: "error", Icon: Bug },
  "unhandled-rejection": { label: "Krasch (promise)", tone: "error", Icon: Bug },
  "unknown-systemd-restart": {
    label: "Okänd död (OOM/segfault?)",
    tone: "error",
    Icon: Skull,
  },
  "manual-start-all": { label: "Manuell Starta allt", tone: "muted", Icon: HelpCircle },
};

function formatUptime(ms: number | null): string {
  if (ms == null) return "?";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTimeAgo(iso: string): string {
  const ago = Date.now() - new Date(iso).getTime();
  if (ago < 60_000) return `${Math.floor(ago / 1000)}s sedan`;
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m sedan`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h sedan`;
  return `${Math.floor(ago / 86_400_000)}d sedan`;
}

export function RestartHistoryPanel({ piBase }: Props) {
  const [entries, setEntries] = useState<RestartEntry[]>([]);
  const [transitions, setTransitions] = useState<SubsystemTransition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await fetch(`${piBase}/api/status`, {
        signal: AbortSignal.timeout(3000),
      });
      const j = await r.json();
      const list: RestartEntry[] = Array.isArray(j?.restarts) ? j.restarts : [];
      const tlist: SubsystemTransition[] = Array.isArray(j?.subsystemTransitions) ? j.subsystemTransitions : [];
      // Nyaste först
      setEntries([...list].reverse());
      setTransitions([...tlist].reverse());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piBase]);

  // Snabb-stat: antal senaste 24h, dominerande reason
  const last24h = entries.filter(
    (e) => Date.now() - new Date(e.ts).getTime() < 86_400_000
  );
  const reasonCounts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.reason] = (acc[e.reason] ?? 0) + 1;
    return acc;
  }, {});
  const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];

  return (
    <details className="rounded-xl border border-border bg-card/40">
      <summary className="cursor-pointer select-none px-4 py-2 text-xs text-muted-foreground hover:text-foreground flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5" />
          Restart-historik
          {entries.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              ({entries.length} totalt
              {last24h.length > 0 && `, ${last24h.length} senaste 24h`})
            </span>
          )}
        </span>
        {topReason && (
          <span className="text-[10px] text-muted-foreground">
            mest: {REASON_META[topReason[0] as Reason]?.label ?? topReason[0]} ×
            {topReason[1]}
          </span>
        )}
      </summary>
      <div className="space-y-2 p-3 pt-0">
        {loading && (
          <div className="text-xs text-muted-foreground">Laddar…</div>
        )}
        {error && (
          <div className="text-xs text-destructive">Fel: {error}</div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="text-xs text-muted-foreground">
            Inga restarts loggade — motorn har gått stabilt sedan installationen.
          </div>
        )}
        {entries.length > 0 && (
          <ol className="space-y-1.5">
            {entries.map((e, idx) => {
              const meta = REASON_META[e.reason] ?? {
                label: e.reason,
                tone: "muted" as const,
                Icon: HelpCircle,
              };
              const toneClass =
                meta.tone === "error"
                  ? "text-destructive"
                  : meta.tone === "warn"
                    ? "text-yellow-500"
                    : "text-muted-foreground";
              return (
                <li
                  key={`${e.ts}-${idx}`}
                  className="rounded-md border border-border/60 bg-background/40 p-2 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className={`flex items-center gap-1.5 ${toneClass}`}>
                      <meta.Icon className="h-3.5 w-3.5" />
                      {meta.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatTimeAgo(e.ts)}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>uptime: {formatUptime(e.uptimeBeforeMs)}</span>
                    {e.memoryBeforeMb != null && (
                      <span>RSS: {e.memoryBeforeMb}MB</span>
                    )}
                    <span className="font-mono opacity-70">
                      {new Date(e.ts).toLocaleString("sv-SE", {
                        hour12: false,
                      })}
                    </span>
                  </div>
                  {e.detail && (
                    <div className="text-[10px] text-muted-foreground/80 break-words font-mono leading-snug max-h-20 overflow-y-auto">
                      {e.detail}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {/* Subsystem-fall: ready→error eller ready→idle = något stängdes av */}
        {transitions.length > 0 && (() => {
          const falls = transitions.filter(
            (t) => t.from === "ready" && (t.to === "error" || t.to === "idle")
          );
          if (falls.length === 0) return null;
          return (
            <div className="space-y-1.5 pt-2 border-t border-border/40">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <Activity className="h-3 w-3" />
                Subsystem som föll bort ({falls.length})
              </div>
              <ol className="space-y-1">
                {falls.slice(0, 10).map((t, idx) => (
                  <li
                    key={`${t.ts}-${idx}`}
                    className="rounded-md border border-border/60 bg-background/40 p-2 space-y-0.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-foreground">{t.id}</span>
                        <span className="text-muted-foreground">
                          ready → {t.to}
                        </span>
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatTimeAgo(t.ts)}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground/80">
                      höll {formatUptime(t.uptimeMs)} innan fall
                    </div>
                    {t.error && (
                      <div className="text-[10px] text-destructive/90 break-words font-mono leading-snug max-h-16 overflow-y-auto">
                        {t.error}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          );
        })()}
      </div>
    </details>
  );
}
