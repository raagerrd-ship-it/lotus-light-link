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
}

export function setSavedDevice(id: string | null, name: string | null, address?: string | null, meta?: Partial<SavedDeviceMetadata>): void {
  _savedDeviceId = id;
  _savedDeviceName = name;
  _savedDeviceAddress = address ?? null;
  _savedAddressType = meta?.addressType ?? null;
  _savedConnectable = meta?.connectable ?? null;
  _savedServiceUuids = meta?.serviceUuids ?? null;
  setItem('ble-device-id', id ?? '');
  setItem('ble-device-name', name ?? '');
  setItem('ble-device-address', address ?? '');
  setItem('ble-address-type', _savedAddressType ?? '');
  setItem('ble-connectable', _savedConnectable != null ? String(_savedConnectable) : '');
  setItem('ble-service-uuids', _savedServiceUuids ? JSON.stringify(_savedServiceUuids) : '');
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

let _nobleHciReleased = false;

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

export function isNobleHciReleased(): boolean { return _nobleHciReleased; }
export function setNobleHciReleased(released: boolean): void {
  _nobleHciReleased = released;
}

export function getAdapterState(): string | undefined {
  const n = noble as typeof noble & {
    state?: string;
    _state?: string;
    adapterState?: string;
    _adapterState?: string;
  };
  const raw = n.state ?? n._state ?? n.adapterState ?? n._adapterState;

  if (raw === 'poweredOff' && _nobleHciReleased && processHasBtCaps()) {
    console.log('[BLE] noble HCI intentionally released — treating adapter as poweredOn for bluetoothctl mode');
    return 'poweredOn';
  }

  if ((raw === 'unauthorized' || raw === 'unknown' || raw == null) && processHasBtCaps()) {
    console.log('[BLE] noble state unclear but process has CAP_NET_RAW+CAP_NET_ADMIN — overriding to poweredOn');
    return 'poweredOn';
  }
  return raw;
}

export { noble };
