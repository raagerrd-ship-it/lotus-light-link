/**
 * Lazy noble singleton.
 *
 * KRITISKT: `@stoprocent/noble` får INTE require:as vid module-load eftersom
 * dess HCI-init körs synkront vid require, och noble emit:ar `stateChange`
 * EXAKT EN GÅNG via libuv strax efter. Om någon annan native-bindning
 * (alsa, etc.) eller tung sync-init blockerar event-loopen i det fönstret
 * tappas eventet och `noble.state` fastnar i `'unknown'` för all framtid i
 * processen. Se mem://pi/ble/noble-statechange-event-loop-race.
 *
 * Lösningen: ladda noble FÖRSTA gången någon faktiskt accessar den, och
 * attach:a stateChange-listenern omedelbart i samma synkrona block.
 * Subsystem-startern (startBleEngine) ser till att inga andra native-
 * bindningar konkurrerar om event-loopen runt denna första access.
 *
 * API:
 *   - getNoble()        — hämtar noble-instansen (lazy createRequire första gången)
 *   - noble             — Proxy som triggar getNoble() vid första property-access
 *   - hasNobleLoaded()  — true om noble redan är laddad (för diagnostik)
 *   - onNobleStateChange(cb) — registrera lyssnare som anropas vid varje stateChange
 *                              (även retroaktivt om state redan är cachad)
 */

import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

let _nobleInstance: any = null;
let _loadedAt: number | null = null;
const _stateChangeListeners: Array<(state: string) => void> = [];
let _cachedState: string | undefined = undefined;

export function hasNobleLoaded(): boolean { return _nobleInstance != null; }
export function getNobleLoadedAt(): number | null { return _loadedAt; }
export function getCachedNobleState(): string | undefined { return _cachedState; }

/**
 * Registrera en stateChange-lyssnare. Om noble redan är laddad och har en
 * cachad state anropas callback:en omedelbart med det värdet — så att en
 * lyssnare som registreras EFTER att eventet fyrats ändå får reda på state.
 */
export function onNobleStateChange(cb: (state: string) => void): void {
  _stateChangeListeners.push(cb);
  if (_cachedState) {
    try { cb(_cachedState); } catch (e) { console.error('[noble-singleton] listener threw on replay:', e); }
  }
}

function attachStateChangeListener(noble: any): void {
  try {
    noble.on?.('stateChange', (s: string) => {
      _cachedState = s;
      console.log(`[noble-singleton] stateChange → ${s}`);
      for (const cb of _stateChangeListeners) {
        try { cb(s); } catch (e) { console.error('[noble-singleton] listener threw:', e); }
      }
    });
    const initial = noble.state ?? noble._state;
    if (initial && initial !== 'unknown') {
      _cachedState = initial;
      for (const cb of _stateChangeListeners) {
        try { cb(initial); } catch {}
      }
    }
  } catch (e) {
    console.error('[noble-singleton] failed to attach stateChange listener:', e);
  }
}

/**
 * Hämta noble-instansen. Första anropet laddar `@stoprocent/noble` via
 * createRequire(import.meta.url) så det fungerar i Node ESM, och attach:ar
 * omedelbart stateChange-listenern. Efterföljande anrop returnerar samma instans.
 */
export function getNoble(): any {
  if (_nobleInstance) return _nobleInstance;
  console.log('[noble-singleton] första require av @stoprocent/noble — laddar nu (event-loopen MÅSTE vara ren)');
  const mod = nodeRequire('@stoprocent/noble');
  _nobleInstance = mod?.default ?? mod;
  _loadedAt = Date.now();
  attachStateChangeListener(_nobleInstance);
  return _nobleInstance;
}

/**
 * Proxy som ser ut som noble men lazy-laddar den vid första access.
 * Befintlig kod som gör `noble.startScanningAsync(...)` triggar getNoble()
 * automatiskt utan att veta om singleton:en.
 */
export const noble: any = new Proxy(function noNobleYet() {} as any, {
  get(_target, prop) {
    const n = getNoble();
    const v = (n as any)[prop];
    return typeof v === 'function' ? v.bind(n) : v;
  },
  set(_target, prop, value) {
    const n = getNoble();
    (n as any)[prop] = value;
    return true;
  },
  apply(_target, _thisArg, args) {
    const n = getNoble();
    return n(...args);
  },
});
