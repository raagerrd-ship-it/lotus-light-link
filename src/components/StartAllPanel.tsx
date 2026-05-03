import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Loader2, XCircle, ChevronDown, ChevronUp } from "lucide-react";

/**
 * StartAllPanel — en knapp som startar hela kedjan i ordning:
 *   Motor → Mic → Sonos → Lampa
 *
 * Kontrakt:
 *  - Föregående steg MÅSTE returnera ok innan nästa körs
 *  - 1 sek paus mellan stegen (låt subsystem stabilisera sig)
 *  - Vid fel: stoppa, visa vilket steg, "Försök igen från här"-knapp
 *
 * Avancerade per-steg-knappar finns kvar bakom <details> i PiMobile.
 */

type StepId = "sonos" | "engine" | "mic" | "lamp";
type StepState = "pending" | "running" | "ok" | "error";
type Phase = "ignition" | "motor";

interface Step {
  id: StepId;
  label: string;
  endpoint: string;
  phase: Phase;
  /** Display-only: ingen POST sker, status hydreras enbart från servern. */
  displayOnly?: boolean;
  /** Acceptera 200 + valfri custom-validation av JSON-body. */
  isOk?: (json: any) => boolean;
}

// Bil-tändning-modell:
//   TÄNDNING: Sonos-pollern (startas automatiskt vid boot — display only här).
//   IGÅNG:    BLE-motor → Mikrofon → Lampa (Sonos PLAYING triggar dessa).
const STEPS: Step[] = [
  {
    id: "sonos",
    label: "Sonos",
    endpoint: "/api/subsystem/sonos/start",
    phase: "ignition",
    displayOnly: true,
  },
  {
    id: "engine",
    label: "Motor",
    endpoint: "/api/ble/engine/start",
    phase: "motor",
    isOk: (j) => j?.ready === true,
  },
  {
    id: "mic",
    label: "Mikrofon",
    endpoint: "/api/subsystem/mic/start",
    phase: "motor",
  },
  {
    id: "lamp",
    label: "Lampa",
    endpoint: "/api/ble/connect",
    phase: "motor",
    isOk: (j) => j?.connected === true,
  },
];

const PAUSE_BETWEEN_MS = 1000;
const STEP_TIMEOUT_MS = 15_000;

interface Props {
  piBase: string;
  /** Anropas när motorn blivit redo så PiMobile kan visa lamp-/subsystem-paneler. */
  onEngineReadyChange?: (ready: boolean) => void;
  /** Anropas när alla steg är ok / inte längre ok. PiMobile döljer Avancerat när allt är ok. */
  onAllOkChange?: (ok: boolean) => void;
}

export function StartAllPanel({ piBase, onEngineReadyChange, onAllOkChange }: Props) {
  const [states, setStates] = useState<Record<StepId, StepState>>({
    engine: "pending",
    mic: "pending",
    sonos: "pending",
    lamp: "pending",
  });
  const [errors, setErrors] = useState<Record<StepId, string | null>>({
    engine: null,
    mic: null,
    sonos: null,
    lamp: null,
  });
  const [running, setRunning] = useState(false);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Hydrera state från servern vid mount så vi inte visar "Starta" när allt redan kör.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [bleR, subR] = await Promise.all([
          fetch(`${piBase}/api/ble/state`).then((r) => r.json()).catch(() => null),
          fetch(`${piBase}/api/subsystem/status`).then((r) => r.json()).catch(() => null),
        ]);
        if (cancelled) return;
        const engineReady = bleR?.engineReady === true;
        const lampConnected = bleR?.connected === true;
        const subs = subR?.subsystems ?? {};
        const isOk = (s: any) => s?.status === "ready";
        setStates((prev) => ({
          ...prev,
          engine: engineReady ? "ok" : prev.engine,
          mic: isOk(subs.mic) ? "ok" : prev.mic,
          sonos: isOk(subs.sonos) ? "ok" : prev.sonos,
          lamp: lampConnected ? "ok" : prev.lamp,
        }));
        if (engineReady) onEngineReadyChange?.(true);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piBase]);

  const allOk =
    states.engine === "ok" &&
    states.mic === "ok" &&
    states.sonos === "ok" &&
    states.lamp === "ok";

  // Auto-minimera när allt blivit ok; öppna upp om något senare går till fel.
  useEffect(() => {
    if (allOk) setCollapsed(true);
    else if (failedAt != null) setCollapsed(false);
    onAllOkChange?.(allOk);
  }, [allOk, failedAt, onAllOkChange]);

  async function runStep(step: Step): Promise<boolean> {
    setStates((s) => ({ ...s, [step.id]: "running" }));
    setErrors((e) => ({ ...e, [step.id]: null }));
    try {
      const r = await fetch(`${piBase}${step.endpoint}`, {
        method: "POST",
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      const j = await r.json().catch(() => ({}));
      const okStatus = r.ok;
      const okBody = step.isOk ? step.isOk(j) : true;
      if (!okStatus || !okBody) {
        const msg =
          j?.error ||
          j?.message ||
          `HTTP ${r.status}` +
            (typeof j === "object" ? ` — ${JSON.stringify(j)}` : "");
        setStates((s) => ({ ...s, [step.id]: "error" }));
        setErrors((e) => ({ ...e, [step.id]: String(msg).slice(0, 200) }));
        return false;
      }
      setStates((s) => ({ ...s, [step.id]: "ok" }));
      if (step.id === "engine") onEngineReadyChange?.(true);
      return true;
    } catch (err: any) {
      const msg =
        err?.name === "TimeoutError"
          ? `Timeout efter ${STEP_TIMEOUT_MS / 1000}s`
          : err?.message || String(err);
      setStates((s) => ({ ...s, [step.id]: "error" }));
      setErrors((e) => ({ ...e, [step.id]: msg.slice(0, 200) }));
      return false;
    }
  }

  async function runFromIndex(startIdx: number) {
    setRunning(true);
    setFailedAt(null);
    try {
      await fetch(`${piBase}/api/diagnostics/manual-start-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          detail: `Starta allt från ${STEPS[startIdx]?.label ?? "okänt steg"}; UI-state=${JSON.stringify(states)}`,
        }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Diagnostiken får aldrig blockera faktisk start.
    }
    // Återställ alla körbara steg från startIdx och framåt (skippa displayOnly).
    setStates((s) => {
      const next = { ...s };
      for (let i = startIdx; i < STEPS.length; i++) {
        if (!STEPS[i].displayOnly) next[STEPS[i].id] = "pending";
      }
      return next;
    });

    for (let i = startIdx; i < STEPS.length; i++) {
      const step = STEPS[i];
      if (step.displayOnly) continue; // Sonos startas redan i tändning
      const ok = await runStep(step);
      if (!ok) {
        setFailedAt(i);
        setRunning(false);
        return;
      }
      // 1 sek paus mellan stegen — utom efter sista
      if (i < STEPS.length - 1) {
        await sleep(PAUSE_BETWEEN_MS);
      }
    }
    setRunning(false);
  }

  const startAll = () => runFromIndex(0);
  const retryFromFailed = () => {
    if (failedAt != null) runFromIndex(failedAt);
  };

  // Minimerad vy: allt ok + collapsed → tunn pill med expandera-knapp + "Starta om"
  if (allOk && collapsed) {
    return (
      <div className="rounded-xl border border-border bg-card/40 px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
          <span>Allt igång — Motor, Mic, Sonos, Lampa</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setCollapsed(false)}>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Starta allt</h2>
        <div className="flex items-center gap-2">
          {!running && !allOk && failedAt == null && (
            <Button size="sm" onClick={startAll}>
              Starta
            </Button>
          )}
          {!running && failedAt != null && (
            <Button size="sm" variant="destructive" onClick={retryFromFailed}>
              Försök igen från {STEPS[failedAt].label}
            </Button>
          )}
          {!running && allOk && (
            <>
              <Button size="sm" variant="outline" onClick={startAll}>
                Starta om
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setCollapsed(true)}>
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {running && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Pågår…
            </span>
          )}
        </div>
      </div>

      {(["ignition", "motor"] as const).map((phase) => {
        const phaseSteps = STEPS.map((s, idx) => ({ s, idx })).filter(
          (x) => x.s.phase === phase,
        );
        return (
          <div key={phase} className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
              {phase === "ignition" ? "Tändning" : "Igång"}
            </div>
            <ol className="space-y-1.5">
              {phaseSteps.map(({ s: step, idx }) => {
                const state = states[step.id];
                const err = errors[step.id];
                return (
                  <li key={step.id} className="space-y-0.5">
                    <div className="flex items-center gap-2 text-xs">
                      <StepIcon state={state} />
                      <span
                        className={
                          state === "ok"
                            ? "text-foreground"
                            : state === "error"
                            ? "text-destructive"
                            : state === "running"
                            ? "text-foreground"
                            : "text-muted-foreground"
                        }
                      >
                        {idx + 1}. {step.label}
                      </span>
                      {state === "running" && (
                        <span className="text-muted-foreground">— startar…</span>
                      )}
                      {state === "ok" && (
                        <span className="text-muted-foreground">— klar</span>
                      )}
                    </div>
                    {state === "error" && err && (
                      <div className="ml-6 text-[11px] text-destructive break-words">
                        {err}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </div>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "running")
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />;
  if (state === "ok")
    return <CheckCircle2 className="h-3.5 w-3.5 text-primary" />;
  if (state === "error")
    return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
