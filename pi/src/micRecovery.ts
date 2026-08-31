/**
 * Mic-återställning — spegling av brew-control/spi_recovery.py.
 *
 * Stegen:
 *   1:a–2:a frysningen  → binda om I2S-styrenheten, sedan DÖ (~10 s)
 *   3:e–4:e             → starta om maskinen
 *   5:e+                → sluta försöka, logga högljutt, lampan till idle-färg
 *
 * Processen MÅSTE dö efter ombindning: den håller filhandtag på den GAMLA
 * styrenheten och kan inte använda den nya. En intern restartCapture() räcker
 * därför aldrig. Uppmätt live 2026-08-28/29.
 *
 * Försökslogg på disk, precis som förlagan — varje steg dödar processen som
 * annars skulle minnas den. Åtgärder räknas separat (rebind vs reboot); att
 * räkna ihop dem gav en reboot för mycket i förlagan.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getJson, setItem, removeItem } from './storage.js';
import { DATA_DIR } from './storage.js';

const KEY = 'mic-recovery';
// Motorn kan ALDRIG köra sudo (CapabilityBoundingSet saknar CAP_SETUID/SETGID →
// "unable to change to root gid"). Varje privilegierad åtgärd går via
// path-aktivering: vi skriver en begäran i vår egen ReadWritePaths-katalog,
// lotus-i2s-rebind.path triggar root-tjänsten som binder om bussen och startar
// om motorn EFTER ombindningen.
const REQ_FILE = join(DATA_DIR, 'i2s-rebind.req');
const GIVE_UP_WINDOW_S = 3600;
const MAX_REBINDS = 2;
const MAX_REBOOTS = 2;

type Action = 'rebind' | 'reboot';
type Attempt = { ts: number; action: Action };

let gaveUp = false;

function load(): Attempt[] {
  const st = getJson<{ attempts?: Attempt[] }>(KEY, {});
  const cutoff = Date.now() / 1000 - GIVE_UP_WINDOW_S;
  return (st.attempts ?? []).filter(a => a && typeof a.ts === 'number' && a.ts >= cutoff);
}

function save(attempts: Attempt[]): void {
  try { setItem(KEY, JSON.stringify({ attempts })); } catch {}
}

/** Micen är frisk igen — glöm nattens försök så en isolerad stall nästa vecka
 *  inte räknas mot dem. */
export function clearMicRecovery(): void {
  if (gaveUp) return;
  const had = load().length > 0;
  try { removeItem(KEY); } catch {}
  if (had) console.log('[MicRecovery] mic frisk — försökslogg rensad');
}

export function getMicRecoveryStatus(): { attempts: Attempt[]; gaveUp: boolean } {
  return { attempts: load(), gaveUp };
}

/** True när stegen är uttömda: lampan står i idle-färg och micen är död. */
export function isMicGivenUp(): boolean { return gaveUp; }

/** Ta nästa steg i stegen. Returnerar utan att göra något om vi gett upp. */
export function escalateMicRecovery(reason: string, onGiveUp: () => void): void {
  if (gaveUp) return;

  const attempts = load();
  const rebinds = attempts.filter(a => a.action === 'rebind').length;
  const reboots = attempts.filter(a => a.action === 'reboot').length;

  if (rebinds < MAX_REBINDS) {
    const n = rebinds + 1;
    console.error(`[MicRecovery] frysning (${reason}) — ombindning ${n}/${MAX_REBINDS}`);
    if (!requestPrivileged('rebind')) {
      // Kunde inte lämna begäran → ingen åtgärd skedde. Räkna INTE försöket
      // (låtsas-försök gav gaveUp → lampan parkerad i idle-färg permanent).
      save(attempts);
      return;
    }
    save([...attempts, { ts: Math.round(Date.now() / 1000), action: 'rebind' }]);
    // Exit oavsett om ombindningen rapporterade framgång: den här processen
    // håller filhandtag på den GAMLA styrenheten och kan inte använda den nya.
    // Låt systemd starta en färsk som öppnar enheten från noll.
    hardExit();
    return;
  }

  if (reboots < MAX_REBOOTS) {
    const n = reboots + 1;
    console.error(`[MicRecovery] ombindning hjälpte ej (${reason}) — omstart av maskinen ${n}/${MAX_REBOOTS}`);
    if (!requestPrivileged('reboot')) {
      save(attempts);
      return;
    }
    save([...attempts, { ts: Math.round(Date.now() / 1000), action: 'reboot' }]);
    hardExit();
    return;
  }

  gaveUp = true;
  console.error(
    `[MicRecovery] KRITISKT: micen är död efter ${MAX_REBINDS} ombindningar och ` +
    `${MAX_REBOOTS} omstarter (${reason}). Slutar försöka. Lampan går till ` +
    'idle-färg och stannar där — ingen pulsning på fruset underlag.'
  );
  try { onGiveUp(); } catch {}
}

/** Lämna en begäran till root-tjänsten. False = inget hände (räkna inte försöket). */
function requestPrivileged(what: 'rebind' | 'reboot'): boolean {
  try {
    writeFileSync(REQ_FILE, `${what}\n`, 'utf8');
    console.error(`[MicRecovery] begäran lämnad: ${what} (${REQ_FILE})`);
    return true;
  } catch (e: any) {
    console.error(`[MicRecovery] kunde inte skriva begäran (${what}): ${e?.message ?? e} — ingen åtgärd, försöket räknas ej`);
    return false;
  }
}

// process.exit väntar inte på trådar, men en native addon som blockerar i ALSA
// kan hålla exit-hooks. SIGKILL är sista utväg — motsvarar os._exit(1).
function hardExit(): void {
  const t = setTimeout(() => {
    try { process.kill(process.pid, 'SIGKILL'); } catch {}
  }, 2000);
  t.unref?.();
  process.exit(1);
}
