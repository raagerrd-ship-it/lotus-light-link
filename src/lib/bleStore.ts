// Global BLE connection store — shared across pages
import { type BLEConnection } from "@/lib/bledom";

type Listener = () => void;

let _connection: BLEConnection | null = null;
const _listeners = new Set<Listener>();

export function getBleConnection(): BLEConnection | null {
  return _connection;
}

export function setBleConnection(conn: BLEConnection | null) {
  _connection = conn;
  _listeners.forEach((fn) => fn());
}

export function subscribeBle(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
