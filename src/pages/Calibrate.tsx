import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RotateCcw, Play, Square } from "lucide-react";
import {
  getCalibration, saveCalibration,
  applyColorCalibration, DEFAULT_CALIBRATION,
  type LightCalibration,
} from "@/lib/lightCalibration";
import { sendColor, sendBrightness } from "@/lib/bledom";
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

// Pulse durations to test (ms) — how long the white flash stays on
const PULSE_DURATIONS = [200, 150, 100, 80, 60, 50, 40, 30, 20, 15, 10];

async function bleWrite(char: BluetoothRemoteGATTCharacteristic, buf: Uint8Array) {
  await char.writeValueWithoutResponse(buf as any);
}

async function sendWhite(char: BluetoothRemoteGATTCharacteristic) {
  COLOR_BUF[4] = 255; COLOR_BUF[5] = 255; COLOR_BUF[6] = 255;
  await bleWrite(char, COLOR_BUF);
  BRIGHT_BUF[3] = 100;
  await bleWrite(char, BRIGHT_BUF);
}

async function sendBlack(char: BluetoothRemoteGATTCharacteristic) {
  BRIGHT_BUF[3] = 0;
  await bleWrite(char, BRIGHT_BUF);
}

interface PulseResult {
  durationMs: number;
  seen: boolean | null; // null = not yet answered
}

function BleSpeedTab({ conn }: { conn: any }) {
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'asking' | 'done'>('idle');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [results, setResults] = useState<PulseResult[]>([]);
  const [countdown, setCountdown] = useState(0);
  const acRef = useRef<AbortController | null>(null);

  const currentDuration = PULSE_DURATIONS[currentIdx] ?? 0;

  const sendPulse = useCallback(async (durationMs: number) => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    
    // Ensure lamp is dark first
    await sendBlack(char);
    await new Promise(r => setTimeout(r, 500));
    
    // Random delay 1-3s so user can't predict
    const delay = 1000 + Math.random() * 2000;
    
    // Countdown
    const steps = Math.ceil(delay / 1000);
    for (let i = steps; i > 0; i--) {
      setCountdown(i);
      await new Promise(r => setTimeout(r, Math.min(1000, delay / steps)));
    }
    setCountdown(0);
    
    // Flash white
    await sendWhite(char);
    await new Promise(r => setTimeout(r, durationMs));
    await sendBlack(char);
  }, [conn]);

  const startTest = useCallback(async () => {
    setPhase('waiting');
    setCurrentIdx(0);
    setResults([]);
    
    await sendPulse(PULSE_DURATIONS[0]);
    setPhase('asking');
  }, [sendPulse]);

  const answer = useCallback(async (seen: boolean) => {
    const duration = PULSE_DURATIONS[currentIdx];
    const newResults = [...results, { durationMs: duration, seen }];
    setResults(newResults);

    if (!seen || currentIdx >= PULSE_DURATIONS.length - 1) {
      // Done — user didn't see it, or we've tested all intervals
      setPhase('done');
      // Turn lamp back on at 50%
      if (conn?.characteristic) {
        BRIGHT_BUF[3] = 50;
        try { await bleWrite(conn.characteristic, BRIGHT_BUF); } catch {}
      }
      return;
    }

    // Next pulse
    const nextIdx = currentIdx + 1;
    setCurrentIdx(nextIdx);
    setPhase('waiting');
    await sendPulse(PULSE_DURATIONS[nextIdx]);
    setPhase('asking');
  }, [currentIdx, results, sendPulse, conn]);

  const lastSeen = [...results].reverse().find(r => r.seen);
  const firstMissed = results.find(r => !r.seen);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Lampan blinkar vitt i allt kortare pulser. Svara om du såg blinken. Testet hittar kortaste synliga puls.
      </p>

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
            Puls: {PULSE_DURATIONS[currentIdx]}ms
          </p>
        </div>
      )}

      {phase === 'asking' && (
        <div className="text-center py-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Såg du blinken?</p>
          <p className="text-xs text-muted-foreground">Puls: {currentDuration}ms</p>
          <div className="flex gap-3 justify-center">
            <Button size="sm" onClick={() => answer(true)} className="px-6 text-xs">
              ✓ Ja
            </Button>
            <Button size="sm" variant="secondary" onClick={() => answer(false)} className="px-6 text-xs">
              ✗ Nej
            </Button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="space-y-3">
          <div className="bg-primary/10 border border-primary/20 rounded-md px-3 py-2">
            <p className="text-xs font-bold text-primary">Resultat</p>
            {lastSeen && firstMissed ? (
              <p className="text-xs text-foreground/80 mt-1">
                Kortaste synliga puls: <span className="font-mono font-bold">{lastSeen.durationMs}ms</span>
                <br />
                Första missade: <span className="font-mono font-bold">{firstMissed.durationMs}ms</span>
                <br />
                <span className="text-muted-foreground">→ Lampans effektiva latens ≈ {lastSeen.durationMs}ms</span>
              </p>
            ) : lastSeen ? (
              <p className="text-xs text-foreground/80 mt-1">
                Alla pulser syntes! Minsta testad: <span className="font-mono font-bold">{lastSeen.durationMs}ms</span>
              </p>
            ) : (
              <p className="text-xs text-foreground/80 mt-1">Ingen puls syntes.</p>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={() => { setPhase('idle'); setResults([]); setCurrentIdx(0); }} className="text-xs">
            Kör igen
          </Button>
        </div>
      )}

      {/* Results log */}
      {results.length > 0 && (
        <div className="border border-border/30 rounded-md overflow-hidden">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-muted-foreground border-b border-border/20">
                <th className="px-2 py-1 text-left">Puls</th>
                <th className="px-2 py-1 text-right">Syntes</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className={`border-b border-border/10 ${r.seen ? '' : 'text-red-400'}`}>
                  <td className="px-2 py-0.5">{r.durationMs}ms</td>
                  <td className="px-2 py-0.5 text-right">{r.seen ? '✓' : '✗'}</td>
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
