/**
 * File-based storage — drop-in replacement for localStorage on Pi.
 *
 * PCC-kontrakt (se .lovable/memory/pi/runtime/pcc-contract.md):
 *   PCC_DATA_DIR   → persistent state, profiler, kalibrering, BLE-state, cache
 *   PCC_CONFIG_DIR → konfiguration/inställningar (settings)
 *   PCC_LOG_DIR    → loggar (används av journal/stdout idag, reserverat)
 *
 * /opt/ är PROGRAMKOD och kan skrivas över vid update — INGET state får sparas där.
 * Vi väljer DATA_DIR (state) och CONFIG_DIR (settings) separat. Om PCC inte sätter
 * variablerna faller vi tillbaka på en path under $HOME (eller /var/lib) — aldrig /opt.
 *
 * Auto-migration: om aktiv DATA_DIR är tom vid boot, kopiera över *.json från kända
 * legacy-paths (gammal /opt/lotus-light/pi/data, gamla env-overrides) så profiler
 * inte "försvinner" när PCC börjar/slutar sätta variablerna.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, copyFileSync, accessSync, constants } from 'fs';
import { join } from 'path';

// Settings vs state separeras enligt PCC-kontrakt. Keys som matchar SETTINGS_KEYS
// hamnar i CONFIG_DIR, övrigt i DATA_DIR. Båda fallback:ar till samma katalog
// utanför /opt om PCC-vars saknas.
const FALLBACK_BASE =
  process.env.LOTUS_DATA_DIR ||
  (process.env.HOME ? join(process.env.HOME, '.local/share/lotus-light') : '/var/lib/lotus-light');

export const DATA_DIR = process.env.PCC_DATA_DIR || FALLBACK_BASE;
export const CONFIG_DIR = process.env.PCC_CONFIG_DIR || DATA_DIR;

// Nycklar som klassas som "settings" (config) snarare än state.
// Allt annat (profiler, kalibrering, parade enheter, device-modes, cache) → DATA_DIR.
const SETTINGS_KEYS = new Set<string>([
  'settings',
  'app-settings',
  'user-settings',
]);

function dirFor(key: string): string {
  return SETTINGS_KEYS.has(key) ? CONFIG_DIR : DATA_DIR;
}

// Kända legacy-paths att leta efter vid migration. Första träffen vinner.
// Migrerar ENDAST om aktiv katalog är tom — vi skriver aldrig över nyare data.
const LEGACY_PATHS = [
  '/opt/lotus-light/pi/data',
  process.env.LOTUS_DATA_DIR,
  process.env.PCC_CONFIG_DIR,
  process.env.PCC_DATA_DIR,
].filter((p): p is string => !!p);

const migrationDone = new Set<string>();

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!migrationDone.has(dir)) {
    migrationDone.add(dir);
    migrateFromLegacyIfEmpty(dir);
  }
}

function migrateFromLegacyIfEmpty(targetDir: string): void {
  try {
    const existing = readdirSync(targetDir).filter((f) => f.endsWith('.json'));
    if (existing.length > 0) return; // aktiv dir har data — rör inget
    for (const legacy of LEGACY_PATHS) {
      if (legacy === targetDir) continue;
      if (!existsSync(legacy)) continue;
      let files: string[] = [];
      try { files = readdirSync(legacy).filter((f) => f.endsWith('.json')); } catch { continue; }
      if (files.length === 0) continue;
      for (const f of files) {
        try { copyFileSync(join(legacy, f), join(targetDir, f)); } catch {}
      }
      console.log(`[storage] Migrerade ${files.length} fil(er) från ${legacy} → ${targetDir}`);
      return;
    }
  } catch {}
}

function filePath(key: string): string {
  return join(dirFor(key), `${key}.json`);
}

export function getItem(key: string): string | null {
  try {
    ensureDir(dirFor(key));
    return readFileSync(filePath(key), 'utf-8');
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string): void {
  const dir = dirFor(key);
  ensureDir(dir);
  writeFileSync(filePath(key), value, 'utf-8');
}

export function getStorageDiagnostics(): Array<{ name: string; path: string; writable: boolean; error: string | null }> {
  const dirs = [
    ['PCC_DATA_DIR', DATA_DIR],
    ['PCC_CONFIG_DIR', CONFIG_DIR],
  ] as const;
  const seen = new Set<string>();
  return dirs
    .filter(([, dir]) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      return true;
    })
    .map(([name, dir]) => {
      try {
        ensureDir(dir);
        accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
        const probe = join(dir, `.lotus-write-test-${process.pid}.tmp`);
        writeFileSync(probe, 'ok', 'utf-8');
        unlinkSync(probe);
        return { name, path: dir, writable: true, error: null };
      } catch (e: any) {
        return { name, path: dir, writable: false, error: e?.code ?? e?.message ?? String(e) };
      }
    });
}

export function removeItem(key: string): void {
  try {
    ensureDir(dirFor(key));
    unlinkSync(filePath(key));
  } catch {}
}

/**
 * Shim global localStorage for engine modules that import it directly.
 */
export function installLocalStorageShim(): void {
  ensureDir(DATA_DIR);
  ensureDir(CONFIG_DIR);
  (globalThis as any).localStorage = { getItem, setItem, removeItem };
  (globalThis as any).window = (globalThis as any).window ?? {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
}
