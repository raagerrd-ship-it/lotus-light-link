import { useEffect, useState } from "react";
import { Cpu, AlertCircle, Zap } from "lucide-react";

type Backend = "alsa-vendored" | "alsa-npm" | "none" | null;

interface BleRates {
  sentPerSec: number;
  skipDeltaPerSec: number;
  skipBusyPerSec: number;
  skipInFlightPerSec?: number;
  skipRateLimitPerSec?: number;
  fftDroppedPerSec?: number;
  writeFailPerSec?: number;
  writeStuckPerSec?: number;
  writeLatAvgMs: number;
  writeLatMaxMs?: number;
  fftPerSec?: number;
  tickPerSec?: number;
  tickOkPerSec?: number;
  tickAbortNoMicPerSec?: number;
  tickAbortNoChangePerSec?: number;
  tickAbortNoDevicePerSec?: number;
}

interface StageBreakdown {
  audioToFftMs: number;
  fftToTickMs: number;
  tickInnerMs: number;
  bleWriteMs: number;
}

interface Props {
  piBase: string;
}

/**
 * Visar audio-backend + end-to-end latens + mini-stapeldiagram över hela
 * mic→FFT→tick→BLE-kedjan. Stapeln pulserar i realtid så ögat hinner med
 * istället för att läsa siffror som flimrar varje sekund.
 *
 * Staplar (vänster→höger):
 *   FFT  — frames/s normaliserat mot 2000/tickMs (mål: 2 FFT/tick)
 *   TCK  — engine ticks/s mot 1000/tickMs
 *   PKT  — BLE-paket/s mot 1000/tickMs
 *   DLT  — skip pga oförändrad färg (normalt, blå)
 *   RLM  — skip pga 35ms BLE-rate-limit (normalt vid hög aktivitet, blå)
 *
 * Röd LED-prick: lyser om någon av skipInFlight / writeFail / fftDropped > 0
 * — det är dessa som indikerar verklig kö eller missad kapacitet.
 */
export function MicBackendBadge({ piBase }: Props) {
  const [backend, setBackend] = useState<Backend>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [latencyP95Ms, setLatencyP95Ms] = useState<number | null>(null);
  const [stages, setStages] = useState<StageBreakdown | null>(null);
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
          setLatencyP95Ms(typeof d.audioToBleP95Ms === "number" ? d.audioToBleP95Ms : null);
          setStages(d.stageBreakdown ?? null);
          setTickMs(typeof d.tickMs === "number" ? d.tickMs : null);
          setBle(d.ble ?? null);
        }
      } catch {
        if (!cancelled) {
          setBackend("none");
          setLatencyMs(null);
          setLatencyP95Ms(null);
          setStages(null);
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

  // ── Latens-färg: <= tickMs grönt, <= 2× gult, > destruktivt ───────
  // p95 är det som syns för ögat — använd den för färgning så drift fångas tidigt.
  const latRef = latencyP95Ms ?? latencyMs;
  const latencyClass =
    latRef == null || tickMs == null
      ? ""
      : latRef <= tickMs
        ? "text-primary"
        : latRef <= tickMs * 2
          ? "text-foreground/70"
          : "text-destructive";

  // ── Bygg en tydlig latens-summa: "p50/p95 ms" så ögat fångar drift ───
  const latencyText =
    latencyMs != null && latencyP95Ms != null
      ? `${latencyMs}/${latencyP95Ms}ms`
      : latencyMs != null
        ? `${latencyMs}ms`
        : "—ms";

  const isLagging = latRef != null && tickMs != null && latRef > tickMs * 2;

  const latencySuffix = (
    <span className={`ml-1 inline-flex items-center gap-0.5 ${latencyClass}`}>
      · {latencyText}
      {isLagging ? <Zap size={9} className="text-destructive animate-pulse" /> : null}
    </span>
  );

  // ── Stapel-rendering ──────────────────────────────────────────────
  const pktTarget = tickMs ? 1000 / tickMs : 0;
  const fftTarget = pktTarget * 2; // 2 FFT per tick by design

  const pct = (v: number, target: number) =>
    target > 0 ? Math.max(2, Math.min(100, Math.round((v / target) * 100))) : 0;

  const productiveColor = (ratio: number) =>
    ratio >= 0.8 ? "bg-primary" : ratio >= 0.4 ? "bg-foreground/60" : "bg-destructive";

  const fftRatio = ble && fftTarget ? (ble.fftPerSec ?? 0) / fftTarget : 0;
  const tckRatio = ble && pktTarget ? (ble.tickPerSec ?? 0) / pktTarget : 0;
  const pktRatio = ble && pktTarget ? ble.sentPerSec / pktTarget : 0;

  const skipInFlight = ble?.skipInFlightPerSec ?? 0;
  const writeFail = ble?.writeFailPerSec ?? 0;
  const writeStuck = ble?.writeStuckPerSec ?? 0;
  const fftDropped = ble?.fftDroppedPerSec ?? 0;
  const hasBadSkip = skipInFlight > 0 || writeFail > 0 || writeStuck > 0;

  const Bar = ({ height, colorClass, label }: { height: number; colorClass: string; label: string }) => (
    <div className="flex flex-col items-center justify-end h-3 w-[5px]" title={label}>
      <div
        className={`w-full rounded-sm ${colorClass} transition-all duration-200`}
        style={{ height: `${height}%` }}
      />
    </div>
  );

  const tooltip = ble
    ? [
        `Mål: tick=${tickMs}ms → ${Math.round(pktTarget)} pkt/s, ${Math.round(fftTarget)} FFT/s`,
        ``,
        `PRODUKTIVT:`,
        `  FFT  ${ble.fftPerSec ?? "?"}/s   (${Math.round(fftRatio * 100)}% av mål)`,
        `  TICK ${ble.tickPerSec ?? "?"}/s  (${Math.round(tckRatio * 100)}% av mål)`,
        `  PKT  ${ble.sentPerSec}/s    (${Math.round(pktRatio * 100)}% av mål)`,
        ``,
        `TICK-AVBROTT (per sekund):`,
        `  no-mic:    ${ble.tickAbortNoMicPerSec ?? 0}/s   (mic-frame saknades)`,
        `  busy:      ${skipInFlight}/s   (BLE-slot upptagen)`,
        `  rate-lim:  ${ble.skipRateLimitPerSec ?? 0}/s   (35ms-gate)`,
        `  no-change: ${ble.tickAbortNoChangePerSec ?? 0}/s   (samma färg)`,
        `  no-device: ${ble.tickAbortNoDevicePerSec ?? 0}/s   (ingen lampa)`,
        ``,
        `BLE-FEL:`,
        `  writeFail:  ${writeFail}/s`,
        `  writeStuck: ${writeStuck}/s   (>500ms watchdog tvångs-släppte slot)`,
        `  fftDropped: ${fftDropped}/s   (mic-frame innan tick-fönster)`,
        ``,
        `WRITE-LATENS:`,
        `  avg: ${ble.writeLatAvgMs}ms`,
        `  max (senaste s): ${ble.writeLatMaxMs ?? 0}ms`,
        latencyMs != null ? `audio→BLE: ${latencyMs}ms` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const bars = ble ? (
    <span className="ml-1.5 inline-flex items-end gap-[2px] align-middle" title={tooltip}>
      <Bar height={pct(ble.fftPerSec ?? 0, fftTarget)} colorClass={productiveColor(fftRatio)} label="FFT/s" />
      <Bar height={pct(ble.tickPerSec ?? 0, pktTarget)} colorClass={productiveColor(tckRatio)} label="TICK/s" />
      <Bar height={pct(ble.sentPerSec, pktTarget)} colorClass={productiveColor(pktRatio)} label="PKT/s" />
      <span className="w-[3px]" />
      <Bar height={pct(ble.skipDeltaPerSec, pktTarget)} colorClass="bg-foreground/30" label="skip delta" />
      <Bar height={pct(ble.skipRateLimitPerSec ?? 0, pktTarget)} colorClass="bg-foreground/30" label="skip rate-limit" />
      {hasBadSkip ? (
        <span
          className="ml-1 w-[6px] h-[6px] rounded-full bg-destructive animate-pulse"
          title={`KÖ! in-flight=${skipInFlight}/s writeFail=${writeFail}/s`}
        />
      ) : null}
      {!hasBadSkip && fftDropped > 0 ? (
        <span
          className="ml-1 w-[6px] h-[6px] rounded-full bg-foreground/40"
          title={`fftDropped=${fftDropped}/s — extra mic-frames bidrar till FFT-state men driver ej output`}
        />
      ) : null}
    </span>
  ) : null;

  if (backend === "alsa-vendored" || backend === "alsa-npm") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-primary/15 text-primary border border-primary/30"
        title={`Native ALSA${latencyMs != null ? ` · ${latencyMs}ms audio→BLE` : ""}`}
      >
        <Cpu size={9} /> ALSA{latencySuffix}{bars}
      </span>
    );
  }

  // arecord-fallback finns inte längre — engine vägrar starta utan native binding.

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-muted text-muted-foreground border border-border"
      title="Mikrofon-subsystem ej startat"
    >
      <AlertCircle size={9} /> INAKTIV
    </span>
  );
}
