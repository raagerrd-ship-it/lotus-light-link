import { useState, useCallback, useEffect, useRef } from "react";
import { X, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getCalibration, saveCalibration, DEFAULT_CALIBRATION,
  type LightCalibration,
} from "@/lib/lightCalibration";
import { getBleConnection, subscribeBle } from "@/lib/bleStore";

/* ── Slider definitions ── */

interface SliderDef {
  key: keyof LightCalibration;
  label: string;
  shortLabel: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  group: string;
  description: string;
  format?: (v: number) => string;
}

const SLIDERS: SliderDef[] = [
  // Brightness
  { key: 'minBrightness', label: 'Min ljusstyrka', shortLabel: 'Min', min: 0, max: 30, step: 1, unit: '%', group: 'Ljus', description: 'Lägsta ljusnivå vid tystnad. Högre = lampan släcks aldrig helt.' },
  { key: 'maxBrightness', label: 'Max ljusstyrka', shortLabel: 'Max', min: 30, max: 100, step: 1, unit: '%', group: 'Ljus', description: 'Högsta ljusnivå vid maximal ljudvolym.' },
  // Dynamics
  { key: 'attackAlpha', label: 'Attack', shortLabel: 'Atk', min: 0.05, max: 0.9, step: 0.01, unit: 'α', group: 'Dynamik', description: 'Hur snabbt ljuset reagerar uppåt. Lågt = mjukare fade in, högt = omedelbar respons.' },
  { key: 'releaseAlpha', label: 'Release', shortLabel: 'Rel', min: 0.005, max: 0.3, step: 0.005, unit: 'α', group: 'Dynamik', description: 'Hur snabbt ljuset tonar ner. Lågt = lång svans, högt = snabb dip.', format: v => v.toFixed(3) },
  { key: 'dynamicDamping', label: 'Dynamik', shortLabel: 'Dyn', min: -2.0, max: 3.0, step: 0.1, unit: '×', group: 'Dynamik', description: 'Negativt = förstärkt kontrast (punch). Positivt = utjämnad dynamik. 0 = neutral.' },
  // Kick
  { key: 'whiteKickThreshold', label: 'Kick tröskel', shortLabel: 'Kick', min: 50, max: 100, step: 1, unit: '%', group: 'Kick', description: 'Hur stark basökning krävs för att trigga en vit "drop"-blixt. Lägre = fler drops.' },
  { key: 'whiteKickMs', label: 'Kick tid', shortLabel: 'Tid', min: 20, max: 200, step: 5, unit: 'ms', group: 'Kick', description: 'Hur länge den vita blixten varar vid en drop.' },
  // Color
];

function formatValue(def: SliderDef, val: number): string {
  if (def.format) return def.format(val);
  if (def.step < 0.1) return val.toFixed(2);
  if (def.step < 1) return val.toFixed(1);
  return String(Math.round(val));
}

/* ── Vertical mixer fader ── */

function MixerFader({
  def, value, onChange, isActive, onFocus,
}: {
  def: SliderDef;
  value: number;
  onChange: (v: number) => void;
  isActive: boolean;
  onFocus: () => void;
}) {
  const isDefault = value === DEFAULT_CALIBRATION[def.key];
  const trackRef = useRef<HTMLDivElement>(null);

  const nudge = (dir: 1 | -1) => {
    const next = Math.round((value + def.step * dir) * 1000) / 1000;
    onChange(Math.max(def.min, Math.min(def.max, next)));
  };

  const pct = ((value - def.min) / (def.max - def.min)) * 100;

  const handlePointer = useCallback((e: React.PointerEvent) => {
    onFocus();
    const track = trackRef.current;
    if (!track) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const update = (ev: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      // Vertical: bottom = min, top = max
      const rawPct = 1 - Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      const raw = def.min + rawPct * (def.max - def.min);
      const snapped = Math.round(raw / def.step) * def.step;
      onChange(Math.max(def.min, Math.min(def.max, Math.round(snapped * 1000) / 1000)));
    };

    update(e.nativeEvent);
    const move = (ev: PointerEvent) => update(ev);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }, [def, onChange, onFocus]);

  // Group color coding
  const groupColors: Record<string, string> = {
    'Ljus': 'hsl(48, 90%, 60%)',
    'Dynamik': 'hsl(142, 70%, 50%)',
    'Kick': 'hsl(0, 80%, 60%)',
    'Färg': 'hsl(270, 70%, 65%)',
  };
  const accentColor = groupColors[def.group] ?? 'hsl(var(--primary))';

  return (
    <div
      className={`flex flex-col items-center gap-1 min-w-[3rem] transition-all ${isActive ? 'scale-105' : ''}`}
      onClick={onFocus}
    >
      {/* + button */}
      <button
        onClick={(e) => { e.stopPropagation(); nudge(1); }}
        className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
      >
        +
      </button>

      {/* Vertical track */}
      <div
        ref={trackRef}
        className="relative w-3 rounded-full touch-none select-none cursor-ns-resize"
        style={{ height: '7rem', background: 'hsl(var(--secondary))' }}
        onPointerDown={handlePointer}
      >
        {/* Fill from bottom */}
        <div
          className="absolute bottom-0 left-0 right-0 rounded-full transition-none"
          style={{ height: `${pct}%`, background: accentColor, opacity: 0.5 }}
        />
        {/* Thumb */}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-5 h-3 rounded-sm shadow-md border transition-none"
          style={{
            bottom: `calc(${pct}% - 6px)`,
            background: isActive ? accentColor : 'hsl(var(--foreground) / 0.9)',
            borderColor: isActive ? accentColor : 'hsl(var(--border))',
          }}
        />
      </div>

      {/* - button */}
      <button
        onClick={(e) => { e.stopPropagation(); nudge(-1); }}
        className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
      >
        −
      </button>

      {/* Label */}
      <span className={`text-[9px] font-bold tracking-wide leading-tight text-center ${isDefault ? 'text-muted-foreground' : 'text-foreground'}`}>
        {def.shortLabel}
      </span>
      {/* Value */}
      <span className={`text-[9px] font-mono leading-tight ${isDefault ? 'text-muted-foreground/60' : 'text-foreground/80'}`}>
        {formatValue(def, value)}{def.unit}
      </span>
    </div>
  );
}

/* ── BLE Speed Test (ported from Calibrate.tsx) ── */

const COLOR_BUF = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const BRIGHT_BUF = new Uint8Array([0x7e, 0x04, 0x01, 0, 0x01, 0xff, 0x00, 0x00, 0xef]);
const CYCLE_COLORS: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
const TEST_INTERVALS = [100, 80, 60, 50, 40, 35, 30, 25, 20];
const WRITES_PER_STEP = 10;
const WARMUP_WRITES = 2;

interface StepResult {
  intervalMs: number;
  meanMs: number;
  maxMs: number;
  stable: boolean;
}

function BleSpeedSection({ conn }: { conn: any }) {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [stepResults, setStepResults] = useState<StepResult[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [optimalMs, setOptimalMs] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const abortRef = useRef(false);

  const runTest = useCallback(async () => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    setPhase('running'); setStepResults([]); setOptimalMs(null); setSaved(false);
    abortRef.current = false;

    BRIGHT_BUF[3] = 0;
    await char.writeValueWithoutResponse(BRIGHT_BUF as any);
    await new Promise(r => setTimeout(r, 300));

    const results: StepResult[] = [];
    let lastStable = TEST_INTERVALS[0];

    for (let si = 0; si < TEST_INTERVALS.length; si++) {
      if (abortRef.current) break;
      const interval = TEST_INTERVALS[si];
      setCurrentStep(si);
      const times: number[] = [];

      for (let w = 0; w < WRITES_PER_STEP; w++) {
        if (abortRef.current) break;
        const [cr, cg, cb] = CYCLE_COLORS[w % 3];
        COLOR_BUF[4] = cr; COLOR_BUF[5] = cg; COLOR_BUF[6] = cb;
        BRIGHT_BUF[3] = 100;
        const t0 = performance.now();
        await char.writeValueWithoutResponse(COLOR_BUF as any);
        await new Promise(r => setTimeout(r, 1));
        await char.writeValueWithoutResponse(BRIGHT_BUF as any);
        times.push(performance.now() - t0);
        const rem = interval - (performance.now() - t0);
        if (rem > 0) await new Promise(r => setTimeout(r, rem));
      }

      const measured = times.slice(WARMUP_WRITES);
      const mean = measured.reduce((a, b) => a + b, 0) / measured.length;
      const max = Math.max(...measured);
      const stable = mean < interval * 0.5 && max < interval * 0.8;
      results.push({ intervalMs: interval, meanMs: Math.round(mean * 10) / 10, maxMs: Math.round(max * 10) / 10, stable });
      setStepResults([...results]);
      if (stable) lastStable = interval; else break;
    }

    setOptimalMs(lastStable);
    setBleMinInterval(lastStable);
    setPhase('done');
  }, [conn]);

  const handleSave = () => {
    if (optimalMs == null) return;
    const deviceName = conn?.device?.name;
    if (deviceName) saveBleSpeedToCloud(deviceName, optimalMs, { combined: optimalMs });
    setSaved(true);
  };

  if (!conn) return <p className="text-[10px] text-destructive">⚠ Anslut BLE-lampan först</p>;

  return (
    <div className="space-y-2">
      {phase === 'idle' && (
        <Button size="sm" onClick={runTest} className="gap-1.5 text-xs w-full">
          <Play className="w-3.5 h-3.5" /> Starta BLE-hastighetstest
        </Button>
      )}
      {phase === 'running' && (
        <div className="text-center py-2">
          <p className="text-xs text-muted-foreground">Testar intervall <span className="font-mono font-bold text-foreground">{TEST_INTERVALS[currentStep]}ms</span> ({currentStep + 1}/{TEST_INTERVALS.length})</p>
          <div className="mx-auto mt-2 w-3/4 h-1 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${((currentStep + 1) / TEST_INTERVALS.length) * 100}%` }} />
          </div>
        </div>
      )}
      {stepResults.length > 0 && (
        <table className="w-full text-[9px] font-mono border border-border/20 rounded overflow-hidden">
          <thead><tr className="bg-secondary/40 text-foreground/60"><th className="text-left px-1.5 py-1">Int</th><th className="text-right px-1.5">Medel</th><th className="text-right px-1.5">Max</th><th className="text-center px-1.5">OK</th></tr></thead>
          <tbody>
            {stepResults.map((r, i) => (
              <tr key={i} className={r.stable ? '' : 'text-destructive/70'}>
                <td className="px-1.5 py-0.5">{r.intervalMs}ms</td>
                <td className="px-1.5 text-right">{r.meanMs}ms</td>
                <td className="px-1.5 text-right">{r.maxMs}ms</td>
                <td className="px-1.5 text-center">{r.stable ? '✓' : '✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {phase === 'done' && optimalMs != null && (
        <div className="space-y-2">
          <p className="text-xs text-foreground">Optimalt: <span className="font-mono font-bold text-primary">{optimalMs}ms</span> ({Math.round(1000 / optimalMs)} cmd/s)</p>
          {!saved ? (
            <Button size="sm" onClick={handleSave} className="text-xs gap-1 w-full"><Check className="w-3.5 h-3.5" /> Spara</Button>
          ) : (
            <p className="text-xs text-primary font-bold">✓ Sparad!</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Calibration History ── */

function HistorySection({ deviceName }: { deviceName: string | null }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!deviceName) return;
    setLoading(true);
    setEntries(await listCalibrationsFromCloud(deviceName));
    setLoading(false);
  }, [deviceName]);

  useEffect(() => { load(); }, [load]);

  if (!deviceName) return <p className="text-[10px] text-muted-foreground">Anslut lampa för historik.</p>;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-foreground/70">Historik</span>
        <button onClick={load} className="text-muted-foreground hover:text-foreground"><RefreshCw className="w-3 h-3" /></button>
      </div>
      {loading && <p className="text-[10px] text-muted-foreground">Laddar…</p>}
      {!loading && entries.length === 0 && <p className="text-[10px] text-muted-foreground">Inga poster.</p>}
      {!loading && entries.map((e) => (
        <div key={e.id} className="flex justify-between items-center text-[9px] font-mono text-foreground/60 border-b border-border/10 py-0.5">
          <span>{new Date(e.updated_at).toLocaleDateString('sv')} {new Date(e.updated_at).toLocaleTimeString('sv', { hour: '2-digit', minute: '2-digit' })}</span>
          <div className="flex items-center gap-2">
            {e.ble_min_interval_ms && <span>BLE:{e.ble_min_interval_ms}ms</span>}
            <button onClick={async () => { await deleteCalibrationFromCloud(e.id); setEntries(prev => prev.filter(x => x.id !== e.id)); }} className="text-muted-foreground hover:text-destructive"><Trash2 className="w-2.5 h-2.5" /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Main Overlay ── */

interface CalibrationOverlayProps {
  onClose: () => void;
  onCalibrationChange?: (cal: LightCalibration) => void;
}

export default function CalibrationOverlay({ onClose, onCalibrationChange }: CalibrationOverlayProps) {
  const [cal, setCal] = useState<LightCalibration>(getCalibration);
  const [activeSlider, setActiveSlider] = useState<number>(0);
  const [showBle, setShowBle] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conn, setConn] = useState(getBleConnection);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeBle(() => setConn(getBleConnection())), []);

  const update = useCallback((key: keyof LightCalibration, value: number) => {
    setCal(prev => {
      const next = { ...prev, [key]: value };
      saveCalibration(next, conn?.device?.name, { localOnly: true });
      onCalibrationChange?.(next);
      return next;
    });
  }, [conn?.device?.name, onCalibrationChange]);

  const handleClose = useCallback(() => {
    saveCalibration(cal, conn?.device?.name);
    onClose();
  }, [cal, conn?.device?.name, onClose]);

  const resetAll = useCallback(() => {
    const fresh = { ...DEFAULT_CALIBRATION };
    setCal(fresh);
    saveCalibration(fresh, conn?.device?.name);
    onCalibrationChange?.(fresh);
  }, [conn?.device?.name, onCalibrationChange]);

  const activeDef = SLIDERS[activeSlider];

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'hsl(var(--background) / 0.92)', backdropFilter: 'blur(20px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] border-b border-border/20">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-bold tracking-widest uppercase text-foreground/80">Mixer</h2>
          {conn && <span className="text-[9px] font-mono text-primary/60">{conn.device?.name}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={resetAll} className="rounded-full w-7 h-7" title="Återställ allt">
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleClose} className="rounded-full w-7 h-7">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Mixer faders — horizontal scroll */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Group labels */}
        <div className="px-3 pt-2 pb-1 flex gap-3 text-[9px] font-bold text-muted-foreground tracking-wide">
          <span style={{ color: 'hsl(48, 90%, 60%)' }}>LJUS</span>
          <span style={{ color: 'hsl(142, 70%, 50%)' }}>DYNAMIK</span>
          <span style={{ color: 'hsl(0, 80%, 60%)' }}>KICK</span>
          
        </div>

        {/* Scrollable fader strip */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-x-auto overflow-y-hidden px-2 pb-1"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div className="flex gap-2 h-full items-center min-w-max py-2">
            {SLIDERS.map((def, i) => {
              // Add group separator
              const prevGroup = i > 0 ? SLIDERS[i - 1].group : null;
              const showSep = prevGroup && prevGroup !== def.group;
              return (
                <div key={def.key} className="flex items-center">
                  {showSep && <div className="w-px h-24 bg-border/30 mx-1" />}
                  <MixerFader
                    def={def}
                    value={cal[def.key] as number}
                    onChange={(v) => update(def.key, v)}
                    isActive={activeSlider === i}
                    onFocus={() => setActiveSlider(i)}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Description box */}
        <div className="px-3 py-2 border-t border-border/20 bg-secondary/30">
          <p className="text-[10px] font-bold text-foreground/80">{activeDef.label} <span className="text-muted-foreground font-normal">({activeDef.group})</span></p>
          <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">{activeDef.description}</p>
          <p className="text-[9px] text-muted-foreground/60 mt-0.5">
            Standard: {formatValue(activeDef, DEFAULT_CALIBRATION[activeDef.key] as number)}{activeDef.unit} · Nu: <span className="text-foreground/80 font-bold">{formatValue(activeDef, cal[activeDef.key] as number)}{activeDef.unit}</span>
          </p>
        </div>

        {/* Collapsible sections */}
        <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-1 overflow-y-auto max-h-[30vh]">
          {/* BLE Speed */}
          <button
            onClick={() => setShowBle(!showBle)}
            className="w-full flex items-center justify-between py-1.5 text-[10px] font-bold text-foreground/70"
          >
            BLE-hastighetstest
            {showBle ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showBle && <BleSpeedSection conn={conn} />}

          {/* History */}
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="w-full flex items-center justify-between py-1.5 text-[10px] font-bold text-foreground/70"
          >
            Kalibreringshistorik
            {showHistory ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showHistory && <HistorySection deviceName={conn?.device?.name ?? null} />}
        </div>
      </div>
    </div>
  );
}
