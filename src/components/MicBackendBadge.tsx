import { useEffect, useState } from "react";
import { Cpu, Terminal, AlertCircle } from "lucide-react";

type Backend = "alsa-vendored" | "alsa-npm" | "arecord" | "none" | null;

interface Props {
  piBase: string;
}

/**
 * Visar vilken audio-backend Pi-engine använder + end-to-end latens
 * (audio-in → BLE-write):
 *  - ALSA · Nms — native (vendored fork eller npm), direkt snd_pcm_readi
 *  - ARECORD · Nms — subprocess-fallback via node-record-lpcm16
 *  - INACTIVE — mic-subsystemet är inte startat
 */
export function MicBackendBadge({ piBase }: Props) {
  const [backend, setBackend] = useState<Backend>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${piBase}/api/mic/level`, {
          signal: AbortSignal.timeout(1500),
        });
        if (r.ok && !cancelled) {
          const d = await r.json();
          setBackend(d.backend ?? "none");
          setLatencyMs(typeof d.audioToBleLatencyMs === "number" ? d.audioToBleLatencyMs : null);
        }
      } catch {
        if (!cancelled) {
          setBackend("none");
          setLatencyMs(null);
        }
      }
    };
    tick();
    // 1s poll — vi vill se latensen ändras i nästan realtid
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [piBase]);

  if (!backend) return null;

  // Färga latens-siffran efter målet 25ms (BLEDOM teoretiskt minimum)
  const latencyClass =
    latencyMs == null
      ? ""
      : latencyMs <= 25
        ? "text-primary"
        : latencyMs <= 50
          ? "text-foreground/70"
          : "text-destructive";

  const latencySuffix =
    latencyMs != null ? (
      <span className={`ml-1 ${latencyClass}`}>· {latencyMs}ms</span>
    ) : null;

  if (backend === "alsa-vendored" || backend === "alsa-npm") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-primary/15 text-primary border border-primary/30"
        title={`Native ALSA (direct snd_pcm_readi)${latencyMs != null ? ` — ${latencyMs}ms audio→BLE` : ""}`}
      >
        <Cpu size={9} /> ALSA{latencySuffix}
      </span>
    );
  }

  if (backend === "arecord") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-destructive/15 text-destructive border border-destructive/30"
        title={`arecord-subprocess (fallback)${latencyMs != null ? ` — ${latencyMs}ms audio→BLE` : ""}`}
      >
        <Terminal size={9} /> ARECORD{latencySuffix}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-muted text-muted-foreground border border-border"
      title="Mikrofon-subsystem ej startat"
    >
      <AlertCircle size={9} /> INAKTIV
    </span>
  );
}
