// Light calibration — simplified for RMS→brightness model
// Persisted in localStorage only. Cloud sync handled externally.

import { type AgcVolumeTable, migrateToVolumeTable, createVolumeTable } from './agc';

const STORAGE_KEY = 'light-calibration';
const DEVICE_STORAGE_KEY = 'light-calibration-device';
const IDLE_COLOR_KEY = 'idle-color';
const PRESETS_KEY = 'calibration-presets';
const ACTIVE_PRESET_KEY = 'active-preset';

const DEFAULT_IDLE_COLOR: [number, number, number] = [255, 60, 0];

export function getIdleColor(): [number, number, number] {
  try {
    const stored = localStorage.getItem(IDLE_COLOR_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length === 3) return parsed as [number, number, number];
    }
  } catch {}
  return [...DEFAULT_IDLE_COLOR];
}

export function saveIdleColor(color: [number, number, number]): void {
  localStorage.setItem(IDLE_COLOR_KEY, JSON.stringify(color));
}

export interface LightCalibration {
  gammaR: number;
  gammaG: number;
  gammaB: number;
  offsetR: number;
  offsetG: number;
  offsetB: number;
  attackAlpha: number;
  releaseAlpha: number;
  dynamicDamping: number;
  bassWeight: number;
  hiShelfGainDb: number;
  bandAgcAttack: number;
  bandAgcDecay: number;
  volCompensation: number;
  punchWhiteThreshold: number;
  smoothing: number;
  brightnessFloor: number;
  paletteRotation: boolean;
  paletteRotationSpeed: number;
  agcVolumeTable: AgcVolumeTable;
}

export const DEFAULT_CALIBRATION: LightCalibration = {
  gammaR: 1.0, gammaG: 1.0, gammaB: 1.0,
  offsetR: 0, offsetG: 0, offsetB: 0,
  attackAlpha: 0.3, releaseAlpha: 0.025, dynamicDamping: -1.0,
  bassWeight: 0.7, hiShelfGainDb: 6,
  bandAgcAttack: 0.15, bandAgcDecay: 0.997,
  volCompensation: 80, punchWhiteThreshold: 100,
  smoothing: 0, brightnessFloor: 0,
  paletteRotation: false, paletteRotationSpeed: 8,
  agcVolumeTable: {},
};

export function getCalibration(): LightCalibration {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_CALIBRATION };
    const parsed = JSON.parse(stored);

    // Migrate old agcMax/agcMin/agcVolume → agcVolumeTable
    if (!parsed.agcVolumeTable && (parsed.agcMax != null || parsed.agcVolume != null)) {
      parsed.agcVolumeTable = migrateToVolumeTable(
        parsed.agcMax ?? 0.01,
        parsed.agcVolume ?? null,
      );
      delete parsed.agcMax;
      delete parsed.agcMin;
      delete parsed.agcVolume;
      // Save migrated version
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    }

    return { ...DEFAULT_CALIBRATION, ...parsed, agcVolumeTable: parsed.agcVolumeTable ?? {} };
  } catch {
    return { ...DEFAULT_CALIBRATION };
  }
}

/** Optional cloud save hook — set externally to enable cloud persistence */
let _cloudSaveHook: ((deviceName: string, patch: Record<string, unknown>, createNew: boolean) => void) | null = null;

export function setCloudSaveHook(hook: typeof _cloudSaveHook): void {
  _cloudSaveHook = hook;
}

export function saveCalibration(cal: LightCalibration, deviceName?: string, { localOnly = false, createNewEntry = false } = {}): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
  window.dispatchEvent(new CustomEvent('calibration-changed'));
  if (localOnly) return;
  const name = deviceName ?? getActiveDeviceName();
  if (name && _cloudSaveHook) {
    _cloudSaveHook(name, { calibration: cal }, createNewEntry);
  }
}

export function setActiveDeviceName(name: string) {
  localStorage.setItem(DEVICE_STORAGE_KEY, name);
}

export function getActiveDeviceName(): string | null {
  return localStorage.getItem(DEVICE_STORAGE_KEY) || null;
}

export function applyColorCalibration(
  r: number, g: number, b: number,
  cal?: LightCalibration,
): [number, number, number] {
  const c = cal ?? getCalibration();
  const apply = (val: number, gamma: number, offset: number) => {
    const normalized = Math.max(0, Math.min(1, val / 255));
    const corrected = Math.pow(normalized, gamma) * 255 + offset;
    return Math.max(0, Math.min(255, Math.round(corrected)));
  };
  return [
    apply(r, c.gammaR, c.offsetR),
    apply(g, c.gammaG, c.offsetG),
    apply(b, c.gammaB, c.offsetB),
  ];
}

/* ── Presets ── */

export const PRESET_NAMES = ['Lugn', 'Normal', 'Party', 'Custom'] as const;
export type PresetName = typeof PRESET_NAMES[number];

const BUILT_IN_PRESETS: Record<PresetName, Partial<LightCalibration>> = {
  Lugn: { attackAlpha: 0.08, releaseAlpha: 0.01, dynamicDamping: 1.5, bassWeight: 0.5, punchWhiteThreshold: 100 },
  Normal: {},
  Party: { attackAlpha: 0.6, releaseAlpha: 0.08, dynamicDamping: -2.0, bassWeight: 0.85, punchWhiteThreshold: 95, paletteRotation: true, paletteRotationSpeed: 6 },
  Custom: {},
};

function _defaultPresets(): Record<PresetName, LightCalibration> {
  const out = {} as Record<PresetName, LightCalibration>;
  for (const name of PRESET_NAMES) {
    out[name] = { ...DEFAULT_CALIBRATION, ...BUILT_IN_PRESETS[name] };
  }
  return out;
}

export function getPresets(): Record<PresetName, LightCalibration> {
  try {
    const stored = localStorage.getItem(PRESETS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const defaults = _defaultPresets();
      for (const name of PRESET_NAMES) {
        if (parsed[name]) defaults[name] = { ...DEFAULT_CALIBRATION, ...parsed[name] };
      }
      return defaults;
    }
  } catch {}
  return _defaultPresets();
}

export function savePresetCalibration(name: PresetName, cal: LightCalibration): void {
  const presets = getPresets();
  presets[name] = cal;
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

export function getActivePreset(): PresetName | null {
  return (localStorage.getItem(ACTIVE_PRESET_KEY) as PresetName) || null;
}

export function setActivePreset(name: PresetName | null): void {
  if (name) localStorage.setItem(ACTIVE_PRESET_KEY, name);
  else localStorage.removeItem(ACTIVE_PRESET_KEY);
}
