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
  const rootRef = useRef<HTMLDivElement>(null);
  const deviceRef = useRef<HTMLDivElement>(null);
  const reconnectRef = useRef<HTMLDivElement>(null);
  const sonosRef = useRef<HTMLDivElement>(null);
  const rttRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef<HTMLDivElement>(null);
  const bleOutSwatchRef = useRef<HTMLDivElement>(null);
  const bleOutBarRef = useRef<HTMLDivElement>(null);
  const bleOutSourceRef = useRef<HTMLSpanElement>(null);
  const bleOutContainerRef = useRef<HTMLDivElement>(null);
  const bleOutWaitRef = useRef<HTMLDivElement>(null);
  const bleStatsRef = useRef<HTMLDivElement>(null);
  const bleRateRef = useRef<HTMLDivElement>(null);
  const lastSentSnapshotRef = useRef({ count: 0, time: performance.now() });
  const bleRateValueRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const d = debugData;

      if (deviceRef.current) {
        if (d.bleConnected) {
          deviceRef.current.innerHTML = `<span class="text-green-400">${d.bleDeviceName || 'ansluten'}</span>`;
        } else {
          deviceRef.current.innerHTML = `<span class="text-red-400">ej ansluten</span>`;
        }
      }

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

      if (sonosRef.current) {
        const vol = d.sonosVolume;
        if (vol != null) {
          sonosRef.current.innerHTML = `sonos: <span class="text-green-400">ok</span><span class="text-foreground"> ${vol}%</span><span class="text-foreground/40"> ${d.gainMode}</span>`;
        } else {
          sonosRef.current.innerHTML = `sonos: <span class="text-foreground/50">—</span>`;
        }
      }
      if (rttRef.current) {
        rttRef.current.textContent = `RTT: ${Math.round(d.smoothedRtt)}ms`;
      }

      if (playbackRef.current) {
        const ps = d.sonosPlaybackState;
        if (!ps) {
          playbackRef.current.innerHTML = '<span class="text-foreground/40">— no state</span>';
        } else if (ps.includes('PLAYING')) {
          playbackRef.current.innerHTML = '<span class="text-green-400">▶ playing</span>';
        } else if (ps.includes('PAUSED')) {
          playbackRef.current.innerHTML = '<span class="text-yellow-400">⏸ paused</span>';
        } else if (ps.includes('IDLE') || ps.includes('STOPPED')) {
          playbackRef.current.innerHTML = '<span class="text-red-400">⏹ idle</span>';
        } else {
          playbackRef.current.innerHTML = `<span class="text-foreground/40">${ps}</span>`;
        }
      }


      const sc = d.bleSentColor;
      if (sc) {
        if (bleOutContainerRef.current) bleOutContainerRef.current.style.display = '';
        if (bleOutWaitRef.current) bleOutWaitRef.current.style.display = 'none';
        const bc = d.bleBaseColor ?? sc;
        const rgb = `rgb(${bc[0]},${bc[1]},${bc[2]})`;
        if (bleOutSwatchRef.current) bleOutSwatchRef.current.style.backgroundColor = rgb;
        if (bleOutBarRef.current) {
          const pct = d.tickMs > 0 ? Math.min(100, (d.bleWriteLatMs / d.tickMs) * 100) : 0;
          bleOutBarRef.current.style.width = `${pct}%`;
          const barColor = pct > 80 ? '#f87171' : pct > 50 ? '#facc15' : '#4ade80';
          bleOutBarRef.current.style.backgroundColor = barColor;
        }
        if (bleOutSourceRef.current) {
          const src = d.bleColorSource;
          if (src && src !== 'normal') {
            bleOutSourceRef.current.textContent = src;
            bleOutSourceRef.current.className = `shrink-0 text-yellow-400`;
            bleOutSourceRef.current.style.display = '';
          } else {
            bleOutSourceRef.current.style.display = 'none';
          }
        }
      } else {
        if (bleOutContainerRef.current) bleOutContainerRef.current.style.display = 'none';
        if (bleOutWaitRef.current) bleOutWaitRef.current.style.display = '';
      }

      // BLE send/skip stats
      if (bleStatsRef.current) {
        const sent = d.bleSentCount;
        const skipD = d.bleSkipDeltaCount;
        const skipT = d.bleSkipThrottleCount;
        const skipB = d.bleSkipBusyCount;
        const total = sent + skipD + skipT + skipB;
        const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
        bleStatsRef.current.textContent = `tx ${sent} skip ${skipD + skipT} busy ${skipB} (${pct}%)`;
      }

      // BLE writes/sec (computed over each poll interval)
      if (bleRateRef.current) {
        const now = performance.now();
        const snap = lastSentSnapshotRef.current;
        const dt = (now - snap.time) / 1000;
        if (dt >= 0.5) {
          const delta = d.bleSentCount - snap.count;
          bleRateValueRef.current = Math.round(delta / dt * 10) / 10;
          snap.count = d.bleSentCount;
          snap.time = now;
        }
        const lat = d.bleWriteLatMs;
        const avg = d.bleWriteLatAvgMs;
        const colorClass = avg > 30 ? 'text-red-400' : avg > 15 ? 'text-yellow-400' : 'text-green-400';
        bleRateRef.current.innerHTML = `${bleRateValueRef.current} w/s <span class="${colorClass}">${Math.round(lat)}ms (avg ${Math.round(avg)}ms)</span>`;
      }
    };

    const id = setInterval(tick, 200);
    tick();
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={rootRef} className="fixed top-14 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none max-w-[220px]">
      <div className="text-foreground/40 text-[9px] uppercase tracking-wider mb-0.5">enhet</div>
      <div ref={deviceRef} />
      <div ref={reconnectRef} style={{ display: 'none' }} />

      <div className="border-t border-border/30 pt-0.5 mt-0.5">
        <div className="text-foreground/40 text-[9px] uppercase tracking-wider mb-0.5">input</div>
        <div ref={sonosRef} />
        <div ref={rttRef} />
        <div ref={playbackRef} />
      </div>


      <div className="border-t border-border/30 pt-0.5 mt-0.5">
        <div className="text-foreground/40 text-[9px] uppercase tracking-wider mb-0.5">ble output</div>
        <div ref={bleOutContainerRef} className="flex items-center gap-1.5" style={{ display: 'none' }}>
          <div ref={bleOutSwatchRef} className="w-3 h-3 rounded-sm border border-border/40 shrink-0" />
          <div className="flex-1 h-2.5 rounded-sm bg-foreground/10 overflow-hidden">
            <div ref={bleOutBarRef} className="h-full rounded-sm transition-[width] duration-100" style={{ width: '0%' }} />
          </div>
          <span ref={bleOutSourceRef} style={{ display: 'none' }} />
        </div>
        <div ref={bleOutWaitRef} className="text-foreground/50">väntar…</div>
        <div ref={bleStatsRef} className="text-foreground/40" />
        <div ref={bleRateRef} className="text-foreground/40" />
      </div>

      <div className="mt-0.5 border-t border-border/30 pt-0.5 text-foreground/40">
        {(() => { try { const d = new Date(__BUILD_TIME__); return d.toLocaleString('sv-SE', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }); } catch { return '?'; } })()}
      </div>
    </div>
  );
}
