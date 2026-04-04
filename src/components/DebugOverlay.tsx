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
  // Rolling window: snapshot counters every 10s, compute skip%/wps from delta
  const windowRef = useRef({
    time: performance.now(),
    sent: 0, skipRms: 0, skipBusy: 0,
  });
  const statsRef = useRef({ skipPct: 0, wps: 0 });

  useEffect(() => {
    const tick = () => {
      const el = rootRef.current;
      if (!el) return;
      const d = debugData;

      // ── Rolling window (10s) for skip% and writes/sec ──
      const now = performance.now();
      const wdt = (now - windowRef.current.time) / 1000;
      if (wdt >= 10) {
        const dSent = d.bleSentCount - windowRef.current.sent;
        const dSkip = (d.rmsGateSkipCount - (windowRef.current as any).skipRms)
          + (d.bleSkipBusyCount - windowRef.current.skipBusy);
        const dTotal = dSent + dSkip;
        statsRef.current.skipPct = dTotal > 0 ? Math.round((dSkip / dTotal) * 100) : 0;
        statsRef.current.wps = Math.round(dSent / wdt);
        windowRef.current = {
          time: now,
          sent: d.bleSentCount,
          skipDelta: d.bleSkipDeltaCount,
          skipThrottle: d.bleSkipThrottleCount,
          skipBusy: d.bleSkipBusyCount,
        };
      } else if (wdt >= 0.5) {
        // Live wps update (more responsive)
        const dSent = d.bleSentCount - windowRef.current.sent;
        statsRef.current.wps = Math.round(dSent / wdt);
      }

      const skipPct = statsRef.current.skipPct;

      // ── Sonos status ──
      const sonosOk = d.sonosVolume !== null;
      const sonosRtt = Math.round(d.smoothedRtt);

      // ── BLE status ──
      let bleStatus: string;
      if (!d.bleConnected) {
        bleStatus = '<span class="text-red-400">—</span>';
      } else {
        bleStatus = '<span class="text-green-400">OK</span>';
      }

      // ── Reconnect ──
      let reconnectHtml = '';
      const rs = d.bleReconnectStatus;
      if (!d.bleConnected && rs) {
        const phase = phaseLabels[rs.phase] || rs.phase;
        reconnectHtml = `<div class="text-yellow-400 mt-0.5 text-[9px]">#${rs.attempt} ${phase}`;
        if (rs.targetName) reconnectHtml += ` → ${rs.targetName}`;
        reconnectHtml += '</div>';
      }

      // ── Headroom bar based on total E2E latency ──
      const e2e = d.micBufferMs + d.pipelineTotalMs + d.bleRadioEstMs;
      const tickTarget = d.tickMs || 125;
      if (e2e > peakLatRef.current) { peakLatRef.current = e2e; peakDecayRef.current = 0; }
      else { peakDecayRef.current++; if (peakDecayRef.current > 5) peakLatRef.current *= 0.9; }
      const peak = peakLatRef.current;
      const loadPct = tickTarget > 0 ? Math.min(150, (peak / tickTarget) * 100) : 0;
      const barPct = Math.min(100, loadPct);
      const barColor = loadPct > 90 ? 'rgb(248,113,113)' : loadPct > 60 ? 'rgb(250,204,21)' : 'rgb(74,222,128)';

      // ── Output color / active palette slot ──
      const base = d.bleBaseColor || [0, 0, 0];
      const displayPalette = (d.palette.length > 0 ? d.palette : [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]).slice(0, 4);
      const activePaletteIndex = d.palette.length > 0
        ? displayPalette.reduce((bestIdx, color, idx, arr) => {
            const best = arr[bestIdx];
            const dist = Math.abs(color[0] - base[0]) + Math.abs(color[1] - base[1]) + Math.abs(color[2] - base[2]);
            const bestDist = Math.abs(best[0] - base[0]) + Math.abs(best[1] - base[1]) + Math.abs(best[2] - base[2]);
            return dist < bestDist ? idx : bestIdx;
          }, 0)
        : 0;

      // ── Build ──
      let buildTime = '';
      try { const dt2 = new Date(__BUILD_TIME__); buildTime = dt2.toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { buildTime = '?'; }

      el.innerHTML = `
        <div class="text-foreground/40 text-[9px] uppercase tracking-wider">Input</div>
        <div class="mt-0.5 flex justify-between">
          <span>Sonos</span>
          <span>${sonosOk ? '<span class="text-green-400">OK</span>' : '<span class="text-red-400">—</span>'}</span>
        </div>
        <div class="flex justify-between">
          <span>BLE</span>
          <span>${bleStatus}${d.bleDeviceName ? ` <span class="text-foreground/30">${d.bleDeviceName}</span>` : ''}</span>
        </div>
        <div class="flex justify-between">
          <span>Skip</span>
          <span class="${skipPct > 50 ? 'text-yellow-400' : 'text-foreground/60'}">${skipPct}%</span>
        </div>
        ${reconnectHtml}

        <div class="mt-1.5 text-foreground/40 text-[9px] uppercase tracking-wider">Latens</div>
        <div class="mt-0.5 flex justify-between">
          <span>Mic buf</span>
          <span class="text-foreground/60">${d.micBufferMs || '?'} ms</span>
        </div>
        <div class="flex justify-between">
          <span>Tick CPU</span>
          <span class="text-foreground/60">${Math.round(d.pipelineTotalMs)} ms</span>
        </div>
        <div class="flex justify-between">
          <span>BLE radio</span>
          <span class="text-foreground/60">~${d.bleRadioEstMs} ms</span>
        </div>
        <div class="flex justify-between font-semibold">
          <span>Σ E2E</span>
          <span class="text-foreground/80">${d.micBufferMs + Math.round(d.pipelineTotalMs) + d.bleRadioEstMs} ms</span>
        </div>
        <div class="flex items-center gap-1 mt-0.5">
          <div class="flex-1 h-2.5 rounded-sm bg-foreground/10 overflow-hidden">
            <div class="h-full rounded-sm transition-[width] duration-200" style="width:${barPct}%;background:${barColor}"></div>
          </div>
          <span class="text-foreground/30 text-[9px] w-12 text-right">${Math.round(peak)}/${tickTarget}ms</span>
        </div>

        <div class="mt-1.5 text-foreground/40 text-[9px] uppercase tracking-wider">Output</div>
        <div class="mt-0.5 flex items-center gap-1">
          ${displayPalette.map((c, i, arr) => {
            const active = i === activePaletteIndex;
            return `<div class="flex-1 h-4 ${i === 0 ? 'rounded-l-sm' : ''} ${i === arr.length - 1 ? 'rounded-r-sm' : ''}" style="background:rgb(${c[0]},${c[1]},${c[2]});border:2px solid ${active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.15)'}"></div>`;
          }).join('')}
        </div>
        <div class="flex justify-between mt-0.5">
          <span>BLE w/s</span>
          <span class="text-foreground/60">${statsRef.current.wps}</span>
        </div>

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
      className="fixed top-14 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none w-[190px]"
    />
  );
}
