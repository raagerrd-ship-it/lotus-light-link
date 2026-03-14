import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Play, Square, Check, RefreshCw, Music, Trash2 } from "lucide-react";
import {
  getCalibration, saveCalibration,
  setActiveDeviceName, loadCalibrationFromCloud,
  saveBleSpeedToCloud,
  listCalibrationsFromCloud, deleteCalibrationFromCloud,
  DEFAULT_CALIBRATION,
  type LightCalibration, type LatencyResults,
} from "@/lib/lightCalibration";
import { supabase } from "@/integrations/supabase/client";
import { setBleMinInterval } from "@/lib/bledom";
import { getBleConnection, subscribeBle } from "@/lib/bleStore";

import ChainSyncTab from "@/components/ChainSyncTab";
import SongCalibrationTab from "@/components/SongCalibrationTab";
import CalibrationTips from "@/components/CalibrationTips";

type Tab = 'ble' | 'chain' | 'song' | 'songs';

interface TabInfo {
  key: Tab;
  label: string;
  step?: number;
  desc: string;
}

const TABS: TabInfo[] = [
  { key: 'ble', label: '1. BLE', step: 1, desc: 'Testa lampans hastighet' },
  { key: 'chain', label: '2. Synk', step: 2, desc: 'Mät fördröjning' },
  { key: 'song', label: '3. Dynamik', step: 3, desc: 'Optimera ljusrespons' },
  { key: 'songs', label: 'Inspelningar', desc: 'Hantera inspelade låtar' },
];

// BLE Throughput Test — measures actual GATT write times at decreasing intervals

const COLOR_BUF = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
const BRIGHT_BUF = new Uint8Array([0x7e, 0x04, 0x01, 0, 0x01, 0xff, 0x00, 0x00, 0xef]);
const CYCLE_COLORS: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

const TEST_INTERVALS = [100, 80, 60, 50, 40, 35, 30, 25, 20];
const WRITES_PER_STEP = 10;
const WARMUP_WRITES = 2; // ignore first N writes per step

interface StepResult {
  intervalMs: number;
  meanMs: number;
  maxMs: number;
  stable: boolean;
  writeTimes: number[];
}

async function bleWriteTimed(char: BluetoothRemoteGATTCharacteristic, buf: Uint8Array): Promise<number> {
  const t0 = performance.now();
  await char.writeValueWithoutResponse(buf as any);
  return performance.now() - t0;
}

function BleSpeedTab({ conn, onSpeedSave }: { conn: any; onSpeedSave?: (bestMs: number) => void }) {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [stepResults, setStepResults] = useState<StepResult[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [optimalMs, setOptimalMs] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const abortRef = { current: false };

  const runTest = useCallback(async () => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    
    setPhase('running');
    setStepResults([]);
    setOptimalMs(null);
    setSaved(false);
    abortRef.current = false;

    // Start with lamp off
    BRIGHT_BUF[3] = 0;
    await char.writeValueWithoutResponse(BRIGHT_BUF as any);
    await new Promise(r => setTimeout(r, 300));

    const results: StepResult[] = [];
    let lastStableInterval = TEST_INTERVALS[0];

    for (let si = 0; si < TEST_INTERVALS.length; si++) {
      if (abortRef.current) break;
      const interval = TEST_INTERVALS[si];
      setCurrentStep(si);

      const writeTimes: number[] = [];

      for (let w = 0; w < WRITES_PER_STEP; w++) {
        if (abortRef.current) break;

        // Cycle colors for visual feedback
        const [cr, cg, cb] = CYCLE_COLORS[w % 3];
        COLOR_BUF[4] = cr; COLOR_BUF[5] = cg; COLOR_BUF[6] = cb;
        BRIGHT_BUF[3] = 100;

        // Write color + brightness, measure total time
        const t0 = performance.now();
        await char.writeValueWithoutResponse(COLOR_BUF as any);
        await new Promise(r => setTimeout(r, 1));
        await char.writeValueWithoutResponse(BRIGHT_BUF as any);
        const elapsed = performance.now() - t0;

        writeTimes.push(elapsed);

        // Wait remainder of interval
        const remaining = interval - elapsed;
        if (remaining > 0) {
          await new Promise(r => setTimeout(r, remaining));
        }
      }

      // Analyze: skip warmup writes
      const measured = writeTimes.slice(WARMUP_WRITES);
      const mean = measured.reduce((a, b) => a + b, 0) / measured.length;
      const max = Math.max(...measured);

      // Stable if mean < 50% of interval AND max < 80% of interval
      const stable = mean < interval * 0.5 && max < interval * 0.8;

      const result: StepResult = {
        intervalMs: interval,
        meanMs: Math.round(mean * 10) / 10,
        maxMs: Math.round(max * 10) / 10,
        stable,
        writeTimes: measured.map(t => Math.round(t * 10) / 10),
      };

      results.push(result);
      setStepResults([...results]);

      if (stable) {
        lastStableInterval = interval;
      } else {
        // Found the limit — stop testing
        break;
      }
    }

    // Turn lamp to neutral after test
    COLOR_BUF[4] = 255; COLOR_BUF[5] = 200; COLOR_BUF[6] = 100;
    BRIGHT_BUF[3] = 50;
    try {
      await char.writeValueWithoutResponse(COLOR_BUF as any);
      await new Promise(r => setTimeout(r, 2));
      await char.writeValueWithoutResponse(BRIGHT_BUF as any);
    } catch {}

    setOptimalMs(lastStableInterval);
    setBleMinInterval(lastStableInterval);
    setPhase('done');
  }, [conn]);

  return (
    <div className="space-y-4">
      {/* Description */}
      <div className="bg-secondary/50 border border-border/30 rounded-lg px-3 py-2.5">
        <p className="text-xs text-foreground/90 leading-relaxed">
          <span className="font-bold">Vad händer?</span> Systemet skickar färg + brightness-kommandon i allt snabbare takt och mäter
          hur lång tid varje BLE-skrivning tar. När skrivtiderna börjar öka har lampans buffert nått sin gräns.
        </p>
        <p className="text-[10px] text-muted-foreground mt-1">
          💡 Lampan blinkar R→G→B under testet — du ser visuellt att den reagerar.
        </p>
      </div>

      {!conn && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2.5">
          <p className="text-xs text-destructive font-medium">⚠ Anslut BLE-lampan först</p>
          <p className="text-[10px] text-destructive/70 mt-0.5">Gå tillbaka till huvudvyn och tryck på Bluetooth-knappen i headern.</p>
        </div>
      )}

      {/* Start button */}
      {phase === 'idle' && conn && (
        <Button size="sm" onClick={runTest} className="gap-1.5 text-xs w-full">
          <Play className="w-3.5 h-3.5" /> Starta genomströmningstest
        </Button>
      )}

      {/* Running — live progress */}
      {phase === 'running' && (
        <div className="space-y-3">
          <div className="text-center py-4 bg-secondary/30 rounded-xl border border-border/20">
            <p className="text-sm font-bold text-foreground/80">Testar…</p>
            <p className="text-xs text-muted-foreground mt-1">
              Intervall: <span className="font-mono font-bold text-primary">{TEST_INTERVALS[currentStep]}ms</span>
              <span className="text-foreground/40 ml-2">({currentStep + 1}/{TEST_INTERVALS.length})</span>
            </p>
            {/* Progress bar */}
            <div className="mx-auto mt-3 w-3/4 h-1.5 bg-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${((currentStep + 1) / TEST_INTERVALS.length) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Live results table (during running + done) */}
      {stepResults.length > 0 && (
        <div className="border border-border/30 rounded-lg overflow-hidden">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="bg-secondary/50 text-foreground/70">
                <th className="text-left px-2 py-1.5 font-bold">Intervall</th>
                <th className="text-right px-2 py-1.5 font-bold">Medel</th>
                <th className="text-right px-2 py-1.5 font-bold">Max</th>
                <th className="text-center px-2 py-1.5 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {stepResults.map((r, i) => (
                <tr key={i} className={`border-t border-border/10 ${r.stable ? '' : 'bg-destructive/5'}`}>
                  <td className="px-2 py-1 text-foreground/80">{r.intervalMs}ms</td>
                  <td className="px-2 py-1 text-right text-foreground/80">{r.meanMs}ms</td>
                  <td className="px-2 py-1 text-right text-foreground/80">{r.maxMs}ms</td>
                  <td className="px-2 py-1 text-center">
                    {r.stable
                      ? <span className="text-primary">✓</span>
                      : <span className="text-destructive">✗</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Done — results */}
      {phase === 'done' && optimalMs != null && (
        <div className="space-y-3">
          {saved && (
            <div className="bg-primary/15 border border-primary/30 rounded-lg px-3 py-2.5 flex items-center gap-2">
              <Check className="w-4 h-4 text-primary shrink-0" />
              <p className="text-xs font-bold text-primary">Kalibrering sparad!</p>
            </div>
          )}

          <div className="bg-secondary/50 border border-border/30 rounded-lg px-3 py-2.5">
            <p className="text-xs font-bold text-foreground">Resultat</p>
            <p className="text-sm text-foreground mt-1">
              Optimalt intervall: <span className="font-mono font-bold text-primary">{optimalMs}ms</span>
              <span className="text-muted-foreground ml-2 text-xs">({Math.round(1000 / optimalMs)} cmd/s)</span>
            </p>
          </div>

          <div className="flex gap-2">
            {!saved ? (
              <Button size="sm" onClick={() => { onSpeedSave?.(optimalMs); setSaved(true); }} className="text-xs gap-1 flex-1">
                <Check className="w-3.5 h-3.5" /> Spara kalibrering
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => { setPhase('idle'); setStepResults([]); setOptimalMs(null); setSaved(false); }} className="text-xs flex-1">
                <RefreshCw className="w-3 h-3 mr-1" /> Ny kalibrering
              </Button>
            )}
            {!saved && (
              <Button size="sm" variant="secondary" onClick={() => { setPhase('idle'); setStepResults([]); }} className="text-xs">
                Kör om
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// LatencyTab removed — functionality moved to ChainSyncTab sub-step B

function CurrentCalibrationPanel({ cal }: { cal: LightCalibration }) {
  const changed = (key: keyof LightCalibration) => cal[key] !== DEFAULT_CALIBRATION[key];
  const row = (label: string, key: keyof LightCalibration, unit = '') => (
    <div className={`flex justify-between text-[10px] font-mono ${changed(key) ? 'text-primary font-bold' : 'text-muted-foreground'}`}>
      <span>{label}</span>
      <span>{typeof cal[key] === 'number' ? (cal[key] as number).toFixed(key.startsWith('gamma') || key === 'saturationBoost' || key === 'attackAlpha' || key === 'releaseAlpha' || key === 'dynamicDamping' ? (key === 'releaseAlpha' ? 3 : 2) : 0) : String(cal[key])}{unit}</span>
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
          {row('Damping', 'dynamicDamping', '×')}
          {row('Kedjelatens', 'chainLatencyMs', 'ms')}
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

  // Compute average BLE interval
  const bleIntervals = entries
    .map(e => e.ble_min_interval_ms)
    .filter((v: any): v is number => v != null && v > 0);
  const avgBle = bleIntervals.length > 0
    ? Math.round(bleIntervals.reduce((a, b) => a + b, 0) / bleIntervals.length)
    : null;

  return (
    <div className="border border-border/30 rounded-md px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-bold text-foreground/70">Historik — {deviceName}</p>
        <button onClick={load} className="text-[10px] text-muted-foreground hover:text-foreground">
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {/* Averaged values summary */}
      {avgBle != null && bleIntervals.length > 1 && (
        <div className="bg-primary/10 border border-primary/20 rounded px-2 py-1.5 mb-2">
          <p className="text-[10px] font-bold text-primary">Aktivt snitt ({bleIntervals.length} mätningar)</p>
          <p className="text-[10px] font-mono text-foreground/80">BLE-intervall: <span className="font-bold text-primary">{avgBle}ms</span></p>
          <p className="text-[9px] text-muted-foreground mt-0.5">Ta bort gamla poster för att ändra snittet.</p>
        </div>
      )}

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

  // Step completion status
  const bleCalibrated = cal.bleLatencyMs !== DEFAULT_CALIBRATION.bleLatencyMs || true; // BLE speed auto-saves
  const chainCalibrated = cal.chainLatencyMs !== 0;
  const songCalibrated = cal.attackAlpha !== DEFAULT_CALIBRATION.attackAlpha || cal.releaseAlpha !== DEFAULT_CALIBRATION.releaseAlpha || cal.minBrightness !== DEFAULT_CALIBRATION.minBrightness || cal.maxBrightness !== DEFAULT_CALIBRATION.maxBrightness;

  const stepStatus = (tab: Tab): 'done' | 'current' | 'pending' => {
    if (tab === 'ble') return 'done'; // always "done" if they've been here
    if (tab === 'chain') return chainCalibrated ? 'done' : 'pending';
    if (tab === 'song') return songCalibrated ? 'done' : 'pending';
    return 'pending';
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-3 mb-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')} className="rounded-full w-8 h-8">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-sm font-bold tracking-widest uppercase text-foreground/80">Kalibrering</h1>
          <p className="text-[10px] text-muted-foreground">Gå igenom stegen i ordning för bästa resultat</p>
        </div>
        <div className="flex-1" />
        {conn
          ? <span className="text-[10px] font-mono text-primary/70">{conn.device?.name || 'Ansluten'}</span>
          : <span className="text-[10px] font-mono text-destructive/70">Ej ansluten</span>
        }
      </div>

      {/* Tab bar with step indicators */}
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {TABS.map((t) => {
          const status = t.step ? stepStatus(t.key) : undefined;
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wide transition-colors shrink-0 flex items-center gap-1 ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-accent'
              }`}
            >
              {status === 'done' && !isActive && <span className="text-[9px]">✓</span>}
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-1">
        {tab === 'ble' && <BleSpeedTab conn={conn} onSpeedSave={(bests) => {
          const deviceName = conn?.device?.name;
          if (deviceName) {
            const worst = Math.max(...(Object.values(bests) as number[]));
            saveBleSpeedToCloud(deviceName, worst, bests as Record<string, number>);
          }
        }} />}

        {tab === 'chain' && <ChainSyncTab
          currentChainLatencyMs={cal.chainLatencyMs}
          onSave={(ms) => update({ chainLatencyMs: ms })}
        />}
        {tab === 'song' && <SongCalibrationTab cal={cal} onSave={(patch) => update(patch)} />}

        {tab === 'songs' && <RecordedSongsTab />}
      </div>

      {/* Calibration song tips — show on relevant tabs */}
      {(tab === 'chain' || tab === 'song') && (
        <div className="mt-4">
          <CalibrationTips activeCategory={tab === 'chain' ? 'sync' : 'dynamics'} />
        </div>
      )}

      {/* Current calibration + history */}
      <div className="mt-6 space-y-3">
        <CurrentCalibrationPanel cal={cal} />
        <CalibrationHistory deviceName={conn?.device?.name ?? null} />
      </div>
    </div>
  );
}
