import type { SongSection } from "@/lib/songSections";
import type { BleReconnectStatus } from "@/lib/bledom";

interface DebugOverlayProps {
  smoothedRtt: number;
  autoDriftMs: number;
  currentSection: SongSection | null;
  palette?: [number, number, number][];
  paletteIndex?: number;
  source?: 'local' | 'cloud';
  sonosVolume?: number | null;
  gainMode?: 'agc' | 'vol' | 'manual';
  volCalibrationVol?: number | null;
  liveBpm?: number | null;
  maxBrightness?: number;
  dynamicDamping?: number;
  bleConnected?: boolean;
  bleDeviceName?: string | null;
  bleReconnectStatus?: BleReconnectStatus | null;
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
  smoothedRtt, autoDriftMs, currentSection, palette, paletteIndex = 0,
  source, sonosVolume, gainMode, liveBpm, maxBrightness, dynamicDamping,
  bleConnected, bleDeviceName, bleReconnectStatus
}: DebugOverlayProps) {
  return (
    <div className="fixed bottom-16 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none max-w-[220px]">
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
      <div>max ljus: <span className="text-foreground">{maxBrightness ?? 100}%</span></div>
      {dynamicDamping != null && dynamicDamping > 1 && <div>dämpa: <span className="text-foreground">{dynamicDamping.toFixed(1)}x</span></div>}
      <div>RTT: <span className="text-foreground">{Math.round(smoothedRtt)}ms</span>{source && <span className={source === 'local' ? ' text-green-400' : ' text-yellow-400'}> {source}</span>}</div>
      <div>auto-sync: <span className="text-foreground">{autoDriftMs >= 0 ? "+" : ""}{Math.round(autoDriftMs)}ms</span></div>
      <div>section: <span className="text-foreground">{currentSection ? `${currentSection.type} (e${currentSection.energy.toFixed(1)})` : "—"}</span></div>
      {sonosVolume != null && <div>vol: <span className="text-foreground">{sonosVolume}%</span> <span className="text-muted-foreground">{gainMode}</span></div>}
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
