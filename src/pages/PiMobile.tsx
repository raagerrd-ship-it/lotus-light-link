import { useState, useRef, useEffect, useCallback } from "react";
import { Settings, ArrowLeft, Bluetooth, Music, Save, Check, Mic, Lightbulb, Zap, Search, X, Loader2, Activity, Download, Timer } from "lucide-react";
import { apiBase } from "@/lib/apiBase";

const PI_FONT = '"Noto Sans", "DejaVu Sans", "Liberation Sans", system-ui, sans-serif';

const PRESETS = ["Lugn", "Normal", "Party", "Custom"] as const;

type PaletteMode = 'off' | 'timed' | 'bass' | 'energy' | 'blend';
const PALETTE_MODES: { value: PaletteMode; label: string }[] = [
  { value: 'off', label: 'Av' },
  { value: 'timed', label: 'Tid' },
  { value: 'bass', label: 'Bas' },
  { value: 'energy', label: 'Energi' },
  { value: 'blend', label: 'Blend' },
];

type Cal = { bassWeight: number; softness: number; dynamicDamping: number; brightnessFloor: number; punchWhiteThreshold: number; paletteMode: PaletteMode; perceptualCurve: boolean; transientBoost: boolean; agcEnabled: boolean; dynamicsEnabled: boolean };

const PRESET_CALS: Record<string, Cal> = {
  Lugn:   { bassWeight: 0.7, softness: 75, dynamicDamping: -1.5, brightnessFloor: 8, punchWhiteThreshold: 100, paletteMode: 'off', perceptualCurve: true, transientBoost: true, agcEnabled: true, dynamicsEnabled: true },
  Normal: { bassWeight: 0.5, softness: 30, dynamicDamping: 1.0,  brightnessFloor: 0, punchWhiteThreshold: 97,  paletteMode: 'blend', perceptualCurve: false, transientBoost: true, agcEnabled: true, dynamicsEnabled: true },
  Party:  { bassWeight: 0.3, softness: 5,  dynamicDamping: 1.5,  brightnessFloor: 0, punchWhiteThreshold: 93,  paletteMode: 'bass', perceptualCurve: false, transientBoost: true, agcEnabled: true, dynamicsEnabled: true },
  Custom: { bassWeight: 0.5, softness: 0,  dynamicDamping: 0,    brightnessFloor: 0, punchWhiteThreshold: 100, paletteMode: 'off', perceptualCurve: false, transientBoost: true, agcEnabled: true, dynamicsEnabled: true },
};

const DEFAULT_CAL = PRESET_CALS.Normal;

/** Convert Softness 0-100 → releaseAlpha only (no extra smoothing filter) */
function softnessToParams(s: number) {
  const t = s / 100;
  const releaseAlpha = 1.0 - 0.995 * Math.pow(t, 0.7);
  return { releaseAlpha: Math.max(0.005, Math.round(releaseAlpha * 1000) / 1000), smoothing: 0 };
}

type NumericCalKey = 'bassWeight' | 'softness' | 'dynamicDamping' | 'brightnessFloor' | 'punchWhiteThreshold';
const SLIDER_CONFIG: { key: NumericCalKey; label: string; min: number; max: number; step: number; unit?: string; description: string }[] = [
  { key: "bassWeight", label: "Bas ↔ Disk", min: 0, max: 1, step: 0.05, description: "0 = diskant, 0.5 = lika, 1.0 = bas" },
  { key: "softness", label: "Mjukhet", min: 0, max: 100, step: 1, description: "0 = rått, 100 = mycket mjukt" },
  { key: "dynamicDamping", label: "Dynamik", min: -3, max: 2, step: 0.1, unit: "×", description: "Positivt = kontrast, negativt = utjämnad" },
  { key: "brightnessFloor", label: "Golv", min: 0, max: 25, step: 1, unit: "%", description: "Lägsta ljusstyrka" },
  { key: "punchWhiteThreshold", label: "Punch White", min: 90, max: 100, step: 0.5, unit: "%", description: "100 = av. Över detta → vit" },
];

const CURVE_POINTS = 200; // points to draw

/** Pre-compute a 3-wave sinus: low → mid → high amplitude */
function buildRawCurve(): number[] {
  const pts: number[] = [];
  const third = CURVE_POINTS / 3;
  for (let i = 0; i < CURVE_POINTS; i++) {
    const t = i / CURVE_POINTS;
    // Which wave section (0=low, 1=mid, 2=high)
    const section = Math.min(2, Math.floor(i / third));
    const amp = [0.2, 0.5, 0.9][section];
    const freq = 6 * Math.PI; // ~3 full waves per section
    const val = 0.5 + amp * 0.5 * Math.sin(t * freq);
    pts.push(Math.max(0, Math.min(1, val)));
  }
  return pts;
}

const RAW_CURVE = buildRawCurve();

/** Apply calibration to a raw curve and return processed curve */
/** Real applyDynamics — mirrors src/lib/engine/brightnessEngine.ts */
function applyDynamics(energyNorm: number, center: number, dynamicDamping: number): number {
  let result = energyNorm;
  if (dynamicDamping > 0) {
    const amount = Math.min(1, dynamicDamping / 2);
    const exponent = 1 / (1 + amount * 4);
    const range = result >= center ? (1 - center) || 0.5 : center || 0.5;
    const normalized = (result - center) / range;
    const expanded = Math.sign(normalized) * Math.pow(Math.abs(normalized), exponent);
    const gain = 1 + amount * 0.5;
    result = center + expanded * range * gain;
    const ceiling = 1 + amount * 0.4;
    if (result > ceiling) result = ceiling + (result - ceiling) * 0.2;
  } else if (dynamicDamping < 0) {
    const amount = Math.min(1, Math.abs(dynamicDamping) / 3);
    const compression = 1 / (1 + amount * 4);
    result = center + (result - center) * compression;
  }
  return Math.max(0, result);
}

function processCurve(raw: number[], cal: typeof DEFAULT_CAL): number[] {
  const { releaseAlpha, smoothing } = softnessToParams(cal.softness);
  const attackAlpha = 1.0;
  const out: number[] = [];
  let prev = raw[0];
  let dynamicCenter = 0.5;
  let extraSm = raw[0];

  // Onset detection state (mirrors onsetDetector.ts)
  const onsetBufLen = 7;
  const fluxBuf: number[] = new Array(onsetBufLen).fill(0);
  let fluxIdx = 0;
  let prevFlux = 0;
  let onsetBoost = 0;
  const tickMs = 25; // simulated tick rate

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const alpha = r > prev ? attackAlpha : releaseAlpha;
    let val = prev + alpha * (r - prev);

    // Real dynamics processing with adaptive center
    dynamicCenter += (val - dynamicCenter) * 0.002;
    val = applyDynamics(val, dynamicCenter, cal.dynamicDamping);

    // Smoothing
    if (smoothing > 0) {
      const k = Math.exp(-smoothing * 0.04);
      extraSm = extraSm + k * (val - extraSm);
      val = extraSm;
    }

    // Onset detection: simulate spectral flux from signal derivative
    if (cal.transientBoost) {
      const flux = Math.max(0, r - (i > 0 ? raw[i - 1] : r));
      fluxBuf[fluxIdx % onsetBufLen] = flux;
      fluxIdx++;
      // Median threshold
      const sorted = fluxBuf.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const threshold = median * 1.5 + 0.005;
      const isOnset = flux > threshold && flux >= prevFlux;
      prevFlux = flux;
      // Exponential decay
      onsetBoost *= Math.pow(0.10, tickMs / 1000);
      if (isOnset) onsetBoost = 0.20;
      val = val * (1 + onsetBoost);
    }

    // Floor
    const floor = cal.brightnessFloor / 100;
    val = Math.max(val, floor);

    // Perceptual curve (mirrors piEngine.ts)
    if (cal.perceptualCurve && val > floor && val < 1) {
      const gamma = 1.8; // matches default dimmingGamma
      const norm = (val - floor) / (1 - floor);
      val = floor + Math.pow(Math.max(0, norm), gamma) * (1 - floor);
    }

    val = Math.max(0, val);
    prev = Math.max(0, Math.min(1, val));
    out.push(val);
  }
  return out;
}

/* ── Signal Preview — static sinus canvas ── */
function SignalPreview({ cal, height = 90, showLegend = true }: { cal: typeof DEFAULT_CAL; height?: number; showLegend?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const pad = 4 * dpr;
    const ch = h - pad * 2;
    ctx.clearRect(0, 0, w, h);

    const processed = processCurve(RAW_CURVE, cal);
    const step = w / (CURVE_POINTS - 1);

    const procMax = Math.max(1, ...processed);
    const showBoost = procMax > 1.02;
    const yMax = showBoost ? Math.max(1.35, Math.ceil(procMax * 10) / 10) : 1;
    const toY = (v: number) => pad + ch * (1 - Math.min(v, yMax) / yMax);

    // Section labels
    const labels = ["Låg", "Mellan", "Hög"];
    const third = w / 3;
    ctx.font = `${10 * dpr}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    for (let s = 0; s < 3; s++) {
      ctx.fillText(labels[s], third * s + third / 2, h - 2 * dpr);
      if (s > 0) {
        ctx.beginPath();
        ctx.moveTo(third * s, 0);
        ctx.lineTo(third * s, h);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // 100% reference line + boost band
    if (showBoost) {
      const refY = toY(1);
      ctx.fillStyle = "rgba(255,120,50,0.08)";
      ctx.fillRect(0, pad, w, Math.max(0, refY - pad));

      ctx.beginPath();
      ctx.moveTo(0, refY);
      ctx.lineTo(w, refY);
      ctx.strokeStyle = "rgba(255,255,255,0.24)";
      ctx.setLineDash([2 * dpr, 4 * dpr]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.textAlign = "right";
      ctx.font = `${8 * dpr}px sans-serif`;
      ctx.fillText("100%", w - 2 * dpr, refY - 2 * dpr);

      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(255,120,50,0.9)";
      ctx.fillText(`${Math.round(procMax * 100)}% peak`, 4 * dpr, pad + 9 * dpr);
    }

    // Raw curve (dashed)
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    for (let i = 0; i < CURVE_POINTS; i++) {
      const x = i * step;
      i === 0 ? ctx.moveTo(x, toY(RAW_CURVE[i])) : ctx.lineTo(x, toY(RAW_CURVE[i]));
    }
    ctx.stroke();
    ctx.restore();

    // Processed curve (solid + fill)
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgb(255,120,50)";
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < CURVE_POINTS; i++) {
      const x = i * step;
      i === 0 ? ctx.moveTo(x, toY(processed[i])) : ctx.lineTo(x, toY(processed[i]));
    }
    ctx.stroke();

    // Fill under processed
    const grad = ctx.createLinearGradient(0, pad, 0, pad + ch);
    grad.addColorStop(0, "rgba(255,120,50,0.4)");
    grad.addColorStop(1, "rgba(255,120,50,0)");
    ctx.lineTo((CURVE_POINTS - 1) * step, pad + ch);
    ctx.lineTo(0, pad + ch);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }, [cal]);

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="w-full rounded-lg"
        style={{ height, background: "rgba(0,0,0,0.3)" }}
      />
      {showLegend && (
        <div className="flex justify-center gap-4 mt-1.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t border-dashed" style={{ borderColor: "rgba(255,255,255,0.4)" }} /> Rå signal
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t-2" style={{ borderColor: "rgb(255,120,50)" }} /> Bearbetad
          </span>
        </div>
      )}
    </div>
  );
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
function ProfileSettingsView({
  cal, setCal, activePreset,
  onBack, onSave, saved, saveError,
}: {
  cal: typeof DEFAULT_CAL; setCal: (c: typeof DEFAULT_CAL) => void;
  activePreset: string;
  onBack: () => void; onSave: () => void; saved: boolean; saveError?: string | null;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto" style={{ fontFamily: PI_FONT }}>
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-2 text-muted-foreground active:text-foreground">
          <ArrowLeft size={20} />
        </button>
        <span className="text-sm font-semibold bg-accent text-accent-foreground px-3 py-1 rounded-full">{activePreset}</span>
        <button
          onClick={onSave}
          className={`p-2 rounded-lg transition-all active:scale-95 ${
            saved ? "text-green-500" : "text-primary"
          }`}
        >
          {saved ? <Check size={20} /> : <Save size={20} />}
        </button>
      </div>
      {saveError && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/20 border border-destructive/40 text-destructive text-xs">
          ⚠ Sparning misslyckades: {saveError}
        </div>
      )}

      <section className="space-y-5 mb-8">
        
        <SignalPreview cal={cal} height={180} showLegend={false} />
        
        {SLIDER_CONFIG.map(({ key, label, min, max, step, unit, description }) => (
          <div key={key}>
            <div className="flex justify-between text-sm mb-0.5">
              <span>{label}</span>
              <span className="text-muted-foreground font-mono text-xs">{cal[key]}{unit ?? ''}</span>
            </div>
            <input
              type="range" min={min} max={max} step={step} value={cal[key]}
              onChange={(e) => setCal({ ...cal, [key]: parseFloat(e.target.value) })}
              className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
          </div>
        ))}

        {/* Palette mode */}
        <div>
          <div className="text-sm mb-2">Palettläge</div>
          <div className="flex gap-1.5 flex-wrap">
            {PALETTE_MODES.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setCal({ ...cal, paletteMode: value })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all active:scale-95 ${
                  cal.paletteMode === value
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground"
                }`}
              >{label}</button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">Hur färgen roterar genom albumpalett</p>
        </div>

        {/* Toggles */}
        <div className="space-y-3">
          {([
            { key: 'agcEnabled' as const, label: 'AGC', desc: 'Enkel peak-normalisering av insignalen' },
            { key: 'dynamicsEnabled' as const, label: 'Dynamik', desc: 'Expanderar/komprimerar signalen' },
            
          ]).map(({ key, label, desc }) => (
            <label key={key} className="flex items-center justify-between">
              <div>
                <div className="text-sm">{label}</div>
                <p className="text-[10px] text-muted-foreground">{desc}</p>
              </div>
              <button
                onClick={() => setCal({ ...cal, [key]: !cal[key] })}
                className={`w-12 h-7 rounded-full transition-colors relative ${cal[key] ? 'bg-green-500' : 'bg-secondary border border-border'}`}
              >
                <span className={`absolute top-0.5 w-6 h-6 rounded-full shadow transition-transform ${cal[key] ? 'left-[22px] bg-foreground' : 'left-0.5 bg-muted-foreground'}`} />
              </button>
            </label>
          ))}
          <label className="flex items-center justify-between">
            <div>
              <div className="text-sm">Perceptuell kurva</div>
              <p className="text-[10px] text-muted-foreground">Anpassar ljusstyrka till ögats uppfattning</p>
            </div>
            <button
              onClick={() => setCal({ ...cal, perceptualCurve: !cal.perceptualCurve })}
              className={`w-12 h-7 rounded-full transition-colors relative ${cal.perceptualCurve ? 'bg-green-500' : 'bg-secondary border border-border'}`}
            >
              <span className={`absolute top-0.5 w-6 h-6 rounded-full shadow transition-transform ${cal.perceptualCurve ? 'left-[22px] bg-foreground' : 'left-0.5 bg-muted-foreground'}`} />
            </button>
          </label>
          <label className="flex items-center justify-between">
            <div>
              <div className="text-sm">Transient boost</div>
              <p className="text-[10px] text-muted-foreground">Extra lyft vid trumslag och attacker</p>
            </div>
            <button
              onClick={() => setCal({ ...cal, transientBoost: !cal.transientBoost })}
              className={`w-12 h-7 rounded-full transition-colors relative ${cal.transientBoost ? 'bg-green-500' : 'bg-secondary border border-border'}`}
            >
              <span className={`absolute top-0.5 w-6 h-6 rounded-full shadow transition-transform ${cal.transientBoost ? 'left-[22px] bg-foreground' : 'left-0.5 bg-muted-foreground'}`} />
            </button>
          </label>
        </div>
      </section>
    </div>
  );
}


/* ── Two-point gain calibration + auto-gain toggle ── */
function GainCalibrationPanel({ piBase }: { piBase: string }) {
  const [enabled, setEnabled] = useState(true);
  const [multiplier, setMultiplier] = useState(1);
  const [calPoints, setCalPoints] = useState<{ point1: any; point2: any }>({ point1: null, point2: null });
  const [calStep, setCalStep] = useState<0 | 1 | 2 | 3>(0); // 0=idle, 1=step1, 2=step2, 3=done
  const [sonosVol, setSonosVol] = useState<number | null>(null);
  const [tempGain, setTempGain] = useState(15);
  const [outputPct, setOutputPct] = useState(0);

  // Load initial state
  useEffect(() => {
    Promise.all([
      fetch(`${piBase}/api/auto-gain`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()),
      fetch(`${piBase}/api/gain-calibration`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()),
    ]).then(([ag, cal]) => {
      setEnabled(ag.enabled);
      setMultiplier(ag.multiplier);
      setCalPoints(cal);
    }).catch(() => {});
  }, [piBase]);

  // Enable/disable raw mode when entering/leaving calibration
  useEffect(() => {
    if (calStep > 0 && calStep < 3) {
      fetch(`${piBase}/api/raw-mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }).catch(() => {});
    }
    return () => {
      // Disable raw mode on unmount or step change to 0/3
      if (calStep > 0 && calStep < 3) {
        fetch(`${piBase}/api/raw-mode`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        }).catch(() => {});
      }
    };
  }, [piBase, calStep]);

  // Poll Sonos volume + output level during calibration
  useEffect(() => {
    if (calStep === 0) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [statusRes, diagRes] = await Promise.all([
          fetch(`${piBase}/api/status`, { signal: AbortSignal.timeout(2000) }),
          fetch(`${piBase}/api/diagnostics`, { signal: AbortSignal.timeout(2000) }),
        ]);
        const status = await statusRes.json();
        const diag = await diagRes.json();
        if (!cancelled) {
          if (status.sonos?.volume != null) setSonosVol(status.sonos.volume);
          if (diag.pipeline?.brightnessPct != null) setOutputPct(diag.pipeline.brightnessPct);
        }
      } catch {}
    };
    poll();
    const id = setInterval(poll, 200);
    return () => { cancelled = true; clearInterval(id); };
  }, [piBase, calStep]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    fetch(`${piBase}/api/auto-gain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    }).then(r => r.json()).then(d => setMultiplier(d.multiplier)).catch(() => {});
  };

  const startCalibration = () => {
    setCalStep(1);
    fetch(`${piBase}/api/mic-gain`, { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then(d => setTempGain(d.gain ?? 15))
      .catch(() => {});
  };

  const exitCalibration = () => {
    // Disable raw mode before leaving
    fetch(`${piBase}/api/raw-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => {});
    setCalStep(0);
  };

  const savePoint = (pointNum: 1 | 2) => {
    if (sonosVol == null) return;
    const point = { vol: sonosVol, gain: tempGain };
    const updated = pointNum === 1
      ? { point1: point, point2: calPoints.point2 }
      : { point1: calPoints.point1, point2: point };
    setCalPoints(updated);

    if (pointNum === 1) {
      setCalStep(2);
    } else {
      fetch(`${piBase}/api/gain-calibration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      }).then(() => {
        // Disable raw mode
        fetch(`${piBase}/api/raw-mode`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        }).catch(() => {});
        setCalStep(3);
        setTimeout(() => setCalStep(0), 2000);
      }).catch(() => {});
    }
  };

  const applyTempGain = (gain: number) => {
    setTempGain(gain);
    fetch(`${piBase}/api/mic-gain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gain }),
    }).catch(() => {});
  };

  const clearCalibration = () => {
    fetch(`${piBase}/api/gain-calibration`, { method: 'DELETE' }).catch(() => {});
    setCalPoints({ point1: null, point2: null });
  };

  const hasCalibration = calPoints.point1 && calPoints.point2;

  // Calibration wizard UI
  if (calStep > 0 && calStep < 3) {
    const stepNum = calStep;
    const stepLabel = stepNum === 1 ? 'Låg volym' : 'Hög volym';
    const stepDesc = stepNum === 1
      ? 'Spela en låt med höga partier på låg volym (t.ex. 10–20). Justera gain tills output når nära 100% på de starkaste partierna.'
      : 'Samma låt/parti på hög volym (t.ex. 35–50). Justera gain tills output når nära 100% igen.';

    // Color the bar based on level
    const barColor = outputPct > 90 ? 'bg-red-500' : outputPct > 60 ? 'bg-yellow-500' : outputPct > 20 ? 'bg-green-500' : 'bg-muted-foreground';

    return (
      <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-primary">Kalibrering — Steg {stepNum}/2: {stepLabel}</span>
          <button onClick={exitCalibration} className="text-[10px] text-muted-foreground underline">Avbryt</button>
        </div>
        <p className="text-[10px] text-muted-foreground">{stepDesc}</p>

        {/* Output bar */}
        <div>
          <div className="flex justify-between text-[10px] mb-1">
            <span className="text-muted-foreground">Output (rå mic)</span>
            <span className="font-mono font-bold">{outputPct}%</span>
          </div>
          <div className="w-full h-3 rounded-full bg-secondary overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-150 ${barColor}`}
              style={{ width: `${Math.min(100, outputPct)}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 bg-secondary/50 rounded-lg px-3 py-2">
          <span className="text-xs text-muted-foreground w-16">Sonos vol:</span>
          <span className="text-sm font-mono font-bold">{sonosVol ?? '—'}</span>
        </div>

        <div>
          <div className="flex justify-between text-xs mb-1">
            <span>Mic Gain</span>
            <span className="text-muted-foreground font-mono">{tempGain.toFixed(1)}×</span>
          </div>
          <input
            type="range" min={1} max={50} step={0.5} value={tempGain}
            onChange={(e) => applyTempGain(parseFloat(e.target.value))}
            className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
          />
        </div>

        <button
          onClick={() => savePoint(stepNum as 1 | 2)}
          disabled={sonosVol == null}
          className="w-full py-2.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground active:scale-[0.98] transition-transform disabled:opacity-40"
        >
          {stepNum === 1 ? 'Spara punkt 1 → Nästa' : 'Spara punkt 2 → Klar'}
        </button>
      </div>
    );
  }

  if (calStep === 3) {
    return (
      <div className="mt-4 rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-center">
        <Check size={20} className="mx-auto text-green-500 mb-1" />
        <p className="text-sm font-medium text-green-500">Kalibrering sparad!</p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {/* Auto-gain toggle */}
      <label className="flex items-center justify-between">
        <div>
          <div className="text-sm">Auto-gain (Sonos vol)</div>
          <p className="text-[10px] text-muted-foreground">Justerar mic-gain efter Sonos-volym ({multiplier.toFixed(1)}×)</p>
        </div>
        <button
          onClick={toggle}
          className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-green-500' : 'bg-secondary border border-border'}`}
        >
          <span className={`absolute top-0.5 w-6 h-6 rounded-full shadow transition-transform ${enabled ? 'left-[22px] bg-foreground' : 'left-0.5 bg-muted-foreground'}`} />
        </button>
      </label>

      {/* Calibration status & button */}
      {hasCalibration ? (
        <div className="flex items-center justify-between text-[10px] text-muted-foreground bg-secondary/40 rounded-lg px-3 py-2">
          <div>
            <span className="font-mono">P1: vol {calPoints.point1.vol} → {calPoints.point1.gain.toFixed(1)}×</span>
            <span className="mx-2">|</span>
            <span className="font-mono">P2: vol {calPoints.point2.vol} → {calPoints.point2.gain.toFixed(1)}×</span>
          </div>
          <button onClick={clearCalibration} className="text-destructive underline ml-2">Rensa</button>
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">Ingen kalibrering — använder standardkurva</p>
      )}

      <button
        onClick={startCalibration}
        className="w-full py-2 rounded-lg text-xs font-medium border border-border bg-secondary/50 active:scale-[0.98] transition-transform"
      >
        {hasCalibration ? 'Kalibrera om' : 'Kalibrera gain'}
      </button>
    </div>
  );
}

/* ── Global Settings View (motor, mic, sonos, BLE test) ── */
function GlobalSettingsView({
  tickMs, setTickMs,
  sonosUrl, setSonosUrl, alsaDevice, setAlsaDevice,
  dimmingGamma, setDimmingGamma,
  micGain, setMicGain,
  idleColor, setIdleColor,
  autoTvMode, setAutoTvMode,
  sonosMode, setSonosMode, sonosLocalDetected,
  piBase,
  onBack, onSave, saved, saveError,
}: {
  tickMs: number; setTickMs: (v: number) => void;
  sonosUrl: string; setSonosUrl: (v: string) => void;
  alsaDevice: string; setAlsaDevice: (v: string) => void;
  dimmingGamma: number; setDimmingGamma: (v: number) => void;
  micGain: number; setMicGain: (v: number) => void;
  idleColor: number[]; setIdleColor: (c: number[]) => void;
  autoTvMode: boolean; setAutoTvMode: (v: boolean) => void;
  sonosMode: 'auto' | 'local' | 'extern'; setSonosMode: (v: 'auto' | 'local' | 'extern') => void;
  sonosLocalDetected: { found: boolean; url: string; name: string; version: string | null } | null;
  piBase: string;
  onBack: () => void; onSave: () => void; saved: boolean; saveError?: string | null;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto" style={{ fontFamily: PI_FONT }}>
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-2 text-muted-foreground active:text-foreground">
          <ArrowLeft size={20} />
        </button>
        <span className="text-sm font-semibold bg-accent text-accent-foreground px-3 py-1 rounded-full">Inställningar</span>
        <button
          onClick={onSave}
          className={`p-2 rounded-lg transition-all active:scale-95 ${
            saved ? "text-green-500" : "text-primary"
          }`}
        >
          {saved ? <Check size={20} /> : <Save size={20} />}
        </button>
      </div>
      {saveError && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/20 border border-destructive/40 text-destructive text-xs">
          ⚠ Sparning misslyckades: {saveError}
        </div>
      )}

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Motor</h2>
        <div className="flex justify-between text-sm mb-1">
          <span>Tick rate</span>
          <span className="text-muted-foreground font-mono text-xs">{tickMs} ms</span>
        </div>
        <input
          type="range" min={10} max={50} step={1} value={tickMs}
          onChange={(e) => setTickMs(parseInt(e.target.value))}
          className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
        />

        <div className="flex justify-between text-sm mb-1 mt-5">
          <span>Dimming gamma</span>
          <span className="text-muted-foreground font-mono text-xs">{dimmingGamma.toFixed(1)}</span>
        </div>
        <input
          type="range" min={1.0} max={3.0} step={0.1} value={dimmingGamma}
          onChange={(e) => setDimmingGamma(parseFloat(e.target.value))}
          className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
        />
        <p className="text-[10px] text-muted-foreground mt-0.5">Lägre = mer ljus vid låga nivåer, högre = mer kontrast</p>

        {/* BLE Fade Test */}
        <BleFadeTest piBase={piBase} onResult={(wps) => { const ms = Math.round(1000 / wps); setTickMs(ms); }} />
      </section>

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Mic size={14} /> Mikrofon
        </h2>
        <input
          type="text" value={alsaDevice} onChange={(e) => setAlsaDevice(e.target.value)}
          placeholder="plughw:0,0"
          className="w-full bg-secondary text-foreground rounded-lg px-3 py-3 text-sm font-mono border border-border focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <p className="text-[10px] text-muted-foreground mt-1">ALSA-enhet. Vanligtvis plughw:0,0 eller plughw:1,0.</p>

        <div className="flex justify-between text-sm mb-1 mt-5">
          <span>Mic Gain</span>
          <span className="text-muted-foreground font-mono text-xs">{micGain.toFixed(1)}×</span>
        </div>
        <input
          type="range" min={1} max={50} step={1} value={micGain}
          onChange={(e) => setMicGain(parseFloat(e.target.value))}
          className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
        />
        <p className="text-[10px] text-muted-foreground mt-0.5">Mjukvaruförstärkning av mikrofonsignal. 1× = rå signal, högre = känsligare.</p>

        {/* Auto-gain toggle */}
        <GainCalibrationPanel piBase={piBase} />
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

    </div>
  );
}

/* ── BLE Adapter Diagnostics Panel ── */
function BleDiagnosticsPanel({ piBase }: { piBase: string }) {
  const [diag, setDiag] = useState<{
    adapter: { state: string; hciReleased: boolean; hasCaps: boolean; mode: string };
    stats: {
      connected: number; savedDevice: string | null; savedDeviceId: string | null;
      connectedDeviceId: string | null; demand: boolean; scanning: boolean;
      sentCount: number; writeFailCount: number; disconnectCount: number;
      reconnectCount: number; lastDisconnectReason: string | null; lastDisconnectAt: string | null;
    };
    events: { type: string; device?: string; detail?: string; timestamp: string; durationMs?: number }[];
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${piBase}/api/ble/diagnostics`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) setDiag(await r.json());
    } catch {}
    setLoading(false);
  }, [piBase]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-poll every 5s
  useEffect(() => {
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  if (!diag) return (
    <div className="text-center py-4 text-sm text-muted-foreground">
      {loading ? <Loader2 size={16} className="animate-spin mx-auto" /> : 'Kunde inte hämta diagnostik'}
    </div>
  );

  const a = diag.adapter;
  const s = diag.stats;
  const stateColor = a.state === 'poweredOn' ? 'text-green-400' : a.state === 'unauthorized' ? 'text-destructive' : 'text-yellow-400';

  return (
    <div className="space-y-3">
      {/* Adapter status */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">Adapter</div>
          <div className={`font-mono font-bold ${stateColor}`}>{a.state}</div>
        </div>
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">HCI-läge</div>
          <div className="font-mono font-bold">{a.mode}</div>
          {a.hciReleased && <span className="text-[9px] text-yellow-400">HCI frigiven</span>}
        </div>
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">Capabilities</div>
          <div className={`font-mono font-bold ${a.hasCaps ? 'text-green-400' : 'text-destructive'}`}>
            {a.hasCaps ? 'OK ✓' : 'Saknas ✗'}
          </div>
        </div>
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">Status</div>
          <div className="font-mono font-bold">
            {s.connected > 0 ? '🟢 Ansluten' : s.demand ? '🟡 Ansluter' : s.scanning ? '🔵 Söker' : '⚪ Vilar'}
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap gap-2 text-[10px]">
        <span className="bg-background/50 rounded px-2 py-1 font-mono">
          📤 {s.sentCount} skickade
        </span>
        {s.writeFailCount > 0 && (
          <span className="bg-destructive/20 text-destructive rounded px-2 py-1 font-mono">
            ❌ {s.writeFailCount} misslyckade
          </span>
        )}
        {s.disconnectCount > 0 && (
          <span className="bg-yellow-500/20 text-yellow-400 rounded px-2 py-1 font-mono">
            🔌 {s.disconnectCount} frånkopplingar
          </span>
        )}
        {s.reconnectCount > 0 && (
          <span className="bg-green-500/20 text-green-400 rounded px-2 py-1 font-mono">
            🔄 {s.reconnectCount} återanslutningar
          </span>
        )}
      </div>

      {s.lastDisconnectReason && (
        <div className="text-[10px] text-muted-foreground bg-background/30 rounded px-2 py-1">
          Senaste frånkoppling: <span className="font-mono text-destructive">{s.lastDisconnectReason}</span>
          {s.lastDisconnectAt && <span className="ml-1">({new Date(s.lastDisconnectAt).toLocaleTimeString('sv-SE')})</span>}
        </div>
      )}

      {/* Event log */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
            Eventlogg ({diag.events.length})
          </span>
          <button onClick={refresh} disabled={loading} className="text-[10px] text-muted-foreground active:text-foreground px-1.5 py-0.5 rounded border border-border/50">
            {loading ? <Loader2 size={10} className="animate-spin" /> : '↻'}
          </button>
        </div>
        {diag.events.length > 0 ? (
          <div className="bg-background/40 rounded-lg border border-border/50 p-2 max-h-56 overflow-y-auto text-[10px] font-mono space-y-0.5">
            {diag.events.slice().reverse().map((ev, i) => {
              const parsed = new Date(ev.timestamp);
              const time = isNaN(parsed.getTime()) ? '??:??:??' : parsed.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              const typeColor = ev.type.includes('fail') || ev.type === 'disconnect' ? 'text-destructive'
                : ev.type.includes('ok') || ev.type.includes('connect_start') ? 'text-green-400'
                : ev.type.includes('scan') ? 'text-blue-400'
                : ev.type.includes('hci') ? 'text-yellow-400'
                : 'text-muted-foreground';
              return (
                <div key={i} className="flex gap-1.5 leading-tight">
                  <span className="text-muted-foreground/60 shrink-0">{time}</span>
                  <span className={`shrink-0 ${typeColor}`}>{ev.type}</span>
                  {ev.device && <span className="text-foreground/70">{ev.device}</span>}
                  {ev.durationMs != null && <span className="text-muted-foreground">{ev.durationMs}ms</span>}
                  {ev.detail && <span className="text-muted-foreground truncate">{ev.detail}</span>}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground italic">Inga events ännu.</p>
        )}
      </div>
    </div>
  );
}


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


// ── Diagnostics panel component ──
/* ── Diagnostics Recording Panel ── */
type RecordingSample = { tInput: number; tOutput: number; inputRms: number; bassRms: number; outputPct: number };

function DiagnosticsPanel({ piBase }: { piBase: string }) {
  const [status, setStatus] = useState<'idle' | 'recording' | 'done'>('idle');
  const [countdown, setCountdown] = useState(0);
  const [samples, setSamples] = useState<RecordingSample[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const countRef = useRef<ReturnType<typeof setInterval>>();

  const startRecording = async () => {
    setStatus('recording');
    setCountdown(5);
    setSamples([]);

    // Countdown timer
    let c = 5;
    countRef.current = setInterval(() => {
      c--;
      setCountdown(c);
      if (c <= 0) clearInterval(countRef.current);
    }, 1000);

    // Start recording on Pi
    await fetch(`${piBase}/api/diagnostics/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMs: 5000 }),
    });

    // Poll for results
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${piBase}/api/diagnostics/recording`);
        const data = await r.json();
        if (data.status === 'done' && data.samples) {
          clearInterval(pollRef.current);
          clearInterval(countRef.current);
          setSamples(data.samples);
          setStatus('done');
        }
      } catch {}
    }, 300);
  };

  useEffect(() => () => { clearInterval(pollRef.current); clearInterval(countRef.current); }, []);

  // Draw graph when samples arrive
  useEffect(() => {
    if (samples.length === 0 || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const pad = { top: 20 * dpr, bottom: 28 * dpr, left: 36 * dpr, right: 12 * dpr };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    // Find max time and normalize
    const maxT = Math.max(samples[samples.length - 1].tInput, samples[samples.length - 1].tOutput);
    const maxInput = Math.max(0.001, ...samples.map(s => s.inputRms));

    const toX = (t: number) => pad.left + (t / maxT) * cw;
    const toY = (v: number, max: number) => pad.top + ch * (1 - Math.min(v / max, 1));

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    }

    // X-axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = `${9 * dpr}px monospace`;
    ctx.textAlign = 'center';
    for (let s = 0; s <= 5; s++) {
      const x = toX((maxT / 5) * s);
      ctx.fillText(`${s}s`, x, h - 6 * dpr);
    }

    // Y-axis labels
    ctx.textAlign = 'right';
    ctx.fillText('100%', pad.left - 4 * dpr, pad.top + 4 * dpr);
    ctx.fillText('0%', pad.left - 4 * dpr, pad.top + ch + 4 * dpr);

    // Draw Input RMS curve (blue) — plotted against tInput
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(100,160,255,0.9)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    for (let i = 0; i < samples.length; i++) {
      const x = toX(samples[i].tInput);
      const y = toY(samples[i].inputRms, maxInput);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw Bass RMS curve (green) — plotted against tInput
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(100,220,120,0.8)';
    ctx.lineWidth = 1.5 * dpr;
    for (let i = 0; i < samples.length; i++) {
      const x = toX(samples[i].tInput);
      const y = toY(samples[i].bassRms, maxInput);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw Output brightness curve (orange) — plotted against tOutput
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,140,50,0.9)';
    ctx.lineWidth = 2 * dpr;
    for (let i = 0; i < samples.length; i++) {
      const x = toX(samples[i].tOutput);
      const y = toY(samples[i].outputPct, 100);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under output
    ctx.lineTo(toX(samples[samples.length - 1].tOutput), pad.top + ch);
    ctx.lineTo(toX(samples[0].tOutput), pad.top + ch);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, 'rgba(255,140,50,0.25)');
    grad.addColorStop(1, 'rgba(255,140,50,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Compute and draw average latency label
    let totalDelay = 0;
    let delayCount = 0;
    for (let i = 0; i < samples.length; i++) {
      const d = samples[i].tOutput - samples[i].tInput;
      if (d >= 0) { totalDelay += d; delayCount++; }
    }
    const avgDelay = delayCount > 0 ? totalDelay / delayCount : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `${10 * dpr}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`avg latency: ${avgDelay.toFixed(1)} ms`, pad.left + 4 * dpr, pad.top + 14 * dpr);
  }, [samples]);

  return (
    <div className="space-y-3">
      {status === 'idle' && (
        <button
          onClick={startRecording}
          className="w-full py-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium active:scale-95 transition-transform flex items-center justify-center gap-2"
        >
          <Activity size={16} />
          Starta diagnos (5s inspelning)
        </button>
      )}

      {status === 'recording' && (
        <div className="text-center py-6">
          <div className="text-4xl font-bold font-mono text-primary mb-2">{countdown}</div>
          <p className="text-sm text-muted-foreground animate-pulse">Spelar in…</p>
          <div className="w-full bg-secondary rounded-full h-2 mt-3">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-1000"
              style={{ width: `${((5 - countdown) / 5) * 100}%` }}
            />
          </div>
        </div>
      )}

      {status === 'done' && samples.length > 0 && (
        <div>
          <canvas
            ref={canvasRef}
            className="w-full rounded-lg"
            style={{ height: 200, background: 'rgba(0,0,0,0.3)' }}
          />
          <div className="flex justify-center gap-5 mt-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 border-t-2" style={{ borderColor: 'rgba(100,160,255,0.9)' }} /> Input RMS
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 border-t-2" style={{ borderColor: 'rgba(100,220,120,0.8)' }} /> Bass RMS
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 border-t-2" style={{ borderColor: 'rgba(255,140,50,0.9)' }} /> Output %
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground text-center mt-1">
            {samples.length} samples | avg latency: {(samples.reduce((s, x) => s + Math.max(0, x.tOutput - x.tInput), 0) / samples.length).toFixed(1)} ms
          </p>
          <button
            onClick={() => { setStatus('idle'); setSamples([]); }}
            className="w-full mt-3 py-2.5 rounded-lg bg-secondary text-secondary-foreground text-sm font-medium active:scale-95 transition-transform"
          >
            Ny inspelning
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Engine Profiler Panel ── */
type ProfileStageResult = { avgUs: number; p50Us: number; p99Us: number; maxUs: number; minUs: number };
type ProfileResult = { ticks: number; stages: Record<string, ProfileStageResult> };

const STAGE_LABELS: Record<string, string> = {
  agc: 'AGC',
  normalize: 'Normalisering',
  mix: 'Bas/Disk mix',
  smooth: 'Mjukhet',
  dynamics: 'Dynamik',
  onset: 'Transient',
  curve: 'Perceptuell',
  palette: 'Palett',
  colorCal: 'Färgkal.',
  bleWrite: 'BLE Write',
  diag: 'Diagnostik',
  total: 'TOTALT',
};

function ProfilerPanel({ piBase }: { piBase: string }) {
  const [status, setStatus] = useState<'idle' | 'profiling' | 'done'>('idle');
  const [result, setResult] = useState<ProfileResult | null>(null);
  const [ticks, setTicks] = useState(1000);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const startProfile = async () => {
    setStatus('profiling');
    setResult(null);
    try {
      await fetch(`${piBase}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticks }),
      });
    } catch {}

    // Poll for results
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${piBase}/api/profile`, { signal: AbortSignal.timeout(2000) });
        const data = await r.json();
        if (data.status === 'done' && data.stages) {
          clearInterval(pollRef.current);
          setResult({ ticks: data.ticks, stages: data.stages });
          setStatus('done');
        }
      } catch {}
    }, 500);
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  // Find the slowest stage (excluding 'total')
  const slowestStage = result ? Object.entries(result.stages)
    .filter(([k]) => k !== 'total')
    .sort(([, a], [, b]) => b.avgUs - a.avgUs)[0]?.[0] : null;

  return (
    <div className="space-y-3">
      {status === 'idle' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex justify-between text-xs mb-1">
                <span>Antal ticks</span>
                <span className="text-muted-foreground font-mono">{ticks}</span>
              </div>
              <input
                type="range" min={100} max={5000} step={100} value={ticks}
                onChange={(e) => setTicks(parseInt(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none bg-secondary accent-primary"
              />
            </div>
          </div>
          <button
            onClick={startProfile}
            className="w-full py-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium active:scale-95 transition-transform flex items-center justify-center gap-2"
          >
            <Timer size={16} />
            Starta profiling ({ticks} ticks ≈ {Math.round(ticks * 10 / 1000)}s)
          </button>
        </div>
      )}

      {status === 'profiling' && (
        <div className="text-center py-6">
          <Loader2 size={32} className="text-primary animate-spin mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Profilerar {ticks} ticks…</p>
          <p className="text-[10px] text-muted-foreground mt-1">Spela musik för bästa resultat</p>
        </div>
      )}

      {status === 'done' && result && (
        <div className="space-y-3">
          <div className="text-[10px] text-muted-foreground text-center">
            {result.ticks} ticks profilerade
          </div>

          {/* Results table */}
          <div className="rounded-lg overflow-hidden border border-border">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-secondary/80 text-muted-foreground">
                  <th className="text-left px-2 py-1.5 font-medium">Steg</th>
                  <th className="text-right px-2 py-1.5 font-medium">Avg</th>
                  <th className="text-right px-2 py-1.5 font-medium">P50</th>
                  <th className="text-right px-2 py-1.5 font-medium">P99</th>
                  <th className="text-right px-2 py-1.5 font-medium">Max</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(result.stages).map(([stage, stats]) => {
                  const isTotal = stage === 'total';
                  const isSlowest = stage === slowestStage;
                  const isHot = !isTotal && stats.avgUs > 5; // >5µs is notable
                  return (
                    <tr
                      key={stage}
                      className={`border-t border-border/50 ${isTotal ? 'bg-secondary/50 font-semibold' : ''} ${isSlowest ? 'bg-destructive/10' : ''}`}
                    >
                      <td className={`px-2 py-1.5 ${isSlowest ? 'text-destructive' : ''}`}>
                        {STAGE_LABELS[stage] ?? stage}
                        {isSlowest && <span className="text-[9px] ml-1">🔥</span>}
                      </td>
                      <td className={`text-right px-2 py-1.5 font-mono ${isHot ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {stats.avgUs.toFixed(1)}
                      </td>
                      <td className="text-right px-2 py-1.5 font-mono text-muted-foreground">
                        {stats.p50Us.toFixed(1)}
                      </td>
                      <td className={`text-right px-2 py-1.5 font-mono ${stats.p99Us > 50 ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {stats.p99Us.toFixed(1)}
                      </td>
                      <td className={`text-right px-2 py-1.5 font-mono ${stats.maxUs > 100 ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {stats.maxUs.toFixed(0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-muted-foreground text-center">
            Alla tider i µs (mikrosekunder). 🔥 = långsammast steg.
          </p>

          {/* Bar chart visualization */}
          <div className="space-y-1">
            {Object.entries(result.stages)
              .filter(([k]) => k !== 'total')
              .sort(([, a], [, b]) => b.avgUs - a.avgUs)
              .map(([stage, stats]) => {
                const totalAvg = result.stages.total?.avgUs || 1;
                const pct = Math.min(100, (stats.avgUs / totalAvg) * 100);
                return (
                  <div key={stage} className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground w-16 text-right shrink-0">
                      {STAGE_LABELS[stage] ?? stage}
                    </span>
                    <div className="flex-1 h-3 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${stage === slowestStage ? 'bg-destructive' : 'bg-primary/70'}`}
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground w-12 text-right">
                      {stats.avgUs.toFixed(1)}µs
                    </span>
                  </div>
                );
              })}
          </div>

          <button
            onClick={() => { setStatus('idle'); setResult(null); }}
            className="w-full mt-2 py-2.5 rounded-lg bg-secondary text-secondary-foreground text-sm font-medium active:scale-95 transition-transform"
          >
            Ny profiling
          </button>
        </div>
      )}
    </div>
  );
}
export default function PiMobile() {
  const [view, setView] = useState<"home" | "profile" | "global">("home");
  const [activePreset, setActivePreset] = useState<string>("Normal");
  const [idleColor, setIdleColor] = useState([255, 60, 0]);
  const [cal, setCal] = useState({ ...DEFAULT_CAL });
  const [tickMs, setTickMs] = useState(10);
  const [sonosUrl, setSonosUrl] = useState("http://127.0.0.1:3053/api/sonos");
  const [sonosMode, setSonosMode] = useState<'auto' | 'local' | 'extern'>('auto'); // auto = detecting
  const [sonosLocalDetected, setSonosLocalDetected] = useState<{ found: boolean; url: string; name: string; version: string | null } | null>(null);
  const [alsaDevice, setAlsaDevice] = useState("plughw:0,0");
  const [dimmingGamma, setDimmingGamma] = useState(1.8);
  const [autoTvMode, setAutoTvMode] = useState(false);
  const [micGain, setMicGain] = useState(1.0);
  const [showDiag, setShowDiag] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<'checking' | 'running' | 'uptodate' | 'done' | 'error' | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [liveTrack, setLiveTrack] = useState<string | null>(null);
  const [liveBleCount, setLiveBleCount] = useState<number | null>(null);
  const [livePalette, setLivePalette] = useState<[number, number, number][]>([]);
  const [bleScanning, setBleScanning] = useState(false);
  const [bleScanLog, setBleScanLog] = useState<{ type: string; detail?: string; device?: string; timestamp: string }[]>([]);
  const [showBleLog, setShowBleLog] = useState(true);
  const [bleScanResults, setBleScanResults] = useState<{ id: string; name: string; rssi: number }[]>([]);
  const [bleConnectedId, setBleConnectedId] = useState<string | null>(null);
  const [bleConnectedName, setBleConnectedName] = useState<string | null>(null);
  const [bleSavedId, setBleSavedId] = useState<string | null>(null);
  const [bleSavedName, setBleSavedName] = useState<string | null>(null);
  const [bleSavedAddress, setBleSavedAddress] = useState<string | null>(null);
  const [bleConnecting, setBleConnecting] = useState<string | null>(null);
  const [bleDemand, setBleDemand] = useState(false);
  const [bleAdapterState, setBleAdapterState] = useState<string | null>(null);
  const [blePreview, setBlePreview] = useState(false);
  const [blePreviewSec, setBlePreviewSec] = useState(0);
  const [showManualBle, setShowManualBle] = useState(false);
  const [manualBleMac, setManualBleMac] = useState("");
  const [manualBleName, setManualBleName] = useState("");
  const [manualBleSaving, setManualBleSaving] = useState(false);
  const [manualBleError, setManualBleError] = useState<string | null>(null);
  const [hciScanning, setHciScanning] = useState(false);
  const [hciScanResults, setHciScanResults] = useState<{ address: string; name: string }[]>([]);
  const [hciScanRaw, setHciScanRaw] = useState<string>("");
  const [hciScanError, setHciScanError] = useState<string | null>(null);
  const [piVersion, setPiVersion] = useState<{ version: string; commitShort: string; branch: string } | null>(null);
  const [piOnline, setPiOnline] = useState<boolean | null>(null);
  const [engineStatus, setEngineStatus] = useState<{ running: boolean; hz: number; tickMs: number } | null>(null);
  const [sonosPlaying, setSonosPlaying] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  const bleIdentityRef = useRef<{ savedId: string | null; savedName: string | null; connectedId: string | null }>({
    savedId: null,
    savedName: null,
    connectedId: null,
  });

  useEffect(() => {
    bleIdentityRef.current = {
      savedId: bleSavedId,
      savedName: bleSavedName,
      connectedId: bleConnectedId,
    };
  }, [bleSavedId, bleSavedName, bleConnectedId]);

  const longPressTimer = useRef<ReturnType<typeof setTimeout>>();
  const longPressTriggered = useRef(false);

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
      const { releaseAlpha, smoothing } = softnessToParams(cal.softness);
      const results = await Promise.allSettled([
        putJson('/api/calibration', {
          bassWeight: cal.bassWeight,
          releaseAlpha,
          smoothing,
          dynamicDamping: cal.dynamicDamping,
          brightnessFloor: cal.brightnessFloor,
          punchWhiteThreshold: cal.punchWhiteThreshold,
          paletteMode: cal.paletteMode,
          perceptualCurve: cal.perceptualCurve,
          transientBoost: cal.transientBoost,
          agcEnabled: cal.agcEnabled,
          dynamicsEnabled: cal.dynamicsEnabled,
          hiShelfGainDb: 6,
        }),
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

  // Load current settings from Pi on mount
  useEffect(() => {
    const load = async () => {
      const safeFetch = (url: string) =>
        fetch(url, { signal: AbortSignal.timeout(3000) })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null);

      const [calRes, statusRes, micRes, gammaRes, idleRes, sonosRes, tvModeRes, micGainRes, detectRes] = await Promise.all([
        safeFetch(`${piBase}/api/calibration`),
        safeFetch(`${piBase}/api/status`),
        safeFetch(`${piBase}/api/mic-device`),
        safeFetch(`${piBase}/api/dimming-gamma`),
        safeFetch(`${piBase}/api/idle-color`),
        safeFetch(`${piBase}/api/sonos-gateway`),
        safeFetch(`${piBase}/api/auto-tv-mode`),
        safeFetch(`${piBase}/api/mic-gain`),
        safeFetch(`${piBase}/api/sonos-gateway/detect`),
      ]);

      // calRes is the flat stored calibration object (or {} if empty)
      if (calRes && typeof calRes === 'object' && Object.keys(calRes).length > 0) {
        const c = calRes;
        // Reverse-map releaseAlpha+smoothing back to softness
        let softness = DEFAULT_CAL.softness;
        if (c.releaseAlpha != null) {
          const t = Math.pow(Math.max(0, (1 - c.releaseAlpha) / 0.995), 1 / 0.7);
          softness = Math.round(Math.min(100, Math.max(0, t * 100)));
        }
        setCal({
          bassWeight: c.bassWeight ?? DEFAULT_CAL.bassWeight,
          softness,
          dynamicDamping: c.dynamicDamping ?? DEFAULT_CAL.dynamicDamping,
          brightnessFloor: c.brightnessFloor ?? DEFAULT_CAL.brightnessFloor,
          punchWhiteThreshold: c.punchWhiteThreshold ?? DEFAULT_CAL.punchWhiteThreshold,
          paletteMode: c.paletteMode ?? DEFAULT_CAL.paletteMode,
          perceptualCurve: c.perceptualCurve ?? DEFAULT_CAL.perceptualCurve,
          transientBoost: c.transientBoost ?? DEFAULT_CAL.transientBoost,
          agcEnabled: c.agcEnabled ?? DEFAULT_CAL.agcEnabled,
          dynamicsEnabled: c.dynamicsEnabled ?? DEFAULT_CAL.dynamicsEnabled,
        });
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
    if (view !== 'home') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`${piBase}/api/status`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok || cancelled) return;
        const data = await r.json();
        if (cancelled) return;
        setPiOnline(true);
        setPiVersion({ version: data.version ?? '?', commitShort: data.commit ?? '?', branch: data.branch ?? '?' });
        if (data.engine) setEngineStatus({ running: data.engine.running, hz: data.engine.hz, tickMs: data.engine.tickMs });
        const track = data.sonos?.trackName ?? null;
        setLiveTrack(track);
        setLiveBleCount(data.ble?.connected ?? null);
        setBleConnectedId(data.ble?.connectedDeviceId ?? null);
        setBleConnectedName(data.ble?.devices?.[0] ?? null);
        setBleSavedId(data.ble?.savedDeviceId ?? null);
        setBleSavedName(data.ble?.savedDeviceName ?? null);
        setBleSavedAddress(data.ble?.savedDeviceAddress ?? null);
        setBleDemand(data.ble?.demand ?? false);
        setBleAdapterState(data.ble?.adapterState ?? null);
        setSonosPlaying(data.sonos?.playbackState === 'PLAYBACK_STATE_PLAYING');
        // Always update palette when available (may arrive after track change)
        const palette = data.engine?.palette ?? [];
        if (palette.length > 0) {
          setLivePalette(palette);
        }
      } catch {
        if (!cancelled) setPiOnline(false);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [view, piBase]);

  if (view === "profile") {
    return (
      <ProfileSettingsView
        cal={cal} setCal={setCal} activePreset={activePreset}
        onBack={() => setView("home")} onSave={handleSave} saved={saved} saveError={saveError}
      />
    );
  }

  if (view === "global") {
    return (
      <GlobalSettingsView
        tickMs={tickMs} setTickMs={setTickMs}
        sonosUrl={sonosUrl} setSonosUrl={setSonosUrl}
        alsaDevice={alsaDevice} setAlsaDevice={setAlsaDevice}
        dimmingGamma={dimmingGamma} setDimmingGamma={setDimmingGamma}
        micGain={micGain} setMicGain={setMicGain}
        idleColor={idleColor} setIdleColor={setIdleColor}
        autoTvMode={autoTvMode} setAutoTvMode={setAutoTvMode}
        sonosMode={sonosMode} setSonosMode={setSonosMode} sonosLocalDetected={sonosLocalDetected}
        piBase={piBase}
        onBack={() => setView("home")} onSave={handleSave} saved={saved} saveError={saveError}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto" style={{ fontFamily: PI_FONT }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
          <span className="text-sm font-semibold">BLE Light</span>
        </div>
        <div className="flex gap-1">
          <button
            onTouchStart={() => {
              longPressTriggered.current = false;
              longPressTimer.current = setTimeout(() => {
                longPressTriggered.current = true;
                if (updateStatus === 'running') return;
                if (!confirm('Tvinga ominstallation? (Hoppar över versionskontroll)')) return;
                setUpdateStatus('running');
                fetch(`${piBase}/api/update/force`, { method: 'POST' }).then(() => {
                  const poll = setInterval(async () => {
                    try {
                      const s = await fetch(`${piBase}/api/update/status`, { signal: AbortSignal.timeout(3000) });
                      const sd = await s.json();
                      if (!sd.running) {
                        clearInterval(poll);
                        setUpdateStatus('done');
                        setTimeout(() => setUpdateStatus(null), 5000);
                      }
                    } catch { clearInterval(poll); setUpdateStatus('error'); }
                  }, 2000);
                }).catch(() => { setUpdateStatus('error'); setTimeout(() => setUpdateStatus(null), 3000); });
              }, 800);
            }}
            onTouchEnd={() => { clearTimeout(longPressTimer.current); }}
            onTouchCancel={() => { clearTimeout(longPressTimer.current); }}
            onClick={async () => {
              if (longPressTriggered.current) return;
              if (updateStatus === 'running') return;
              setUpdateStatus('checking');
              try {
                const r = await fetch(`${piBase}/api/update/check`, { signal: AbortSignal.timeout(8000) });
                const data = await r.json();
                if (data.error) { setUpdateStatus('error'); return; }
                if (data.upToDate) { setUpdateStatus('uptodate'); setTimeout(() => setUpdateStatus(null), 3000); return; }
                setUpdateStatus('running');
                await fetch(`${piBase}/api/update/run`, { method: 'POST' });
                const poll = setInterval(async () => {
                  try {
                    const s = await fetch(`${piBase}/api/update/status`, { signal: AbortSignal.timeout(3000) });
                    const sd = await s.json();
                    if (!sd.running) {
                      clearInterval(poll);
                      setUpdateStatus('done');
                      setTimeout(() => setUpdateStatus(null), 5000);
                    }
                  } catch { clearInterval(poll); setUpdateStatus('error'); }
                }, 2000);
              } catch { setUpdateStatus('error'); setTimeout(() => setUpdateStatus(null), 3000); }
            }}
            onContextMenu={(e) => e.preventDefault()}
            className="p-2 rounded-lg active:bg-accent"
            title={updateStatus === 'running' ? 'Uppdaterar…' : 'Tryck = uppdatera | Håll = tvinga ominstallation'}
          >
            {updateStatus === 'checking' || updateStatus === 'running' ? (
              <Loader2 size={20} className="text-primary animate-spin" />
            ) : updateStatus === 'uptodate' ? (
              <Check size={20} className="text-green-500" />
            ) : updateStatus === 'done' ? (
              <Check size={20} className="text-primary" />
            ) : updateStatus === 'error' ? (
              <X size={20} className="text-destructive" />
            ) : (
              <Download size={20} className="text-muted-foreground" />
            )}
          </button>
          <button onClick={() => setView("profile")} className="p-2 rounded-lg active:bg-accent disabled:opacity-30 disabled:pointer-events-none" title="Profilinställningar" disabled={!piOnline}>
            <Lightbulb size={20} className="text-muted-foreground" />
          </button>
          <button onClick={() => setView("global")} className="p-2 rounded-lg active:bg-accent disabled:opacity-30 disabled:pointer-events-none" title="Globala inställningar" disabled={!piOnline}>
            <Settings size={20} className="text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* BLE capability warning */}
      {bleAdapterState === 'unauthorized' && (
        <div className="mb-3 p-2.5 rounded-lg bg-destructive/15 border border-destructive/30 text-destructive text-[11px] flex items-start gap-2">
          <Bluetooth size={14} className="shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">BLE saknar rättigheter</span> — tjänsten behöver AmbientCapabilities (CAP_NET_RAW). Kontrollera att den körs via Pi Control Center.
          </div>
        </div>
      )}
      {bleAdapterState === 'poweredOff' && (
        <div className="mb-3 p-2.5 rounded-lg bg-yellow-500/15 border border-yellow-500/30 text-yellow-400 text-[11px] flex items-start gap-2">
          <Bluetooth size={14} className="shrink-0 mt-0.5" />
          <span>Bluetooth-adapter avstängd eller blockerad</span>
        </div>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-4 bg-secondary/50 rounded-lg px-3 py-2">
        <div className="flex items-center gap-1.5 shrink-0">
          <Bluetooth size={14} className={bleAdapterState === 'unauthorized' ? 'text-destructive' : bleAdapterState === 'poweredOff' ? 'text-yellow-400' : bleConnectedId ? 'text-primary' : bleDemand && bleSavedId ? 'text-yellow-400 animate-pulse' : bleSavedId ? 'text-muted-foreground' : 'text-muted-foreground/50'} />
          <span>{bleAdapterState === 'unauthorized' ? 'Ej behörig' : bleAdapterState === 'poweredOff' ? 'Avstängd' : bleConnectedId ? (bleConnectedName ?? '1 aktiv') : bleDemand && bleSavedId ? 'Ansluter…' : bleSavedId ? 'Vilar' : 'Ej kopplad'}</span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Music size={14} className="shrink-0" />
          <span className="truncate">{liveTrack ? `${sonosPlaying ? '▶' : '⏸'} ${liveTrack}` : 'Ingen låt'}</span>
        </div>
        {livePalette.length > 0 && (
          <div className="flex gap-1 shrink-0">
            {livePalette.map((c, i) => (
              <div
                key={i}
                className="w-4 h-4 rounded-full border border-border/50"
                style={{ backgroundColor: `rgb(${c[0]},${c[1]},${c[2]})` }}
                title={`rgb(${c[0]},${c[1]},${c[2]})`}
              />
            ))}
          </div>
        )}
      </div>
      {saveError && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/20 border border-destructive/40 text-destructive text-xs">
          ⚠ Sparning misslyckades: {saveError}
        </div>
      )}

      {/* Version / Status */}
      <div className="mb-4 text-[10px] text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2 space-y-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${piOnline === true ? 'bg-green-500' : piOnline === false ? 'bg-destructive' : 'bg-muted-foreground animate-pulse'}`} />
            <span>Frontend</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${engineStatus?.running ? 'bg-green-500' : piOnline === false ? 'bg-destructive' : 'bg-muted-foreground animate-pulse'}`} />
            <span>Motor {engineStatus ? (engineStatus.running ? `${engineStatus.hz} Hz` : 'Stoppad') : '…'}</span>
          </div>
          {piVersion && (
            <div className="flex flex-col items-end font-mono leading-tight text-right">
              <span>v{piVersion.version}</span>
              <span>{piVersion.commitShort}@{piVersion.branch}</span>
            </div>
          )}
        </div>
      </div>


      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Profil</h2>
        <div className="grid grid-cols-2 gap-3">
          {PRESETS.map((name) => (
            <button
              key={name} onClick={() => { setActivePreset(name); setCal({ ...PRESET_CALS[name] }); }}
              className={`py-4 rounded-xl text-sm font-medium transition-all active:scale-95 ${
                activePreset === name
                  ? "bg-primary text-primary-foreground ring-2 ring-ring"
                  : "bg-secondary text-secondary-foreground"
              }`}
            >{name}</button>
          ))}
        </div>
      </section>

      {/* BLE Device */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">BLE-enhet</h2>

        {/* Saved/paired device card */}
        {(bleSavedId || bleConnectedId) && !blePreview ? (
          <div className="bg-secondary/50 rounded-xl p-3 mb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bluetooth size={16} className={bleConnectedId ? "text-primary" : "text-muted-foreground"} />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{bleConnectedName ?? bleSavedName ?? bleSavedId?.substring(0, 12) ?? '—'}</span>
                  {bleSavedAddress && <span className="text-[10px] text-muted-foreground font-mono">{bleSavedAddress}</span>}
                </div>
                {bleConnectedId ? (
                  <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full">Aktiv</span>
                ) : bleDemand ? (
                  <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded-full animate-pulse">Ansluter…</span>
                ) : (
                  <span className="text-[10px] bg-secondary text-muted-foreground px-1.5 py-0.5 rounded-full">Vilar</span>
                )}
              </div>
              <button
                onClick={async () => {
                  try {
                    await fetch(`${piBase}/api/ble/forget`, { method: 'POST' });
                    setBleConnectedId(null);
                    setBleConnectedName(null);
                    setBleSavedId(null);
                    setBleSavedName(null);
                  } catch {}
                }}
                className="p-1.5 rounded-lg text-muted-foreground active:text-destructive"
                title="Glöm enhet"
              >
                <X size={16} />
              </button>
            </div>
            {!bleConnectedId && !bleDemand && (
              <div className="mt-2 ml-6 flex items-center gap-2">
                <p className="text-[10px] text-muted-foreground">Ansluter automatiskt när musik spelas</p>
                <button
                  onClick={async () => {
                    try {
                      await fetch(`${piBase}/api/ble/connect`, { method: 'POST' });
                    } catch {}
                  }}
                  className="text-[10px] text-primary font-medium px-2 py-0.5 rounded-md bg-primary/10 active:bg-primary/20 transition-colors shrink-0"
                >
                  Anslut nu
                </button>
              </div>
            )}
            {!bleConnectedId && bleDemand && (
              <p className="text-[10px] text-yellow-400 mt-1.5 ml-6">Ansluter…</p>
            )}
          </div>
        ) : null}

        {/* Preview state after selecting a device */}
        {blePreview && (
          <div className="bg-primary/10 rounded-xl p-4 mb-3 border border-primary/30">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 rounded-full animate-pulse" style={{ backgroundColor: `rgb(${idleColor[0]},${idleColor[1]},${idleColor[2]})` }} />
              <span className="text-sm font-medium">Förhandsgranskar…</span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Lampan visar idle-färgen i {blePreviewSec}s. Enheten sparas automatiskt.
            </p>
          </div>
        )}

        {/* Manual entry is the only path — scan via HCI inside the form */}
        {/* Manual MAC entry — fallback when scan fails */}
        {!bleSavedId && (
          <div className="mt-2">
            {!showManualBle ? (
              <button
                onClick={() => setShowManualBle(true)}
                className="text-[11px] text-muted-foreground active:text-foreground underline-offset-2 hover:underline"
              >
                Lägg till manuellt (MAC-adress)
              </button>
            ) : (
              <div className="bg-secondary/40 rounded-xl p-3 border border-border/60 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-foreground">Lägg till manuellt</span>
                  <button
                    onClick={() => { setShowManualBle(false); setManualBleError(null); }}
                    className="text-muted-foreground active:text-foreground"
                    aria-label="Stäng"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="space-y-1.5">
                  <label className="block">
                    <span className="text-[10px] text-muted-foreground">MAC-adress</span>
                    <input
                      type="text"
                      value={manualBleMac}
                      onChange={(e) => { setManualBleMac(e.target.value); setManualBleError(null); }}
                      placeholder="BE:67:00:15:09:41"
                      maxLength={17}
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      className="w-full mt-0.5 bg-background border border-border rounded-md px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] text-muted-foreground">Namn</span>
                    <input
                      type="text"
                      value={manualBleName}
                      onChange={(e) => { setManualBleName(e.target.value); setManualBleError(null); }}
                      placeholder="ELK-BLEDOM01"
                      maxLength={64}
                      className="w-full mt-0.5 bg-background border border-border rounded-md px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </label>
                </div>

                {/* HCI scan — alternative to noble scan */}
                <div className="space-y-1.5">
                  <button
                    disabled={hciScanning}
                    onClick={async () => {
                      setHciScanning(true);
                      setHciScanError(null);
                      setHciScanResults([]);
                      setHciScanRaw("");
                      try {
                        const r = await fetch(`${piBase}/api/ble/hci-scan`, {
                          method: 'POST',
                          signal: AbortSignal.timeout(15000),
                        });
                        const data = await r.json();
                        if (!r.ok) {
                          setHciScanError(data.error ?? 'HCI-scan misslyckades');
                        } else {
                          setHciScanResults(data.devices ?? []);
                          setHciScanRaw(data.rawOutput ?? '');
                        }
                      } catch (e: any) {
                        setHciScanError(e?.message ?? 'Nätverksfel');
                      } finally {
                        setHciScanning(false);
                      }
                    }}
                    className="w-full flex items-center justify-center gap-2 text-[11px] font-medium px-2.5 py-1.5 rounded-md bg-secondary text-foreground active:bg-secondary/70 disabled:opacity-50 border border-border/60"
                  >
                    {hciScanning ? (
                      <><Loader2 size={12} className="animate-spin" /> HCI-scannar (3s)…</>
                    ) : (
                      <><Search size={12} /> HCI-scan (hcitool lescan)</>
                    )}
                  </button>
                  {hciScanError && (
                    <p className="text-[10px] text-destructive">{hciScanError}</p>
                  )}
                  {hciScanResults.length > 0 && (
                    <div className="bg-background/60 border border-border rounded-md max-h-40 overflow-y-auto divide-y divide-border/60">
                      {hciScanResults.map((d) => (
                        <button
                          key={d.address}
                          onClick={() => {
                            setManualBleMac(d.address);
                            if (d.name && d.name !== '(unknown)') setManualBleName(d.name);
                            setManualBleError(null);
                          }}
                          className="w-full text-left px-2 py-1.5 active:bg-secondary/40 transition-colors"
                        >
                          <div className="text-[11px] font-mono text-foreground">{d.address}</div>
                          <div className="text-[10px] text-muted-foreground truncate">{d.name}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  {hciScanRaw && (
                    <details className="text-[10px]">
                      <summary className="text-muted-foreground cursor-pointer active:text-foreground">Rå output</summary>
                      <pre className="mt-1 bg-background/60 border border-border rounded-md p-1.5 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">{hciScanRaw}</pre>
                    </details>
                  )}
                </div>
                {manualBleError && (
                  <p className="text-[10px] text-destructive">{manualBleError}</p>
                )}
                <button
                  disabled={manualBleSaving || !manualBleMac.trim() || !manualBleName.trim()}
                  onClick={async () => {
                    setManualBleSaving(true);
                    setManualBleError(null);
                    try {
                      const r = await fetch(`${piBase}/api/ble/save-manual`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ address: manualBleMac.trim(), name: manualBleName.trim() }),
                        signal: AbortSignal.timeout(12000),
                      });
                      const data = await r.json();
                      if (!r.ok || !data.ok) {
                        setManualBleError(data.error ?? 'Kunde inte spara enheten');
                      } else {
                        setBleSavedId(data.savedDeviceId ?? null);
                        setBleSavedName(data.savedDeviceName ?? null);
                        setBleSavedAddress(data.savedDeviceAddress ?? null);
                        setShowManualBle(false);
                        setManualBleMac("");
                        setManualBleName("");
                      }
                    } catch (e: any) {
                      setManualBleError(e?.message ?? 'Nätverksfel');
                    } finally {
                      setManualBleSaving(false);
                    }
                  }}
                  className="w-full flex items-center justify-center gap-2 text-xs font-medium px-3 py-2 rounded-lg bg-primary text-primary-foreground active:bg-primary/80 disabled:opacity-50 disabled:active:bg-primary"
                >
                  {manualBleSaving ? (
                    <><Loader2 size={14} className="animate-spin" /> Sparar…</>
                  ) : (
                    <><Save size={14} /> Spara enhet</>
                  )}
                </button>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Försöker ansluta direkt efter sparning. BLEDOM-standardvärden används (public address, fff0-tjänst).
                </p>
              </div>
            )}
          </div>
        )}

        {/* BLE Scan Log */}
        {showBleLog && (
          <div className="mt-3">
            <div className="flex items-center gap-2 mb-1.5">
              <button
                onClick={() => setShowBleLog(false)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground active:text-foreground"
              >
                <Activity size={10} /> BLE-logg ({bleScanLog.length}) <X size={10} className="ml-1" />
              </button>
              <button
                onClick={async () => {
                  try {
                    const r = await fetch(`${piBase}/api/ble/log`);
                    const data = await r.json();
                    setBleScanLog(data.events ?? []);
                  } catch {}
                }}
                className="ml-auto text-[10px] text-muted-foreground active:text-foreground px-1.5 py-0.5 rounded border border-border/50"
              >
                ↻ Uppdatera
              </button>
              <button
                onClick={async () => {
                  const text = bleScanLog.map(ev => {
                    const t = typeof ev.timestamp === 'string' ? ev.timestamp : '';
                    return `${t}\t${ev.type}${ev.device ? '\t' + ev.device : ''}${ev.detail ? '\t' + ev.detail : ''}`;
                  }).join('\n');
                  try {
                    if (navigator.clipboard?.writeText) {
                      await navigator.clipboard.writeText(text);
                    } else {
                      const ta = document.createElement('textarea');
                      ta.value = text; document.body.appendChild(ta);
                      ta.select(); document.execCommand('copy'); ta.remove();
                    }
                  } catch {}
                }}
                className="text-[10px] text-muted-foreground active:text-foreground px-1.5 py-0.5 rounded border border-border/50"
              >
                ⧉ Kopiera
              </button>
              <button
                onClick={() => setBleScanLog([])}
                className="text-[10px] text-muted-foreground active:text-foreground px-1.5 py-0.5 rounded border border-border/50"
              >
                ✕ Rensa
              </button>
            </div>
            {bleScanLog.length > 0 ? (
              <div className="bg-secondary/60 rounded-lg border border-border p-2 max-h-48 overflow-y-auto text-[10px] font-mono space-y-0.5">
                {bleScanLog.slice().reverse().map((ev, i) => {
                  const parsed = new Date(ev.timestamp);
                  const time = isNaN(parsed.getTime())
                    ? (typeof ev.timestamp === 'string' ? ev.timestamp.slice(11, 19) : '??:??:??')
                    : parsed.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  const typeColor = ev.type === 'connect_fail' || ev.type === 'disconnect'
                    ? 'text-destructive'
                    : ev.type === 'connected'
                      ? 'text-green-400'
                      : 'text-muted-foreground';
                  return (
                    <div key={i} className="flex gap-1.5 leading-tight">
                      <span className="text-muted-foreground/60 shrink-0">{time}</span>
                      <span className={`shrink-0 ${typeColor}`}>{ev.type}</span>
                      {ev.device && <span className="text-foreground/70">{ev.device}</span>}
                      {ev.detail && <span className="text-muted-foreground truncate">{ev.detail}</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground italic">Ingen logg ännu.</p>
            )}
          </div>
        )}

        {bleScanResults.length > 0 && (
          <div className="mt-3 space-y-2">
            {bleScanResults.map((d) => (
              <button
                key={d.id}
                onClick={async () => {
                  setBleConnecting(d.id);
                  try {
                    const r = await fetch(`${piBase}/api/ble/select`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ deviceId: d.id }),
                    });
                    const data = await r.json();
                    if (data.ok) {
                      setBleSavedId(d.id);
                      setBleConnectedName(d.name);
                      setBleScanResults([]);
                      setBlePreview(true);
                      setBlePreviewSec(10);
                      const countdown = setInterval(() => {
                        setBlePreviewSec(prev => {
                          if (prev <= 1) {
                            clearInterval(countdown);
                            setBlePreview(false);
                            return 0;
                          }
                          return prev - 1;
                        });
                      }, 1000);
                    } else {
                      alert(`Kunde inte ansluta: ${data.error || 'okänt fel'}`);
                    }
                  } catch (e: any) {
                    alert(`Nätverksfel: ${e.message}`);
                  }
                  setBleConnecting(null);
                }}
                disabled={bleConnecting === d.id}
                className={`w-full flex items-center justify-between p-3 rounded-xl text-sm transition-all active:scale-[0.98] ${
                  d.id === bleSavedId ? 'bg-primary/10 ring-1 ring-primary' : 'bg-secondary/50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Bluetooth size={14} />
                  <span className="font-medium">{d.name}</span>
                  {d.id === bleSavedId && <span className="text-[10px] text-primary">(nuvarande)</span>}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="text-[10px]">{d.rssi} dBm</span>
                  {bleConnecting === d.id && <Loader2 size={14} className="animate-spin" />}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Diagnostics toggle + panel */}
      <section className="mb-8">
        <button
          onClick={() => setShowDiag(d => !d)}
          className="w-full py-3 rounded-xl text-sm font-medium bg-secondary text-secondary-foreground active:scale-95 transition-all flex items-center justify-center gap-2"
        >
          <Activity size={16} />
          {showDiag ? 'Dölj diagnostik' : 'Visa diagnostik'}
        </button>
        {showDiag && (
          <div className="mt-3 space-y-4">
            <div className="bg-secondary/50 rounded-xl p-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Bluetooth size={12} /> BLE Adapter & Status
              </h3>
              <BleDiagnosticsPanel piBase={piBase} />
            </div>
            <BleIntervalDiag piBase={piBase} />
            <div className="bg-secondary/50 rounded-xl p-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Activity size={12} /> Latens-inspelning
              </h3>
              <DiagnosticsPanel piBase={piBase} />
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Timer size={12} /> Pipeline-profiler
              </h3>
              <ProfilerPanel piBase={piBase} />
            </div>
          </div>
        )}
      </section>

    </div>
  );
}