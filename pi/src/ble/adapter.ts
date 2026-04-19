/**
 * BLE adapter management — noble HCI helpers and adapter init.
 */

import { noble, getAdapterState, logConnectionEvent, processHasBtCaps, bumpWorkaround, getNobleRawState } from './state.js';
import { runShellScript, runShellRead } from './sysExec.js';
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

    // Try every "kick noble to re-read adapter state" hook this build of
    // @stoprocent/noble might expose. Each one is best-effort.
    const tried: string[] = [];

    if (typeof hci?.pollIsDevUp === 'function') {
      try { hci.pollIsDevUp(); tried.push('pollIsDevUp'); } catch {}
    }
    if (typeof hci?.setSocketFilter === 'function') {
      try { hci.setSocketFilter(); tried.push('setSocketFilter'); } catch {}
    }
    if (typeof hci?.stop === 'function') {
      try { hci.stop(); tried.push('stop'); } catch {}
    }
    if (typeof hci?.init === 'function') {
      try { hci.init(); tried.push('init'); } catch {}
    } else if (typeof hci?.start === 'function') {
      try { hci.start(); tried.push('start'); } catch {}
    }
    if (typeof bindings?.init === 'function') {
      try { bindings.init(); tried.push('bindings.init'); } catch {}
    }

    logConnectionEvent({
      type: 'connect_start',
      device: deviceName,
      detail: `noble HCI refresh: ${tried.join(',') || 'no hooks available'}`,
    });
  } catch {}
  await new Promise(r => setTimeout(r, 400));
}

/**
 * Strict raw-noble check. Only used by code paths that genuinely need
 * `noble.state === 'poweredOn'` (e.g. waitForNoblePoweredOn polling).
 */
function isNobleRawPoweredOn(): boolean {
  return getNobleRawState() === 'poweredOn';
}

/**
 * Pragmatic readiness check for BLE ops (scan/connect).
 *
 * Background: on Pi Zero 2W noble's first `stateChange` event sometimes
 * never fires (libuv timing race), even though hci0 is UP RUNNING and the
 * process has CAP_NET_RAW + CAP_NET_ADMIN. In that wedged-but-functional
 * state, `getNobleRawState()` returns `unknown` forever — but
 * `startScanningAsync` and `connectAsync` actually work because the HCI
 * socket is healthy.
 *
 * Empirically: when raw=`unknown` AND caps OK, scan/connect succeed
 * (verified via pi/scripts/ble-diag.mjs). When raw=`poweredOff` or
 * `unauthorized`, they always fail. So we treat caps-aware
 * `getAdapterState() === 'poweredOn'` as "good enough to try".
 *
 * Returns true if either raw noble or the caps-aware effective state
 * reports poweredOn. Returns false on hard fails (poweredOff/unauthorized).
 */
export function isAdapterReadyForBleOps(): boolean {
  const raw = getNobleRawState();
  if (raw === 'poweredOn') return true;
  if (raw === 'poweredOff' || raw === 'unauthorized') return false;
  // raw is unknown/undefined — fall back to caps-aware effective state
  return getAdapterState() === 'poweredOn';
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
  // Step 1: unblock rfkill + bring hci0 up (idempotent, non-destructive).
  // We deliberately do NOT touch hciconfig down — that races noble's raw
  // socket and tends to leave noble.state stuck in `poweredOff` even after
  // the adapter comes back up.
  //
  // Använder runShellScript (PATH-safe) istället för bash -lc — login-shell
  // har tom PATH under systemd user-service, se mem://no-bash-lc-for-system-tools.
  runShellScript(
    'rfkill unblock bluetooth >/dev/null 2>&1 || true; ' +
    '(command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1) || true; ' +
    'rfkill unblock bluetooth >/dev/null 2>&1 || true',
    { timeoutMs: 6000 }
  );

  await new Promise(r => setTimeout(r, 300));
  if (await waitForNoblePoweredOn(2500)) return true;

  // Tidigare anropades restartNobleHci() här som "fallback". Den kallar
  // hci.stop() + hci.init() på en LIVE noble-instans, vilket på Pi sparkar
  // ner adaptern från poweredOn → poweredOff. Vi gör INGET destruktivt här
  // längre — om noble inte är poweredOn efter rfkill/hciconfig up så är det
  // användarens jobb att trycka "Återställ BLE-stack".
  if (await waitForNoblePoweredOn(3000)) return true;

  // Give up — surface the failure instead of fighting noble. The user can
  // press the manual "Reset BLE stack" button which does a full HCI reset
  // out-of-band, or fix the underlying OS issue (rfkill block, missing caps).
  logConnectionEvent({
    type: 'connect_start',
    detail: `ensureAdapterUp gav upp utan att toggla hci0 (raw=${getNobleRawState() ?? 'unknown'}, effective=${getAdapterState() ?? 'unknown'}). Tryck "Återställ BLE-stack" om det inte löser sig.`,
  });
  return false;
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

/**
 * Check if hci0 is UP RUNNING by reading `hciconfig hci0` (no root required).
 * Returns true if adapter is up, false otherwise (incl. command missing).
 *
 * Använder runShellRead som garanterar PATH=/usr/sbin etc. — bash -lc
 * fungerar inte under systemd user-service (tom PATH i login-shell).
 * Memory: mem://pi/ble/no-bash-lc-for-system-tools
 */
export function isHci0Up(): boolean {
  const out = runShellRead('hciconfig hci0', { timeoutMs: 1500 });
  return /UP\s+RUNNING/.test(out);
}

/**
 * Poll `hciconfig hci0` until it reports UP RUNNING.
 * Non-destructive — read-only. PCC (root service) is responsible for bringing
 * the adapter up via ExecStartPre. Lotus user-service just waits.
 */
export async function waitForHci0Up(timeoutMs = 10000, intervalMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isHci0Up()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return isHci0Up();
}

export async function initAdapter(): Promise<void> {
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

// IMPORTANT: do NOT auto-init BLE on module import.
// On Raspberry Pi, touching HCI during process startup can race noble's own
// startup path and strand state at poweredOff/unknown. BLE should stay idle
// until an actual scan/connect request needs it.
