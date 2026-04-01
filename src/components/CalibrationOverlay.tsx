import { useState, useCallback, useEffect, useRef } from "react";
import { X, RotateCcw, Save, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getCalibration, saveCalibration, DEFAULT_CALIBRATION,
  getIdleColor, saveIdleColor,
  type LightCalibration, type PresetName,
} from "@/lib/engine/lightCalibration";
import { DEFAULT_TICK_MS } from "@/lib/engine/lightEngine";
import { getDimmingGamma, setDimmingGamma, DEFAULT_DIMMING_GAMMA } from "@/lib/engine/bledom";
import { getBleConnection, subscribeBle } from "@/lib/engine/bleStore";
import { getPipelineTimings } from "@/lib/ui/pipelineTimings";

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
  // Frequency
  { key: 'bassWeight', label: 'Basvikt', shortLabel: 'Bass', min: 0, max: 1, step: 0.05, unit: '', group: 'Frekvens', description: 'Hur mycket bas påverkar ljusstyrkan. 0.7 = 70% bas, 30% diskant.' },
  { key: 'hiShelfGainDb', label: 'Hi-shelf gain', shortLabel: 'HiSh', min: 0, max: 12, step: 0.5, unit: 'dB', group: 'Frekvens', description: 'Diskantkompensation för mikrofonen. 6 dB = standard för laptopmic.' },
  // Dynamics
  { key: 'attackAlpha', label: 'Attack', shortLabel: 'Atk', min: 0.05, max: 1.0, step: 0.01, unit: 'α', group: 'Dynamik', description: 'Hur snabbt ljuset reagerar uppåt. 1.0 = ingen smoothing.' },
  { key: 'releaseAlpha', label: 'Release', shortLabel: 'Rel', min: 0.005, max: 1.0, step: 0.005, unit: 'α', group: 'Dynamik', description: 'Hur snabbt ljuset tonar ner. 1.0 = ingen smoothing.', format: v => v.toFixed(3) },
  { key: 'dynamicDamping', label: 'Dynamik', shortLabel: 'Dyn', min: -3.0, max: 2.0, step: 0.1, unit: '×', group: 'Dynamik', description: 'Positivt = förstärkt kontrast. Negativt = utjämnad. 0 = neutral.' },
  { key: 'smoothing', label: 'Smoothing', shortLabel: 'Smth', min: 0, max: 100, step: 1, unit: '%', group: 'Dynamik', description: 'Extra utjämning av ljuskurvan. 0 = av, högre = mjukare.' },
  { key: 'brightnessFloor', label: 'Golv', shortLabel: 'Floor', min: 0, max: 25, step: 1, unit: '%', group: 'Dynamik', description: 'Lägsta brightness. Ljuset går aldrig under detta värde.' },
  // AGC
  { key: 'volCompensation', label: 'Volymkomp.', shortLabel: 'Vol', min: 0, max: 100, step: 5, unit: '%', group: 'AGC', description: 'Hur mycket en volymändring direkt skalas om i AGC.' },
  // Punch
  { key: 'punchWhiteThreshold', label: 'Punch White', shortLabel: 'Punch', min: 90, max: 100, step: 0.5, unit: '%', group: 'Punch', description: '100 = av. Ljusstyrka över detta → vit färg.' },
];

const BYPASS_VALUES: Record<string, number> = {
  bassWeight: 0.5,
  hiShelfGainDb: 0,
  attackAlpha: 1.0,
  releaseAlpha: 1.0,
  dynamicDamping: 0,
  smoothing: 0,
  brightnessFloor: 0,
  volCompensation: 80,
  punchWhiteThreshold: 100,
};

const IDLE_PRESETS: { color: [number, number, number]; label: string }[] = [
  { color: [255, 60, 0], label: 'Orange' },
  { color: [255, 0, 0], label: 'Röd' },
  { color: [255, 140, 0], label: 'Amber' },
  { color: [255, 200, 50], label: 'Varm vit' },
  { color: [0, 80, 255], label: 'Blå' },
  { color: [180, 0, 255], label: 'Lila' },
  { color: [0, 255, 80], label: 'Grön' },
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

  const groupColors: Record<string, string> = {
    'Frekvens': 'hsl(200, 80%, 55%)',
    'Dynamik': 'hsl(142, 70%, 50%)',
    'AGC': 'hsl(170, 60%, 50%)',
    'Punch': 'hsl(45, 90%, 55%)',
  };
  const accentColor = groupColors[def.group] ?? 'hsl(var(--primary))';

  return (
    <div
      className={`flex flex-col items-center gap-1 min-w-[3rem] transition-all ${isActive ? 'scale-105' : ''}`}
      onClick={onFocus}
    >
      <button
        onClick={(e) => { e.stopPropagation(); nudge(1); }}
        className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
      >
        +
      </button>

      <div
        ref={trackRef}
        className="relative w-3 rounded-full touch-none select-none cursor-ns-resize"
        style={{ height: '4.5rem', background: 'hsl(var(--secondary))' }}
        onPointerDown={handlePointer}
      >
        {(() => {
          const bypassVal = BYPASS_VALUES[def.key] ?? def.min;
          const bypassPct = ((bypassVal - def.min) / (def.max - def.min)) * 100;
          const bottom = Math.min(pct, bypassPct);
          const top = Math.max(pct, bypassPct);
          return (
            <div
              className="absolute left-0 right-0 rounded-full transition-none"
              style={{ bottom: `${bottom}%`, height: `${top - bottom}%`, background: accentColor, opacity: 0.45 }}
            />
          );
        })()}
        {(() => {
          const bypassVal = BYPASS_VALUES[def.key] ?? def.min;
          const bypassPct = ((bypassVal - def.min) / (def.max - def.min)) * 100;
          return (
            <div
              className="absolute left-0 right-0 h-px transition-none"
              style={{ bottom: `${bypassPct}%`, borderTop: '1px dashed hsl(var(--foreground) / 0.35)' }}
            />
          );
        })()}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-5 h-3 rounded-sm shadow-md border transition-none"
          style={{
            bottom: `calc(${pct}% - 6px)`,
            background: isActive ? accentColor : 'hsl(var(--foreground) / 0.9)',
            borderColor: isActive ? accentColor : 'hsl(var(--border))',
          }}
        />
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); nudge(-1); }}
        className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
      >
        −
      </button>

      <span className={`text-[9px] font-bold tracking-wide leading-tight text-center ${isDefault ? 'text-muted-foreground' : 'text-foreground'}`}>
        {def.shortLabel}
      </span>
      <span className={`text-[9px] font-mono leading-tight ${isDefault ? 'text-muted-foreground/60' : 'text-foreground/80'}`}>
        {formatValue(def, value)}{def.unit}
      </span>
    </div>
  );
}

/* ── Pipeline stats ── */

function PipelineStats() {
  const [stats, setStats] = useState({ tickMs: 0 });

  useEffect(() => {
    const id = setInterval(() => {
      const pipe = getPipelineTimings();
      setStats({ tickMs: pipe.totalTickMs });
    }, 300);
    return () => clearInterval(id);
  }, []);

  const warn = stats.tickMs > 20;

  return (
    <div className={`text-[10px] font-mono leading-tight ${warn ? 'text-red-400' : 'text-muted-foreground/70'}`}>
      Pipeline {stats.tickMs.toFixed(1)}ms
    </div>
  );
}

/* ── Mini chart removed — we reuse the main MicPanel chart behind this overlay ── */

interface CalibrationOverlayProps {
  onClose: () => void;
  onCalibrationChange?: (cal: LightCalibration) => void;
  activePreset?: PresetName | null;
  onPresetSave?: (name: PresetName, cal: LightCalibration) => void;
  tickMs?: number;
  onTickMsChange?: (ms: number) => void;
  dimmingGamma?: number;
  onDimmingGammaChange?: (v: number) => void;
}

export default function CalibrationOverlay({ onClose, onCalibrationChange, activePreset, onPresetSave, tickMs = DEFAULT_TICK_MS, onTickMsChange, dimmingGamma = DEFAULT_DIMMING_GAMMA, onDimmingGammaChange }: CalibrationOverlayProps) {
  const [idleColor, setIdleColorState] = useState(getIdleColor);
  const [cal, setCal] = useState<LightCalibration>(getCalibration);
  const [savedCal, setSavedCal] = useState<LightCalibration>(getCalibration);
  const [activeSlider, setActiveSlider] = useState<number>(0);
  const [conn, setConn] = useState(getBleConnection);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showIdleMenu, setShowIdleMenu] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const isDirty = JSON.stringify(cal) !== JSON.stringify(savedCal);

  useEffect(() => subscribeBle(() => setConn(getBleConnection())), []);

  // Sync local state when calibration changes externally (e.g. preset switch)
  useEffect(() => {
    const handler = () => {
      const fresh = getCalibration();
      setCal(fresh);
      setSavedCal(fresh);
    };
    window.addEventListener('calibration-changed', handler);
    return () => window.removeEventListener('calibration-changed', handler);
  }, []);

  const update = useCallback((key: keyof LightCalibration, value: number) => {
    setCal(prev => {
      const next = { ...prev, [key]: value };
      saveCalibration(next, conn?.device?.name, { localOnly: true });
      onCalibrationChange?.(next);
      return next;
    });
  }, [conn?.device?.name, onCalibrationChange]);

  const handleSave = useCallback(() => {
    const targetPreset = activePreset ?? 'Custom';
    saveCalibration(cal, conn?.device?.name);
    onPresetSave?.(targetPreset, cal);
    setSavedCal(cal);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1500);
  }, [cal, conn?.device?.name, activePreset, onPresetSave]);

  const handleClose = useCallback(() => {
    saveCalibration(cal, conn?.device?.name);
    onClose();
  }, [cal, conn?.device?.name, onClose]);

  const resetAll = useCallback(() => {
    const fresh = { ...DEFAULT_CALIBRATION };
    setCal(fresh);
    setSavedCal(fresh);
    saveCalibration(fresh, conn?.device?.name);
    onCalibrationChange?.(fresh);
  }, [conn?.device?.name, onCalibrationChange]);

  const bypassAll = useCallback(() => {
    const neutral: LightCalibration = {
      ...DEFAULT_CALIBRATION,
      bassWeight: 0.5,
      hiShelfGainDb: 0,
      attackAlpha: 1.0,
      releaseAlpha: 1.0,
      dynamicDamping: 0,
    };
    setCal(neutral);
    saveCalibration(neutral, conn?.device?.name);
    onCalibrationChange?.(neutral);
  }, [conn?.device?.name, onCalibrationChange]);

  const activeDef = SLIDERS[activeSlider];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[60] flex flex-col" style={{ background: 'hsl(var(--background) / 0.88)', backdropFilter: 'blur(20px)' }}>
      {/* Compact header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/20">
        <div className="flex items-center gap-2">
          <h2 className="text-[10px] font-bold tracking-widest uppercase text-foreground/80">Mixer{activePreset ? ` — ${activePreset}` : ''}</h2>
          {conn && <span className="text-[9px] font-mono text-primary/60">{conn.device?.name}</span>}
          <PipelineStats />
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative flex items-center">
            <button
              className="w-5 h-5 rounded-full border border-border/40 active:scale-90 transition-transform"
              style={{ background: `rgb(${idleColor[0]},${idleColor[1]},${idleColor[2]})` }}
              title="Vilofärg"
              onClick={() => setShowIdleMenu(prev => !prev)}
            />
            {showIdleMenu && (
              <div className="absolute right-0 bottom-8 z-10 bg-background/95 backdrop-blur-md border border-border/30 rounded-lg p-2 flex flex-col gap-1 shadow-xl">
                <span className="text-[9px] text-muted-foreground px-1 pb-1">Färg vid paus</span>
                {IDLE_PRESETS.map(({ color, label }) => {
                  const isActive = idleColor[0] === color[0] && idleColor[1] === color[1] && idleColor[2] === color[2];
                  return (
                    <button
                      key={label}
                      onClick={() => {
                        setIdleColorState(color);
                        saveIdleColor(color);
                        window.dispatchEvent(new CustomEvent('idle-color-changed'));
                        setShowIdleMenu(false);
                      }}
                      className={`flex items-center gap-2 px-2 py-1 rounded text-[10px] transition-colors ${isActive ? 'bg-secondary text-foreground font-bold' : 'text-foreground/70 hover:bg-secondary/50'}`}
                    >
                      <span className="w-4 h-4 rounded-full shrink-0" style={{ background: `rgb(${color[0]},${color[1]},${color[2]})` }} />
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={bypassAll} className="rounded-full h-6 px-2 text-[9px] font-bold tracking-wide uppercase" title="Nollställ – ingen påverkan">
            Bypass
          </Button>
          <Button variant="ghost" size="icon" onClick={resetAll} className="rounded-full w-6 h-6" title="Återställ standard">
            <RotateCcw className="w-3 h-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSave}
            className={`rounded-full w-6 h-6 transition-colors ${isDirty ? 'text-primary animate-pulse' : ''}`}
            title={isDirty ? 'Spara ändringar' : 'Sparad'}
          >
            {justSaved ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Save className={`w-3.5 h-3.5 ${isDirty ? '' : 'text-muted-foreground/40'}`} />}
          </Button>
          <Button variant="ghost" size="icon" onClick={handleClose} className="rounded-full w-6 h-6">
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Fader strip + description side by side */}
      <div className="flex">
        {/* Active slider description — left column */}
        <div className="flex items-center px-3 py-1.5 border-r border-border/20 min-w-[5.5rem] max-w-[6.5rem]">
          <p className="text-[9px] text-muted-foreground leading-tight">
            <span className="font-bold text-foreground/80 block">{activeDef?.label}</span>
            <span className="font-mono text-foreground/70">{activeDef ? formatValue(activeDef, cal[activeDef.key] as number) : ''}{activeDef?.unit}</span>
            <br />
            {activeDef?.description}
          </p>
        </div>

        {/* Scrollable fader strip */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-x-auto overflow-y-hidden px-2 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div className="flex gap-2 items-center justify-center min-w-max py-1.5 mx-auto" style={{ height: '11rem' }}>
            {SLIDERS.map((def, i) => {
              const prevGroup = i > 0 ? SLIDERS[i - 1].group : null;
              const showSep = prevGroup && prevGroup !== def.group;
              return (
                <div key={def.key} className="flex items-center">
                  {showSep && <div className="w-px h-20 bg-border/30 mx-1" />}
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
            {/* Tick rate fader — after calibration sliders */}
            <div className="flex items-center">
              <div className="w-px h-20 bg-border/30 mx-1" />
              <div className="flex flex-col items-center gap-1 min-w-[3rem]">
                <button
                  onClick={() => onTickMsChange?.(Math.max(40, tickMs - 1))}
                  className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
                >+</button>
                <div
                  className="relative w-3 rounded-full touch-none select-none cursor-ns-resize"
                  style={{ height: '4.5rem', background: 'hsl(var(--secondary))' }}
                  onPointerDown={(e) => {
                    const track = e.currentTarget;
                    const el = e.currentTarget as HTMLElement;
                    el.setPointerCapture(e.pointerId);
                    const update = (ev: PointerEvent) => {
                      const rect = track.getBoundingClientRect();
                      const rawPct = 1 - Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
                      const ms = Math.round(125 - rawPct * 85);
                      onTickMsChange?.(Math.max(40, Math.min(125, ms)));
                    };
                    update(e.nativeEvent);
                    const move = (ev: PointerEvent) => update(ev);
                    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
                    el.addEventListener('pointermove', move);
                    el.addEventListener('pointerup', up);
                  }}
                >
                  {/* Default reference line */}
                  {(() => {
                    const defMs = Math.max(40, Math.min(125, DEFAULT_TICK_MS));
                    const bypassPct = ((125 - defMs) / 85) * 100;
                    return <div className="absolute left-0 right-0 h-px" style={{ bottom: `${bypassPct}%`, borderTop: '1px dashed hsl(var(--foreground) / 0.35)' }} />;
                  })()}
                  {/* Thumb */}
                  {(() => {
                    const pct = ((125 - tickMs) / 85) * 100;
                    return (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 w-5 h-3 rounded-sm shadow-md border"
                        style={{ bottom: `calc(${pct}% - 6px)`, background: 'hsl(30, 90%, 55%)', borderColor: 'hsl(30, 90%, 55%)' }}
                      />
                    );
                  })()}
                </div>
                <button
                  onClick={() => onTickMsChange?.(Math.min(125, tickMs + 1))}
                  className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
                >−</button>
                <span className="text-[9px] font-mono leading-tight text-foreground/80">{tickMs}</span>
                <span className="text-[9px] font-bold tracking-wide leading-tight text-center text-foreground">ms</span>
              </div>
            </div>
            {/* Dimming gamma fader */}
            <div className="flex items-center">
              <div className="w-px h-20 bg-border/30 mx-1" />
              <div className="flex flex-col items-center gap-1 min-w-[3rem]">
                <button
                  onClick={() => onDimmingGammaChange?.(Math.min(3.0, Math.round((dimmingGamma + 0.1) * 10) / 10))}
                  className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
                >+</button>
                <div
                  className="relative w-3 rounded-full touch-none select-none cursor-ns-resize"
                  style={{ height: '4.5rem', background: 'hsl(var(--secondary))' }}
                  onPointerDown={(e) => {
                    const track = e.currentTarget;
                    const el = e.currentTarget as HTMLElement;
                    el.setPointerCapture(e.pointerId);
                    const update = (ev: PointerEvent) => {
                      const rect = track.getBoundingClientRect();
                      const rawPct = 1 - Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
                      const v = Math.round((1.0 + rawPct * 2.0) * 10) / 10;
                      onDimmingGammaChange?.(Math.max(1.0, Math.min(3.0, v)));
                    };
                    update(e.nativeEvent);
                    const move = (ev: PointerEvent) => update(ev);
                    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
                    el.addEventListener('pointermove', move);
                    el.addEventListener('pointerup', up);
                  }}
                >
                  {/* Default reference line */}
                  {(() => {
                    const bypassPct = ((DEFAULT_DIMMING_GAMMA - 1.0) / 2.0) * 100;
                    return <div className="absolute left-0 right-0 h-px" style={{ bottom: `${bypassPct}%`, borderTop: '1px dashed hsl(var(--foreground) / 0.35)' }} />;
                  })()}
                  {/* Thumb */}
                  {(() => {
                    const pct = ((dimmingGamma - 1.0) / 2.0) * 100;
                    return (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 w-5 h-3 rounded-sm shadow-md border"
                        style={{ bottom: `calc(${pct}% - 6px)`, background: 'hsl(200, 80%, 50%)', borderColor: 'hsl(200, 80%, 50%)' }}
                      />
                    );
                  })()}
                </div>
                <button
                  onClick={() => onDimmingGammaChange?.(Math.max(1.0, Math.round((dimmingGamma - 0.1) * 10) / 10))}
                  className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
                >−</button>
                <span className="text-[9px] font-mono leading-tight text-foreground/80">{dimmingGamma.toFixed(1)}</span>
                <span className="text-[9px] font-bold tracking-wide leading-tight text-center text-foreground">γ</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
