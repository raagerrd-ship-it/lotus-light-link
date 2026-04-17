/**
 * BLE adapter management — noble HCI helpers and adapter init.
 */

import { noble, getAdapterState, logConnectionEvent, processHasBtCaps, bumpWorkaround } from './state.js';
export { processHasBtCaps };

/** Stop noble scanning (no HCI release — noble keeps the socket) */
export function stopNoble(): void {
  try { noble.stopScanning(); } catch {}
}

/**
 * Ask noble to refresh its HCI listeners without toggling the kernel adapter.
 * On Pi, destructive hciconfig down/up while noble is alive often wedges
 * noble in raw `unknown`, so keep this re-init best-effort and non-destructive.
 */
export async function restartNobleHci(deviceName?: string): Promise<void> {
  bumpWorkaround('restartNobleHci_invoked');
  try {
    const bindings = (noble as any)._bindings;
    const hci = bindings?._hci;

    if (typeof hci?.stop === 'function') {
      try { hci.stop(); } catch {}
    }
    if (typeof hci?.start === 'function') {
      hci.start();
      logConnectionEvent({ type: 'connect_start', device: deviceName, detail: 'noble HCI listeners refreshed' });
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

/**
 * Make sure Bluetooth is unblocked and the adapter is up.
 * Always runs `rfkill unblock bluetooth` BEFORE `hciconfig hci0 up` so a
 * soft-blocked adapter can come back online. Avoid hciconfig reset here —
 * resetting under a live noble instance is what tends to strand raw
 * noble.state in `unknown` on Raspberry Pi.
 *
 * Synchronous part runs the OS commands; caller can then await
 * `waitForNoblePoweredOn(timeoutMs)` to confirm noble sees the adapter.
 */
export function ensureAdapterUp(): void {
  try {
    const { execFileSync } = require('child_process');
    execFileSync('bash', ['-lc',
      // 1) unblock rfkill (soft block) FIRST
      'rfkill unblock bluetooth >/dev/null 2>&1 || true; ' +
      // 2) bring hci0 up
      '(command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1) || true'
    ], { timeout: 6000, stdio: 'ignore' });
  } catch {}
}

/**
 * Wait for noble (or caps-aware adapter state) to report poweredOn.
 * Polls every 200ms up to `timeoutMs`. Returns true if ready.
 */
export async function waitForNoblePoweredOn(timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getAdapterState() === 'poweredOn') return true;
    try {
      await (noble as any).waitForPoweredOnAsync?.(Math.min(500, timeoutMs - (Date.now() - start)));
      if (getAdapterState() === 'poweredOn') return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return getAdapterState() === 'poweredOn';
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
