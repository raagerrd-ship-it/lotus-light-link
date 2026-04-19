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
  stopKeepAlive();
  setDevice(null);
  resetLastSent();
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
      let matched = false; // sätts när vi hittat target — påverkar timeout-meddelandet
      const finish = (r: { connected: boolean; error?: string }) => {
        if (resolved) return;
        resolved = true;
        try { n.removeListener('discover', onDiscover); } catch {}
        clearTimeout(timer);
        resolve(r);
      };

      // Helper: race en promise mot en hård timeout. noble's connectAsync
      // kan på Pi Zero 2W hänga oändligt om L2CAP-handshake tappas, vilket
      // tidigare lät yttre 8s-watchdogen fyra "ingen matchade" trots match.
      const withTimeout = <T,>(p: Promise<T>, label: string, ms: number): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
        ]);

      const onDiscover = async (peripheral: any) => {
        discoverCount++;
        const isMatch = matchesHardcoded(peripheral);
        // Logga BARA matchande enheter — annars spammar varje närliggande
        // BLE-advertisement loggen och äter CPU på Pi Zero 2W.
        if (!isMatch) return;
        matched = true;
        const name = peripheral.advertisement?.localName ?? '(no name)';
        console.log(`${ts()} [event:discover] ${peripheral.address} ${name} rssi=${peripheral.rssi} ← MATCH`);
        console.log(`${ts()} 3. MATCH efter ${discoverCount} discover-events — stopScanningAsync…`);
        try {
          await n.stopScanningAsync();
          console.log(`${ts()}    stopScanningAsync OK`);
        } catch (e: any) {
          console.warn(`${ts()}    stopScanningAsync warning: ${e?.message ?? e}`);
        }
        console.log(`${ts()} 4. peripheral.connectAsync() (5s timeout)…`);
        try {
          await withTimeout(peripheral.connectAsync(), 'connectAsync', 5000);
          _connected = peripheral;
          peripheral.once?.('disconnect', () => {
            console.log(`[connect-hardcoded] peripheral disconnected (${peripheral.address})`);
            stopKeepAlive();
            setDevice(null);
            resetLastSent();
            bleStats.disconnectCount++;
            bleStats.lastDisconnectAt = new Date().toISOString();
            if (_connected === peripheral) _connected = null;
          });
          console.log(`${ts()} 5. ANSLUTEN ${peripheral.address}`);

          // ── 6. GATT discovery: hitta write-characteristic så vi kan skriva färg + hålla keep-alive ──
          console.log(`${ts()} 6. discoverSomeServicesAndCharacteristicsAsync([${SERVICE_UUID}], [${CHAR_UUID}])…`);
          try {
            const { characteristics } = await withTimeout(
              peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [CHAR_UUID]),
              'GATT discovery',
              8000,
            );
            const ch = characteristics?.[0];
            if (!ch) {
              console.warn(`${ts()}    GATT: ingen ${CHAR_UUID}-characteristic hittad — keep-alive startas EJ`);
              finish({ connected: true });
              return;
            }
            setDevice({
              peripheral,
              characteristic: ch,
              mode: 'rgb',
              name: HARDCODED_DEVICE.name,
              id: peripheral.id,
            });
            startKeepAlive();
            console.log(`${ts()} 7. keep-alive STARTAD (400ms intervall) — lampan håller anslutningen`);
            finish({ connected: true });
          } catch (e: any) {
            console.warn(`${ts()}    GATT discovery FEL: ${e?.message ?? e} — försöker disconnecta`);
            try { await peripheral.disconnectAsync(); } catch {}
            finish({ connected: false, error: `GATT discovery failed: ${e?.message ?? e}` });
          }
        } catch (e: any) {
          console.log(`${ts()}    connectAsync FEL: ${e?.message ?? e} — disconnectar och ger upp`);
          try { await peripheral.disconnectAsync(); } catch {}
          finish({ connected: false, error: `connectAsync failed: ${e?.message ?? e}` });
        }
      };

      n.on('discover', onDiscover);

      const timer = setTimeout(async () => {
        if (matched) {
          // Detta ska aldrig hända nu (connectAsync har egen 5s timeout) —
          // men om det gör det, säg sanningen istället för "ingen matchade".
          console.log(`${ts()} TIMEOUT efter ${timeoutMs}ms — match hittades men connect hängde (${discoverCount} discover-events)`);
        } else {
          console.log(`${ts()} TIMEOUT efter ${timeoutMs}ms — ${discoverCount} discover-events totalt, ingen matchade`);
        }
        try { await n.stopScanningAsync(); } catch {}
        finish({
          connected: false,
          error: matched
            ? `Match hittad men connect hängde efter ${timeoutMs}ms`
            : `Hittade inte ${HARDCODED_DEVICE.mac} efter ${timeoutMs}ms (${discoverCount} discover-events)`,
        });
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
