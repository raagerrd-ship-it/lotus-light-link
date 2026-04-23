/**
 * BleControlPanel — minimal UI för att bevisa BLE-flödet end-to-end.
 *
 * Två block:
 *   1. BLE-motor: knapp "Starta motor" → POST /api/ble/engine/start
 *   2. Lampa (hårdkodad ELK-BLEDOM01): "Anslut" → POST /api/ble/connect
 *      (scan-then-connect mot hårdkodad MAC)
 *
 * Pollar /api/ble/state varannan sekund för status.
 * Engine-loggen är borttagen — felsök via SSH/journalctl istället.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Bluetooth, Loader2, Lightbulb, Play, Power, Gauge, AlertTriangle } from "lucide-react";

interface BleStateResp {
  engineReady: boolean;
  connected: boolean;
  device: { name: string; mac: string };
  rawState?: string;
}

type Section = "engine" | "lamp" | "all";

interface BleOutput {
  active: boolean;
  r: number;
  g: number;
  b: number;
  brightness: number;
  sentCount: number;
  skipDeltaCount?: number;
  skipBusyCount?: number;
  skipLeaseLockedCount?: number;
  controllerOutstandingCount?: number;
  controllerQueuedCount?: number;
  controllerCompleteCount?: number;
  controllerStuckCount?: number;
  outstandingAgeMs?: number;
  writeLatAvgMs?: number;
}

export function BleControlPanel({ piBase, onConnectedChange, onEngineReadyChange, section = "all" }: { piBase: string; onConnectedChange?: (connected: boolean) => void; onEngineReadyChange?: (ready: boolean) => void; section?: Section }) {
  const showEngine = section === "engine" || section === "all";
  const showLamp = section === "lamp" || section === "all";
  const [state, setState] = useState<BleStateResp | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [bleOutput, setBleOutput] = useState<BleOutput>({ active: false, r: 0, g: 0, b: 0, brightness: 0, sentCount: 0 });
  const lastSentCountRef = useRef(0);
  const lastSentRateRef = useRef(0);
  const lastSkipDeltaRateRef = useRef(0);
  const lastSkipBusyRateRef = useRef(0);
  const lastSkipLeaseRateRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${piBase}/api/ble/state`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const ct = r.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) throw new Error("non-json response");
        const data = (await r.json()) as BleStateResp;
        setState(data);
        onConnectedChange?.(data.connected);
        onEngineReadyChange?.(data.engineReady);
      } else {
        throw new Error(`http ${r.status}`);
      }
    } catch {
      // Engine ej nåbar → markera som ej redo / ej ansluten istället för
      // att visa stale state (annars ser UI:t ut som att allt funkar).
      setState((prev) => prev ? { ...prev, engineReady: false, connected: false } : { engineReady: false, connected: false, device: { name: "ELK-BLEDOM01", mac: "BE:67:00:15:09:41" } });
      onConnectedChange?.(false);
      onEngineReadyChange?.(false);
    }
  }, [piBase, onConnectedChange, onEngineReadyChange]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  // Poll BLE-output (sista färg + brightness skickad till lampan) — bara
  // när lampan är ansluten och vi visar lamp-sektionen. ~5 Hz.
  const lampConnected = !!state?.connected;
  useEffect(() => {
    if (!showLamp || !lampConnected) {
      lastSentRateRef.current = 0;
      lastSkipDeltaRateRef.current = 0;
      lastSkipBusyRateRef.current = 0;
      lastSkipLeaseRateRef.current = 0;
      setBleOutput({ active: false, r: 0, g: 0, b: 0, brightness: 0, sentCount: 0 });
      return;
    }
    let cancelled = false;
    let lastCount = 0;
    let lastSkipDelta = 0;
    let lastSkipBusy = 0;
    let lastSkipLease = 0;
    let lastT = performance.now();
    const tick = async () => {
      try {
        const r = await fetch(`${piBase}/api/ble/output`, { signal: AbortSignal.timeout(1500) });
        if (r.ok && !cancelled) {
          const data = (await r.json()) as BleOutput;
          const now = performance.now();
          const dt = (now - lastT) / 1000;
          if (lastCount > 0 && dt > 0) {
            lastSentRateRef.current = Math.round((data.sentCount - lastCount) / dt);
            lastSkipDeltaRateRef.current = Math.round(((data.skipDeltaCount ?? 0) - lastSkipDelta) / dt);
            lastSkipBusyRateRef.current = Math.round(((data.skipBusyCount ?? 0) - lastSkipBusy) / dt);
            lastSkipLeaseRateRef.current = Math.round(((data.skipLeaseLockedCount ?? 0) - lastSkipLease) / dt);
          }
          lastCount = data.sentCount;
          lastSkipDelta = data.skipDeltaCount ?? 0;
          lastSkipBusy = data.skipBusyCount ?? 0;
          lastSkipLease = data.skipLeaseLockedCount ?? 0;
          lastT = now;
          lastSentCountRef.current = data.sentCount;
          setBleOutput(data);
        }
      } catch {}
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [piBase, showLamp, lampConnected]);

  const startEngine = async () => {
    setEngineBusy(true);
    setLastError(null);
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
    }
  };

  const connect = async () => {
    setConnectBusy(true);
    setLastError(null);
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
  const queuedCount = bleOutput.controllerQueuedCount ?? 0;
  const drainLooksBusy = queuedCount > 0;

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

          {/* BLE-output VU-meter — visar att engine faktiskt skickar data till lampan.
              Brightness-staplen + RGB-prick är ground truth: rör sig prick + stapel
              så går färgkommandon ut. Står de still betyder det att engine producerar
              svart/oförändrat → lampan reagerar inte i verkligheten. */}
          {connected && (
            <div className="mt-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[8px] uppercase opacity-50 w-12">Output</span>
                <div
                  className="w-4 h-4 rounded-full border border-border/50 shrink-0 transition-colors"
                  style={{ backgroundColor: `rgb(${bleOutput.r},${bleOutput.g},${bleOutput.b})` }}
                  title={`rgb(${bleOutput.r}, ${bleOutput.g}, ${bleOutput.b})`}
                />
                <span className="text-[10px] font-mono opacity-70 shrink-0">
                  RGB {bleOutput.r},{bleOutput.g},{bleOutput.b}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden min-w-[20px]">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${Math.max(0, Math.min(100, Math.round(bleOutput.brightness)))}%`,
                      backgroundColor: `rgb(${bleOutput.r},${bleOutput.g},${bleOutput.b})`,
                    }}
                  />
                </div>
                <span className="flex items-center gap-1 text-[10px] font-mono shrink-0">
                  <span className="opacity-60">Kö</span>
                  <span className={drainLooksBusy ? "text-destructive font-semibold" : "opacity-70"}>
                    {queuedCount}
                  </span>
                  {queuedCount > 0 && (
                    <AlertTriangle size={12} className="text-destructive" />
                  )}
                </span>
              </div>
              <BleBenchRow piBase={piBase} />
            </div>
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

// ─────────────────────────────────────────────────────────────────────
// BLE Bench — auto-ramp tickMs (HÖG → LÅG).
// Skickar ett paket per tickMs direkt mot lampan (förbi engine + lease)
// och rampar tickMs nedåt (50 → 20ms i 5ms-steg, 5s/steg). Stannar när
// queuedPeak > 2 (=noble köar paket snabbare än radion). pending=8 är
// hårdvarutaket och ignoreras. lastGoodTickMs visar lägsta stabila tick.
// ─────────────────────────────────────────────────────────────────────
interface BenchStep {
  tickMs: number; ratePps: number; sent: number; failed: number;
  failRatePct: number; avgLatencyMs: number; maxLatencyMs: number;
  queuedPeak: number; pendingPeak: number; passed: boolean;
}
interface BenchResult {
  lastGoodTickMs: number; lastGoodRatePps: number; stoppedReason: string;
  steps: BenchStep[];
  startTickMs: number; endTickMs: number; stepMs: number; stepSec: number; maxQueued: number;
  connIntervalMs: number | null;
  connLatency: number | null;
  supervisionTimeoutMs: number | null;
}

function BleBenchRow({ piBase }: { piBase: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const r = await fetch(`${piBase}/api/ble/bench`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startTickMs: 30, endTickMs: 10, stepMs: 2, stepSec: 5, maxQueued: 2 }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const data = await r.json();
      setResult(data);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  }, [piBase]);

  return (
    <div className="mt-2 pt-2 border-t border-border/40">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={run}
          disabled={running}
          className="px-2 py-1 rounded text-[10px] font-semibold bg-secondary text-foreground active:scale-95 transition-transform disabled:opacity-40 flex items-center gap-1"
        >
          {running ? <Loader2 size={10} className="animate-spin" /> : <Gauge size={10} />}
          {running ? 'Mäter…' : 'Bench tick 30→10ms'}
        </button>
        {result && (
          <span className="text-[10px] font-mono opacity-70">
            tak: <span className="text-foreground font-semibold">{result.lastGoodTickMs}ms</span>
            <span className="opacity-60"> · {result.lastGoodRatePps} pps</span>
            <span className="opacity-50"> · {result.stoppedReason}</span>
          </span>
        )}
        {err && <span className="text-[10px] text-destructive">⚠ {err}</span>}
      </div>
      {result && (
        <div className="mt-1 text-[10px] font-mono opacity-70">
          connInterval:{' '}
          <span className={
            result.connIntervalMs == null
              ? 'text-destructive'
              : result.connIntervalMs > 20
                ? 'text-destructive font-semibold'
                : 'text-foreground font-semibold'
          }>
            {result.connIntervalMs == null ? 'okänt' : `${result.connIntervalMs}ms`}
          </span>
          {result.connLatency != null && <span className="opacity-50"> · slaveLat {result.connLatency}</span>}
          {result.supervisionTimeoutMs != null && <span className="opacity-50"> · supTO {result.supervisionTimeoutMs}ms</span>}
        </div>
      )}
      {result && result.steps.length > 0 && (
        <div className="mt-1.5 grid grid-cols-[auto_auto_auto_auto_auto_auto] gap-x-2 gap-y-0.5 text-[9px] font-mono opacity-70">
          <span className="opacity-50">tick</span>
          <span className="opacity-50">pps</span>
          <span className="opacity-50">fail%</span>
          <span className="opacity-50">avgLat</span>
          <span className="opacity-50">queuedPk</span>
          <span className="opacity-50">pendingPk</span>
          {result.steps.map((s) => (
            <Fragment key={s.tickMs}>
              <span className={s.passed ? 'text-foreground' : 'text-destructive'}>{s.tickMs}</span>
              <span>{s.ratePps}</span>
              <span className={s.failRatePct >= 5 ? 'text-destructive' : ''}>{s.failRatePct}</span>
              <span>{s.avgLatencyMs}</span>
              <span className={s.queuedPeak > 2 ? 'text-destructive' : ''}>{s.queuedPeak}</span>
              <span className="opacity-60">{s.pendingPeak}</span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
