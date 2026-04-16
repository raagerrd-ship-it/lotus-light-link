/**
 * BLE adapter management — noble HCI helpers and adapter init.
 */

import { noble, getAdapterState, logConnectionEvent, processHasBtCaps } from './state.js';
export { processHasBtCaps };

/** Stop noble scanning (no HCI release — noble keeps the socket) */
export function stopNoble(): void {
  try { noble.stopScanning(); } catch {}
}

/** Re-initialize noble's HCI binding after it was stopped */
export async function restartNobleHci(deviceName?: string): Promise<void> {
  try {
    const bindings = (noble as any)._bindings;
    if (bindings?._hci?.start) {
      bindings._hci.start();
      logConnectionEvent({ type: 'connect_start', device: deviceName, detail: 'noble HCI re-initialized' });
    }
  } catch {}
  await new Promise(r => setTimeout(r, 300));
}

/**
 * Wait for adapter to be ready.
 * Like the old browser Web Bluetooth implementation, we don't gate on adapter state —
 * we just trust noble.connectAsync to handle adapter readiness internally.
 * If process has BT caps OR noble reports poweredOn, we proceed.
 */
export async function waitForAdapter(deviceName?: string): Promise<boolean> {
  // If caps-aware state says poweredOn, trust it
  if (getAdapterState() === 'poweredOn') return true;
  if (processHasBtCaps()) return true;

  // Last resort: brief wait for noble to confirm
  try {
    await (noble as any).waitForPoweredOnAsync(2000);
    return true;
  } catch {
    // Don't block — let connectAsync try and fail with a real error
    logConnectionEvent({ type: 'connect_start', device: deviceName, detail: `Adapter state unclear (${getAdapterState()}) — proceeding anyway` });
    return true;
  }
}

/** Force Bluetooth adapter up via rfkill/hciconfig + reset (required for noble to detect poweredOn on Pi) */
export function ensureAdapterUp(): void {
  try {
    const { execFileSync } = require('child_process');
    execFileSync('bash', ['-lc', 'rfkill unblock bluetooth >/dev/null 2>&1 || true; (command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1 && hciconfig hci0 reset >/dev/null 2>&1) || true'], { timeout: 6000, stdio: 'ignore' });
  } catch {}
}

/** Normalize a BLE identifier (MAC, UUID, id) to lowercase hex without colons */
export function normalizeBleKey(value: string | null | undefined): string {
  return (value ?? '').replace(/:/g, '').toLowerCase();
}

async function initAdapter(): Promise<void> {
  ensureAdapterUp();
  await new Promise(r => setTimeout(r, 500));

  if (getAdapterState() === 'poweredOn') {
    console.log('[BLE] Adapter state: poweredOn ✓');
    logConnectionEvent({ type: 'connect_start', detail: 'Adapter ready (caps/state)' });
    return;
  }

  try {
    console.log('[BLE] initAdapter: waitForPoweredOnAsync...');
    await (noble as any).waitForPoweredOnAsync(5000);
    console.log('[BLE] Adapter state: poweredOn ✓ (noble confirmed)');
    logConnectionEvent({ type: 'connect_start', detail: 'Adapter ready (noble confirmed)' });
    return;
  } catch {}

  const state = getAdapterState();
  if (state === 'unauthorized') {
    console.error('[BLE] Adapter state: unauthorized — saknar CAP_NET_RAW + CAP_NET_ADMIN.');
    logConnectionEvent({ type: 'connect_start', detail: 'unauthorized — caps missing' });
    return;
  }
  if (state === 'poweredOff') {
    console.warn('[BLE] Adapter state: poweredOff — Bluetooth är avstängt eller rfkill-blockerat.');
    return;
  }

  console.log(`[BLE] Adapter state at init: ${state ?? 'unknown'} — continuing without reset loop`);
  logConnectionEvent({ type: 'connect_start', detail: `Adapter init state: ${state ?? 'unknown'}` });
}

// Fire and forget — don't block module loading
initAdapter().catch((e) => console.error('[BLE] initAdapter error:', e));
