/**
 * File-based storage — drop-in replacement for localStorage on Pi.
 * Stores persisted settings in the app's own data directory so they survive updates
 * and do not depend on HOME being set or writable under the service manager.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.LOTUS_DATA_DIR || '/opt/lotus-light/pi/data';

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
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
