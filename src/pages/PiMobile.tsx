import { useState, useRef, useEffect, useCallback } from "react";
import { Settings, ArrowLeft, Bluetooth, Music, Save, Check } from "lucide-react";

const PRESETS = ["Lugn", "Normal", "Party", "Custom"] as const;

const DEFAULT_CAL = {
  attackAlpha: 1.0,
  releaseAlpha: 0.025,
  dynamicDamping: -1.0,
  bassWeight: 0.7,
  brightnessFloor: 0,
  smoothing: 0,
};

const SLIDER_CONFIG: { key: keyof typeof DEFAULT_CAL; label: string; min: number; max: number; step: number }[] = [
  { key: "attackAlpha", label: "Attack", min: 0.1, max: 1.0, step: 0.05 },
  { key: "releaseAlpha", label: "Release", min: 0.005, max: 0.15, step: 0.005 },
  { key: "dynamicDamping", label: "Dynamik", min: -3, max: 3, step: 0.1 },
  { key: "bassWeight", label: "Bas-vikt", min: 0, max: 1, step: 0.05 },
  { key: "brightnessFloor", label: "Min ljusstyrka", min: 0, max: 50, step: 1 },
  { key: "smoothing", label: "Utjämning", min: 0, max: 20, step: 1 },
];

const HISTORY = 64;
const TICK_MS = 25;

/* ── Simulated audio chart ── */
function SimChart({ cal }: { cal: typeof DEFAULT_CAL }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rawBuf = useRef<number[]>([]);
  const procBuf = useRef<number[]>([]);
  const smoothed = useRef(0);
  const phase = useRef(0);

  const tick = useCallback(() => {
    // Generate fake "raw energy" — sine + noise
    phase.current += 0.07;
    const base = 0.5 + 0.35 * Math.sin(phase.current) + 0.15 * Math.sin(phase.current * 2.7);
    const noise = (Math.random() - 0.5) * 0.3;
    const raw = Math.max(0, Math.min(1, base + noise));

    // Apply calibration (simplified engine logic)
    const prev = smoothed.current;
    const alpha = raw > prev ? cal.attackAlpha : cal.releaseAlpha;
    let val = prev + alpha * (raw - prev);

    // Dynamic damping
    if (cal.dynamicDamping !== 0) {
      const diff = val - prev;
      val += diff * cal.dynamicDamping * 0.1;
    }

    // Smoothing (moving average approximation)
    if (cal.smoothing > 0) {
      const k = 1 / (1 + cal.smoothing);
      val = prev * (1 - k) + val * k;
    }

    // Floor
    val = Math.max(val, cal.brightnessFloor / 100);
    val = Math.max(0, Math.min(1, val));
    smoothed.current = val;

    const rb = rawBuf.current;
    const pb = procBuf.current;
    rb.push(raw);
    pb.push(val);
    if (rb.length > HISTORY) { rb.shift(); pb.shift(); }
  }, [cal]);

  useEffect(() => {
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [tick]);

  // Draw loop
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const rb = rawBuf.current;
      const pb = procBuf.current;
      if (pb.length < 2) return;

      const step = w / (HISTORY - 1);
      const off = (HISTORY - pb.length) * step;

      // Grid
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      for (let pct = 25; pct <= 75; pct += 25) {
        const y = h - (pct / 100) * h;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Raw (dashed)
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      for (let i = 0; i < rb.length; i++) {
        const x = off + i * step;
        const y = h - rb[i] * h;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // Processed (solid, colored)
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgb(255,120,50)";
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i < pb.length; i++) {
        const x = off + i * step;
        const y = h - pb[i] * h;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Fill under processed
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(255,120,50,0.5)");
      grad.addColorStop(1, "rgba(255,120,50,0)");
      ctx.lineTo(off + (pb.length - 1) * step, h);
      ctx.lineTo(off, h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-lg"
      style={{ height: 80, background: "rgba(0,0,0,0.3)" }}
    />
  );
}

/* ── Settings View ── */
function SettingsView({
  cal, setCal, activePreset, tickMs, setTickMs,
  sonosUrl, setSonosUrl, onBack, onSave, saved,
}: {
  cal: typeof DEFAULT_CAL; setCal: (c: typeof DEFAULT_CAL) => void;
  activePreset: string; tickMs: number; setTickMs: (v: number) => void;
  sonosUrl: string; setSonosUrl: (v: string) => void;
  onBack: () => void; onSave: () => void; saved: boolean;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-2 text-muted-foreground active:text-foreground">
          <ArrowLeft size={20} /><span className="text-sm">Tillbaka</span>
        </button>
        <button
          onClick={onSave}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all active:scale-95 ${
            saved ? "bg-green-600 text-foreground" : "bg-primary text-primary-foreground"
          }`}
        >
          {saved ? <Check size={16} /> : <Save size={16} />}
          {saved ? "Sparat!" : "Spara"}
        </button>
      </div>

      <div className="flex items-center gap-2 mb-6">
        <h1 className="text-lg font-bold">Inställningar</h1>
        <span className="text-xs bg-accent text-accent-foreground px-2 py-0.5 rounded-full">{activePreset}</span>
      </div>

      {/* Calibration sliders + live mini chart */}
      <section className="space-y-5 mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Kalibrering</h2>
        <SimChart cal={cal} />
        <p className="text-[10px] text-muted-foreground -mt-3">
          Heldragen = bearbetad · Streckad = rå signal
        </p>
        {SLIDER_CONFIG.map(({ key, label, min, max, step }) => (
          <div key={key}>
            <div className="flex justify-between text-sm mb-1">
              <span>{label}</span>
              <span className="text-muted-foreground font-mono text-xs">{cal[key]}</span>
            </div>
            <input
              type="range" min={min} max={max} step={step} value={cal[key]}
              onChange={(e) => setCal({ ...cal, [key]: parseFloat(e.target.value) })}
              className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
            />
          </div>
        ))}
      </section>

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Motor</h2>
        <div className="flex justify-between text-sm mb-1">
          <span>Tick rate</span>
          <span className="text-muted-foreground font-mono text-xs">{tickMs} ms</span>
        </div>
        <input
          type="range" min={20} max={200} step={1} value={tickMs}
          onChange={(e) => setTickMs(parseInt(e.target.value))}
          className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
        />
      </section>

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Sonos Gateway</h2>
        <input
          type="url" value={sonosUrl} onChange={(e) => setSonosUrl(e.target.value)}
          placeholder="http://192.168.1.x:5005"
          className="w-full bg-secondary text-foreground rounded-lg px-3 py-3 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </section>
    </div>
  );
}

/* ── Main Component ── */
export default function PiMobile() {
  const [view, setView] = useState<"home" | "settings">("home");
  const [activePreset, setActivePreset] = useState<string>("Normal");
  const [idleColor, setIdleColor] = useState([255, 60, 0]);
  const [cal, setCal] = useState({ ...DEFAULT_CAL });
  const [tickMs, setTickMs] = useState(33);
  const [sonosUrl, setSonosUrl] = useState("http://192.168.1.100:5005");
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();

  const handleSave = () => {
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  };

  if (view === "settings") {
    return (
      <SettingsView
        cal={cal} setCal={setCal} activePreset={activePreset}
        tickMs={tickMs} setTickMs={setTickMs}
        sonosUrl={sonosUrl} setSonosUrl={setSonosUrl}
        onBack={() => setView("home")} onSave={handleSave} saved={saved}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
          <span className="text-sm font-semibold">Lotus Light</span>
        </div>
        <button onClick={() => setView("settings")} className="p-2 rounded-lg active:bg-accent">
          <Settings size={20} className="text-muted-foreground" />
        </button>
      </div>

      <div className="flex gap-4 text-xs text-muted-foreground mb-4 bg-secondary/50 rounded-lg px-3 py-2">
        <div className="flex items-center gap-1.5"><Bluetooth size={14} /><span>2 enheter</span></div>
        <div className="flex items-center gap-1.5"><Music size={14} /><span>▶ Bohemian Rhapsody</span></div>
      </div>

      {/* Live chart */}
      <div className="mb-6">
        <SimChart cal={cal} />
        <p className="text-[10px] text-muted-foreground mt-1">Heldragen = bearbetad · Streckad = rå signal</p>
      </div>

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Profil</h2>
        <div className="grid grid-cols-2 gap-3">
          {PRESETS.map((name) => (
            <button
              key={name} onClick={() => setActivePreset(name)}
              className={`py-4 rounded-xl text-sm font-medium transition-all active:scale-95 ${
                activePreset === name
                  ? "bg-primary text-primary-foreground ring-2 ring-ring"
                  : "bg-secondary text-secondary-foreground"
              }`}
            >{name}</button>
          ))}
        </div>
      </section>

      <section>
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
    </div>
  );
}
