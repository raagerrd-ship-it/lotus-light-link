import { useEffect, useRef } from "react";
import { debugData } from "@/lib/debugStore";

// Injected by Vite define at build time
declare const __BUILD_TIME__: string;

const phaseLabels: Record<string, string> = {
  getDevices: 'Hämtar enheter…',
  directGatt: 'GATT-anslutning…',
  advScan: 'Söker BLE-signal…',
  waiting: 'Väntar…',
  done: 'Ansluten',
  failed: 'Misslyckades',
};

/**
 * Ref-driven debug overlay — reads from debugStore every 200ms
 * and updates DOM directly. Zero React re-renders from live data.
 */
export default function DebugOverlay() {
  const rootRef = useRef<HTMLDivElement>(null);

  // Refs to DOM elements we update directly
  const deviceRef = useRef<HTMLDivElement>(null);
  const reconnectRef = useRef<HTMLDivElement>(null);
  const sonosRef = useRef<HTMLDivElement>(null);
  const rttRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLDivElement>(null);
  const rmsRef = useRef<HTMLDivElement>(null);
  const bpmRef = useRef<HTMLDivElement>(null);
  const nrgRef = useRef<HTMLDivElement>(null);
  const loudRef = useRef<HTMLDivElement>(null);
  const ljusRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  
  const bleOutSwatchRef = useRef<HTMLDivElement>(null);
  const bleOutBarRef = useRef<HTMLDivElement>(null);
  const bleOutSourceRef = useRef<HTMLSpanElement>(null);
  const bleOutContainerRef = useRef<HTMLDivElement>(null);
  const bleOutWaitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tick = () => {
      const d = debugData;

      // 1. ENHET
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

      // 2. INPUT
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
      if (micRef.current) {
        micRef.current.innerHTML = `mic: <span class="text-foreground">lo ${d.bassLevel.toFixed(3)}</span> <span class="text-foreground/40">|</span> <span class="text-foreground">hi ${d.midHiLevel.toFixed(3)}</span>`;
      }
      if (rmsRef.current) {
        const playIcon = d.isPlayingState ? '<span class="text-green-400">▶</span>' : '<span class="text-yellow-400">⏸</span>';
        rmsRef.current.innerHTML = `rms: <span class="text-foreground">${d.micRms.toFixed(5)}</span><span class="text-foreground/40"> │ </span>play: ${playIcon}`;
      }
      if (bpmRef.current) {
        if (d.liveBpm) {
          bpmRef.current.textContent = `BPM: ${Math.round(d.liveBpm)}`;
          bpmRef.current.style.display = '';
        } else {
          bpmRef.current.style.display = 'none';
        }
      }

      // 3. PROCESS
      if (nrgRef.current) {
        if (d.energy != null) {
          const e = d.energy / 100;
          const surgeNeed = (4.0 - e * 2.0).toFixed(1);
          const quietPct = Math.round((0.12 + e * 0.18) * 100);
          nrgRef.current.innerHTML = `nrg <span class="text-foreground">${d.energy}</span> <span class="text-foreground/40">q${quietPct}% s${surgeNeed}×</span>`;
          nrgRef.current.style.display = '';
        } else {
          nrgRef.current.style.display = 'none';
        }
      }
      if (loudRef.current) {
        if (d.loudness != null) {
          const m = d.loudness.match(/-?\d+(\.\d+)?/);
          const db = m ? parseFloat(m[0]) : null;
          const factor = db != null ? Math.max(0.4, Math.min(2.0, 1.0 + (db - (-9)) * 0.06)) : null;
          let html = `loud <span class="text-foreground">${d.loudness}</span>`;
          if (factor != null) html += `<span class="text-foreground/40"> agc×${factor.toFixed(2)}</span>`;
          loudRef.current.innerHTML = html;
          loudRef.current.style.display = '';
        } else {
          loudRef.current.style.display = 'none';
        }
      }
      if (ljusRef.current) {
        let html = `ljus: <span class="text-foreground">${d.maxBrightness}%</span>`;
        if (d.dynamicDamping !== 0) {
          html += `<span class="text-foreground/40"> dyn ${d.dynamicDamping > 0 ? '+' : ''}${d.dynamicDamping.toFixed(1)}</span>`;
        }
        ljusRef.current.innerHTML = html;
      }
      if (dropRef.current) {
        dropRef.current.innerHTML = d.dropActive
          ? 'drop: <span class="text-red-400 font-bold">🔥 DROP</span>'
          : 'drop: <span class="text-foreground/50">—</span>';
      }

      // 4. BLE OUTPUT
      const sc = d.bleSentColor;
      if (sc) {
        if (bleOutContainerRef.current) bleOutContainerRef.current.style.display = '';
        if (bleOutWaitRef.current) bleOutWaitRef.current.style.display = 'none';
        const bc = d.bleBaseColor ?? sc;
        const rgb = `rgb(${bc[0]},${bc[1]},${bc[2]})`;
        if (bleOutSwatchRef.current) bleOutSwatchRef.current.style.backgroundColor = rgb;
        if (bleOutBarRef.current) {
          bleOutBarRef.current.style.width = `${d.bleSentBright ?? 0}%`;
          bleOutBarRef.current.style.backgroundColor = rgb;
        }
        if (bleOutSourceRef.current) {
          const src = d.bleColorSource;
          if (src && src !== 'normal') {
            bleOutSourceRef.current.textContent = src;
            bleOutSourceRef.current.className = `shrink-0 ${src === 'idle' ? 'text-yellow-400' : 'text-foreground'}`;
            bleOutSourceRef.current.style.display = '';
          } else {
            bleOutSourceRef.current.style.display = 'none';
          }
        }
      } else {
        if (bleOutContainerRef.current) bleOutContainerRef.current.style.display = 'none';
        if (bleOutWaitRef.current) bleOutWaitRef.current.style.display = '';
      }
    };

    const id = setInterval(tick, 200);
    tick(); // initial render
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={rootRef} className="fixed bottom-16 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none max-w-[220px]">

      {/* 1. ENHET */}
      <div className="text-foreground/40 text-[9px] uppercase tracking-wider mb-0.5">enhet</div>
      <div ref={deviceRef} />
      <div ref={reconnectRef} style={{ display: 'none' }} />

      {/* 2. INPUT */}
      <div className="border-t border-border/30 pt-0.5 mt-0.5">
        <div className="text-foreground/40 text-[9px] uppercase tracking-wider mb-0.5">input</div>
        <div ref={sonosRef} />
        <div ref={rttRef} />
        <div ref={micRef} />
        <div ref={rmsRef} />
        <div ref={bpmRef} style={{ display: 'none' }} />
      </div>

      {/* 3. PROCESS */}
      <div className="border-t border-border/30 pt-0.5 mt-0.5">
        <div className="text-foreground/40 text-[9px] uppercase tracking-wider mb-0.5">process</div>
        <div ref={nrgRef} style={{ display: 'none' }} />
        <div ref={dncRef} style={{ display: 'none' }} />
        <div ref={hpyRef} style={{ display: 'none' }} />
        <div ref={loudRef} style={{ display: 'none' }} />
        <div ref={ljusRef} />
        <div ref={dropRef} />
      </div>

      {/* 4. BLE OUTPUT */}
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
      </div>

      {/* Build info */}
      <div className="mt-0.5 border-t border-border/30 pt-0.5 text-foreground/40">
        {(() => { try { const d = new Date(__BUILD_TIME__); return d.toLocaleString('sv-SE', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }); } catch { return '?'; } })()}
      </div>
    </div>
  );
}
