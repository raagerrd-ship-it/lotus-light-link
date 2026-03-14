import { useEffect, useState } from "react";
import type { BleReconnectStatus } from "@/lib/bledom";
import { getBleWriteStats, getPipelineTimings, type BleWriteStats, type PipelineTimings } from "@/lib/bledom";

// Injected by Vite define at build time
declare const __BUILD_TIME__: string;

interface DebugOverlayProps {
  smoothedRtt: number;
  palette?: [number, number, number][];
  paletteIndex?: number;
  source?: 'local' | 'cloud';
  sonosVolume?: number | null;
  gainMode?: 'agc' | 'vol' | 'manual';
  volCalibrationVol?: number | null;
  liveBpm?: number | null;
  maxBrightness?: number;
  tickToWriteMs?: number;
  dynamicDamping?: number;
  bleConnected?: boolean;
  bleDeviceName?: string | null;
  bleReconnectStatus?: BleReconnectStatus | null;
  deviceRole?: 'master' | 'monitor';
  bleMinIntervalMs?: number;
  bleLatencyMs?: number;
  dropActive?: boolean;
  energy?: number | null;
  danceability?: number | null;
  happiness?: number | null;
  loudness?: string | null;
}

const phaseLabels: Record<string, string> = {
  getDevices: 'Hämtar enheter…',
  directGatt: 'GATT-anslutning…',
  advScan: 'Söker BLE-signal…',
  waiting: 'Väntar…',
  done: 'Ansluten',
  failed: 'Misslyckades',
};

export default function DebugOverlay({
  smoothedRtt, palette, paletteIndex = 0,
  source, sonosVolume, gainMode, volCalibrationVol, liveBpm, maxBrightness, dynamicDamping,
  bleConnected, bleDeviceName, bleReconnectStatus, tickToWriteMs,
  deviceRole, bleMinIntervalMs, bleLatencyMs, dropActive,
  energy, danceability, happiness, loudness,
}: DebugOverlayProps) {
  const [bleStats, setBleStats] = useState<BleWriteStats>({ writesPerSec: 0, droppedPerSec: 0, lastWriteMs: 0, queueAgeMs: 0, errorCount: 0, lastError: '' });
  const [pipeline, setPipeline] = useState<PipelineTimings>({ rmsMs: 0, smoothMs: 0, bleCallMs: 0, totalTickMs: 0 });

  useEffect(() => {
    const id = setInterval(() => {
      setBleStats(getBleWriteStats());
      setPipeline(getPipelineTimings());
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="fixed bottom-16 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none max-w-[220px]">
      {/* Role */}
      <div>roll: <span className={deviceRole === 'master' ? 'text-green-400' : 'text-yellow-400'}>{deviceRole ?? '?'}</span></div>
      {/* BLE */}
      <div>
        BLE: {bleConnected
          ? <span className="text-green-400">{bleDeviceName || 'ansluten'}</span>
          : <span className="text-red-400">ej ansluten</span>
        }
      </div>
      {!bleConnected && bleReconnectStatus && (
        <div className="text-yellow-400">
          #{bleReconnectStatus.attempt} {phaseLabels[bleReconnectStatus.phase] || bleReconnectStatus.phase}
          {bleReconnectStatus.targetName && <span className="text-foreground/50"> → {bleReconnectStatus.targetName}</span>}
          {bleReconnectStatus.error && bleReconnectStatus.phase !== 'advScan' && (
            <div className="text-red-300 truncate">{bleReconnectStatus.error}</div>
          )}
        </div>
      )}

      {/* Audio */}
      <div>BPM: <span className="text-foreground">{liveBpm ? Math.round(liveBpm) : '—'}</span></div>
      <div>drop: {dropActive ? <span className="text-red-400 font-bold animate-pulse">🔥 DROP</span> : <span className="text-foreground/50">—</span>}</div>

      {/* Track traits & effects */}
      {(energy != null || danceability != null || happiness != null || loudness != null) && (
        <div className="mt-0.5 border-t border-border/30 pt-0.5">
          <div className="text-foreground/40 mb-0.5">traits →</div>
          {energy != null && (
            <div>nrg: <span className="text-foreground">{energy}</span>
              <span className="text-foreground/40"> kick‑{Math.round((1.0 - (energy / 100) * 0.35) * 100)}% drop+{Math.round((energy / 100) * 50)}%</span>
            </div>
          )}
          {danceability != null && (
            <div>dnc: <span className="text-foreground">{danceability}</span>
              <span className="text-foreground/40"> sync‑{Math.round((0.9 - (danceability / 100) * 0.15) * 100)}% kick‑{Math.round((0.12 + (danceability / 100) * 0.08) * 100)}%</span>
            </div>
          )}
          {happiness != null && (
            <div>hpy: <span className="text-foreground">{happiness}</span>
              <span className="text-foreground/40"> mod‑{((0.2 + (happiness / 100) * 0.25)).toFixed(2)} wb‑{Math.round(200 + (1 - happiness / 100) * 55)}</span>
            </div>
          )}
          {loudness != null && (() => {
            const m = loudness.match(/-?\d+(\.\d+)?/);
            const db = m ? parseFloat(m[0]) : null;
            const factor = db != null ? Math.max(0.4, Math.min(2.0, 1.0 + (db - (-9)) * 0.06)) : null;
            return (
              <div>loud: <span className="text-foreground">{loudness}</span>
                {factor != null && <span className="text-foreground/40"> agc×{factor.toFixed(2)}</span>}
              </div>
            );
          })()}
        </div>
      )}
      <div>max ljus: <span className="text-foreground">{maxBrightness ?? 100}%</span></div>
      {dynamicDamping != null && dynamicDamping > 1 && <div>dämpa: <span className="text-foreground">{dynamicDamping.toFixed(1)}x</span></div>}
      <div>RTT: <span className="text-foreground">{Math.round(smoothedRtt)}ms</span>{source && <span className={source === 'local' ? ' text-green-400' : ' text-yellow-400'}> {source}</span>}</div>
      {bleMinIntervalMs != null && <div>BLE intervall: <span className="text-foreground">{bleMinIntervalMs}ms</span></div>}
      {bleLatencyMs != null && <div>BLE latens: <span className="text-foreground">{Math.round(bleLatencyMs)}ms</span></div>}
      {sonosVolume != null && <div>vol: <span className="text-foreground">{sonosVolume}%</span> <span className="text-muted-foreground">{gainMode}{gainMode === 'vol' && volCalibrationVol != null ? ` (ref ${volCalibrationVol}%)` : ''}</span></div>}
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

      {/* BLE write stats */}
      <div className="mt-0.5 border-t border-border/30 pt-0.5">
        <div>BLE w/s: <span className="text-foreground">{bleStats.writesPerSec}</span> skip: <span className="text-foreground">{bleStats.droppedPerSec}</span></div>
        <div>write: <span className="text-foreground">{bleStats.lastWriteMs}ms</span> queue: <span className="text-foreground">{bleStats.queueAgeMs}ms</span></div>
        {tickToWriteMs != null && <div>e2e: <span className="text-foreground">{Math.round(tickToWriteMs)}ms</span></div>}
        {bleStats.errorCount > 0 && <div className="text-red-400">err: {bleStats.errorCount} — {bleStats.lastError}</div>}
      </div>

      {/* Pipeline step timings */}
      <div className="mt-0.5 border-t border-border/30 pt-0.5">
        <div>rms: <span className="text-foreground">{pipeline.rmsMs.toFixed(1)}ms</span> smooth: <span className="text-foreground">{pipeline.smoothMs.toFixed(1)}ms</span></div>
        <div>ble call: <span className="text-foreground">{pipeline.bleCallMs.toFixed(1)}ms</span> tick: <span className="text-foreground">{pipeline.totalTickMs.toFixed(1)}ms</span></div>
      </div>

      {/* Build info */}
      <div className="mt-0.5 border-t border-border/30 pt-0.5 text-foreground/40">
        build: {(() => { try { const d = new Date(__BUILD_TIME__); return d.toLocaleString('sv-SE', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }); } catch { return '?'; } })()}
      </div>
    </div>
  );
}
