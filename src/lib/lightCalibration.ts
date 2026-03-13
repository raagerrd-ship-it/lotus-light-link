// Light calibration — simplified for RMS→brightness model

const STORAGE_KEY = 'light-calibration';

export interface LightCalibration {
  // Color correction
  gammaR: number;      // 0.5–2.5
  gammaG: number;
  gammaB: number;
  offsetR: number;     // -30 to +30
  offsetG: number;
  offsetB: number;
  saturationBoost: number; // 0.5–2.0

  // Brightness & dynamics
  minBrightness: number;   // 0–30 (%)
  maxBrightness: number;   // 30–100 (%)
  attackAlpha: number;      // 0.05–0.9
  releaseAlpha: number;     // 0.01–0.3

  // White kick
  whiteKickThreshold: number; // 80–100 (%)
  whiteKickMs: number;        // 50–300 (ms)

  // BLE latency compensation (ms)
  bleLatencyMs: number;
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
  attackAlpha: 0.3,
  releaseAlpha: 0.05,

  whiteKickThreshold: 95,
  whiteKickMs: 100,

  bleLatencyMs: 0,
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

  let rr = r, gg = g, bb = b;
  if (c.saturationBoost !== 1.0) {
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    rr = gray + (r - gray) * c.saturationBoost;
    gg = gray + (g - gray) * c.saturationBoost;
    bb = gray + (b - gray) * c.saturationBoost;
  }

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
