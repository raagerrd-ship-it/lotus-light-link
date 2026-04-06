import { useState, useRef } from "react";
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

export default function PiMobile() {
  const [view, setView] = useState<"home" | "settings">("home");
  const [activePreset, setActivePreset] = useState<string>("Normal");
  const [idleColor, setIdleColor] = useState([255, 60, 0]);
  const [cal, setCal] = useState({ ...DEFAULT_CAL });
  const [tickMs, setTickMs] = useState(33);
  const [sonosUrl, setSonosUrl] = useState("http://192.168.1.100:5005");

  if (view === "settings") {
    return (
      <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto">
        {/* Header */}
        <button
          onClick={() => setView("home")}
          className="flex items-center gap-2 text-muted-foreground mb-6 active:text-foreground"
        >
          <ArrowLeft size={20} />
          <span className="text-sm">Tillbaka</span>
        </button>

        <h1 className="text-lg font-bold mb-6">Inställningar</h1>

        {/* Calibration sliders */}
        <section className="space-y-5 mb-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Kalibrering</h2>
          {SLIDER_CONFIG.map(({ key, label, min, max, step }) => (
            <div key={key}>
              <div className="flex justify-between text-sm mb-1">
                <span>{label}</span>
                <span className="text-muted-foreground font-mono text-xs">{cal[key]}</span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={cal[key]}
                onChange={(e) => setCal({ ...cal, [key]: parseFloat(e.target.value) })}
                className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
              />
            </div>
          ))}
        </section>

        {/* Tick rate */}
        <section className="mb-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Motor</h2>
          <div className="flex justify-between text-sm mb-1">
            <span>Tick rate</span>
            <span className="text-muted-foreground font-mono text-xs">{tickMs} ms</span>
          </div>
          <input
            type="range"
            min={20}
            max={200}
            step={1}
            value={tickMs}
            onChange={(e) => setTickMs(parseInt(e.target.value))}
            className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
          />
        </section>

        {/* Sonos Gateway */}
        <section className="mb-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Sonos Gateway</h2>
          <input
            type="url"
            value={sonosUrl}
            onChange={(e) => setSonosUrl(e.target.value)}
            placeholder="http://192.168.1.x:5005"
            className="w-full bg-secondary text-foreground rounded-lg px-3 py-3 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </section>
      </div>
    );
  }

  // Home view
  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-md mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
          <span className="text-sm font-semibold">Lotus Light</span>
        </div>
        <button
          onClick={() => setView("settings")}
          className="p-2 rounded-lg active:bg-accent"
        >
          <Settings size={20} className="text-muted-foreground" />
        </button>
      </div>

      {/* Status bar */}
      <div className="flex gap-4 text-xs text-muted-foreground mb-6 bg-secondary/50 rounded-lg px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Bluetooth size={14} />
          <span>2 enheter</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Music size={14} />
          <span>▶ Bohemian Rhapsody</span>
        </div>
      </div>

      {/* Preset grid */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Profil</h2>
        <div className="grid grid-cols-2 gap-3">
          {PRESETS.map((name) => (
            <button
              key={name}
              onClick={() => setActivePreset(name)}
              className={`py-4 rounded-xl text-sm font-medium transition-all active:scale-95 ${
                activePreset === name
                  ? "bg-primary text-primary-foreground ring-2 ring-ring"
                  : "bg-secondary text-secondary-foreground"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </section>

      {/* Idle color */}
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
                  type="range"
                  min={0}
                  max={255}
                  value={idleColor[i]}
                  onChange={(e) => {
                    const next = [...idleColor];
                    next[i] = parseInt(e.target.value);
                    setIdleColor(next);
                  }}
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
