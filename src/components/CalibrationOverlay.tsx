import { useState, useCallback, useEffect, useRef } from "react";
import { X, RotateCcw, Save, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getCalibration, saveCalibration, DEFAULT_CALIBRATION,
  getIdleColor, saveIdleColor,
  PALETTE_MODES, PALETTE_MODE_LABELS,
  type LightCalibration, type PresetName,
} from "@/lib/engine/lightCalibration";
import { DEFAULT_TICK_MS } from "@/lib/engine/lightEngine";
import { getDimmingGamma, setDimmingGamma, DEFAULT_DIMMING_GAMMA } from "@/lib/engine/bledom";
import { getBleConnection, subscribeBle } from "@/lib/engine/bleStore";
import { getPipelineTimings } from "@/lib/ui/pipelineTimings";

/* ── Slider definitions ── */

interface SliderDef {
  key: keyof LightCalibration | '_softness';
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

/** Profile sliders — saved per-preset */
const PROFILE_SLIDERS: SliderDef[] = [
  { key: 'bassWeight', label: 'Bas ↔ Disk', shortLabel: 'B↔D', min: 0, max: 1, step: 0.05, unit: '', group: 'Frekvens', description: 'Crossfader: hur mycket bas vs diskant styr ljuset. 0 = bara diskant, 0.5 = lika, 1.0 = bara bas.' },
  { key: '_softness', label: 'Mjukhet', shortLabel: 'Soft', min: 0, max: 100, step: 1, unit: '', group: 'Dynamik', description: 'Hur mjukt ljuset beter sig. 0 = rått/direkt, 100 = mycket mjukt/långsamt. Bypass = 0.' },
  { key: 'dynamicDamping', label: 'Dynamik', shortLabel: 'Dyn', min: -3.0, max: 2.0, step: 0.1, unit: '×', group: 'Dynamik', description: 'Positivt = förstärkt kontrast. Negativt = utjämnad. 0 = neutral.' },
  { key: 'brightnessFloor', label: 'Golv', shortLabel: 'Floor', min: 0, max: 25, step: 1, unit: '%', group: 'Dynamik', description: 'Lägsta brightness. Ljuset går aldrig under detta värde.' },
  { key: 'punchWhiteThreshold', label: 'Punch White', shortLabel: 'Punch', min: 90, max: 100, step: 0.5, unit: '%', group: 'Effekt', description: '100 = av. Ljusstyrka över detta → vit färg.' },
];

/** Global sliders — shared across all presets */
const GLOBAL_SLIDERS: SliderDef[] = [];

const BYPASS_VALUES: Record<string, number> = {
  bassWeight: 0.5,
  _softness: 0,
  dynamicDamping: 0,
  brightnessFloor: 0,
  punchWhiteThreshold: 100,
};

/** Convert Softness 0-100 → releaseAlpha + smoothing */
function softnessToParams(s: number): { releaseAlpha: number; smoothing: number } {
  // 0 = raw (release=1.0, smoothing=0), 100 = very smooth (release=0.005, smoothing=80)
  const t = s / 100;
  const releaseAlpha = 1.0 - 0.995 * Math.pow(t, 0.7);
  const smoothing = Math.round(t * 80);
  return { releaseAlpha: Math.max(0.005, Math.round(releaseAlpha * 1000) / 1000), smoothing };
}

/** Convert releaseAlpha → approximate Softness 0-100 */
function paramsToSoftness(releaseAlpha: number): number {
  // Inverse: t = ((1.0 - releaseAlpha) / 0.995) ^ (1/0.7)
  const t = Math.pow(Math.max(0, (1.0 - releaseAlpha)) / 0.995, 1 / 0.7);
  return Math.round(Math.max(0, Math.min(100, t * 100)));
}

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
  def, value, onChange, isActive, onFocus, accentColor,
}: {
  def: SliderDef;
  value: number;
  onChange: (v: number) => void;
  isActive: boolean;
  onFocus: () => void;
  accentColor?: string;
}) {
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
    'Global': 'hsl(30, 90%, 55%)',
  };
  const color = accentColor ?? groupColors[def.group] ?? 'hsl(var(--primary))';
  const isDefault = value === (BYPASS_VALUES[def.key] ?? def.min);

  return (
    <div
      className={`flex flex-col items-center gap-1 min-w-[3rem] transition-all ${isActive ? 'scale-105' : ''}`}
      onClick={onFocus}
    >
      <button
        onClick={(e) => { e.stopPropagation(); nudge(1); }}
        className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
      >+</button>

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
              style={{ bottom: `${bottom}%`, height: `${top - bottom}%`, background: color, opacity: 0.45 }}
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
            background: isActive ? color : 'hsl(var(--foreground) / 0.9)',
            borderColor: isActive ? color : 'hsl(var(--border))',
          }}
        />
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); nudge(-1); }}
        className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
      >−</button>

      <span className={`text-[9px] font-bold tracking-wide leading-tight text-center ${isDefault ? 'text-muted-foreground' : 'text-foreground'}`}>
        {def.shortLabel}
      </span>
      <span className={`text-[9px] font-mono leading-tight ${isDefault ? 'text-muted-foreground/60' : 'text-foreground/80'}`}>
        {formatValue(def, value)}{def.unit}
      </span>
    </div>
  );
}

/* ── Generic vertical fader (for tick rate, gamma) ── */

function GenericFader({
  label, shortLabel, value, min, max, step, unit,
  defaultValue, onChange, accentColor, isActive, onFocus,
}: {
  label: string; shortLabel: string;
  value: number; min: number; max: number; step: number; unit: string;
  defaultValue: number; onChange: (v: number) => void;
  accentColor: string; isActive: boolean; onFocus: () => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const bypassPct = ((defaultValue - min) / (max - min)) * 100;

  return (
    <div className={`flex flex-col items-center gap-1 min-w-[3rem] transition-all ${isActive ? 'scale-105' : ''}`} onClick={onFocus}>
      <button
        onClick={(e) => { e.stopPropagation(); onChange(Math.min(max, Math.round((value + step) * 1000) / 1000)); }}
        className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
      >+</button>
      <div
        className="relative w-3 rounded-full touch-none select-none cursor-ns-resize"
        style={{ height: '4.5rem', background: 'hsl(var(--secondary))' }}
        onPointerDown={(e) => {
          onFocus();
          const track = e.currentTarget;
          const el = e.currentTarget as HTMLElement;
          el.setPointerCapture(e.pointerId);
          const update = (ev: PointerEvent) => {
            const rect = track.getBoundingClientRect();
            const rawPct = 1 - Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
            const raw = min + rawPct * (max - min);
            const snapped = Math.round(raw / step) * step;
            onChange(Math.max(min, Math.min(max, Math.round(snapped * 1000) / 1000)));
          };
          update(e.nativeEvent);
          const move = (ev: PointerEvent) => update(ev);
          const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
        }}
      >
        <div className="absolute left-0 right-0 h-px" style={{ bottom: `${bypassPct}%`, borderTop: '1px dashed hsl(var(--foreground) / 0.35)' }} />
        {(() => {
          const bottom = Math.min(pct, bypassPct);
          const top = Math.max(pct, bypassPct);
          return <div className="absolute left-0 right-0 rounded-full" style={{ bottom: `${bottom}%`, height: `${top - bottom}%`, background: accentColor, opacity: 0.45 }} />;
        })()}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-5 h-3 rounded-sm shadow-md border"
          style={{ bottom: `calc(${pct}% - 6px)`, background: isActive ? accentColor : 'hsl(var(--foreground) / 0.9)', borderColor: isActive ? accentColor : 'hsl(var(--border))' }}
        />
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onChange(Math.max(min, Math.round((value - step) * 1000) / 1000)); }}
        className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold active:scale-90 transition-transform bg-secondary/60 text-foreground/70 hover:bg-secondary"
      >−</button>
      <span className="text-[9px] font-bold tracking-wide leading-tight text-center text-foreground">{shortLabel}</span>
      <span className="text-[9px] font-mono leading-tight text-foreground/80">
        {step < 1 ? value.toFixed(1) : String(Math.round(value))}{unit}
      </span>
    </div>
  );
}

/* ── Toggle fader (on/off, styled like a mini fader) ── */

function ToggleFader({
  label, title, value, onChange, accentColor, onFocus,
}: {
  label: string; title: string;
  value: boolean; onChange: (v: boolean) => void;
  accentColor: string; onFocus?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-[3rem]" title={title}>
      <div
        className="relative w-3 rounded-full cursor-pointer select-none"
        style={{ height: '2.5rem', background: 'hsl(var(--secondary))' }}
        onClick={() => { onFocus?.(); onChange(!value); }}
      >
        {value && (
          <div className="absolute left-0 right-0 bottom-0 rounded-full" style={{ height: '100%', background: accentColor, opacity: 0.35 }} />
        )}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-5 h-3 rounded-sm shadow-md border transition-all"
          style={{
            bottom: value ? 'calc(100% - 10px)' : '2px',
            background: value ? accentColor : 'hsl(var(--foreground) / 0.5)',
            borderColor: value ? accentColor : 'hsl(var(--border))',
          }}
        />
      </div>
      <span className="text-[10px] leading-tight text-center">{label}</span>
      <span className={`text-[9px] font-mono leading-tight ${value ? 'text-foreground/80' : 'text-muted-foreground/60'}`}>
        {value ? 'på' : 'av'}
      </span>
    </div>
  );
}

/* ── Pipeline stats ── */

function PipelineStats() {
  const [stats, setStats] = useState({ tickMs: 0 });
  useEffect(() => {
    const id = setInterval(() => { setStats({ tickMs: getPipelineTimings().totalTickMs }); }, 300);
    return () => clearInterval(id);
  }, []);
  const warn = stats.tickMs > 20;
  return (
    <div className={`text-[10px] font-mono leading-tight ${warn ? 'text-red-400' : 'text-muted-foreground/70'}`}>
      Pipeline {stats.tickMs.toFixed(1)}ms
    </div>
  );
}

/* ── Main overlay ── */

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
  const [activeSlider, setActiveSlider] = useState<string>('bassWeight');
  const [conn, setConn] = useState(getBleConnection);
  const [showIdleMenu, setShowIdleMenu] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const isDirty = JSON.stringify(cal) !== JSON.stringify(savedCal);
  const softness = paramsToSoftness(cal.releaseAlpha);

  useEffect(() => subscribeBle(() => setConn(getBleConnection())), []);

  useEffect(() => {
    const handler = () => { const fresh = getCalibration(); setCal(fresh); setSavedCal(fresh); };
    window.addEventListener('calibration-changed', handler);
    return () => window.removeEventListener('calibration-changed', handler);
  }, []);

  const update = useCallback((key: keyof LightCalibration, value: number) => {
    setCal(prev => {
      const next = { ...prev, [key]: value, attackAlpha: 1.0 };
      saveCalibration(next, conn?.device?.name, { localOnly: true });
      onCalibrationChange?.(next);
      return next;
    });
  }, [conn?.device?.name, onCalibrationChange]);

  const updateSoftness = useCallback((s: number) => {
    setCal(prev => {
      const { releaseAlpha, smoothing } = softnessToParams(s);
      const next = { ...prev, releaseAlpha, smoothing, attackAlpha: 1.0 };
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
    setCal(fresh); setSavedCal(fresh);
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

  // Extra descriptions for non-slider controls
  const EXTRA_DESCS: Record<string, { label: string; description: string; value: string }> = {
    '_tickMs': { label: 'Tick-intervall', description: 'Hur ofta ljuset uppdateras. Lägre = snabbare men kräver mer BLE-bandbredd.', value: `${tickMs}ms` },
    '_gamma': { label: 'Dimningsgamma', description: 'Icke-linjär kurva för LED-dimning. Högre γ = djupare mörker vid låga nivåer, mjukare fade.', value: `γ ${dimmingGamma.toFixed(1)}` },
    '_transient': { label: '⚡ Transient-boost', description: 'Ger upp till 15% extra ljusstyrka vid transienter (trumslag, attacker). Gör rytmen tydligare.', value: cal.transientBoost !== false ? 'På' : 'Av' },
    '_perceptual': { label: '👁 Perceptuell kurva', description: 'CIE-baserad gammakorrektion som lyfter låga värden så ljusändringar ser jämna ut för ögat.', value: cal.perceptualCurve === true ? 'På' : 'Av' },
  };

  // Find active slider description
  const allSliders = [...PROFILE_SLIDERS, ...GLOBAL_SLIDERS];
  const activeDef = allSliders.find(s => s.key === activeSlider);
  const extraDesc = EXTRA_DESCS[activeSlider];
  const activeLabel = activeDef?.label ?? extraDesc?.label ?? '';
  const activeDesc = activeDef?.description ?? extraDesc?.description ?? '';
  const activeValueStr = activeSlider === '_softness'
    ? `${softness}`
    : extraDesc
      ? extraDesc.value
      : activeDef && activeDef.key !== '_softness'
        ? `${formatValue(activeDef, cal[activeDef.key as keyof LightCalibration] as number)}${activeDef.unit}`
        : '';

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[60] flex flex-col" style={{ background: 'hsl(var(--background) / 0.88)', backdropFilter: 'blur(20px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/20">
        <div className="flex items-center gap-2">
          <h2 className="text-[10px] font-bold tracking-widest uppercase text-foreground/80">Mixer{activePreset ? ` — ${activePreset}` : ''}</h2>
          {conn && <span className="text-[9px] font-mono text-primary/60">{conn.device?.name}</span>}
          <PipelineStats />
        </div>
        <div className="flex items-center gap-1.5">
          {/* Idle color */}
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
          {/* Palette mode toggle */}
          <button
            onClick={() => {
              setCal(prev => {
                const modes = PALETTE_MODES;
                const curIdx = modes.indexOf(prev.paletteMode ?? 'off');
                const nextMode = modes[(curIdx + 1) % modes.length];
                const next = { ...prev, paletteMode: nextMode };
                saveCalibration(next, conn?.device?.name, { localOnly: true });
                onCalibrationChange?.(next);
                return next;
              });
            }}
            className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wide transition-all active:scale-90 ${
              (cal.paletteMode ?? 'off') !== 'off'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground/50 hover:text-foreground/80'
            }`}
            title={`Palettläge: ${PALETTE_MODE_LABELS[cal.paletteMode ?? 'off']}`}
          >
            🎨 {PALETTE_MODE_LABELS[cal.paletteMode ?? 'off']}
          </button>
          <Button variant="ghost" size="sm" onClick={bypassAll} className="rounded-full h-6 px-2 text-[9px] font-bold tracking-wide uppercase" title="Nollställ – ingen påverkan">
            Bypass
          </Button>
          <Button variant="ghost" size="icon" onClick={resetAll} className="rounded-full w-6 h-6" title="Återställ standard">
            <RotateCcw className="w-3 h-3" />
          </Button>
          <Button
            variant="ghost" size="icon"
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

      {/* Fader strip + description */}
      <div className="flex">
        {/* Active slider description */}
        <div className="flex items-center px-3 py-1.5 border-r border-border/20 min-w-[5.5rem] max-w-[6.5rem]">
          <p className="text-[9px] text-muted-foreground leading-tight">
            <span className="font-bold text-foreground/80 block">{activeLabel}</span>
            <span className="font-mono text-foreground/70">{activeValueStr}</span>
            <br />
            {activeDesc}
          </p>
        </div>

        {/* Scrollable fader strip */}
        <div
          className="flex-1 overflow-x-auto overflow-y-hidden px-2 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div className="flex gap-2 items-end min-w-max py-1.5 mx-auto" style={{ height: '12rem' }}>
            {/* ── Profile sliders ── */}
            {PROFILE_SLIDERS.map((def, i) => {
              const prevGroup = i > 0 ? PROFILE_SLIDERS[i - 1].group : null;
              const showSep = prevGroup && prevGroup !== def.group;

              if (def.key === '_softness') {
                return (
                  <div key="_softness" className="flex items-center">
                    {showSep && <div className="w-px h-20 bg-border/30 mx-1" />}
                    <MixerFader
                      def={def}
                      value={softness}
                      onChange={updateSoftness}
                      isActive={activeSlider === '_softness'}
                      onFocus={() => setActiveSlider('_softness')}
                    />
                  </div>
                );
              }

              return (
                <div key={def.key} className="flex items-center">
                  {showSep && <div className="w-px h-20 bg-border/30 mx-1" />}
                  <MixerFader
                    def={def}
                    value={cal[def.key as keyof LightCalibration] as number}
                    onChange={(v) => update(def.key as keyof LightCalibration, v)}
                    isActive={activeSlider === def.key}
                    onFocus={() => setActiveSlider(def.key)}
                  />
                </div>
              );
            })}

            {/* ── GLOBAL separator ── */}
            <div className="flex flex-col items-center justify-center mx-1">
              <div className="w-px flex-1 bg-border/50" />
              <span className="text-[8px] font-bold tracking-[0.15em] uppercase text-muted-foreground/60 py-1 [writing-mode:vertical-lr] rotate-180">Global</span>
              <div className="w-px flex-1 bg-border/50" />
            </div>

            {/* Global calibration sliders */}
            {GLOBAL_SLIDERS.map((def) => (
              <MixerFader
                key={def.key}
                def={def}
                value={cal[def.key as keyof LightCalibration] as number}
                onChange={(v) => update(def.key as keyof LightCalibration, v)}
                isActive={activeSlider === def.key}
                onFocus={() => setActiveSlider(def.key)}
                accentColor="hsl(30, 90%, 55%)"
              />
            ))}

            {/* Tick rate */}
            <GenericFader
              label="Tick-intervall" shortLabel="Tick"
              value={tickMs} min={20} max={125} step={1} unit="ms"
              defaultValue={DEFAULT_TICK_MS}
              onChange={(v) => onTickMsChange?.(v)}
              accentColor="hsl(30, 90%, 55%)"
              isActive={activeSlider === '_tickMs'}
              onFocus={() => setActiveSlider('_tickMs')}
            />

            {/* Toggle faders */}
            <ToggleFader
              label="⚡" title="Transient-boost"
              value={cal.transientBoost !== false}
              onChange={(v) => {
                setCal(prev => {
                  const next = { ...prev, transientBoost: v };
                  saveCalibration(next, conn?.device?.name, { localOnly: true });
                  onCalibrationChange?.(next);
                  return next;
                });
              }}
              accentColor="hsl(45, 90%, 55%)"
              onFocus={() => setActiveSlider('_transient')}
            />
            <ToggleFader
              label="👁" title="Perceptuell kurva"
              value={cal.perceptualCurve === true}
              onChange={(v) => {
                setCal(prev => {
                  const next = { ...prev, perceptualCurve: v };
                  saveCalibration(next, conn?.device?.name, { localOnly: true });
                  onCalibrationChange?.(next);
                  return next;
                });
              }}
              accentColor="hsl(200, 80%, 55%)"
              onFocus={() => setActiveSlider('_perceptual')}
            />
            {/* Dimming gamma */}
            <GenericFader
              label="Dimningsgamma" shortLabel="γ"
              value={dimmingGamma} min={1.0} max={3.0} step={0.1} unit=""
              defaultValue={DEFAULT_DIMMING_GAMMA}
              onChange={(v) => onDimmingGammaChange?.(v)}
              accentColor="hsl(30, 90%, 55%)"
              isActive={activeSlider === '_gamma'}
              onFocus={() => setActiveSlider('_gamma')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
