/**
 * Lazy noble singleton — minimal variant.
 *
 * Speglar pi/scripts/noble-scan-isolated.mjs EXAKT:
 *   const noble = (await import('@stoprocent/noble')).default;
 *
 * Ingen extra `noble.on(...)`, ingen läsning av `.state`/`._state` efter
 * import — allt sådant gör engine-start-minimal själv på exakt samma
 * sätt som scriptet. Att läsa `.state` direkt efter import har visat sig
 * trigga lazy HCI-init på vissa noble-builds, vilket äter stateChange-
 * eventet via libuv.
 */

let _nobleInstance: any = null;
let _loadedAt: number | null = null;

export function hasNobleLoaded(): boolean { return _nobleInstance != null; }
export function getNobleLoadedAt(): number | null { return _loadedAt; }

/**
 * Backåt-kompatibel no-op. Tidigare registrerade en stateChange-callback
 * direkt mot noble — men det är borttaget för att matcha SSH-skriptet 1:1.
 * Anropare som vill veta state får polla via getNoble().state.
 */
export function onNobleStateChange(_cb: (state: string) => void): void {
  // intentionally empty — engine-start-minimal binds its own listener
}

export function getCachedNobleState(): string | undefined {
  return _nobleInstance?.state;
}

/**
 * Synkron access — kräver att getNobleAsync() har körts en gång.
 */
export function getNoble(): any {
  if (_nobleInstance) return _nobleInstance;
  throw new Error('[noble-singleton] getNoble() called before getNobleAsync() — load noble via dynamic import first');
}

/**
 * Ladda noble via dynamic ESM-import — IDENTISKT med
 *   const noble = (await import('@stoprocent/noble')).default;
 * i pi/scripts/noble-scan-isolated.mjs.
 */
export async function getNobleAsync(): Promise<any> {
  if (_nobleInstance) return _nobleInstance;
  _nobleInstance = (await import('@stoprocent/noble' as any)).default;
  _loadedAt = Date.now();
  return _nobleInstance;
}

/**
 * Proxy-noble för legacy-kod. Använder getNoble() (synkron) — kräver att
 * BLE-motorn redan startats. Befintlig kod som accessar `noble.xxx` innan
 * motorstart kommer kasta — det är medvetet, så vi inte triggar dolda
 * native-init någon annanstans.
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
