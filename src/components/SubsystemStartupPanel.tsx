/**
 * Subsystem startup panel — manuell uppstart av mic + sonos.
 *
 * (BLE-motorn startas separat via BleControlPanel "Starta motor".)
 */

import { useCallback, useEffect, useState } from "react";
import { Mic, Music, Loader2, Check, X, Play } from "lucide-react";
import { MicBackendBadge } from "@/components/MicBackendBadge";

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

interface MicLevel {
  active: boolean;
  totalRms: number;
  bassRms: number;
  midHiRms: number;
}

interface SonosSnapshot {
  playing: boolean;
  track: string | null;
  palette: [number, number, number][];
  nextPalette: [number, number, number][];
}

const POLL_MS = 2000;
const MIC_POLL_MS = 200;
const START_TIMEOUT_MS = 30_000;

function VuMeter({ level }: { level: MicLevel }) {
  const bassPct = Math.min(100, Math.round(level.bassRms * 400));
  const midPct = Math.min(100, Math.round(level.midHiRms * 400));
  return (
    <div className="flex flex-col gap-1 mt-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[8px] uppercase opacity-50 w-6">Bas</span>
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-primary transition-[width] duration-75" style={{ width: `${bassPct}%` }} />
        </div>
        <span className="text-[8px] font-mono opacity-60 w-7 text-right">{bassPct}%</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[8px] uppercase opacity-50 w-6">Disk</span>
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-accent transition-[width] duration-75" style={{ width: `${midPct}%` }} />
        </div>
        <span className="text-[8px] font-mono opacity-60 w-7 text-right">{midPct}%</span>
      </div>
    </div>
  );
}

export function SubsystemStartupPanel({ piBase, enabled }: { piBase: string; enabled: boolean }) {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [micLevel, setMicLevel] = useState<MicLevel>({ active: false, totalRms: 0, bassRms: 0, midHiRms: 0 });
  const [sonos, setSonos] = useState<SonosSnapshot>({ playing: false, track: null, palette: [], nextPalette: [] });

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${piBase}/api/subsystem/status`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) throw new Error("non-json response");
      setStatus(await r.json());
    } catch {
      // Engine ej nåbar → nollställ subsystem-status så UI:t inte visar
      // "Redo" på gammal data när motorn faktiskt ligger nere.
      setStatus(null);
    }
  }, [piBase]);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const micReady = status?.subsystems.mic?.status === "ready";
  const sonosReady = status?.subsystems.sonos?.status === "ready";

  useEffect(() => {
    if (!micReady) {
      setMicLevel({ active: false, totalRms: 0, bassRms: 0, midHiRms: 0 });
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${piBase}/api/mic/level`, { signal: AbortSignal.timeout(1000) });
        if (r.ok && !cancelled) setMicLevel(await r.json());
      } catch {}
    };
    tick();
    const id = setInterval(tick, MIC_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [piBase, micReady]);

  useEffect(() => {
    if (!sonosReady) {
      setSonos({ playing: false, track: null, palette: [], nextPalette: [] });
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${piBase}/api/status`, { signal: AbortSignal.timeout(2500) });
        if (r.ok && !cancelled) {
          const data = await r.json();
          const s = data.sonos ?? {};
          const palette = Array.isArray(s.palette) ? s.palette : [];
          const nextPalette = Array.isArray(s.nextPalette) ? s.nextPalette : [];
          const track: string | null =
            (typeof s.trackName === "string" && s.trackName) ||
            (typeof s.currentTrack === "string" && s.currentTrack) ||
            (s.currentTrack?.title
              ? `${s.currentTrack.title}${s.currentTrack.artist ? ` — ${s.currentTrack.artist}` : ""}`
              : null) ||
            null;
          setSonos({
            playing: s.playbackState === "PLAYBACK_STATE_PLAYING" || s.playbackState === "PLAYING" || s.playing === true,
            track,
            palette,
            nextPalette,
          });
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [piBase, sonosReady]);

  const startOne = useCallback(async (id: SubsystemId) => {
    try {
      await fetch(`${piBase}/api/subsystem/${id}/start`, {
        method: "POST",
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      });
    } catch {}
    await fetchStatus();
  }, [piBase, fetchStatus]);

  const renderRow = (
    id: SubsystemId,
    label: string,
    Icon: typeof Mic,
    extra?: React.ReactNode,
    badge?: React.ReactNode,
  ) => {
    const sub = status?.subsystems[id] ?? { status: "idle" as Status, startedAt: null, readyAt: null, durationMs: null, error: null };
    const dot = sub.status === "ready"
      ? "bg-green-500"
      : sub.status === "starting"
        ? "bg-yellow-400 animate-pulse"
        : sub.status === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/40";
    const disabled = !enabled || sub.status === "starting" || sub.status === "ready";
    return (
      <div key={id} className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
          <Icon size={14} className="shrink-0 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground/90 flex items-center gap-1.5 flex-wrap">{label}{badge}</div>
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
            onClick={() => startOne(id)}
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
        {sub.status === "ready" && extra}
      </div>
    );
  };

  return (
    <div className="mb-4 rounded-xl border border-border bg-secondary/40 text-[11px]">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <span className="font-semibold uppercase tracking-wider text-[10px] opacity-70">2. Subsystem</span>
        {!enabled && <span className="text-[9px] opacity-60">— starta BLE-motorn först</span>}
      </div>
      <div className="divide-y divide-border">
        {renderRow("mic", "Mikrofon", Mic, <VuMeter level={micLevel} />, <MicBackendBadge piBase={piBase} />)}
        {renderRow("sonos", "Sonos", Music, (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[10px] opacity-70 truncate flex-1">
              {sonos.track ? `${sonos.playing ? "▶" : "⏸"} ${sonos.track}` : <span className="opacity-50">Ingen låt</span>}
            </span>
            {(sonos.palette.length > 0 || sonos.nextPalette.length > 0) && (
              <div className="flex items-center gap-1.5 shrink-0">
                {sonos.palette[0] && (
                  <div
                    className="w-3.5 h-3.5 rounded-full ring-2 ring-primary/60 border border-border/50"
                    style={{ backgroundColor: `rgb(${sonos.palette[0][0]},${sonos.palette[0][1]},${sonos.palette[0][2]})` }}
                    title={`Aktuell: rgb(${sonos.palette[0][0]},${sonos.palette[0][1]},${sonos.palette[0][2]})`}
                  />
                )}
                <span className="text-[9px] opacity-40">→</span>
                {sonos.nextPalette[0] ? (
                  <div
                    className="w-3 h-3 rounded-full border border-border/50 opacity-70"
                    style={{ backgroundColor: `rgb(${sonos.nextPalette[0][0]},${sonos.nextPalette[0][1]},${sonos.nextPalette[0][2]})` }}
                    title={`Nästa: rgb(${sonos.nextPalette[0][0]},${sonos.nextPalette[0][1]},${sonos.nextPalette[0][2]})`}
                  />
                ) : (
                  <div className="w-3 h-3 rounded-full border border-dashed border-border/50" title="Ingen nästa-palett cachad" />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
