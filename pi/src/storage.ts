/**
 * File-based storage — drop-in replacement for localStorage on Pi.
 * Stores persisted settings in the app's own data directory so they survive updates
 * and do not depend on HOME being set or writable under the service manager.
 *
 * Persistence-garantier:
 * 1. update-services.sh rör ALDRIG pi/data/ (endast dist/, node_modules/, vendor/).
 * 2. setup-lotus.sh kör endast `mkdir -p` + `chown -R` på pi/data — innehåll bevaras.
 * 3. Om DATA_DIR-pathen byter mellan boots (t.ex. PCC_CONFIG_DIR sätts/avsätts),
 *    migrerar vi automatiskt befintliga *.json-filer från known legacy-paths så
 *    profiler och kalibrering inte "försvinner".
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, copyFileSync } from 'fs';
import { join } from 'path';

// PCC-styrd config-katalog vinner. LOTUS_DATA_DIR är legacy override.
// Sista fallback är hårdkodad path för standalone-install (utan PCC).
const DATA_DIR =
  process.env.PCC_CONFIG_DIR ||
  process.env.LOTUS_DATA_DIR ||
  '/opt/lotus-light/pi/data';

// Kända legacy-paths att leta efter vid migration. Ordningen spelar roll —
// första träffen vinner. Vi migrerar ENDAST om aktiv DATA_DIR är tom, så vi
// aldrig skriver över nyare data.
const LEGACY_PATHS = [
  '/opt/lotus-light/pi/data',
  process.env.LOTUS_DATA_DIR,
  process.env.PCC_CONFIG_DIR,
].filter((p): p is string => !!p && p !== DATA_DIR);

let migrationDone = false;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!migrationDone) {
    migrationDone = true;
    migrateFromLegacyIfEmpty();
  }
}

function migrateFromLegacyIfEmpty(): void {
  try {
    const existing = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
    if (existing.length > 0) return; // aktiv dir har data — rör inget
    for (const legacy of LEGACY_PATHS) {
      if (!existsSync(legacy)) continue;
      let files: string[] = [];
      try { files = readdirSync(legacy).filter((f) => f.endsWith('.json')); } catch { continue; }
      if (files.length === 0) continue;
      for (const f of files) {
        try { copyFileSync(join(legacy, f), join(DATA_DIR, f)); } catch {}
      }
      console.log(`[storage] Migrerade ${files.length} settings-fil(er) från ${legacy} → ${DATA_DIR}`);
      return;
    }
  } catch {}
}

function filePath(key: string): string {
  return join(DATA_DIR, `${key}.json`);
}

export function getItem(key: string): string | null {
  try {
    ensureDataDir();
    return readFileSync(filePath(key), 'utf-8');
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string): void {
  ensureDataDir();
  writeFileSync(filePath(key), value, 'utf-8');
}

export function removeItem(key: string): void {
  try {
    ensureDataDir();
    unlinkSync(filePath(key));
  } catch {}
}

/**
 * Shim global localStorage for engine modules that import it directly.
 */
export function installLocalStorageShim(): void {
  ensureDataDir();
  (globalThis as any).localStorage = { getItem, setItem, removeItem };
  (globalThis as any).window = (globalThis as any).window ?? {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
}
