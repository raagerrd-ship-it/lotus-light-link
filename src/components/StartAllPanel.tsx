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

type StepId = "engine" | "mic" | "sonos" | "lamp";
type StepState = "pending" | "running" | "ok" | "error";

interface Step {
  id: StepId;
  label: string;
  endpoint: string;
  /** Acceptera 200 + valfri custom-validation av JSON-body. */
  isOk?: (json: any) => boolean;
}

const STEPS: Step[] = [
  {
    id: "engine",
    label: "Motor",
    endpoint: "/api/ble/engine/start",
    isOk: (j) => j?.ready === true,
  },
  {
    id: "mic",
    label: "Mikrofon",
    endpoint: "/api/subsystem/mic/start",
  },
  {
    id: "sonos",
    label: "Sonos",
    endpoint: "/api/subsystem/sonos/start",
  },
  {
    id: "lamp",
    label: "Lampa",
    endpoint: "/api/ble/connect",
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
    // Återställ alla steg från startIdx och framåt
    setStates((s) => {
      const next = { ...s };
      for (let i = startIdx; i < STEPS.length; i++) next[STEPS[i].id] = "pending";
      return next;
    });

    for (let i = startIdx; i < STEPS.length; i++) {
      const ok = await runStep(STEPS[i]);
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

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Starta allt</h2>
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
          <Button size="sm" variant="outline" onClick={startAll}>
            Starta om
          </Button>
        )}
        {running && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Pågår…
          </span>
        )}
      </div>

      <ol className="space-y-1.5">
        {STEPS.map((step, idx) => {
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
