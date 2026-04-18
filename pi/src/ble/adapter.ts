/**
 * BLE adapter management — noble HCI helpers and adapter init.
 */

import { noble, getAdapterState, logConnectionEvent, processHasBtCaps, bumpWorkaround, getNobleRawState } from './state.js';
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
 * Internal BLE flows must NOT trust the caps-aware adapter override.
 * It is only for UI/diagnostics so the Pi can show "effectively poweredOn"
 * even when noble is still settling. For scan/connect readiness we require raw
 * noble state to actually be poweredOn, otherwise startScanningAsync/connectAsync
 * will still fail with "state is unknown".
 */
function isNobleRawPoweredOn(): boolean {
  return getNobleRawState() === 'poweredOn';
}

/**
 * Wait for adapter to be ready for actual BLE operations.
 * Requires raw noble state, not the caps-aware effective state.
 */
export async function waitForAdapter(deviceName?: string): Promise<boolean> {
  if (isNobleRawPoweredOn()) return true;

  try {
    await (noble as any).waitForPoweredOnAsync(2000);
    return isNobleRawPoweredOn();
  } catch {
    logConnectionEvent({
      type: 'connect_start',
      device: deviceName,
      detail: `Adapter raw state still ${getNobleRawState() ?? 'unknown'} (effective=${getAdapterState() ?? 'unknown'})`,
    });
    return isNobleRawPoweredOn();
  }
}

/**
 * Make sure Bluetooth is unblocked and the adapter is up.
 * Always runs `rfkill unblock bluetooth` BEFORE `hciconfig hci0 up` so a
 * soft-blocked adapter can come back online. Avoid hciconfig reset here —
 * resetting under a live noble instance is what tends to strand raw
 * noble.state in `unknown` on Raspberry Pi.
 *
 * Runs the OS commands, then waits for noble to observe raw `poweredOn`
 * before returning so callers don't continue while noble is still settling.
 */
export async function ensureAdapterUp(): Promise<boolean> {
  try {
    const { execFileSync } = require('child_process');
    execFileSync('bash', ['-lc',
      'rfkill unblock bluetooth >/dev/null 2>&1 || true; ' +
      '(command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1) || true; ' +
      'rfkill unblock bluetooth >/dev/null 2>&1 || true'
    ], { timeout: 6000, stdio: 'ignore' });
  } catch {}

  await new Promise(r => setTimeout(r, 300));
  if (await waitForNoblePoweredOn(2500)) return true;

  try { await restartNobleHci('ensure_adapter_up'); } catch {}
  const ok = await waitForNoblePoweredOn(4000);
  if (!ok) {
    logConnectionEvent({
      type: 'connect_start',
      detail: `ensureAdapterUp timed out (raw=${getNobleRawState() ?? 'unknown'}, effective=${getAdapterState() ?? 'unknown'})`,
    });
  }
  return ok;
}

/**
 * Wait for RAW noble state to report poweredOn.
 * Polls every 200ms up to `timeoutMs`. Returns true if ready.
 */
export async function waitForNoblePoweredOn(timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isNobleRawPoweredOn()) return true;
    try {
      await (noble as any).waitForPoweredOnAsync?.(Math.min(500, timeoutMs - (Date.now() - start)));
      if (isNobleRawPoweredOn()) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return isNobleRawPoweredOn();
}

/** Normalize a BLE identifier (MAC, UUID, id) to lowercase hex without colons */
export function normalizeBleKey(value: string | null | undefined): string {
  return (value ?? '').replace(/:/g, '').toLowerCase();
}

async function initAdapter(): Promise<void> {
  await ensureAdapterUp();

  if (isNobleRawPoweredOn()) {
    console.log('[BLE] Adapter state: poweredOn ✓ (raw noble)');
    logConnectionEvent({ type: 'connect_start', detail: 'Adapter ready (raw noble poweredOn)' });
    return;
  }

  try {
    console.log('[BLE] initAdapter: waitForPoweredOnAsync...');
    await (noble as any).waitForPoweredOnAsync(5000);
    if (isNobleRawPoweredOn()) {
      console.log('[BLE] Adapter state: poweredOn ✓ (noble confirmed)');
      logConnectionEvent({ type: 'connect_start', detail: 'Adapter ready (noble confirmed)' });
      return;
    }
  } catch {}

  const rawState = getNobleRawState();
  const effectiveState = getAdapterState();
  if (rawState === 'unauthorized') {
    console.error('[BLE] Adapter state: unauthorized — saknar CAP_NET_RAW + CAP_NET_ADMIN.');
    logConnectionEvent({ type: 'connect_start', detail: 'unauthorized — caps missing' });
    return;
  }
  if (rawState === 'poweredOff') {
    console.warn('[BLE] Adapter state: poweredOff — Bluetooth är avstängt eller rfkill-blockerat.');
    return;
  }

  console.log(`[BLE] Adapter raw state at init: ${rawState ?? 'unknown'} (effective=${effectiveState ?? 'unknown'})`);
  logConnectionEvent({ type: 'connect_start', detail: `Adapter init raw=${rawState ?? 'unknown'}, effective=${effectiveState ?? 'unknown'}` });
}

// Fire and forget — don't block module loading
initAdapter().catch((e) => console.error('[BLE] initAdapter error:', e));
