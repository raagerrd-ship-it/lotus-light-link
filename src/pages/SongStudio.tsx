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

function SongStudio() {
  const [seqs, setSeqs] = useState<Seq[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadList = useCallback(() => {
    fetch(`${piBase}/api/light-seq/list`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .then((d) => setSeqs(Array.isArray(d.sequences) ? d.sequences : []))
      .catch(() => {});
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

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
              <div className="flex items-center justify-end text-[10px] text-muted-foreground mb-1">
                <span>rå → polerad</span>
              </div>
              <StatRow label="Längd" raw={detail.raw ? Math.round(detail.raw.durationMs / 1000) : undefined} polished={detail.polished ? Math.round(detail.polished.durationMs / 1000) : undefined} suffix="s" />
              <StatRow label="Frames" raw={detail.raw?.frameCount} polished={detail.polished?.frameCount} />
              <StatRow label="Glapp" raw={detail.raw?.gaps} polished={detail.polished?.gaps} />
              <StatRow label="Beats" raw={detail.raw?.beats} polished={detail.polished?.beats} />
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
