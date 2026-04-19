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
  const [tickMs, setTickMs] = useState<number | null>(null);

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
          setTickMs(typeof d.tickMs === "number" ? d.tickMs : null);
        }
      } catch {
        if (!cancelled) {
          setBackend("none");
          setLatencyMs(null);
        }
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [piBase]);

  if (!backend) return null;

  // Latensen JÄMFÖRS MOT TICK-RATE — det är taket för hur snabbt vi kan reagera.
  // ≤ tick     → vi hänger med (grönt)
  // ≤ 2× tick  → en frame efter (neutral)
  // > 2× tick  → vi släpar (rött)
  const latencyClass =
    latencyMs == null || tickMs == null
      ? ""
      : latencyMs <= tickMs
        ? "text-primary"
        : latencyMs <= tickMs * 2
          ? "text-foreground/70"
          : "text-destructive";

  const latencyTitle =
    latencyMs != null && tickMs != null
      ? ` — ${latencyMs}ms audio→BLE (tick=${tickMs}ms)`
      : latencyMs != null
        ? ` — ${latencyMs}ms audio→BLE`
        : "";

  const latencySuffix =
    latencyMs != null ? (
      <span className={`ml-1 ${latencyClass}`}>· {latencyMs}ms</span>
    ) : null;

  if (backend === "alsa-vendored" || backend === "alsa-npm") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-primary/15 text-primary border border-primary/30"
        title={`Native ALSA (direct snd_pcm_readi)${latencyTitle}`}
      >
        <Cpu size={9} /> ALSA{latencySuffix}
      </span>
    );
  }

  if (backend === "arecord") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-destructive/15 text-destructive border border-destructive/30"
        title={`arecord-subprocess (fallback)${latencyTitle}`}
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
