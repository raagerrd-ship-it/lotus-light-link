/**
 * File-based storage — drop-in replacement for localStorage on Pi.
 * Stores calibration, presets, idle color, device modes as JSON files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME ?? '/root', '.lotus-light');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function filePath(key: string): string {
  return join(DATA_DIR, `${key}.json`);
}

export function getItem(key: string): string | null {
  try {
    return readFileSync(filePath(key), 'utf-8');
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string): void {
  writeFileSync(filePath(key), value, 'utf-8');
}

export function removeItem(key: string): void {
  try {
    const { unlinkSync } = require('fs');
    unlinkSync(filePath(key));
  } catch {}
}

/**
 * Shim global localStorage for engine modules that import it directly.
 */
export function installLocalStorageShim(): void {
  (globalThis as any).localStorage = { getItem, setItem, removeItem };
  (globalThis as any).window = (globalThis as any).window ?? {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
  // performance.now() exists in Node 16+
}
