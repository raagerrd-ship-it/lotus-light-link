/**
 * BLE scan discover-handler — bygger upp set av unika peripherals från
 * noble's `discover`-event och dedupliceras per id.
 *
 * Hålls separat från scan-loopen så det blir trivialt att enhets-testa
 * namn-/RSSI-uppdatering utan att blanda in noble-state eller timers.
 */

import type { DiscoveredDevice } from './types.js';
import { scanMetrics } from './scan-metrics.js';

export interface DiscoverHandlerOptions {
  found: Map<string, DiscoveredDevice>;
  discoveredPeripherals: Map<string, any>;
}

/** Normalisera id: id || uuid || address, lowercase, utan kolon. */
export function normalizePeripheralId(peripheral: any): string | null {
  const idRaw: string =
    peripheral?.id ?? peripheral?.uuid ?? peripheral?.address ?? '';
  if (!idRaw) return null;
  return String(idRaw).replace(/:/g, '').toLowerCase();
}

/** Härled bästa möjliga visningsnamn för en peripheral. */
export function derivePeripheralName(peripheral: any, fallbackId: string): string {
  const adv = peripheral?.advertisement ?? {};
  const rawName: string =
    adv.localName ||
    peripheral?.name ||
    (adv.manufacturerData ? `(mfg) ${peripheral?.address ?? fallbackId}` : '') ||
    `(no-name) ${peripheral?.address ?? fallbackId}`;
  return String(rawName).trim() || `(no-name) ${fallbackId}`;
}

/**
 * Skapar en discover-handler bunden till ett `found`-map. Handlern
 * dedupliceras per id, uppdaterar RSSI till högsta sett och ersätter
 * "(no-name)"-platshållare när ett riktigt namn dyker upp i ett senare
 * advertisement.
 */
export function createDiscoverHandler(opts: DiscoverHandlerOptions): (p: any) => void {
  const { found, discoveredPeripherals } = opts;

  return (peripheral: any) => {
    try {
      const id = normalizePeripheralId(peripheral);
      if (!id) return;
      scanMetrics.lastRawDiscoverCount++;

      const name = derivePeripheralName(peripheral, id);
      const rssi = typeof peripheral?.rssi === 'number' ? peripheral.rssi : -100;

      discoveredPeripherals.set(id, peripheral);

      const prev = found.get(id);
      if (!prev) {
        found.set(id, { id, name, rssi, source: 'noble' });
      } else {
        if (rssi > prev.rssi) prev.rssi = rssi;
        if (prev.name.startsWith('(no-name)') && !name.startsWith('(no-name)')) {
          prev.name = name;
        }
      }
    } catch (e: any) {
      console.error('[BLE:scan] discover handler error:', e?.message ?? e);
    }
  };
}
