import { useEffect, useState } from "react";
import { Cpu, AlertCircle } from "lucide-react";

type Backend = "alsa-vendored" | "alsa-npm" | "none" | null;

interface Props {
  piBase: string;
}

/**
 * Visar audio-backend (ALSA / inaktiv).
 * Pollar /api/mic/level en gång per 5s — vi behöver bara veta om mic-en är aktiv,
 * inte realtids-staplar. Latens/BLE-stats togs bort som brus.
 */
export function MicBackendBadge({ piBase }: Props) {
  const [backend, setBackend] = useState<Backend>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${piBase}/api/mic/level`, { signal: AbortSignal.timeout(1500) });
        if (r.ok && !cancelled) {
          const d = await r.json();
          setBackend(d.backend ?? "none");
        }
      } catch {
        if (!cancelled) setBackend("none");
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
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

  if (backend === "alsa-vendored" || backend === "alsa-npm") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-primary/15 text-primary border border-primary/30"
        title="Native ALSA mic aktiv"
      >
        <Cpu size={9} /> ALSA
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
