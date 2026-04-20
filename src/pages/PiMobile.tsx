import { useState, useRef, useEffect, useCallback } from "react";
import { Settings, ArrowLeft, Bluetooth, Music, Save, Check, Mic, Lightbulb, Zap, Search, X, Loader2, Activity, Download, Timer } from "lucide-react";
import { apiBase } from "@/lib/apiBase";
import { SubsystemStartupPanel } from "@/components/SubsystemStartupPanel";
import { BleControlPanel } from "@/components/BleControlPanel";


const PI_FONT = '"Noto Sans", "DejaVu Sans", "Liberation Sans", system-ui, sans-serif';

const PRESETS = ["Lugn", "Normal", "Party", "Custom"] as const;

type Cal = { bassWeight: number; softness: number; dynamicDamping: number; brightnessFloor: number; punchWhiteThreshold: number; perceptualCurve: boolean; transientBoost: boolean; agcEnabled: boolean; dynamicsEnabled: boolean };
const PRESET_CALS: Record<string, Cal> = {
  Lugn:   { bassWeight: 0.7, softness: 75, dynamicDamping: -1.5, brightnessFloor: 8, punchWhiteThreshold: 100, perceptualCurve: true, transientBoost: true, agcEnabled: true, dynamicsEnabled: true },
  Normal: { bassWeight: 0.5, softness: 30, dynamicDamping: 1.0,  brightnessFloor: 0, punchWhiteThreshold: 97,  perceptualCurve: false, transientBoost: true, agcEnabled: true, dynamicsEnabled: true },
  Party:  { bassWeight: 0.3, softness: 5,  dynamicDamping: 1.5,  brightnessFloor: 0, punchWhiteThreshold: 93,  perceptualCurve: false, transientBoost: true, agcEnabled: true, dynamicsEnabled: true },
  Custom: { bassWeight: 0.5, softness: 0,  dynamicDamping: 0,    brightnessFloor: 0, punchWhiteThreshold: 100, perceptualCurve: false, transientBoost: true, agcEnabled: true, dynamicsEnabled: true },
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

function normalizeMacInput(value: string): string {
  const hex = value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 12);
  return hex.match(/.{1,2}/g)?.join(':') ?? '';
}

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

  // Live-poll: aktuell gain + Sonos-volym (alltid, så Manual också ser motorvärdet)
  useEffect(() => {
    let cancelled = false;
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
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(id); };
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

      {/* Motor-sektionen borttagen: tickMs hårdkodat till 25ms (40 pkt/s),
          dimmingGamma flyttas till profilinställning, BLE Hastighetstest borttaget. */}

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

    </div>
  );
}

/* ── BLE Adapter Diagnostics Panel ── */
function BleDiagnosticsPanel({ piBase }: { piBase: string }) {
  const [diag, setDiag] = useState<{
    adapter: {
      state: string;
      hciReleased?: boolean;
      hasCaps: boolean;
      mode?: string;
      nobleRaw?: { state: string | null; _state: string | null; adapterState: string | null; _adapterState: string | null };
      hci?: { raw: string; error: string | null };
      rfkill?: string;
    };
    build?: { bleTag?: string };
    enabled?: boolean;
    enabledMeta?: {
      source?: 'boot-default' | 'manual-toggle' | 'auto-restore';
      changedAt?: string;
      wasEnabledBeforeRestart?: boolean;
    };
    boot?: {
      startedAt?: string;
      elapsedMs?: number;
      firstStateChangeAt?: string | null;
      everPoweredOn?: boolean;
      stillBooting?: boolean;
      graceMs?: number;
    };
    pipeline?: { id: string; label: string; status: 'ok' | 'fail' | 'pending'; detail?: string }[];
    hciProbe?: { ok: boolean; method: string; errno?: string; error?: string; details?: string; ranAt?: string } | null;
    scan?: {
      phase: 'idle' | 'starting' | 'scanning' | 'stopping'; active: boolean; activeSince: string | null;
      lastScanId: number; lastStartedAt: string | null; lastStartOkAt: string | null; lastStoppedAt: string | null;
      lastDurationMs: number | null; lastRawDiscoverCount: number; lastResultCount: number;
      lastStartError: string | null; lastStopError: string | null; lastWatchdogAt: string | null;
    };
    stats: {
      connected: number; savedDevice: string | null; savedDeviceId: string | null;
      connectedDeviceId: string | null; demand: boolean; scanning: boolean;
      sentCount: number; writeFailCount: number; disconnectCount: number;
      reconnectCount: number; lastDisconnectReason: string | null; lastDisconnectAt: string | null;
    };
    events: { type: string; device?: string; detail?: string; timestamp: string; durationMs?: number }[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [startMsg, setStartMsg] = useState<{ kind: 'ok' | 'info' | 'error'; text: string } | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [, forceTick] = useState(0); // re-render varje sek så "Xs sedan" tickar

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${piBase}/api/ble/diagnostics`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        setDiag(await r.json());
        setLastFetchAt(Date.now());
      }
    } catch {}
    setLoading(false);
  }, [piBase]);

  useEffect(() => { refresh(); }, [refresh]);

  // Adaptiv auto-poll: 2s under boot/recovery, annars 5s.
  useEffect(() => {
    const fast = diag?.boot?.stillBooting === true || diag?.adapter?.state !== 'poweredOn';
    const iv = setInterval(refresh, fast ? 2000 : 5000);
    return () => clearInterval(iv);
  }, [refresh, diag?.boot?.stillBooting, diag?.adapter?.state]);

  // Tick varje sek så "Xs sedan"-text uppdateras live
  useEffect(() => {
    const iv = setInterval(() => forceTick(t => (t + 1) % 1000), 1000);
    return () => clearInterval(iv);
  }, []);

  if (!diag) return (
    <div className="text-center py-4 text-sm text-muted-foreground">
      {loading ? <Loader2 size={16} className="animate-spin mx-auto" /> : 'Kunde inte hämta diagnostik'}
    </div>
  );

  const a = diag.adapter;
  const s = diag.stats;
  const stateColor = a.state === 'poweredOn' ? 'text-green-400' : a.state === 'unauthorized' ? 'text-destructive' : 'text-yellow-400';
  const nobleRaw = a.nobleRaw;
  const nobleStateRaw = nobleRaw?.state ?? nobleRaw?._state ?? nobleRaw?.adapterState ?? nobleRaw?._adapterState ?? 'unknown';
  const hadEarlyStateChange = diag.boot?.everPoweredOn === true;
  const rawStateIgnored = (a.state === 'poweredOn' && a.hasCaps) || hadEarlyStateChange;
  const nobleStateColor = rawStateIgnored
    ? 'text-muted-foreground'
    : nobleStateRaw === 'poweredOn'
      ? 'text-green-400'
      : nobleStateRaw === 'unauthorized'
        ? 'text-destructive'
        : 'text-yellow-400';
  const rawStateLabel = rawStateIgnored ? 'noble.state (rå, endast referens på Pi)' : 'noble.state (rå)';

  const enabled = diag.enabled === true;
  const stillBooting = diag.boot?.stillBooting === true;
  const bootElapsedSec = diag.boot?.elapsedMs != null ? Math.floor(diag.boot.elapsedMs / 1000) : null;
  const toggleDisabled = toggling || stillBooting;
  const toggleBle = async () => {
    if (stillBooting) return;
    setToggling(true);
    setStartMsg(null);
    try {
      const path = enabled ? '/api/ble/stop' : '/api/ble/start';
      const r = await fetch(`${piBase}${path}`, { method: 'POST', signal: AbortSignal.timeout(12000) });
      const data = await r.json().catch(() => ({} as any));
      if (!enabled) {
        // Vi just slog PÅ → tolka start-svaret
        if (!data.adapterReady) {
          setStartMsg({ kind: 'error', text: 'Adaptern vaknade inte — tryck "Återställ BLE-stack" om det inte löser sig.' });
        } else if (!data.hasSaved) {
          setStartMsg({ kind: 'info', text: 'Ingen sparad enhet — använd Scan för att para.' });
        } else if (data.connected) {
          setStartMsg({ kind: 'ok', text: 'Ansluten till sparad enhet ✓' });
        } else if (data.autoConnect) {
          setStartMsg({ kind: 'info', text: 'BLE-radio är på — försöker ansluta sparad enhet i bakgrunden…' });
        }
      }
      await refresh();
    } catch (e: any) {
      setStartMsg({ kind: 'error', text: `BLE-toggle misslyckades: ${e?.message ?? 'okänt fel'}` });
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Master switch borttagen — använd "Anslut nu"-knappen längst upp istället.
          BLE-radion styrs nu enbart av direkta connect/disconnect-anrop. */}
      {startMsg && (
        <div
          className={`text-[11px] rounded-md px-2 py-1.5 ${
            startMsg.kind === 'ok'
              ? 'bg-green-500/10 text-green-400 border border-green-500/30'
              : startMsg.kind === 'info'
                ? 'bg-muted text-muted-foreground border border-border/60'
                : 'bg-destructive/10 text-destructive border border-destructive/30'
          }`}
        >
          {startMsg.text}
        </div>
      )}

      {/* Adapter status */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">Adapter (effektiv)</div>
          <div className={`font-mono font-bold ${stateColor}`}>{a.state}</div>
        </div>
        <div className="bg-background/50 rounded-lg p-2">
          <div className="text-muted-foreground text-[10px]">{rawStateLabel}</div>
          <div className={`font-mono font-bold ${nobleStateColor}`}>{nobleStateRaw}</div>
          {rawStateIgnored ? (
            <span className="text-[9px] text-muted-foreground">Förväntat på Pi — använder caps-aware state</span>
          ) : null}
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
            {s.connected > 0 ? '🟢 Ansluten' : s.demand && s.savedDeviceId ? '🟡 Ansluter' : s.scanning ? '🔵 Söker' : '⚪ Vilar'}
          </div>
        </div>
      </div>

      {/* Pipeline-checklista — steg-för-steg vad som är online */}
      {diag.pipeline && diag.pipeline.length > 0 && (
        <div className="bg-background/40 rounded-lg border border-border/50 p-2 space-y-1">
          <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-1.5 px-1">
            Pipeline — vad är online?
          </div>
          {diag.pipeline.map((step) => {
            const icon = step.status === 'ok' ? '✓' : step.status === 'pending' ? '⏳' : '✗';
            const colorClass =
              step.status === 'ok'
                ? 'text-green-400'
                : step.status === 'pending'
                  ? 'text-yellow-400'
                  : 'text-destructive';
            return (
              <div key={step.id} className="flex items-start gap-2 px-1 py-0.5 text-[11px]">
                <span className={`font-mono font-bold ${colorClass} shrink-0 w-4`}>{icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-foreground leading-tight">{step.label}</div>
                  {step.detail && (
                    <div className="text-muted-foreground text-[10px] font-mono leading-tight truncate">
                      {step.detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Noble internals + raw HCI from OS */}
      {(nobleRaw || a.hci || a.rfkill || diag.scan) && (
        <details className="bg-background/40 rounded-lg border border-border/50">
          <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-muted-foreground font-semibold uppercase tracking-wider active:text-foreground">
            OS ↔ noble (hciconfig + rfkill + noble internals)
          </summary>
          <div className="p-2 space-y-2 text-[10px] font-mono">
            {diag.scan && (
              <div>
                <div className="text-muted-foreground mb-0.5">scan metrics</div>
                <div className="bg-background/60 rounded px-1.5 py-1 leading-tight">
                  <div>phase:           <span className="text-foreground">{diag.scan.phase}</span></div>
                  <div>active:          <span className="text-foreground">{String(diag.scan.active)}</span></div>
                  <div>scanId:          <span className="text-foreground">{diag.scan.lastScanId}</span></div>
                  <div>startedAt:       <span className="text-foreground">{diag.scan.lastStartedAt ?? '—'}</span></div>
                  <div>startOkAt:       <span className="text-foreground">{diag.scan.lastStartOkAt ?? '—'}</span></div>
                  <div>stoppedAt:       <span className="text-foreground">{diag.scan.lastStoppedAt ?? '—'}</span></div>
                  <div>durationMs:      <span className="text-foreground">{diag.scan.lastDurationMs ?? '—'}</span></div>
                  <div>rawDiscover:     <span className="text-foreground">{diag.scan.lastRawDiscoverCount}</span></div>
                  <div>resultCount:     <span className="text-foreground">{diag.scan.lastResultCount}</span></div>
                  <div>startError:      <span className="text-foreground">{diag.scan.lastStartError ?? '—'}</span></div>
                  <div>stopError:       <span className="text-foreground">{diag.scan.lastStopError ?? '—'}</span></div>
                  <div>watchdogAt:      <span className="text-foreground">{diag.scan.lastWatchdogAt ?? '—'}</span></div>
                </div>
              </div>
            )}
            {nobleRaw && (
              <div>
                <div className="text-muted-foreground mb-0.5">noble internals</div>
                <div className="bg-background/60 rounded px-1.5 py-1 leading-tight">
                  <div>state:         <span className="text-foreground">{String(nobleRaw.state)}</span></div>
                  <div>_state:        <span className="text-foreground">{String(nobleRaw._state)}</span></div>
                  <div>adapterState:  <span className="text-foreground">{String(nobleRaw.adapterState)}</span></div>
                  <div>_adapterState: <span className="text-foreground">{String(nobleRaw._adapterState)}</span></div>
                </div>
              </div>
            )}
            {a.hci && (
              <div>
                <div className="text-muted-foreground mb-0.5">hciconfig hci0 {a.hci.error && <span className="text-destructive">({a.hci.error})</span>}</div>
                <pre className="bg-background/60 rounded px-1.5 py-1 whitespace-pre-wrap break-all text-foreground/80">{a.hci.raw || '(no output)'}</pre>
              </div>
            )}
            {a.rfkill && (
              <div>
                <div className="text-muted-foreground mb-0.5">rfkill list bluetooth</div>
                <pre className="bg-background/60 rounded px-1.5 py-1 whitespace-pre-wrap break-all text-foreground/80">{a.rfkill}</pre>
              </div>
            )}
          </div>
        </details>
      )}



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

      <div className="flex items-center justify-between text-[10px] text-muted-foreground/70 font-mono px-1">
        {diag.build?.bleTag ? (
          <span>build: <span className="text-foreground/70">{diag.build.bleTag}</span></span>
        ) : <span />}
        {lastFetchAt && (
          <span className="flex items-center gap-1">
            {loading && <Loader2 size={10} className="animate-spin" />}
            <span>poll: {Math.max(0, Math.floor((Date.now() - lastFetchAt) / 1000))}s sedan</span>
          </span>
        )}
      </div>

      {/* Återställ-knapparna borttagna — de fungerade ändå inte i praktiken.
          Vid problem: kör `sudo systemctl --user restart lotus-light-engine` via SSH. */}

      {/* Event log */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
            Eventlogg ({diag.events.length})
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                const text = diag.events.slice().reverse().map((ev) => {
                  const parsed = new Date(ev.timestamp);
                  const time = isNaN(parsed.getTime()) ? '??:??:??' : parsed.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  const parts = [time, ev.type];
                  if (ev.device) parts.push(ev.device);
                  if (ev.durationMs != null) parts.push(`${ev.durationMs}ms`);
                  if (ev.detail) parts.push(ev.detail);
                  return parts.join('\t');
                }).join('\n');
                const fallback = () => {
                  const ta = document.createElement('textarea');
                  ta.value = text;
                  ta.style.position = 'fixed';
                  ta.style.opacity = '0';
                  document.body.appendChild(ta);
                  ta.select();
                  try { document.execCommand('copy'); } catch {}
                  document.body.removeChild(ta);
                };
                if (navigator.clipboard?.writeText) {
                  navigator.clipboard.writeText(text).catch(fallback);
                } else {
                  fallback();
                }
              }}
              className="text-[10px] text-muted-foreground active:text-foreground px-1.5 py-0.5 rounded border border-border/50"
              title="Kopiera hela loggen"
            >
              📋 Kopiera
            </button>
            <button onClick={refresh} disabled={loading} className="text-[10px] text-muted-foreground active:text-foreground px-1.5 py-0.5 rounded border border-border/50">
              {loading ? <Loader2 size={10} className="animate-spin" /> : '↻'}
            </button>
          </div>
        </div>
        {diag.events.length > 0 ? (
          <div className="bg-background/40 rounded-lg border border-border/50 p-2 max-h-56 overflow-y-auto text-[10px] font-mono space-y-0.5">
            {diag.events.slice().reverse().map((ev, i) => {
              const parsed = new Date(ev.timestamp);
              const time = isNaN(parsed.getTime()) ? '??:??:??' : parsed.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              const typeColor = ev.type.includes('fail') || ev.type === 'disconnect' ? 'text-destructive'
                : ev.type === 'heartbeat' ? 'text-muted-foreground/50'
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



export default function PiMobile() {
  const [view, setView] = useState<"home" | "profile" | "global">("home");
  const [activePreset, setActivePreset] = useState<string>("Normal");
  const [idleColor, setIdleColor] = useState([255, 60, 0]);
  const [cal, setCal] = useState({ ...DEFAULT_CAL });
  const [tickMs, setTickMs] = useState(25);
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
  const [bleScanCompletedEmpty, setBleScanCompletedEmpty] = useState(false);
  const [bleScanMessage, setBleScanMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [bleScanLog, setBleScanLog] = useState<{ type: string; detail?: string; device?: string; timestamp: string }[]>([]);
  const [showBleLog, setShowBleLog] = useState(true);
  const [bleScanResults, setBleScanResults] = useState<{ id: string; name: string; rssi: number; source?: 'noble' | 'hcitool' | 'both' }[]>([]);
  const [bleConnectedId, setBleConnectedId] = useState<string | null>(null);
  const [bleHardcodedConnected, setBleHardcodedConnected] = useState(false);
  const [bleEngineReady, setBleEngineReady] = useState(false);
  const [bleConnectedName, setBleConnectedName] = useState<string | null>(null);
  const [bleSavedId, setBleSavedId] = useState<string | null>(null);
  const [bleSavedName, setBleSavedName] = useState<string | null>(null);
  const [bleSavedAddress, setBleSavedAddress] = useState<string | null>(null);
  const [bleConnecting, setBleConnecting] = useState<string | null>(null);
  const [bleDemand, setBleDemand] = useState(false);
  const [bleAdapterState, setBleAdapterState] = useState<string | null>(null);
  const [bootPhase, setBootPhase] = useState<string | null>(null);
  const [blePreview, setBlePreview] = useState(false);
  const [blePreviewSec, setBlePreviewSec] = useState(0);
  const [bleEngineDiagOpen, setBleEngineDiagOpen] = useState(false);
  const [bleEngineDiag, setBleEngineDiag] = useState<any>(null);
  const [bleEngineDiagLoading, setBleEngineDiagLoading] = useState(false);
  const [showManualBle, setShowManualBle] = useState(true);
  const [manualBleMac, setManualBleMac] = useState("");
  const [manualBleName, setManualBleName] = useState("");
  const [manualBleSaving, setManualBleSaving] = useState(false);
  const [manualBleError, setManualBleError] = useState<string | null>(null);
  const [piVersion, setPiVersion] = useState<{ version: string; commitShort: string; branch: string } | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [updatePhase, setUpdatePhase] = useState<'idle' | 'stopping' | 'downloading' | 'starting'>('idle');
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
  const showBlePicker = !bleSavedId || bleScanning || bleScanResults.length > 0;
  const showBleSavedCard = (bleSavedId || bleConnectedId) && !blePreview && !showBlePicker;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const isBleRespawnScanError = (message: string | null | undefined) =>
    typeof message === 'string' && /noble inte poweredOn inom 10s|Timeout waiting for Noble to be powered on/i.test(message);
  const isBleRespawnCooldownError = (message: string | null | undefined) =>
    typeof message === 'string' && /respawn blockerad|cooldown/i.test(message);

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

  const requestBleScan = useCallback(async () => {
    const r = await fetch(`${piBase}/api/ble/scan`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    });
    let data: any = null;
    try {
      data = await r.json();
    } catch {}
    return { r, data };
  }, [piBase]);

  const waitForBleRecovery = useCallback(async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const r = await fetch(`${piBase}/api/ble/diagnostics`, {
          signal: AbortSignal.timeout(1500),
        });
        if (r.ok) {
          await sleep(500);
          return true;
        }
      } catch {}
      await sleep(500);
    }
    return false;
  }, [piBase]);

  const handleBleScan = useCallback(async () => {
    const applyScanResult = (devices: { id: string; name: string; rssi: number; source?: 'noble' | 'hcitool' | 'both' }[], startError?: string | null) => {
      setBleScanResults(devices);
      setBleScanCompletedEmpty(devices.length === 0 && !startError);
      setBleScanMessage(startError ? { kind: 'error', text: startError } : null);
    };

    setBleScanning(true);
    setBleScanResults([]);
    setBleScanCompletedEmpty(false);
    setBleScanMessage(null);

    try {
      const first = await requestBleScan();
      const firstDevices = Array.isArray(first.data?.devices) ? first.data.devices : null;
      const firstError = first.data?.scan?.lastStartError ?? first.data?.error ?? null;

      if (isBleRespawnCooldownError(firstError)) {
        applyScanResult(firstDevices ?? [], firstError);
        return;
      }

      if (first.r.ok && firstDevices && (firstDevices.length > 0 || !isBleRespawnScanError(firstError))) {
        applyScanResult(firstDevices, firstError);
        return;
      }

      if (isBleRespawnScanError(firstError) || !first.r.ok) {
        setBleScanMessage({ kind: 'info', text: 'BLE startar om — försöker igen automatiskt…' });
        const recovered = await waitForBleRecovery();
        if (!recovered) {
          setBleScanMessage({ kind: 'error', text: 'BLE hann inte starta om. Försök igen om några sekunder.' });
          return;
        }

        const retry = await requestBleScan();
        const retryDevices = Array.isArray(retry.data?.devices) ? retry.data.devices : null;
        const retryError = retry.data?.scan?.lastStartError ?? retry.data?.error ?? null;

        if (isBleRespawnCooldownError(retryError)) {
          applyScanResult(retryDevices ?? [], retryError);
          return;
        }

        if (retry.r.ok && retryDevices) {
          applyScanResult(retryDevices, retryError);
          return;
        }

        setBleScanMessage({ kind: 'error', text: retryError ?? 'BLE återhämtade sig inte. Försök igen.' });
        return;
      }

      applyScanResult([], firstError ?? 'BLE-sökningen misslyckades');
    } catch {
      setBleScanMessage({ kind: 'info', text: 'BLE svarade inte direkt — väntar in omstart och försöker igen…' });
      const recovered = await waitForBleRecovery();
      if (!recovered) {
        setBleScanMessage({ kind: 'error', text: 'BLE hann inte starta om. Försök igen om några sekunder.' });
        return;
      }

      try {
        const retry = await requestBleScan();
        const retryDevices = Array.isArray(retry.data?.devices) ? retry.data.devices : null;
        const retryError = retry.data?.scan?.lastStartError ?? retry.data?.error ?? null;
        if (isBleRespawnCooldownError(retryError)) {
          applyScanResult(retryDevices ?? [], retryError);
          return;
        }
        if (retry.r.ok && retryDevices) {
          setBleScanResults(retryDevices);
          setBleScanCompletedEmpty(retryDevices.length === 0 && !retryError);
          setBleScanMessage(retryError ? { kind: 'error', text: retryError } : null);
          return;
        }
        setBleScanMessage({ kind: 'error', text: retryError ?? 'BLE-sökningen misslyckades.' });
      } catch {
        setBleScanMessage({ kind: 'error', text: 'BLE-sökningen misslyckades efter omstart.' });
      }
    } finally {
      setBleScanning(false);
    }
  }, [requestBleScan, waitForBleRecovery]);

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
        setBootPhase(data.bootPhase ?? null);
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

      {/* 1. BLE-motor — startas först så noble är poweredOn innan vi gör något annat */}
      <BleControlPanel
        piBase={piBase}
        section="engine"
        onEngineReadyChange={setBleEngineReady}
      />

      {/* 2. Subsystem (mic + sonos) — startas när motorn är redo, så ALSA + Sonos hinner upp innan vi börjar skicka färg */}
      <SubsystemStartupPanel piBase={piBase} enabled={bleEngineReady} />

      {/* 3. Lampa — anslut sist, när allt annat är på plats */}
      <BleControlPanel
        piBase={piBase}
        section="lamp"
        onConnectedChange={setBleHardcodedConnected}
        onEngineReadyChange={setBleEngineReady}
      />

      {/* Tidigare global BLE/Sonos-statusrad borttagen — sanningen finns nu
          i lamp-rutan (BLE) respektive sonos-rutan (låt + palette).
          Att duplicera här ledde till dubbeltydig "ELK-BLEDOM01" även när
          lampan inte var ansluten. */}
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

      {/* BLE-enhet hanteras nu helt av BleControlPanel ovan (hårdkodad ELK-BLEDOM01).
          Sök/manuell-MAC/spara/glöm är medvetet borttaget i denna iteration. */}

      {/* Diagnostik medvetet borttaget — UI är minimalt fokuserat på Starta motor + Anslut.
          Logg från backend visas live i BleControlPanel via /api/ble/engine/logs. */}

    </div>
  );
}