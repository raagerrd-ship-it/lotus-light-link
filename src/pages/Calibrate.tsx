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

type Tab = 'color' | 'dynamics' | 'ble' | 'latency';

const TABS: { key: Tab; label: string }[] = [
  { key: 'color', label: 'Färg' },
  { key: 'dynamics', label: 'Dynamik' },
  { key: 'ble', label: 'BLE' },
  { key: 'latency', label: 'Latens' },
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

// Per-mode best result: the shortest duration where all 3 pulses were seen
type ModeBests = Partial<Record<TestMode, number>>;

function BleSpeedTab({ conn }: { conn: any }) {
  const [mode, setMode] = useState<TestMode>('brightness');
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'asking' | 'done'>('idle');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [results, setResults] = useState<PulseResult[]>([]);
  const [countdown, setCountdown] = useState(0);
  const [modeBests, setModeBests] = useState<ModeBests>({});

  const currentDuration = PULSE_DURATIONS[currentIdx] ?? 0;
  const testedModes = Object.keys(modeBests) as TestMode[];
  const allThreeTested = testedModes.length === 3;
  const worstBest = testedModes.length > 0 ? Math.max(...testedModes.map(m => modeBests[m]!)) : null;

  const sendPulses = useCallback(async (durationMs: number, testMode: TestMode) => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;

    BRIGHT_BUF[3] = 0;
    await bleWrite(char, BRIGHT_BUF);
    await new Promise(r => setTimeout(r, 600));

    const delay = 1000 + Math.random() * 1000;
    const steps = Math.ceil(delay / 1000);
    for (let i = steps; i > 0; i--) {
      setCountdown(i);
      await new Promise(r => setTimeout(r, Math.min(1000, delay / steps)));
    }
    setCountdown(0);

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
    await sendPulses(PULSE_DURATIONS[0], mode);
    setPhase('asking');
  }, [sendPulses, mode]);

  const answer = useCallback(async (ans: 'all' | 'partial' | 'none') => {
    const duration = PULSE_DURATIONS[currentIdx];
    const newResults = [...results, { durationMs: duration, answer: ans, mode }];
    setResults(newResults);

    if (ans !== 'all' || currentIdx >= PULSE_DURATIONS.length - 1) {
      // Record this mode's best result
      const lastAllForMode = [...newResults].reverse().find(r => r.answer === 'all' && r.mode === mode);
      const bestMs = lastAllForMode?.durationMs ?? PULSE_DURATIONS[0]; // fallback to slowest
      const newBests = { ...modeBests, [mode]: bestMs };
      setModeBests(newBests);

      // Auto-save worst (highest) of all tested modes
      const testedValues = Object.values(newBests) as number[];
      if (testedValues.length > 0) {
        const worst = Math.max(...testedValues);
        setBleMinInterval(worst);
      }

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
  }, [currentIdx, results, sendPulses, conn, mode, modeBests]);

  const lastAll = [...results].reverse().find(r => r.answer === 'all');
  const firstFail = results.find(r => r.answer !== 'all');
  const firstFailType = firstFail?.answer;

  const questionText = mode === 'color'
    ? `Såg du ${PULSES_PER_STEP} tydliga färgbyten (R→G→B)?`
    : mode === 'combined'
    ? `Såg du ${PULSES_PER_STEP} tydliga färg+blinkar?`
    : `Såg du ${PULSES_PER_STEP} tydliga blinkar?`;

  // Suggest next untested mode
  const allModes: TestMode[] = ['brightness', 'color', 'combined'];
  const nextUntested = allModes.find(m => !(m in modeBests));

  return (
    <div className="space-y-4">
      {/* Mode selector */}
      <div className="flex gap-1 flex-wrap">
        {allModes.map((m) => (
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
            {m in modeBests && <span className="ml-1 opacity-70">({modeBests[m]}ms)</span>}
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
              <p className="text-xs text-foreground/80 mt-1">
                Kortaste med alla 3: <span className="font-mono font-bold">{lastAll.durationMs}ms</span>
                <br />
                Missade vid: <span className="font-mono font-bold">{firstFail.durationMs}ms</span>
                {firstFailType === 'partial' && <span className="text-yellow-400"> (lampan hänger kvar)</span>}
                {firstFailType === 'none' && <span className="text-red-400"> (ingen syntes)</span>}
              </p>
            ) : lastAll ? (
              <p className="text-xs text-foreground/80 mt-1">
                Alla syntes! Minsta: <span className="font-mono font-bold">{lastAll.durationMs}ms</span>
              </p>
            ) : (
              <p className="text-xs text-foreground/80 mt-1">Ingen puls syntes.</p>
            )}
          </div>

          {/* Cross-mode summary */}
          {testedModes.length > 0 && (
            <div className="bg-secondary/50 border border-border/30 rounded-md px-3 py-2">
              <p className="text-[10px] font-bold text-foreground/70 mb-1">Testade lägen</p>
              {allModes.map(m => (
                <div key={m} className="text-[10px] font-mono flex justify-between">
                  <span className={m in modeBests ? 'text-foreground/80' : 'text-muted-foreground'}>{MODE_LABELS[m]}</span>
                  <span>{m in modeBests ? `${modeBests[m]}ms` : '—'}</span>
                </div>
              ))}
              <div className="border-t border-border/20 mt-1 pt-1 flex justify-between text-[10px] font-mono font-bold">
                <span>Scheduler-intervall (sämsta)</span>
                <span className="text-primary">{worstBest}ms</span>
              </div>
              {!allThreeTested && <p className="text-[10px] text-yellow-400 mt-1">⚠ Testa alla 3 lägen för bästa resultat</p>}
              {allThreeTested && <p className="text-[10px] text-primary mt-1">✓ Alla lägen testade — {worstBest}ms sparad</p>}
            </div>
          )}

          <div className="flex gap-2">
            {nextUntested ? (
              <Button size="sm" onClick={() => { setMode(nextUntested); setPhase('idle'); setResults([]); setCurrentIdx(0); }} className="text-xs gap-1">
                Testa {MODE_LABELS[nextUntested]}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => { setPhase('idle'); setResults([]); setCurrentIdx(0); }} className="text-xs">
                Kör igen
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => { setPhase('idle'); setResults([]); setCurrentIdx(0); }} className="text-xs">
              Kör om
            </Button>
          </div>
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

// --- Latency Calibration Tab ---

const LATENCY_COLOR_BUF = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 255, 255, 255, 0x00, 0xef]);
const LATENCY_BRIGHT_ON = new Uint8Array([0x7e, 0x04, 0x01, 100, 0x01, 0xff, 0x00, 0x00, 0xef]);
const LATENCY_BRIGHT_OFF = new Uint8Array([0x7e, 0x04, 0x01, 0, 0x01, 0xff, 0x00, 0x00, 0xef]);

function LatencyTab({ conn, onSave }: { conn: any; onSave: (ms: number) => void }) {
  const [testMode, setTestMode] = useState<'tap' | 'metronome'>('tap');

  // TAP-SYNC
  const [tapPhase, setTapPhase] = useState<'idle' | 'waiting' | 'asking' | 'done'>('idle');
  const [tapOffset, setTapOffset] = useState(0);
  const [tapLow, setTapLow] = useState(-20);
  const [tapHigh, setTapHigh] = useState(200);
  const [tapRound, setTapRound] = useState(0);
  const [tapHistory, setTapHistory] = useState<{ offset: number; answer: string }[]>([]);
  const [screenFlash, setScreenFlash] = useState(false);
  const MAX_TAP_ROUNDS = 8;

  // METRONOME
  const [metroRunning, setMetroRunning] = useState(false);
  const [metroOffset, setMetroOffset] = useState(50);
  const [metroFlash, setMetroFlash] = useState(false);
  const metroRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const metroOffsetRef = useRef(50);
  const METRO_BPM = 120;

  // RESULTS
  const [tapResult, setTapResult] = useState<number | null>(null);
  const [metroResult, setMetroResult] = useState<number | null>(null);

  useEffect(() => { metroOffsetRef.current = metroOffset; }, [metroOffset]);

  // TAP-SYNC
  const doTapFlash = useCallback(async (offsetMs: number) => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;

    await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);
    await new Promise(r => setTimeout(r, 800));
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));

    // Send BLE flash
    await char.writeValueWithoutResponse(LATENCY_COLOR_BUF as any);
    await char.writeValueWithoutResponse(LATENCY_BRIGHT_ON as any);

    // Screen flash with offset delay
    setTimeout(() => { setScreenFlash(true); setTimeout(() => setScreenFlash(false), 100); }, Math.max(0, offsetMs));

    // Turn off lamp after 100ms
    setTimeout(async () => { try { await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any); } catch {} }, 100);
  }, [conn]);

  const startTap = useCallback(async () => {
    const low = -20, high = 200, mid = Math.round((low + high) / 2);
    setTapLow(low); setTapHigh(high); setTapOffset(mid);
    setTapRound(1); setTapHistory([]); setTapResult(null);
    setTapPhase('waiting');
    await doTapFlash(mid);
    setTapPhase('asking');
  }, [doTapFlash]);

  const tapAnswer = useCallback(async (ans: 'before' | 'sync' | 'after') => {
    const newHistory = [...tapHistory, { offset: tapOffset, answer: ans }];
    setTapHistory(newHistory);

    if (ans === 'sync' || tapRound >= MAX_TAP_ROUNDS || Math.abs(tapHigh - tapLow) <= 5) {
      setTapResult(tapOffset); setTapPhase('done');
      if (conn?.characteristic) try { await conn.characteristic.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any); } catch {}
      return;
    }

    let nLow = tapLow, nHigh = tapHigh;
    if (ans === 'before') nHigh = tapOffset; else nLow = tapOffset;
    const nMid = Math.round((nLow + nHigh) / 2);

    setTapLow(nLow); setTapHigh(nHigh); setTapOffset(nMid); setTapRound(tapRound + 1);
    setTapPhase('waiting');
    await doTapFlash(nMid);
    setTapPhase('asking');
  }, [tapHistory, tapOffset, tapRound, tapLow, tapHigh, doTapFlash, conn]);

  // METRONOME
  const startMetro = useCallback(() => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    const intervalMs = (60 / METRO_BPM) * 1000;
    setMetroRunning(true); setMetroResult(null);

    char.writeValueWithoutResponse(LATENCY_COLOR_BUF as any).catch(() => {});

    const tick = () => {
      char.writeValueWithoutResponse(LATENCY_BRIGHT_ON as any).catch(() => {});
      setTimeout(() => { char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any).catch(() => {}); }, 80);
      setTimeout(() => { setMetroFlash(true); setTimeout(() => setMetroFlash(false), 80); }, metroOffsetRef.current);
    };
    tick();
    metroRef.current = setInterval(tick, intervalMs);
  }, [conn]);

  const stopMetro = useCallback(() => {
    if (metroRef.current) clearInterval(metroRef.current);
    metroRef.current = null;
    setMetroRunning(false);
    setMetroResult(metroOffset);
  }, [metroOffset]);

  useEffect(() => () => { if (metroRef.current) clearInterval(metroRef.current); }, []);

  const bestResult = tapResult != null && metroResult != null
    ? Math.round((tapResult + metroResult) / 2)
    : tapResult ?? metroResult;

  return (
    <div className="space-y-4">
      {(screenFlash || metroFlash) && <div className="fixed inset-0 z-[100] bg-white pointer-events-none" />}

      <div className="flex gap-1">
        <button onClick={() => { if (!metroRunning) setTestMode('tap'); }} className={`px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition-colors ${testMode === 'tap' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'}`}>
          Tap-sync
        </button>
        <button onClick={() => { if (tapPhase === 'idle' || tapPhase === 'done') setTestMode('metronome'); }} className={`px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition-colors ${testMode === 'metronome' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'}`}>
          Metronom
        </button>
      </div>

      {!conn && <p className="text-xs text-destructive">Anslut BLE-lampan först.</p>}

      {testMode === 'tap' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Lampan och skärmen blinkar. Svara om lampan var före, efter eller synk med skärmen. Binärsökning hittar latensen (~{MAX_TAP_ROUNDS} rundor).
          </p>
          {tapPhase === 'idle' && (
            <Button size="sm" onClick={startTap} disabled={!conn} className="gap-1.5 text-xs"><Play className="w-3 h-3" /> Starta</Button>
          )}
          {tapPhase === 'waiting' && (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground animate-pulse">Titta på lampan och skärmen…</p>
              <p className="text-[10px] text-muted-foreground mt-1">Runda {tapRound}/{MAX_TAP_ROUNDS} — offset {tapOffset}ms [{tapLow}–{tapHigh}]</p>
            </div>
          )}
          {tapPhase === 'asking' && (
            <div className="text-center py-4 space-y-3">
              <p className="text-sm font-medium text-foreground">Lampan vs skärmen?</p>
              <p className="text-[10px] text-muted-foreground">Runda {tapRound}/{MAX_TAP_ROUNDS} — offset {tapOffset}ms</p>
              <div className="flex gap-2 justify-center flex-wrap">
                <Button size="sm" variant="secondary" onClick={() => tapAnswer('before')} className="px-3 text-xs">← Lampan före</Button>
                <Button size="sm" onClick={() => tapAnswer('sync')} className="px-4 text-xs">✓ Synk</Button>
                <Button size="sm" variant="secondary" onClick={() => tapAnswer('after')} className="px-3 text-xs">Lampan efter →</Button>
              </div>
            </div>
          )}
          {tapPhase === 'done' && tapResult != null && (
            <div className="bg-primary/10 border border-primary/20 rounded-md px-3 py-2">
              <p className="text-xs font-bold text-primary">Tap-sync: <span className="font-mono">{tapResult}ms</span></p>
              <Button size="sm" variant="secondary" onClick={() => { setTapPhase('idle'); setTapHistory([]); }} className="text-xs mt-1">Kör igen</Button>
            </div>
          )}
          {tapHistory.length > 0 && (
            <div className="text-[10px] font-mono text-muted-foreground">
              {tapHistory.map((h, i) => <span key={i} className="mr-2">{h.offset}ms:{h.answer === 'sync' ? '✓' : h.answer === 'before' ? '←' : '→'}</span>)}
            </div>
          )}
        </div>
      )}

      {testMode === 'metronome' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Lampan och skärmen pulserar i {METRO_BPM} BPM. Dra slidern tills de känns synkade.
          </p>
          <Button size="sm" onClick={metroRunning ? stopMetro : startMetro} disabled={!conn} className="gap-1.5 text-xs">
            {metroRunning ? <><Square className="w-3 h-3" /> Stoppa & spara</> : <><Play className="w-3 h-3" /> Starta</>}
          </Button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground font-mono w-14 shrink-0">Offset</span>
            <input type="range" min={0} max={200} step={5} value={metroOffset} onChange={(e) => setMetroOffset(parseInt(e.target.value))} className="flex-1 h-1.5 accent-current text-primary" />
            <span className="text-xs font-mono text-foreground w-14 text-right">{metroOffset}ms</span>
          </div>
          {metroResult != null && !metroRunning && (
            <div className="bg-primary/10 border border-primary/20 rounded-md px-3 py-2">
              <p className="text-xs font-bold text-primary">Metronom: <span className="font-mono">{metroResult}ms</span></p>
            </div>
          )}
        </div>
      )}

      {(tapResult != null || metroResult != null) && (
        <div className="border-t border-border/20 pt-3 space-y-2">
          <p className="text-[10px] font-bold text-foreground/70">Sammanfattning</p>
          <div className="text-[10px] font-mono space-y-0.5">
            <div className="flex justify-between"><span>Tap-sync</span><span>{tapResult != null ? `${tapResult}ms` : '—'}</span></div>
            <div className="flex justify-between"><span>Metronom</span><span>{metroResult != null ? `${metroResult}ms` : '—'}</span></div>
            {bestResult != null && (
              <div className="flex justify-between font-bold border-t border-border/20 pt-1">
                <span>{tapResult != null && metroResult != null ? 'Medelvärde' : 'Resultat'}</span>
                <span className="text-primary">{bestResult}ms</span>
              </div>
            )}
          </div>
          {bestResult != null && (
            <Button size="sm" onClick={() => onSave(bestResult)} className="text-xs gap-1 w-full">
              Spara latenskompensation ({bestResult}ms)
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

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
    if (!conn || tab === 'ble' || tab === 'latency') return;
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
