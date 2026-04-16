/**
 * BLE adapter management — noble HCI helpers and adapter init.
 */

import { noble, getAdapterState, logConnectionEvent, processHasBtCaps } from './state.js';

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

/** Wait for adapter to reach poweredOn state using noble's official API */
export async function waitForAdapter(deviceName?: string): Promise<boolean> {
  try {
    await (noble as any).waitForPoweredOnAsync(5000);
    return true;
  } catch {
    logConnectionEvent({ type: 'connect_fail', device: deviceName, detail: `Adapter not ready: ${getAdapterState()}` });
    return false;
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

// ── Startup diagnostics with adapter retry ──
import { resetHciAdapter } from './connect.js';

async function initAdapter(): Promise<void> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Reset HCI adapter before each attempt — required on Pi for noble to register poweredOn
    ensureAdapterUp();
    await new Promise(r => setTimeout(r, 500));

    // Always call waitForPoweredOnAsync to ensure noble's internal state machine
    // is properly initialized — our caps-based override in getAdapterState() does
    // NOT set noble's real state, so startScanningAsync would fail without this.
    try {
      console.log(`[BLE] initAdapter attempt ${attempt}: hciconfig reset + waitForPoweredOnAsync...`);
      await (noble as any).waitForPoweredOnAsync(5000);
      console.log('[BLE] Adapter state: poweredOn ✓ (noble confirmed)');
      logConnectionEvent({ type: 'connect_start', detail: `Adapter ready (attempt ${attempt})` });
      return;
    } catch {
      // waitForPoweredOnAsync timed out — check if retryable
    }

    const state = getAdapterState();

    if ((state === 'unauthorized' || state === 'poweredOn') && processHasBtCaps()) {
      console.warn(`[BLE] noble not poweredOn but process has caps — HCI reset retry ${attempt + 1}/${MAX_RETRIES}`);
      logConnectionEvent({ type: 'hci_reset', detail: `Adapter not ready despite caps, retry ${attempt + 1}` });
      try {
        await resetHciAdapter();
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

    console.log(`[BLE] Adapter state at init: ${state ?? 'unknown'} — waiting for stateChange`);
    noble.once('stateChange', (s: string) => {
      logConnectionEvent({ type: 'connect_start', detail: `Adapter state changed: ${s}` });
    });
    return;
  }

  console.error('[BLE] Adapter failed to reach poweredOn after retries');
  logConnectionEvent({ type: 'connect_start', detail: 'Adapter stuck after all retries' });
}

// Fire and forget — don't block module loading
initAdapter().catch((e) => console.error('[BLE] initAdapter error:', e));
