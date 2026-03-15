// Cloud persistence for calibration data — user-scoped (Lovable Cloud)

import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_CALIBRATION, setCloudSaveHook, getPresets, getActivePreset, savePresetCalibration, setActivePreset, getIdleColor, saveIdleColor, type LightCalibration, type PresetName, PRESET_NAMES } from "@/lib/engine/lightCalibration";
import { getSavedDeviceMode, setDeviceMode } from "@/lib/engine/bledom";

const STORAGE_KEY = 'light-calibration';

let _currentUserId: string | null = null;

/** Set current user id for cloud operations */
export function setCloudUserId(userId: string | null): void {
  _currentUserId = userId;
}

/** Install the cloud save hook so saveCalibration() auto-syncs when logged in */
export function installCloudSync(): void {
  setCloudSaveHook((deviceName, patch, createNew) => {
    if (!_currentUserId) return;
    _upsertCloud(deviceName, patch, createNew);
  });
}

async function _upsertCloud(deviceName: string, patch: Record<string, unknown>, createNewEntry = false) {
  if (!_currentUserId) return;
  try {
    if (!createNewEntry) {
      const { data: existing } = await (supabase as any)
        .from('device_calibration')
        .select('id')
        .eq('device_name', deviceName)
        .eq('user_id', _currentUserId)
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
      { device_name: deviceName, user_id: _currentUserId, ...patch, updated_at: new Date().toISOString() },
    );
  } catch (e) {
    console.warn('[calibration] cloud upsert failed', e);
  }
}

export async function loadCalibrationFromCloud(deviceName: string): Promise<{
  calibration: LightCalibration;
} | null> {
  if (!_currentUserId) return null;
  try {
    const { data, error } = await (supabase as any)
      .from('device_calibration')
      .select('calibration')
      .eq('device_name', deviceName)
      .eq('user_id', _currentUserId)
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

/** Sync user_settings (presets, device modes, idle color) to cloud */
export async function saveSettingsToCloud(): Promise<void> {
  if (!_currentUserId) return;
  try {
    const payload = {
      user_id: _currentUserId,
      presets: getPresets(),
      device_modes: _getAllDeviceModes(),
      idle_color: getIdleColor(),
      active_preset: getActivePreset(),
      color_source: localStorage.getItem('colorSource') || 'proxy',
      manual_color: JSON.parse(localStorage.getItem('manualColor') || '[255,80,0]'),
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await (supabase as any)
      .from('user_settings')
      .select('id')
      .eq('user_id', _currentUserId)
      .single();

    if (existing?.id) {
      await (supabase as any).from('user_settings')
        .update(payload)
        .eq('id', existing.id);
    } else {
      await (supabase as any).from('user_settings').insert(payload);
    }
  } catch (e) {
    console.warn('[settings] cloud save failed', e);
  }
}

/** Load user_settings from cloud and apply to localStorage */
export async function loadSettingsFromCloud(): Promise<void> {
  if (!_currentUserId) return;
  try {
    const { data, error } = await (supabase as any)
      .from('user_settings')
      .select('*')
      .eq('user_id', _currentUserId)
      .single();
    if (error || !data) return;

    // Apply presets
    if (data.presets && typeof data.presets === 'object') {
      for (const name of PRESET_NAMES) {
        if (data.presets[name]) {
          savePresetCalibration(name, { ...DEFAULT_CALIBRATION, ...data.presets[name] });
        }
      }
    }

    // Apply active preset
    if (data.active_preset) {
      setActivePreset(data.active_preset as PresetName);
    }

    // Apply idle color
    if (Array.isArray(data.idle_color) && data.idle_color.length === 3) {
      saveIdleColor(data.idle_color as [number, number, number]);
    }

    // Apply device modes
    if (data.device_modes && typeof data.device_modes === 'object') {
      for (const [deviceId, mode] of Object.entries(data.device_modes)) {
        setDeviceMode(deviceId, mode as any);
      }
    }
  } catch (e) {
    console.warn('[settings] cloud load failed', e);
  }
}

function _getAllDeviceModes(): Record<string, string> {
  // Collect all saved device modes from localStorage
  const modes: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('ble-device-mode-')) {
        const deviceId = key.replace('ble-device-mode-', '');
        modes[deviceId] = localStorage.getItem(key) || 'rgb';
      }
    }
  } catch {}
  return modes;
}
