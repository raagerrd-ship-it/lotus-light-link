import { useState } from "react";
import { useLiveSessionMonitor, type MasterDebugState } from "@/hooks/useLiveSession";
import { WifiOff, ChevronDown, ChevronUp } from "lucide-react";

function timeSince(isoString?: string): string {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 3000) return "live";
  if (diff < 60000) return `${Math.round(diff / 1000)}s sedan`;
  return "offline";
}

function DebugPanel({ d }: { d: MasterDebugState }) {
  return (
    <div className="font-mono text-[10px] leading-tight text-foreground/70 space-y-0.5">
      <div>BLE: {d.bleConnected ? <span className="text-green-400">{d.bleDeviceName || 'ok'}</span> : <span className="text-red-400">ej ansluten</span>}</div>
      <div>sonos: {d.sonosConnected ? <span className="text-green-400">ok</span> : <span className="text-red-400">offline</span>} {d.sonosRtt != null && <span>RTT {Math.round(d.sonosRtt)}ms</span>}</div>
      <div>BLE w/s: <span className="text-foreground">{d.bleWritesPerSec ?? 0}</span> e2e: <span className="text-foreground">{Math.round(d.e2eMs ?? 0)}ms</span> tick: <span className="text-foreground">{(d.totalTickMs ?? 0).toFixed(1)}ms</span></div>
      <div className="mt-1 pt-1 border-t border-border/30">
        <div>BLE latens: <span className="text-foreground">{Math.round(d.bleLatencyMs ?? 0)}ms</span></div>
        {d.bleMinIntervalMs != null && <div>BLE intervall: <span className="text-foreground">{d.bleMinIntervalMs}ms</span></div>}
      </div>
      <div className="mt-1 pt-1 border-t border-border/30">
        {d.maxBrightness != null && <div>max ljus: <span className="text-foreground">{d.maxBrightness}%</span></div>}
        {d.dynamicDamping != null && d.dynamicDamping > 1 && <div>dämpa: <span className="text-foreground">{d.dynamicDamping.toFixed(1)}x</span></div>}
        {d.attackAlpha != null && <div>attack: <span className="text-foreground">{d.attackAlpha.toFixed(3)}</span></div>}
        {d.releaseAlpha != null && <div>release: <span className="text-foreground">{d.releaseAlpha.toFixed(3)}</span></div>}
        {d.sonosVolume != null && <div>volym: <span className="text-foreground">{d.sonosVolume}%</span></div>}
      </div>
    </div>
  );
}

// Rewrite localhost art URLs to use monitor's own proxy or skip
function rewriteArtUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const monitorProxy = localStorage.getItem('sonosLocalProxy');
      if (monitorProxy) {
        const proxyOrigin = new URL(monitorProxy).origin;
        return `${proxyOrigin}${parsed.pathname}${parsed.search}`;
      }
      return `${window.location.origin}${parsed.pathname}${parsed.search}`;
    }
  } catch { /* not a valid URL, return as-is */ }
  return url;
}

export default function MonitorView() {
  const session = useLiveSessionMonitor();
  const [showDebug, setShowDebug] = useState(true);

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

  const { color_r: r, color_g: g, color_b: b, brightness, track_name, artist_name, album_art_url, is_playing, debug_state } = session;
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
            <img src={rewriteArtUrl(album_art_url)} alt="Album art" className="w-14 h-14 rounded-xl"
              style={{ boxShadow: `0 0 20px rgba(${r},${g},${b},0.4)` }} />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">{track_name}</p>
            <p className="text-xs text-muted-foreground truncate">{artist_name}</p>
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
    </div>
  );
}
