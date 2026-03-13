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

// --- BLE Speed Test ---

interface IntervalResult {
  targetMs: number;
  sent: number;
  ok: number;
  failed: number;
  avgWriteMs: number;
  minWriteMs: number;
  maxWriteMs: number;
}

const BRIGHT_BUF = new Uint8Array([0x7e, 0x04, 0x01, 0, 0x01, 0xff, 0x00, 0x00, 0xef]);
const TEST_INTERVALS = [100, 80, 60, 50, 40, 30, 25, 20, 15, 10];
const WRITES_PER_INTERVAL = 20;

async function runBleSpeedTest(
  char: BluetoothRemoteGATTCharacteristic,
  onProgress: (msg: string, results: IntervalResult[]) => void,
  signal: AbortSignal,
): Promise<IntervalResult[]> {
  const results: IntervalResult[] = [];

  for (const intervalMs of TEST_INTERVALS) {
    if (signal.aborted) break;

    onProgress(`Testar ${intervalMs}ms intervall…`, results);
    const writeTimes: number[] = [];
    let ok = 0;
    let failed = 0;

    for (let i = 0; i < WRITES_PER_INTERVAL; i++) {
      if (signal.aborted) break;
      BRIGHT_BUF[3] = i % 2 === 0 ? 90 : 10;

      const t0 = performance.now();
      try {
        await char.writeValueWithoutResponse(BRIGHT_BUF);
        writeTimes.push(performance.now() - t0);
        ok++;
      } catch {
        failed++;
      }

      const elapsed = performance.now() - t0;
      const wait = Math.max(0, intervalMs - elapsed);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }

    const result: IntervalResult = {
      targetMs: intervalMs,
      sent: ok + failed,
      ok,
      failed,
      avgWriteMs: writeTimes.length > 0 ? writeTimes.reduce((a, b) => a + b, 0) / writeTimes.length : 0,
      minWriteMs: writeTimes.length > 0 ? Math.min(...writeTimes) : 0,
      maxWriteMs: writeTimes.length > 0 ? Math.max(...writeTimes) : 0,
    };
    results.push(result);
    onProgress(`${intervalMs}ms: ${ok}/${ok + failed} ok, avg ${result.avgWriteMs.toFixed(1)}ms`, [...results]);

    if (failed > WRITES_PER_INTERVAL * 0.25) {
      onProgress(`Stopp vid ${intervalMs}ms — för många fel`, [...results]);
      break;
    }
  }

  BRIGHT_BUF[3] = 50;
  try { await char.writeValueWithoutResponse(BRIGHT_BUF); } catch {}
  return results;
}

function BleSpeedTab({ conn }: { conn: any }) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [results, setResults] = useState<IntervalResult[]>([]);
  const acRef = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    if (!conn?.characteristic) return;
    setRunning(true);
    setResults([]);
    setStatus('Startar…');
    const ac = new AbortController();
    acRef.current = ac;

    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    const finalResults = await runBleSpeedTest(char, (msg, r) => {
      setStatus(msg);
      setResults(r);
    }, ac.signal);

    setResults(finalResults);
    if (finalResults.length > 0) {
      const best = [...finalResults].reverse().find(r => r.failed === 0);
      setStatus(best
        ? `✓ Minsta säkra intervall: ${best.targetMs}ms (${Math.round(1000 / best.targetMs)} cmd/s)`
        : `Snabbaste med <25% fel: ${finalResults[finalResults.length - 1].targetMs}ms`
      );
    }
    setRunning(false);
  }, [conn]);

  const stop = useCallback(() => {
    acRef.current?.abort();
    setRunning(false);
    setStatus('Avbruten');
  }, []);

  const bestSafe = [...results].reverse().find(r => r.failed === 0);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Skickar {WRITES_PER_INTERVAL} brightness-kommandon vid varje intervall ({TEST_INTERVALS[0]}ms → {TEST_INTERVALS[TEST_INTERVALS.length - 1]}ms) för att hitta lampans gräns.
      </p>

      {!conn && <p className="text-xs text-destructive">Anslut BLE-lampan först.</p>}

      <div className="flex gap-2">
        <Button size="sm" onClick={running ? stop : start} disabled={!conn} className="gap-1.5 text-xs">
          {running ? <><Square className="w-3 h-3" /> Stoppa</> : <><Play className="w-3 h-3" /> Kör test</>}
        </Button>
      </div>

      {status && <p className="text-xs font-mono text-foreground/80">{status}</p>}

      {results.length > 0 && (
        <div className="border border-border/30 rounded-md overflow-hidden">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-muted-foreground border-b border-border/20">
                <th className="px-2 py-1 text-left">ms</th>
                <th className="px-2 py-1 text-right">OK</th>
                <th className="px-2 py-1 text-right">Fel</th>
                <th className="px-2 py-1 text-right">Avg</th>
                <th className="px-2 py-1 text-right">Min</th>
                <th className="px-2 py-1 text-right">Max</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.targetMs} className={`border-b border-border/10 ${r.failed === 0 ? '' : r.failed <= r.sent * 0.25 ? 'text-yellow-400' : 'text-red-400'}`}>
                  <td className="px-2 py-0.5">{r.targetMs}</td>
                  <td className="px-2 py-0.5 text-right">{r.ok}</td>
                  <td className="px-2 py-0.5 text-right">{r.failed}</td>
                  <td className="px-2 py-0.5 text-right">{r.avgWriteMs.toFixed(1)}</td>
                  <td className="px-2 py-0.5 text-right">{r.minWriteMs.toFixed(1)}</td>
                  <td className="px-2 py-0.5 text-right">{r.maxWriteMs.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bestSafe && (
        <div className="bg-primary/10 border border-primary/20 rounded-md px-3 py-2">
          <p className="text-xs font-bold text-primary">Rekommendation</p>
          <p className="text-xs text-foreground/80 mt-0.5">
            Minsta intervall utan fel: <span className="font-mono font-bold">{bestSafe.targetMs}ms</span> = <span className="font-mono font-bold">{Math.round(1000 / bestSafe.targetMs)} cmd/s</span>
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Snitt: {bestSafe.avgWriteMs.toFixed(1)}ms, max: {bestSafe.maxWriteMs.toFixed(1)}ms
          </p>
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
