// Global BLE connection store — shared across pages
import { type BLEConnection } from "./bledom";

type Listener = () => void;

let _connections: BLEConnection[] = [];
const _listeners = new Set<Listener>();

function notify() { _listeners.forEach((fn) => fn()); }

/** @deprecated Use getBleConnections() for multi-device */
export function getBleConnection(): BLEConnection | null {
  return _connections[0] ?? null;
}

export function getBleConnections(): BLEConnection[] {
  return _connections;
}

/** @deprecated Use addBleConnection/removeBleConnection for multi-device */
export function setBleConnection(conn: BLEConnection | null) {
  if (conn) {
    // Replace all with single connection (legacy compat)
    _connections = [conn];
  } else {
    _connections = [];
  }
  notify();
}

export function addBleConnection(conn: BLEConnection) {
  // Avoid duplicates by device id
  if (!_connections.some(c => c.device?.id === conn.device?.id)) {
    _connections = [..._connections, conn];
    notify();
  }
}

export function removeBleConnection(conn: BLEConnection) {
  _connections = _connections.filter(c => c.device?.id !== conn.device?.id);
  notify();
}

export function clearBleConnections() {
  _connections = [];
  notify();
}

export function subscribeBle(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
