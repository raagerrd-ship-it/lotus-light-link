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
 */

import { getNobleRawState, processHasBtCaps, logConnectionEvent, bumpWorkaround } from './state.js';
import { isHci0Up } from './adapter-hci-check.js';

let _watchdogTriggered = false;

/**
 * Run a one-shot check after `delayMs`. If hci0 is UP RUNNING + caps OK
 * but noble is still `unknown`/`null`, exit the process so systemd respawns.
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
      logConnectionEvent({
        type: 'connect_fail',
        detail: `noble watchdog: noble=${raw ?? 'null'}, hci0Up=${hciUp}, caps=${caps} — väntar på OS, ingen respawn`,
      });
      return;
    }

    // hci0 is up, caps are fine, but noble is wedged. Respawn.
    bumpWorkaround('nobleStuckRespawn_invoked');
    const msg = `[BLE] noble watchdog: hci0 UP RUNNING + caps OK men noble=${raw ?? 'null'} → process.exit(1) för systemd-respawn`;
    console.error(msg);
    logConnectionEvent({
      type: 'connect_fail',
      detail: msg,
    });

    // Give the log a chance to flush before exiting.
    setTimeout(() => process.exit(1), 250);
  }, delayMs);
}
