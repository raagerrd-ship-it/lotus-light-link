/**
 * Subsystem startup panel — manuell uppstart av motor/mic/sonos.
 *
 * Pollar /api/subsystem/status och triggar /api/subsystem/<id>/start på klick.
 * Stöder sekventiell autostart: i autostart-läge startas ett subsystem i taget,
 * nästa väntar på att föregående blir 'ready' (eller 'error' → stannar kedjan).
 *
 * Persisterar autostart-flaggor i localStorage:
 *   subsystem-autostart-<id> = 'true' | 'false'
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bluetooth, Mic, Music, Loader2, Check, X, Play } from "lucide-react";

type SubsystemId = "bleEngine" | "mic" | "sonos";
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
  subsystems: Record<SubsystemId | "engine", SubsystemState>;
}

const ROWS: { id: SubsystemId; label: string; icon: typeof Bluetooth; autostartKey: string }[] = [
  { id: "bleEngine", label: "BLE-motor", icon: Bluetooth, autostartKey: "subsystem-autostart-bleEngine" },
  { id: "mic",       label: "Mikrofon",  icon: Mic,       autostartKey: "subsystem-autostart-mic" },
  { id: "sonos",     label: "Sonos",     icon: Music,     autostartKey: "subsystem-autostart-sonos" },
];

const POLL_MS = 1500;
const START_TIMEOUT_MS = 30_000;

function readAutostart(id: SubsystemId): boolean {
  try { return localStorage.getItem(`subsystem-autostart-${id}`) === "true"; } catch { return false; }
}
function writeAutostart(id: SubsystemId, on: boolean): void {
  try { localStorage.setItem(`subsystem-autostart-${id}`, on ? "true" : "false"); } catch {}
}

export function SubsystemStartupPanel({ piBase }: { piBase: string }) {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [autostartTick, setAutostartTick] = useState(0); // re-render on toggle
  const autostartRanRef = useRef(false);

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

  const startOne = useCallback(async (id: SubsystemId): Promise<Status> => {
    const path = id === "bleEngine" ? "ble-engine" : id;
    try {
      const r = await fetch(`${piBase}/api/subsystem/${path}/start`, {
        method: "POST",
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      });
      const data = await r.json().catch(() => ({}));
      // Servern returnerar slutstatus i data.subsystem
      const final = (data?.subsystem?.status ?? (r.ok ? "ready" : "error")) as Status;
      await fetchStatus();
      return final;
    } catch {
      await fetchStatus();
      return "error";
    }
  }, [piBase, fetchStatus]);

  // ── Sekventiell autostart vid mount ──
  // Kör en gång per page-load. Startar subsystem som har autostart-flaggan satt,
  // i ordning bleEngine → mic → sonos. Stannar vid första 'error'.
  useEffect(() => {
    if (autostartRanRef.current) return;
    if (!status) return; // vänta på första statusen så vi inte dubbel-startar
    autostartRanRef.current = true;

    const queue = ROWS.filter(r => readAutostart(r.id));
    if (queue.length === 0) return;

    (async () => {
      for (const row of queue) {
        const current = status.subsystems[row.id]?.status ?? "idle";
        if (current === "ready") continue;
        if (current === "starting") {
          // vänta in pågående start
          for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 500));
            await fetchStatus();
            const s = (await fetch(`${piBase}/api/subsystem/status`).then(r => r.json()).catch(() => null)) as StatusResp | null;
            const st = s?.subsystems[row.id]?.status;
            if (st === "ready") break;
            if (st === "error") return;
          }
          continue;
        }
        const result = await startOne(row.id);
        if (result === "error") {
          console.warn(`[Autostart] ${row.id} → error, stannar kedjan`);
          return;
        }
      }
    })();
  }, [status, startOne, fetchStatus, piBase]);

  const allReady = useMemo(() => {
    if (!status) return false;
    return ROWS.every(r => status.subsystems[r.id]?.status === "ready");
  }, [status]);

  if (!status) {
    return (
      <div className="mb-3 p-3 rounded-lg border border-border bg-muted/20 text-[11px] text-muted-foreground flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Hämtar subsystem-status…
      </div>
    );
  }

  if (allReady && collapsed) {
    return (
      <div className="mb-3 p-2.5 rounded-lg border border-green-500/30 bg-green-500/10 text-green-400 text-[11px] flex items-center gap-2">
        <Check size={14} className="shrink-0" />
        <span className="flex-1 font-medium">Alla subsystem redo</span>
        <button
          onClick={() => setCollapsed(false)}
          className="px-2 py-0.5 rounded-md bg-current/10 hover:bg-current/20 text-[10px] font-semibold"
        >
          Visa
        </button>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/20 text-[11px]">
      <div className="px-3 py-2 flex items-center justify-between border-b border-border">
        <span className="font-semibold uppercase tracking-wider text-[10px] opacity-70">Starta subsystem</span>
        {allReady && (
          <button
            onClick={() => setCollapsed(true)}
            className="px-2 py-0.5 rounded-md bg-foreground/10 hover:bg-foreground/20 text-[10px] font-semibold text-foreground/70"
          >
            Dölj
          </button>
        )}
      </div>
      <div className="divide-y divide-border">
        {ROWS.map(row => {
          const Icon = row.icon;
          const sub = status.subsystems[row.id] ?? { status: "idle", startedAt: null, readyAt: null, durationMs: null, error: null };
          const auto = readAutostart(row.id);
          // Re-read autostart on tick
          void autostartTick;

          const dot = sub.status === "ready"
            ? "bg-green-500"
            : sub.status === "starting"
              ? "bg-yellow-400 animate-pulse"
              : sub.status === "error"
                ? "bg-destructive"
                : "bg-muted-foreground/40";

          return (
            <div key={row.id} className="px-3 py-2.5 flex items-center gap-2.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
              <Icon size={14} className="shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground/90">{row.label}</div>
                {sub.status === "ready" && sub.durationMs != null && (
                  <div className="text-[9px] opacity-50">Redo på {(sub.durationMs / 1000).toFixed(1)}s</div>
                )}
                {sub.status === "starting" && (
                  <div className="text-[9px] opacity-60">Startar…</div>
                )}
                {sub.status === "error" && sub.error && (
                  <div className="text-[9px] text-destructive break-words">{sub.error}</div>
                )}
                {sub.status === "idle" && (
                  <div className="text-[9px] opacity-50">Ej startad</div>
                )}
              </div>

              <label className="flex items-center gap-1 cursor-pointer text-[9px] opacity-70 hover:opacity-100 select-none">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => { writeAutostart(row.id, e.target.checked); setAutostartTick(t => t + 1); }}
                  className="w-3 h-3 accent-primary"
                />
                Auto
              </label>

              <button
                onClick={() => startOne(row.id)}
                disabled={sub.status === "starting" || sub.status === "ready"}
                className="px-2.5 py-1 rounded-md text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-primary/15 hover:bg-primary/25 text-primary flex items-center gap-1"
              >
                {sub.status === "starting" ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : sub.status === "ready" ? (
                  <Check size={11} />
                ) : sub.status === "error" ? (
                  <X size={11} />
                ) : (
                  <Play size={11} />
                )}
                {sub.status === "ready" ? "Redo" : sub.status === "starting" ? "Startar" : sub.status === "error" ? "Försök igen" : "Starta"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="px-3 py-1.5 text-[9px] opacity-50 border-t border-border">
        Tips: aktivera "Auto" → startar sekventiellt vid nästa sidladdning (väntar på att föregående blir Redo).
      </div>
    </div>
  );
}
