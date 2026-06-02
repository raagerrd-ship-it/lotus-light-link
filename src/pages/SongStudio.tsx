/**
 * SongStudio — Låt-studio. Granska, förhandsgranska och ångra finslipade
 * ljus-sekvenser. Finslipningen sker automatiskt på Pi:n vid varje inspelning;
 * här ser du analysen (före/efter) och kan spela upp eller återställa.
 */
import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Play, Undo2, Trash2, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { apiBase } from "@/lib/apiBase";

const PI_FONT = '"Noto Sans", "DejaVu Sans", "Liberation Sans", system-ui, sans-serif';

type Seq = { key: string; frames: number; durationMs: number };
type Analysis = {
  durationMs: number;
  frameCount: number;
  gaps: number;
  beats: number;
  bpm: number;
  brightnessMin: number;
  brightnessAvg: number;
  brightnessMax: number;
  flicker: number;
};
type Detail = { raw: Analysis | null; polished: Analysis | null };

const piBase = apiBase;

function StatRow({ label, raw, polished, suffix = "" }: { label: string; raw?: number; polished?: number; suffix?: string }) {
  return (
    <div className="flex items-center justify-between text-xs py-1 border-b border-border/40 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        <span className="text-muted-foreground">{raw ?? "–"}{suffix}</span>
        <span className="mx-1.5 text-muted-foreground">→</span>
        <span className="text-foreground font-medium">{polished ?? "–"}{suffix}</span>
      </span>
    </div>
  );
}

/** Vertikal ljusprofil 0–100: band min→max med snittlinje. */
function BrightnessBand({ a, label, accent }: { a: Analysis; label: string; accent: boolean }) {
  const H = 96;
  const y = (v: number) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const top = y(a.brightnessMax);
  const bottom = y(a.brightnessMin);
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="48" height={H} className="overflow-visible">
        <rect x="14" y="0" width="20" height={H} rx="3" className="fill-border/30" />
        <rect
          x="14" y={top} width="20" height={Math.max(2, bottom - top)} rx="3"
          className={accent ? "fill-primary/70" : "fill-muted-foreground/50"}
        />
        <line
          x1="10" x2="38" y1={y(a.brightnessAvg)} y2={y(a.brightnessAvg)}
          className={accent ? "stroke-primary" : "stroke-foreground"} strokeWidth="2"
        />
      </svg>
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="text-[10px] tabular-nums text-foreground font-medium">{a.brightnessAvg}</span>
    </div>
  );
}

/** Före/efter-diagram: ljusprofil + flimmer jämförelse. */
function BeforeAfter({ raw, polished }: { raw: Analysis | null; polished: Analysis | null }) {
  if (!raw && !polished) return null;
  const maxFlicker = Math.max(1, raw?.flicker ?? 0, polished?.flicker ?? 0);
  const flickerBar = (v: number | undefined, accent: boolean) => (
    <div className="flex-1">
      <div className="h-2 rounded-full bg-border/30 overflow-hidden">
        <div
          className={`h-full rounded-full ${accent ? "bg-primary/70" : "bg-muted-foreground/50"}`}
          style={{ width: `${((v ?? 0) / maxFlicker) * 100}%` }}
        />
      </div>
    </div>
  );
  return (
    <div className="mb-4 rounded-lg bg-background/40 p-3">
      <div className="text-[10px] text-muted-foreground mb-2">Ljusprofil (min–max, snitt)</div>
      <div className="flex items-end justify-center gap-8">
        {raw && <BrightnessBand a={raw} label="Rå" accent={false} />}
        {polished && <BrightnessBand a={polished} label="Polerad" accent={true} />}
      </div>
      <div className="mt-3">
        <div className="text-[10px] text-muted-foreground mb-1">Flimmer (lägre = jämnare)</div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-12 text-muted-foreground">Rå</span>
          {flickerBar(raw?.flicker, false)}
          <span className="w-8 text-right tabular-nums text-muted-foreground">{raw?.flicker ?? "–"}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] mt-1">
          <span className="w-12 text-foreground">Polerad</span>
          {flickerBar(polished?.flicker, true)}
          <span className="w-8 text-right tabular-nums text-foreground font-medium">{polished?.flicker ?? "–"}</span>
        </div>
      </div>
    </div>
  );
}

type RecState = { recording: boolean; currentKey: string | null; bufferFrames: number; playingBack: boolean };

function SongStudio() {
  const [seqs, setSeqs] = useState<Seq[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rec, setRec] = useState<RecState | null>(null);
  const [sync, setSync] = useState<{ enabled: boolean; leadMs: number; confidence: number; warmup?: boolean } | null>(null);

  const loadList = useCallback(() => {
    fetch(`${piBase}/api/light-seq/list`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .then((d) => setSeqs(Array.isArray(d.sequences) ? d.sequences : []))
      .catch(() => {});
    fetch(`${piBase}/api/record`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .then((d) => setRec(d))
      .catch(() => {});
    fetch(`${piBase}/api/playback-sync`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .then((d) => setSync(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, 2000);
    return () => clearInterval(t);
  }, [loadList]);

  const toggleSync = (enabled: boolean) => {
    setSync((s) => (s ? { ...s, enabled } : s));
    fetch(`${piBase}/api/playback-sync`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).catch(() => {});
  };

  const openDetail = (key: string) => {
    setSelected(key);
    setDetail(null);
    fetch(`${piBase}/api/light-seq/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .then((d) => setDetail(d))
      .catch(() => setDetail({ raw: null, polished: null }));
  };

  const preview = (variant: "raw" | "polished") => {
    if (!selected) return;
    setBusy(`preview-${variant}`);
    fetch(`${piBase}/api/light-seq/${encodeURIComponent(selected)}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant }),
    }).finally(() => setTimeout(() => setBusy(null), 600));
  };

  const revert = () => {
    if (!selected) return;
    setBusy("revert");
    fetch(`${piBase}/api/light-seq/${encodeURIComponent(selected)}/revert`, { method: "POST" })
      .then(() => openDetail(selected))
      .finally(() => setBusy(null));
  };

  const del = (key: string) => {
    fetch(`${piBase}/api/light-seq/${encodeURIComponent(key)}`, { method: "DELETE" })
      .then(() => { if (selected === key) { setSelected(null); setDetail(null); } loadList(); })
      .catch(() => {});
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto" style={{ fontFamily: PI_FONT }}>
      <div className="flex items-center justify-between mb-6">
        <Link to="/" className="flex items-center gap-2 text-muted-foreground active:text-foreground">
          <ArrowLeft size={20} />
        </Link>
        <span className="text-sm font-semibold bg-accent text-accent-foreground px-3 py-1 rounded-full flex items-center gap-1.5">
          <Sparkles size={14} /> Låt-studio
        </span>
        <span className="w-5" />
      </div>

      <p className="text-[11px] text-muted-foreground mb-4">
        Inspelade ljus-shower finslipas automatiskt. Här ser du analysen (rå → polerad), kan förhandsgranska på slingan och ångra till råinspelningen.
      </p>

      <div className="text-[11px] rounded-lg bg-secondary/40 px-3 py-2 mb-4">
        {!rec ? (
          <span className="text-muted-foreground">Kontaktar motorn…</span>
        ) : !rec.recording ? (
          <span className="text-destructive">● Inspelning är AV — slå på "Spela in ljus-sekvenser" på startsidan.</span>
        ) : rec.currentKey ? (
          <span className="text-green-500">● Spelar in: {rec.currentKey.replace("__", " — ")} ({rec.bufferFrames} frames)</span>
        ) : (
          <span className="text-muted-foreground">● Inspelning på, väntar på låt-info (Sonos-metadata eller ACR).</span>
        )}
      </div>

      {sync && (
        <div className="rounded-lg bg-secondary/40 px-3 py-3 mb-4">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[11px] text-muted-foreground">Auto-synk (mäter Sonos-fördröjning)</span>
            <input
              type="checkbox" checked={sync.enabled}
              onChange={(e) => toggleSync(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
          </label>
          {sync.enabled && (
            <p className="text-[10px] text-muted-foreground mt-1.5 tabular-nums">
              Uppmätt fördröjning: <span className="text-foreground font-medium">{-sync.leadMs} ms</span>
              {" · "}säkerhet: <span className="text-foreground font-medium">{Math.round(Math.max(0, sync.confidence) * 100)}%</span>
            </p>
          )}
        </div>
      )}


      {seqs.length === 0 && (
        <p className="text-xs text-muted-foreground">Inga inspelade sekvenser än.</p>
      )}


      <div className="space-y-1.5">
        {seqs.map((s) => (
          <button
            key={s.key}
            onClick={() => openDetail(s.key)}
            className={`w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors ${selected === s.key ? "bg-accent/60" : "bg-secondary/50"}`}
          >
            <div className="min-w-0">
              <div className="text-xs truncate">{s.key.replace("__", " — ")}</div>
              <div className="text-[10px] text-muted-foreground">{Math.round(s.durationMs / 1000)}s · {s.frames} frames</div>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <section className="mt-5 bg-secondary/40 rounded-xl p-4">
          <h2 className="text-xs font-semibold mb-3 truncate">{selected.replace("__", " — ")}</h2>

          {detail ? (
            <div className="mb-4">
              <BeforeAfter raw={detail.raw} polished={detail.polished} />
              <div className="flex items-center justify-end text-[10px] text-muted-foreground mb-1">
                <span>rå → polerad</span>
              </div>
              <StatRow label="Längd" raw={detail.raw ? Math.round(detail.raw.durationMs / 1000) : undefined} polished={detail.polished ? Math.round(detail.polished.durationMs / 1000) : undefined} suffix="s" />
              <StatRow label="Frames" raw={detail.raw?.frameCount} polished={detail.polished?.frameCount} />
              <StatRow label="Glapp" raw={detail.raw?.gaps} polished={detail.polished?.gaps} />
              <StatRow label="Beats" raw={detail.raw?.beats} polished={detail.polished?.beats} />
              <StatRow label="Tempo" raw={detail.raw?.bpm} polished={detail.polished?.bpm} suffix=" BPM" />

              <StatRow label="Ljus min" raw={detail.raw?.brightnessMin} polished={detail.polished?.brightnessMin} />
              <StatRow label="Ljus snitt" raw={detail.raw?.brightnessAvg} polished={detail.polished?.brightnessAvg} />
              <StatRow label="Ljus max" raw={detail.raw?.brightnessMax} polished={detail.polished?.brightnessMax} />
              <StatRow label="Flimmer" raw={detail.raw?.flicker} polished={detail.polished?.flicker} />
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground mb-4">Laddar analys…</p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => preview("raw")}
              disabled={busy !== null || !detail?.raw}
              className="flex items-center justify-center gap-1.5 text-xs bg-secondary rounded-lg py-2 active:scale-95 disabled:opacity-40"
            >
              <Play size={14} /> Rå
            </button>
            <button
              onClick={() => preview("polished")}
              disabled={busy !== null || !detail?.polished}
              className="flex items-center justify-center gap-1.5 text-xs bg-primary text-primary-foreground rounded-lg py-2 active:scale-95 disabled:opacity-40"
            >
              <Play size={14} /> Polerad
            </button>
            <button
              onClick={revert}
              disabled={busy !== null || !detail?.raw}
              className="flex items-center justify-center gap-1.5 text-xs bg-secondary rounded-lg py-2 active:scale-95 disabled:opacity-40"
            >
              <Undo2 size={14} /> Ångra
            </button>
            <button
              onClick={() => del(selected)}
              className="flex items-center justify-center gap-1.5 text-xs text-destructive bg-destructive/10 rounded-lg py-2 active:scale-95"
            >
              <Trash2 size={14} /> Radera
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

export default SongStudio;
