// Cloud persistence for calibration data — project-specific (Supabase)

import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_CALIBRATION, setCloudSaveHook, type LightCalibration } from "@/lib/engine/lightCalibration";

const STORAGE_KEY = 'light-calibration';

/** Install the cloud save hook so saveCalibration() auto-syncs to Supabase */
export function installCloudSync(): void {
  setCloudSaveHook((deviceName, patch, createNew) => {
    _upsertCloud(deviceName, patch, createNew);
  });
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
