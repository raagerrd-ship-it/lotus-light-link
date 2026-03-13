import { useState, useEffect } from "react";
import { useLiveSessionMonitor, type MasterDebugState } from "@/hooks/useLiveSession";
import { supabase } from "@/integrations/supabase/client";
import { Wifi, WifiOff, ChevronDown, ChevronUp, Music, Trash2 } from "lucide-react";

interface SongRecord {
  id: string;
  track_name: string;
  artist_name: string;
  bpm: number | null;
  created_at: string;
  has_sections: boolean;
  has_drops: boolean;
}

function timeSince(isoString?: string): string {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 3000) return "live";
  if (diff < 60000) return `${Math.round(diff / 1000)}s sedan`;
  return "offline";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Idag ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Igår ${time}`;
  return d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }) + ' ' + time;
}

function DebugPanel({ d }: { d: MasterDebugState }) {
  return (
    <div className="font-mono text-[10px] leading-tight text-foreground/70 space-y-0.5">
      <div>BLE: {d.bleConnected ? <span className="text-green-400">{d.bleDeviceName || 'ok'}</span> : <span className="text-red-400">ej ansluten</span>}</div>
      <div>sonos: {d.sonosConnected ? <span className="text-green-400">ok</span> : <span className="text-red-400">offline</span>} {d.sonosRtt != null && <span>RTT {Math.round(d.sonosRtt)}ms</span>}</div>
      <div>
        kurva:{' '}
        {d.curveStatus === 'recording' && <span className="text-orange-400">⏺ spelar in{d.curveSamples ? ` (${d.curveSamples})` : ''}</span>}
        {d.curveStatus === 'saved' && <span className="text-green-400">✓ sparad{d.curveSamples ? ` (${d.curveSamples} st)` : ''}</span>}
        {d.curveStatus === 'loading' && <span className="text-yellow-400">↓ laddar…</span>}
        {d.curveStatus === 'none' && <span className="text-muted-foreground">—</span>}
      </div>
      {d.curveTrackName && <div className="truncate text-foreground/50">{d.curveTrackName}</div>}
      <div>BLE w/s: <span className="text-foreground">{d.bleWritesPerSec ?? 0}</span> e2e: <span className="text-foreground">{Math.round(d.e2eMs ?? 0)}ms</span> tick: <span className="text-foreground">{(d.totalTickMs ?? 0).toFixed(1)}ms</span></div>
    </div>
  );
}

function SongList({ songs, onDelete }: { songs: SongRecord[]; onDelete: (id: string, name: string) => void }) {
  return (
    <div className="space-y-1">
      {songs.map((s) => (
        <div key={s.id} className="flex items-center gap-2 py-1 px-1 rounded-md bg-secondary/30 group">
          <Music className="w-3 h-3 shrink-0 text-muted-foreground/50" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-foreground truncate">{s.track_name}</p>
            <p className="text-[10px] text-muted-foreground truncate">{s.artist_name}</p>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            <div className="text-right">
              <div className="flex items-center gap-1">
                {s.bpm && <span className="text-[9px] font-mono text-muted-foreground">{s.bpm}bpm</span>}
                {s.has_sections && <span className="text-[8px] text-green-400">§</span>}
                {s.has_drops && <span className="text-[8px] text-orange-400">⚡</span>}
              </div>
              <p className="text-[9px] text-muted-foreground/60">{formatDate(s.created_at)}</p>
            </div>
            <button
              onClick={() => onDelete(s.id, s.track_name)}
              className="w-6 h-6 flex items-center justify-center rounded-full text-muted-foreground/40 hover:text-red-400 hover:bg-red-400/10 active:scale-90 transition-all"
              title="Ta bort inspelning"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const SECTION_LABELS: Record<string, string> = {
  intro: 'Intro', verse: 'Vers', pre_chorus: 'Pre-chorus',
  chorus: 'Refräng', bridge: 'Bridge', drop: 'Drop',
  build_up: 'Build-up', break: 'Break', outro: 'Outro',
};

export default function MonitorView() {
  const session = useLiveSessionMonitor();
  const [songs, setSongs] = useState<SongRecord[]>([]);
  const [showSongs, setShowSongs] = useState(true);
  const [showDebug, setShowDebug] = useState(true);

  // Fetch song list
  useEffect(() => {
    const fetchSongs = () => {
      supabase
        .from("song_analysis")
        .select("id, track_name, artist_name, bpm, created_at, sections, drops")
        .order("created_at", { ascending: false })
        .limit(50)
        .then(({ data }) => {
          if (data) {
            setSongs(data.map((d: any) => ({
              id: d.id,
              track_name: d.track_name,
              artist_name: d.artist_name,
              bpm: d.bpm,
              created_at: d.created_at,
              has_sections: !!d.sections,
              has_drops: !!d.drops,
            })));
          }
        });
    };
    fetchSongs();
    const id = setInterval(fetchSongs, 10000); // refresh every 10s
    return () => clearInterval(id);
  }, []);

  if (!session) {
    return (
      <div className="h-[100dvh] bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOff className="w-8 h-8" />
          <p className="text-sm">Väntar på master…</p>
        </div>
      </div>
    );
  }

  const { color_r: r, color_g: g, color_b: b, brightness, track_name, artist_name, album_art_url, section_type, bpm, is_playing, debug_state } = session;
  const scaledR = Math.round(r * (brightness / 100));
  const scaledG = Math.round(g * (brightness / 100));
  const scaledB = Math.round(b * (brightness / 100));
  const liveColor = `rgb(${scaledR},${scaledG},${scaledB})`;
  const status = timeSince((session as any).updated_at);
  const isLive = status === "live";

  return (
    <div
      className="h-[100dvh] bg-background overflow-y-auto flex flex-col"
      style={{
        backgroundImage: `radial-gradient(ellipse at 50% 20%, rgba(${scaledR},${scaledG},${scaledB},0.12) 0%, transparent 60%)`,
      }}
    >
      {/* Status bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-lg border-b border-border/30" style={{ background: 'hsl(var(--background) / 0.85)' }}>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isLive ? 'animate-pulse' : ''}`} style={{ backgroundColor: isLive ? '#22c55e' : 'hsl(var(--muted-foreground))' }} />
          <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
            Monitor {status !== "live" ? `· ${status}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full" style={{ background: liveColor, boxShadow: `0 0 8px ${liveColor}` }} />
          <span className="text-[10px] font-mono text-muted-foreground">{brightness}%</span>
        </div>
      </div>

      {/* Now playing */}
      {track_name ? (
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/20">
          {album_art_url && (
            <img src={album_art_url} alt="Album art" className="w-14 h-14 rounded-xl"
              style={{ boxShadow: `0 0 20px rgba(${r},${g},${b},0.4)` }} />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">{track_name}</p>
            <p className="text-xs text-muted-foreground truncate">{artist_name}</p>
            <div className="flex items-center gap-1.5 mt-1">
              {section_type && (
                <span className="text-[9px] font-medium tracking-wide text-muted-foreground bg-secondary/60 border px-1.5 py-0.5 rounded-full uppercase"
                  style={{ borderColor: `rgba(${r},${g},${b},0.2)` }}>
                  {SECTION_LABELS[section_type] ?? section_type}
                </span>
              )}
              {bpm != null && (
                <span className="text-[9px] font-mono font-bold text-muted-foreground bg-secondary border px-1.5 py-0.5 rounded-full"
                  style={{ borderColor: `rgba(${r},${g},${b},0.3)` }}>
                  {bpm} BPM
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="px-4 py-4 text-center border-b border-border/20">
          <p className="text-xs text-muted-foreground">{is_playing ? "Spelar…" : "Inget spelas"}</p>
        </div>
      )}

      {/* Debug panel */}
      {debug_state && (
        <div className="border-b border-border/20">
          <button onClick={() => setShowDebug(p => !p)} className="w-full flex items-center justify-between px-4 py-2 text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
            <span>Master debug</span>
            {showDebug ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showDebug && (
            <div className="px-4 pb-2">
              <DebugPanel d={debug_state} />
            </div>
          )}
        </div>
      )}

      {/* Song library */}
      <div className="flex-1">
        <button onClick={() => setShowSongs(p => !p)} className="w-full flex items-center justify-between px-4 py-2 text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
          <span>Inspelningar ({songs.length})</span>
          {showSongs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {showSongs && (
          <div className="px-3 pb-4">
            {songs.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">Inga inspelningar ännu</p>
            ) : (
              <SongList songs={songs} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
