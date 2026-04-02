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
  const peakLatRef = useRef(0);
  const peakDecayRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const el = rootRef.current;
      if (!el) return;
      const d = debugData;

      // ── STATUS ──
      let statusDot: string, statusText: string;
      if (!d.bleConnected) {
        statusDot = 'bg-red-500'; statusText = `<span class="text-red-400">ej ansluten</span>`;
      } else if (d.bleSentCount > 0) {
        const total = d.bleSentCount + d.bleSkipDeltaCount + d.bleSkipThrottleCount + d.bleSkipBusyCount;
        const txPct = total > 0 ? Math.round((d.bleSentCount / total) * 100) : 0;
        statusDot = 'bg-green-500'; statusText = `<span class="text-green-400">ok</span> <span class="text-foreground/40">${txPct}% tx</span>`;
      } else {
        statusDot = 'bg-yellow-500'; statusText = `<span class="text-yellow-400">väntar</span>`;
      }

      // ── RECONNECT ──
      let reconnectHtml = '';
      const rs = d.bleReconnectStatus;
      if (!d.bleConnected && rs) {
        const phase = phaseLabels[rs.phase] || rs.phase;
        reconnectHtml = `<div class="text-yellow-400 mt-0.5">#${rs.attempt} ${phase}`;
        if (rs.targetName) reconnectHtml += ` → <span class="text-foreground/50">${rs.targetName}</span>`;
        if (rs.error && rs.phase !== 'advScan') reconnectHtml += `<div class="text-red-300 truncate">${rs.error}</div>`;
        reconnectHtml += '</div>';
      }

      // ── HEADROOM (sliding peak) ──
      const lat = d.bleWriteLatMs;
      const tickTarget = d.tickMs || 125;
      if (lat > peakLatRef.current) { peakLatRef.current = lat; peakDecayRef.current = 0; }
      else { peakDecayRef.current++; if (peakDecayRef.current > 5) peakLatRef.current *= 0.9; }
      const peak = peakLatRef.current;
      const loadPct = tickTarget > 0 ? Math.min(150, (peak / tickTarget) * 100) : 0;
      const headroom = Math.max(0, 100 - loadPct);
      const barPct = Math.min(100, loadPct);
      const barColor = loadPct > 90 ? 'rgb(248,113,113)' : loadPct > 60 ? 'rgb(250,204,21)' : 'rgb(74,222,128)';

      // ── INPUT ──
      const micBar = Math.min(100, d.micRms * 5000);
      const bassBar = Math.min(100, d.bassLevel * 3000);
      const midBar = Math.min(100, d.midHiLevel * 3000);

      // ── BLE OUTPUT ──
      const c = d.bleSentColor || [0, 0, 0];
      const br = d.bleSentBright ?? 0;
      const base = d.bleBaseColor || c;
      const colorSwatch = `rgb(${base[0]},${base[1]},${base[2]})`;

      // ── COUNTERS ──
      const sent = d.bleSentCount;
      const skipD = d.bleSkipDeltaCount;
      const skipB = d.bleSkipBusyCount;

      // ── BUILD ──
      let buildTime = '';
      try { const dt = new Date(__BUILD_TIME__); buildTime = dt.toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { buildTime = '?'; }

      el.innerHTML = `
        <div class="flex items-center gap-1">
          <span class="inline-block w-2 h-2 rounded-full ${statusDot}"></span>
          ${statusText}
          ${d.bleDeviceName ? `<span class="text-foreground/30 ml-auto truncate max-w-[60px]">${d.bleDeviceName}</span>` : ''}
        </div>
        ${reconnectHtml}

        <div class="mt-1.5 text-foreground/40 text-[9px] uppercase tracking-wider">Headroom</div>
        <div class="flex items-center gap-1 mt-0.5">
          <div class="flex-1 h-2.5 rounded-sm bg-foreground/10 overflow-hidden">
            <div class="h-full rounded-sm transition-[width] duration-200" style="width:${barPct}%;background:${barColor}"></div>
          </div>
          <span style="color:${barColor}" class="text-[10px] font-bold w-7 text-right">${Math.round(headroom)}%</span>
        </div>
        <div class="text-foreground/30 text-right text-[9px]">${Math.round(peak)}ms / ${tickTarget}ms tick</div>

        <div class="mt-1.5 text-foreground/40 text-[9px] uppercase tracking-wider">Mic input</div>
        <div class="mt-0.5 space-y-px">
          ${miniBar('rms', micBar, 'rgb(147,197,253)')}
          ${miniBar('bas', bassBar, 'rgb(252,165,165)')}
          ${miniBar('mid', midBar, 'rgb(253,224,71)')}
        </div>

        <div class="mt-1.5 text-foreground/40 text-[9px] uppercase tracking-wider">BLE output</div>
        <div class="flex items-center gap-1.5 mt-0.5">
          <div class="w-4 h-4 rounded-sm border border-foreground/20" style="background:${colorSwatch}"></div>
          <div class="flex-1">
            <div class="h-2 rounded-sm bg-foreground/10 overflow-hidden">
              <div class="h-full rounded-sm bg-blue-400/80 transition-[width] duration-100" style="width:${br}%"></div>
            </div>
          </div>
          <span class="text-foreground/50 w-7 text-right">${br}%</span>
        </div>
        <div class="text-foreground/30 text-[9px] mt-0.5">sent ${sent} · skip ${skipD}Δ ${skipB}⏳</div>
        ${d.bleEffectiveIntervalMs > 0 ? `<div class="text-foreground/30 text-[9px]">interval ${Math.round(d.bleEffectiveIntervalMs)}ms</div>` : ''}

        <div class="mt-1 text-foreground/20 text-[8px]">${buildTime}</div>
      `;
    };

    const id = setInterval(tick, 200);
    tick();
    return () => clearInterval(id);
  }, []);

  return (
    <div
      ref={rootRef}
      className="fixed bottom-20 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none w-[190px]"
    />
  );
}

function miniBar(label: string, pct: number, color: string): string {
  return `<div class="flex items-center gap-1">
    <span class="text-foreground/30 w-5 text-[9px]">${label}</span>
    <div class="flex-1 h-1.5 rounded-sm bg-foreground/10 overflow-hidden">
      <div class="h-full rounded-sm" style="width:${Math.round(pct)}%;background:${color}"></div>
    </div>
  </div>`;
}
