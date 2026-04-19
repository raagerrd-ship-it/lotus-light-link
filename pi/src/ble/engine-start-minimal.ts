/**
 * Minimal BLE-motor-start som speglar pi/scripts/noble-scan-isolated.mjs 1:1.
 *
 * Loggformat (matchar isolated-scriptet exakt):
 *   "1. Importing @stoprocent/noble..."
 *   "2. Imported. typeof noble.startScanningAsync = function"
 *   "   noble.state = unknown | noble._state = unknown"
 *   "3. Waiting 1s for any initial stateChange events..."
 *   "[event:stateChange] poweredOn"
 *   "   noble.state efter 1s = poweredOn"
 *   "4. State redan poweredOn — hoppar waitForPoweredOnAsync"
 *
 * Inga watchdogs, ingen ensureAdapterUp, ingen heartbeat — bara det som
 * noble-scan-isolated.mjs gör. Resten (heartbeat, dimming-gamma) körs i
 * ett efterföljande steg om motorn blev redo.
 */

import { getNoble } from './noble-singleton.js';

let _started = false;
let _eventsBound = false;

function bindEvents(noble: any): void {
  if (_eventsBound) return;
  _eventsBound = true;
  const events = ['stateChange', 'scanStart', 'scanStop', 'discover', 'warning', 'error'] as const;
  for (const ev of events) {
    noble.on(ev, (...args: unknown[]) => {
      const arg0: any = args[0];
      if (ev === 'discover') {
        console.log(
          `[event:${ev}]`,
          arg0?.address,
          arg0?.advertisement?.localName ?? '(no name)',
          `rssi=${arg0?.rssi}`,
        );
        return;
      }
      const parts = args.map(a => {
        if (a == null) return String(a);
        if (typeof a === 'object') {
          try { return JSON.stringify(a).slice(0, 100); } catch { return '[obj]'; }
        }
        return String(a);
      });
      console.log(`[event:${ev}]`, ...parts);
    });
  }
}

export interface MinimalEngineResult {
  ready: boolean;
  rawState: string | null;
  durationMs: number;
  error?: string;
}

export async function startBleEngineMinimal(): Promise<MinimalEngineResult> {
  const t0 = Date.now();
  const ts = () => `+${(Date.now() - t0).toString().padStart(5, ' ')}ms`;

  console.log(`${ts()} 1. Importing @stoprocent/noble...`);
  const noble = getNoble();
  console.log(`${ts()} 2. Imported. typeof noble.startScanningAsync =`, typeof noble.startScanningAsync);
  console.log(`${ts()}    noble.state =`, noble.state, '| noble._state =', (noble as any)._state);

  bindEvents(noble);

  console.log(`${ts()} 3. Waiting 1s for any initial stateChange events...`);
  await new Promise(r => setTimeout(r, 1000));
  console.log(`${ts()}    noble.state efter 1s =`, noble.state);

  if (noble.state !== 'poweredOn') {
    console.log(`${ts()} 4. State är inte poweredOn — försöker waitForPoweredOnAsync(3s)...`);
    try {
      await Promise.race([
        (noble as any).waitForPoweredOnAsync(3000),
        new Promise((_, rej) => setTimeout(() => rej(new Error('outer timeout 4s')), 4000)),
      ]);
      console.log(`${ts()}    waitForPoweredOnAsync resolved. state =`, noble.state);
    } catch (e: any) {
      console.log(`${ts()}    waitForPoweredOnAsync FEL:`, e?.message ?? e);
      return {
        ready: false,
        rawState: noble.state ?? null,
        durationMs: Date.now() - t0,
        error: e?.message ?? String(e),
      };
    }
  } else {
    console.log(`${ts()} 4. State redan poweredOn — hoppar waitForPoweredOnAsync`);
  }

  _started = true;
  const ready = noble.state === 'poweredOn';
  console.log(`${ts()} 5. Motor redo=${ready} (state=${noble.state})`);
  return { ready, rawState: noble.state ?? null, durationMs: Date.now() - t0 };
}

export function isMinimalEngineStarted(): boolean {
  return _started;
}
