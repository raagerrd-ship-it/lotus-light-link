/**
 * BLE shared mutable state — single source of truth for device, stats, and config.
 * All modules read/write through these accessors to avoid circular imports.
 */

// @ts-ignore — noble types are approximate
import noble from '@stoprocent/noble';
import { readFileSync } from 'fs';
import { getItem, setItem } from '../storage.js';
import type { ConnectedDevice, BleConnectionEvent } from './types.js';

// ── Constants ──
export const SERVICE_UUID = 'fff0';
export const CHAR_UUID = 'fff3';

// ── Build tag — bump when BLE behaviour changes so we can verify the Pi
// is actually running the latest release. Shows up in /api/ble/diagnostics
// and in the boot log.
export const BLE_BUILD_TAG = '2026-04-18/hcitool-with-full-hci-reset';
console.log(`[BLE] build tag: ${BLE_BUILD_TAG}`);

// ── EARLY stateChange listener ──
// noble fires `stateChange` exactly ONCE shortly after require(). If any
// downstream module subscribes a few seconds later (after building HTTP
// server, loading config etc.) the event is gone and noble.state stays
// "unknown" forever even though the adapter is perfectly poweredOn.
// We MUST attach the listener synchronously here, on the very first import
// of noble, and cache the latest state for everyone else to read.
let _cachedNobleState: string | undefined = undefined;
let _firstStateChangeResolve: any = null;
const _firstStateChangePromise: Promise<string> = new Promise<string>((resolve) => {
  _firstStateChangeResolve = resolve;
});

// Boot-tracking: när processen startade och om noble någonsin hunnit fyra
// `stateChange`. Används av /api/ble/diagnostics så UI kan visa
// "Initialiserar BLE…" istället för "Adaptern vaknade inte" under de första
// 30–90 sekunderna efter en kall boot på Pi Zero 2W.
const _bootStartedAt = Date.now();
let _firstStateChangeAt: number | null = null;

export function getBleBootStartedAt(): number { return _bootStartedAt; }
export function getFirstStateChangeAt(): number | null { return _firstStateChangeAt; }
export function hasNobleEverFiredStateChange(): boolean { return _firstStateChangeAt != null; }

// ── HCI socket probe result (persisted from boot for diagnostics UI) ──
export interface HciProbeSnapshot {
  ok: boolean;
  method: string;
  errno?: string;
  error?: string;
  details?: string;
  ranAt: string;
}
let _hciProbeSnapshot: HciProbeSnapshot | null = null;
export function setHciProbeSnapshot(s: Omit<HciProbeSnapshot, 'ranAt'>): void {
  _hciProbeSnapshot = { ...s, ranAt: new Date().toISOString() };
}
export function getHciProbeSnapshot(): HciProbeSnapshot | null { return _hciProbeSnapshot; }

// ── Force-mutation snapshot (last forceNoblePoweredOn() result) ──
// Visas som ett steg i pipeline-checklistan i UI:t så användaren ser
// om mutation faktiskt fastnar eller om noble har read-only getters.
export interface ForceMutationSnapshot {
  stuck: boolean;
  after: string | undefined;
  attempts: string[];
  failures: string[];
  ranAt: string;
}
let _forceMutationSnapshot: ForceMutationSnapshot | null = null;
export function getForceMutationSnapshot(): ForceMutationSnapshot | null { return _forceMutationSnapshot; }
function setForceMutationSnapshot(s: Omit<ForceMutationSnapshot, 'ranAt'>): void {
  _forceMutationSnapshot = { ...s, ranAt: new Date().toISOString() };
}

try {
  (noble as any).on?.('stateChange', (s: string) => {
    _cachedNobleState = s;
    if (_firstStateChangeAt == null) _firstStateChangeAt = Date.now();
    console.log(`[BLE:stateChange] ${s}`);
    if (_firstStateChangeResolve) {
      _firstStateChangeResolve(s);
      _firstStateChangeResolve = null;
    }
  });
  const initial = (noble as any).state ?? (noble as any)._state;
  if (initial && initial !== 'unknown') {
    _cachedNobleState = initial;
    if (_firstStateChangeAt == null) _firstStateChangeAt = Date.now();
    if (_firstStateChangeResolve) {
      _firstStateChangeResolve(initial);
      _firstStateChangeResolve = null;
    }
  }
} catch (e) {
  console.error('[BLE] failed to attach early stateChange listener:', e);
}

/**
 * Wait for noble's first `stateChange` event (or already-cached state).
 * Resolves to the state string ('poweredOn', 'poweredOff', 'unauthorized', ...).
 * Resolves to 'timeout' if no event fires within `timeoutMs`.
 *
 * MUST be awaited at boot before any other code blocks the event loop —
 * noble emits `stateChange` exactly once via libuv, and if we busy-loop or
 * sync-block before it fires, the event is silently lost and noble.state
 * stays `unknown` for the rest of the process lifetime.
 */
export function waitForFirstStateChange(timeoutMs = 5000): Promise<string> {
  if (_cachedNobleState) return Promise.resolve(_cachedNobleState);
  return Promise.race([
    _firstStateChangePromise,
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
}

// ── Single device state ──
let _device: ConnectedDevice | null = null;

export function getDevice(): ConnectedDevice | null { return _device; }
export function setDevice(d: ConnectedDevice | null): void { _device = d; }

// ── Saved device (persisted) ──
let _savedDeviceId: string | null = getItem('ble-device-id') ?? null;
let _savedDeviceName: string | null = getItem('ble-device-name') ?? null;
let _savedDeviceAddress: string | null = getItem('ble-device-address') ?? null;
let _savedAddressType: string | null = getItem('ble-address-type') ?? null;
let _savedConnectable: boolean | null = (() => { const v = getItem('ble-connectable'); return v === 'true' ? true : v === 'false' ? false : null; })();
let _savedServiceUuids: string[] | null = (() => { try { const v = getItem('ble-service-uuids'); return v ? JSON.parse(v) : null; } catch { return null; } })();

export function getSavedDeviceId(): string | null { return _savedDeviceId; }
export function getSavedDeviceName(): string | null { return _savedDeviceName; }
export function getSavedDeviceAddress(): string | null { return _savedDeviceAddress; }
export function getSavedAddressType(): string | null { return _savedAddressType; }
export function getSavedConnectable(): boolean | null { return _savedConnectable; }
export function getSavedServiceUuids(): string[] | null { return _savedServiceUuids; }

export interface SavedDeviceMetadata {
  id: string | null;
  name: string | null;
  address?: string | null;
  addressType?: string | null;
  connectable?: boolean | null;
  serviceUuids?: string[] | null;
  serviceHandle?: number | null;
  charHandle?: number | null;
}

// ── GATT handle cache ──
let _savedServiceHandle: number | null = (() => { const v = getItem('ble-service-handle'); return v ? Number(v) : null; })();
let _savedCharHandle: number | null = (() => { const v = getItem('ble-char-handle'); return v ? Number(v) : null; })();

export function getSavedServiceHandle(): number | null { return _savedServiceHandle; }
export function getSavedCharHandle(): number | null { return _savedCharHandle; }

export function setSavedGattHandles(serviceHandle: number | null, charHandle: number | null): void {
  _savedServiceHandle = serviceHandle;
  _savedCharHandle = charHandle;
  setItem('ble-service-handle', serviceHandle != null ? String(serviceHandle) : '');
  setItem('ble-char-handle', charHandle != null ? String(charHandle) : '');
}

export function setSavedDevice(id: string | null, name: string | null, address?: string | null, meta?: Partial<SavedDeviceMetadata>): void {
  _savedDeviceId = id;
  _savedDeviceName = name;
  _savedDeviceAddress = address ?? null;
  _savedAddressType = meta?.addressType ?? null;
  _savedConnectable = meta?.connectable ?? null;
  _savedServiceUuids = meta?.serviceUuids ?? null;
  if (meta?.serviceHandle !== undefined) _savedServiceHandle = meta.serviceHandle ?? null;
  if (meta?.charHandle !== undefined) _savedCharHandle = meta.charHandle ?? null;
  setItem('ble-device-id', id ?? '');
  setItem('ble-device-name', name ?? '');
  setItem('ble-device-address', address ?? '');
  setItem('ble-address-type', _savedAddressType ?? '');
  setItem('ble-connectable', _savedConnectable != null ? String(_savedConnectable) : '');
  setItem('ble-service-uuids', _savedServiceUuids ? JSON.stringify(_savedServiceUuids) : '');
  if (meta?.serviceHandle !== undefined) setItem('ble-service-handle', _savedServiceHandle != null ? String(_savedServiceHandle) : '');
  if (meta?.charHandle !== undefined) setItem('ble-char-handle', _savedCharHandle != null ? String(_savedCharHandle) : '');
  // Clear GATT cache when device is forgotten
  if (id === null) {
    _savedServiceHandle = null;
    _savedCharHandle = null;
    setItem('ble-service-handle', '');
    setItem('ble-char-handle', '');
  }
}

// ── Demand-based connection ──
let _demandConnect = false;

export function isDemandActive(): boolean { return _demandConnect; }
export function setDemand(v: boolean): void { _demandConnect = v; }

// ── Stats ──
export const bleStats = {
  sentCount: 0,
  skipDeltaCount: 0,
  skipBusyCount: 0,
  writeFailCount: 0,

  writeLatMs: 0,
  writeLatAvgMs: 0,
  effectiveIntervalMs: 0,

  // Connection stability
  disconnectCount: 0,
  reconnectCount: 0,
  lastDisconnectReason: null as string | null,
  lastDisconnectAt: null as string | null,

  // Connection interval diagnostics
  requestedIntervalMs: '—' as string,
  actualIntervalMs: '—' as string,
  intervalSource: 'unknown' as string,
};

// ── Workaround usage counters ──
// Spårar hur ofta varje defensiv fallback faktiskt triggas. Om en counter
// står på 0 efter en vecka i drift → koden är död och kan rensas bort
// efter den rena PCC-installationen. Visas i /api/ble/diagnostics.
export const workaroundCounters = {
  // forceNoblePoweredOn() — varje gång vi ger upp och accepterar caps-aware state
  forceNoblePoweredOn_invoked: 0,
  forceNoblePoweredOn_skippedHealthy: 0,
  forceNoblePoweredOn_neededRefresh: 0,
  // hciconfig down/up/reset
  resetHciAdapter_invoked: 0,
  // (DEAD: removed 2026-04-18) systemctl restart bluetooth — Lotus får aldrig röra bluetoothd
  hardBluetoothRestart_invoked: 0,
  // POST /api/ble/reset från UI-knappen
  manualBleReset_invoked: 0,
  // restartNobleHci — refresh av noble HCI-listeners
  restartNobleHci_invoked: 0,
  // getAdapterState() override (raw=unknown men caps OK → reporting poweredOn)
  capsOverride_applied: 0,
  // Caps self-check failures (saknar CAP_NET_RAW/CAP_NET_ADMIN)
  capsSelfCheck_failed: 0,
  // Watchdog: noble fastnade i `unknown` trots UP RUNNING + caps OK → process.exit(1)
  nobleStuckRespawn_invoked: 0,
  // Watchdog ville respawna men cooldown blockerade (skydd mot loop)
  nobleStuckRespawn_cooldownBlocked: 0,
  // Force-revert watchdog: noble.state återgick till `unknown` efter en lyckad
  // force-mutation. Indikerar att noble självskriver över våra ändringar
  // (t.ex. internt event från HCI-bindningen som nollställer state).
  forceMutationReverted: 0,
  // Sista gång varje workaround triggades
  lastInvocationAt: {} as Record<string, string>,
};

export function bumpWorkaround(key: keyof Omit<typeof workaroundCounters, 'lastInvocationAt'>): void {
  workaroundCounters[key]++;
  workaroundCounters.lastInvocationAt[key] = new Date().toISOString();
}

// ── Connection event log (ring buffer for diagnostics) ──
const MAX_EVENTS = 50;
const _connectionLog: BleConnectionEvent[] = [];

export function logConnectionEvent(event: Omit<BleConnectionEvent, 'timestamp'>): void {
  const entry: BleConnectionEvent = { ...event, timestamp: new Date().toISOString() };
  _connectionLog.push(entry);
  if (_connectionLog.length > MAX_EVENTS) _connectionLog.shift();

  // Also console-log with structured prefix for easy grep
  const detail = entry.detail ? ` — ${entry.detail}` : '';
  const dur = entry.durationMs != null ? ` (${entry.durationMs}ms)` : '';
  const dev = entry.device ? ` [${entry.device}]` : '';
  console.log(`[BLE:${entry.type}]${dev}${detail}${dur}`);
}

export function getConnectionLog(): BleConnectionEvent[] {
  return [..._connectionLog];
}

// ── Noble adapter helpers ──

export function processHasBtCaps(): boolean {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const match = status.match(/^CapEff:\s*([0-9a-fA-F]+)$/m);
    if (match) {
      const caps = BigInt('0x' + match[1]);
      const needed = (1n << 12n) | (1n << 13n);
      return (caps & needed) === needed;
    }
  } catch {
    // not on Linux or /proc unavailable
  }
  return false;
}

/**
 * Boot-time self-check of BLE capabilities. Logs a clear ✓/✗ banner so
 * misconfigured systemd services are obvious in the engine logs and in
 * /api/ble/diagnostics. Safe to call multiple times (idempotent).
 */
let _capsSelfCheckRan = false;
export function runBleCapsSelfCheck(): {
  hasCaps: boolean;
  capEff: string | null;
  uid: number | null;
  missing: string[];
} {
  let capEff: string | null = null;
  let uid: number | null = null;
  const missing: string[] = [];

  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const m = status.match(/^CapEff:\s*([0-9a-fA-F]+)$/m);
    if (m) capEff = m[1];
    const u = status.match(/^Uid:\s*(\d+)/m);
    if (u) uid = Number(u[1]);
  } catch {
    // not Linux
  }

  let hasCaps = false;
  if (capEff != null) {
    const caps = BigInt('0x' + capEff);
    const hasNetRaw = (caps & (1n << 13n)) !== 0n;
    const hasNetAdmin = (caps & (1n << 12n)) !== 0n;
    if (!hasNetRaw) missing.push('CAP_NET_RAW');
    if (!hasNetAdmin) missing.push('CAP_NET_ADMIN');
    hasCaps = hasNetRaw && hasNetAdmin;
  }

  if (_capsSelfCheckRan) return { hasCaps, capEff, uid, missing };
  _capsSelfCheckRan = true;

  if (capEff == null) {
    console.log('[BLE:caps-check] ⚠ /proc/self/status unavailable — kan inte verifiera capabilities (icke-Linux?)');
    logConnectionEvent({ type: 'connect_start', detail: 'caps-check: /proc unavailable' });
    return { hasCaps, capEff, uid, missing };
  }

  if (hasCaps) {
    console.log(`[BLE:caps-check] ✓ CAP_NET_RAW + CAP_NET_ADMIN OK (CapEff=${capEff}, uid=${uid})`);
    logConnectionEvent({ type: 'connect_start', detail: `caps-check OK: CapEff=${capEff}` });
  } else {
    const isRoot = uid === 0;
    const banner = [
      '',
      '╔════════════════════════════════════════════════════════════════════╗',
      '║ [BLE:caps-check] ✗ SAKNAR BLE-CAPABILITIES                         ║',
      `║   Saknar: ${missing.join(' + ').padEnd(56)}║`,
      `║   CapEff=${(capEff ?? 'n/a').padEnd(58)}║`,
      `║   uid=${String(uid).padEnd(61)}║`,
      '║                                                                    ║',
      '║ Fix: kontrollera systemd user-service:                             ║',
      '║   ~/.config/systemd/user/lotus-light-engine.service                ║',
      '║                                                                    ║',
      '║   [Service]                                                        ║',
      '║   NoNewPrivileges=false                                            ║',
      '║   AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN                    ║',
      '║   CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN                  ║',
      '║                                                                    ║',
      '║ Sedan: systemctl --user daemon-reload &&                           ║',
      '║        systemctl --user restart lotus-light-engine                 ║',
      '╚════════════════════════════════════════════════════════════════════╝',
      '',
    ].join('\n');
    console.error(banner);
    if (isRoot) {
      console.error('[BLE:caps-check] (kör som root men saknar ändå caps — ovanligt; kontrollera CapBnd)');
    }
    bumpWorkaround('capsSelfCheck_failed');
    logConnectionEvent({
      type: 'connect_fail',
      detail: `caps-check FAIL: saknar ${missing.join('+')} (CapEff=${capEff}, uid=${uid}) — fixa systemd-service`,
    });
  }

  return { hasCaps, capEff, uid, missing };
}

let _capsOverrideLogged = false;

export function getNobleRawState(): string | undefined {
  // Prefer our cached value from the early stateChange listener — that's
  // the only source of truth that survives noble's "fire once at startup"
  // semantics. Fall back to noble's own properties.
  if (_cachedNobleState) return _cachedNobleState;
  const n = noble as typeof noble & {
    state?: string;
    _state?: string;
    adapterState?: string;
    _adapterState?: string;
  };
  return n.state ?? n._state ?? n.adapterState ?? n._adapterState;
}

export function getAdapterState(): string | undefined {
  const raw = getNobleRawState();

  if ((raw === 'unauthorized' || raw === 'unknown' || raw == null) && processHasBtCaps()) {
    bumpWorkaround('capsOverride_applied');
    if (!_capsOverrideLogged) {
      console.log('[BLE] noble state unclear but process has CAP_NET_RAW+CAP_NET_ADMIN — reporting poweredOn (without mutating noble internals)');
      _capsOverrideLogged = true;
    }
    return 'poweredOn';
  }
  return raw;
}

/**
 * Force noble's INTERNAL state to 'poweredOn' so its built-in guard in
 * startScanningAsync/connectAsync stops throwing "state is unknown".
 *
 * Background: on Pi Zero 2W noble's first `stateChange` event sometimes
 * never fires (libuv timing race). hci0 is UP RUNNING and the process has
 * CAP_NET_RAW + CAP_NET_ADMIN, but noble's internal `_state` stays
 * `unknown` forever. noble's own scan/connect methods do
 * `if (this.state !== 'poweredOn') throw ...` BEFORE touching the HCI
 * socket, so caps-aware accept doesn't help — we must mutate noble itself.
 *
 * Only call when caps OK + hci0 UP. Idempotent + cheap.
 */
let _forcePoweredOnLogged = false;
// Watchdog-state: undvik flera samtidiga pollers + cooldown så loggen inte
// flödas över om noble revertar varje sekund.
let _revertWatchdogActive = false;
let _lastRevertLogAt = 0;

/**
 * Pollar noble.state under WATCH_MS ms efter en lyckad force-mutation.
 * Om raw state hoppar tillbaka till `unknown`/`poweredOff`/null:
 *   - bumpar `forceMutationReverted`-counter
 *   - loggar event i connection-log (max 1/15s för att undvika spam)
 *   - mut­erar tillbaka till poweredOn igen (best effort)
 * Detta ger oss data: revertar noble en gång (libuv-event efter setup) eller
 * konstant (då måste vi hooka in djupare i noble-bindings)?
 */
function startForceRevertWatchdog(): void {
  if (_revertWatchdogActive) return;
  _revertWatchdogActive = true;

  const WATCH_MS = 8000;
  const POLL_MS = 250;
  const startedAt = Date.now();
  let revertCount = 0;

  const tick = () => {
    if (Date.now() - startedAt >= WATCH_MS) {
      _revertWatchdogActive = false;
      if (revertCount > 0) {
        logConnectionEvent({
          type: 'connect_fail',
          detail: `force-revert-watchdog: noble.state revertade ${revertCount}x under ${WATCH_MS}ms — noble självskriver över mutationen`,
        });
      }
      return;
    }

    const n = noble as any;
    const raw = n.state ?? n._state;
    if (raw && raw !== 'poweredOn') {
      revertCount++;
      workaroundCounters.forceMutationReverted++;
      workaroundCounters.lastInvocationAt['forceMutationReverted'] = new Date().toISOString();

      // Logga max 1/15s för att skydda eventloggen från spam
      const now = Date.now();
      if (now - _lastRevertLogAt > 15000) {
        _lastRevertLogAt = now;
        logConnectionEvent({
          type: 'connect_fail',
          detail: `force-revert: noble.state=${raw} (${Math.round((now - startedAt) / 1000)}s efter mutation) — re-mutating`,
        });
      }

      // Re-mutate så vi håller noble sövd. Om detta också misslyckas
      // ser vi det som extra revertCount-bumpar.
      try {
        n.state = 'poweredOn';
        n._state = 'poweredOn';
        if (n._bindings) {
          n._bindings.state = 'poweredOn';
          if (n._bindings._state !== undefined) n._bindings._state = 'poweredOn';
        }
        _cachedNobleState = 'poweredOn';
      } catch {
        // best effort
      }
    }

    setTimeout(tick, POLL_MS);
  };

  setTimeout(tick, POLL_MS);
}

export function forceNoblePoweredOn(): boolean {
  const raw = getNobleRawState();
  if (raw === 'poweredOn') {
    bumpWorkaround('forceNoblePoweredOn_skippedHealthy');
    return true;
  }
  // OBS: ingen caps-gating här. På Pi körs vi via systemd user-service med
  // AmbientCapabilities + file-caps på node-binären. processHasBtCaps()
  // läser /proc/self/status CapEff men returnerar ibland false trots att
  // noble's HCI-socket fungerar (caps är OK i kärnan men CapEff räknas
  // annorlunda för user-services). Att skippa mutationen pga den check:en
  // betyder att noble's interna `state is unknown`-guard alltid blockar
  // scan/connect — exakt det vi sett i UI-loggen ("SKIPPED (caps missing)"
  // → "startScanning failed"). Mutera alltid; om HCI-socket failar nedanför
  // ser vi det som en ärlig EPERM istället för tyst skip.
  const capsOk = processHasBtCaps();
  bumpWorkaround('forceNoblePoweredOn_invoked');
  bumpWorkaround('forceNoblePoweredOn_neededRefresh');
  if (!capsOk) {
    bumpWorkaround('capsSelfCheck_failed');
  }
  bumpWorkaround('forceNoblePoweredOn_invoked');
  bumpWorkaround('forceNoblePoweredOn_neededRefresh');

  const n = noble as any;
  const attempts: string[] = [];
  const failures: string[] = [];

  /**
   * Försök sätta target[key]='poweredOn' med eskalerande aggressivitet:
   *  1) Vanlig assignment
   *  2) Object.defineProperty med writable+configurable (bypassar getter-only)
   *  3) Object.defineProperty på prototypen (om descriptor finns där)
   *  4) Ta bort prop helt och re-define som data-property
   * Loggar exakt descriptor-info så vi ser VARFÖR det failar.
   */
  const forceSet = (path: string, target: any, key: string) => {
    if (!target) {
      failures.push(`${path}: target is null/undefined`);
      return;
    }

    // Inspektera descriptor (egen + prototypkedja)
    let desc = Object.getOwnPropertyDescriptor(target, key);
    let descSource = 'own';
    if (!desc) {
      const proto = Object.getPrototypeOf(target);
      if (proto) {
        desc = Object.getOwnPropertyDescriptor(proto, key);
        descSource = 'proto';
      }
    }
    const descInfo = desc
      ? `${descSource}{w=${desc.writable},c=${desc.configurable},g=${!!desc.get},s=${!!desc.set}}`
      : 'no-descriptor';

    // Steg 1: vanlig assignment
    try {
      target[key] = 'poweredOn';
      if (target[key] === 'poweredOn') {
        attempts.push(`${path}=assign(${descInfo})`);
        return;
      }
      // Tyst no-op (sloppy mode + read-only) — gå vidare till defineProperty
    } catch (e: any) {
      // Strict mode kastar — fortsätt med defineProperty
    }

    // Steg 2: defineProperty på objektet självt
    try {
      Object.defineProperty(target, key, {
        value: 'poweredOn',
        writable: true,
        configurable: true,
        enumerable: true,
      });
      if (target[key] === 'poweredOn') {
        attempts.push(`${path}=defineProperty(${descInfo})`);
        return;
      }
      failures.push(`${path}: defineProperty silent-fail (${descInfo})`);
    } catch (e: any) {
      // Steg 3: om configurable=false på objektet, prova att redefiniera på prototypen
      if (descSource === 'proto' && desc) {
        try {
          const proto = Object.getPrototypeOf(target);
          Object.defineProperty(proto, key, {
            value: 'poweredOn',
            writable: true,
            configurable: true,
            enumerable: true,
          });
          if (target[key] === 'poweredOn') {
            attempts.push(`${path}=defineProperty-on-proto(${descInfo})`);
            return;
          }
        } catch (e2: any) {
          failures.push(`${path}: proto-defineProperty failed (${descInfo}): ${e2?.message ?? e2}`);
          return;
        }
      }
      failures.push(`${path}: defineProperty failed (${descInfo}): ${e?.message ?? e}`);
    }
  };

  forceSet('noble.state', n, 'state');
  forceSet('noble._state', n, '_state');
  if (n._bindings) {
    forceSet('noble._bindings.state', n._bindings, 'state');
    if ('_state' in n._bindings) {
      forceSet('noble._bindings._state', n._bindings, '_state');
    }
  }

  // Verifiera om någon mutation faktiskt fastnade
  const after = n.state ?? n._state;
  const stuck = after === 'poweredOn';

  _cachedNobleState = 'poweredOn';
  if (_firstStateChangeAt == null) _firstStateChangeAt = Date.now();
  if (_firstStateChangeResolve) {
    _firstStateChangeResolve('poweredOn');
    _firstStateChangeResolve = null;
  }

  setForceMutationSnapshot({ stuck, after, attempts, failures });

  // Om mutationen INTE fastnade — patcha noble's scan/connect-metoder så de
  // hoppar över sin interna `if (this.state !== 'poweredOn') throw`-guard.
  // Detta är sista utvägen när noble har frozen/getter-only state-prop.
  if (!stuck) {
    patchNobleSkipStateGuard();
  }

  if (!_forcePoweredOnLogged) {
    console.log(`[BLE] forceNoblePoweredOn: attempts=${attempts.join(',')} failures=${failures.join(';') || 'none'} stuck=${stuck} after=${after}`);
    _forcePoweredOnLogged = true;
  }

  // Diagnostisk event så vi ser i UI-loggen exakt vad som hände
  logConnectionEvent({
    type: stuck ? 'scan_start' : 'connect_fail',
    detail: `force-mutation: stuck=${stuck} after=${after} ok=[${attempts.join(',')}] fail=[${failures.join(';') || 'none'}]`,
  });

  if (stuck) {
    startForceRevertWatchdog();
  }

  return stuck;
}

// ── Runtime-patch: bypass noble's interna state-guard ──
// Wrappar startScanningAsync/connectAsync så de temporärt sätter
// this.state='poweredOn' (via lokal scope-variabel) under anropet, oavsett
// om descriptor är frozen. Vi ersätter metoderna med proxies som anropar
// originalimplementationen med en patched `this`.
let _nobleGuardPatched = false;
let _nobleGuardPatchResult: { ok: boolean; methods: string[]; error?: string } | null = null;

export function getNobleGuardPatchResult() { return _nobleGuardPatchResult; }

function patchNobleSkipStateGuard(): void {
  if (_nobleGuardPatched) return;
  _nobleGuardPatched = true;

  const n = noble as any;
  const patched: string[] = [];
  const errors: string[] = [];

  const wrap = (methodName: string) => {
    const original = n[methodName];
    if (typeof original !== 'function') {
      errors.push(`${methodName}: not a function (${typeof original})`);
      return;
    }
    try {
      // Skapa en Proxy som fakerar this.state='poweredOn' under anropet
      const wrapped = function (this: any, ...args: any[]) {
        const proxy = new Proxy(n, {
          get(target, prop, receiver) {
            if (prop === 'state' || prop === '_state') return 'poweredOn';
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
        return original.apply(proxy, args);
      };
      Object.defineProperty(n, methodName, {
        value: wrapped,
        writable: true,
        configurable: true,
      });
      patched.push(methodName);
    } catch (e: any) {
      errors.push(`${methodName}: ${e?.message ?? e}`);
    }
  };

  wrap('startScanningAsync');
  wrap('startScanning');
  wrap('connectAsync');
  wrap('connect');

  _nobleGuardPatchResult = {
    ok: patched.length > 0,
    methods: patched,
    error: errors.length ? errors.join('; ') : undefined,
  };

  console.log(`[BLE] patchNobleSkipStateGuard: patched=[${patched.join(',')}] errors=[${errors.join(';') || 'none'}]`);
  logConnectionEvent({
    type: patched.length > 0 ? 'scan_start' : 'connect_fail',
    detail: `noble-guard-patch: methods=[${patched.join(',')}] errors=[${errors.join(';') || 'none'}]`,
  });
}

export { noble };
