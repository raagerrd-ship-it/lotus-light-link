/**
 * BLE shared mutable state — single source of truth for device, stats, and config.
 * All modules read/write through these accessors to avoid circular imports.
 */

// @ts-ignore — noble types are approximate
import noble from '@abandonware/noble';
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

export function getSavedDeviceId(): string | null { return _savedDeviceId; }
export function getSavedDeviceName(): string | null { return _savedDeviceName; }
export function setSavedDevice(id: string | null, name: string | null): void {
  _savedDeviceId = id;
  _savedDeviceName = name;
  setItem('ble-device-id', id ?? '');
  setItem('ble-device-name', name ?? '');
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

/**
 * Check if the current process actually has CAP_NET_RAW + CAP_NET_ADMIN
 * by reading /proc/self/status. This is the ground truth — noble's own
 * state can lag or be wrong after a service-file update + restart.
 */
let _capsVerified: boolean | null = null;

function processHasBtCaps(): boolean {
  if (_capsVerified !== null) return _capsVerified;
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const status = readFileSync('/proc/self/status', 'utf8');
    const match = status.match(/^CapEff:\s*([0-9a-fA-F]+)$/m);
    if (match) {
      const caps = BigInt('0x' + match[1]);
      // CAP_NET_ADMIN = bit 12, CAP_NET_RAW = bit 13
      const needed = (1n << 12n) | (1n << 13n);
      _capsVerified = (caps & needed) === needed;
    } else {
      _capsVerified = false;
    }
  } catch {
    _capsVerified = false;
  }
  return _capsVerified;
}

export function getAdapterState(): string | undefined {
  const n = noble as typeof noble & { state?: string; _state?: string };
  const raw = n.state ?? n._state;

  // If noble says "unauthorized" but we actually have the caps, override.
  // This happens when noble caches the state before caps are applied.
  if (raw === 'unauthorized' && processHasBtCaps()) {
    console.log('[BLE] noble reports unauthorized but process has CAP_NET_RAW+CAP_NET_ADMIN — overriding to poweredOn');
    return 'poweredOn';
  }
  return raw;
}

export { noble };
