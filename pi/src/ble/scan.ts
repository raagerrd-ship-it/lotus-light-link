/**
 * BLE scanning — ren noble, ingen destruktiv HCI-rebind.
 *
 * VIKTIGT: tidigare versioner anropade `hci.stop()` + `hci.start()` för att
 * tvinga noble att re-initiera bindings när raw `_state` var `unknown`. Det
 * river HCI-socketen på Pi:s BlueZ-stack och stänger ner adaptern
 * (poweredOn → poweredOff). Vi gör det INTE längre.
 *
 * Strategi:
 *  1. `ensureAdapterUp()` (rfkill unblock + hciconfig hci0 up — säkert).
 *  2. Vänta på poweredOn via stateChange-event (upp till 6s).
 *  3. Försök `noble.startScanningAsync`. Om noble fortfarande tror state är
 *     unknown, returnera tom lista med tydlig felflagga — UI kan trigga
 *     manuell `/api/ble/reset` om det fastnar.
 *
 * Vi cachear hela peripheral-objektet (inte bara id/name/rssi) så att
 * connect.ts kan använda samma peripheral direkt.
 */

import { noble, getAdapterState, processHasBtCaps, logConnectionEvent } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { ensureAdapterUp } from './adapter.js';

async function scanViaHcitool(timeoutMs: number): Promise<DiscoveredDevice[]> {
  const tmpFile = `/tmp/lotus-ble-lescan-${process.pid}-${Date.now()}.txt`;
  const timeoutSec = Math.max(2, Math.ceil(timeoutMs / 1000));

  try {
    const { execFileSync } = await import('child_process');
    const { readFile, unlink } = await import('fs/promises');

    execFileSync(
      'bash',
      [
        '-lc',
        'tmp="$1"; secs="$2"; ' +
          'rm -f "$tmp"; ' +
          'rfkill unblock bluetooth >/dev/null 2>&1 || true; ' +
          'timeout "$secs" hcitool lescan --duplicates > "$tmp" 2>&1 || true; ' +
          'killall -9 hcitool >/dev/null 2>&1 || true',
        'bash',
        tmpFile,
        String(timeoutSec),
      ],
      { timeout: timeoutMs + 3000, stdio: 'ignore' },
    );

    const raw = await readFile(tmpFile, 'utf8').catch(() => '');
    await unlink(tmpFile).catch(() => {});

    const found = new Map<string, DiscoveredDevice>();
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s+(.+?)\s*$/i);
      if (!match) continue;

      const id = match[1].replace(/:/g, '').toLowerCase();
      const name = match[2].trim();
      if (!name || /^LE Scan/i.test(name)) continue;

      if (!found.has(id)) found.set(id, { id, name, rssi: -100 });
    }

    const results = Array.from(found.values());
    logConnectionEvent({
      type: 'scan_done',
      detail: results.length > 0
        ? `${results.length} device(s) found via hcitool fallback`
        : '0 devices via hcitool fallback',
    });
    return results;
  } catch (e: any) {
    logConnectionEvent({ type: 'scan_done', detail: `hcitool fallback failed: ${e?.message ?? e}` });
    return [];
  }
}

function getNobleRawBindingsState(): string | undefined {
  const n = noble as any;
  return n?._bindings?._state ?? n?._state ?? n?.state;
}

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

// Cache av peripheral-objekt indexerat på normaliserat id (lowercase, utan kolon).
const discoveredPeripherals = new Map<string, any>();

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }
export function getDiscoveredPeripheral(id: string): any | undefined {
  return discoveredPeripherals.get(id.toLowerCase());
}

function peripheralToDevice(p: any): DiscoveredDevice | null {
  const id: string | undefined = p?.id ?? p?.uuid ?? p?.address?.replace(/:/g, '').toLowerCase();
  if (!id) return null;
  const adv = p?.advertisement ?? {};
  const rawName: string | undefined = adv?.localName ?? p?.name;
  const name = (rawName && String(rawName).trim()) || '';
  if (!name) return null;
  const rssi = typeof p?.rssi === 'number' ? p.rssi : -100;
  return { id: String(id).toLowerCase(), name, rssi };
}

async function waitForPoweredOn(timeoutMs: number): Promise<boolean> {
  if (getAdapterState() === 'poweredOn') return true;
  return await new Promise<boolean>((resolve) => {
    const onState = (s: string) => {
      if (s === 'poweredOn') { cleanup(); resolve(true); }
    };
    const poll = setInterval(() => {
      if (getAdapterState() === 'poweredOn') { cleanup(); resolve(true); }
    }, 200);
    const timer = setTimeout(() => { cleanup(); resolve(getAdapterState() === 'poweredOn'); }, timeoutMs);
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      try { (noble as any).removeListener?.('stateChange', onState); } catch {}
    };
    try { (noble as any).on?.('stateChange', onState); } catch {}
  });
}

export async function scanForDevices(timeoutMs = 10000): Promise<DiscoveredDevice[]> {
  if (scanning) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — scan already running' });
    return lastScanResults;
  }
  if (isNobleScanActive()) {
    logConnectionEvent({ type: 'scan_start', detail: 'Skipped — noble scan-connect is active (would lock HCI)' });
    return lastScanResults;
  }

  scanning = true;
  discoveredPeripherals.clear();
  const found = new Map<string, DiscoveredDevice>();

  const onDiscover = (p: any) => {
    const dev = peripheralToDevice(p);
    if (!dev) return;
    const prev = found.get(dev.id);
    if (!prev) {
      logConnectionEvent({ type: 'scan_start', detail: `Found: ${dev.name} (${p?.address ?? dev.id}) rssi=${dev.rssi}` });
    }
    discoveredPeripherals.set(dev.id, p);
    if (!prev || dev.rssi > prev.rssi) found.set(dev.id, dev);
  };

  try {
    const adapterState = getAdapterState();
    const rawNoble = getNobleRawBindingsState();
    const hasCaps = processHasBtCaps();
    logConnectionEvent({
      type: 'scan_start',
      detail: `noble scan, timeout=${timeoutMs}ms, adapter=${adapterState}, rawNoble=${rawNoble ?? 'null'}, caps=${hasCaps}`,
    });

    // Säker adapter-init (rfkill unblock + hciconfig hci0 up). Ingen hci.stop().
    try { await ensureAdapterUp(); } catch {}

    const ready = await waitForPoweredOn(6000);
    if (!ready) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `Adapter inte poweredOn (state=${getAdapterState()}, raw=${getNobleRawBindingsState() ?? 'null'}) — kan inte scanna`,
      });
      lastScanResults = [];
      return lastScanResults;
    }

    (noble as any).on('discover', onDiscover);

    const rawBeforeScan = getNobleRawBindingsState();
    if (rawBeforeScan !== 'poweredOn' && hasCaps) {
      logConnectionEvent({
        type: 'scan_start',
        detail: `raw noble=${rawBeforeScan ?? 'null'} while adapter is poweredOn — using hcitool fallback`,
      });
      lastScanResults = await scanViaHcitool(timeoutMs);
      return lastScanResults;
    }

    try {
      await (noble as any).startScanningAsync([], true);
    } catch (scanErr: any) {
      logConnectionEvent({
        type: 'scan_start',
        detail: `startScanning failed: "${scanErr?.message ?? scanErr}" (raw=${getNobleRawBindingsState() ?? 'null'}) — trying hcitool fallback`,
      });
      lastScanResults = await scanViaHcitool(timeoutMs);
      return lastScanResults;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

    try { await (noble as any).stopScanningAsync(); } catch {}

    lastScanResults = Array.from(found.values()).sort((a, b) => b.rssi - a.rssi);

    if (lastScanResults.length === 0) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `0 devices via noble — är BLEDOM på och i närheten? Adapter=${getAdapterState()}`,
      });
    } else {
      logConnectionEvent({ type: 'scan_done', detail: `${lastScanResults.length} device(s) found via noble` });
    }

    return lastScanResults;
  } catch (e: any) {
    lastScanResults = [];
    logConnectionEvent({ type: 'scan_done', detail: `Error: ${e?.message ?? e}` });
    console.error(`[BLE] scan error: ${e?.message ?? e}`);
    try { await (noble as any).stopScanningAsync(); } catch {}
    return lastScanResults;
  } finally {
    try { (noble as any).removeListener?.('discover', onDiscover); } catch {}
    scanning = false;
  }
}
