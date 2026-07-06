import { useState, useRef, useEffect, useCallback } from "react";
import { Save, Check, Mic, Bluetooth, Loader2 } from "lucide-react";

import { apiBase } from "@/lib/apiBase";
import { PermissionsBanner } from "@/components/PermissionsBanner";



const PI_FONT = '"Noto Sans", "DejaVu Sans", "Liberation Sans", system-ui, sans-serif';



type Cal = { bassWeight: number; attack: number; softness: number; dynamicDamping: number; brightnessFloor: number; punchWhiteThreshold: number; perceptualGamma: number; transientGain: number; dynamicsEnabled: boolean; onsetThreshold: number; onsetRefractoryMs: number; onsetEnergyFloor: number; tickEnergyFloor: number; flickerDeadband: number; beatSource: 'bass' | 'full'; beatCutoffHz: number; dropEnabled: boolean; dropSensitivity: number; dropFlashMs: number };
const PRESET_CALS: Record<string, Cal> = {
  // Nytänkta preset-värden som utnyttjar nya slidrarnas bredd
  Lugn:   { bassWeight: 0.7, attack: 70,  softness: 75, dynamicDamping: -1.5, brightnessFloor: 8, punchWhiteThreshold: 100, perceptualGamma: 2.2, transientGain: 0.7, dynamicsEnabled: true,  onsetThreshold: 2.0, onsetRefractoryMs: 150, onsetEnergyFloor: 0.05, tickEnergyFloor: 0.02, flickerDeadband: 0.03, beatSource: 'bass', beatCutoffHz: 150, dropEnabled: true, dropSensitivity: 1.2, dropFlashMs: 220 },
  Normal: { bassWeight: 0.95, attack: 100, softness: 71, dynamicDamping: 0.4, brightnessFloor: 25, punchWhiteThreshold: 100, perceptualGamma: 1.2, transientGain: 1.1, dynamicsEnabled: true, onsetThreshold: 4.0, onsetRefractoryMs: 300, onsetEnergyFloor: 0.025, tickEnergyFloor: 0.025, flickerDeadband: 0.01, beatSource: 'bass', beatCutoffHz: 150, dropEnabled: true, dropSensitivity: 0.64, dropFlashMs: 220 },
  Party:  { bassWeight: 0.5, attack: 100, softness: 37, dynamicDamping: 1.5,  brightnessFloor: 0, punchWhiteThreshold: 93,  perceptualGamma: 1.5, transientGain: 1.5, dynamicsEnabled: true,  onsetThreshold: 1.6, onsetRefractoryMs: 90,  onsetEnergyFloor: 0.03, tickEnergyFloor: 0.01, flickerDeadband: 0.005, beatSource: 'bass', beatCutoffHz: 150, dropEnabled: true, dropSensitivity: 0.85, dropFlashMs: 260 },
  Custom: { bassWeight: 0.5, attack: 100, softness: 0,  dynamicDamping: 0,    brightnessFloor: 0, punchWhiteThreshold: 100, perceptualGamma: 0,   transientGain: 0.5, dynamicsEnabled: true,  onsetThreshold: 3.0, onsetRefractoryMs: 110, onsetEnergyFloor: 0.05, tickEnergyFloor: 0.02, flickerDeadband: 0.02, beatSource: 'bass', beatCutoffHz: 150, dropEnabled: true, dropSensitivity: 1.0, dropFlashMs: 220 },
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
  piBase, micGain, setMicGain, sonosVolume,
}: {
  piBase: string;
  micGain: number;
  setMicGain: (g: number) => void;
  sonosVolume: number | null;
}) {
  const [enabled, setEnabled] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const [gainLow, setGainLow] = useState(DEFAULT_GAIN_LOW);
  const [gainHigh, setGainHigh] = useState(DEFAULT_GAIN_HIGH);
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

  // Live-poll: endast auto-gain (multiplier/effective). Sonos-volym kommer
  // via delad status-poll i förälder. Snabbpoll i 5s efter slider-aktivitet.
  const fastPollUntilRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const ag = await fetch(`${piBase}/api/auto-gain`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
        if (!cancelled) {
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
              <span className="font-mono font-bold">{sonosVolume ?? "—"}</span>
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


type BleDevice = { name: string; mac: string; rssi?: number };

/* ── BLE-enhetsval: upptäck & välj lampa, slipp hårdkoda MAC ── */
function BleDeviceSection({ piBase }: { piBase: string }) {
  const [current, setCurrent] = useState<{ name: string; mac: string } | null>(null);
  const [devices, setDevices] = useState<BleDevice[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [savingMac, setSavingMac] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${piBase}/api/ble/device`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then(d => { if (d?.mac) setCurrent({ name: d.name, mac: d.mac }); })
      .catch(() => {});
  }, [piBase]);

  const scan = async () => {
    setScanning(true);
    setError(null);
    setDevices(null);
    try {
      const r = await fetch(`${piBase}/api/ble/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 6000 }),
        signal: AbortSignal.timeout(20000),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? 'scan misslyckades');
      setDevices((d.devices ?? []) as BleDevice[]);
    } catch (e: any) {
      setError(e?.message ?? 'Kunde inte söka');
    } finally {
      setScanning(false);
    }
  };

  const select = async (dev: BleDevice) => {
    setSavingMac(dev.mac);
    setError(null);
    try {
      const r = await fetch(`${piBase}/api/ble/device`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dev.name || 'BLE-lampa', mac: dev.mac }),
        signal: AbortSignal.timeout(5000),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? 'kunde inte spara');
      setCurrent(d.device);
    } catch (e: any) {
      setError(e?.message ?? 'Kunde inte spara');
    } finally {
      setSavingMac(null);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Bluetooth size={14} /> BLE-lampa
      </h2>

      <div className="mb-3 p-2.5 rounded-lg bg-secondary/50 border border-border text-[11px]">
        <div className="text-muted-foreground">Sparad enhet</div>
        <div className="font-medium">
          {current ? current.name : '—'}
          {current && <span className="text-muted-foreground font-mono ml-1.5">{current.mac}</span>}
        </div>
      </div>

      <button
        onClick={scan}
        disabled={scanning}
        className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium active:scale-95 transition-transform disabled:opacity-50 flex items-center justify-center gap-1.5"
      >
        {scanning ? <><Loader2 size={14} className="animate-spin" /> Söker…</> : <><Bluetooth size={14} /> Sök enheter</>}
      </button>

      {error && <p className="text-[11px] text-destructive mt-2">⚠ {error}</p>}

      {devices && (
        <div className="mt-3 space-y-1.5">
          {devices.length === 0 && (
            <p className="text-[11px] text-muted-foreground">Inga enheter hittades. Kontrollera att lampan är på och nära.</p>
          )}
          {devices.map(dev => {
            const isCurrent = current?.mac?.toUpperCase() === dev.mac.toUpperCase();
            return (
              <button
                key={dev.mac}
                onClick={() => select(dev)}
                disabled={savingMac != null}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left transition-colors disabled:opacity-50 ${
                  isCurrent ? 'bg-primary/15 border border-primary/40' : 'bg-secondary border border-border'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm truncate">{dev.name || '(namnlös)'}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{dev.mac}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {dev.rssi != null && <span className="text-[10px] text-muted-foreground font-mono">{dev.rssi} dBm</span>}
                  {savingMac === dev.mac
                    ? <Loader2 size={14} className="animate-spin" />
                    : isCurrent && <Check size={14} className="text-primary" />}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}


function ConnectionSettingsSection({
  sonosUrl, setSonosUrl,
  micGain, setMicGain,
  idleColor, setIdleColor,
  autoTvMode, setAutoTvMode,
  sonosMode, setSonosMode, sonosLocalDetected,
  piBase, sonosVolume,
}: {
  sonosUrl: string; setSonosUrl: (v: string) => void;
  micGain: number; setMicGain: (v: number) => void;
  idleColor: number[]; setIdleColor: (c: number[]) => void;
  autoTvMode: boolean; setAutoTvMode: (v: boolean) => void;
  sonosMode: 'auto' | 'local' | 'extern'; setSonosMode: (v: 'auto' | 'local' | 'extern') => void;
  sonosLocalDetected: { found: boolean; url: string; name: string; version: string | null } | null;
  piBase: string;
  sonosVolume: number | null;
}) {
  return (
    <>





      {/* Mikrofon: device hårdkodat till hw:0,0 i state.
          Endast gain-kontrollen (Manual/Auto) exponeras. */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Mic size={14} /> Mic Gain
        </h2>
        <GainCalibrationPanel piBase={piBase} micGain={micGain} setMicGain={setMicGain} sonosVolume={sonosVolume} />
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
  
  const [piOnline, setPiOnline] = useState<boolean | null>(null);
  const [engineStatus, setEngineStatus] = useState<{ running: boolean; hz: number; tickMs: number } | null>(null);
  const [sonosPlaying, setSonosPlaying] = useState(false);
  const [sonosState, setSonosState] = useState<string | null>(null);
  const [bleConnected, setBleConnected] = useState(false);
  const [sonosVolume, setSonosVolume] = useState<number | null>(null);
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
          beatCutoffHz: p.beatCutoffHz,
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
          beatCutoffHz: c?.beatCutoffHz ?? DEFAULT_CAL.beatCutoffHz,
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
        setSonosVolume(data.sonos?.volume ?? null);

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

      <BleDeviceSection piBase={piBase} />


      {/* Permissions self-check — varnar om PCC hoppade över setup-lotus.sh */}
      <PermissionsBanner piBase={piBase} />

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
                piBase={piBase} sonosVolume={sonosVolume}
              />
            </section>

            {/* Ljusinställningar: fyra reglage — resten är låst till intrimmade värden */}
            <section className="mb-8">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Ljusinställningar</h2>

              {/* Softness */}
              <div className="flex justify-between text-sm mb-1">
                <span>Softness</span>
                <span className="text-muted-foreground font-mono text-xs">{cal.softness}</span>
              </div>
              <input
                type="range" min={0} max={100} step={1} value={cal.softness}
                onChange={(e) => setCal({ ...cal, softness: parseInt(e.target.value) })}
                className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
              />
              <p className="text-[10px] text-muted-foreground mt-0.5 mb-4">0 = rått fall, 100 = mycket mjuk fade-out.</p>

              {/* Min ljusstyrka */}
              <div className="flex justify-between text-sm mb-1">
                <span>Min ljusstyrka</span>
                <span className="text-muted-foreground font-mono text-xs">{cal.brightnessFloor}%</span>
              </div>
              <input
                type="range" min={0} max={100} step={1} value={cal.brightnessFloor}
                onChange={(e) => setCal({ ...cal, brightnessFloor: parseInt(e.target.value) })}
                className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
              />
              <p className="text-[10px] text-muted-foreground mt-0.5 mb-4">Lägsta ljusstyrka (0 = släck helt i tystnad).</p>

              {/* Dynamik */}
              <div className="flex justify-between text-sm mb-1">
                <span>Dynamik</span>
                <span className="text-muted-foreground font-mono text-xs">{cal.dynamicDamping.toFixed(1)}×</span>
              </div>
              <input
                type="range" min={-2} max={2} step={0.1} value={cal.dynamicDamping}
                onChange={(e) => setCal({ ...cal, dynamicDamping: parseFloat(e.target.value) })}
                className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
              />
              <p className="text-[10px] text-muted-foreground mt-0.5 mb-4">0 = av, positivt = kontrast, negativt = utjämning.</p>

              {/* Beat-källa (lågpass) */}
              <div className="flex justify-between text-sm mb-1">
                <span>Beat-källa (lyssnar under)</span>
                <span className="text-muted-foreground font-mono text-xs">{cal.beatCutoffHz} Hz</span>
              </div>
              <input
                type="range" min={60} max={2000} step={10} value={cal.beatCutoffHz}
                onChange={(e) => setCal({ ...cal, beatCutoffHz: parseInt(e.target.value) })}
                className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary"
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Takt-detektorn reagerar bara på ljud under denna frekvens. Lågt (~120 Hz) = enbart kick/bas, högre = mer trummor och melodi. Spara för att tillämpa.
              </p>
            </section>





          </div>
        );
      })()}



      {/* Minimal status: Motor + Sonos + Lampa — grönt = allt igång */}
      <div className="mt-6 mb-4 text-[10px] text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${
              engineStatus?.running ? 'bg-green-500'
                : piOnline === false ? 'bg-destructive'
                : 'bg-muted-foreground animate-pulse'
            }`} />
            <span>Motor {engineStatus?.running ? 'Igång' : 'Av'}</span>
          </div>
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