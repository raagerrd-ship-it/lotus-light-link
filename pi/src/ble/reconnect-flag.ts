import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

// Minimal flaggmodul utan BLE/noble-importer. Används vid boot för att kunna
// avgöra om reconnect behövs utan att ladda BLE-stacken i normalfallet.
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