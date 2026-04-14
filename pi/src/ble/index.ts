/**
 * BLE module — public API re-exports.
 * Drop-in replacement for the old monolithic nobleBle.ts.
 *
 * Import order matters: reconnect.ts must load after connection.ts and protocol.ts
 * to wire up cross-module callbacks.
 */

// Types
export type { DeviceMode, PiCharacteristic, DiscoveredDevice, BleConnectionEvent } from './types.js';

// State & adapter
export { bleStats, getAdapterState, isDemandActive, getConnectionLog } from './state.js';
export { getDevice, getSavedDeviceId, getSavedDeviceName } from './state.js';

// Protocol (write pipeline)
export { sendToBLE, sendRawColor, resetLastSent, setDimmingGamma, getDimmingGamma } from './protocol.js';

// Connection
export { connectPeripheral, resetHciAdapter } from './connection.js';

// Scanning
export { scanForDevices, selectDevice, forgetDevice, autoConnectSaved, getLastScanResults, isScanning } from './scan.js';

// Reconnection & demand
export { requestConnect, releaseDemand, startReconnectLoop } from './reconnect.js';

// ── Convenience / legacy aliases ──
import { getDevice, setDevice } from './state.js';
import { stopKeepAlive, resetLastSent } from './protocol.js';
import { autoConnectSaved } from './scan.js';

export function getConnectedCount(): number {
  return getDevice() ? 1 : 0;
}

export function getConnectedNames(): string[] {
  const d = getDevice();
  return d ? [d.name] : [];
}

export function getConnectedDeviceId(): string | null {
  return getDevice()?.id ?? null;
}

export async function disconnect(): Promise<void> {
  stopKeepAlive();
  const d = getDevice();
  if (d) {
    try { await d.peripheral.disconnectAsync(); } catch {}
    setDevice(null);
    resetLastSent();
    console.log('[BLE] Disconnected');
  }
}

export const disconnectAll = disconnect;
export const scanAndConnect = autoConnectSaved;
export function setExpectedDeviceCount(_n: number): void { /* no-op */ }

// ── Startup diagnostics with adapter retry ──
import { getAdapterState, noble, logConnectionEvent, processHasBtCaps } from './state.js';
import { resetHciAdapter } from './connection.js';

async function initAdapter(): Promise<void> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const state = getAdapterState();

    if (state === 'poweredOn') {
      console.log('[BLE] Adapter state: poweredOn ✓');
      logConnectionEvent({ type: 'connect_start', detail: `Adapter ready (attempt ${attempt})` });
      return;
    }

    if (state === 'unauthorized' && processHasBtCaps()) {
      console.warn(`[BLE] noble reports unauthorized but process has caps — retrying adapter (${attempt + 1}/${MAX_RETRIES})`);
      logConnectionEvent({ type: 'hci_reset', detail: `Adapter unauthorized despite caps, retry ${attempt + 1}` });
      try {
        await resetHciAdapter();
        // Wait for noble to pick up the state change
        const settled = await new Promise<string>((resolve) => {
          const timeout = setTimeout(() => resolve('timeout'), RETRY_DELAY_MS);
          noble.once('stateChange', (s: string) => {
            clearTimeout(timeout);
            resolve(s);
          });
        });
        if (settled === 'poweredOn') {
          console.log('[BLE] Adapter recovered after HCI reset ✓');
          logConnectionEvent({ type: 'connect_start', detail: 'Adapter recovered after retry ✓' });
          return;
        }
      } catch (e: any) {
        console.error(`[BLE] HCI reset attempt ${attempt + 1} failed: ${e.message}`);
      }
      continue;
    }

    // Non-retryable states
    if (state === 'unauthorized') {
      console.error('[BLE] Adapter state: unauthorized — saknar CAP_NET_RAW + CAP_NET_ADMIN.');
      logConnectionEvent({ type: 'connect_start', detail: 'unauthorized — caps missing' });
      return;
    }
    if (state === 'poweredOff') {
      console.warn('[BLE] Adapter state: poweredOff — Bluetooth är avstängt eller rfkill-blockerat.');
      return;
    }

    // Unknown/undefined — wait for stateChange once
    console.log(`[BLE] Adapter state at init: ${state ?? 'unknown'} — waiting for stateChange`);
    noble.once('stateChange', (s: string) => {
      logConnectionEvent({ type: 'connect_start', detail: `Adapter state changed: ${s}` });
    });
    return;
  }

  console.error('[BLE] Adapter failed to reach poweredOn after retries');
  logConnectionEvent({ type: 'connect_start', detail: 'Adapter stuck unauthorized after all retries' });
}

// Fire and forget — don't block module loading
initAdapter().catch((e) => console.error('[BLE] initAdapter error:', e));
