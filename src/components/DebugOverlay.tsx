import { useEffect, useRef } from "react";
import { debugData } from "@/lib/ui/debugStore";

declare const __BUILD_TIME__: string;

const phaseLabels: Record<string, string> = {
  getDevices: 'Hämtar enheter…',
  directGatt: 'GATT-anslutning…',
  advScan: 'Söker BLE-signal…',
  waiting: 'Väntar…',
  done: 'Ansluten',
  failed: 'Misslyckades',
};

export default function DebugOverlay() {
  const statusRef = useRef<HTMLDivElement>(null);
  const reconnectRef = useRef<HTMLDivElement>(null);
  const headroomBarRef = useRef<HTMLDivElement>(null);
  const headroomLabelRef = useRef<HTMLSpanElement>(null);
  const peakLatRef = useRef(0);
  const peakDecayRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const d = debugData;

      // --- STATUS: simple "working" / "not working" ---
      if (statusRef.current) {
        if (!d.bleConnected) {
          statusRef.current.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-red-500 mr-1 align-middle"></span><span class="text-red-400">ej ansluten</span>`;
        } else {
          // "Working" = sent at least 1 write recently (rate > 0)
          // We check if bleSentCount is increasing
          const total = d.bleSentCount + d.bleSkipDeltaCount + d.bleSkipThrottleCount + d.bleSkipBusyCount;
          const txPct = total > 0 ? Math.round((d.bleSentCount / total) * 100) : 0;
          const isActive = d.bleSentCount > 0;
          if (isActive) {
            statusRef.current.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1 align-middle"></span><span class="text-green-400">ok</span> <span class="text-foreground/40">${txPct}% tx</span>`;
          } else {
            statusRef.current.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-yellow-500 mr-1 align-middle"></span><span class="text-yellow-400">väntar</span>`;
          }
        }
      }

      // --- RECONNECT ---
      if (reconnectRef.current) {
        const rs = d.bleReconnectStatus;
        if (!d.bleConnected && rs) {
          const phase = phaseLabels[rs.phase] || rs.phase;
          let html = `<span class="text-yellow-400">#${rs.attempt} ${phase}`;
          if (rs.targetName) html += `<span class="text-foreground/50"> → ${rs.targetName}</span>`;
          if (rs.error && rs.phase !== 'advScan') html += `<div class="text-red-300 truncate">${rs.error}</div>`;
          html += '</span>';
          reconnectRef.current.innerHTML = html;
          reconnectRef.current.style.display = '';
        } else {
          reconnectRef.current.style.display = 'none';
        }
      }

      // --- HEADROOM: how close to breaking point ---
      // Uses sliding peak of write latency vs tick interval
      if (headroomBarRef.current && headroomLabelRef.current) {
        const lat = d.bleWriteLatMs;
        const tickTarget = d.tickMs || 125;

        // Sliding peak: fast attack, slow decay (decays ~20% per poll = 1/s decay)
        if (lat > peakLatRef.current) {
          peakLatRef.current = lat;
          peakDecayRef.current = 0;
        } else {
          peakDecayRef.current++;
          // Decay after 5 polls (1s), drop 10% per poll
          if (peakDecayRef.current > 5) {
            peakLatRef.current *= 0.9;
          }
        }

        const peak = peakLatRef.current;
        // Load = peak latency / tick interval (100% = at limit, >100% = overloaded)
        const loadPct = tickTarget > 0 ? Math.min(150, (peak / tickTarget) * 100) : 0;
        // Headroom = how much capacity is left (invert of load)
        const headroom = Math.max(0, 100 - loadPct);

        // Bar width = load (fills up as we approach limit)
        const barPct = Math.min(100, loadPct);
        headroomBarRef.current.style.width = `${barPct}%`;

        // Color: green = plenty of room, yellow = getting close, red = at/over limit
        const barColor = loadPct > 90 ? 'rgb(248,113,113)' : loadPct > 60 ? 'rgb(250,204,21)' : 'rgb(74,222,128)';
        headroomBarRef.current.style.backgroundColor = barColor;

        const peakMs = Math.round(peak);
        headroomLabelRef.current.innerHTML = `<span style="color:${barColor}">${Math.round(headroom)}%</span> <span class="text-foreground/40">${peakMs}/${tickTarget}ms</span>`;
      }
    };

    const id = setInterval(tick, 200);
    tick();
    return () => clearInterval(id);
  }, []);

  return (
    <div className="fixed bottom-20 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none max-w-[180px]">
      <div ref={statusRef} />
      <div ref={reconnectRef} style={{ display: 'none' }} />

      <div className="mt-1">
        <div className="flex items-center gap-1">
          <span className="text-foreground/40 shrink-0 text-[9px]">headroom</span>
          <div className="flex-1 h-2.5 rounded-sm bg-foreground/10 overflow-hidden">
            <div ref={headroomBarRef} className="h-full rounded-sm transition-[width] duration-200" style={{ width: '0%' }} />
          </div>
        </div>
        <span ref={headroomLabelRef} className="block text-right mt-0.5" />
      </div>

      <div className="mt-0.5 text-foreground/30 text-[8px]">
        {(() => { try { const d = new Date(__BUILD_TIME__); return d.toLocaleString('sv-SE', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return '?'; } })()}
      </div>
    </div>
  );
}
