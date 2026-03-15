// Light calibration — simplified for RMS→brightness model
// Persisted in localStorage (fast cache) + Supabase (durable)

import { supabase } from "@/integrations/supabase/client";

const STORAGE_KEY = 'light-calibration';
const DEVICE_STORAGE_KEY = 'light-calibration-device';

export interface LightCalibration {
  // Color correction (defaults are neutral — not exposed in UI but used by applyColorCalibration)
  gammaR: number;
  gammaG: number;
  gammaB: number;
  offsetR: number;
  offsetG: number;
  offsetB: number;
  saturationBoost: number;

  // Brightness & dynamics
  minBrightness: number;   // 0–30 (%)
  maxBrightness: number;   // 30–100 (%)
  attackAlpha: number;      // 0.05–0.9
  releaseAlpha: number;     // 0.01–0.3

  // White kick
  whiteKickThreshold: number; // 80–100 (%)
  whiteKickMs: number;        // 50–300 (ms)

  // Dynamic damping (1.0 = linear, >1.0 = compress dynamics)
  dynamicDamping: number;

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
  saturationBoost: 1.0,

  minBrightness: 3,
  maxBrightness: 100,
  attackAlpha: 0.3,
  releaseAlpha: 0.025,

  whiteKickThreshold: 95,
  whiteKickMs: 100,

  dynamicDamping: 1.0,

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

/** Save to localStorage + optionally to cloud.
 *  localOnly=true skips cloud (used for frequent AGC saves).
 *  createNewEntry=true creates a new cloud row (explicit calibration actions). */
export function saveCalibration(cal: LightCalibration, deviceName?: string, { localOnly = false, createNewEntry = false } = {}): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
  // Notify same-tab listeners (StorageEvent only fires cross-tab)
  window.dispatchEvent(new CustomEvent('calibration-changed'));
  if (localOnly) return;
  const name = deviceName ?? getActiveDeviceName();
  if (name) {
    _upsertCloud(name, { calibration: cal }, createNewEntry);
  }
}

// --- Device name tracking ---

export function setActiveDeviceName(name: string) {
  localStorage.setItem(DEVICE_STORAGE_KEY, name);
}

export function getActiveDeviceName(): string | null {
  return localStorage.getItem(DEVICE_STORAGE_KEY) || null;
}

// --- Cloud persistence ---

async function _upsertCloud(deviceName: string, patch: Record<string, unknown>, createNewEntry = false) {
  try {
    if (!createNewEntry) {
      // Update the most recent entry for this device
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

    // Create new row (explicit calibration or first-ever entry)
    await (supabase as any).from('device_calibration').insert(
      { device_name: deviceName, ...patch, updated_at: new Date().toISOString() },
    );
  } catch (e) {
    console.warn('[calibration] cloud upsert failed', e);
  }
}

/** Load calibration from cloud for a device. */
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

    // Cache locally
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
    return { calibration: cal as LightCalibration };
  } catch {
    return null;
  }
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
