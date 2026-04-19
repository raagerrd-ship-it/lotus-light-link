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
  const inflight = (async (): Promise<{ connected: boolean; error?: string }> => {
    const n = getNoble();

    // 1. Vänta på riktig poweredOn — ALDRIG mutera _state manuellt.
    try {
      await (n as any).waitForPoweredOnAsync(10_000);
    } catch (e: any) {
      return { connected: false, error: `waitForPoweredOnAsync failed: ${e?.message ?? e}` };
    }

    // 2. Scan-then-connect — matchar isolated-scriptet
    return await new Promise<{ connected: boolean; error?: string }>((resolve) => {
      let resolved = false;
      const finish = (r: { connected: boolean; error?: string }) => {
        if (resolved) return;
        resolved = true;
        try { n.removeListener('discover', onDiscover); } catch {}
        clearTimeout(timer);
        resolve(r);
      };

      const onDiscover = async (peripheral: any) => {
        if (!matchesHardcoded(peripheral)) return;
        console.log(`[connect-hardcoded] discover MATCH: ${peripheral.address} (${peripheral.advertisement?.localName ?? 'no name'}) rssi=${peripheral.rssi}`);
        try {
          await n.stopScanningAsync();
        } catch (e: any) {
          console.warn(`[connect-hardcoded] stopScanningAsync warning: ${e?.message ?? e}`);
        }
        try {
          await peripheral.connectAsync();
          _connected = peripheral;
          peripheral.once?.('disconnect', () => {
            console.log('[connect-hardcoded] peripheral disconnected');
            if (_connected === peripheral) _connected = null;
          });
          finish({ connected: true });
        } catch (e: any) {
          finish({ connected: false, error: `connectAsync failed: ${e?.message ?? e}` });
        }
      };

      n.on('discover', onDiscover);

      const timer = setTimeout(async () => {
        try { await n.stopScanningAsync(); } catch {}
        finish({ connected: false, error: `Hittade inte ${HARDCODED_DEVICE.mac} efter ${timeoutMs}ms` });
      }, timeoutMs);

      n.startScanningAsync([], true).catch((e: any) => {
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
