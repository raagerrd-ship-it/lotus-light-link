/**
 * BleControlPanel — minimal UI för att bevisa BLE-flödet end-to-end.
 *
 * Två block:
 *   1. BLE-motor: knapp "Starta motor" → POST /api/ble/engine/start
 *   2. Lampa (hårdkodad ELK-BLEDOM01): "Anslut" → POST /api/ble/connect
 *      (scan-then-connect mot hårdkodad MAC)
 *
 * Pollar /api/ble/state varannan sekund för status.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bluetooth, Loader2, Lightbulb, Play, Power } from "lucide-react";

interface BleStateResp {
  engineReady: boolean;
  connected: boolean;
  device: { name: string; mac: string };
  rawState?: string;
}

interface LogEntry {
  seq: number;
  t: number;
  level: "log" | "warn" | "error";
  text: string;
}

type Section = "engine" | "lamp" | "all";

export function BleControlPanel({ piBase, onConnectedChange, onEngineReadyChange, section = "all" }: { piBase: string; onConnectedChange?: (connected: boolean) => void; onEngineReadyChange?: (ready: boolean) => void; section?: Section }) {
  const showEngine = section === "engine" || section === "all";
  const showLamp = section === "lamp" || section === "all";
  const [state, setState] = useState<BleStateResp | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const sinceRef = useRef(0);
  const logPollRef = useRef<number | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${piBase}/api/ble/state`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const data = (await r.json()) as BleStateResp;
        setState(data);
        onConnectedChange?.(data.connected);
      }
    } catch {}
  }, [piBase, onConnectedChange]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const pollLogs = useCallback(async () => {
    try {
      const r = await fetch(`${piBase}/api/ble/engine/logs?since=${sinceRef.current}`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const data = (await r.json()) as { entries: LogEntry[]; nextSince: number };
        if (data.entries?.length) {
          setLogs((prev) => [...prev, ...data.entries].slice(-300));
        }
        sinceRef.current = data.nextSince ?? sinceRef.current;
      }
    } catch {}
  }, [piBase]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => () => {
    if (logPollRef.current) window.clearInterval(logPollRef.current);
  }, []);

  const startEngine = async () => {
    setEngineBusy(true);
    setLastError(null);
    setLogs([]);
    sinceRef.current = 0;
    if (logPollRef.current) window.clearInterval(logPollRef.current);
    logPollRef.current = window.setInterval(pollLogs, 400);
    try {
      const r = await fetch(`${piBase}/api/ble/engine/start`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ready) {
        setLastError(data.error ?? `Motor startade inte (rawState=${data.rawState ?? "okänd"})`);
      }
      await refresh();
    } catch (e: any) {
      setLastError(e?.message ?? "Nätverksfel");
    } finally {
      setEngineBusy(false);
      await pollLogs();
      if (logPollRef.current) {
        window.clearInterval(logPollRef.current);
        logPollRef.current = null;
      }
    }
  };

  const connect = async () => {
    setConnectBusy(true);
    setLastError(null);
    setLogs([]);
    sinceRef.current = 0;
    if (logPollRef.current) window.clearInterval(logPollRef.current);
    logPollRef.current = window.setInterval(pollLogs, 400);
    try {
      const r = await fetch(`${piBase}/api/ble/connect`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.connected) {
        setLastError(data.error ?? "Anslutning misslyckades");
      }
      await refresh();
    } catch (e: any) {
      setLastError(e?.message ?? "Nätverksfel");
    } finally {
      setConnectBusy(false);
      await pollLogs();
      if (logPollRef.current) {
        window.clearInterval(logPollRef.current);
        logPollRef.current = null;
      }
    }
  };

  const disconnect = async () => {
    setConnectBusy(true);
    try {
      await fetch(`${piBase}/api/ble/disconnect`, { method: "POST", signal: AbortSignal.timeout(5000) });
      await refresh();
    } catch {}
    setConnectBusy(false);
  };

  const engineReady = !!state?.engineReady;
  const connected = !!state?.connected;
  const device = state?.device ?? { name: "ELK-BLEDOM01", mac: "BE:67:00:15:09:41" };

  return (
    <div className="space-y-3 mb-4">
      {/* BLE-motor */}
      {showEngine && (
        <div className={`rounded-xl border p-3 ${engineReady ? "bg-green-500/10 border-green-500/30" : "bg-secondary/50 border-border"}`}>
          <div className="flex items-center gap-2.5">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${engineReady ? "bg-green-500" : engineBusy ? "bg-yellow-400 animate-pulse" : "bg-muted-foreground/40"}`} />
            <Bluetooth size={16} className={engineReady ? "text-green-400" : "text-muted-foreground"} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">1. BLE-motor</div>
              <div className="text-[10px] text-muted-foreground">
                {engineReady ? "Redo" : engineBusy ? "Startar…" : "Inte startad"}
              </div>
            </div>
            <button
              onClick={startEngine}
              disabled={engineBusy || engineReady}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-primary text-primary-foreground active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100 flex items-center gap-1.5"
            >
              {engineBusy ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
              {engineReady ? "Klar" : "Starta motor"}
            </button>
          </div>
        </div>
      )}
      {/* SSH-style live-logg */}
      {logs.length > 0 && (
        <div className="rounded-xl border border-border bg-black/80 p-2">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Engine-logg</span>
            <button
              onClick={() => { setLogs([]); sinceRef.current = 0; }}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Rensa
            </button>
          </div>
          <div
            ref={logBoxRef}
            className="font-mono text-[10px] leading-snug text-green-300 max-h-56 overflow-y-auto whitespace-pre-wrap"
          >
            {logs.map((l) => (
              <div key={l.seq} className={l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-yellow-300" : undefined}>
                <span className="text-muted-foreground">+{String(l.t).padStart(5, " ")}ms</span>{" "}
                {l.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lampa (hårdkodad) */}
      {showLamp && (
        <div className={`rounded-xl border p-3 ${connected ? "bg-green-500/10 border-green-500/30" : "bg-secondary/50 border-border"}`}>
          <div className="flex items-center gap-2.5">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? "bg-green-500" : connectBusy ? "bg-yellow-400 animate-pulse" : "bg-muted-foreground/40"}`} />
            <Lightbulb size={16} className={connected ? "text-green-400" : "text-muted-foreground"} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate">3. {device.name}</div>
              <div className="text-[10px] text-muted-foreground font-mono">{device.mac}</div>
            </div>
            {connected ? (
              <button
                onClick={disconnect}
                disabled={connectBusy}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-secondary text-foreground active:scale-95 transition-transform disabled:opacity-40"
              >
                Koppla från
              </button>
            ) : (
              <button
                onClick={connect}
                disabled={connectBusy || !engineReady}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-primary text-primary-foreground active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100 flex items-center gap-1.5"
                title={!engineReady ? "Starta BLE-motorn först" : undefined}
              >
                {connectBusy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                Anslut
              </button>
            )}
          </div>
          {!engineReady && !connected && (
            <div className="text-[10px] text-muted-foreground mt-2 ml-6">Starta BLE-motorn först.</div>
          )}
        </div>
      )}
      {lastError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-[11px] p-2.5">
          ⚠ {lastError}
        </div>
      )}
    </div>
  );
}
