/**
 * BLE shared mutable state — single source of truth for device, stats, and config.
 * All modules read/write through these accessors to avoid circular imports.
 */

// noble laddas LAZY via singleton — får aldrig require:as här på top-level
// (mem://pi/ble/noble-statechange-event-loop-race). `noble`-proxy:n triggar
// `require('@stoprocent/noble')` först vid första property-access, vilket
// sker först när startBleEngine() kör — inte vid module load.
import { noble, onNobleStateChange, hasNobleLoaded } from './noble-singleton.js';
import { readFileSync } from 'fs';
import { getItem, setItem } from '../storage.js';
import type { ConnectedDevice, BleConnectionEvent } from './types.js';
export { hasNobleLoaded };

// ── Constants ──
export const SERVICE_UUID = 'fff0';
export const CHAR_UUID = 'fff3';
const MAX_EVENTS = 200;
const CONNECTION_LOG_KEY = 'ble-connection-log';

// ── Build tag — bump when BLE behaviour changes so we can verify the Pi
// is actually running the latest release. Shows up in /api/ble/diagnostics
// and in the boot log.
export const BLE_BUILD_TAG = '2026-04-19/separate-raw-eff-statechange';
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

// ── Boot phase ──
// 'idle' = process bootad men inga subsystem startade än (manuellt UI-läge).
// 'waiting-for-noble' = legacy auto-boot väntar på noble.
// 'ready' = minst BLE-motorn redo (övriga subsystem kan vara separat startade).
export type BootPhase = 'idle' | 'waiting-for-noble' | 'ready';
let _bootPhase: BootPhase = 'idle';
export function getBootPhase(): BootPhase { return _bootPhase; }
export function setBootPhase(phase: BootPhase): void {
  if (_bootPhase === phase) return;
  _bootPhase = phase;
  console.log(`[Boot] phase → ${phase}`);
}

// ── Subsystem state ──
// Lazy-startade subsystem (BLE-motor, mic, Sonos). Engine startas separat
// efter mic är igång. Status spåras här så configServer + heartbeat ser
// samma sanning, oavsett vilken modul som triggade starten.
export type SubsystemId = 'bleEngine' | 'mic' | 'sonos' | 'engine';
export type SubsystemStatus = 'idle' | 'starting' | 'ready' | 'error';
export interface SubsystemState {
  status: SubsystemStatus;
  startedAt: number | null;
  readyAt: number | null;
  durationMs: number | null;
  error: string | null;
}
const _subsystems: Record<SubsystemId, SubsystemState> = {
  bleEngine: { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null },
  mic:       { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null },
  sonos:     { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null },
  engine:    { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null },
};
export function getSubsystemState(id: SubsystemId): SubsystemState { return { ..._subsystems[id] }; }
export function getAllSubsystemStates(): Record<SubsystemId, SubsystemState> {
  return {
    bleEngine: { ..._subsystems.bleEngine },
    mic: { ..._subsystems.mic },
    sonos: { ..._subsystems.sonos },
    engine: { ..._subsystems.engine },
  };
}
export function markSubsystemStarting(id: SubsystemId): void {
  _subsystems[id] = { status: 'starting', startedAt: Date.now(), readyAt: null, durationMs: null, error: null };
  console.log(`[Subsystem] ${id} → starting`);
}
export function markSubsystemReady(id: SubsystemId): void {
  const s = _subsystems[id];
  const startedAt = s.startedAt ?? Date.now();
  const readyAt = Date.now();
  _subsystems[id] = { status: 'ready', startedAt, readyAt, durationMs: readyAt - startedAt, error: null };
  console.log(`[Subsystem] ${id} → ready (${_subsystems[id].durationMs}ms)`);
}
export function markSubsystemError(id: SubsystemId, error: string): void {
  const s = _subsystems[id];
  const startedAt = s.startedAt ?? Date.now();
  _subsystems[id] = { status: 'error', startedAt, readyAt: null, durationMs: Date.now() - startedAt, error };
  console.error(`[Subsystem] ${id} → error: ${error}`);
}
export function resetSubsystem(id: SubsystemId): void {
  _subsystems[id] = { status: 'idle', startedAt: null, readyAt: null, durationMs: null, error: null };
}

/**
 * Markera att noble HAR fyrat stateChange — kallas från fallback-vägar
 * (waitForPoweredOnAsync race i index.ts, eller getNobleRawState när vi
 * läser noble.state direkt). Idempotent — sätter bara första gången.
 */
export function recordObservedNobleState(state: string): void {
  if (!state || state === 'unknown') return;
  if (!_cachedNobleState) _cachedNobleState = state;
  if (_firstStateChangeAt == null) {
    _firstStateChangeAt = Date.now();
    console.log(`[BLE:stateChange:observed] ${state} (via fallback path, not early listener)`);
  }
  if (_firstStateChangeResolve) {
    _firstStateChangeResolve(state);
    _firstStateChangeResolve = null;
  }
}

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
  // Noble's HCI-binding stoppades innan subprocess-scan-helper kördes
  noble_hci_stopped_for_scan: 0,
  // Post-scan watchdog: noble återgick inte till poweredOn inom 5s → recovery kördes
  post_scan_noble_recovery_invoked: 0,
  // Post-scan watchdog: recovery kördes men noble blev fortfarande inte poweredOn
  post_scan_noble_recovery_failed: 0,
  // Scan kördes med noble's HCI-binding orörd (parallel-mode med hcitool)
  post_scan_noble_untouched: 0,
  // Sista gång varje workaround triggades
  lastInvocationAt: {} as Record<string, string>,
};

export function bumpWorkaround(key: keyof Omit<typeof workaroundCounters, 'lastInvocationAt'>): void {
  workaroundCounters[key]++;
  workaroundCounters.lastInvocationAt[key] = new Date().toISOString();
}

// ── Connection event log (ring buffer for diagnostics) ──
// Loggen rensas vid varje engine-start — gammal historik från en tidigare
// process är förvirrande efter en deploy/restart eftersom den blandas med
// nya events utan tydlig markör. Vi behåller ringbufferten i RAM och
// persisterar den till storage så att en /api/ble/log-request mellan
// crashes inte tappar context, men vid kallstart börjar vi alltid på 0.
function persistConnectionLog(): void {
  try {
    setItem(CONNECTION_LOG_KEY, JSON.stringify(_connectionLog));
  } catch {}
}

const _connectionLog: BleConnectionEvent[] = [];
// Skriv tom array till storage direkt så diskstate matchar RAM
try {
  setItem(CONNECTION_LOG_KEY, '[]');
  console.log('[BLE] connection log cleared on engine start');
} catch {}


function trimConnectionLog(): void {
  while (_connectionLog.length > MAX_EVENTS) {
    const oldestHeartbeatIdx = _connectionLog.findIndex((entry) => entry.type === 'heartbeat');
    if (oldestHeartbeatIdx >= 0) {
      _connectionLog.splice(oldestHeartbeatIdx, 1);
    } else {
      _connectionLog.shift();
    }
  }
  persistConnectionLog();
}

export function logConnectionEvent(event: Omit<BleConnectionEvent, 'timestamp'>): void {
  const entry: BleConnectionEvent = { ...event, timestamp: new Date().toISOString() };
  _connectionLog.push(entry);
  trimConnectionLog();

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
  const raw = n.state ?? n._state ?? n.adapterState ?? n._adapterState;
  // Om noble's egen property säger något annat än `unknown` så HAR
  // stateChange fyrats någon gång — vår early-listener missade bara eventet
  // (event-loop blockerad vid emit-ögonblicket). Markera observationen så
  // hasNobleEverFiredStateChange() blir korrekt.
  if (raw && raw !== 'unknown') recordObservedNobleState(raw);
  return raw;
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
 * NO-OP — quarantined.
 *
 * Tidigare muterade vi `noble._state = 'poweredOn'` för att kringgå noble's
 * interna state-guard. Det visade sig vara katastrofalt (mem://pi/ble/never-force-mutate-noble-state):
 * mutationen byter bara strängvärdet — noble's HCI-init körde aldrig klart,
 * så `startScanningAsync` returnerar OK men skickar inget HCI-kommando och
 * inga discover-events kommer någonsin. SSH-bevis: utan force-mutate hittas
 * BLEDOM01 på +411ms; med force-mutate = 0 events på 5s.
 *
 * Den här funktionen behålls bara för API-kompat med befintliga importer
 * (connect.ts, configServer.ts diagnostik). Den gör nu absolut INGENTING
 * förutom att rapportera om noble redan är poweredOn.
 *
 * Korrekt mönster: `await noble.waitForPoweredOnAsync(10_000)` före varje
 * scan/connect — inget annat.
 */
export function forceNoblePoweredOn(): boolean {
  const raw = getNobleRawState();
  return raw === 'poweredOn';
}

// patchNobleSkipStateGuard borttagen — samma anti-mönster (lurar noble's guard
// utan att HCI-socketen är redo). Stub kvar för API-kompat.
export function getNobleGuardPatchResult(): { ok: boolean; methods: string[]; error?: string } | null {
  return null;
}

export { noble };

// ── Release noble HCI/mgmt resources ──
// När det inte finns någon sparad enhet behöver noble inte hålla mgmt-/HCI-
// socketen — den blockerar bara `btmgmt find` (mgmt tillåter en discovery
// åt gången). Vi anropar noble's interna stop:ar utan att unloada modulen.
// Idempotent och säker att kalla flera gånger.
let _nobleReleased = false;
export function isNobleReleased(): boolean { return _nobleReleased; }

export async function releaseNobleResources(reason: string): Promise<void> {
  const n: any = noble;
  const errors: string[] = [];
  try {
    if (typeof n.stopScanningAsync === 'function') {
      try { await n.stopScanningAsync(); } catch (e: any) { errors.push(`stopScanningAsync: ${e?.message ?? e}`); }
    } else if (typeof n.stopScanning === 'function') {
      try { n.stopScanning(); } catch (e: any) { errors.push(`stopScanning: ${e?.message ?? e}`); }
    }
    // @stoprocent/noble exponerar `_bindings` med både `_hci` (raw HCI-socket)
    // och en mgmt-binding. `stop()` på bindings frigör båda socketsen.
    const bindings = n._bindings ?? n.bindings;
    if (bindings) {
      if (typeof bindings.stop === 'function') {
        try { bindings.stop(); } catch (e: any) { errors.push(`bindings.stop: ${e?.message ?? e}`); }
      }
      const hci = bindings._hci ?? bindings.hci;
      if (hci && typeof hci.stop === 'function') {
        try { hci.stop(); } catch (e: any) { errors.push(`hci.stop: ${e?.message ?? e}`); }
      }
    }
  } catch (e: any) {
    errors.push(`outer: ${e?.message ?? e}`);
  }

  _nobleReleased = true;
  const summary = errors.length ? ` (warnings: ${errors.join('; ')})` : '';
  console.log(`[BLE] noble HCI/mgmt resources released — ${reason}${summary}`);
  logConnectionEvent({ type: 'disconnect', detail: `noble released — ${reason}${summary}` });
}

