import { useState, useRef, useEffect, useCallback } from "react";
import { Save, Check, Mic, Bluetooth, Loader2, Sliders } from "lucide-react";

import { apiBase } from "@/lib/apiBase";
import { PermissionsBanner } from "@/components/PermissionsBanner";
import { Panel, Row, Stat, Slider, Segmented, Button, Toggle, StatusDot } from "@/components/piUi";




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


/** Post-gain nivåmätare. Kompakt, alltid synlig. */
function LevelMeter({ health }: { health: { peak: number; clipPct: number; status: 'low' | 'ok' | 'hot' } | null }) {
  const peak = health ? Math.min(1, health.peak) : 0;
  const status = health?.status ?? 'low';
  const statusText =
    status === 'hot' ? 'Clipping' : status === 'low' ? 'Svag signal' : 'Bra nivå';
  const statusClass =
    status === 'hot' ? 'text-destructive' : status === 'ok' ? 'text-ok' : 'text-muted-foreground';


  return (
    <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-border p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="label-eyebrow">Nivå</span>
        <span className={`font-mono text-[10px] font-semibold ${statusClass}`}>{statusText}</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted overflow-hidden">
        <div className="absolute inset-y-0 w-px bg-foreground/20" style={{ left: '15%' }} />
        <div className="absolute inset-y-0 w-px bg-foreground/20" style={{ left: '90%' }} />
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${
            status === 'hot'
              ? 'bg-destructive'
              : status === 'ok'
              ? 'bg-ok shadow-[0_0_12px_hsl(var(--ok)/0.6)]'
              : 'bg-muted-foreground'
          }`}
          style={{ width: `${peak * 100}%` }}
        />
      </div>
      <div className="flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground/70 mt-1.5">
        <span>peak {(peak * 100).toFixed(0)}%</span>
        <span>clip {health ? (health.clipPct * 100).toFixed(2) : '0.00'}%</span>
      </div>
    </div>
  );
}


type CalPoint = { vol: number; gain: number };

/** Guidad tvåstegskalibrering. Nivåmätaren visas utanför, så wizardn fokuserar
 *  på instruktion + mätning + finjustering. */
function GuidedGainWizard({
  piBase, sonosVolume, micGain, setMicGain, onDone,
}: {
  piBase: string;
  sonosVolume: number | null;
  micGain: number;
  setMicGain: (g: number) => void;
  onDone: (low: CalPoint, high: CalPoint) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [low, setLow] = useState<CalPoint | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [progress, setProgress] = useState(0);
  const [measured, setMeasured] = useState<null | { ok: boolean; measuredRms: number }>(null);

  const start = async () => {
    await fetch(`${piBase}/api/auto-gain`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => {});
    setLow(null);
    setMeasured(null);
    setStep(1);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setMeasuring(false);
    setMeasured(null);
  };

  const measure = async () => {
    setMeasured(null);
    setProgress(0);
    try {
      await fetch(`${piBase}/api/mic-gain-calibration/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 15000, targetRms: 0.35 }),
        signal: AbortSignal.timeout(2000),
      });
      setMeasuring(true);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!measuring) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${piBase}/api/mic-gain-calibration`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
        if (r.active) {
          setProgress(Math.min(100, Math.round(((r.elapsedMs || 0) / (r.durationMs || 15000)) * 100)));
        } else {
          setMeasuring(false);
          if (r.lastResult) {
            setMeasured({ ok: !!r.lastResult.ok, measuredRms: r.lastResult.measuredRms });
            if (r.lastResult.ok) setMicGain(r.lastResult.newGain);
          }
        }
      } catch { /* keep polling */ }
    }, 500);
    return () => clearInterval(id);
  }, [measuring, piBase, setMicGain]);

  const onSlide = (g: number) => {
    setMicGain(g);
    fetch(`${piBase}/api/mic-gain`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gain: g }),
    }).catch(() => {});
  };

  const savePoint = async () => {
    const vol = sonosVolume ?? 0;
    if (step === 1) {
      setLow({ vol, gain: micGain });
      setMeasured(null);
      setStep(2);
      return;
    }
    if (!low) return;
    const high: CalPoint = { vol, gain: micGain };
    const [p1, p2] = low.vol <= high.vol ? [low, high] : [high, low];
    await fetch(`${piBase}/api/gain-calibration`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ point1: p1, point2: p2 }),
    }).catch(() => {});
    await fetch(`${piBase}/api/auto-gain`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {});
    onDone(p1, p2);
    close();
  };

  if (!open) {
    return (
      <Button onClick={start} variant="secondary">
        <Mic size={12} /> Kalibrera automatiskt
      </Button>
    );
  }

  const sameVol = step === 2 && low != null && sonosVolume != null && Math.abs(sonosVolume - low.vol) < 3;

  return (
    <div className="rounded-xl bg-primary/[0.06] ring-1 ring-inset ring-primary/30 p-3 space-y-3">
      <Row>
        <span className="label-eyebrow">Kalibrering · steg {step}/2</span>
        <button onClick={close} className="text-[10px] text-muted-foreground hover:text-foreground">Stäng</button>
      </Row>

      <div className="flex gap-1">
        <div className={`h-[3px] flex-1 rounded-full ${step >= 1 ? 'bg-primary' : 'bg-muted'}`} />
        <div className={`h-[3px] flex-1 rounded-full ${step >= 2 ? 'bg-primary' : 'bg-muted'}`} />
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {step === 1
          ? <>Spela musik på <span className="text-foreground font-medium">låg volym</span> och mät — justera sedan slidern om det behövs.</>
          : <><span className="text-foreground font-medium">Höj volymen</span> och mät igen. Sparad lågpunkt: {low?.vol} → {low?.gain.toFixed(1)}×.</>}
      </p>

      <div className="rounded-xl bg-foreground/[0.04] px-3 py-2">
        <Stat label="Sonos volym" value={sonosVolume ?? '—'} />
      </div>

      <Button onClick={measure} disabled={measuring} variant="secondary">
        {measuring ? <><Loader2 size={12} className="animate-spin" /> Mäter… {progress}%</>
          : <><Mic size={12} /> Mät automatiskt (15 s)</>}
      </Button>

      {measuring && (
        <div className="h-[3px] rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {measured && !measuring && (
        <p className={`text-[10px] ${measured.ok ? 'text-ok' : 'text-destructive'}`}>
          {measured.ok
            ? `Mätt RMS ${measured.measuredRms.toFixed(3)} → gain ${micGain.toFixed(1)}×`
            : 'För tyst — höj Sonos-volymen eller justera manuellt.'}
        </p>
      )}

      <Slider
        label="Finjustera"
        value={micGain}
        display={`${micGain.toFixed(1)}×`}
        min={1} max={50} step={0.5}
        onChange={onSlide}
      />

      {sameVol && (
        <p className="text-[10px] text-warn">
          Volymen är för nära lågpunkten — höj den innan du sparar.
        </p>
      )}

      <Button
        onClick={savePoint}
        variant="primary"
        disabled={sonosVolume == null || sameVol || measuring}
      >
        {step === 1 ? 'Spara lågpunkt' : 'Spara & aktivera auto-gain'}
      </Button>
    </div>
  );
}


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
  const [volLow, setVolLow] = useState(AUTO_VOL_LOW);
  const [volHigh, setVolHigh] = useState(AUTO_VOL_HIGH);
  const [effectiveGain, setEffectiveGain] = useState<number | null>(null);
  const [health, setHealth] = useState<{ peak: number; clipPct: number; status: 'low' | 'ok' | 'hot' } | null>(null);

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
      if (cal?.point1?.vol != null) setVolLow(cal.point1.vol);
      if (cal?.point2?.vol != null) setVolHigh(cal.point2.vol);
    }).catch(() => {});
  }, [piBase]);

  // Live-poll: endast auto-gain (multiplier/effective). Snabbpoll i 5s efter slider-aktivitet.
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
          setHealth(ag.health ?? null);
        }
      } catch {}
      if (cancelled) return;
      const interval = Date.now() < fastPollUntilRef.current ? 500 : 1500;
      timeoutId = setTimeout(poll, interval);
    };
    poll();
    return () => { cancelled = true; if (timeoutId) clearTimeout(timeoutId); };
  }, [piBase]);

  const pushCalibration = (lowGain: number, highGain: number) => {
    fetch(`${piBase}/api/gain-calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        point1: { vol: volLow, gain: lowGain },
        point2: { vol: volHigh, gain: highGain },
      }),
    }).catch(() => {});
    fastPollUntilRef.current = Date.now() + 5000;
  };

  const setMode = (auto: boolean) => {
    if (auto === enabled) return;
    setEnabled(auto);
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
    <div className="space-y-3">
      <Segmented
        value={enabled ? 'auto' : 'manual'}
        onChange={(v) => setMode(v === 'auto')}
        options={[
          { value: 'manual', label: 'Manuell' },
          { value: 'auto', label: 'Auto (Sonos)' },
        ]}
      />

      <LevelMeter health={health} />

      {!enabled && (
        <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-border p-3 space-y-2">
          <Slider
            label="Mic gain"
            value={micGain}
            display={`${micGain.toFixed(1)}×`}
            min={1} max={50}
            onChange={setMicGain}
            hint="1× = rå signal. Högre = känsligare."
          />
          {effectiveGain != null && (
            <div className="pt-2 border-t border-border/60">
              <Stat label="Aktiv i motor" value={`${effectiveGain.toFixed(1)}×`} tone="accent" />
            </div>
          )}
        </div>
      )}

      {enabled && (
        <div className="space-y-3">
          <div className="rounded-xl bg-primary/[0.06] ring-1 ring-inset ring-primary/25 p-3 space-y-2">
            <Stat label="Sonos volym" value={sonosVolume ?? '—'} />
            <div className="pt-2 border-t border-border/60">
              <Stat
                label="Aktuell mic-gain"
                value={`${(effectiveGain ?? multiplier).toFixed(1)}×`}
                tone="accent"
              />
            </div>
          </div>

          <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-border p-3 space-y-3">
            <Slider
              label={`Gain vid vol ${volLow}`}
              value={gainLow}
              display={`${gainLow.toFixed(1)}×`}
              min={1} max={50} step={0.5}
              onChange={onGainLowChange}
            />
            <Slider
              label={`Gain vid vol ${volHigh}`}
              value={gainHigh}
              display={`${gainHigh.toFixed(1)}×`}
              min={1} max={50} step={0.5}
              onChange={onGainHighChange}
              hint="Motorn interpolerar mellan punkterna utifrån Sonos-volymen."
            />
          </div>

          <GuidedGainWizard
            piBase={piBase}
            sonosVolume={sonosVolume}
            micGain={micGain}
            setMicGain={setMicGain}
            onDone={(low, high) => {
              setGainLow(low.gain);
              setGainHigh(high.gain);
              setVolLow(low.vol);
              setVolHigh(high.vol);
              setEnabled(true);
              fastPollUntilRef.current = Date.now() + 5000;
            }}
          />
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
    <Panel
      title="BLE-lampa"
      icon={<Bluetooth size={12} />}
      action={
        <button
          onClick={scan}
          disabled={scanning}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-foreground/[0.05] ring-1 ring-inset ring-border text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/80 disabled:opacity-50"
        >
          {scanning ? <><Loader2 size={11} className="animate-spin" /> Söker</> : 'Sök'}
        </button>
      }
    >
      <Row>
        <span className="text-[13px] truncate">{current ? current.name : 'Ingen enhet vald'}</span>
        {current && <span className="font-mono text-[10px] text-muted-foreground shrink-0">{current.mac}</span>}
      </Row>

      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}

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
                className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-left transition-colors disabled:opacity-50 ${
                  isCurrent
                    ? 'bg-primary/10 ring-1 ring-inset ring-primary/40'
                    : 'bg-foreground/[0.03] ring-1 ring-inset ring-border hover:bg-foreground/[0.06]'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-[13px] truncate">{dev.name || '(namnlös)'}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{dev.mac}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {dev.rssi != null && <span className="font-mono text-[10px] text-muted-foreground">{dev.rssi} dBm</span>}
                  {savingMac === dev.mac
                    ? <Loader2 size={14} className="animate-spin" />
                    : isCurrent && <Check size={14} className="text-primary" />}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
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
      {/* Mikrofon: device hårdkodat till hw:0,0 i state. Endast gain exponeras. */}
      <Panel title="Mic gain" icon={<Mic size={12} />}>
        <GainCalibrationPanel piBase={piBase} micGain={micGain} setMicGain={setMicGain} sonosVolume={sonosVolume} />
      </Panel>

      <Panel
        title="Sonos gateway"
        action={
          sonosLocalDetected?.found ? (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-ok">
              <Check size={11} /> Lokal
            </span>
          ) : undefined
        }
      >
        <div className="space-y-3">
          {sonosLocalDetected?.found && (
            <p className="text-[11px] text-muted-foreground">
              {sonosLocalDetected.name}
              {sonosLocalDetected.version && <span className="font-mono"> v{sonosLocalDetected.version}</span>}
            </p>
          )}

          {sonosLocalDetected?.found && (
            <Segmented
              value={sonosMode === 'extern' ? 'extern' : 'local'}
              onChange={(mode) => {
                setSonosMode(mode);
                if (mode === 'local' && sonosLocalDetected?.url) setSonosUrl(sonosLocalDetected.url);
              }}
              options={[
                { value: 'local', label: 'Lokal' },
                { value: 'extern', label: 'Extern' },
              ]}
            />
          )}

          {(sonosMode === 'extern' || !sonosLocalDetected?.found) && (
            <input
              type="url" value={sonosUrl} onChange={(e) => setSonosUrl(e.target.value)}
              placeholder="http://192.168.1.x:3053/api/sonos"
              className="w-full rounded-xl bg-foreground/[0.04] px-3 py-2.5 text-[12px] font-mono ring-1 ring-inset ring-border focus:outline-none focus:ring-primary/60"
            />
          )}

          {sonosMode === 'local' && sonosLocalDetected?.found && (
            <div className="rounded-xl bg-foreground/[0.03] px-3 py-2 text-[10px] font-mono text-muted-foreground truncate">
              {sonosUrl}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Idle-färg">
        <div className="flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-xl ring-1 ring-inset ring-border shrink-0"
            style={{
              backgroundColor: `rgb(${idleColor[0]},${idleColor[1]},${idleColor[2]})`,
              boxShadow: `0 0 26px rgb(${idleColor[0]} ${idleColor[1]} ${idleColor[2]} / 0.35)`,
            }}
          />
          <div className="flex-1 -my-1">
            {["R", "G", "B"].map((ch, i) => (
              <div key={ch} className="flex items-center gap-2">
                <span className="label-eyebrow w-3">{ch}</span>
                <input
                  type="range" min={0} max={255} value={idleColor[i]}
                  onChange={(e) => { const next = [...idleColor]; next[i] = parseInt(e.target.value); setIdleColor(next); }}
                  className="lotus-range flex-1"
                  style={{ ["--fill" as string]: `${(idleColor[i] / 255) * 100}%` }}
                />
                <span className="w-8 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{idleColor[i]}</span>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Automatik">
        <Row>
          <div className="min-w-0">
            <div className="text-[13px]">Auto TV-läge</div>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Mikrofon-reaktivt ljus när Sonos spelar från TV/SPDIF.
            </p>
          </div>
          <Toggle checked={autoTvMode} onChange={setAutoTvMode} />
        </Row>
      </Panel>
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
  const [sonosUrl, setSonosUrl] = useState(() =>
    typeof window !== 'undefined'
      ? `http://${window.location.hostname}:3053/api/sonos`
      : 'http://127.0.0.1:3053/api/sonos'
  );
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


  const engineState: 'ok' | 'warn' | 'error' | 'idle' =
    engineStatus?.running ? 'ok' : piOnline === false ? 'error' : 'idle';
  const sonosState2: 'ok' | 'warn' | 'error' | 'idle' =
    sonosPlaying ? 'ok' : sonosState ? 'warn' : piOnline === false ? 'error' : 'idle';
  const bleState: 'ok' | 'warn' | 'error' | 'idle' =
    bleConnected ? 'ok' : piOnline === false ? 'error' : 'idle';

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Sticky header — identitet, live-status och spara */}
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-md">
        <div className="mx-auto w-full max-w-[430px] px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${piOnline ? 'bg-ok shadow-[0_0_8px_hsl(var(--ok)/0.8)]' : 'bg-destructive'}`} />
              <span className="text-[13px] font-semibold tracking-tight">Lotus Light</span>
            </div>
            <div className="mt-1 flex items-center gap-3">
              <StatusDot label={engineStatus?.running ? 'Motor' : 'Motor av'} state={engineState} />
              <StatusDot label={sonosPlaying ? 'Spelar' : sonosState ? 'Pausad' : 'Sonos av'} state={sonosState2} />
              <StatusDot label={bleConnected ? 'Lampa' : 'Ej ansluten'} state={bleState} />
            </div>
          </div>
          <button
            onClick={handleSave}
            disabled={!piOnline}
            className={`shrink-0 flex items-center gap-1.5 px-4 min-h-[44px] rounded-xl text-[11px] font-semibold transition-all active:scale-[0.97] disabled:opacity-30 disabled:pointer-events-none ${
              saved
                ? 'bg-ok/15 text-ok ring-1 ring-inset ring-ok/40'
                : 'bg-primary text-primary-foreground shadow-[0_0_20px_hsl(var(--primary)/0.3)]'
            }`}
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? 'Sparat' : 'Spara'}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[430px] px-4 pt-4 safe-bottom space-y-3.5">
        <PermissionsBanner piBase={piBase} />

        {saveError && (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-[11px] text-destructive">
            Sparning misslyckades: {saveError}
          </div>
        )}

        <BleDeviceSection piBase={piBase} />

        {(() => {
          const ready = piOnline === true && engineStatus?.running === true;
          return (
            <div className={`space-y-3.5 ${!ready ? 'opacity-50 pointer-events-none select-none' : ''}`} aria-disabled={!ready}>
              {!ready && (
                <div className="rounded-2xl border border-border bg-card/50 p-4 text-center text-[11px] text-muted-foreground">
                  Väntar på motorn…
                </div>
              )}

              {/* Ljusinställningar — appens huvudkontroller */}
              <Panel title="Ljus" icon={<Sliders size={12} />} className="space-y-5">
                <Slider
                  label="Softness"
                  value={cal.softness}
                  display={`${cal.softness}`}
                  min={0} max={100}
                  onChange={(v) => setCal({ ...cal, softness: Math.round(v) })}
                  hint="0 = rått fall, 100 = mycket mjuk fade-out."
                />
                <Slider
                  label="Min ljusstyrka"
                  value={cal.brightnessFloor}
                  display={`${cal.brightnessFloor} %`}
                  min={0} max={100}
                  onChange={(v) => setCal({ ...cal, brightnessFloor: Math.round(v) })}
                  hint="0 = släck helt i tystnad."
                />
                <Slider
                  label="Dynamik"
                  value={cal.dynamicDamping}
                  display={`${cal.dynamicDamping.toFixed(1)}×`}
                  min={-2} max={2} step={0.1}
                  onChange={(v) => setCal({ ...cal, dynamicDamping: v })}
                  hint="0 = av, positivt = kontrast, negativt = utjämning."
                />
                <Slider
                  label="Beat-källa (lyssnar under)"
                  value={cal.beatCutoffHz}
                  display={`${cal.beatCutoffHz} Hz`}
                  min={60} max={2000} step={10}
                  onChange={(v) => setCal({ ...cal, beatCutoffHz: Math.round(v) })}
                  hint="Lågt (~120 Hz) = enbart kick/bas, högre = mer trummor och melodi. Spara för att tillämpa."
                />
              </Panel>

              <ConnectionSettingsSection
                sonosUrl={sonosUrl} setSonosUrl={setSonosUrl}
                micGain={micGain} setMicGain={setMicGain}
                idleColor={idleColor} setIdleColor={setIdleColor}
                autoTvMode={autoTvMode} setAutoTvMode={setAutoTvMode}
                sonosMode={sonosMode} setSonosMode={setSonosMode} sonosLocalDetected={sonosLocalDetected}
                piBase={piBase} sonosVolume={sonosVolume}
              />

              <p className="pt-2 text-center text-[9px] uppercase tracking-[0.24em] text-muted-foreground/40">
                {engineStatus ? `${engineStatus.hz ?? 0} Hz · ${engineStatus.tickMs ?? tickMs} ms tick` : 'offline'}
              </p>
            </div>
          );
        })()}
      </main>
    </div>
  );

}