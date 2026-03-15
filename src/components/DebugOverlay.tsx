import type { BleReconnectStatus, BleWriteStats } from "@/lib/bledom";
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
  
  dynamicDamping?: number;
  bleConnected?: boolean;
  bleDeviceName?: string | null;
  bleReconnectStatus?: BleReconnectStatus | null;
  deviceRole?: 'master' | 'monitor';
  bleMinIntervalMs?: number;
  dropActive?: boolean;
  energy?: number | null;
  danceability?: number | null;
  happiness?: number | null;
  loudness?: string | null;
  bassLevel?: number;
  midHiLevel?: number;
  bleSentColor?: [number, number, number] | null;
  bleSentBright?: number | null;
  bleColorSource?: 'idle' | 'normal' | 'white' | null;
  bleBaseColor?: [number, number, number] | null;
  bleWriteStats?: BleWriteStats | null;
  pipelinePeakMs?: number | null;
}

const phaseLabels: Record<string, string> = {
  getDevices: 'Hämtar enheter…',
  directGatt: 'GATT-anslutning…',
  advScan: 'Söker BLE-signal…',
  waiting: 'Väntar…',
  done: 'Ansluten',
  failed: 'Misslyckades',
};

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border/30 pt-0.5 mt-0.5">
      <div className="text-foreground/40 text-[9px] uppercase tracking-wider mb-0.5">{label}</div>
      {children}
    </div>
  );
}

export default function DebugOverlay({
  smoothedRtt, palette, paletteIndex = 0,
  source, sonosVolume, gainMode, volCalibrationVol, liveBpm, maxBrightness, dynamicDamping,
  bleConnected, bleDeviceName, bleReconnectStatus,
  deviceRole, bleMinIntervalMs, dropActive,
  energy, danceability, happiness, loudness,
  bassLevel, midHiLevel,
  bleSentColor, bleSentBright, bleColorSource, bleBaseColor, bleWriteStats, pipelinePeakMs,
}: DebugOverlayProps) {

  return (
    <div className="fixed bottom-16 left-2 z-50 font-mono text-[10px] leading-tight bg-background/70 backdrop-blur-sm border border-border/40 rounded-md px-2 py-1.5 text-foreground/70 pointer-events-none select-none max-w-[220px]">

      {/* ── 1. ENHET ── */}
      <div className="text-foreground/40 text-[9px] uppercase tracking-wider mb-0.5">enhet</div>
      <div>
        {bleConnected
          ? <span className="text-green-400">{bleDeviceName || 'ansluten'}</span>
          : <span className="text-red-400">ej ansluten</span>
        }
        <span className="text-foreground/40"> · {deviceRole ?? '?'}</span>
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

      {/* ── 2. INPUT ── */}
      <Section label="input">
        <div>sonos: {sonosVolume != null ? <span className="text-green-400">ok</span> : <span className="text-foreground/50">—</span>}
          {sonosVolume != null && <span className="text-foreground"> {sonosVolume}%</span>}
          <span className="text-foreground/40"> {gainMode ?? ''}</span>
          {source && <span className={source === 'local' ? ' text-green-400' : ' text-yellow-400'}> {source}</span>}
        </div>
        <div>RTT: <span className="text-foreground">{Math.round(smoothedRtt)}ms</span></div>
        <div>mic: <span className="text-foreground">lo {bassLevel != null ? bassLevel.toFixed(3) : '—'}</span> <span className="text-foreground/40">|</span> <span className="text-foreground">hi {midHiLevel != null ? midHiLevel.toFixed(3) : '—'}</span></div>
        {liveBpm ? <div>BPM: <span className="text-foreground">{Math.round(liveBpm)}</span></div> : null}
      </Section>

      {/* ── 3. PROCESS ── */}
      <Section label="process">
        {(energy != null || danceability != null || happiness != null || loudness != null) && (
          <div className="space-y-0">
            {energy != null && (() => {
              const e = energy / 100;
              const surgeNeed = (4.0 - e * 2.0).toFixed(1);
              const quietPct = Math.round((0.12 + e * 0.18) * 100);
              return <div>nrg <span className="text-foreground">{energy}</span> <span className="text-foreground/40">q{quietPct}% s{surgeNeed}×</span></div>;
            })()}
            {danceability != null && <div>dnc <span className="text-foreground">{danceability}</span></div>}
            {happiness != null && (
              <div>hpy <span className="text-foreground">{happiness}</span> <span className="text-foreground/40">mod{((0.2 + (happiness / 100) * 0.25)).toFixed(2)}</span></div>
            )}
            {loudness != null && (() => {
              const m = loudness.match(/-?\d+(\.\d+)?/);
              const db = m ? parseFloat(m[0]) : null;
              const factor = db != null ? Math.max(0.4, Math.min(2.0, 1.0 + (db - (-9)) * 0.06)) : null;
              return <div>loud <span className="text-foreground">{loudness}</span>{factor != null && <span className="text-foreground/40"> agc×{factor.toFixed(2)}</span>}</div>;
            })()}
          </div>
        )}
        <div>ljus: <span className="text-foreground">{maxBrightness ?? 100}%</span>
          {dynamicDamping != null && dynamicDamping !== 0 && <span className="text-foreground/40"> dyn {dynamicDamping > 0 ? '+' : ''}{dynamicDamping.toFixed(1)}</span>}
        </div>
        <div>drop: {dropActive ? <span className="text-red-400 font-bold animate-pulse">🔥 DROP</span> : <span className="text-foreground/50">—</span>}</div>
      </Section>

      {/* ── 4. FÄRGVAL ── */}
      <Section label="färg">
        {palette && palette.length > 0 && (
          <div className="flex items-center gap-1">
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
      </Section>

      {/* ── 5. BLE OUTPUT ── */}
      <Section label="ble output">
        {bleSentColor ? (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm border border-border/40 shrink-0" style={{ backgroundColor: bleBaseColor ? `rgb(${bleBaseColor[0]},${bleBaseColor[1]},${bleBaseColor[2]})` : `rgb(${bleSentColor[0]},${bleSentColor[1]},${bleSentColor[2]})` }} />
            <div className="flex-1 h-2.5 rounded-sm bg-foreground/10 overflow-hidden">
              <div className="h-full rounded-sm transition-[width] duration-100" style={{ width: `${bleSentBright ?? 0}%`, backgroundColor: bleBaseColor ? `rgb(${bleBaseColor[0]},${bleBaseColor[1]},${bleBaseColor[2]})` : `rgb(${bleSentColor[0]},${bleSentColor[1]},${bleSentColor[2]})` }} />
            </div>
            {bleColorSource && bleColorSource !== 'normal' && (
              <span className={`shrink-0 ${bleColorSource === 'idle' ? 'text-yellow-400' : 'text-foreground'}`}>{bleColorSource}</span>
            )}
          </div>
        ) : (
          <div className="text-foreground/50">väntar…</div>
        )}
        {bleMinIntervalMs != null && (() => {
          const interval = bleMinIntervalMs;
          const peak = pipelinePeakMs ?? 0;
          const ratio = interval > 0 ? peak / interval : 0;
          const peakColor = ratio >= 1 ? 'text-red-400 font-bold' : ratio > 0.8 ? 'text-yellow-400' : 'text-green-400';
          return (
            <div>
              intervall: <span className="text-foreground">{interval}ms</span>
              <span className="text-foreground/40"> │ </span>
              peak: <span className={peakColor}>{Math.round(peak)}ms</span>
              <span className={peakColor}> {ratio >= 1 ? '!!' : '✓'}</span>
            </div>
          );
        })()}
        {bleWriteStats && (
          <div>
            <span className="text-foreground">{bleWriteStats.writesPerSec}w/s</span>
            {' '}
            {bleWriteStats.errorsPerSec > 0
              ? <span className="text-red-400 animate-pulse">err:{bleWriteStats.errorsPerSec}/s</span>
              : <span className="text-green-400">0 err</span>
            }
            {bleWriteStats.errorsPerSec > 0 && bleWriteStats.lastError && (
              <div className="text-red-300 truncate max-w-[200px]">{bleWriteStats.lastError}</div>
            )}
          </div>
        )}
      </Section>

      {/* Build info */}
      <div className="mt-0.5 border-t border-border/30 pt-0.5 text-foreground/40">
        {(() => { try { const d = new Date(__BUILD_TIME__); return d.toLocaleString('sv-SE', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }); } catch { return '?'; } })()}
      </div>
    </div>
  );
}
