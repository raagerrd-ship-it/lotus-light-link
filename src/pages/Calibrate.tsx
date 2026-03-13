import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RotateCcw } from "lucide-react";
import DynamicsPreview from "@/components/DynamicsPreview";
import {
  getCalibration, saveCalibration, resetCalibration,
  applyColorCalibration, DEFAULT_CALIBRATION,
  type LightCalibration,
} from "@/lib/lightCalibration";
import { connectBLEDOM, sendColor, sendBrightness, type BLEConnection } from "@/lib/bledom";

type Tab = 'color' | 'dynamics' | 'timing' | 'ambient';

const TABS: { key: Tab; label: string }[] = [
  { key: 'color', label: 'Färg' },
  { key: 'dynamics', label: 'Dynamik' },
  { key: 'timing', label: 'Timing' },
  { key: 'ambient', label: 'Ambient' },
];

const TEST_COLORS: { label: string; color: [number, number, number] }[] = [
  { label: 'Röd', color: [255, 0, 0] },
  { label: 'Grön', color: [0, 255, 0] },
  { label: 'Blå', color: [0, 0, 255] },
  { label: 'Vit', color: [255, 255, 255] },
  { label: 'Gul', color: [255, 255, 0] },
  { label: 'Cyan', color: [0, 255, 255] },
  { label: 'Magenta', color: [255, 0, 255] },
];

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}

function SliderRow({ label, value, min, max, step, unit = '', onChange }: SliderRowProps) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground font-mono w-28 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1.5 accent-current text-primary"
      />
      <span className="text-xs font-mono text-foreground w-14 text-right">
        {Number.isInteger(step) || step >= 1 ? Math.round(value) : value.toFixed(2)}{unit}
      </span>
    </div>
  );
}

export default function Calibrate() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('color');
  const [cal, setCal] = useState<LightCalibration>(getCalibration);
  const [testColor, setTestColor] = useState<[number, number, number]>([255, 0, 0]);
  const [conn, setConn] = useState<BLEConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const bleThrottleRef = useRef(0);

  // Persist on every change
  const update = useCallback((patch: Partial<LightCalibration>) => {
    setCal((prev) => {
      const next = { ...prev, ...patch };
      saveCalibration(next);
      return next;
    });
  }, []);

  const handleReset = useCallback((tabKey: Tab) => {
    const full = { ...DEFAULT_CALIBRATION };
    const patches: Record<Tab, Partial<LightCalibration>> = {
      color: { gammaR: full.gammaR, gammaG: full.gammaG, gammaB: full.gammaB, offsetR: full.offsetR, offsetG: full.offsetG, offsetB: full.offsetB, saturationBoost: full.saturationBoost },
      dynamics: { minBrightness: full.minBrightness, maxBrightness: full.maxBrightness, attackAlpha: full.attackAlpha, releaseAlpha: full.releaseAlpha, dynamicDamping: full.dynamicDamping },
      timing: { punchWhiteThreshold: full.punchWhiteThreshold, fadeBackDuration: full.fadeBackDuration, bleLatencyMs: full.bleLatencyMs, groovePhaseGate: full.groovePhaseGate },
      ambient: { ambientEma: full.ambientEma, silenceFadeMs: full.silenceFadeMs, baselinePct: full.baselinePct },
    };
    update(patches[tabKey]);
  }, [update]);

  // Send test color to BLE (throttled)
  useEffect(() => {
    if (!conn) return;
    const now = performance.now();
    if (now - bleThrottleRef.current < 50) return;
    bleThrottleRef.current = now;
    const [r, g, b] = applyColorCalibration(...testColor, cal);
    sendColor(conn.characteristic, r, g, b).catch(() => {});
    sendBrightness(conn.characteristic, cal.maxBrightness).catch(() => {});
  }, [testColor, cal, conn]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const c = await connectBLEDOM();
      setConn(c);
    } catch {}
    setConnecting(false);
  };

  const calibrated = applyColorCalibration(...testColor, cal);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')} className="rounded-full w-8 h-8">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-sm font-bold tracking-widest uppercase text-foreground/80">Kalibrering</h1>
        <div className="flex-1" />
        {!conn && (
          <Button variant="outline" size="sm" onClick={handleConnect} disabled={connecting} className="text-xs">
            {connecting ? 'Ansluter…' : 'Anslut BLE'}
          </Button>
        )}
        {conn && <span className="text-[10px] text-green-400 font-mono">{conn.device?.name || 'Ansluten'}</span>}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition-colors ${
              tab === t.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-accent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="space-y-1">
        {/* Reset button */}
        <div className="flex justify-end mb-2">
          <Button variant="ghost" size="sm" onClick={() => handleReset(tab)} className="text-xs gap-1 text-muted-foreground">
            <RotateCcw className="w-3 h-3" /> Återställ
          </Button>
        </div>

        {tab === 'color' && (
          <>
            {/* Test color preview */}
            <div className="flex items-center gap-3 mb-3">
              <div className="flex gap-1.5">
                {TEST_COLORS.map((tc) => (
                  <button
                    key={tc.label}
                    onClick={() => setTestColor(tc.color)}
                    className="w-7 h-7 rounded-full border border-border/50 transition-transform active:scale-90"
                    style={{ backgroundColor: `rgb(${tc.color.join(',')})` }}
                    title={tc.label}
                  />
                ))}
              </div>
            </div>
            <div className="flex gap-3 mb-4">
              <div className="flex-1 rounded-lg h-16 border border-border/30 flex items-center justify-center" style={{ backgroundColor: `rgb(${testColor.join(',')})` }}>
                <span className="text-[9px] font-mono opacity-60 mix-blend-difference text-white">MÅL</span>
              </div>
              <div className="flex-1 rounded-lg h-16 border border-border/30 flex items-center justify-center" style={{ backgroundColor: `rgb(${calibrated.join(',')})` }}>
                <span className="text-[9px] font-mono opacity-60 mix-blend-difference text-white">KALIBRERAD</span>
              </div>
            </div>
            <SliderRow label="Gamma R" value={cal.gammaR} min={0.5} max={2.5} step={0.05} onChange={(v) => update({ gammaR: v })} />
            <SliderRow label="Gamma G" value={cal.gammaG} min={0.5} max={2.5} step={0.05} onChange={(v) => update({ gammaG: v })} />
            <SliderRow label="Gamma B" value={cal.gammaB} min={0.5} max={2.5} step={0.05} onChange={(v) => update({ gammaB: v })} />
            <SliderRow label="Offset R" value={cal.offsetR} min={-30} max={30} step={1} onChange={(v) => update({ offsetR: v })} />
            <SliderRow label="Offset G" value={cal.offsetG} min={-30} max={30} step={1} onChange={(v) => update({ offsetG: v })} />
            <SliderRow label="Offset B" value={cal.offsetB} min={-30} max={30} step={1} onChange={(v) => update({ offsetB: v })} />
            <SliderRow label="Mättnad" value={cal.saturationBoost} min={0.5} max={2.0} step={0.05} onChange={(v) => update({ saturationBoost: v })} unit="x" />
          </>
        )}

        {tab === 'dynamics' && (
          <>
            <SliderRow label="Min ljusstyrka" value={cal.minBrightness} min={0} max={30} step={1} unit="%" onChange={(v) => update({ minBrightness: v })} />
            <SliderRow label="Max ljusstyrka" value={cal.maxBrightness} min={30} max={100} step={1} unit="%" onChange={(v) => update({ maxBrightness: v })} />
            <SliderRow label="Attack" value={cal.attackAlpha} min={0.1} max={0.9} step={0.01} onChange={(v) => update({ attackAlpha: v })} />
            <SliderRow label="Release" value={cal.releaseAlpha} min={0.02} max={0.2} step={0.005} onChange={(v) => update({ releaseAlpha: v })} />
            <SliderRow label="Dämpning" value={cal.dynamicDamping} min={1.0} max={3.0} step={0.1} unit="x" onChange={(v) => update({ dynamicDamping: v })} />
          </>
        )}

        {tab === 'timing' && (
          <>
            <SliderRow label="Punch-tröskel" value={cal.punchWhiteThreshold} min={60} max={95} step={1} unit="%" onChange={(v) => update({ punchWhiteThreshold: v })} />
            <SliderRow label="Fade-back" value={cal.fadeBackDuration} min={100} max={800} step={10} unit="ms" onChange={(v) => update({ fadeBackDuration: v })} />
            <SliderRow label="BLE-latens" value={cal.bleLatencyMs} min={0} max={150} step={5} unit="ms" onChange={(v) => update({ bleLatencyMs: v })} />
            <SliderRow label="Groove-gate" value={cal.groovePhaseGate} min={0.1} max={0.5} step={0.01} onChange={(v) => update({ groovePhaseGate: v })} />
          </>
        )}

        {tab === 'ambient' && (
          <>
            <SliderRow label="Ambient EMA" value={cal.ambientEma} min={0.7} max={0.98} step={0.01} onChange={(v) => update({ ambientEma: v })} />
            <SliderRow label="Tystnad fade" value={cal.silenceFadeMs} min={500} max={5000} step={100} unit="ms" onChange={(v) => update({ silenceFadeMs: v })} />
            <SliderRow label="Baseline" value={cal.baselinePct} min={3} max={20} step={1} unit="%" onChange={(v) => update({ baselinePct: v })} />
          </>
        )}
      </div>
    </div>
  );
}
