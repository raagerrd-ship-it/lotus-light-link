import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Play, Square, Check, RefreshCw, Music, Trash2 } from "lucide-react";
import {
  getCalibration, saveCalibration,
  setActiveDeviceName, loadCalibrationFromCloud,
  saveBleSpeedToCloud, saveLatencyToCloud,
  listCalibrationsFromCloud, deleteCalibrationFromCloud,
  DEFAULT_CALIBRATION,
  type LightCalibration, type LatencyResults,
} from "@/lib/lightCalibration";
import { supabase } from "@/integrations/supabase/client";
import { setBleMinInterval } from "@/lib/bledom";
import { getBleConnection, subscribeBle } from "@/lib/bleStore";

type Tab = 'ble' | 'latency' | 'songs';

const TABS: { key: Tab; label: string }[] = [
  { key: 'ble', label: 'BLE-hastighet' },
  { key: 'latency', label: 'Latens' },
  { key: 'songs', label: 'Inspelade låtar' },
];

// BLE Perceptual Speed Test buffers

const COLOR_BUF = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const BRIGHT_BUF = new Uint8Array([0x7e, 0x04, 0x01, 0, 0x01, 0xff, 0x00, 0x00, 0xef]);

const PULSE_DURATIONS = [30, 25, 20, 18, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const PULSES_PER_STEP = 3;
const PULSE_GAP_MS = 800;

const BLE_CMD_GAP = 1; // ms between color and brightness commands
async function bleWrite(char: BluetoothRemoteGATTCharacteristic, buf: Uint8Array) {
  await char.writeValueWithoutResponse(buf as any);
}
async function bleColorThenBright(char: BluetoothRemoteGATTCharacteristic, brightness: number) {
  await bleWrite(char, COLOR_BUF);
  await new Promise(r => setTimeout(r, BLE_CMD_GAP));
  BRIGHT_BUF[3] = brightness;
  await bleWrite(char, BRIGHT_BUF);
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
    COLOR_BUF[4] = 255; COLOR_BUF[5] = 255; COLOR_BUF[6] = 255;
    await bleColorThenBright(char, 100);
    await new Promise(r => setTimeout(r, durationMs));
    await bleColorThenBright(char, 0);
  } else if (mode === 'color') {
    // Dark first, set color, then raise brightness
    COLOR_BUF[4] = 0; COLOR_BUF[5] = 0; COLOR_BUF[6] = 0;
    await bleColorThenBright(char, 0);
    await new Promise(r => setTimeout(r, BLE_CMD_GAP));
    const [cr, cg, cb] = CYCLE_COLORS[pulseIndex % 3];
    COLOR_BUF[4] = cr; COLOR_BUF[5] = cg; COLOR_BUF[6] = cb;
    await bleColorThenBright(char, 100);
    await new Promise(r => setTimeout(r, durationMs));
    await bleColorThenBright(char, 0);
  } else {
    // Combined: color + brightness
    const [cr, cg, cb] = CYCLE_COLORS[pulseIndex % 3];
    COLOR_BUF[4] = cr; COLOR_BUF[5] = cg; COLOR_BUF[6] = cb;
    await bleColorThenBright(char, 100);
    await new Promise(r => setTimeout(r, durationMs));
    await bleColorThenBright(char, 0);
  }
}

interface PulseResult {
  durationMs: number;
  answer: 'all' | 'partial' | 'none';
  mode: TestMode;
}

// Per-mode best result: the shortest duration where all 3 pulses were seen
type ModeBests = Partial<Record<TestMode, number>>;

function BleSpeedTab({ conn, onSpeedSave }: { conn: any; onSpeedSave?: (bests: ModeBests) => void }) {
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
        onSpeedSave?.(newBests);
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

const FLASHES_PER_ROUND = 3;
const FLASH_GAP_MS = 900;
const MAX_TAP_ROUNDS = 8;
const VERIFY_FLASHES = 5;
const METRO_BPM = 120;

function LatencyTab({ conn, onSave }: { conn: any; onSave: (ms: number, latency: LatencyResults) => void }) {
  const [testMode, setTestMode] = useState<'tap' | 'metronome' | 'verify'>('tap');

  // TAP-SYNC state
  const [tapPhase, setTapPhase] = useState<'idle' | 'waiting' | 'asking' | 'done'>('idle');
  const [tapOffset, setTapOffset] = useState(0);
  const [tapLow, setTapLow] = useState(0);
  const [tapHigh, setTapHigh] = useState(300);
  const [tapRound, setTapRound] = useState(0);
  const [tapHistory, setTapHistory] = useState<{ offset: number; answer: string }[]>([]);
  const [screenFlash, setScreenFlash] = useState(false);
  const [gattRoundtrip, setGattRoundtrip] = useState<number | null>(null);

  // METRONOME state
  const [metroRunning, setMetroRunning] = useState(false);
  const [metroOffset, setMetroOffset] = useState(50);
  const [metroFlash, setMetroFlash] = useState(false);
  const metroTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metroOffsetRef = useRef(50);
  const metroRunningRef = useRef(false);

  // VERIFY state
  const [verifyPhase, setVerifyPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [verifyCount, setVerifyCount] = useState(0);
  const [verified, setVerified] = useState<boolean | null>(null);

  // RESULTS
  const [tapResult, setTapResult] = useState<number | null>(null);
  const [metroResult, setMetroResult] = useState<number | null>(null);

  useEffect(() => { metroOffsetRef.current = metroOffset; }, [metroOffset]);

  // Measure GATT roundtrip on mount
  useEffect(() => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    (async () => {
      try {
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);
          times.push(performance.now() - t0);
          await new Promise(r => setTimeout(r, 50));
        }
        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)];
        setGattRoundtrip(Math.round(median));
      } catch {}
    })();
  }, [conn?.characteristic]);

  // TAP-SYNC: fire 3 flashes per round
  const doTapFlashes = useCallback(async (offsetMs: number) => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;

    await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);
    await new Promise(r => setTimeout(r, 600));
    // Random wait
    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

    for (let i = 0; i < FLASHES_PER_ROUND; i++) {
      // Color first, then brightness, with 1ms gap
      await char.writeValueWithoutResponse(LATENCY_COLOR_BUF as any);
      await new Promise(r => setTimeout(r, BLE_CMD_GAP));
      await char.writeValueWithoutResponse(LATENCY_BRIGHT_ON as any);

      // Screen flash delayed by offset
      setTimeout(() => { setScreenFlash(true); setTimeout(() => setScreenFlash(false), 100); }, Math.max(0, offsetMs));

      // Turn off lamp after 100ms
      await new Promise(r => setTimeout(r, 100));
      await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);

      if (i < FLASHES_PER_ROUND - 1) {
        await new Promise(r => setTimeout(r, FLASH_GAP_MS));
      }
    }
  }, [conn]);

  const startTap = useCallback(async () => {
    // Use GATT roundtrip as initial guess if available, else midpoint
    const low = 0, high = 300;
    const mid = gattRoundtrip != null ? Math.min(high, Math.max(low, gattRoundtrip * 3)) : Math.round((low + high) / 2);
    setTapLow(low); setTapHigh(high); setTapOffset(mid);
    setTapRound(1); setTapHistory([]); setTapResult(null);
    setTapPhase('waiting');
    await doTapFlashes(mid);
    setTapPhase('asking');
  }, [doTapFlashes, gattRoundtrip]);

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
    await doTapFlashes(nMid);
    setTapPhase('asking');
  }, [tapHistory, tapOffset, tapRound, tapLow, tapHigh, doTapFlashes, conn]);

  // METRONOME — setTimeout chain instead of setInterval
  const startMetro = useCallback(() => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    const intervalMs = (60 / METRO_BPM) * 1000;
    setMetroRunning(true); setMetroResult(null);
    metroRunningRef.current = true;

    char.writeValueWithoutResponse(LATENCY_COLOR_BUF as any).catch(() => {});

    const tick = () => {
      if (!metroRunningRef.current) return;
      char.writeValueWithoutResponse(LATENCY_BRIGHT_ON as any).catch(() => {});
      setTimeout(() => { char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any).catch(() => {}); }, 80);
      setTimeout(() => { setMetroFlash(true); setTimeout(() => setMetroFlash(false), 80); }, metroOffsetRef.current);
      // Schedule next tick with setTimeout for lower jitter
      metroTimeoutRef.current = setTimeout(tick, intervalMs);
    };
    tick();
  }, [conn]);

  const stopMetro = useCallback(() => {
    metroRunningRef.current = false;
    if (metroTimeoutRef.current) clearTimeout(metroTimeoutRef.current);
    metroTimeoutRef.current = null;
    setMetroRunning(false);
    setMetroResult(metroOffset);
  }, [metroOffset]);

  useEffect(() => () => {
    metroRunningRef.current = false;
    if (metroTimeoutRef.current) clearTimeout(metroTimeoutRef.current);
  }, []);

  // VERIFY — run synced flashes with saved offset
  const bestResult = tapResult != null && metroResult != null
    ? Math.round((tapResult + metroResult) / 2)
    : tapResult ?? metroResult;

  const startVerify = useCallback(async () => {
    if (!conn?.characteristic || bestResult == null) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    setVerifyPhase('running'); setVerifyCount(0); setVerified(null);

    await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);
    await new Promise(r => setTimeout(r, 500));

    for (let i = 0; i < VERIFY_FLASHES; i++) {
      setVerifyCount(i + 1);
      // BLE flash
      await char.writeValueWithoutResponse(LATENCY_COLOR_BUF as any);
      await char.writeValueWithoutResponse(LATENCY_BRIGHT_ON as any);
      // Screen flash with calibrated offset
      setTimeout(() => { setScreenFlash(true); setTimeout(() => setScreenFlash(false), 100); }, Math.max(0, bestResult));
      await new Promise(r => setTimeout(r, 100));
      await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);
      await new Promise(r => setTimeout(r, 900));
    }
    setVerifyPhase('done');
  }, [conn, bestResult]);

  const handleSave = useCallback(() => {
    if (bestResult == null) return;
    const latency: LatencyResults = {
      tapMs: tapResult,
      metroMs: metroResult,
      gattRoundtripMs: gattRoundtrip,
      verifiedAt: verified ? new Date().toISOString() : null,
      verified: verified === true,
    };
    onSave(bestResult, latency);
  }, [bestResult, tapResult, metroResult, gattRoundtrip, verified, onSave]);

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
        {bestResult != null && (
          <button onClick={() => setTestMode('verify')} className={`px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition-colors ${testMode === 'verify' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'}`}>
            Verifiera
          </button>
        )}
      </div>

      {!conn && <p className="text-xs text-destructive">Anslut BLE-lampan först.</p>}

      {/* GATT roundtrip info */}
      {gattRoundtrip != null && (
        <p className="text-[10px] text-muted-foreground font-mono">GATT roundtrip: {gattRoundtrip}ms</p>
      )}

      {testMode === 'tap' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Lampan och skärmen blinkar {FLASHES_PER_ROUND} gånger per runda. Svara om lampan var före, efter eller synk med skärmen. Binärsökning ~{MAX_TAP_ROUNDS} rundor.
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
            <input type="range" min={0} max={300} step={5} value={metroOffset} onChange={(e) => setMetroOffset(parseInt(e.target.value))} className="flex-1 h-1.5 accent-current text-primary" />
            <span className="text-xs font-mono text-foreground w-14 text-right">{metroOffset}ms</span>
          </div>
          {metroResult != null && !metroRunning && (
            <div className="bg-primary/10 border border-primary/20 rounded-md px-3 py-2">
              <p className="text-xs font-bold text-primary">Metronom: <span className="font-mono">{metroResult}ms</span></p>
            </div>
          )}
        </div>
      )}

      {testMode === 'verify' && bestResult != null && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Verifierar latenskompensation ({bestResult}ms). {VERIFY_FLASHES} synkade blinkar — lampan och skärmen ska matcha.
          </p>
          {verifyPhase === 'idle' && (
            <Button size="sm" onClick={startVerify} disabled={!conn} className="gap-1.5 text-xs">
              <RefreshCw className="w-3 h-3" /> Kör verifiering
            </Button>
          )}
          {verifyPhase === 'running' && (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground animate-pulse">Blink {verifyCount}/{VERIFY_FLASHES}…</p>
            </div>
          )}
          {verifyPhase === 'done' && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground">Såg lampan och skärmen synkade ut?</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => { setVerified(true); setVerifyPhase('idle'); }} className="gap-1 text-xs">
                  <Check className="w-3 h-3" /> Ja, synkat
                </Button>
                <Button size="sm" variant="secondary" onClick={() => { setVerified(false); setVerifyPhase('idle'); setTestMode('tap'); }} className="text-xs">
                  Nej, kör om
                </Button>
              </div>
              {verified === true && (
                <p className="text-[10px] text-primary font-mono">✓ Verifierad</p>
              )}
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
            {gattRoundtrip != null && <div className="flex justify-between"><span>GATT roundtrip</span><span>{gattRoundtrip}ms</span></div>}
            {bestResult != null && (
              <div className="flex justify-between font-bold border-t border-border/20 pt-1">
                <span>{tapResult != null && metroResult != null ? 'Medelvärde' : 'Resultat'}</span>
                <span className="text-primary">{bestResult}ms</span>
              </div>
            )}
            {verified === true && <div className="text-primary">✓ Verifierad</div>}
          </div>
          {bestResult != null && (
            <div className="pt-2">
              <Button size="sm" onClick={handleSave} className="text-xs gap-1 w-full">
                Spara latenskompensation ({bestResult}ms)
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="h-24" />
    </div>
  );
}

function CurrentCalibrationPanel({ cal }: { cal: LightCalibration }) {
  const changed = (key: keyof LightCalibration) => cal[key] !== DEFAULT_CALIBRATION[key];
  const row = (label: string, key: keyof LightCalibration, unit = '') => (
    <div className={`flex justify-between text-[10px] font-mono ${changed(key) ? 'text-foreground' : 'text-muted-foreground'}`}>
      <span>{label}</span>
      <span>{typeof cal[key] === 'number' ? (cal[key] as number).toFixed(key.startsWith('gamma') || key === 'saturationBoost' ? 2 : 0) : String(cal[key])}{unit}</span>
    </div>
  );

  return (
    <div className="border border-border/30 rounded-md px-3 py-2 space-y-0.5">
      <p className="text-[10px] font-bold text-foreground/70 mb-1">Aktuell kalibrering</p>
      <div className="grid grid-cols-2 gap-x-4">
        <div className="space-y-0.5">
          <p className="text-[9px] text-muted-foreground font-bold">Färg</p>
          {row('Gamma R', 'gammaR')}
          {row('Gamma G', 'gammaG')}
          {row('Gamma B', 'gammaB')}
          {row('Offset R', 'offsetR')}
          {row('Offset G', 'offsetG')}
          {row('Offset B', 'offsetB')}
          {row('Mättnad', 'saturationBoost', '×')}
        </div>
        <div className="space-y-0.5">
          <p className="text-[9px] text-muted-foreground font-bold">Ljus & dynamik</p>
          {row('Min ljus', 'minBrightness', '%')}
          {row('Max ljus', 'maxBrightness', '%')}
          {row('Attack α', 'attackAlpha')}
          {row('Release α', 'releaseAlpha')}
          {row('Kick tröskel', 'whiteKickThreshold', '%')}
          {row('Kick tid', 'whiteKickMs', 'ms')}
          {row('BLE latens', 'bleLatencyMs', 'ms')}
        </div>
      </div>
    </div>
  );
}

function CalibrationHistory({ deviceName }: { deviceName: string | null }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!deviceName) return;
    setLoading(true);
    const data = await listCalibrationsFromCloud(deviceName);
    setEntries(data);
    setLoading(false);
  }, [deviceName]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteCalibrationFromCloud(id);
    setEntries(prev => prev.filter(e => e.id !== id));
  }, []);

  if (!deviceName) return <p className="text-[10px] text-muted-foreground">Anslut BLE-lampa för att se historik.</p>;

  return (
    <div className="border border-border/30 rounded-md px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-bold text-foreground/70">Historik — {deviceName}</p>
        <button onClick={load} className="text-[10px] text-muted-foreground hover:text-foreground">
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>
      {loading && <p className="text-[10px] text-muted-foreground">Laddar…</p>}
      {!loading && entries.length === 0 && <p className="text-[10px] text-muted-foreground">Inga poster.</p>}
      {!loading && entries.length > 0 && (
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {entries.map((e) => {
            const cal = e.calibration as Record<string, number> | null;
            const lat = e.latency_results as LatencyResults | null;
            const spd = e.ble_speed_results as Record<string, number> | null;
            const date = new Date(e.updated_at);
            return (
              <div key={e.id} className="border border-border/20 rounded px-2 py-1.5 text-[10px] font-mono space-y-0.5">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{date.toLocaleDateString('sv')} {date.toLocaleTimeString('sv', { hour: '2-digit', minute: '2-digit' })}</span>
                  <button onClick={() => handleDelete(e.id)} className="text-muted-foreground hover:text-destructive p-0.5">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-foreground/70">
                  {e.ble_min_interval_ms != null && <span>BLE: {e.ble_min_interval_ms}ms</span>}
                  {cal?.bleLatencyMs != null && <span>Latens: {cal.bleLatencyMs}ms</span>}
                  {lat?.tapMs != null && <span>Tap: {lat.tapMs}ms</span>}
                  {lat?.metroMs != null && <span>Metro: {lat.metroMs}ms</span>}
                  {lat?.gattRoundtripMs != null && <span>GATT: {lat.gattRoundtripMs}ms</span>}
                  {lat?.verified && <span className="text-primary">✓</span>}
                  {spd && Object.entries(spd).map(([k, v]) => <span key={k}>{k}: {v}ms</span>)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RecordedSongsTab() {
  const [songs, setSongs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("song_analysis")
      .select("id, track_name, artist_name, recorded_volume, energy_curve, created_at")
      .not("energy_curve", "is", null)
      .order("created_at", { ascending: false });
    setSongs(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    setDeleting(id);
    await supabase
      .from("song_analysis")
      .update({ energy_curve: null, recorded_volume: null } as any)
      .eq("id", id);
    setSongs(prev => prev.filter(s => s.id !== id));
    setDeleting(null);
  }, []);

  const curveLength = (curve: any): number => {
    if (!Array.isArray(curve)) return 0;
    return curve.length;
  };

  const curveDuration = (curve: any): string => {
    if (!Array.isArray(curve) || curve.length === 0) return "—";
    const last = curve[curve.length - 1];
    const secs = last?.t ?? 0;
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Låtar med inspelade energikurvor. Nästa gång de spelas styrs lampan direkt från kurvan.
        </p>
        <button onClick={load} className="text-muted-foreground hover:text-foreground p-1">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading && <p className="text-xs text-muted-foreground">Laddar…</p>}

      {!loading && songs.length === 0 && (
        <div className="text-center py-8">
          <Music className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">Inga inspelade låtar ännu.</p>
          <p className="text-[10px] text-muted-foreground/60 mt-1">Spela musik med mikrofonen aktiv — kurvan sparas automatiskt.</p>
        </div>
      )}

      {!loading && songs.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground font-bold">{songs.length} låt{songs.length !== 1 ? 'ar' : ''}</p>
          <div className="space-y-1 max-h-[60vh] overflow-y-auto">
            {songs.map((s) => {
              const samples = curveLength(s.energy_curve);
              const dur = curveDuration(s.energy_curve);
              const date = s.created_at ? new Date(s.created_at) : null;
              return (
                <div key={s.id} className="border border-border/30 rounded-md px-3 py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{s.track_name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{s.artist_name}</p>
                    <div className="flex gap-3 mt-0.5 text-[10px] font-mono text-foreground/50">
                      <span>{dur}</span>
                      <span>{samples} samples</span>
                      {s.recorded_volume != null && <span>Vol {s.recorded_volume}</span>}
                      {date && <span>{date.toLocaleDateString('sv')}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(s.id)}
                    disabled={deleting === s.id}
                    className="text-muted-foreground hover:text-destructive p-1.5 rounded-full hover:bg-destructive/10 transition-colors shrink-0 disabled:opacity-50"
                    title="Ta bort inspelning"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Calibrate() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('ble');
  const [cal, setCal] = useState<LightCalibration>(getCalibration);
  const [conn, setConn] = useState(getBleConnection);
  useEffect(() => subscribeBle(() => setConn(getBleConnection())), []);

  // Sync calibration from cloud when device connects
  useEffect(() => {
    const deviceName = conn?.device?.name;
    if (!deviceName) return;
    setActiveDeviceName(deviceName);
    loadCalibrationFromCloud(deviceName).then((data) => {
      if (data) {
        setCal(data.calibration);
        if (data.bleMinIntervalMs) setBleMinInterval(data.bleMinIntervalMs);
        console.log(`[calibration] loaded from cloud for ${deviceName}`);
      }
    });
  }, [conn?.device?.name]);

  const update = useCallback((patch: Partial<LightCalibration>) => {
    setCal((prev) => {
      const next = { ...prev, ...patch };
      saveCalibration(next, conn?.device?.name);
      return next;
    });
  }, [conn?.device?.name]);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')} className="rounded-full w-8 h-8">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-sm font-bold tracking-widest uppercase text-foreground/80">Bas-kalibrering</h1>
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
        {tab === 'ble' && <BleSpeedTab conn={conn} onSpeedSave={(bests) => {
          const deviceName = conn?.device?.name;
          if (deviceName) {
            const worst = Math.max(...(Object.values(bests) as number[]));
            saveBleSpeedToCloud(deviceName, worst, bests as Record<string, number>);
          }
        }} />}

        {tab === 'latency' && <LatencyTab conn={conn} onSave={(ms, latency) => {
          update({ bleLatencyMs: ms });
          const deviceName = conn?.device?.name;
          if (deviceName) saveLatencyToCloud(deviceName, latency);
        }} />}
      </div>

      {/* Current calibration + history */}
      <div className="mt-6 space-y-3">
        <CurrentCalibrationPanel cal={cal} />
        <CalibrationHistory deviceName={conn?.device?.name ?? null} />
      </div>
    </div>
  );
}
