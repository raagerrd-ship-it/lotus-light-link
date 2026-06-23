import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

// Minimal flaggmodul utan BLE/noble-importer. Används vid boot för att kunna
// avgöra om reconnect behövs utan att ladda BLE-stacken i normalfallet.
//
// Sätts av:
//  - connect-hardcoded.ts vid 2 consecutive BLE connect-failures (innan exit)
//  - index.ts så snart engine + mic + sonos + lamp har varit aktiva i denna
//    process ("vi var igång — om vi dör innan graceful shutdown, starta om allt")
//
// Konsumeras vid boot i index.ts → triggar auto-start av motor + connect + mic + sonos.
// Rensas av graceful shutdown (SIGINT/SIGTERM via UI-disconnect).
const RECONNECT_FLAG = '/tmp/lotus-auto-reconnect-on-boot';

export function setReconnectOnBootFlag(): void {
  try { writeFileSync(RECONNECT_FLAG, String(Date.now()), 'utf8'); } catch {}
}

export function consumeReconnectOnBootFlag(): boolean {
  try {
    if (!existsSync(RECONNECT_FLAG)) return false;
    unlinkSync(RECONNECT_FLAG);
    return true;
  } catch {
    return false;
  }
}

export function clearReconnectOnBootFlag(): void {
  try {
    if (existsSync(RECONNECT_FLAG)) unlinkSync(RECONNECT_FLAG);
  } catch {}
}
