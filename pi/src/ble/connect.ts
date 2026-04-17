/**
 * BLE connection — all connection logic in one place.
 *
 * Single connection path: brief scan → peripheral.connectAsync() → full GATT discovery.
 * Mirrors the early monolithic Pi version that worked reliably.
 */

import {
  noble, getDevice, setDevice, bleStats, isDemandActive,
  getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, getSavedAddressType,
  setSavedDevice, logConnectionEvent, SERVICE_UUID, CHAR_UUID, getAdapterState,
  bumpWorkaround,
} from './state.js';
import { brightMaxBuf, startKeepAlive, stopKeepAlive, resetLastSent } from './protocol.js';
import { waitForAdapter, ensureAdapterUp, waitForNoblePoweredOn, normalizeBleKey, restartNobleHci } from './adapter.js';
import { isScanning, getDiscoveredPeripheral } from './scan.js';
import { savePeripheralMetadata } from './save.js';
import type { PiCharacteristic } from './types.js';

// ── HCI reset tracking ──
let consecutiveConnectFailures = 0;
const HCI_RESET_THRESHOLD = 3;
let activeConnectPromise: Promise<void> | null = null;
let nobleScanActive = false;

export function isNobleScanActive(): boolean { return nobleScanActive; }

export function getConsecutiveFailures(): number { return consecutiveConnectFailures; }
export function resetConsecutiveFailures(): void { consecutiveConnectFailures = 0; }
export function incrementConsecutiveFailures(): void { consecutiveConnectFailures++; }

// Hard ceiling for any single connect attempt. If the inner fn() never
// settles (e.g. noble's discover listener got wedged), we still release the
// lock so the next /api/ble/connect doesn't queue forever.
const CONNECT_LOCK_HARD_TIMEOUT_MS = 12_000;

async function withConnectLock<T>(deviceName: string | undefined, successResult: () => T, fn: () => Promise<T>): Promise<T> {
  // Don't queue: if a connect is already running, just bail with a no-op.
  // Stacking waiters caused the "Connect already in progress" infinite log.
  if (activeConnectPromise) {
    logConnectionEvent({ type: 'connect_start', device: deviceName, detail: 'Connect already in progress — skipping duplicate' });
    try { await activeConnectPromise; } catch {}
    return getDevice() ? successResult() : (0 as any);
  }

  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  activeConnectPromise = lock;

  // Hard timeout: force-release the lock even if fn() never settles.
  const safetyTimer = setTimeout(() => {
    if (activeConnectPromise === lock) {
      activeConnectPromise = null;
      logConnectionEvent({ type: 'connect_fail', device: deviceName, detail: `Lock safety timeout after ${CONNECT_LOCK_HARD_TIMEOUT_MS}ms — releasing` });
      release();
    }
  }, CONNECT_LOCK_HARD_TIMEOUT_MS);

  try {
    return await fn();
  } finally {
    clearTimeout(safetyTimer);
    if (activeConnectPromise === lock) activeConnectPromise = null;
    release();
  }
}

export async function resetHciAdapter(): Promise<void> {
  bumpWorkaround('resetHciAdapter_invoked');
  logConnectionEvent({ type: 'hci_reset', detail: 'rfkill unblock + hciconfig reset/up' });
  try {
    const { execFileSync } = await import('child_process');
    execFileSync('bash', ['-lc',
      // 1) unblock rfkill FIRST — without this hciconfig up is a no-op
      'rfkill unblock bluetooth >/dev/null 2>&1 || true; ' +
      // 2) cycle the adapter
      '(command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 down >/dev/null 2>&1; ' +
      ' command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 reset >/dev/null 2>&1; ' +
      // 3) bring it back up (must come AFTER reset, otherwise reset leaves it DOWN)
      ' command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 up >/dev/null 2>&1) || true; ' +
      // 4) double-check rfkill in case reset re-blocked it (seen on some kernels)
      'rfkill unblock bluetooth >/dev/null 2>&1 || true'
    ], { timeout: 6000, stdio: 'ignore' });
    bleStats.lastDisconnectReason = 'hci_reset';
    logConnectionEvent({ type: 'hci_reset', detail: 'hciconfig reset complete ✓ — refreshing noble HCI listeners' });

    // Give the kernel a moment after rfkill+up before noble re-binds
    await new Promise(r => setTimeout(r, 400));

    // Force noble to re-attach its HCI listeners — without this, noble keeps
    // reporting poweredOff even though hciconfig shows UP RUNNING.
    try { await restartNobleHci('hci_reset'); } catch {}

    // Wait for noble to actually see the adapter as poweredOn
    const ok = await waitForNoblePoweredOn(5000);
    if (ok) {
      logConnectionEvent({ type: 'hci_reset', detail: 'adapter poweredOn ✓ (post-reset)' });
    } else {
      // Last resort: hard-restart bluetoothd, which always re-arms the mgmt socket
      logConnectionEvent({ type: 'hci_reset', detail: `adapter still ${getAdapterState() ?? 'unknown'} after 5s — trying systemctl restart bluetooth` });
      await hardBluetoothRestart('hci_reset');
      const ok2 = await ensureAdapterUp();
      logConnectionEvent({
        type: 'hci_reset',
        detail: ok2
          ? 'adapter poweredOn ✓ (after bluetoothd restart)'
          : `adapter STILL ${getAdapterState() ?? 'unknown'} — manual reboot may be needed`,
      });
    }
  } catch (e: any) {
    logConnectionEvent({ type: 'hci_reset', detail: `hciconfig reset failed: ${e.message}` });
  }
}

/**
 * Hard kernel-level Bluetooth stack reset — last resort when noble is
 * permanently stuck in `unknown` after multiple HCI resets.
 *
 * `systemctl restart bluetooth` reloads bluetoothd which holds the management
 * socket. Combined with a brief settle, this almost always unsticks noble.
 */
async function hardBluetoothRestart(deviceName?: string): Promise<void> {
  bumpWorkaround('hardBluetoothRestart_invoked');
  logConnectionEvent({ type: 'hci_reset', device: deviceName, detail: 'systemctl restart bluetooth (last resort)' });
  try {
    const { execFileSync } = await import('child_process');
    execFileSync('bash', ['-lc', 'systemctl restart bluetooth >/dev/null 2>&1 || sudo systemctl restart bluetooth >/dev/null 2>&1 || true'], { timeout: 8000, stdio: 'ignore' });
    // bluetoothd needs a moment to re-register the adapter
    await new Promise(r => setTimeout(r, 2500));
    logConnectionEvent({ type: 'hci_reset', device: deviceName, detail: 'bluetooth service restarted ✓' });
  } catch (e: any) {
    logConnectionEvent({ type: 'hci_reset', device: deviceName, detail: `bluetooth restart failed: ${e.message}` });
  }
}

/**
 * Force noble's internal HCI binding to reach poweredOn.
 *
 * Strategy (least-invasive first):
 *  0. If noble is already poweredOn → no-op (don't disturb a healthy adapter).
 *  1. Wait up to 3s for noble to settle on its own (it often just needs time).
 *  2. Up to 3 soft attempts: hciconfig down/up/reset + restartNobleHci + wait 2s.
 *  3. Last resort: systemctl restart bluetooth + restartNobleHci + wait 3s.
 *
 * Aborts early on `unauthorized` / `poweredOff` (hard fails — no point looping).
 */
async function forceNoblePoweredOn(deviceName?: string): Promise<void> {
  bumpWorkaround('forceNoblePoweredOn_invoked');
  const readState = () => (noble as any).state ?? (noble as any)._state;
  const effectiveState = () => getAdapterState();

  // If the caps-aware adapter state is already good, do not touch the kernel
  // adapter. On Pi, that is the exact path that tends to wedge raw noble state.
  if (effectiveState() === 'poweredOn') {
    bumpWorkaround('forceNoblePoweredOn_skippedHealthy');
    logConnectionEvent({
      type: 'hci_reset',
      device: deviceName,
      detail: `Skipping noble reset — effective adapter state is poweredOn (raw=${readState() ?? 'unknown'})`,
    });
    return;
  }

  bumpWorkaround('forceNoblePoweredOn_neededRefresh');

  try {
    await (noble as any).waitForPoweredOnAsync?.(3000);
    if (readState() === 'poweredOn' || effectiveState() === 'poweredOn') {
      logConnectionEvent({ type: 'hci_reset', device: deviceName, detail: 'noble poweredOn ✓ (no reset needed)' });
      return;
    }
  } catch {}

  const SOFT_ATTEMPTS = 2;
  for (let i = 1; i <= SOFT_ATTEMPTS; i++) {
    const before = readState();
    logConnectionEvent({
      type: 'hci_reset',
      device: deviceName,
      detail: `noble state=${before ?? 'unknown'} — listener refresh ${i}/${SOFT_ATTEMPTS}`,
    });

    try { await restartNobleHci(deviceName); } catch {}

    try {
      await (noble as any).waitForPoweredOnAsync?.(2000);
    } catch {}

    const after = readState();
    if (after === 'poweredOn' || effectiveState() === 'poweredOn') {
      logConnectionEvent({ type: 'hci_reset', device: deviceName, detail: `adapter ready ✓ (after refresh ${i})` });
      return;
    }
    if (after === 'unauthorized' || after === 'poweredOff') {
      logConnectionEvent({ type: 'hci_reset', device: deviceName, detail: `Hard fail (${after}) — abort` });
      return;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  logConnectionEvent({
    type: 'hci_reset',
    device: deviceName,
    detail: `noble still ${readState() ?? 'unknown'} after safe refresh — proceeding with caps-aware adapter state=${effectiveState() ?? 'unknown'}`,
  });
}

// ── Timeout helper — per-step budgets ──
// L2CAP and write are quick; GATT discovery on BLEDOM has been observed
// up to ~4s on a marginal link, so give it more headroom.
const TIMEOUTS = { l2cap: 3000, gatt: 5000, write: 2000 } as const;
type StepKind = keyof typeof TIMEOUTS;

function withTimeout<T>(promise: Promise<T>, label: string, kind: StepKind = 'l2cap'): Promise<T> {
  const ms = TIMEOUTS[kind];
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(v => { clearTimeout(timer); return v; }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** Exposed so reconnect.ts can wait out an in-flight connect before its first attempt. */
export function isConnectInProgress(): boolean { return activeConnectPromise !== null; }
export async function waitForConnectIdle(maxMs = 12_000): Promise<void> {
  const p = activeConnectPromise;
  if (!p) return;
  await Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, maxMs))]);
}

// ── Reconnect handler (set by reconnect.ts to break circular dep) ──
let _reconnectWithBackoff: ((peripheral: any, name: string) => void) | null = null;
export function setReconnectHandler(fn: (peripheral: any, name: string) => void): void {
  _reconnectWithBackoff = fn;
}

// ═══════════════════════════════════════════════════════════════════
//  GATT discovery — shared by both direct and scan-based connect
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a handle-based characteristic wrapper that writes directly
 * via peripheral.writeHandleAsync, bypassing GATT discovery entirely.
 */
// ═══════════════════════════════════════════════════════════════════
//  GATT discovery — mirrors early monolith (always full discovery, no cache)
// ═══════════════════════════════════════════════════════════════════

/**
 * Connect to a peripheral, discover GATT services/characteristics,
 * set connection interval, and wire up disconnect handler.
 *
 * Always performs full GATT discovery — no handle cache. The cache caused
 * stale-handle failures across reconnects and adds no measurable value.
 */
export async function connectPeripheral(peripheral: any, _retryCount = 0, skipL2cap = false): Promise<void> {
  const MAX_DISCOVERY_RETRIES = 3;
  const name = peripheral.advertisement?.localName ?? peripheral.id;
  const connectStart = performance.now();
  let connectDuration = 0;

  logConnectionEvent({ type: 'connect_start', device: name, detail: `attempt ${_retryCount + 1}${skipL2cap ? ' (already connected)' : ''}` });

  // Step 1: L2CAP connect
  if (!skipL2cap) {
    try {
      await withTimeout(peripheral.connectAsync(), 'BLE connect', 'l2cap');
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: `Connect failed: ${e.message}`, durationMs: Math.round(performance.now() - connectStart) });
      throw e;
    }
  }
  connectDuration = Math.round(performance.now() - connectStart);
  logConnectionEvent({ type: 'connect_ok', device: name, detail: skipL2cap ? 'L2CAP already up' : 'L2CAP connected', durationMs: connectDuration });

  // Step 2: Full GATT discovery (combined call, like the early monolith)
  const gattStart = performance.now();
  let characteristics: any[] = [];
  try {
    logConnectionEvent({ type: 'gatt_discovery', device: name, detail: 'discoverSomeServicesAndCharacteristicsAsync...' });
    const result = await withTimeout(
      peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [CHAR_UUID]),
      'GATT discovery',
      'gatt'
    ) as any;
    // @stoprocent/noble returns { services, characteristics } object;
    // @abandonware/noble returned [services, characteristics] array.
    // Handle both shapes.
    if (Array.isArray(result)) {
      characteristics = result[1] ?? [];
    } else {
      characteristics = result?.characteristics ?? [];
    }
  } catch (e: any) {
    logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `GATT discovery failed: ${e.message}` });
  }

  const gattDuration = Math.round(performance.now() - gattStart);

  if (!characteristics?.length) {
    if (_retryCount < MAX_DISCOVERY_RETRIES) {
      // Keep L2CAP up between GATT retries — disconnecting and reconnecting
      // on @stoprocent/noble often triggers "already connected" errors.
      const delay = 500 * (_retryCount + 1);
      logConnectionEvent({ type: 'gatt_retry', device: name, detail: `No characteristic — retry ${_retryCount + 1}/${MAX_DISCOVERY_RETRIES} in ${delay}ms (L2CAP kept)`, durationMs: gattDuration });
      await new Promise(r => setTimeout(r, delay));
      return connectPeripheral(peripheral, _retryCount + 1, true);
    }
    try { await peripheral.disconnectAsync(); } catch {}
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `No characteristic after ${MAX_DISCOVERY_RETRIES} retries`, durationMs: gattDuration });
    throw new Error(`No characteristic found on ${name} after ${MAX_DISCOVERY_RETRIES} retries`);
  }

  logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `GATT OK — ${characteristics.length} characteristic(s)`, durationMs: gattDuration });

  const char = characteristics[0] as PiCharacteristic;
  char.deviceName = name;
  char.deviceId = peripheral.id;

  // Write brightness max — same as early monolith
  await withTimeout(char.writeAsync(brightMaxBuf, true), 'Brightness write', 'write');

  // Step 3: Request minimum connection interval
  requestConnectionInterval(peripheral, name);

  // Step 4: Register disconnect handler BEFORE activating device (prevents race condition)
  peripheral.once('disconnect', (reason: any) => {
    const uptime = Math.round((performance.now() - connectStart) / 1000);
    bleStats.disconnectCount++;
    bleStats.lastDisconnectReason = String(reason ?? 'unknown');
    bleStats.lastDisconnectAt = new Date().toISOString();

    logConnectionEvent({
      type: 'disconnect',
      device: name,
      detail: `reason=${reason ?? 'unknown'}, uptime=${uptime}s, sent=${bleStats.sentCount}, avgLat=${bleStats.writeLatAvgMs}ms`,
    });

    stopKeepAlive();
    setDevice(null);
    resetLastSent();

    if (isDemandActive()) {
      bleStats.reconnectCount++;
      logConnectionEvent({ type: 'reconnect_start', device: name, detail: `rc#${bleStats.reconnectCount}` });
      if (_reconnectWithBackoff) _reconnectWithBackoff(peripheral, name);
    }
  });

  // Step 5: Activate device (safe — disconnect handler already registered)
  setDevice({ peripheral, characteristic: char, mode: 'rgb', name, id: peripheral.id });
  consecutiveConnectFailures = 0;
  startKeepAlive();

  // Backfill saved name if missing
  if (getSavedDeviceId() === peripheral.id && (!getSavedDeviceName() || getSavedDeviceName() === peripheral.id)) {
    setSavedDevice(peripheral.id, name);
    console.log(`[BLE] Backfilled saved name: ${name}`);
  }

  const totalDuration = Math.round(performance.now() - connectStart);
  logConnectionEvent({ type: 'connect_ok', device: name, detail: `Fully ready (connect=${connectDuration}ms, gatt=${Math.round(performance.now() - gattStart)}ms)`, durationMs: totalDuration });
}

// ═══════════════════════════════════════════════════════════════════
//  Scan-based connect — primary path (mirrors old working monolith)
// ═══════════════════════════════════════════════════════════════════

/**
 * Scan briefly for a target MAC, then peripheral.connectAsync().
 * This is what worked in the early monolithic Pi version — it doesn't rely on
 * the @stoprocent/noble-specific noble.connectAsync(address) API which has
 * proven unreliable on this hardware.
 */
export async function nobleScanConnect(targetMacOrId: string, name: string, timeoutMs = 6000): Promise<boolean> {
  const targetNorm = normalizeBleKey(targetMacOrId);

  // Trust caps — don't gate on adapter state
  if (!await waitForAdapter(name)) return false;

  // Make sure no stale scan is holding the HCI socket
  try { (noble as any).stopScanning?.(); } catch {}

  // Only force-reinit noble if it's NOT already poweredOn. Touching the
  // adapter when noble is healthy is what causes most `unknown` lockups.
  await forceNoblePoweredOn(name);

  const attempt = async (): Promise<boolean> => new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onDiscover: ((peripheral: any) => void) | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (onDiscover) { try { noble.removeListener('discover', onDiscover); } catch {} onDiscover = null; }
      try { noble.stopScanning(); } catch {}
      // Always clear the active flag — even if listener removal threw.
      nobleScanActive = false;
    };

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;          // set BEFORE cleanup so re-entrant events bail
      try { cleanup(); } catch {}
      resolve(ok);
    };

    onDiscover = (peripheral: any) => {
      if (done) return;     // duplicate advertisement after match — ignore
      const pid = normalizeBleKey(peripheral.id);
      const pmac = normalizeBleKey(peripheral.address);
      if (pid !== targetNorm && pmac !== targetNorm) return;

      // Mark done + tear down the listener BEFORE awaiting connect, so the
      // scan timer can't fire finish(false) while we're mid-connect, and a
      // second discover event for the same peripheral can't re-enter.
      done = true;
      try { cleanup(); } catch {}

      logConnectionEvent({ type: 'connect_start', device: name, detail: `Found via scan, connecting (addressType=${peripheral.addressType ?? 'unknown'})` });

      connectPeripheral(peripheral, 0, false).then(
        () => resolve(true),
        (e: any) => {
          logConnectionEvent({ type: 'connect_fail', device: name, detail: `Scan-connect failed: ${e.message}` });
          resolve(false);
        }
      );
    };

    noble.on('discover', onDiscover);
    nobleScanActive = true;

    timer = setTimeout(() => {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: `Scan-connect timeout (${timeoutMs}ms) — device not advertising?` });
      finish(false);
    }, timeoutMs);

    logConnectionEvent({ type: 'connect_start', device: name, detail: `Scanning for ${targetNorm} (timeout=${timeoutMs}ms)` });

    try {
      // Allow duplicates — BLEDOM advertises infrequently
      const startPromise = (noble as any).startScanningAsync?.([], true);
      if (startPromise && typeof startPromise.catch === 'function') {
        startPromise.catch((e: any) => {
          logConnectionEvent({ type: 'connect_fail', device: name, detail: `startScanning failed: ${e.message}` });
          finish(false);
        });
      }
    } catch (e: any) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: `startScanning threw: ${e.message}` });
      finish(false);
    }
  });

  // First attempt
  let ok = await attempt();
  if (ok) return true;

  // Retry once, but only with a destructive HCI reset if the effective adapter
  // state is actually bad. If caps-aware state already says poweredOn, another
  // hciconfig reset tends to make noble even more stuck on Pi.
  if (getAdapterState() !== 'poweredOn') {
    logConnectionEvent({ type: 'hci_reset', detail: 'scan attempt failed — effective adapter not ready, resetting HCI before retry' });
    try { (noble as any).stopScanning?.(); } catch {}
    await resetHciAdapter();
    await new Promise(r => setTimeout(r, 400));
  } else {
    logConnectionEvent({ type: 'hci_reset', detail: 'scan attempt failed — skipping HCI reset because effective adapter is already poweredOn' });
  }

  ok = await attempt();
  return ok;
}

/**
 * Försök direct-connect via noble.connectAsync(address) — snabbt (~500ms)
 * när det fungerar, ingen scan behövs. Kräver att vi har sparad addressType.
 *
 * Returnerar true om hela kedjan (L2CAP + GATT + write) lyckades.
 * Vid fel returneras false utan att kasta — caller ska falla tillbaka på scan.
 */
async function tryDirectConnectAsync(name: string, timeoutMs: number): Promise<boolean> {
  const address = getSavedDeviceAddress();
  const addressType = getSavedAddressType();
  if (!address || !addressType) return false;
  if (typeof (noble as any).connectAsync !== 'function') return false;

  const directStart = performance.now();
  logConnectionEvent({
    type: 'connect_start',
    device: name,
    detail: `Direct-connect attempt (address=${address}, type=${addressType}, timeout=${timeoutMs}ms)`,
  });

  try {
    // noble.connectAsync(address, options) — connectar utan scan.
    const peripheral = await withTimeout(
      (noble as any).connectAsync(address.toLowerCase(), { addressType }),
      'Direct connect',
      'l2cap',
    ) as any;

    if (!peripheral) {
      logConnectionEvent({ type: 'connect_fail', device: name, detail: 'Direct-connect returned no peripheral' });
      return false;
    }

    // Peripheral är redan ansluten på L2CAP-nivå → skipL2cap=true
    await connectPeripheral(peripheral, 0, true);
    const totalMs = Math.round(performance.now() - directStart);
    logConnectionEvent({ type: 'connect_ok', device: name, detail: `Direct-connect SUCCESS (${totalMs}ms — no scan)`, durationMs: totalMs });
    return !!getDevice();
  } catch (e: any) {
    const totalMs = Math.round(performance.now() - directStart);
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `Direct-connect failed in ${totalMs}ms: ${e.message} — falling back to scan` });
    return false;
  }
}

/**
 * @deprecated Kept for backwards compat — delegates to scan-based connect.
 */
export async function nobleDirectConnect(name: string, timeoutMs = 5000): Promise<boolean> {
  const savedAddress = getSavedDeviceAddress() ?? getSavedDeviceId();
  if (!savedAddress) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: 'No saved address for scan-connect' });
    return false;
  }
  return nobleScanConnect(savedAddress, name, timeoutMs);
}

// ═══════════════════════════════════════════════════════════════════
//  Noble scan connect — first-time selection (needs peripheral object)
// ═══════════════════════════════════════════════════════════════════

/**
 * Connect directly to a selected device without relying on noble scanning.
 * On Raspberry Pi, noble discovery can stay stuck in `unknown` even when
 * direct connect works, so first-pairing uses the scanned MAC address.
 */
/**
 * Connect using a peripheral object cached from a recent scan.
 * This is exactly how the early monolith worked: scan → keep peripheral →
 * peripheral.connectAsync(). Mycket mer pålitligt än att starta en ny scan
 * eller använda noble.connectAsync(address) på Pi.
 */
async function connectFromScanCache(targetId: string, name: string): Promise<boolean> {
  const peripheral = getDiscoveredPeripheral(targetId);
  if (!peripheral) {
    logConnectionEvent({ type: 'connect_start', device: name, detail: `No cached peripheral for ${targetId} — falling back to scan-connect` });
    return false;
  }
  logConnectionEvent({
    type: 'connect_start',
    device: name,
    detail: `Using cached peripheral from scan (addressType=${peripheral.addressType ?? 'unknown'})`,
  });
  try {
    await connectPeripheral(peripheral, 0, false);
    return !!getDevice();
  } catch (e: any) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `Cached connect failed: ${e.message}` });
    return false;
  }
}

export async function nobleConnect(targetId: string, name: string, timeoutMs = 8000): Promise<boolean> {
  return withConnectLock(name, () => true, async () => {
    // 1) Försök med peripheral från senaste scan (gamla monolit-vägen)
    let ok = await connectFromScanCache(targetId, name);
    // 2) Fallback: starta egen mini-scan och connecta när vi ser MAC:en
    if (!ok) ok = await nobleScanConnect(targetId, name, timeoutMs);
    if (ok) {
      const dev = getDevice();
      const savedId = getSavedDeviceId();
      if (dev && savedId && normalizeBleKey(savedId) === normalizeBleKey(targetId)) {
        const macWithColons = normalizeBleKey(targetId).replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
        savePeripheralMetadata(dev.peripheral, savedId, name, macWithColons);
      }
    }
    return ok;
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Auto-connect — called on startup and by reconnect loop
// ═══════════════════════════════════════════════════════════════════

/**
 * Auto-connect to saved device via brief scan + peripheral.connectAsync().
 * Mirrors the early monolithic Pi version that worked reliably.
 * No longer requires addressType metadata — scan finds it automatically.
 */
export async function autoConnectSaved(timeoutMs = 8000): Promise<number> {
  const savedId = getSavedDeviceId();
  if (!savedId) {
    console.log('[BLE] No saved device — waiting for user selection');
    return 0;
  }
  if (getDevice()) return 1;

  // Vänta ut ev. pågående scan (manuell parning från UI) innan connect.
  if (isScanning()) {
    logConnectionEvent({ type: 'connect_start', detail: 'Waiting for HCI-scan to finish before connect' });
    for (let i = 0; i < 50 && isScanning(); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (isScanning()) {
      logConnectionEvent({ type: 'connect_fail', detail: 'HCI-scan still active after 5s — skipping connect' });
      return 0;
    }
    if (getDevice()) return 1;
  }

  const savedName = getSavedDeviceName() ?? savedId;

  return withConnectLock(savedName, () => 1, async () => {
    if (getDevice()) return 1;

    const adapterReady = await ensureAdapterUp();
    if (!adapterReady) {
      logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Adapter not ready after ensureAdapterUp (${getAdapterState() ?? 'unknown'})` });
      return 0;
    }

    // Direct-connect ONLY. Scan-fallback borttagen — den kraschar noble-state
    // och är onödig för redan-sparade enheter (vi har MAC + addressType).
    // Om addressType saknas måste användaren parna om via UI:ts scan-flöde.
    if (!getSavedAddressType()) {
      logConnectionEvent({
        type: 'connect_fail',
        device: savedName,
        detail: 'Saknar addressType — parna om enheten via Scan i UI',
      });
      return 0;
    }

    const directOk = await tryDirectConnectAsync(savedName, Math.min(timeoutMs, 3000));
    if (directOk) return 1;

    incrementConsecutiveFailures();
    const fails = getConsecutiveFailures();
    logConnectionEvent({ type: 'connect_fail', device: savedName, detail: `Direct-connect misslyckades — enheten ev. avstängd/utom räckhåll [fail#${fails}]` });
    if (fails >= HCI_RESET_THRESHOLD && getAdapterState() !== 'poweredOn') {
      await resetHciAdapter();
      resetConsecutiveFailures();
    }
    return 0;
  });
}


// Legacy alias
export const tryDirectConnect = (_id: string) => autoConnectSaved().then(r => r > 0);

// ═══════════════════════════════════════════════════════════════════
//  Connection interval optimization
// ═══════════════════════════════════════════════════════════════════

function requestConnectionInterval(peripheral: any, name: string): void {
  try {
    const hci = (noble as any)._bindings?._hci;
    const handle = peripheral._handle ?? peripheral.handle;
    if (hci && handle != null && typeof hci.writeLeConnectionUpdate === 'function') {
      // Capture handle in a const for strict comparison inside the listener.
      const expectedHandle = handle;
      hci.writeLeConnectionUpdate(expectedHandle, 6, 8, 0, 200);
      bleStats.requestedIntervalMs = '7.5–10';
      console.log(`[BLE] Requested connection interval 7.5–10ms for ${name}`);

      if (typeof hci.on === 'function') {
        let settled = false;
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        const onLeConnUpdateComplete = (_status: number, connHandle: number, interval: number, latency: number, supervisionTimeout: number) => {
          if (connHandle !== expectedHandle) return;     // strict — ignore other handles
          if (settled) return;
          settled = true;
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
          try { hci.removeListener('leConnUpdateComplete', onLeConnUpdateComplete); } catch {}
          const actualMs = (interval * 1.25).toFixed(1);
          bleStats.actualIntervalMs = actualMs;
          bleStats.intervalSource = 'hci_event';
          console.log(`[BLE] Connection interval accepted: ${actualMs}ms (latency=${latency}, timeout=${supervisionTimeout * 10}ms)`);
        };
        hci.on('leConnUpdateComplete', onLeConnUpdateComplete);
        timeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { hci.removeListener('leConnUpdateComplete', onLeConnUpdateComplete); } catch {}
          if (bleStats.intervalSource === 'unknown') {
            bleStats.intervalSource = 'estimated';
          }
        }, 3000);
      }
    } else {
      bleStats.requestedIntervalMs = 'n/a (no HCI)';
      console.log(`[BLE] Connection interval update not available (HCI access limited)`);
    }
  } catch (e: any) {
    bleStats.requestedIntervalMs = 'error';
    console.warn(`[BLE] Failed to set connection interval: ${e.message}`);
  }
}
