import { useState, useRef, useEffect, useCallback } from "react";
import { Settings, ArrowLeft, Bluetooth, Music, Save, Check, Mic, Lightbulb, Zap, Search, X, Loader2, Activity, Download, Timer } from "lucide-react";
import { apiBase } from "@/lib/apiBase";
import { SubsystemStartupPanel } from "@/components/SubsystemStartupPanel";
import { BleControlPanel } from "@/components/BleControlPanel";
import { PermissionsBanner } from "@/components/PermissionsBanner";
import { LiveStrip } from "@/components/LiveStrip";
import { StartAllPanel } from "@/components/StartAllPanel";
import { RestartHistoryPanel } from "@/components/RestartHistoryPanel";


const PI_FONT = '"Noto Sans", "DejaVu Sans", "Liberation Sans", system-ui, sans-serif';

const PRESETS = ["Lugn", "Normal", "Party", "Custom"] as const;

type Cal = { bassWeight: number; attack: number; softness: number; dynamicDamping: number; brightnessFloor: number; punchWhiteThreshold: number; perceptualGamma: number; transientGain: number; saturation: number; dynamicsEnabled: boolean; onsetThreshold: number; onsetRefractoryMs: number; onsetEnergyFloor: number; maxRisePerSec: number; maxFallPerSec: number; flickerDeadband: number };
const PRESET_CALS: Record<string, Cal> = {
  // Nytänkta preset-värden som utnyttjar nya slidrarnas bredd
  Lugn:   { bassWeight: 0.7, attack: 70,  softness: 75, dynamicDamping: -1.5, brightnessFloor: 8, punchWhiteThreshold: 100, perceptualGamma: 2.2, transientGain: 0.7, saturation: 0, dynamicsEnabled: true,  onsetThreshold: 2.0, onsetRefractoryMs: 150, onsetEnergyFloor: 0.05, maxRisePerSec: 4.0,  maxFallPerSec: 1.5, flickerDeadband: 0.04 },
  Normal: { bassWeight: 0.8, attack: 100, softness: 20, dynamicDamping: 0,    brightnessFloor: 5, punchWhiteThreshold: 100, perceptualGamma: 0.9, transientGain: 0.8, saturation: 0, dynamicsEnabled: false, onsetThreshold: 1.8, onsetRefractoryMs: 200, onsetEnergyFloor: 0.05, maxRisePerSec: 8.0,  maxFallPerSec: 2.5, flickerDeadband: 0.02 },
  Party:  { bassWeight: 0.3, attack: 100, softness: 5,  dynamicDamping: 1.5,  brightnessFloor: 0, punchWhiteThreshold: 93,  perceptualGamma: 1.5, transientGain: 1.5, saturation: 0, dynamicsEnabled: true,  onsetThreshold: 1.6, onsetRefractoryMs: 90,  onsetEnergyFloor: 0.03, maxRisePerSec: 15.0, maxFallPerSec: 5.0, flickerDeadband: 0.01 },
  Custom: { bassWeight: 0.5, attack: 100, softness: 0,  dynamicDamping: 0,    brightnessFloor: 0, punchWhiteThreshold: 100, perceptualGamma: 0,   transientGain: 0.5, saturation: 0, dynamicsEnabled: true,  onsetThreshold: 3.0, onsetRefractoryMs: 110, onsetEnergyFloor: 0.05, maxRisePerSec: 8.0,  maxFallPerSec: 2.5, flickerDeadband: 0.02 },
};

const DEFAULT_CAL = PRESET_CALS.Normal;

/** Format uptime-sekunder till "2h 15m" / "45m" / "12s" */
function formatUptime(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function cleanVersionLabel(version?: string | null): string | null {
  const v = version?.trim();
  if (!v || v === '?' || v.toLowerCase() === 'unknown') return null;
  return v.replace(/^v+/i, '');
}

function cleanBuildLabel(commit?: string | null, branch?: string | null): string | null {
  const c = commit?.trim();
  const b = branch?.trim();
  const hasCommit = !!c && c !== '?' && c.toLowerCase() !== 'unknown';
  const hasBranch = !!b && b !== '?' && b.toLowerCase() !== 'unknown';
  if (hasCommit && hasBranch) return `${c}@${b}`;
  if (hasCommit) return c;
  return null;
}

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

type NumericCalKey = 'bassWeight' | 'attack' | 'softness' | 'dynamicDamping' | 'brightnessFloor' | 'punchWhiteThreshold' | 'perceptualGamma' | 'transientGain' | 'saturation' | 'onsetThreshold' | 'onsetRefractoryMs' | 'onsetEnergyFloor' | 'flickerDeadband';
// Slider-ranges = användbar zon (inte API-clamp). Power-users kan sätta extrema värden via PUT /api/calibration.
// flickerDeadband exponeras inte här längre — sköts av AutoTuneAntiFlickerPanel (legacy BLE-bandbreddsfilter).
// saturation/maxRisePerSec/maxFallPerSec borttagna 2026-04-25/26 (ingen runtime-effekt).
const SLIDER_CONFIG: { key: NumericCalKey; label: string; min: number; max: number; step: number; unit?: string; description: string }[] = [
  { key: "bassWeight", label: "Bas ↔ Disk", min: 0, max: 1, step: 0.05, description: "0 = bara disk, 0.5 = neutral, 1.0 = bara bas (dämpar motsatt sida)" },
  { key: "attack", label: "Attack", min: 0, max: 100, step: 1, description: "0 = mjuk rise, 100 = omedelbar" },
  { key: "softness", label: "Release", min: 0, max: 100, step: 1, description: "0 = rått fall, 100 = mycket mjukt" },
  { key: "onsetThreshold", label: "Beat-känslighet", min: 1.5, max: 4.0, step: 0.1, unit: "×", description: "Lägre = fler beats triggar (känsligare). 1.5 = mycket känslig, 4.0 = bara tydliga slag" },
  { key: "onsetRefractoryMs", label: "Beat-mellanrum", min: 80, max: 300, step: 10, unit: "ms", description: "Minsta gap mellan beats. Högt värde = lugnare puls" },
  { key: "onsetEnergyFloor", label: "Beat energi-golv", min: 0, max: 0.20, step: 0.005, description: "Lampan flashar bara när musik är starkare än detta. Höj om bakgrundsbrus triggar pulser i tysta partier (0 = av, 0.05 = default)" },
  { key: "dynamicDamping", label: "Dynamik", min: -2, max: 2, step: 0.1, unit: "×", description: "0 = av, positivt = kontrast, negativt = utjämning" },
  { key: "transientGain", label: "Transient boost", min: 0, max: 1.5, step: 0.1, unit: "×", description: "0 = av, 1.0 = normal, 1.5 = överdrivna trumslag" },
  { key: "perceptualGamma", label: "Perceptuell kurva", min: 0, max: 2.2, step: 0.1, description: "0 = av, 1.0 = linjär, 1.8 = mjuk, 2.2 = kraftigt komprimerad" },
  { key: "brightnessFloor", label: "Golv", min: 0, max: 30, step: 1, unit: "%", description: "Lägsta ljusstyrka (0 = av)" },
  { key: "punchWhiteThreshold", label: "Punch White", min: 90, max: 100, step: 1, unit: "%", description: "100 = av. Över detta → vit" },
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

function processCurve(raw: number[], cal: typeof DEFAULT_CAL): { values: number[]; rising: boolean[]; punched: boolean[] } {
  // Tick-rate normalisering — speglar computeTickConstants() i piEngine.ts EXAKT.
  // Engine kör med variabel tickMs men normaliserar alla alphor till 125ms-referens:
  //   effectiveAlpha = 1 - (1 - rawAlpha)^(tickMs/125)
  // Vid tickMs=20 (default) skalas alphan ner ~6×, vilket ger mjukare beteende än rå-värdet
  // skulle antyda. Måste matcha exakt eller blir visualiseringen meningslös.
  const TICK_MS = 20;
  const RATIO = TICK_MS / 125;
  const SEC_RATIO = TICK_MS / 1000;
  const releaseAlphaRaw = softnessToAlpha(cal.softness);
  const attackAlphaRaw = attackToAlpha(cal.attack);
  const releaseAlpha = 1 - Math.pow(1 - releaseAlphaRaw, RATIO);
  const attackAlpha = 1 - Math.pow(1 - attackAlphaRaw, RATIO);
  const centerAlpha = 1 - Math.pow(1 - 0.002, RATIO);
  const onsetDecay = Math.pow(0.04, SEC_RATIO);
  const onsetRiseAlpha = 1 - Math.pow(0.05, RATIO);

  // bassWeight: speglar engine — asymmetrisk dämpning runt 0.5 (neutral).
  // bw=0 → bara disk (bas dämpad). bw=0.5 → båda 100% (neutral). bw=1 → bara bas (disk dämpad).
  // Rå-kurvans 3 sektioner tolkas som band: Låg=bass, Mellan=50/50, Hög=midHi.
  const bw = cal.bassWeight;
  const bassGain = bw <= 0.5 ? bw * 2 : 1;
  const midHiGain = bw >= 0.5 ? (1 - bw) * 2 : 1;
  const weighted: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = i / raw.length;
    const section = t < 1 / 3 ? 0 : t < 2 / 3 ? 1 : 2;
    const bassShare = section === 0 ? 1 : section === 1 ? 0.5 : 0;
    const midHiShare = 1 - bassShare;
    const gain = bassShare * bassGain + midHiShare * midHiGain;
    const scaled = raw[i] * gain;
    weighted.push(Math.max(0, Math.min(1, scaled)));
  }

  const values: number[] = [];
  const rising: boolean[] = [];
  const punched: boolean[] = [];
  let prev = weighted[0];
  let dynamicCenter = 0.5;

  // Onset state — engine använder rise/decay-alphor via processOnset(), spegla samma logik
  const onsetBufLen = 7;
  const fluxBuf: number[] = new Array(onsetBufLen).fill(0);
  let fluxIdx = 0;
  let prevFlux = 0;
  let onsetBoost = 0;
  let onsetTarget = 0;

  for (let i = 0; i < weighted.length; i++) {
    const r = weighted[i];
    // Riktning bestäms av rå-insignalen (inte filtrerad prev) — det är så engine
    // väljer attack vs release-alpha (energyNorm > smoothed).
    const isRising = r >= prev;
    const alpha = isRising ? attackAlpha : releaseAlpha;
    let val = prev + alpha * (r - prev);

    // Dynamics — speglar engine: hoppa över helt om dynamicsEnabled === false,
    // använd centerAlpha (tick-rate-skalad), clamp dynamicCenter till [0.2, 0.7]
    if (cal.dynamicsEnabled !== false) {
      dynamicCenter += centerAlpha * (val - dynamicCenter);
      if (dynamicCenter < 0.2) dynamicCenter = 0.2;
      if (dynamicCenter > 0.7) dynamicCenter = 0.7;
      val = applyDynamics(val, dynamicCenter, cal.dynamicDamping);
    }

    // Transient boost — engine: processOnset(flux) sätter onsetTarget=0.20 vid candidate,
    // sen rise mot target via onsetRiseAlpha + decay via onsetDecay. Additiv på energyNorm.
    if ((cal.transientGain ?? 0) > 0) {
      const flux = Math.max(0, r - (i > 0 ? weighted[i - 1] : r));
      fluxBuf[fluxIdx % onsetBufLen] = flux;
      fluxIdx++;
      const sorted = fluxBuf.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const threshold = median * 1.8 + 0.008; // matchar engine
      const isOnset = flux > threshold && flux >= prevFlux;
      prevFlux = flux;
      if (isOnset) onsetTarget = 0.20;
      if (onsetBoost < onsetTarget) {
        onsetBoost += onsetRiseAlpha * (onsetTarget - onsetBoost);
      } else {
        onsetBoost *= onsetDecay;
      }
      onsetTarget *= onsetDecay;
      if (onsetBoost < 0.001) { onsetBoost = 0; onsetTarget = 0; }
      val = val + onsetBoost * cal.transientGain; // additiv
      if (val > 1) val = 1;
    }

    // Floor + Gamma — engine arbetar i pct-domän (0–100) och avrundar till heltal
    // EFTER gamma men FÖRE punch-check. Måste speglas exakt eller blir små
    // slider-justeringar (särskilt kring golv/punch-tröskel) icke-monotona.
    const floorPct = cal.brightnessFloor; // 0–25 (procent)
    let pct = val * 100;
    if (pct < floorPct) pct = floorPct;

    const pGamma = cal.perceptualGamma ?? 0;
    if (pGamma > 0 && pct > floorPct && pct < 100) {
      const norm = (pct - floorPct) / (100 - floorPct);
      pct = floorPct + Math.pow(Math.max(0, norm), pGamma) * (100 - floorPct);
    }

    // Engine: snabb avrundning + clamp + andra floor-clamp (gamma kan dra under)
    pct = Math.floor(pct + 0.5);
    if (pct > 100) pct = 100;
    if (pct < floorPct) pct = floorPct;

    // Punch white — engine: kontroll på avrundad heltals-pct
    let didPunch = false;
    if ((cal.punchWhiteThreshold ?? 100) < 100 && pct >= cal.punchWhiteThreshold) {
      pct = 100;
      didPunch = true;
    }

    val = pct / 100;
    if (val < 0) val = 0;
    prev = val > 1 ? 1 : val;
    values.push(val);
    rising.push(isRising);
    punched.push(didPunch);
  }
  return { values, rising, punched };
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

    const { values: processed, rising, punched } = processCurve(RAW_CURVE, cal);
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

    // Floor reference line
    const floorVal = cal.brightnessFloor / 100;
    if (floorVal > 0.005) {
      const fy = toY(floorVal);
      ctx.beginPath();
      ctx.moveTo(0, fy);
      ctx.lineTo(w, fy);
      ctx.strokeStyle = "rgba(120,180,255,0.25)";
      ctx.setLineDash([2 * dpr, 3 * dpr]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
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

    // Processed curve — segmented per step:
    //   punched=white, rising=attack-color, falling=release-color
    ctx.setLineDash([]);
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const ATTACK_COLOR = "rgb(255,200,60)";
    const RELEASE_COLOR = "rgb(255,90,140)";
    const PUNCH_COLOR = "rgb(255,255,255)";
    for (let i = 0; i < CURVE_POINTS - 1; i++) {
      const x0 = i * step;
      const x1 = (i + 1) * step;
      const y0 = toY(processed[i]);
      const y1 = toY(processed[i + 1]);
      const isPunch = punched[i + 1] || punched[i];
      ctx.strokeStyle = isPunch ? PUNCH_COLOR : (rising[i + 1] ? ATTACK_COLOR : RELEASE_COLOR);
      ctx.lineWidth = isPunch ? 3 * dpr : 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // Fill under processed (neutral tint)
    const grad = ctx.createLinearGradient(0, pad, 0, pad + ch);
    grad.addColorStop(0, "rgba(255,120,50,0.25)");
    grad.addColorStop(1, "rgba(255,120,50,0)");
    ctx.beginPath();
    ctx.moveTo(0, toY(processed[0]));
    for (let i = 1; i < CURVE_POINTS; i++) {
      ctx.lineTo(i * step, toY(processed[i]));
    }
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
        <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-1.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t border-dashed" style={{ borderColor: "rgba(255,255,255,0.4)" }} /> Rå (in)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t-2" style={{ borderColor: "rgb(255,200,60)" }} /> Attack (rise)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t-2" style={{ borderColor: "rgb(255,90,140)" }} /> Release (fall)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t-[3px]" style={{ borderColor: "rgb(255,255,255)" }} /> Punch white (≥ tröskel)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t border-dashed" style={{ borderColor: "rgba(120,180,255,0.6)" }} /> Golv (min)
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

/* ── Auto-tune anti-flicker panel ──
 * Mäter pct-rörelser i 30s, föreslår maxFallPerSec + flickerDeadband.
 * Kräver att musik spelas. Skriver i aktiv profil när användaren accepterar. */
function AutoTuneAntiFlickerPanel({
  piBase, cal, setCal,
}: {
  piBase: string;
  cal: typeof DEFAULT_CAL;
  setCal: (c: typeof DEFAULT_CAL) => void;
}) {
  const [status, setStatus] = useState<{
    active: boolean; elapsedMs: number; durationMs: number; sampleCount: number;
    progress: number; done: boolean;
    suggestion?: { maxFallPerSec: number; flickerDeadband: number; flickerScore: number; samplesUsed: number; sampleRateHz: number; isPlaying: boolean };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(30);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const fetchStatus = async () => {
    try {
      const r = await fetch(`${piBase}/api/autotune/status`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setStatus(j);
      if (!j.active) stopPoll();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const start = async () => {
    setError(null);
    try {
      const r = await fetch(`${piBase}/api/autotune/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: duration * 1000 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      stopPoll();
      pollRef.current = setInterval(fetchStatus, 500);
      fetchStatus();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const cancel = async () => {
    stopPoll();
    try { await fetch(`${piBase}/api/autotune/cancel`, { method: 'POST' }); } catch {}
    setStatus(null);
  };

  const apply = async () => {
    if (!status?.suggestion) return;
    const body: Record<string, number> = { flickerDeadband: status.suggestion.flickerDeadband };
    try {
      const r = await fetch(`${piBase}/api/autotune/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Spegla i lokal cal-state så slidrarna uppdateras direkt
      setCal({ ...cal, ...body } as typeof DEFAULT_CAL);
      setStatus(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  useEffect(() => () => stopPoll(), []);

  // Status-derivat
  const running = !!status?.active;
  const done = !!status?.done && !!status?.suggestion;
  const progress = status?.progress ?? 0;
  const elapsed = status ? Math.round(status.elapsedMs / 1000) : 0;
  const total = status ? Math.round(status.durationMs / 1000) : duration;
  const sug = status?.suggestion;

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Auto-tune anti-fladder
        </h3>
        {!running && !done && (
          <select
            value={duration}
            onChange={(e) => setDuration(parseInt(e.target.value, 10))}
            className="text-[11px] bg-secondary text-foreground rounded px-1.5 py-0.5"
          >
            <option value={15}>15s</option>
            <option value={30}>30s</option>
            <option value={60}>60s</option>
          </select>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground leading-snug">
        Spela en låt som brukar fladdra. Mätningen registrerar varje pct-rörelse och
        föreslår en lämplig deadband-tröskel.
      </p>

      {error && (
        <div className="text-[10px] text-destructive">⚠ {error}</div>
      )}

      {!running && !done && (
        <button
          onClick={start}
          className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium active:scale-95 transition-transform"
        >
          🎚 Starta {duration}s mätning
        </button>
      )}

      {running && (
        <>
          <div className="text-[11px] font-mono text-muted-foreground flex justify-between">
            <span>{elapsed}s / {total}s</span>
            <span>{status?.sampleCount ?? 0} samples</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
          <button
            onClick={cancel}
            className="w-full py-1.5 rounded-lg bg-secondary text-secondary-foreground text-[11px] font-medium active:scale-95 transition-transform"
          >
            Avbryt
          </button>
        </>
      )}

      {done && sug && (
        <div className="space-y-2">
          {!sug.isPlaying && (
            <div className="text-[10px] text-amber-500">
              ⚠ Mätningen kördes utan playback — förslagen kan vara missvisande.
            </div>
          )}
          <div className="rounded-md bg-background/60 p-2 space-y-1.5">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Fladder-poäng</span>
              <span className="font-mono font-semibold">
                {sug.flickerScore}/100
                <span className="text-muted-foreground ml-1">
                  ({sug.flickerScore < 15 ? 'låg' : sug.flickerScore < 40 ? 'medel' : 'hög'})
                </span>
              </span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Deadband (nu → förslag)</span>
              <span className="font-mono">
                {cal.flickerDeadband.toFixed(3)} → <span className="text-primary font-semibold">{sug.flickerDeadband.toFixed(3)}</span>
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              {sug.samplesUsed} samples @ {sug.sampleRateHz.toFixed(1)} Hz
            </div>
          </div>
          <button
            onClick={apply}
            className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold active:scale-95 transition-transform"
          >
            ✓ Tillämpa deadband-förslag
          </button>
          <button
            onClick={() => setStatus(null)}
            className="w-full py-1 text-[10px] text-muted-foreground active:text-foreground"
          >
            Stäng utan att tillämpa
          </button>
        </div>
      )}
    </div>
  );
}


function ProfileSettingsView({
  cal, setCal, activePreset,
  piBase,
  onBack, onSave, saved, saveError,
}: {
  cal: typeof DEFAULT_CAL; setCal: (c: typeof DEFAULT_CAL) => void;
  activePreset: string;
  piBase: string;
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
        
        <SignalPreview cal={cal} height={180} showLegend={true} />

        <AutoTuneAntiFlickerPanel piBase={piBase} cal={cal} setCal={setCal} />
        
        {SLIDER_CONFIG.map(({ key, label, min, max, step, unit, description }) => {
          const isDyn = key === 'dynamicDamping';
          const isFloor = key === 'brightnessFloor';
          const isTransient = key === 'transientGain';
          const isPerceptual = key === 'perceptualGamma';
          const isOffAtZero = isDyn || isFloor || isTransient || isPerceptual;
          const displayValue = isOffAtZero && cal[key] === 0 ? 'av' : `${cal[key]}${unit ?? ''}`;
          // Tick-position i procent längs slidern där "av"-läget ligger (0)
          const zeroPct = ((0 - min) / (max - min)) * 100;
          const showTick = isOffAtZero && zeroPct > 0 && zeroPct < 100;
          const showSoftnessHeader = key === 'attack';
          return (
            <div key={key}>
              {showSoftnessHeader && (
                <div className="pt-2 pb-1 mb-2 border-t border-border/40">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mjukhet</h3>
                </div>
              )}
              <div className="flex justify-between text-sm mb-0.5">
                <span>{label}</span>
                <span className={`font-mono text-xs ${isOffAtZero && cal[key] === 0 ? 'text-muted-foreground italic' : 'text-muted-foreground'}`}>{displayValue}</span>
              </div>
              <div className="relative">
                <input
                  type="range" min={min} max={max} step={step} value={cal[key]}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (isDyn) {
                      // Slider = enda kontrollen: 0 = av, ≠0 = på
                      setCal({ ...cal, dynamicDamping: v, dynamicsEnabled: v !== 0 });
                    } else {
                      setCal({ ...cal, [key]: v });
                    }
                  }}
                  className="w-full h-2 rounded-full appearance-none bg-secondary accent-primary relative z-10"
                />
                {showTick && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-muted-foreground/60 pointer-events-none z-0"
                    style={{ left: `calc(${zeroPct}% - 1px)` }}
                    aria-hidden
                  />
                )}
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
            </div>
          );
        })}

        {/* Togglar borttagna — Perceptuell kurva & Transient boost är nu sliders i SLIDER_CONFIG ovan */}
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
  const [view, setView] = useState<"home" | "profile" | "global">("home");
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
  const [updateStatus, setUpdateStatus] = useState<'checking' | 'running' | 'uptodate' | 'done' | 'error' | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bleHardcodedConnected, setBleHardcodedConnected] = useState(false);
  const [bleEngineReady, setBleEngineReady] = useState(false);
  const [startAllOk, setStartAllOk] = useState(false);
  const [piVersion, setPiVersion] = useState<{ version: string; commitShort: string; branch: string } | null>(null);
  const [engineUptime, setEngineUptime] = useState<number | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [updatePhase, setUpdatePhase] = useState<'idle' | 'stopping' | 'downloading' | 'starting'>('idle');
  const [piOnline, setPiOnline] = useState<boolean | null>(null);
  const [engineStatus, setEngineStatus] = useState<{ running: boolean; hz: number; tickMs: number } | null>(null);
  const engineVersionLabel = cleanVersionLabel(piVersion?.version);
  const engineBuildLabel = cleanBuildLabel(piVersion?.commitShort, piVersion?.branch);
  const [sonosPlaying, setSonosPlaying] = useState(false);
  const [sonosState, setSonosState] = useState<string | null>(null);
  const [lifecycleState, setLifecycleState] = useState<string | null>(null);
  const [lifecycleOverride, setLifecycleOverride] = useState(false);
  const [pendingShutdownInMs, setPendingShutdownInMs] = useState<number | null>(null);
  const [subsystems, setSubsystems] = useState<Record<string, { status: string }> | null>(null);
  const [bleConnected, setBleConnected] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
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
          maxRisePerSec: p.maxRisePerSec,
          maxFallPerSec: p.maxFallPerSec,
          flickerDeadband: p.flickerDeadband,
          hiShelfGainDb: 6,
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
          saturation: c?.saturation ?? DEFAULT_CAL.saturation,
          dynamicsEnabled: c?.dynamicsEnabled ?? DEFAULT_CAL.dynamicsEnabled,
          onsetThreshold: c?.onsetThreshold ?? DEFAULT_CAL.onsetThreshold,
          onsetRefractoryMs: c?.onsetRefractoryMs ?? DEFAULT_CAL.onsetRefractoryMs,
          onsetEnergyFloor: c?.onsetEnergyFloor ?? DEFAULT_CAL.onsetEnergyFloor,
          maxRisePerSec: c?.maxRisePerSec ?? DEFAULT_CAL.maxRisePerSec,
          maxFallPerSec: c?.maxFallPerSec ?? DEFAULT_CAL.maxFallPerSec,
          flickerDeadband: c?.flickerDeadband ?? DEFAULT_CAL.flickerDeadband,
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
        if (typeof data.uptime === 'number') setEngineUptime(data.uptime);
        if (data.engine) setEngineStatus({ running: data.engine.running, hz: data.engine.hz, tickMs: data.engine.tickMs });
        setSonosPlaying(typeof data.sonos?.playbackState === 'string' && data.sonos.playbackState.includes('PLAYING'));
        setSonosState(typeof data.sonos?.playbackState === 'string' ? data.sonos.playbackState : null);
        setLifecycleState(data.lifecycle?.state ?? null);
        setLifecycleOverride(!!data.lifecycle?.manualOverrideOff);
        setPendingShutdownInMs(
          typeof data.lifecycle?.pendingShutdownInMs === 'number'
            ? data.lifecycle.pendingShutdownInMs
            : null,
        );
        setSubsystems(data.subsystems ?? null);
        setBleConnected(!!data.ble?.connected);

      } catch {
        if (!cancelled) setPiOnline(false);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [view, piBase]);

  // Poll latest available version every 5 min (and once at mount when online)
  useEffect(() => {
    if (view !== 'home' || piOnline !== true) return;
    let cancelled = false;
    const checkLatest = async () => {
      try {
        const r = await fetch(`${piBase}/api/update/check`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok || cancelled) return;
        const data = await r.json();
        if (cancelled || data.error) return;
        if (data.latestVersion) setLatestVersion(data.latestVersion);
      } catch { /* nätverksfel — försök igen nästa intervall */ }
    };
    checkLatest();
    const id = setInterval(checkLatest, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [view, piBase, piOnline]);

  // "Tvångs-uppdatera": stoppa engine → kör force-update → backend startar om service
  const runForceUpdate = async () => {
    if (updatePhase !== 'idle') return;
    setUpdatePhase('downloading');
    setUpdateStatus('running');
    try {
      // /api/update/force triggar update-script som:
      //   1. Stoppar systemd-tjänsten (= motor stängs ner)
      //   2. Hämtar + installerar ny tarball
      //   3. Startar tjänsten igen (= motor startar med ny version)
      // Vi visar bara faserna i UI:t baserat på poll-svar.
      await fetch(`${piBase}/api/update/force`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      setUpdatePhase('starting');
      // Step 3: Polla tills update done OCH service tillbaka online
      const poll = setInterval(async () => {
        try {
          const s = await fetch(`${piBase}/api/update/status`, { signal: AbortSignal.timeout(3000) });
          const sd = await s.json();
          if (!sd.running) {
            // Verifiera att engine svarar igen
            try {
              const v = await fetch(`${piBase}/api/status`, { signal: AbortSignal.timeout(2000) });
              if (v.ok) {
                clearInterval(poll);
                // Tvinga ny version-hämtning så v-raden uppdateras direkt
                try {
                  const fresh = await v.json();
                  if (fresh?.version) setPiVersion({ version: fresh.version, commitShort: fresh.commit ?? '?', branch: fresh.branch ?? '?' });
                } catch {}
                setUpdatePhase('idle');
                setUpdateStatus('done');
                setTimeout(() => setUpdateStatus(null), 4000);
              }
            } catch { /* engine ännu inte uppe — fortsätt polla */ }
          }
        } catch { /* service kanske startar om — fortsätt polla */ }
      }, 2500);
      // Säkerhetsstopp efter 3 min
      setTimeout(() => { clearInterval(poll); if (updatePhase !== 'idle') { setUpdatePhase('idle'); setUpdateStatus('error'); setTimeout(() => setUpdateStatus(null), 4000); } }, 180000);
    } catch {
      setUpdatePhase('idle');
      setUpdateStatus('error');
      setTimeout(() => setUpdateStatus(null), 4000);
    }
  };


  if (view === "profile") {
    return (
      <ProfileSettingsView
        cal={cal} setCal={setCal} activePreset={activePreset}
        piBase={piBase}
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

      {/* (LiveStrip flyttad — visas precis ovanför profilknapparna nedan) */}

      {/* 0. Permissions self-check — varnar om PCC hoppade över setup-lotus.sh */}
      <PermissionsBanner piBase={piBase} />

      {/* Förenklad start: en knapp kör Motor → Mic → Sonos → Lampa i sekvens */}
      <StartAllPanel
        piBase={piBase}
        onEngineReadyChange={setBleEngineReady}
        onAllOkChange={setStartAllOk}
      />

      {/* Allt nedanför kräver att frontend når Pi:n OCH att motorn faktiskt
          körs — annars är slidrar/profiler/livestrip meningslösa.
          Dolt (inte bara disabled) för att undvika visuell brus innan ready. */}
      {(() => {
        const ready = piOnline === true && engineStatus?.running === true;
        if (!ready) {
          return (
            <div className="my-4 rounded-xl border border-border bg-card/40 p-4 text-center text-xs text-muted-foreground">
              Väntar på motor och frontend…
            </div>
          );
        }
        return (
          <>
            {/* Avancerat: per-steg-kontroll — visas BARA om Starta-allt inte är klart
                (dvs. när användaren behöver felsöka eller starta delsystem manuellt) */}
            {!startAllOk && (
              <details className="rounded-xl border border-border bg-card/40">
                <summary className="cursor-pointer select-none px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
                  Avancerat — starta delsystem individuellt
                </summary>
                <div className="space-y-3 p-3 pt-0">
                  <BleControlPanel
                    piBase={piBase}
                    section="engine"
                    onEngineReadyChange={setBleEngineReady}
                  />
                  <SubsystemStartupPanel piBase={piBase} enabled={bleEngineReady} />
                  <BleControlPanel
                    piBase={piBase}
                    section="lamp"
                    onConnectedChange={setBleHardcodedConnected}
                    onEngineReadyChange={setBleEngineReady}
                  />
                </div>
              </details>
            )}

            {/* Restart-historik — alltid synlig så vi ser om motorn dör ofta */}
            <RestartHistoryPanel piBase={piBase} />

            {saveError && (
              <div className="mb-4 mt-4 p-3 rounded-lg bg-destructive/20 border border-destructive/40 text-destructive text-xs">
                ⚠ Sparning misslyckades: {saveError}
              </div>
            )}

            {/* Realtidsstatus precis ovanför profilknapparna */}
            <div className="mb-4 mt-4">
              <LiveStrip />
            </div>

            <section className="mb-8">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Profil</h2>
              <div className="grid grid-cols-2 gap-3">
                {PRESETS.map((name) => (
                  <button
                    key={name}
                    onClick={() => {
                      setActivePreset(name);
                      fetch(`${piBase}/api/active-preset`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name }),
                        signal: AbortSignal.timeout(3000),
                      }).catch(() => {});
                    }}
                    className={`py-4 rounded-xl text-sm font-medium transition-all active:scale-95 ${
                      activePreset === name
                        ? "bg-primary text-primary-foreground ring-2 ring-ring"
                        : "bg-secondary text-secondary-foreground"
                    }`}
                  >{name}</button>
                ))}
              </div>
            </section>
          </>
        );
      })()}

      {/* Motor / Version — flyttad längst ner.
          "Tvinga uppdatering"-knappen är borttagen; force-update finns kvar
          via versionssymbolen i toppraden (lång-tryck) ifall den behövs. */}
      <div className="mt-6 mb-4 text-[10px] text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${piOnline === true ? 'bg-green-500' : piOnline === false ? 'bg-destructive' : 'bg-muted-foreground animate-pulse'}`} />
            <span>Frontend</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${engineStatus?.running ? 'bg-green-500' : piOnline === false ? 'bg-destructive' : 'bg-muted-foreground animate-pulse'}`} />
            <span>Motor {engineStatus ? (engineStatus.running ? `${engineStatus.hz} Hz` : 'Stoppad') : '…'}</span>
            {engineUptime != null && (
              <span className="opacity-60 font-mono">· {formatUptime(engineUptime)}</span>
            )}
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
          {lifecycleState && (() => {
            // Bil-tändning: IGNITION = IGN (gul), MOTOR_ON = ON (grön),
            // IGNITION_OFF = OFF (röd, manuell override).
            const label =
              lifecycleState === 'MOTOR_ON' ? 'ON' :
              lifecycleState === 'IGNITION_OFF' ? 'OFF' : 'IGN';
            const dot =
              lifecycleState === 'MOTOR_ON' ? 'bg-green-500' :
              lifecycleState === 'IGNITION_OFF' ? 'bg-destructive' :
              'bg-amber-500';
            return (
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                <span>Tändning {label}</span>
                {pendingShutdownInMs != null && pendingShutdownInMs > 0 && (
                  <span className="opacity-60 font-mono">· shutdown {Math.ceil(pendingShutdownInMs / 100) / 10}s</span>
                )}
                {lifecycleOverride && lifecycleState !== 'IGNITION_OFF' && (
                  <span className="opacity-60 font-mono">· override</span>
                )}
              </div>
            );
          })()}
          {(engineVersionLabel || engineBuildLabel) && (
            <div className="flex flex-col items-end font-mono leading-tight text-right">
              {engineVersionLabel && <span>v{engineVersionLabel}</span>}
              {engineBuildLabel && <span>{engineBuildLabel}</span>}
            </div>
          )}
        </div>
      </div>

      {/* BLE-enhet hanteras nu helt av BleControlPanel ovan (hårdkodad ELK-BLEDOM01).
          Sök/manuell-MAC/spara/glöm är medvetet borttaget i denna iteration. */}

      {/* Diagnostik medvetet borttaget — UI är minimalt fokuserat på Starta motor + Anslut.
          Engine-loggen är borttagen — felsök via SSH/journalctl istället. */}

    </div>
  );
}