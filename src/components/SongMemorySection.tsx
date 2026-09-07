import { useState, useEffect, useCallback } from "react";
import { Music, Loader2, Trash2 } from "lucide-react";
import { Panel, Toggle } from "@/components/piUi";

/**
 * LÅTMINNET — vad motorn VET om en låt, i stället för vad den gissar i realtid.
 *
 * Listan finns för ETT syfte: att kunna slänga ett värde. Ett felaktigt tempo i
 * minnet är värre än inget värde, eftersom det används med hög konfidens och
 * därför inte rättas av realtidsanalysen. Analysen kan slå fel på en enskild
 * inspelning — ett kort klipp, en tyst intro, en låt utan stabil puls.
 */

interface Song {
  key: string; artist: string; title: string;
  bpm: number; bpmSource: string;
  analysedSeconds: number; analysedAt: string;
  beats: number; drops: number; downbeats: number; parts: string[];
  /** Uppmatt tidsforskjutning som showen kompenserar for. null = inte mätt än. */
  syncOffsetMs: number | null;
}

export function SongMemorySection({ piBase }: { piBase: string }) {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<{ beatMode: string; songBpm: number; track: string | null } | null>(null);
  /**
   * De tva reglagen. null = inte hamtade an, sa vi inte ritar ett falskt lage
   * innan motorn svarat.
   */
  const [toggles, setToggles] = useState<{ record: boolean; use: boolean } | null>(null);

  useEffect(() => {
    fetch(`${piBase}/api/calibration`, { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json())
      .then((d) => {
        const c = d?.cal ?? d ?? {};
        setToggles({ record: c.recordEnabled !== false, use: c.useRecording !== false });
      })
      .catch(() => { /* utan svar later vi reglagen vara dolda */ });
  }, [piBase]);

  const setToggle = useCallback((key: 'recordEnabled' | 'useRecording', v: boolean) => {
    setToggles((t) => (t ? { ...t, [key === 'recordEnabled' ? 'record' : 'use']: v } : t));
    // PUT:en slar ihop mot befintlig kalibrering, sa tva falt racker att skicka.
    fetch(`${piBase}/api/calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: v }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => { /* reglaget visar redan det onskade laget; nasta laddning rattar */ });
  }, [piBase]);

  const load = useCallback(() => {
    fetch(`${piBase}/api/songs`, { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json())
      .then((d) => { setAvailable(!!d?.available); setSongs(d?.songs ?? []); })
      .catch(() => setAvailable(false));
  }, [piBase]);

  useEffect(() => { load(); }, [load]);

  // Vilket läge motorn faktiskt kör i just nu.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch(`${piBase}/api/status`, { signal: AbortSignal.timeout(4000) })
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          const f = d?.analyserFrame ?? d?.analyser ?? {};
          setMode({
            beatMode: f.beatMode ?? (f.songBpm > 0 ? "minne" : "analys"),
            songBpm: f.songBpm ?? 0,
            track: d?.sonos?.trackName ?? d?.live?.track ?? null,
          });
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [piBase]);

  const forget = async (key: string) => {
    setBusy(key);
    try {
      await fetch(`${piBase}/api/songs/forget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      load();
    } finally { setBusy(null); }
  };

  const known = mode?.beatMode === "minne";

  return (
    <Panel
      title="Låtminne"
      icon={<Music size={12} />}
      action={
        <span className="text-[10px] font-mono text-muted-foreground">
          {songs ? `${songs.length} låtar` : ""}
        </span>
      }
    >
      {/* Vilket läge motorn kör i NU — det är den frågan man ställer sig först. */}
      <div
        className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl ring-1 ring-inset ${
          known ? "bg-primary/10 ring-primary/40" : "bg-foreground/[0.03] ring-border"
        }`}
      >
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {known ? "Kör på minne" : "Kör på realtidsanalys"}
          </div>
          <div className="text-[13px] truncate">{mode?.track ?? "—"}</div>
        </div>
        {known && (
          <span className="font-mono text-[13px] shrink-0 tabular-nums">
            {mode!.songBpm.toFixed(1)} BPM
          </span>
        )}
      </div>

      {toggles && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-border">
            <div className="min-w-0">
              <div className="text-[13px]">Spela in</div>
              <div className="text-[10px] text-muted-foreground">
                Nya låtar spelas in och analyseras. Redan lagrade påverkas inte.
              </div>
            </div>
            <Toggle checked={toggles.record} onChange={(v) => setToggle('recordEnabled', v)} />
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-border">
            <div className="min-w-0">
              <div className="text-[13px]">Använd inspelning</div>
              <div className="text-[10px] text-muted-foreground">
                Av = realtidsanalys även för låtar som finns i minnet. Verkar direkt.
              </div>
            </div>
            <Toggle checked={toggles.use} onChange={(v) => setToggle('useRecording', v)} />
          </div>
        </div>
      )}

      {available === false && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Minnet kunde inte läsas. Motorn kör på realtidsanalys, precis som förut.
        </p>
      )}

      {songs === null && available !== false && (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 size={11} className="animate-spin" /> Hämtar
        </p>
      )}

      {songs?.length === 0 && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Inga låtar analyserade än. Låtar läggs till efter att de spelats och analyserats.
        </p>
      )}

      {songs && songs.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {songs.map((s) => (
            <div
              key={s.key}
              className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-border"
            >
              <div className="min-w-0">
                <div className="text-[13px] truncate">{s.title}</div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {s.artist}
                  {/* Sektioner är bara meningsfulla om analysen sett hela låten —
                      ett 40-sekundersklipp ÄR introt, och modellen svarar då
                      helt riktigt "intro". Visa längden så värdet kan bedömas. */}
                  {s.analysedSeconds > 0 && ` · ${s.analysedSeconds}s`}
                  {s.drops > 0 && ` · ${s.drops} drops`}
                  {s.parts.length > 0 && ` · ${s.parts.join("/")}`}
                  {s.syncOffsetMs != null && ` · synk ${s.syncOffsetMs > 0 ? "+" : ""}${s.syncOffsetMs} ms`}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-[13px] tabular-nums">{s.bpm.toFixed(1)}</span>
                <button
                  onClick={() => forget(s.key)}
                  disabled={busy === s.key}
                  aria-label={`Glöm ${s.artist} – ${s.title}`}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40 transition-colors"
                >
                  {busy === s.key ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
