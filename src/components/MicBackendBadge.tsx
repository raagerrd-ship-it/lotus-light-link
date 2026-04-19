import { useEffect, useState } from "react";
import { Cpu, Terminal, AlertCircle } from "lucide-react";

type Backend = "alsa-vendored" | "alsa-npm" | "arecord" | "none" | null;

interface Props {
  piBase: string;
}

/**
 * Visar vilken audio-backend Pi-engine använder:
 *  - ALSA (native) — vendored fork eller npm-paket, direkt snd_pcm_readi
 *  - ARECORD — subprocess-fallback via node-record-lpcm16
 *  - INACTIVE — mic-subsystemet är inte startat
 */
export function MicBackendBadge({ piBase }: Props) {
  const [backend, setBackend] = useState<Backend>(null);

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
        }
      } catch {
        /* mic ej startat eller engine offline — visa inaktiv */
        if (!cancelled) setBackend("none");
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [piBase]);

  if (!backend) return null;

  if (backend === "alsa-vendored" || backend === "alsa-npm") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-primary/15 text-primary border border-primary/30"
        title="Native ALSA (direct snd_pcm_readi) — låg latens"
      >
        <Cpu size={9} /> ALSA
      </span>
    );
  }

  if (backend === "arecord") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/15 text-amber-500 border border-amber-500/30"
        title="arecord-subprocess (fallback) — högre latens. Bygg native alsa-capture för bättre prestanda."
      >
        <Terminal size={9} /> ARECORD
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
