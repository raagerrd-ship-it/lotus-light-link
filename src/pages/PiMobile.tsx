import { useState, useRef, useEffect, useCallback } from "react";
import { Save, Check, Mic } from "lucide-react";

import { apiBase } from "@/lib/apiBase";
import { PermissionsBanner } from "@/components/PermissionsBanner";
import { StartAllPanel } from "@/components/StartAllPanel";


const PI_FONT = '"Noto Sans", "DejaVu Sans", "Liberation Sans", system-ui, sans-serif';



type Cal = { bassWeight: number; attack: number; softness: number; dynamicDamping: number; brightnessFloor: number; punchWhiteThreshold: number; perceptualGamma: number; transientGain: number; dynamicsEnabled: boolean; onsetThreshold: number; onsetRefractoryMs: number; onsetEnergyFloor: number; tickEnergyFloor: number; flickerDeadband: number; beatSource: 'bass' | 'full'; dropEnabled: boolean; dropSensitivity: number; dropFlashMs: number };
const PRESET_CALS: Record<string, Cal> = {
  // Nytänkta preset-värden som utnyttjar nya slidrarnas bredd
  Lugn:   { bassWeight: 0.7, attack: 70,  softness: 75, dynamicDamping: -1.5, brightnessFloor: 8, punchWhiteThreshold: 100, perceptualGamma: 2.2, transientGain: 0.7, dynamicsEnabled: true,  onsetThreshold: 2.0, onsetRefractoryMs: 150, onsetEnergyFloor: 0.05, tickEnergyFloor: 0.02, flickerDeadband: 0.03, beatSource: 'bass', dropEnabled: true, dropSensitivity: 1.2, dropFlashMs: 220 },
  Normal: { bassWeight: 0.9, attack: 100, softness: 20, dynamicDamping: 0,    brightnessFloor: 5, punchWhiteThreshold: 100, perceptualGamma: 0.9, transientGain: 0.8, dynamicsEnabled: false, onsetThreshold: 1.8, onsetRefractoryMs: 200, onsetEnergyFloor: 0.05, tickEnergyFloor: 0.02, flickerDeadband: 0.02, beatSource: 'bass', dropEnabled: true, dropSensitivity: 1.0, dropFlashMs: 220 },
  Party:  { bassWeight: 0.5, attack: 100, softness: 37, dynamicDamping: 1.5,  brightnessFloor: 0, punchWhiteThreshold: 93,  perceptualGamma: 1.5, transientGain: 1.5, dynamicsEnabled: true,  onsetThreshold: 1.6, onsetRefractoryMs: 90,  onsetEnergyFloor: 0.03, tickEnergyFloor: 0.01, flickerDeadband: 0.005, beatSource: 'bass', dropEnabled: true, dropSensitivity: 0.85, dropFlashMs: 260 },
  Custom: { bassWeight: 0.5, attack: 100, softness: 0,  dynamicDamping: 0,    brightnessFloor: 0, punchWhiteThreshold: 100, perceptualGamma: 0,   transientGain: 0.5, dynamicsEnabled: true,  onsetThreshold: 3.0, onsetRefractoryMs: 110, onsetEnergyFloor: 0.05, tickEnergyFloor: 0.02, flickerDeadband: 0.02, beatSource: 'bass', dropEnabled: true, dropSensitivity: 1.0, dropFlashMs: 220 },
};

const DEFAULT_CAL = PRESET_CALS.Normal;



/** Shared exponential mapping 0-100 → alpha 0.005-1.0 (lägre värde = mjukare) */
function curveToAlpha(v: number) {
  const t = v / 100;
  const alpha = 1.0 - 0.995 * Math.pow(t, 0.7);
  return Math.max(0.005, Math.round(alpha * 1000) / 1000);
}
/** Release: 0 = rått fall (alpha 1.0), 100 = mycket mjukt (alpha ~0.005) */
function softnessToAlpha(s: number) { return curveToAlpha(s); }
/** Attack: 0 = mjuk rise (alpha ~0.005), 100 = omedelbar (alpha 1.0) — INVERS av Release */
function attackToAlpha(a: number) { return curveToAlpha(100 - a); }
/** Reverse-mappa alpha → 0-100 UI-värde (för Release) */
function alphaToCurve(alpha: number) {
  const t = Math.pow(Math.max(0, (1 - alpha) / 0.995), 1 / 0.7);
  return Math.round(Math.min(100, Math.max(0, t * 100)));
}
/** Reverse-mappa alpha → 0-100 UI-värde (för Attack — invers) */
function alphaToAttack(alpha: number) {
  return 100 - alphaToCurve(alpha);
}



/* ── BLE Fade Test ── */
function BleFadeTest({ piBase, onResult }: { piBase: string; onResult: (wps: number) => void }) {
  const [running, setRunning] = useState(false);
  const [currentWps, setCurrentWps] = useState(0);
  const [result, setResult] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const postJson = (path: string, body?: unknown) =>
    fetch(`${piBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const startTest = async () => {
    setResult(null);
    setRunning(true);
    setCurrentWps(0);
    await postJson('/api/ble-fade-test');
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${piBase}/api/ble-fade-test/status`);
        const data = await r.json();
        setCurrentWps(data.currentWps);
        if (!data.running) {
          clearInterval(pollRef.current);
          setRunning(false);
        }
      } catch {}
    }, 500);
  };

  const stopTest = async () => {
    clearInterval(pollRef.current);
    try {
      const r = await postJson('/api/ble-fade-test/stop');
      const data = await r.json();
      setResult(data.lastWps);
    } catch {}
    setRunning(false);
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  const recommendedMs = result ? Math.round(1000 / result) : null;

  return (
    <div className="mt-6 p-4 rounded-xl bg-secondary/50 border border-border">
      <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
        <Zap size={14} /> BLE Hastighetstest
      </h3>
      <p className="text-[10px] text-muted-foreground mb-3">
        Lampan fadar rött snabbare och snabbare. Tryck stopp när den börjar hacka.
      </p>

      {running ? (
        <div className="space-y-3">
          <div className="text-center">
            <span className="text-3xl font-bold font-mono text-primary">{currentWps}</span>
            <span className="text-sm text-muted-foreground ml-1">w/s</span>
          </div>
          <div className="w-full bg-secondary rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-300"
              style={{ width: `${Math.min(100, currentWps)}%` }}
            />
          </div>
          <button
            onClick={stopTest}
            className="w-full py-3 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium active:scale-95 transition-transform"
          >
            ⏹ Stopp — lampan hackar
          </button>
        </div>
      ) : result ? (
        <div className="space-y-3">
          <div className="text-center">
            <div className="text-sm text-muted-foreground">Din lampa klarar ca</div>
            <span className="text-3xl font-bold font-mono text-primary">{result}</span>
            <span className="text-sm text-muted-foreground ml-1">w/s</span>
            <div className="text-xs text-muted-foreground mt-1">
              Rekommenderat: <span className="font-mono font-bold">{recommendedMs} ms</span> tick
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { if (result) onResult(result); }}
              className="flex-1 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium active:scale-95 transition-transform"
            >
              <Check size={14} className="inline mr-1" /> Använd {recommendedMs} ms
            </button>
            <button
              onClick={startTest}
              className="px-4 py-2.5 rounded-lg bg-secondary text-secondary-foreground text-sm font-medium active:scale-95 transition-transform"
            >
              Igen
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={startTest}
          className="w-full py-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium active:scale-95 transition-transform"
        >
          ⚡ Starta test
        </button>
      )}
    </div>
  );
}

/* ── Settings View ── */
/* ── Profile Settings View (calibration per preset) ── */






/* ── Mode-aware gain control: Manual XOR Auto (Sonos vol)
 *  Auto-läget använder två fasta referenspunkter (vol 15 & vol 50) som
 *  användaren själv kan dra i — motorn interpolerar mellan dem live. */
const AUTO_VOL_LOW = 15;
const AUTO_VOL_HIGH = 50;
const DEFAULT_GAIN_LOW = 15;   // hög gain vid låg volym
const DEFAULT_GAIN_HIGH = 6.5; // låg gain vid hög volym

function GainCalibrationPanel({
  piBase, micGain, setMicGain,
}: {
  piBase: string;
  micGain: number;
  setMicGain: (g: number) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const [gainLow, setGainLow] = useState(DEFAULT_GAIN_LOW);
  const [gainHigh, setGainHigh] = useState(DEFAULT_GAIN_HIGH);
  const [liveSonosVol, setLiveSonosVol] = useState<number | null>(null);
  const [effectiveGain, setEffectiveGain] = useState<number | null>(null);

  // Initial load: hämta sparat läge + cal-punkter
  useEffect(() => {
    Promise.all([
      fetch(`${piBase}/api/auto-gain`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()),
      fetch(`${piBase}/api/gain-calibration`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()),
    ]).then(([ag, cal]) => {
      setEnabled(!!ag.enabled);
      if (ag.multiplier != null) setMultiplier(ag.multiplier);
      if (cal?.point1?.gain != null) setGainLow(cal.point1.gain);
      if (cal?.point2?.gain != null) setGainHigh(cal.point2.gain);
    }).catch(() => {});
  }, [piBase]);

  // Live-poll: aktuell gain + Sonos-volym. Snabbpoll i 5s efter slider-aktivitet.
  const fastPollUntilRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const [statusRes, agRes] = await Promise.all([
          fetch(`${piBase}/api/status`, { signal: AbortSignal.timeout(2000) }),
          fetch(`${piBase}/api/auto-gain`, { signal: AbortSignal.timeout(2000) }),
        ]);
        const status = await statusRes.json();
        const ag = await agRes.json();
        if (!cancelled) {
          if (status.sonos?.volume != null) setLiveSonosVol(status.sonos.volume);
          if (ag.multiplier != null) setMultiplier(ag.multiplier);
          if (ag.effective != null) setEffectiveGain(ag.effective);
        }
      } catch {}
      if (cancelled) return;
      const interval = Date.now() < fastPollUntilRef.current ? 500 : 1500;
      timeoutId = setTimeout(poll, interval);
    };
    poll();
    return () => { cancelled = true; if (timeoutId) clearTimeout(timeoutId); };
  }, [piBase]);

  /** PUT båda kalibreringspunkterna live till motorn när en slider ändras. */
  const pushCalibration = (lowGain: number, highGain: number) => {
    fetch(`${piBase}/api/gain-calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        point1: { vol: AUTO_VOL_LOW, gain: lowGain },
        point2: { vol: AUTO_VOL_HIGH, gain: highGain },
      }),
    }).catch(() => {});
    // Trigga snabbpoll (500ms) i 5s så användaren ser effekten direkt
    fastPollUntilRef.current = Date.now() + 5000;
  };

  const setMode = (auto: boolean) => {
    if (auto === enabled) return;
    setEnabled(auto);
    // Säkerställ kalibreringspunkter finns innan Auto aktiveras
    // (motorn returnerar 1.0× utan punkter).
    if (auto) pushCalibration(gainLow, gainHigh);
    fetch(`${piBase}/api/auto-gain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: auto }),
    }).then(r => r.json()).then(d => {
      if (d.multiplier != null) setMultiplier(d.multiplier);
    }).catch(() => {});
    fastPollUntilRef.current = Date.now() + 5000;
  };

  const onGainLowChange = (g: number) => {
    setGainLow(g);
    pushCalibration(g, gainHigh);
  };
  const onGainHighChange = (g: number) => {
    setGainHigh(g);
    pushCalibration(gainLow, g);
  };

  return (
    <div className="space-y-4">
      {/* Mode selector: Manual ↔ Auto */}
      <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-secondary/40 border border-border">
        <button
          onClick={() => setMode(false)}
          className={`py-2 rounded-lg text-xs font-medium transition-colors ${
            !enabled ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground'
          }`}
        >
          Manuell
        </button>
        <button
          onClick={() => setMode(true)}
          className={`py-2 rounded-lg text-xs font-medium transition-colors ${
            enabled ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground'
          }`}
        >
          Auto (Sonos vol)
        </button>
      </div>

      {/* MANUAL MODE: en slider som direkt styr motor-gain */}
      {!enabled && (
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span>Mic Gain</span>
            <span className="text-muted-foreground font-mono text-xs">{micGain.toFixed(1)}×</span>
          </div>
          <input
            type="range" min={1} max={50} step={1} value={micGain}
            onChange={(e) => setMicGain(parseFloat(e.target.value))}
            className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
          />
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Mjukvaruförstärkning. 1× = rå signal, högre = känsligare.
          </p>
        </div>
      )}

      {/* AUTO MODE: två slidrar (vol 15 & vol 50), motorn interpolerar */}
      {enabled && (
        <div className="space-y-4">
          {/* Live status */}
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Sonos volym</span>
              <span className="font-mono font-bold">{liveSonosVol ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between pt-1.5 border-t border-border/40">
              <span className="text-xs text-muted-foreground">Aktuell mic-gain</span>
              <span className="text-base font-mono font-bold text-primary">
                {effectiveGain != null ? `${effectiveGain.toFixed(1)}×` : `${multiplier.toFixed(1)}×`}
              </span>
            </div>
          </div>

          {/* P1: vid låg volym */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Gain @ vol {AUTO_VOL_LOW}</span>
              <span className="text-muted-foreground font-mono text-xs">{gainLow.toFixed(1)}×</span>
            </div>
            <input
              type="range" min={1} max={50} step={0.5} value={gainLow}
              onChange={(e) => onGainLowChange(parseFloat(e.target.value))}
              className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
            />
          </div>

          {/* P2: vid hög volym */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Gain @ vol {AUTO_VOL_HIGH}</span>
              <span className="text-muted-foreground font-mono text-xs">{gainHigh.toFixed(1)}×</span>
            </div>
            <input
              type="range" min={1} max={50} step={0.5} value={gainHigh}
              onChange={(e) => onGainHighChange(parseFloat(e.target.value))}
              className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
            />
          </div>

          <p className="text-[10px] text-muted-foreground">
            Motorn interpolerar mellan dessa två punkter baserat på Sonos-volymen.
          </p>
        </div>
      )}

      {/* MANUAL MODE: visa vad motorn faktiskt kör */}
      {!enabled && effectiveGain != null && (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground bg-secondary/30 rounded-lg px-3 py-1.5">
          <span>Aktiv i motor:</span>
          <span className="font-mono font-bold text-foreground">{effectiveGain.toFixed(1)}×</span>
        </div>
      )}
    </div>
  );
}


function ConnectionSettingsSection({
  sonosUrl, setSonosUrl,
  micGain, setMicGain,
  idleColor, setIdleColor,
  autoTvMode, setAutoTvMode,
  sonosMode, setSonosMode, sonosLocalDetected,
  piBase,
}: {
  sonosUrl: string; setSonosUrl: (v: string) => void;
  micGain: number; setMicGain: (v: number) => void;
  idleColor: number[]; setIdleColor: (c: number[]) => void;
  autoTvMode: boolean; setAutoTvMode: (v: boolean) => void;
  sonosMode: 'auto' | 'local' | 'extern'; setSonosMode: (v: 'auto' | 'local' | 'extern') => void;
  sonosLocalDetected: { found: boolean; url: string; name: string; version: string | null } | null;
  piBase: string;
}) {
  return (
    <>


      {/* Mikrofon: device hårdkodat till hw:0,0 i state.
          Endast gain-kontrollen (Manual/Auto) exponeras. */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Mic size={14} /> Mic Gain
        </h2>
        <GainCalibrationPanel piBase={piBase} micGain={micGain} setMicGain={setMicGain} />
      </section>

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Sonos Gateway</h2>
        
        {/* Local detected info */}
        {sonosLocalDetected?.found && (
          <div className="mb-3 p-2.5 rounded-lg bg-green-500/10 border border-green-500/20 text-[11px]">
            <div className="flex items-center gap-1.5 text-green-400 font-medium">
              <Check size={12} /> Lokal tjänst hittad: {sonosLocalDetected.name}
              {sonosLocalDetected.version && <span className="text-muted-foreground">v{sonosLocalDetected.version}</span>}
            </div>
          </div>
        )}

        {/* Mode toggle: Local vs Extern */}
        {sonosLocalDetected?.found && (
          <div className="flex gap-1.5 mb-3">
            {(['local', 'extern'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => {
                  setSonosMode(mode);
                  if (mode === 'local' && sonosLocalDetected?.url) setSonosUrl(sonosLocalDetected.url);
                }}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
                  sonosMode === mode
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground'
                }`}
              >
                {mode === 'local' ? '🏠 Lokal' : '🌐 Extern'}
              </button>
            ))}
          </div>
        )}

        {/* URL input — shown for extern mode or when no local detected */}
        {(sonosMode === 'extern' || !sonosLocalDetected?.found) && (
          <input
            type="url" value={sonosUrl} onChange={(e) => setSonosUrl(e.target.value)}
            placeholder="http://192.168.1.x:3053/api/sonos"
            className="w-full bg-secondary text-foreground rounded-lg px-3 py-3 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-ring"
          />
        )}

        {/* Show active URL for local mode */}
        {sonosMode === 'local' && sonosLocalDetected?.found && (
          <div className="text-[10px] text-muted-foreground font-mono bg-secondary/50 rounded-lg px-3 py-2">
            {sonosUrl}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Idle-färg</h2>
        <div className="flex items-center gap-4">
          <div
            className="w-12 h-12 rounded-xl border border-border shrink-0"
            style={{ backgroundColor: `rgb(${idleColor[0]},${idleColor[1]},${idleColor[2]})` }}
          />
          <div className="flex-1 space-y-2">
            {["R", "G", "B"].map((ch, i) => (
              <div key={ch} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-3">{ch}</span>
                <input
                  type="range" min={0} max={255} value={idleColor[i]}
                  onChange={(e) => { const next = [...idleColor]; next[i] = parseInt(e.target.value); setIdleColor(next); }}
                  className="flex-1 h-1.5 rounded-full appearance-none bg-secondary accent-primary"
                />
                <span className="text-xs text-muted-foreground font-mono w-7 text-right">{idleColor[i]}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Auto TV-mode */}
      <section className="mb-8">
        <label className="flex items-center justify-between">
          <div>
            <div className="text-sm">📺 Auto TV-läge</div>
            <p className="text-[10px] text-muted-foreground">Mikrofon-reaktivt ljus när Sonos spelar från TV/SPDIF</p>
          </div>
          <button
            onClick={() => setAutoTvMode(!autoTvMode)}
            className={`w-12 h-7 rounded-full transition-colors relative ${autoTvMode ? 'bg-green-500' : 'bg-secondary border border-border'}`}
          >
            <span className={`absolute top-0.5 w-6 h-6 rounded-full shadow transition-transform ${autoTvMode ? 'left-[22px] bg-foreground' : 'left-0.5 bg-muted-foreground'}`} />
          </button>
        </label>
      </section>
    </>

  );
}

/* BleDiagnosticsPanel borttagen — diagnostik-pipeline + scan/save är inte längre del av flödet. */



const BLE_LATENCY_HISTORY_LEN = 60; // ~3 min at 3s poll

function BleIntervalDiag({ piBase }: { piBase: string }) {
  const [data, setData] = useState<{
    requestedIntervalMs: string;
    actualIntervalMs: string;
    intervalSource: string;
    writeLatAvgMs: number;
    writeLatMs: number;
    effectiveIntervalMs: number;
    sentCount: number;
  } | null>(null);
  const [history, setHistory] = useState<{ t: number; lat: number; eff: number }[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`${piBase}/api/status`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok || cancelled) return;
        const json = await r.json();
        if (!cancelled && json.ble?.stats) {
          const s = json.ble.stats;
          setData(s);
          if (s.writeLatMs > 0) {
            setHistory(prev => {
              const next = [...prev, { t: Date.now(), lat: s.writeLatMs, eff: s.effectiveIntervalMs ?? 0 }];
              return next.length > BLE_LATENCY_HISTORY_LEN ? next.slice(-BLE_LATENCY_HISTORY_LEN) : next;
            });
          }
        }
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [piBase]);

  // Draw latency chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || history.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const pad = { top: 12 * dpr, bottom: 16 * dpr, left: 28 * dpr, right: 8 * dpr };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    // Y-axis: auto-scale with nice ceiling
    const maxLat = Math.max(...history.map(h => h.lat), ...history.map(h => h.eff));
    const yMax = Math.max(15, Math.ceil(maxLat / 5) * 5);

    const toX = (i: number) => pad.left + (i / (BLE_LATENCY_HISTORY_LEN - 1)) * cw;
    const toY = (v: number) => pad.top + ch * (1 - Math.min(v, yMax) / yMax);

    // Grid lines
    const gridSteps = [0, yMax / 2, yMax];
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.font = `${8 * dpr}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'right';
    for (const v of gridSteps) {
      const y = toY(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillText(`${v}`, pad.left - 3 * dpr, y + 3 * dpr);
    }

    // 7.5ms target line
    const targetY = toY(7.5);
    ctx.beginPath();
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.strokeStyle = 'rgba(34,197,94,0.4)';
    ctx.moveTo(pad.left, targetY);
    ctx.lineTo(w - pad.right, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(34,197,94,0.5)';
    ctx.textAlign = 'left';
    ctx.fillText('7.5ms', pad.left + 2 * dpr, targetY - 2 * dpr);

    // Offset so latest data is at right edge
    const offset = BLE_LATENCY_HISTORY_LEN - history.length;

    // Draw effective interval line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5 * dpr;
    for (let i = 0; i < history.length; i++) {
      const x = toX(i + offset);
      const y = toY(history[i].eff);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw write latency line (primary)
    ctx.beginPath();
    ctx.strokeStyle = 'rgb(255,120,50)';
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    for (let i = 0; i < history.length; i++) {
      const x = toX(i + offset);
      const y = toY(history[i].lat);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under latency
    ctx.lineTo(toX(history.length - 1 + offset), pad.top + ch);
    ctx.lineTo(toX(offset), pad.top + ch);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, 'rgba(255,120,50,0.25)');
    grad.addColorStop(1, 'rgba(255,120,50,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // X-axis label
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.textAlign = 'center';
    ctx.font = `${7 * dpr}px sans-serif`;
    ctx.fillText('tid →', w / 2, h - 2 * dpr);
  }, [history]);

  if (!data) return null;

  const isHci = data.intervalSource === 'hci_event';
  const isEst = data.intervalSource === 'estimated';
  const isUnknown = data.intervalSource === 'unknown';

  const statusColor = isHci
    ? 'text-green-400'
    : isEst
    ? 'text-yellow-400'
    : 'text-muted-foreground';

  const statusLabel = isHci
    ? 'HCI bekräftat'
    : isEst
    ? 'Estimerat (latens)'
    : 'Väntar på data…';

  return (
    <div className="bg-secondary/50 rounded-xl p-3">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Bluetooth size={12} /> BLE Connection Interval
      </h3>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">Begärt</div>
          <div className="font-mono font-bold">{data.requestedIntervalMs} ms</div>
        </div>
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">Accepterat</div>
          <div className={`font-mono font-bold ${statusColor}`}>{data.actualIntervalMs} ms</div>
        </div>
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">Snitt skrivlatens</div>
          <div className="font-mono font-bold">{data.writeLatAvgMs?.toFixed(1) ?? '—'} ms</div>
        </div>
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">Effektivt intervall</div>
          <div className="font-mono font-bold">{data.effectiveIntervalMs ?? '—'} ms</div>
        </div>
      </div>

      {/* Latency chart */}
      <div className="mt-3">
        <canvas
          ref={canvasRef}
          className="w-full rounded-lg"
          style={{ height: 100, background: 'rgba(0,0,0,0.3)' }}
        />
        <div className="flex justify-center gap-4 mt-1 text-[9px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 border-t-2" style={{ borderColor: 'rgb(255,120,50)' }} /> Skrivlatens
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 border-t" style={{ borderColor: 'rgba(255,255,255,0.3)' }} /> Eff. intervall
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px]">
        <span className={statusColor}>● {statusLabel}</span>
        <span className="text-muted-foreground">{data.sentCount} paket</span>
      </div>
      {isUnknown && data.sentCount === 0 && (
        <p className="text-[10px] text-muted-foreground mt-1.5">
          Anslut en BLE-enhet och starta musik för att se diagnostik.
        </p>
      )}
    </div>
  );
}



export default function PiMobile() {
  const [activePreset, setActivePreset] = useState<string>("Normal");
  const [idleColor, setIdleColor] = useState([255, 60, 0]);
  // 4 oberoende profiler — varje knapp kommer ihåg sina egna värden.
  // Aktiv profils värden härleds som `cal` och muteras via `setCal`.
  const [profiles, setProfiles] = useState<Record<string, Cal>>({
    Lugn:   { ...PRESET_CALS.Lugn },
    Normal: { ...PRESET_CALS.Normal },
    Party:  { ...PRESET_CALS.Party },
    Custom: { ...PRESET_CALS.Custom },
  });
  const cal = profiles[activePreset] ?? PRESET_CALS.Normal;
  const setCal = useCallback((next: Cal) => {
    setProfiles(p => ({ ...p, [activePreset]: next }));
  }, [activePreset]);
  const [tickMs, setTickMs] = useState(25);
  const [sonosUrl, setSonosUrl] = useState("http://127.0.0.1:3053/api/sonos");
  const [sonosMode, setSonosMode] = useState<'auto' | 'local' | 'extern'>('auto');
  const [sonosLocalDetected, setSonosLocalDetected] = useState<{ found: boolean; url: string; name: string; version: string | null } | null>(null);
  const [alsaDevice, setAlsaDevice] = useState("plughw:0,0");
  const [dimmingGamma, setDimmingGamma] = useState(1.8);
  const [autoTvMode, setAutoTvMode] = useState(false);
  const [micGain, setMicGain] = useState(1.0);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bleEngineReady, setBleEngineReady] = useState(false);
  const [piOnline, setPiOnline] = useState<boolean | null>(null);
  const [engineStatus, setEngineStatus] = useState<{ running: boolean; hz: number; tickMs: number } | null>(null);
  const [sonosPlaying, setSonosPlaying] = useState(false);
  const [sonosState, setSonosState] = useState<string | null>(null);
  const [bleConnected, setBleConnected] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();

  // Direct to engine port (no proxy needed)
  const piBase = apiBase;

  const putJson = async (path: string, body: unknown) => {
    const r = await fetch(`${piBase}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r;
  };

  const handleSave = async () => {
    setSaveError(null);
    try {
      // Konvertera alla 4 profilers attack/softness → attackAlpha/releaseAlpha innan PUT
      const profilesPayload: Record<string, any> = {};
      for (const [name, p] of Object.entries(profiles)) {
        profilesPayload[name] = {
          bassWeight: p.bassWeight,
          attackAlpha: attackToAlpha(p.attack),
          releaseAlpha: softnessToAlpha(p.softness),
          dynamicDamping: p.dynamicDamping,
          brightnessFloor: p.brightnessFloor,
          punchWhiteThreshold: p.punchWhiteThreshold,
          perceptualGamma: p.perceptualGamma,
          transientGain: p.transientGain,
          dynamicsEnabled: p.dynamicsEnabled,
          onsetThreshold: p.onsetThreshold,
          onsetRefractoryMs: p.onsetRefractoryMs,
          onsetEnergyFloor: p.onsetEnergyFloor,
          tickEnergyFloor: p.tickEnergyFloor,
          flickerDeadband: p.flickerDeadband,
          beatSource: p.beatSource,
          dropEnabled: p.dropEnabled,
          dropSensitivity: p.dropSensitivity,
          dropFlashMs: p.dropFlashMs,
        };
      }
      const results = await Promise.allSettled([
        putJson('/api/profiles', { profiles: profilesPayload, activePreset }),
        putJson('/api/tick-ms', { tickMs }),
        putJson('/api/mic-device', { device: alsaDevice }),
        putJson('/api/dimming-gamma', { gamma: dimmingGamma }),
        putJson('/api/idle-color', { color: idleColor }),
        ...(sonosUrl ? [putJson('/api/sonos-gateway', { baseUrl: sonosUrl })] : []),
        putJson('/api/auto-tv-mode', { enabled: autoTvMode }),
        putJson('/api/mic-gain', { gain: micGain }),
      ]);
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        const reasons = failed.map(r => (r as PromiseRejectedResult).reason?.message ?? 'okänt').join(', ');
        console.error('[PiMobile] Partial save failure:', reasons);
        setSaveError(`${failed.length}/${results.length} misslyckades: ${reasons}`);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaveError(null), 6000);
        return;
      }
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      console.error('[PiMobile] Save failed', e);
      setSaveError(e.message ?? 'Kunde inte nå motorn');
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaveError(null), 6000);
    }
  };

  // (handleSave defined above)

  // Load current settings from Pi on mount
  useEffect(() => {
    const load = async () => {
      const safeFetch = (url: string) =>
        fetch(url, { signal: AbortSignal.timeout(3000) })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null);

      const [profilesRes, statusRes, micRes, gammaRes, idleRes, sonosRes, tvModeRes, micGainRes, detectRes] = await Promise.all([
        safeFetch(`${piBase}/api/profiles`),
        safeFetch(`${piBase}/api/status`),
        safeFetch(`${piBase}/api/mic-device`),
        safeFetch(`${piBase}/api/dimming-gamma`),
        safeFetch(`${piBase}/api/idle-color`),
        safeFetch(`${piBase}/api/sonos-gateway`),
        safeFetch(`${piBase}/api/auto-tv-mode`),
        safeFetch(`${piBase}/api/mic-gain`),
        safeFetch(`${piBase}/api/sonos-gateway/detect`),
      ]);

      // Mappa varje profils stored kalibrering tillbaka till UI:ts Cal-form
      // (attackAlpha → attack, releaseAlpha → softness, defaults för saknade fält).
      const mapStoredToCal = (c: any): Cal => {
        const softness = c?.releaseAlpha != null ? alphaToCurve(c.releaseAlpha) : DEFAULT_CAL.softness;
        const attack = c?.attackAlpha != null ? alphaToAttack(c.attackAlpha) : DEFAULT_CAL.attack;
        return {
          bassWeight: c?.bassWeight ?? DEFAULT_CAL.bassWeight,
          attack,
          softness,
          dynamicDamping: c?.dynamicDamping ?? DEFAULT_CAL.dynamicDamping,
          brightnessFloor: c?.brightnessFloor ?? DEFAULT_CAL.brightnessFloor,
          punchWhiteThreshold: c?.punchWhiteThreshold ?? DEFAULT_CAL.punchWhiteThreshold,
          perceptualGamma: c?.perceptualGamma ?? (typeof c?.perceptualCurve === 'boolean' ? (c.perceptualCurve ? 1.8 : 0) : DEFAULT_CAL.perceptualGamma),
          transientGain: c?.transientGain ?? (typeof c?.transientBoost === 'boolean' ? (c.transientBoost ? 1.0 : 0) : DEFAULT_CAL.transientGain),
          dynamicsEnabled: c?.dynamicsEnabled ?? DEFAULT_CAL.dynamicsEnabled,
          onsetThreshold: c?.onsetThreshold ?? DEFAULT_CAL.onsetThreshold,
          onsetRefractoryMs: c?.onsetRefractoryMs ?? DEFAULT_CAL.onsetRefractoryMs,
          onsetEnergyFloor: c?.onsetEnergyFloor ?? DEFAULT_CAL.onsetEnergyFloor,
          tickEnergyFloor: c?.tickEnergyFloor ?? DEFAULT_CAL.tickEnergyFloor,
          flickerDeadband: c?.flickerDeadband ?? DEFAULT_CAL.flickerDeadband,
          beatSource: c?.beatSource ?? DEFAULT_CAL.beatSource,
          dropEnabled: c?.dropEnabled ?? DEFAULT_CAL.dropEnabled,
          dropSensitivity: c?.dropSensitivity ?? DEFAULT_CAL.dropSensitivity,
          dropFlashMs: c?.dropFlashMs ?? DEFAULT_CAL.dropFlashMs,
        };
      };

      if (profilesRes?.profiles && typeof profilesRes.profiles === 'object') {
        const next: Record<string, Cal> = {
          Lugn:   mapStoredToCal(profilesRes.profiles.Lugn   ?? {}),
          Normal: mapStoredToCal(profilesRes.profiles.Normal ?? {}),
          Party:  mapStoredToCal(profilesRes.profiles.Party  ?? {}),
          Custom: mapStoredToCal(profilesRes.profiles.Custom ?? {}),
        };
        setProfiles(next);
        if (profilesRes.activePreset) setActivePreset(profilesRes.activePreset);
      }
      if (micRes?.device) setAlsaDevice(micRes.device);
      if (gammaRes?.gamma != null) setDimmingGamma(gammaRes.gamma);
      if (statusRes?.engine?.tickMs) setTickMs(statusRes.engine.tickMs);
      if (Array.isArray(idleRes) && idleRes.length === 3) setIdleColor(idleRes);
      if (tvModeRes?.enabled != null) setAutoTvMode(tvModeRes.enabled);
      if (micGainRes?.gain != null) setMicGain(micGainRes.gain);

      // Sonos gateway: detect local service or fall back to saved/extern
      if (detectRes?.found) {
        setSonosLocalDetected(detectRes);
        // If saved URL matches local default, use local mode
        const savedUrl = sonosRes?.active?.baseUrl ?? sonosRes?.saved?.baseUrl ?? '';
        const isLocal = !savedUrl || savedUrl.includes('127.0.0.1:3053');
        setSonosMode(isLocal ? 'local' : 'extern');
        if (isLocal) {
          setSonosUrl(detectRes.url);
        } else {
          setSonosUrl(savedUrl);
        }
      } else {
        setSonosLocalDetected(detectRes ?? { found: false, url: '', name: '', version: null });
        setSonosMode('extern');
        if (sonosRes?.active?.baseUrl) setSonosUrl(sonosRes.active.baseUrl);
        else if (sonosRes?.saved?.baseUrl) setSonosUrl(sonosRes.saved.baseUrl);
      }

    };
    load();
  }, []);

  // Poll status every 5s to get live track, BLE count, palette
  const lastTrackRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`${piBase}/api/status`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok || cancelled) return;
        const data = await r.json();
        if (cancelled) return;
        setPiOnline(true);
        if (data.engine) setEngineStatus({ running: data.engine.running, hz: data.engine.hz, tickMs: data.engine.tickMs });
        setSonosPlaying(typeof data.sonos?.playbackState === 'string' && data.sonos.playbackState.includes('PLAYING'));
        setSonosState(typeof data.sonos?.playbackState === 'string' ? data.sonos.playbackState : null);
        setBleConnected(!!data.ble?.connected);

      } catch {
        if (!cancelled) setPiOnline(false);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [piBase]);


  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto" style={{ fontFamily: PI_FONT }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
          <span className="text-sm font-semibold">BLE Light</span>
        </div>
        <button
          onClick={handleSave}
          disabled={!piOnline}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all active:scale-95 disabled:opacity-30 disabled:pointer-events-none ${
            saved ? "text-green-500" : "text-primary"
          }`}
          title="Spara inställningar"
        >
          {saved ? <Check size={16} /> : <Save size={16} />}
          {saved ? "Sparat" : "Spara"}
        </button>
      </div>


      {/* Permissions self-check — varnar om PCC hoppade över setup-lotus.sh */}
      <PermissionsBanner piBase={piBase} />

      {/* En knapp kör Motor → Mic → Sonos → Lampa i sekvens */}
      <StartAllPanel
        piBase={piBase}
        onEngineReadyChange={setBleEngineReady}
      />

      {(() => {
        const ready = piOnline === true && engineStatus?.running === true;
        return (
          <div className={!ready ? "opacity-50 pointer-events-none select-none" : undefined} aria-disabled={!ready}>
            {!ready && (
              <div className="my-4 rounded-xl border border-border bg-card/40 p-4 text-center text-xs text-muted-foreground pointer-events-none">
                Väntar på motor och frontend… (visas inaktiverat)
              </div>
            )}

            {saveError && (
              <div className="mb-4 mt-4 p-3 rounded-lg bg-destructive/20 border border-destructive/40 text-destructive text-xs">
                ⚠ Sparning misslyckades: {saveError}
              </div>
            )}

            {/* Anslut: Sonos + mic-kalibrering + idle-färg + auto-TV */}
            <section className="mb-8 mt-4">
              <ConnectionSettingsSection
                sonosUrl={sonosUrl} setSonosUrl={setSonosUrl}
                micGain={micGain} setMicGain={setMicGain}
                idleColor={idleColor} setIdleColor={setIdleColor}
                autoTvMode={autoTvMode} setAutoTvMode={setAutoTvMode}
                sonosMode={sonosMode} setSonosMode={setSonosMode} sonosLocalDetected={sonosLocalDetected}
                piBase={piBase}
              />
            </section>




          </div>
        );
      })()}



      {/* Minimal status: Sonos + Lampa */}
      <div className="mt-6 mb-4 text-[10px] text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${
              sonosPlaying ? 'bg-green-500'
                : sonosState ? 'bg-amber-500'
                : piOnline === false ? 'bg-destructive'
                : 'bg-muted-foreground animate-pulse'
            }`} />
            <span>Sonos {sonosPlaying ? 'Spelar' : sonosState ? 'Pausad' : 'Av'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${
              bleConnected ? 'bg-green-500'
                : piOnline === false ? 'bg-destructive'
                : 'bg-muted-foreground animate-pulse'
            }`} />
            <span>Lampa {bleConnected ? 'Ansluten' : 'Ej ansluten'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}