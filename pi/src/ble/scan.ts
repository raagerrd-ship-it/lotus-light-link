/**
 * BLE scanning — ren noble.
 *
 * Använder noble.startScanningAsync/stopScanningAsync. Ingen hcitool, ingen
 * shell-exec. Noble äger HCI-socketen genom hela scan+connect-flödet.
 *
 * VIKTIGT: Vi cachear hela peripheral-objektet (inte bara id/name/rssi) så att
 * connect.ts kan använda samma peripheral direkt — exakt som den gamla
 * fungerande monoliten. noble.connectAsync(address) är opålitlig på Pi, men
 * peripheral.connectAsync() från ett scan-resultat är robust.
 */

import { noble, getAdapterState, processHasBtCaps, logConnectionEvent, bumpWorkaround } from './state.js';
import type { DiscoveredDevice } from './types.js';
import { isNobleScanActive } from './connect.js';
import { ensureAdapterUp, restartNobleHci } from './adapter.js';

/**
 * Reads noble's INTERNAL bindings state (not the caps-aware override).
 * This is what noble.startScanningAsync() checks internally — and it's
 * what returns `unknown` even when our exposed state says `poweredOn`.
 */
function getNobleRawBindingsState(): string | undefined {
  const n = noble as any;
  return n?._bindings?._state ?? n?._state ?? n?.state;
}

/**
 * When noble's internal _state is `unknown` but our caps-override says
 * poweredOn, noble.startScanningAsync() will throw synchronously with
 * "state is unknown". Force noble to re-init its HCI bindings and wait
 * for a real `stateChange` → `poweredOn` event before proceeding.
 *
 * Returns true if noble's raw internal state ended up poweredOn.
 */
async function ensureNobleReallyPoweredOn(timeoutMs: number): Promise<boolean> {
  const raw0 = getNobleRawBindingsState();
  if (raw0 === 'poweredOn') return true;

  logConnectionEvent({
    type: 'scan_start',
    detail: `noble raw=${raw0 ?? 'null'} — forcing HCI rebind`,
  });
  bumpWorkaround('restartNobleHci_invoked');

  // Attach stateChange listener BEFORE rebinding so we don't miss the event
  const waitForEvent = new Promise<boolean>((resolve) => {
    const n = noble as any;
    let done = false;
    const onState = (s: string) => {
      if (s === 'poweredOn' && !done) { done = true; cleanup(); resolve(true); }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve(getNobleRawBindingsState() === 'poweredOn');
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      try { n.removeListener?.('stateChange', onState); } catch {}
    };
    try { n.on?.('stateChange', onState); } catch {}
  });

  try {
    const bindings = (noble as any)._bindings;
    const hci = bindings?._hci;
    if (typeof hci?.stop === 'function') { try { hci.stop(); } catch {} }
    await new Promise(r => setTimeout(r, 150));
    if (typeof hci?.start === 'function') { try { hci.start(); } catch {} }
  } catch {}

  const ok = await waitForEvent;
  logConnectionEvent({
    type: 'scan_start',
    detail: `noble rebind done — raw=${getNobleRawBindingsState() ?? 'null'}, ok=${ok}`,
  });
  return ok;
}

let lastScanResults: DiscoveredDevice[] = [];
let scanning = false;

// Cache av peripheral-objekt indexerat på normaliserat id (MAC utan kolon, lowercase).
// Connect-flödet hämtar peripheral härifrån istället för att starta egen scan.
const discoveredPeripherals = new Map<string, any>();

export function getLastScanResults(): DiscoveredDevice[] { return lastScanResults; }
export function isScanning(): boolean { return scanning; }
export function getDiscoveredPeripheral(id: string): any | undefined {
  return discoveredPeripherals.get(id.toLowerCase());
}

function peripheralToDevice(p: any): DiscoveredDevice | null {
  const id: string | undefined = p?.id ?? p?.uuid ?? p?.address?.replace(/:/g, '').toLowerCase();
  if (!id) return null;
  const mac: string = (p?.address ?? '').toUpperCase();
  const adv = p?.advertisement ?? {};
  const rawName: string | undefined = adv?.localName ?? p?.name;
  // Filtrera bort enheter helt utan namn (matchar gamla monoliten — minskar brus)
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
  // Töm cachen vid varje ny scan så vi inte refererar till stale peripheral-objekt
  discoveredPeripherals.clear();
  const found = new Map<string, DiscoveredDevice>();

  const onDiscover = (p: any) => {
    const dev = peripheralToDevice(p);
    if (!dev) return;
    const prev = found.get(dev.id);
    if (!prev) {
      logConnectionEvent({ type: 'scan_start', detail: `Found: ${dev.name} (${p?.address ?? dev.id}) rssi=${dev.rssi}` });
    }
    // Spara peripheral-objektet — connect.ts behöver det
    discoveredPeripherals.set(dev.id, p);
    // Behåll bästa (högsta) rssi
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

    try { await ensureAdapterUp(); } catch {}

    // Vänta längre på poweredOn — gamla monoliten väntade via stateChange under hela scan-fönstret.
    // 6s ger noble tid att initiera HCI även efter en kall start.
    const ready = await waitForPoweredOn(6000);
    if (!ready) {
      logConnectionEvent({
        type: 'scan_done',
        detail: `Adapter inte poweredOn (state=${getAdapterState()}) — kan inte scanna med noble`,
      });
      lastScanResults = [];
      return lastScanResults;
    }

    // KRITISK: även om caps-override säger poweredOn kan noble:s interna
    // _state fortfarande vara 'unknown'. startScanningAsync() kollar rå
    // internal state och kastar "state is unknown". Tvinga rebind här.
    if (getNobleRawBindingsState() !== 'poweredOn') {
      const rebindOk = await ensureNobleReallyPoweredOn(4000);
      if (!rebindOk) {
        logConnectionEvent({
          type: 'scan_done',
          detail: `noble raw-state still ${getNobleRawBindingsState() ?? 'null'} after rebind — aborting`,
        });
        lastScanResults = [];
        return lastScanResults;
      }
    }

    (noble as any).on('discover', onDiscover);

    try {
      await (noble as any).startScanningAsync([], true);
    } catch (scanErr: any) {
      // Fallback: noble fortfarande inte redo — gör en sista rebind och försök igen
      logConnectionEvent({
        type: 'scan_start',
        detail: `startScanning threw "${scanErr?.message ?? scanErr}" — retrying after rebind`,
      });
      await ensureNobleReallyPoweredOn(4000);
      await (noble as any).startScanningAsync([], true);
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
