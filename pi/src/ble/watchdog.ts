/**
 * Noble watchdog — detect "noble stuck in unknown" and respawn.
 *
 * Symptom seen on Pi: hci0 is UP RUNNING, rfkill is clear, process has
 * CAP_NET_RAW+CAP_NET_ADMIN, but noble's raw state never leaves `unknown`.
 * The capsOverride masks this for the UI, but waitForAdapter() (used by
 * scan/connect) requires raw `poweredOn` and so every BLE op fails silently.
 *
 * Once noble is wedged like that, no in-process recovery has worked
 * reliably — touching hci.stop()/hci.init() on a live noble instance
 * tends to make things worse. The only known reliable fix is to exit the
 * process and let systemd (`Restart=always`) respawn us with a fresh
 * noble instance that re-reads HCI from scratch.
 *
 * Cooldown: at most 1 respawn per RESPAWN_COOLDOWN_MS. The last respawn
 * timestamp is persisted so it survives the process.exit, otherwise we'd
 * forget on every restart and could spin in an infinite loop if the OS
 * itself is broken.
 */

import { getNobleRawState, processHasBtCaps, logConnectionEvent, bumpWorkaround } from './state.js';
import { isHci0Up } from './adapter-hci-check.js';
import { getItem, setItem } from '../storage.js';

const RESPAWN_COOLDOWN_MS = 15_000;
const LAST_RESPAWN_KEY = 'ble-last-respawn-at';

let _watchdogTriggered = false;
let _giveUpReason: string | null = null;

/** UI-readable status: null = healthy, otherwise human-readable failure cause. */
export function getWatchdogGiveUpReason(): string | null {
  return _giveUpReason;
}

function readLastRespawnAt(): number {
  const raw = getItem(LAST_RESPAWN_KEY);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function writeLastRespawnAt(ts: number): void {
  try { setItem(LAST_RESPAWN_KEY, String(ts)); } catch {}
}

/**
 * Shared respawn path: exit the process so systemd gives us a fresh noble instance.
 * Returns true if respawn was triggered, false if cooldown blocked it.
 */
export function triggerNobleRespawn(reason: string): boolean {
  const now = Date.now();
  const last = readLastRespawnAt();
  const sinceLast = now - last;

  if (last > 0 && sinceLast < RESPAWN_COOLDOWN_MS) {
    const waitS = Math.ceil((RESPAWN_COOLDOWN_MS - sinceLast) / 1000);
    const msg = `${reason} — respawn blockerad, senaste respawn för ${Math.floor(sinceLast / 1000)}s sedan (cooldown ${RESPAWN_COOLDOWN_MS / 1000}s). Väntar ${waitS}s.`;
    _giveUpReason = msg;
    bumpWorkaround('nobleStuckRespawn_cooldownBlocked');
    console.error(`[BLE] noble respawn cooldown: ${msg}`);
    logConnectionEvent({ type: 'connect_fail', detail: `noble respawn cooldown: ${msg}` });
    return false;
  }

  writeLastRespawnAt(now);
  bumpWorkaround('nobleStuckRespawn_invoked');
  _giveUpReason = null;
  const msg = `[BLE] noble watchdog: ${reason} → process.exit(1) för systemd-respawn`;
  console.error(msg);
  logConnectionEvent({ type: 'connect_fail', detail: msg });
  setTimeout(() => process.exit(1), 250);
  return true;
}

/**
 * Run a one-shot check after `delayMs`. If hci0 is UP RUNNING + caps OK
 * but noble is still `unknown`/`null`, exit the process so systemd respawns —
 * unless we already respawned within the cooldown window, in which case we
 * surface a give-up reason for the UI instead of looping.
 *
 * Idempotent — only schedules once per process lifetime.
 */
export function scheduleNobleStuckWatchdog(delayMs = 3000): void {
  if (_watchdogTriggered) return;
  _watchdogTriggered = true;

  setTimeout(() => {
    const raw = getNobleRawState();
    if (raw === 'poweredOn') return; // noble woke up — all good

    const hciUp = isHci0Up();
    const caps = processHasBtCaps();

    if (!hciUp || !caps) {
      // Real problem outside our control — don't respawn, just log.
      const reason = `noble=${raw ?? 'null'}, hci0Up=${hciUp}, caps=${caps} — väntar på OS, ingen respawn`;
      _giveUpReason = reason;
      logConnectionEvent({
        type: 'connect_fail',
        detail: `noble watchdog: ${reason}`,
      });
      return;
    }

    // Cooldown check — did we already respawn very recently?
    const now = Date.now();
    const last = readLastRespawnAt();
    const sinceLast = now - last;
    if (last > 0 && sinceLast < RESPAWN_COOLDOWN_MS) {
      const waitS = Math.ceil((RESPAWN_COOLDOWN_MS - sinceLast) / 1000);
      const reason = `noble fastnade i ${raw ?? 'null'} men respawn skedde för ${Math.floor(sinceLast / 1000)}s sedan (cooldown ${RESPAWN_COOLDOWN_MS / 1000}s). Väntar ${waitS}s till. Tryck "Återställ BLE-stack" eller starta om Pi:n.`;
      _giveUpReason = reason;
      bumpWorkaround('nobleStuckRespawn_cooldownBlocked');
      console.error(`[BLE] noble watchdog: ${reason}`);
      logConnectionEvent({
        type: 'connect_fail',
        detail: `noble watchdog cooldown: ${reason}`,
      });
      return;
    }

    // hci0 is up, caps are fine, noble is wedged, cooldown clear → respawn.
    triggerNobleRespawn(`hci0 UP RUNNING + caps OK men noble=${raw ?? 'null'}`);
  }, delayMs);
}
