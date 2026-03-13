import { useLiveSessionMonitor, type LiveSessionState } from "@/hooks/useLiveSession";
import { Wifi, WifiOff } from "lucide-react";

function timeSince(isoString?: string): string {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 3000) return "live";
  if (diff < 60000) return `${Math.round(diff / 1000)}s sedan`;
  return "offline";
}

export default function MonitorView() {
  const session = useLiveSessionMonitor();

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

  const { color_r: r, color_g: g, color_b: b, brightness, track_name, artist_name, album_art_url, section_type, bpm, is_playing } = session;
  const accent = `rgb(${r},${g},${b})`;
  const scaledR = Math.round(r * (brightness / 100));
  const scaledG = Math.round(g * (brightness / 100));
  const scaledB = Math.round(b * (brightness / 100));
  const liveColor = `rgb(${scaledR},${scaledG},${scaledB})`;
  const status = timeSince((session as any).updated_at);
  const isLive = status === "live";

  const SECTION_LABELS: Record<string, string> = {
    intro: 'Intro', verse: 'Vers', pre_chorus: 'Pre-chorus',
    chorus: 'Refräng', bridge: 'Bridge', drop: 'Drop',
    build_up: 'Build-up', break: 'Break', outro: 'Outro',
  };

  return (
    <div
      className="h-[100dvh] bg-background overflow-hidden flex flex-col"
      style={{
        backgroundImage: `radial-gradient(ellipse at 50% 40%, rgba(${scaledR},${scaledG},${scaledB},0.15) 0%, transparent 70%)`,
      }}
    >
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-lg border-b border-border/30" style={{ background: 'hsl(var(--background) / 0.6)' }}>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isLive ? 'animate-pulse' : ''}`} style={{ backgroundColor: isLive ? '#22c55e' : 'hsl(var(--muted-foreground))' }} />
          <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
            Monitor {status !== "live" ? `· ${status}` : ""}
          </span>
        </div>
        <Wifi className="w-3.5 h-3.5 text-muted-foreground" />
      </div>

      {/* Main glow area */}
      <div className="flex-1 flex items-center justify-center relative">
        <div
          className="rounded-full transition-all duration-300"
          style={{
            width: Math.max(80, brightness * 2.5),
            height: Math.max(80, brightness * 2.5),
            background: `radial-gradient(circle, ${liveColor} 0%, rgba(${scaledR},${scaledG},${scaledB},0.3) 50%, transparent 70%)`,
            boxShadow: `0 0 ${brightness}px ${liveColor}, 0 0 ${brightness * 2}px rgba(${scaledR},${scaledG},${scaledB},0.3)`,
          }}
        />
        {/* Brightness % */}
        <span className="absolute bottom-8 text-xs font-mono text-muted-foreground/60">
          {brightness}%
        </span>
      </div>

      {/* Now playing footer */}
      <div className="shrink-0 backdrop-blur-lg border-t border-border/30 pb-[env(safe-area-inset-bottom)]" style={{ background: 'hsl(var(--background) / 0.6)' }}>
        {track_name ? (
          <div className="flex items-center gap-3 px-4 py-3">
            {album_art_url && (
              <img
                src={album_art_url}
                alt="Album art"
                className="w-12 h-12 rounded-xl"
                style={{
                  boxShadow: `0 0 16px rgba(${r},${g},${b},0.4)`,
                }}
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground truncate">{track_name}</p>
              <p className="text-xs text-muted-foreground truncate">{artist_name}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {section_type && (
                <span
                  className="text-[10px] font-medium tracking-wide text-muted-foreground bg-secondary/60 border px-2 py-0.5 rounded-full uppercase"
                  style={{ borderColor: `rgba(${r},${g},${b},0.2)` }}
                >
                  {SECTION_LABELS[section_type] ?? section_type}
                </span>
              )}
              {bpm != null && (
                <span
                  className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground bg-secondary border px-2 py-0.5 rounded-full"
                  style={{ borderColor: `rgba(${r},${g},${b},0.3)` }}
                >
                  {bpm} BPM
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="px-4 py-4 text-center">
            <p className="text-xs text-muted-foreground">
              {is_playing ? "Spelar…" : "Inget spelas"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
