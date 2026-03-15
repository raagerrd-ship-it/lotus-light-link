import { useState, useCallback, useEffect, useRef } from "react";
import { X, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getCalibration, saveCalibration, DEFAULT_CALIBRATION,
  getIdleColor, saveIdleColor,
  type LightCalibration,
} from "@/lib/lightCalibration";
import { getBleConnection, subscribeBle } from "@/lib/bleStore";
import { getChartSamples } from "@/lib/chartStore";
import { drawIntensityChart } from "@/lib/drawChart";
import { getBleWriteStats, getPipelineTimings } from "@/lib/bledom";

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
  // Frequency
  { key: 'bassWeight', label: 'Basvikt', shortLabel: 'Bass', min: 0, max: 1, step: 0.05, unit: '', group: 'Frekvens', description: 'Hur mycket bas påverkar ljusstyrkan. 0.7 = 70% bas, 30% diskant. Lägre = mer känslig för diskant.' },
  { key: 'colorModStrength', label: 'Färgmodulering', shortLabel: 'Mod', min: 0, max: 1, step: 0.05, unit: '', group: 'Frekvens', description: 'Hur mycket frekvensinnehållet modulerar färgen. 0 = statisk färg, 1 = maximal modulering.' },
  { key: 'hiShelfGainDb', label: 'Hi-shelf gain', shortLabel: 'HiSh', min: 0, max: 12, step: 0.5, unit: 'dB', group: 'Frekvens', description: 'Diskantkompensation för mikrofonen. 6 dB = standard för laptopmic. 0 = ingen kompensation.' },
  // Dynamics
  { key: 'attackAlpha', label: 'Attack', shortLabel: 'Atk', min: 0.05, max: 0.9, step: 0.01, unit: 'α', group: 'Dynamik', description: 'Hur snabbt ljuset reagerar uppåt. Lågt = mjukare fade in, högt = omedelbar respons.' },
  { key: 'releaseAlpha', label: 'Release', shortLabel: 'Rel', min: 0.005, max: 0.3, step: 0.005, unit: 'α', group: 'Dynamik', description: 'Hur snabbt ljuset tonar ner. Lågt = lång svans, högt = snabb dip.', format: v => v.toFixed(3) },
  { key: 'dynamicDamping', label: 'Dynamik', shortLabel: 'Dyn', min: -2.0, max: 3.0, step: 0.1, unit: '×', group: 'Dynamik', description: 'Negativt = förstärkt kontrast (punch). Positivt = utjämnad dynamik. 0 = neutral.' },
  { key: 'bpmReleaseScale', label: 'BPM-release', shortLabel: 'BPM', min: 0, max: 100, step: 5, unit: '%', group: 'Dynamik', description: 'Hur mycket BPM modifierar release-hastigheten. 0% = BPM påverkar inte release. 80% = standard (lägre BPM ger långsammare release).' },
  // Palette
  { key: 'crossfadeSpeed', label: 'Färgövergång', shortLabel: 'Fade', min: 0.002, max: 0.03, step: 0.001, unit: '', group: 'Palett', description: 'Hastigheten på övergången mellan palettfärger. Lågt = mjuk lång fade, högt = snabb skarp övergång.', format: v => v.toFixed(3) },
  { key: 'saturationBoost', label: 'Färgmättnad', shortLabel: 'Sat', min: 0.5, max: 2.0, step: 0.05, unit: '×', group: 'Palett', description: 'Justerar färgmättnaden. 1.0 = neutral, <1 = urtvättad, >1 = intensivare färger.' },
  // Traits
  { key: 'energyInfluence', label: 'Energy', shortLabel: 'Engy', min: 0, max: 100, step: 5, unit: '%', group: 'Traits', description: 'Hur mycket låtens energi-värde påverkar drop-detection och ljusdynamik. 0% = ignorera energy, 100% = full effekt.' },
  { key: 'danceabilityInfluence', label: 'Danceability', shortLabel: 'Danc', min: 0, max: 100, step: 5, unit: '%', group: 'Traits', description: 'Hur mycket danceability påverkar palett-rotationshastighet. 0% = neutral hastighet, 100% = full effekt.' },
  { key: 'happinessInfluence', label: 'Happiness', shortLabel: 'Happ', min: 0, max: 100, step: 5, unit: '%', group: 'Traits', description: 'Hur mycket happiness påverkar färgtemperatur och modulering. 0% = neutral, 100% = full effekt (varmare vid glad musik).' },
  // Kick
  { key: 'whiteKickThreshold', label: 'Kick tröskel', shortLabel: 'Kick', min: 50, max: 100, step: 1, unit: '%', group: 'Kick', description: 'Hur stark basökning krävs för att trigga en vit "drop"-blixt. Lägre = fler drops.' },
  { key: 'whiteKickMs', label: 'Kick tid', shortLabel: 'Tid', min: 20, max: 200, step: 5, unit: 'ms', group: 'Kick', description: 'Hur länge den vita blixten varar vid en drop.' },
  // AGC
  { key: 'bandAgcAttack', label: 'Band AGC attack', shortLabel: 'BAtk', min: 0.02, max: 0.5, step: 0.01, unit: '', group: 'AGC', description: 'Hur snabbt per-band AGC fångar toppar i bas/diskant. Högt = snabbare anpassning, lågt = stabilare nivåer.' },
  { key: 'bandAgcDecay', label: 'Band AGC decay', shortLabel: 'BDcy', min: 0.990, max: 0.999, step: 0.001, unit: '', group: 'AGC', description: 'Hur snabbt per-band AGC släpper efter toppar. Lägre = snabbare decay, högre = längre minne.', format: v => v.toFixed(3) },
];

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
    'Frekvens': 'hsl(200, 80%, 55%)',
    'Dynamik': 'hsl(142, 70%, 50%)',
    'Palett': 'hsl(280, 70%, 60%)',
    'Traits': 'hsl(35, 90%, 55%)',
    'Kick': 'hsl(0, 80%, 60%)',
    'AGC': 'hsl(170, 60%, 50%)',
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
        style={{ height: '6rem', background: 'hsl(var(--secondary))' }}
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

/* ── Pipeline stats (header) ── */

function PipelineStats() {
  const [stats, setStats] = useState({ tickMs: 0, bleMs: 0, wps: 0, drops: 0, queueMs: 0 });

  useEffect(() => {
    const id = setInterval(() => {
      const ble = getBleWriteStats();
      const pipe = getPipelineTimings();
      setStats({
        tickMs: pipe.totalTickMs,
        bleMs: ble.lastWriteMs,
        wps: ble.writesPerSec,
        drops: ble.droppedPerSec,
        queueMs: ble.queueAgeMs,
      });
    }, 300);
    return () => clearInterval(id);
  }, []);

  const warn = stats.tickMs > 20 || stats.queueMs > 80;

  return (
    <div className={`text-[10px] font-mono leading-tight ${warn ? 'text-red-400' : 'text-muted-foreground/70'}`}>
      Pipeline {stats.tickMs.toFixed(1)}ms · BLE {stats.bleMs}ms · {stats.wps}w/s · Q {stats.queueMs}ms
      {stats.drops > 0 && <span className="text-red-400"> · ⚠ {stats.drops} drops/s</span>}
    </div>
  );
}

/* ── Mini live chart (last ~3s) ── */

function MiniChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth * devicePixelRatio;
      canvas.height = container.clientHeight * devicePixelRatio;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const CHART_LEN = 90; // ~3s at 30fps
    let raf: number;
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const all = getChartSamples();
        const recent = all.slice(-CHART_LEN);
        drawIntensityChart(canvas, recent, CHART_LEN, 0, 0, false, 1);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas ref={canvasRef} className="w-full h-full" style={{ opacity: 0.9 }} />
    </div>
  );
}



interface CalibrationOverlayProps {
  onClose: () => void;
  onCalibrationChange?: (cal: LightCalibration) => void;
}

export default function CalibrationOverlay({ onClose, onCalibrationChange }: CalibrationOverlayProps) {
  const [idleColor, setIdleColorState] = useState(getIdleColor);
  const [cal, setCal] = useState<LightCalibration>(getCalibration);
  const [activeSlider, setActiveSlider] = useState<number>(0);
  const [conn, setConn] = useState(getBleConnection);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showIdleMenu, setShowIdleMenu] = useState(false);

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
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: 'hsl(var(--background) / 0.92)', backdropFilter: 'blur(20px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] border-b border-border/20">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-bold tracking-widest uppercase text-foreground/80">Mixer</h2>
          {conn && <span className="text-[9px] font-mono text-primary/60">{conn.device?.name}</span>}
          <PipelineStats />
        </div>
        <div className="flex items-center gap-1.5">
          {/* Idle color dropdown */}
          <div className="relative">
            <button
              className="w-6 h-6 rounded-full border border-border/40 active:scale-90 transition-transform"
              style={{ background: `rgb(${idleColor[0]},${idleColor[1]},${idleColor[2]})` }}
              title="Vilofärg"
              onClick={() => setShowIdleMenu(prev => !prev)}
            />
            {showIdleMenu && (
              <div className="absolute right-0 top-8 z-10 bg-background/95 backdrop-blur-md border border-border/30 rounded-lg p-2 flex flex-col gap-1 shadow-xl">
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
          <Button variant="ghost" size="icon" onClick={resetAll} className="rounded-full w-7 h-7" title="Återställ allt">
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleClose} className="rounded-full w-7 h-7">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Mini live chart — takes remaining space above faders */}
      <div className="flex-1 px-3 pt-2 min-h-0">
        <div className="w-full h-full">
          <MiniChart />
        </div>
      </div>

      {/* Scrollable fader strip — fixed height */}
      <div
        ref={scrollRef}
        className="overflow-x-auto overflow-y-hidden px-2 border-t border-border/20"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div className="flex gap-2 items-center justify-center min-w-max py-2 mx-auto" style={{ height: '12rem' }}>
          {SLIDERS.map((def, i) => {
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
      <div className="px-3 py-2 border-t border-border/20 bg-secondary/30 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <p className="text-[10px] font-bold text-foreground/80">{activeDef.label} <span className="text-muted-foreground font-normal">({activeDef.group})</span></p>
        <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">{activeDef.description}</p>
        <p className="text-[9px] text-muted-foreground/60 mt-0.5">
          Standard: {formatValue(activeDef, DEFAULT_CALIBRATION[activeDef.key] as number)}{activeDef.unit} · Nu: <span className="text-foreground/80 font-bold">{formatValue(activeDef, cal[activeDef.key] as number)}{activeDef.unit}</span>
        </p>
      </div>
    </div>
  );
}
