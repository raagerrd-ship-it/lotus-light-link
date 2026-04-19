import { useEffect, useState } from "react";
import { Cpu, Terminal, AlertCircle } from "lucide-react";

type Backend = "alsa-vendored" | "alsa-npm" | "arecord" | "none" | null;

interface BleRates {
  sentPerSec: number;
  skipDeltaPerSec: number;
  skipBusyPerSec: number;
  writeLatAvgMs: number;
}

interface Props {
  piBase: string;
}

/**
 * Visar audio-backend + end-to-end latens + BLE pkt/s.
 * Pkt/s-badge avslöjar var paketen tar vägen:
 *   pkt/s lågt + skipDelta högt  → samma färg upprepas (engine OK, inget nytt att skicka)
 *   pkt/s lågt + skipBusy högt   → BLE writeAsync långsammare än tick (BLEDOM cap)
 *   pkt/s lågt + båda låga       → engine tickar inte (FFT/audio-problem)
 */
export function MicBackendBadge({ piBase }: Props) {
  const [backend, setBackend] = useState<Backend>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [tickMs, setTickMs] = useState<number | null>(null);
  const [ble, setBle] = useState<BleRates | null>(null);

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
          setBle(d.ble ?? null);
        }
      } catch {
        if (!cancelled) {
          setBackend("none");
          setLatencyMs(null);
          setBle(null);
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

  if (!backend) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-muted text-muted-foreground border border-border"
        title="Väntar på /api/mic/level…"
      >
        <AlertCircle size={9} /> …
      </span>
    );
  }

  // Latensen JÄMFÖRS MOT TICK-RATE — det är taket för hur snabbt vi kan reagera.
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

  // BLE pkt/s — färgkodad mot tick-rate-taket (1000/tickMs)
  const targetPps = tickMs ? Math.round(1000 / tickMs) : 0;
  const pktClass =
    !ble || !targetPps
      ? "text-foreground/60"
      : ble.sentPerSec >= targetPps * 0.8
        ? "text-primary"
        : ble.sentPerSec >= targetPps * 0.4
          ? "text-foreground/70"
          : "text-destructive";

  const pktTitle = ble
    ? `BLE: ${ble.sentPerSec} pkt/s (mål ${targetPps}) · skipDelta ${ble.skipDeltaPerSec}/s · skipBusy ${ble.skipBusyPerSec}/s · writeLat ${ble.writeLatAvgMs}ms`
    : "";

  const pktSuffix = ble ? (
    <span className={`ml-1 ${pktClass}`} title={pktTitle}>
      · {ble.sentPerSec}p/s
      {ble.skipBusyPerSec > 0 ? <span className="opacity-60"> b{ble.skipBusyPerSec}</span> : null}
      {ble.skipDeltaPerSec > 0 ? <span className="opacity-60"> d{ble.skipDeltaPerSec}</span> : null}
    </span>
  ) : null;

  if (backend === "alsa-vendored" || backend === "alsa-npm") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-primary/15 text-primary border border-primary/30"
        title={`Native ALSA (direct snd_pcm_readi)${latencyTitle}`}
      >
        <Cpu size={9} /> ALSA{latencySuffix}{pktSuffix}
      </span>
    );
  }

  if (backend === "arecord") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-destructive/15 text-destructive border border-destructive/30"
        title={`arecord-subprocess (fallback)${latencyTitle}`}
      >
        <Terminal size={9} /> ARECORD{latencySuffix}{pktSuffix}
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
