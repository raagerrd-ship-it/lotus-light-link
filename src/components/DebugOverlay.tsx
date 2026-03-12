import type { SongSection } from "@/lib/songSections";

interface DebugOverlayProps {
  smoothedRtt: number;
  autoDriftMs: number;
  syncOffsetMs: number;
  currentSection: SongSection | null;
}

export default function DebugOverlay({ smoothedRtt, autoDriftMs, syncOffsetMs, currentSection }: DebugOverlayProps) {
  return (
    <div className="fixed bottom-16 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none">
      <div>RTT: <span className="text-foreground">{Math.round(smoothedRtt)}ms</span></div>
      <div>drift: <span className="text-foreground">{autoDriftMs >= 0 ? "+" : ""}{Math.round(autoDriftMs)}ms</span></div>
      <div>offset: <span className="text-foreground">{syncOffsetMs >= 0 ? "+" : ""}{syncOffsetMs}ms</span></div>
      <div>section: <span className="text-foreground">{currentSection ? `${currentSection.type} (e${currentSection.energy.toFixed(1)})` : "—"}</span></div>
    </div>
  );
}
