import type { SongSection } from "@/lib/songSections";

interface DebugOverlayProps {
  smoothedRtt: number;
  autoDriftMs: number;
  currentSection: SongSection | null;
  currentSection: SongSection | null;
  palette?: [number, number, number][];
  paletteIndex?: number;
  source?: 'local' | 'cloud';
}

export default function DebugOverlay({ smoothedRtt, autoDriftMs, currentSection, palette, paletteIndex = 0, source }: DebugOverlayProps) {
  return (
    <div className="fixed bottom-16 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none">
      <div>RTT: <span className="text-foreground">{Math.round(smoothedRtt)}ms</span>{source && <span className={source === 'local' ? ' text-green-400' : ' text-yellow-400'}> {source}</span>}</div>
      <div>drift: <span className="text-foreground">{autoDriftMs >= 0 ? "+" : ""}{Math.round(autoDriftMs)}ms</span></div>
      <div>offset: <span className="text-foreground">{syncOffsetMs >= 0 ? "+" : ""}{syncOffsetMs}ms</span></div>
      <div>section: <span className="text-foreground">{currentSection ? `${currentSection.type} (e${currentSection.energy.toFixed(1)})` : "—"}</span></div>
      {palette && palette.length > 0 && (
        <div className="flex items-center gap-1 mt-0.5">
          <span>palette:</span>
          {palette.map((c, i) => (
            <div
              key={i}
              className="w-2.5 h-2.5 rounded-sm"
              style={{
                backgroundColor: `rgb(${c[0]},${c[1]},${c[2]})`,
                outline: i === paletteIndex ? "1.5px solid white" : "none",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
