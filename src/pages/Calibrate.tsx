import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RotateCcw, Play, Square } from "lucide-react";
import {
  getCalibration, saveCalibration,
  applyColorCalibration, DEFAULT_CALIBRATION,
  type LightCalibration,
} from "@/lib/lightCalibration";
import { sendColor, sendBrightness, getBleMinInterval, setBleMinInterval } from "@/lib/bledom";
import { getBleConnection, subscribeBle } from "@/lib/bleStore";

type Tab = 'color' | 'dynamics' | 'ble';

const TABS: { key: Tab; label: string }[] = [
  { key: 'color', label: 'Färg' },
  { key: 'dynamics', label: 'Dynamik' },
  { key: 'ble', label: 'BLE' },
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

// --- BLE Perceptual Latency Test ---

const COLOR_BUF = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const BRIGHT_BUF = new Uint8Array([0x7e, 0x04, 0x01, 0, 0x01, 0xff, 0x00, 0x00, 0xef]);

const PULSE_DURATIONS = [200, 150, 100, 80, 60, 50, 40, 30, 20, 15, 10];
const PULSES_PER_STEP = 3;
const PULSE_GAP_MS = 800;

async function bleWrite(char: BluetoothRemoteGATTCharacteristic, buf: Uint8Array) {
  await char.writeValueWithoutResponse(buf as any);
}

// Color cycle: R → G → B
const CYCLE_COLORS: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

type TestMode = 'brightness' | 'color' | 'combined';

const MODE_LABELS: Record<TestMode, string> = {
  brightness: 'Brightness 0↔100%',
  color: 'Färgbyte R→G→B',
  combined: 'Färg + Brightness',
};

const MODE_DESC: Record<TestMode, string> = {
  brightness: 'Testar hur snabbt lampan kan växla brightness 0%↔100%. Lampan hålls på vit färg.',
  color: 'Testar hur snabbt lampan kan byta färg (R→G→B) vid 100% brightness.',
  combined: 'Testar färgbyte + brightness-växling samtidigt (R→G→B, 0%↔100%).',
};

async function sendPulseForMode(
  char: BluetoothRemoteGATTCharacteristic,
  mode: TestMode,
  pulseIndex: number,
  durationMs: number,
) {
  if (mode === 'brightness') {
    // White color, toggle brightness 0→100→0
    COLOR_BUF[4] = 255; COLOR_BUF[5] = 255; COLOR_BUF[6] = 255;
    await bleWrite(char, COLOR_BUF);
    BRIGHT_BUF[3] = 100;
    await bleWrite(char, BRIGHT_BUF);
    await new Promise(r => setTimeout(r, durationMs));
    BRIGHT_BUF[3] = 0;
    await bleWrite(char, BRIGHT_BUF);
  } else if (mode === 'color') {
    // 100% brightness, cycle through R→G→B
    BRIGHT_BUF[3] = 100;
    await bleWrite(char, BRIGHT_BUF);
    const [cr, cg, cb] = CYCLE_COLORS[pulseIndex % 3];
    COLOR_BUF[4] = cr; COLOR_BUF[5] = cg; COLOR_BUF[6] = cb;
    await bleWrite(char, COLOR_BUF);
    await new Promise(r => setTimeout(r, durationMs));
    // "Off" = black (brightness 0)
    BRIGHT_BUF[3] = 0;
    await bleWrite(char, BRIGHT_BUF);
  } else {
    // Combined: color + brightness
    const [cr, cg, cb] = CYCLE_COLORS[pulseIndex % 3];
    COLOR_BUF[4] = cr; COLOR_BUF[5] = cg; COLOR_BUF[6] = cb;
    await bleWrite(char, COLOR_BUF);
    BRIGHT_BUF[3] = 100;
    await bleWrite(char, BRIGHT_BUF);
    await new Promise(r => setTimeout(r, durationMs));
    BRIGHT_BUF[3] = 0;
    await bleWrite(char, BRIGHT_BUF);
  }
}

interface PulseResult {
  durationMs: number;
  answer: 'all' | 'partial' | 'none';
  mode: TestMode;
}

function BleSpeedTab({ conn }: { conn: any }) {
  const [mode, setMode] = useState<TestMode>('brightness');
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'asking' | 'done'>('idle');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [results, setResults] = useState<PulseResult[]>([]);
  const [countdown, setCountdown] = useState(0);
  const [saved, setSaved] = useState(false);

  const currentDuration = PULSE_DURATIONS[currentIdx] ?? 0;

  const sendPulses = useCallback(async (durationMs: number, testMode: TestMode) => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;

    // Ensure lamp is dark
    BRIGHT_BUF[3] = 0;
    await bleWrite(char, BRIGHT_BUF);
    await new Promise(r => setTimeout(r, 600));

    // Random delay 1-2s
    const delay = 1000 + Math.random() * 1000;
    const steps = Math.ceil(delay / 1000);
    for (let i = steps; i > 0; i--) {
      setCountdown(i);
      await new Promise(r => setTimeout(r, Math.min(1000, delay / steps)));
    }
    setCountdown(0);

    // Send 3 pulses
    for (let p = 0; p < PULSES_PER_STEP; p++) {
      await sendPulseForMode(char, testMode, p, durationMs);
      if (p < PULSES_PER_STEP - 1) {
        await new Promise(r => setTimeout(r, PULSE_GAP_MS));
      }
    }
  }, [conn]);

  const startTest = useCallback(async () => {
    setPhase('waiting');
    setCurrentIdx(0);
    setResults([]);
    setSaved(false);
    await sendPulses(PULSE_DURATIONS[0], mode);
    setPhase('asking');
  }, [sendPulses, mode]);

  const answer = useCallback(async (ans: 'all' | 'partial' | 'none') => {
    const duration = PULSE_DURATIONS[currentIdx];
    const newResults = [...results, { durationMs: duration, answer: ans, mode }];
    setResults(newResults);

    if (ans !== 'all' || currentIdx >= PULSE_DURATIONS.length - 1) {
      setPhase('done');
      if (conn?.characteristic) {
        BRIGHT_BUF[3] = 50;
        try { await bleWrite(conn.characteristic, BRIGHT_BUF); } catch {}
      }
      return;
    }

    const nextIdx = currentIdx + 1;
    setCurrentIdx(nextIdx);
    setPhase('waiting');
    await sendPulses(PULSE_DURATIONS[nextIdx], mode);
    setPhase('asking');
  }, [currentIdx, results, sendPulses, conn, mode]);

  const lastAll = [...results].reverse().find(r => r.answer === 'all');
  const firstFail = results.find(r => r.answer !== 'all');
  const firstFailType = firstFail?.answer;

  const questionText = mode === 'color'
    ? `Såg du ${PULSES_PER_STEP} tydliga färgbyten (R→G→B)?`
    : mode === 'combined'
    ? `Såg du ${PULSES_PER_STEP} tydliga färg+blinkar?`
    : `Såg du ${PULSES_PER_STEP} tydliga blinkar?`;

  return (
    <div className="space-y-4">
      {/* Mode selector */}
      <div className="flex gap-1 flex-wrap">
        {(Object.keys(MODE_LABELS) as TestMode[]).map((m) => (
          <button
            key={m}
            onClick={() => { if (phase === 'idle' || phase === 'done') setMode(m); }}
            className={`px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wide transition-colors ${
              mode === m
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-accent'
            } ${phase !== 'idle' && phase !== 'done' ? 'opacity-50' : ''}`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{MODE_DESC[mode]}</p>

      {!conn && <p className="text-xs text-destructive">Anslut BLE-lampan först.</p>}

      {phase === 'idle' && (
        <Button size="sm" onClick={startTest} disabled={!conn} className="gap-1.5 text-xs">
          <Play className="w-3 h-3" /> Starta test
        </Button>
      )}

      {phase === 'waiting' && (
        <div className="text-center py-6">
          <p className="text-sm text-muted-foreground mb-2">
            {countdown > 0 ? `Gör dig redo… ${countdown}` : 'Titta på lampan!'}
          </p>
          <p className="text-xs text-muted-foreground">
            {MODE_LABELS[mode]} — {PULSE_DURATIONS[currentIdx]}ms × {PULSES_PER_STEP}
          </p>
        </div>
      )}

      {phase === 'asking' && (
        <div className="text-center py-4 space-y-3">
          <p className="text-sm font-medium text-foreground">{questionText}</p>
          <p className="text-xs text-muted-foreground">{MODE_LABELS[mode]} — {currentDuration}ms × {PULSES_PER_STEP}</p>
          <div className="flex gap-2 justify-center flex-wrap">
            <Button size="sm" onClick={() => answer('all')} className="px-4 text-xs">
              ✓ Alla 3
            </Button>
            <Button size="sm" variant="outline" onClick={() => answer('partial')} className="px-4 text-xs">
              ◐ Bara 1–2
            </Button>
            <Button size="sm" variant="secondary" onClick={() => answer('none')} className="px-4 text-xs">
              ✗ Ingen
            </Button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="space-y-3">
          <div className="bg-primary/10 border border-primary/20 rounded-md px-3 py-2">
            <p className="text-xs font-bold text-primary">Resultat — {MODE_LABELS[mode]}</p>
            {lastAll && firstFail ? (
              <>
                <p className="text-xs text-foreground/80 mt-1">
                  Kortaste med alla 3: <span className="font-mono font-bold">{lastAll.durationMs}ms</span>
                  <br />
                  Missade vid: <span className="font-mono font-bold">{firstFail.durationMs}ms</span>
                  {firstFailType === 'partial' && <span className="text-yellow-400"> (lampan hänger kvar)</span>}
                  {firstFailType === 'none' && <span className="text-red-400"> (ingen syntes)</span>}
                </p>
                <div className="flex gap-2 mt-2">
                  <Button size="sm" onClick={() => { setBleMinInterval(lastAll.durationMs); setSaved(true); }} className="text-xs gap-1">
                    Spara ({lastAll.durationMs}ms)
                  </Button>
                </div>
                {saved && <p className="text-[10px] text-primary mt-1">✓ Scheduler: {getBleMinInterval()}ms</p>}
              </>
            ) : lastAll ? (
              <>
                <p className="text-xs text-foreground/80 mt-1">
                  Alla syntes! Minsta: <span className="font-mono font-bold">{lastAll.durationMs}ms</span>
                </p>
                <div className="flex gap-2 mt-2">
                  <Button size="sm" onClick={() => { setBleMinInterval(lastAll.durationMs); setSaved(true); }} className="text-xs gap-1">
                    Spara ({lastAll.durationMs}ms)
                  </Button>
                </div>
                {saved && <p className="text-[10px] text-primary mt-1">✓ Scheduler: {getBleMinInterval()}ms</p>}
              </>
            ) : (
              <p className="text-xs text-foreground/80 mt-1">Ingen puls syntes.</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setPhase('idle'); setResults([]); setCurrentIdx(0); setSaved(false); }} className="text-xs">
              Kör igen
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">Nuvarande BLE-intervall: <span className="font-mono">{getBleMinInterval()}ms</span></p>
        </div>
      )}

      {results.length > 0 && (
        <div className="border border-border/30 rounded-md overflow-hidden">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-muted-foreground border-b border-border/20">
                <th className="px-2 py-1 text-left">Puls</th>
                <th className="px-2 py-1 text-right">Svar</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className={`border-b border-border/10 ${r.answer === 'all' ? '' : r.answer === 'partial' ? 'text-yellow-400' : 'text-red-400'}`}>
                  <td className="px-2 py-0.5">{r.durationMs}ms</td>
                  <td className="px-2 py-0.5 text-right">{r.answer === 'all' ? '✓ 3/3' : r.answer === 'partial' ? '◐ 1–2' : '✗ 0'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Main ---

export default function Calibrate() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('color');
  const [cal, setCal] = useState<LightCalibration>(getCalibration);
  const [testColor, setTestColor] = useState<[number, number, number]>([255, 80, 0]);
  const [conn, setConn] = useState(getBleConnection);
  useEffect(() => subscribeBle(() => setConn(getBleConnection())), []);

  const update = useCallback((patch: Partial<LightCalibration>) => {
    setCal((prev) => {
      const next = { ...prev, ...patch };
      saveCalibration(next);
      return next;
    });
  }, []);

  const handleReset = useCallback((tabKey: Tab) => {
    if (tabKey === 'ble') return;
    const full = { ...DEFAULT_CALIBRATION };
    const patches: Record<string, Partial<LightCalibration>> = {
      color: { gammaR: full.gammaR, gammaG: full.gammaG, gammaB: full.gammaB, offsetR: full.offsetR, offsetG: full.offsetG, offsetB: full.offsetB, saturationBoost: full.saturationBoost },
      dynamics: { minBrightness: full.minBrightness, maxBrightness: full.maxBrightness, attackAlpha: full.attackAlpha, releaseAlpha: full.releaseAlpha, whiteKickThreshold: full.whiteKickThreshold, whiteKickMs: full.whiteKickMs },
    };
    if (patches[tabKey]) update(patches[tabKey]);
  }, [update]);

  useEffect(() => {
    if (!conn || tab === 'ble') return;
    const interval = setInterval(() => {
      const calibrated = applyColorCalibration(...testColor, cal);
      sendColor(conn.characteristic, ...calibrated).catch(() => {});
      sendBrightness(conn.characteristic, cal.maxBrightness).catch(() => {});
    }, 80);
    return () => clearInterval(interval);
  }, [testColor, cal, conn, tab]);

  const calibrated = applyColorCalibration(...testColor, cal);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')} className="rounded-full w-8 h-8">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-sm font-bold tracking-widest uppercase text-foreground/80">Kalibrering</h1>
        <div className="flex-1" />
        {conn
          ? <span className="text-[10px] font-mono text-primary/70">{conn.device?.name || 'Ansluten'}</span>
          : <span className="text-[10px] font-mono text-muted-foreground">Ej ansluten</span>
        }
      </div>

      <div className="flex gap-1 mb-4">
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

      <div className="space-y-1">
        {tab !== 'ble' && (
          <div className="flex justify-end mb-2">
            <Button variant="ghost" size="sm" onClick={() => handleReset(tab)} className="text-xs gap-1 text-muted-foreground">
              <RotateCcw className="w-3 h-3" /> Återställ
            </Button>
          </div>
        )}

        {tab === 'color' && (
          <>
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
            <SliderRow label="Attack" value={cal.attackAlpha} min={0.05} max={0.9} step={0.01} onChange={(v) => update({ attackAlpha: v })} />
            <SliderRow label="Release" value={cal.releaseAlpha} min={0.01} max={0.3} step={0.005} onChange={(v) => update({ releaseAlpha: v })} />
            <div className="border-t border-border/20 my-3" />
            <SliderRow label="Kick-tröskel" value={cal.whiteKickThreshold} min={80} max={100} step={1} unit="%" onChange={(v) => update({ whiteKickThreshold: v })} />
            <SliderRow label="Kick-tid" value={cal.whiteKickMs} min={50} max={300} step={10} unit="ms" onChange={(v) => update({ whiteKickMs: v })} />
          </>
        )}

        {tab === 'ble' && <BleSpeedTab conn={conn} />}
      </div>
    </div>
  );
}
