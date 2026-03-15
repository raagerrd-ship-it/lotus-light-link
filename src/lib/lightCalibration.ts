// Light calibration — simplified for RMS→brightness model
// Persisted in localStorage (fast cache) + Supabase (durable)

import { supabase } from "@/integrations/supabase/client";

const STORAGE_KEY = 'light-calibration';
const DEVICE_STORAGE_KEY = 'light-calibration-device';
const IDLE_COLOR_KEY = 'idle-color';

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
  // Color correction (defaults are neutral)
  gammaR: number;
  gammaG: number;
  gammaB: number;
  offsetR: number;
  offsetG: number;
  offsetB: number;

  // Dynamics
  attackAlpha: number;      // 0.05–0.9
  releaseAlpha: number;     // 0.01–0.3
  dynamicDamping: number;   // <0 = expand, >0 = compress, 0 = neutral

  // Frequency blend
  bassWeight: number;        // 0–1, how much bass affects brightness
  hiShelfGainDb: number;     // 0–12, hi-shelf filter gain for mic compensation

  // Per-band AGC
  bandAgcAttack: number;     // 0.02–0.5
  bandAgcDecay: number;      // 0.990–0.999

  // Volume compensation
  volCompensation: number;   // 0–100 (%)

  // Punch white: brightness above this % → send white
  punchWhiteThreshold: number; // 0 = off, 50–100 typical

  // Learned AGC state (persisted so it survives restarts)
  agcMin: number;
  agcMax: number;
  agcVolume: number | null;
}

export const DEFAULT_CALIBRATION: LightCalibration = {
  gammaR: 1.0,
  gammaG: 1.0,
  gammaB: 1.0,
  offsetR: 0,
  offsetG: 0,
  offsetB: 0,

  attackAlpha: 0.3,
  releaseAlpha: 0.025,
  dynamicDamping: 1.0,

  bassWeight: 0.7,
  hiShelfGainDb: 6,

  bandAgcAttack: 0.15,
  bandAgcDecay: 0.997,

  volCompensation: 80,

  punchWhiteThreshold: 0,

  agcMin: 0,
  agcMax: 0.01,
  agcVolume: null,
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

export function saveCalibration(cal: LightCalibration, deviceName?: string, { localOnly = false, createNewEntry = false } = {}): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
  window.dispatchEvent(new CustomEvent('calibration-changed'));
  if (localOnly) return;
  const name = deviceName ?? getActiveDeviceName();
  if (name) {
    _upsertCloud(name, { calibration: cal }, createNewEntry);
  }
}

export function setActiveDeviceName(name: string) {
  localStorage.setItem(DEVICE_STORAGE_KEY, name);
}

export function getActiveDeviceName(): string | null {
  return localStorage.getItem(DEVICE_STORAGE_KEY) || null;
}

async function _upsertCloud(deviceName: string, patch: Record<string, unknown>, createNewEntry = false) {
  try {
    if (!createNewEntry) {
      const { data: existing } = await (supabase as any)
        .from('device_calibration')
        .select('id')
        .eq('device_name', deviceName)
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

      if (existing?.id) {
        await (supabase as any).from('device_calibration')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
        return;
      }
    }

    await (supabase as any).from('device_calibration').insert(
      { device_name: deviceName, ...patch, updated_at: new Date().toISOString() },
    );
  } catch (e) {
    console.warn('[calibration] cloud upsert failed', e);
  }
}

export async function loadCalibrationFromCloud(deviceName: string): Promise<{
  calibration: LightCalibration;
} | null> {
  try {
    const { data, error } = await (supabase as any)
      .from('device_calibration')
      .select('calibration')
      .eq('device_name', deviceName)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    if (error || !data) return null;

    const cal = { ...DEFAULT_CALIBRATION, ...(data.calibration as object) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
    return { calibration: cal as LightCalibration };
  } catch {
    return null;
  }
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
