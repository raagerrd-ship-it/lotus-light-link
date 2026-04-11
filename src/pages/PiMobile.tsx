import { useState, useRef, useEffect, useCallback } from "react";
import { Settings, ArrowLeft, Bluetooth, Music, Save, Check, Mic, Lightbulb, Zap, Search, X, Loader2, Activity, Download } from "lucide-react";

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

type Cal = { bassWeight: number; softness: number; dynamicDamping: number; brightnessFloor: number; punchWhiteThreshold: number; paletteMode: PaletteMode; perceptualCurve: boolean; transientBoost: boolean };

const PRESET_CALS: Record<string, Cal> = {
  Lugn:   { bassWeight: 0.7, softness: 75, dynamicDamping: -1.5, brightnessFloor: 8, punchWhiteThreshold: 100, paletteMode: 'off', perceptualCurve: true, transientBoost: true },
  Normal: { bassWeight: 0.5, softness: 30, dynamicDamping: 1.0,  brightnessFloor: 0, punchWhiteThreshold: 97,  paletteMode: 'blend', perceptualCurve: false, transientBoost: true },
  Party:  { bassWeight: 0.3, softness: 5,  dynamicDamping: 1.5,  brightnessFloor: 0, punchWhiteThreshold: 93,  paletteMode: 'bass', perceptualCurve: false, transientBoost: true },
  Custom: { bassWeight: 0.5, softness: 0,  dynamicDamping: 0,    brightnessFloor: 0, punchWhiteThreshold: 100, paletteMode: 'off', perceptualCurve: false, transientBoost: true },
};

const DEFAULT_CAL = PRESET_CALS.Normal;

/** Convert Softness 0-100 → releaseAlpha + smoothing (mirrors CalibrationOverlay) */
function softnessToParams(s: number) {
  const t = s / 100;
  const releaseAlpha = 1.0 - 0.995 * Math.pow(t, 0.7);
  const smoothing = Math.round(t * 80);
  return { releaseAlpha: Math.max(0.005, Math.round(releaseAlpha * 1000) / 1000), smoothing };
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
  onBack, onSave, saved,
}: {
  cal: typeof DEFAULT_CAL; setCal: (c: typeof DEFAULT_CAL) => void;
  activePreset: string;
  onBack: () => void; onSave: () => void; saved: boolean;
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


/* ── Global Settings View (motor, mic, sonos, BLE test) ── */
function GlobalSettingsView({
  tickMs, setTickMs,
  sonosUrl, setSonosUrl, alsaDevice, setAlsaDevice,
  dimmingGamma, setDimmingGamma,
  micGain, setMicGain,
  idleColor, setIdleColor,
  autoTvMode, setAutoTvMode,
  piBase,
  onBack, onSave, saved,
}: {
  tickMs: number; setTickMs: (v: number) => void;
  sonosUrl: string; setSonosUrl: (v: string) => void;
  alsaDevice: string; setAlsaDevice: (v: string) => void;
  dimmingGamma: number; setDimmingGamma: (v: number) => void;
  micGain: number; setMicGain: (v: number) => void;
  idleColor: number[]; setIdleColor: (c: number[]) => void;
  autoTvMode: boolean; setAutoTvMode: (v: boolean) => void;
  piBase: string;
  onBack: () => void; onSave: () => void; saved: boolean;
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

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Motor</h2>
        <div className="flex justify-between text-sm mb-1">
          <span>Tick rate</span>
          <span className="text-muted-foreground font-mono text-xs">{tickMs} ms</span>
        </div>
        <input
          type="range" min={20} max={50} step={1} value={tickMs}
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
      </section>

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Sonos Gateway</h2>
        <input
          type="url" value={sonosUrl} onChange={(e) => setSonosUrl(e.target.value)}
          placeholder="http://192.168.1.x:5005"
          className="w-full bg-secondary text-foreground rounded-lg px-3 py-3 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-ring"
        />
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

/* ── Main Component ── */
// ── Diagnostics panel component ──
type DiagRange = { ok: [number, number]; warn: string };
type DiagData = {
  pipeline: Record<string, number>;
  ble: Record<string, number>;
  calibration: Record<string, unknown>;
  ranges: Record<string, DiagRange>;
} | null;

function diagStatus(value: number, range: DiagRange): 'green' | 'yellow' | 'red' {
  const [lo, hi] = range.ok;
  if (value >= lo && value <= hi) return 'green';
  const span = (hi - lo) || 1;
  const margin = span * 0.2;
  if (value >= lo - margin && value <= hi + margin) return 'yellow';
  return 'red';
}

const DIAG_STATUS_COLORS = {
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
};

const DIAG_LABELS: Record<string, string> = {
  rawRms: 'Rå RMS',
  bassRms: 'Bas RMS',
  midHiRms: 'Disk RMS',
  agcMax: 'AGC Max',
  agcQuietTicks: 'AGC Tyst',
  energyNorm: 'Energi (norm)',
  dynamicCenter: 'Dyn. Center',
  onsetBoost: 'Onset Boost',
  brightnessPct: 'Ljusstyrka %',
  bleScaleRaw: 'BLE Skala',
  lastTickUs: 'Tick μs',
  tickCount: 'Tick #',
  finalR: 'R', finalG: 'G', finalB: 'B',
};

function DiagnosticsPanel({ piBase }: { piBase: string }) {
  const [data, setData] = useState<DiagData>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`${piBase}/api/diagnostics`, { signal: AbortSignal.timeout(2000) });
        if (!r.ok || cancelled) return;
        const d = await r.json();
        if (!cancelled) { setData(d); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    poll();
    const id = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(id); };
  }, [piBase]);

  if (error) return <p className="text-xs text-muted-foreground">Kan ej nå diagnostik-API</p>;
  if (!data) return <p className="text-xs text-muted-foreground animate-pulse">Laddar diagnostik…</p>;

  const { pipeline, ble, calibration, ranges } = data;

  // Pipeline metrics with ranges
  const pipelineKeys = Object.keys(ranges).filter(k => k in pipeline);
  // BLE stats
  const bleWriteLatMs = ble?.writeLatAvgMs ?? 0;
  const bleSkipBusy = ble?.skipBusyCount ?? 0;

  return (
    <div className="space-y-3">
      {/* Pipeline */}
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] font-mono">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left py-1">Mätvärde</th>
              <th className="text-right py-1">Värde</th>
              <th className="text-right py-1">OK-range</th>
              <th className="w-5" />
            </tr>
          </thead>
          <tbody>
            {pipelineKeys.map(key => {
              const val = pipeline[key] ?? 0;
              const range = ranges[key];
              const status = diagStatus(val, range);
              const display = val < 1 ? val.toFixed(4) : val < 100 ? val.toFixed(1) : String(val);
              return (
                <tr key={key} className="border-t border-border/30">
                  <td className="py-1 text-muted-foreground">{DIAG_LABELS[key] ?? key}</td>
                  <td className="text-right font-semibold">{display}</td>
                  <td className="text-right text-muted-foreground">{range.ok[0]}–{range.ok[1]}</td>
                  <td className="text-center"><div className={`w-2 h-2 rounded-full inline-block ${DIAG_STATUS_COLORS[status]}`} title={range.warn} /></td>
                </tr>
              );
            })}
            {/* BLE metrics from bleStats */}
            <tr className="border-t border-border/30">
              <td className="py-1 text-muted-foreground">BLE Latens ms</td>
              <td className="text-right font-semibold">{bleWriteLatMs.toFixed(1)}</td>
              <td className="text-right text-muted-foreground">0–15</td>
              <td className="text-center"><div className={`w-2 h-2 rounded-full inline-block ${DIAG_STATUS_COLORS[diagStatus(bleWriteLatMs, ranges.bleWriteLatMs ?? { ok: [0, 15], warn: '' })]}`} /></td>
            </tr>
            <tr className="border-t border-border/30">
              <td className="py-1 text-muted-foreground">BLE Skip Busy</td>
              <td className="text-right font-semibold">{bleSkipBusy}</td>
              <td className="text-right text-muted-foreground">0–50</td>
              <td className="text-center"><div className={`w-2 h-2 rounded-full inline-block ${DIAG_STATUS_COLORS[diagStatus(bleSkipBusy, ranges.bleSkipBusy ?? { ok: [0, 50], warn: '' })]}`} /></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Color preview */}
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-full border border-border/50" style={{ backgroundColor: `rgb(${pipeline.finalR ?? 0},${pipeline.finalG ?? 0},${pipeline.finalB ?? 0})` }} />
        <span className="text-[10px] text-muted-foreground font-mono">
          rgb({pipeline.finalR},{pipeline.finalG},{pipeline.finalB}) @ {pipeline.brightnessPct}%
        </span>
      </div>

      {/* Calibration snapshot */}
      <details className="text-[10px]">
        <summary className="text-muted-foreground cursor-pointer">Kalibrering</summary>
        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-muted-foreground">
          {Object.entries(calibration).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span>{k}</span>
              <span className="font-semibold text-foreground">{typeof v === 'boolean' ? (v ? 'Ja' : 'Nej') : String(v)}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

export default function PiMobile() {
  const [view, setView] = useState<"home" | "profile" | "global">("home");
  const [activePreset, setActivePreset] = useState<string>("Normal");
  const [idleColor, setIdleColor] = useState([255, 60, 0]);
  const [cal, setCal] = useState({ ...DEFAULT_CAL });
  const [tickMs, setTickMs] = useState(20);
  const [sonosUrl, setSonosUrl] = useState("http://192.168.1.100:5005");
  const [alsaDevice, setAlsaDevice] = useState("plughw:0,0");
  const [dimmingGamma, setDimmingGamma] = useState(1.8);
  const [autoTvMode, setAutoTvMode] = useState(false);
  const [micGain, setMicGain] = useState(1.0);
  const [showDiag, setShowDiag] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<'checking' | 'running' | 'uptodate' | 'done' | 'error' | null>(null);
  const [saved, setSaved] = useState(false);
  const [liveTrack, setLiveTrack] = useState<string | null>(null);
  const [liveBleCount, setLiveBleCount] = useState<number | null>(null);
  const [livePalette, setLivePalette] = useState<[number, number, number][]>([]);
  const [bleScanning, setBleScanning] = useState(false);
  const [bleScanResults, setBleScanResults] = useState<{ id: string; name: string; rssi: number }[]>([]);
  const [bleConnectedId, setBleConnectedId] = useState<string | null>(null);
  const [bleConnectedName, setBleConnectedName] = useState<string | null>(null);
  const [bleSavedId, setBleSavedId] = useState<string | null>(null);
  const [bleSavedName, setBleSavedName] = useState<string | null>(null);
  const [bleConnecting, setBleConnecting] = useState<string | null>(null);
  const [blePreview, setBlePreview] = useState(false);
  const [blePreviewSec, setBlePreviewSec] = useState(0);
  const [piVersion, setPiVersion] = useState<{ version: string; commitShort: string; branch: string } | null>(null);
  const [piOnline, setPiOnline] = useState<boolean | null>(null);
  const [engineStatus, setEngineStatus] = useState<{ running: boolean; hz: number; tickMs: number } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();

  // Derive Pi base URL from current page (frontend proxies /api/* → engine)
  const piBase = typeof window !== 'undefined'
    ? window.location.origin
    : 'http://localhost:3001';

  const putJson = (path: string, body: unknown) =>
    fetch(`${piBase}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const handleSave = async () => {
    try {
      const { releaseAlpha, smoothing } = softnessToParams(cal.softness);
      await Promise.all([
        // Calibration — send flat fields (server merges into stored object)
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
          hiShelfGainDb: 6,
        }),
        // Tick rate
        putJson('/api/tick-ms', { tickMs }),
        // Mic device
        putJson('/api/mic-device', { device: alsaDevice }),
        // Dimming gamma
        putJson('/api/dimming-gamma', { gamma: dimmingGamma }),
        // Idle color
        putJson('/api/idle-color', { color: idleColor }),
        // Sonos gateway
        ...(sonosUrl ? [putJson('/api/sonos-gateway', { baseUrl: sonosUrl })] : []),
        // Auto TV-mode
        putJson('/api/auto-tv-mode', { enabled: autoTvMode }),
        // Mic gain
        putJson('/api/mic-gain', { gain: micGain }),
      ]);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      console.error('[PiMobile] Save failed', e);
    }
  };

  // Load current settings from Pi on mount
  useEffect(() => {
    const load = async () => {
      const safeFetch = (url: string) =>
        fetch(url, { signal: AbortSignal.timeout(3000) })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null);

      const [calRes, statusRes, micRes, gammaRes, idleRes, sonosRes, tvModeRes, micGainRes] = await Promise.all([
        safeFetch(`${piBase}/api/calibration`),
        safeFetch(`${piBase}/api/status`),
        safeFetch(`${piBase}/api/mic-device`),
        safeFetch(`${piBase}/api/dimming-gamma`),
        safeFetch(`${piBase}/api/idle-color`),
        safeFetch(`${piBase}/api/sonos-gateway`),
        safeFetch(`${piBase}/api/auto-tv-mode`),
        safeFetch(`${piBase}/api/mic-gain`),
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
          
        });
      }
      if (micRes?.device) setAlsaDevice(micRes.device);
      if (gammaRes?.gamma != null) setDimmingGamma(gammaRes.gamma);
      if (statusRes?.engine?.tickMs) setTickMs(statusRes.engine.tickMs);
      if (Array.isArray(idleRes) && idleRes.length === 3) setIdleColor(idleRes);
      if (sonosRes?.active?.baseUrl) setSonosUrl(sonosRes.active.baseUrl);
      else if (sonosRes?.saved?.baseUrl) setSonosUrl(sonosRes.saved.baseUrl);
      if (tvModeRes?.enabled != null) setAutoTvMode(tvModeRes.enabled);
      if (micGainRes?.gain != null) setMicGain(micGainRes.gain);

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
        if (track && track !== lastTrackRef.current) {
          lastTrackRef.current = track;
          const palette = data.engine?.palette ?? [];
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
        onBack={() => setView("home")} onSave={handleSave} saved={saved}
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
        piBase={piBase}
        onBack={() => setView("home")} onSave={handleSave} saved={saved}
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
            onClick={async () => {
              if (updateStatus === 'running') return;
              setUpdateStatus('checking');
              try {
                const r = await fetch(`${piBase}/api/update/check`, { signal: AbortSignal.timeout(8000) });
                const data = await r.json();
                if (data.error) { setUpdateStatus('error'); return; }
                if (data.upToDate) { setUpdateStatus('uptodate'); setTimeout(() => setUpdateStatus(null), 3000); return; }
                // Update available — run it
                setUpdateStatus('running');
                await fetch(`${piBase}/api/update/run`, { method: 'POST' });
                // Poll status
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
            className="p-2 rounded-lg active:bg-accent"
            title={updateStatus === 'running' ? 'Uppdaterar…' : 'Sök efter uppdatering'}
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

      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-4 bg-secondary/50 rounded-lg px-3 py-2">
        <div className="flex items-center gap-1.5 shrink-0">
          <Bluetooth size={14} className={bleConnectedId ? 'text-primary' : bleSavedId ? 'text-muted-foreground' : 'text-muted-foreground/50'} />
          <span>{bleConnectedId ? (bleConnectedName ?? '1 aktiv') : bleSavedId ? 'Vilar' : 'Ej kopplad'}</span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Music size={14} className="shrink-0" />
          <span className="truncate">{liveTrack ? `▶ ${liveTrack}` : 'Ingen låt'}</span>
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
                <span className="text-sm font-medium">{bleConnectedName ?? bleSavedName ?? bleSavedId?.substring(0, 12) ?? '—'}</span>
                {bleConnectedId ? (
                  <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full">Aktiv</span>
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
            {!bleConnectedId && (
              <p className="text-[10px] text-muted-foreground mt-1.5 ml-6">Ansluter automatiskt när musik spelas</p>
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

        {/* Scan button */}
        <button
          onClick={async () => {
            setBleScanning(true);
            setBleScanResults([]);
            try {
              const r = await fetch(`${piBase}/api/ble/scan`, { method: 'POST', signal: AbortSignal.timeout(15000) });
              const data = await r.json();
              if (data.error) {
                console.warn('[BLE scan]', data.error);
              }
              setBleScanResults(data.devices ?? []);
            } catch (e) {
              console.error('[BLE scan] failed:', e);
            }
            setBleScanning(false);
          }}
          disabled={bleScanning}
          className="w-full py-3 rounded-xl text-sm font-medium bg-secondary text-secondary-foreground active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {bleScanning ? (
            <><Loader2 size={16} className="animate-spin" /> Söker…</>
          ) : (
            <><Search size={16} /> {bleSavedId ? 'Byt enhet' : 'Sök efter enheter'}</>
          )}
        </button>

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
                    }
                  } catch {}
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
          <div className="mt-3 bg-secondary/50 rounded-xl p-3">
            <DiagnosticsPanel piBase={piBase} />
          </div>
        )}
      </section>

    </div>
  );
}