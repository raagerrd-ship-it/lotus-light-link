// Light calibration — simplified for RMS→brightness model
// Persisted in localStorage (fast cache) + Supabase (durable)

import { supabase } from "@/integrations/supabase/client";

const STORAGE_KEY = 'light-calibration';
const DEVICE_STORAGE_KEY = 'light-calibration-device';

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

  // BLE latency compensation (ms) — kept for legacy, not actively used
  bleLatencyMs: number;

  // Total chain latency: Sonos timestamp → light visible (ms)
  chainLatencyMs: number;

  // Dynamic damping exponent (1.0 = linear, >1.0 = compress dynamics)
  dynamicDamping: number;

  // Learned AGC state (persisted so it survives restarts)
  agcMin: number;
  agcMax: number;
  agcVolume: number | null; // Sonos volume when AGC was learned
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
  chainLatencyMs: 0,
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

/** Save to localStorage + update latest cloud row (fire-and-forget). 
 *  Set createNewEntry=true for explicit calibration actions (BLE speed, latency tap). */
export function saveCalibration(cal: LightCalibration, deviceName?: string, createNewEntry = false): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
  const name = deviceName ?? getActiveDeviceName();
  if (name) {
    _upsertCloud(name, { calibration: cal }, createNewEntry);
  }
}

export function resetCalibration(): LightCalibration {
  localStorage.removeItem(STORAGE_KEY);
  return { ...DEFAULT_CALIBRATION };
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

/** Save BLE speed results + interval to cloud. */
export function saveBleSpeedToCloud(deviceName: string, bleMinIntervalMs: number, speedResults: Record<string, number>) {
  _upsertCloud(deviceName, {
    ble_min_interval_ms: bleMinIntervalMs,
    ble_speed_results: speedResults,
    calibration: getCalibration(),
  }, true);
}

/** List all calibration entries for a device, newest first. */
export async function listCalibrationsFromCloud(deviceName: string) {
  try {
    const { data, error } = await (supabase as any)
      .from('device_calibration')
      .select('id, device_name, calibration, ble_min_interval_ms, ble_speed_results, latency_results, updated_at')
      .eq('device_name', deviceName)
      .order('updated_at', { ascending: false });
    if (error || !data) return [];
    return data as Array<{
      id: string;
      device_name: string;
      calibration: any;
      ble_min_interval_ms: number | null;
      ble_speed_results: Record<string, number> | null;
      latency_results: LatencyResults | null;
      updated_at: string;
    }>;
  } catch {
    return [];
  }
}

/** Delete a calibration entry by id. */
export async function deleteCalibrationFromCloud(id: string) {
  try {
    await (supabase as any).from('device_calibration').delete().eq('id', id);
  } catch (e) {
    console.warn('[calibration] cloud delete failed', e);
  }
}

export interface LatencyResults {
  tapMs: number | null;
  metroMs: number | null;
  gattRoundtripMs: number | null;
  verifiedAt: string | null;
  verified: boolean;
}

/** Save detailed latency results to cloud. */
export function saveLatencyToCloud(deviceName: string, latency: LatencyResults) {
  _upsertCloud(deviceName, {
    latency_results: latency,
    calibration: getCalibration(),
  });
}

/** Load calibration from cloud for a device. Returns null if not found. */
export async function loadCalibrationFromCloud(deviceName: string): Promise<{
  calibration: LightCalibration;
  bleMinIntervalMs: number | null;
  bleSpeedResults: Record<string, number> | null;
  latencyResults: LatencyResults | null;
} | null> {
  try {
    const { data, error } = await (supabase as any)
      .from('device_calibration')
      .select('calibration, ble_min_interval_ms, ble_speed_results, latency_results')
      .eq('device_name', deviceName)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const cal = { ...DEFAULT_CALIBRATION, ...(data.calibration as object) };
    // Cache locally
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
    return {
      calibration: cal as LightCalibration,
      bleMinIntervalMs: data.ble_min_interval_ms,
      bleSpeedResults: data.ble_speed_results as Record<string, number> | null,
      latencyResults: data.latency_results as LatencyResults | null,
    };
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
