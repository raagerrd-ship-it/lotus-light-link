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
  const deviceRef = useRef<HTMLDivElement>(null);
  const reconnectRef = useRef<HTMLDivElement>(null);
  const sonosRef = useRef<HTMLDivElement>(null);
  const bleLineRef = useRef<HTMLDivElement>(null);
  const intervalLineRef = useRef<HTMLDivElement>(null);
  const intervalBarRef = useRef<HTMLDivElement>(null);
  const lastSentSnapshotRef = useRef({ count: 0, time: performance.now() });
  const bleRateValueRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const d = debugData;

      // Device
      if (deviceRef.current) {
        if (d.bleConnected) {
          deviceRef.current.innerHTML = `<span class="text-green-400">${d.bleDeviceName || 'ansluten'}</span>`;
        } else {
          deviceRef.current.innerHTML = `<span class="text-red-400">ej ansluten</span>`;
        }
      }

      // Reconnect status
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

      // Sonos — just connected/volume, no RTT
      if (sonosRef.current) {
        const vol = d.sonosVolume;
        if (vol != null) {
          sonosRef.current.innerHTML = `sonos <span class="text-green-400">ok</span> ${vol}%`;
        } else {
          sonosRef.current.innerHTML = `sonos <span class="text-foreground/40">—</span>`;
        }
      }

      // BLE throughput: w/s + write latency
      if (bleLineRef.current) {
        const now = performance.now();
        const snap = lastSentSnapshotRef.current;
        const dt = (now - snap.time) / 1000;
        if (dt >= 0.5) {
          const delta = d.bleSentCount - snap.count;
          bleRateValueRef.current = Math.round(delta / dt * 10) / 10;
          snap.count = d.bleSentCount;
          snap.time = now;
        }
        const avg = d.bleWriteLatAvgMs;
        const latColor = avg > 30 ? 'text-red-400' : avg > 15 ? 'text-yellow-400' : 'text-green-400';
        const sent = d.bleSentCount;
        const total = sent + d.bleSkipDeltaCount + d.bleSkipThrottleCount + d.bleSkipBusyCount;
        const txPct = total > 0 ? Math.round((sent / total) * 100) : 0;
        bleLineRef.current.innerHTML = `<span class="${latColor}">${bleRateValueRef.current} w/s</span> <span class="text-foreground/40">lat ${Math.round(avg)}ms tx ${txPct}%</span>`;
      }

      // Interval: real time between BLE writes + bar relative to tickMs
      if (intervalLineRef.current) {
        const iv = d.bleEffectiveIntervalMs;
        const tick = d.tickMs || 125;
        // Only flag red if busy-skips are significant (real backpressure)
        const total = d.bleSentCount + d.bleSkipBusyCount;
        const busyPct = total > 0 ? d.bleSkipBusyCount / total : 0;
        const colorClass = busyPct > 0.3 ? 'text-red-400' : busyPct > 0.1 ? 'text-yellow-400' : 'text-green-400';
        intervalLineRef.current.innerHTML = `<span class="${colorClass}">${iv}ms</span> <span class="text-foreground/40">/ ${tick}ms tick</span>`;
      }
      if (intervalBarRef.current) {
        const iv = d.bleEffectiveIntervalMs;
        const tick = d.tickMs || 125;
        // Bar shows how close interval is to tick (100% = perfect, >100% = slower than desired)
        const pct = tick > 0 ? Math.min(100, (tick / Math.max(iv, 1)) * 100) : 0;
        intervalBarRef.current.style.width = `${pct}%`;
        const barColor = pct > 80 ? 'rgb(74,222,128)' : pct > 50 ? 'rgb(250,204,21)' : 'rgb(248,113,113)';
        intervalBarRef.current.style.backgroundColor = barColor;
      }
    };

    const id = setInterval(tick, 200);
    tick();
    return () => clearInterval(id);
  }, []);

  return (
    <div className="fixed bottom-20 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none max-w-[200px]">
      <div ref={deviceRef} />
      <div ref={reconnectRef} style={{ display: 'none' }} />
      <div ref={sonosRef} className="text-foreground/50" />

      <div className="border-t border-border/30 pt-0.5 mt-0.5">
        <div className="text-foreground/40 text-[9px] uppercase tracking-wider">ble</div>
        <div ref={bleLineRef} />
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-foreground/40 shrink-0">int</span>
          <div className="flex-1 h-2 rounded-sm bg-foreground/10 overflow-hidden">
            <div ref={intervalBarRef} className="h-full rounded-sm transition-[width] duration-200" style={{ width: '0%' }} />
          </div>
          <span ref={intervalLineRef} className="shrink-0" />
        </div>
      </div>

      <div className="mt-0.5 text-foreground/30 text-[8px]">
        {(() => { try { const d = new Date(__BUILD_TIME__); return d.toLocaleString('sv-SE', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return '?'; } })()}
      </div>
    </div>
  );
}
