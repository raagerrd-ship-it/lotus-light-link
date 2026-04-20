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

import { getNobleAsync } from './noble-singleton.js';
import { isHci0Up } from './adapter-hci-check.js';

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

  // Steg 0: PASSIV vänta på att hci0 är UP RUNNING.
  //
  // RATIONALE (2026-04-20): Aktiv `hciconfig hci0 up` från engine-processen
  // racear bluetoothd's egen power-on och triggar `org.bluez.Error.Busy` +
  // `Can't init device hci0: Connection timed out (110)` på Pi Zero 2W.
  // Bevisat i SSH-logg där `bluetoothctl power on` failade direkt efter
  // engine-restart. bluetoothd (som setup-lotus.sh enable+startar) ÄGER
  // adaptern och tar upp den korrekt — engine ska bara vänta passivt.
  //
  // Policy: mem://pi/ble/hci-up-only-policy — engine får aldrig mutera hci0.
  console.log(`${ts()} 0. Väntar passivt på att hci0 är UP RUNNING (bluetoothd äger wake)...`);
  const waitStart = Date.now();
  let hciUp = isHci0Up();
  while (!hciUp && Date.now() - waitStart < 8000) {
    await new Promise(r => setTimeout(r, 250));
    hciUp = isHci0Up();
  }
  if (!hciUp) {
    const error = 'hci0 inte UP RUNNING efter 8s — bluetoothd nere? (kör: sudo systemctl restart bluetooth)';
    console.log(`${ts()}    ${error}`);
    return {
      ready: false,
      rawState: null,
      durationMs: Date.now() - t0,
      error,
    };
  }
  console.log(`${ts()}    hci0 UP RUNNING ✓ (väntat ${Date.now() - waitStart}ms)`);

  console.log(`${ts()} 1. Importing @stoprocent/noble...`);
  const noble = await getNobleAsync();
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
