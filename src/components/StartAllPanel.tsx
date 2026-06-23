import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

/**
 * StartAllPanel — en knapp som startar hela kedjan i ordning:
 *   Motor → Mic → Lampa (Sonos-pollern kör redan från boot).
 * Varje steg måste returnera ok innan nästa körs.
 */

type StepId = "engine" | "mic" | "lamp";

interface Step {
  id: StepId;
  label: string;
  endpoint: string;
  isOk?: (json: any) => boolean;
}

const STEPS: Step[] = [
  { id: "engine", label: "Motor", endpoint: "/api/ble/engine/start", isOk: (j) => j?.ready === true },
  { id: "mic", label: "Mikrofon", endpoint: "/api/subsystem/mic/start" },
  { id: "lamp", label: "Lampa", endpoint: "/api/ble/connect", isOk: (j) => j?.connected === true },
];

const PAUSE_BETWEEN_MS = 1000;
const STEP_TIMEOUT_MS = 15_000;

interface Props {
  piBase: string;
  /** Anropas när motorn blivit redo så PiMobile kan aktivera resten. */
  onEngineReadyChange?: (ready: boolean) => void;
}

export function StartAllPanel({ piBase, onEngineReadyChange }: Props) {
  const [running, setRunning] = useState(false);
  const [allOk, setAllOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrera från servern vid mount så vi inte visar "Starta" när allt redan kör.
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
        const micOk = subR?.subsystems?.mic?.status === "ready";
        if (engineReady) onEngineReadyChange?.(true);
        setAllOk(engineReady && lampConnected && micOk);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piBase]);

  async function runStep(step: Step): Promise<boolean> {
    try {
      const r = await fetch(`${piBase}${step.endpoint}`, {
        method: "POST",
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (step.isOk && !step.isOk(j))) {
        setError(`${step.label}: ${String(j?.error || j?.message || `HTTP ${r.status}`).slice(0, 160)}`);
        return false;
      }
      if (step.id === "engine") onEngineReadyChange?.(true);
      return true;
    } catch (err: any) {
      const msg =
        err?.name === "TimeoutError" ? `Timeout efter ${STEP_TIMEOUT_MS / 1000}s` : err?.message || String(err);
      setError(`${step.label}: ${String(msg).slice(0, 160)}`);
      return false;
    }
  }

  async function startAll() {
    setRunning(true);
    setError(null);
    setAllOk(false);
    for (let i = 0; i < STEPS.length; i++) {
      const ok = await runStep(STEPS[i]);
      if (!ok) {
        setRunning(false);
        return;
      }
      if (i < STEPS.length - 1) await sleep(PAUSE_BETWEEN_MS);
    }
    setAllOk(true);
    setRunning(false);
  }

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm">
        {allOk ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <span className="text-foreground">Allt igång</span>
          </>
        ) : error ? (
          <>
            <XCircle className="h-4 w-4 text-destructive" />
            <span className="text-destructive break-words">{error}</span>
          </>
        ) : (
          <span className="font-semibold text-foreground">Starta allt</span>
        )}
      </div>
      <Button size="sm" onClick={startAll} disabled={running} variant={allOk ? "outline" : "default"}>
        {running ? (
          <span className="flex items-center gap-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Pågår…
          </span>
        ) : allOk ? (
          "Starta om"
        ) : error ? (
          "Försök igen"
        ) : (
          "Starta"
        )}
      </Button>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
