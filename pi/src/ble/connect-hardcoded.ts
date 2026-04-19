/**
 * Scan-then-connect mot HARDCODED_DEVICE — speglar pi/scripts/noble-scan-isolated.mjs
 * exakt: vänta på poweredOn → startScanningAsync([], true) → matcha discover-event
 * → stopScanningAsync → peripheral.connectAsync.
 *
 * Inga watchdogs, ingen reconnect-loop, ingen force-mutate av noble._state.
 * Se mem://pi/ble/never-force-mutate-noble-state.
 */

import { noble, getNoble } from './noble-singleton.js';
import { HARDCODED_DEVICE, matchesHardcoded } from './hardcoded-device.js';
import { SERVICE_UUID, CHAR_UUID, setDevice, bleStats } from './state.js';
import { startKeepAlive, stopKeepAlive, resetLastSent } from './protocol.js';

let _connected: any = null;
let _connectInFlight: Promise<{ connected: boolean; error?: string }> | null = null;

export function getHardcodedConnected(): { connected: boolean; name: string; mac: string } {
  return { connected: !!_connected && _connected.state === 'connected', name: HARDCODED_DEVICE.name, mac: HARDCODED_DEVICE.mac };
}

export function getHardcodedPeripheral(): any | null {
  return _connected;
}

export async function disconnectHardcoded(): Promise<{ disconnected: boolean }> {
  if (!_connected) return { disconnected: true };
  try { await _connected.disconnectAsync(); } catch {}
  _connected = null;
  return { disconnected: true };
}

export async function connectHardcoded(timeoutMs = 8000): Promise<{ connected: boolean; error?: string; durationMs: number }> {
  if (_connectInFlight) {
    const r = await _connectInFlight;
    return { ...r, durationMs: 0 };
  }
  if (_connected && _connected.state === 'connected') {
    return { connected: true, durationMs: 0 };
  }

  const t0 = Date.now();
  const ts = () => `+${(Date.now() - t0).toString().padStart(5, ' ')}ms`;

  const inflight = (async (): Promise<{ connected: boolean; error?: string }> => {
    const n = getNoble();

    console.log(`${ts()} 1. waitForPoweredOnAsync(10s)…`);
    try {
      await (n as any).waitForPoweredOnAsync(10_000);
      console.log(`${ts()}    poweredOn (state=${n.state})`);
    } catch (e: any) {
      console.log(`${ts()}    waitForPoweredOnAsync FEL: ${e?.message ?? e}`);
      return { connected: false, error: `waitForPoweredOnAsync failed: ${e?.message ?? e}` };
    }

    return await new Promise<{ connected: boolean; error?: string }>((resolve) => {
      let resolved = false;
      let discoverCount = 0;
      const finish = (r: { connected: boolean; error?: string }) => {
        if (resolved) return;
        resolved = true;
        try { n.removeListener('discover', onDiscover); } catch {}
        clearTimeout(timer);
        resolve(r);
      };

      const onDiscover = async (peripheral: any) => {
        discoverCount++;
        const name = peripheral.advertisement?.localName ?? '(no name)';
        const isMatch = matchesHardcoded(peripheral);
        console.log(`${ts()} [event:discover] ${peripheral.address} ${name} rssi=${peripheral.rssi}${isMatch ? ' ← MATCH' : ''}`);
        if (!isMatch) return;
        console.log(`${ts()} 3. MATCH efter ${discoverCount} discover-events — stopScanningAsync…`);
        try {
          await n.stopScanningAsync();
          console.log(`${ts()}    stopScanningAsync OK`);
        } catch (e: any) {
          console.warn(`${ts()}    stopScanningAsync warning: ${e?.message ?? e}`);
        }
        console.log(`${ts()} 4. peripheral.connectAsync()…`);
        try {
          await peripheral.connectAsync();
          _connected = peripheral;
          peripheral.once?.('disconnect', () => {
            console.log(`[connect-hardcoded] peripheral disconnected (${peripheral.address})`);
            if (_connected === peripheral) _connected = null;
          });
          console.log(`${ts()} 5. ANSLUTEN ${peripheral.address}`);
          finish({ connected: true });
        } catch (e: any) {
          console.log(`${ts()}    connectAsync FEL: ${e?.message ?? e}`);
          finish({ connected: false, error: `connectAsync failed: ${e?.message ?? e}` });
        }
      };

      n.on('discover', onDiscover);

      const timer = setTimeout(async () => {
        console.log(`${ts()} TIMEOUT efter ${timeoutMs}ms — ${discoverCount} discover-events totalt, ingen matchade`);
        try { await n.stopScanningAsync(); } catch {}
        finish({ connected: false, error: `Hittade inte ${HARDCODED_DEVICE.mac} efter ${timeoutMs}ms (${discoverCount} discover-events)` });
      }, timeoutMs);

      console.log(`${ts()} 2. startScanningAsync([], true)…`);
      n.startScanningAsync([], true)
        .then(() => console.log(`${ts()}    startScanningAsync OK — väntar på match (${HARDCODED_DEVICE.mac})`))
        .catch((e: any) => {
          console.log(`${ts()}    startScanningAsync FEL: ${e?.message ?? e}`);
          finish({ connected: false, error: `startScanningAsync failed: ${e?.message ?? e}` });
        });
    });
  })();

  _connectInFlight = inflight;
  try {
    const r = await inflight;
    return { ...r, durationMs: Date.now() - t0 };
  } finally {
    _connectInFlight = null;
  }
}
