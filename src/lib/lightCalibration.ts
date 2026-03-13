// Light calibration system — all tuneable parameters with localStorage persistence

const STORAGE_KEY = 'light-calibration';

export interface LightCalibration {
  // Color
  gammaR: number;      // 0.5–2.5
  gammaG: number;
  gammaB: number;
  offsetR: number;     // -30 to +30
  offsetG: number;
  offsetB: number;
  saturationBoost: number; // 0.5–2.0

  // Brightness & Dynamics
  minBrightness: number;   // 0–30 (%)
  maxBrightness: number;   // 30–100 (%)
  attackAlpha: number;     // 0.1–0.9
  releaseAlpha: number;    // 0.02–0.2
  dynamicDamping: number;  // 1.0–3.0

  // Beat & Timing
  punchWhiteThreshold: number; // 60–95 (%)
  fadeBackDuration: number;    // 100–800 (ms, minimum)
  bleLatencyMs: number;        // 0–150 (ms)
  groovePhaseGate: number;     // 0.1–0.5

  // Ambient
  ambientEma: number;       // 0.7–0.98
  silenceFadeMs: number;    // 500–5000 (ms)
  baselinePct: number;      // 3–20 (%)

  // Auto-calibration
  latencyOffsetMs: number;   // -500 to +500 (ms)
}

export const DEFAULT_CALIBRATION: LightCalibration = {
  gammaR: 1.0,
  gammaG: 1.0,
  gammaB: 1.0,
  offsetR: 0,
  offsetG: 0,
  offsetB: 0,
  saturationBoost: 1.0,

  minBrightness: 3,
  maxBrightness: 100,
  attackAlpha: 0.5,
  releaseAlpha: 0.08,
  dynamicDamping: 1.0,

  punchWhiteThreshold: 85,
  fadeBackDuration: 320,
  bleLatencyMs: 50,
  groovePhaseGate: 0.3,

  ambientEma: 0.85,
  silenceFadeMs: 1500,
  baselinePct: 6,
};

export function getCalibration(): LightCalibration {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_CALIBRATION };
    return { ...DEFAULT_CALIBRATION, ...JSON.parse(stored) };
  } catch {
    return { ...DEFAULT_CALIBRATION };
  }
}

export function saveCalibration(cal: LightCalibration): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
}

export function resetCalibration(): LightCalibration {
  localStorage.removeItem(STORAGE_KEY);
  return { ...DEFAULT_CALIBRATION };
}

/**
 * Apply color calibration: gamma correction + offset + saturation boost per channel.
 */
export function applyColorCalibration(
  r: number, g: number, b: number,
  cal?: LightCalibration,
): [number, number, number] {
  const c = cal ?? getCalibration();

  // Saturation boost in HSL-ish space
  let rr = r, gg = g, bb = b;
  if (c.saturationBoost !== 1.0) {
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    rr = gray + (r - gray) * c.saturationBoost;
    gg = gray + (g - gray) * c.saturationBoost;
    bb = gray + (b - gray) * c.saturationBoost;
  }

  // Gamma + offset per channel
  const apply = (val: number, gamma: number, offset: number) => {
    const normalized = Math.max(0, Math.min(1, val / 255));
    const corrected = Math.pow(normalized, gamma) * 255 + offset;
    return Math.max(0, Math.min(255, Math.round(corrected)));
  };

  return [
    apply(rr, c.gammaR, c.offsetR),
    apply(gg, c.gammaG, c.offsetG),
    apply(bb, c.gammaB, c.offsetB),
  ];
}
