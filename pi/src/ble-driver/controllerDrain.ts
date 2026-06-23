/**
 * Controller-drain tracker.
 *
 * `writeAsync(buf, true)` (withoutResponse) resolvar nästan direkt när noble
 * lägger paketet i sin egen ACL-kö. Det är INTE samma sak som att paketet
 * faktiskt lämnat BLE-controllern över radio. Promise-resolution kan därför
 * inte användas som drain-signal — annars byggs en dold kö i HCI-lagret och
 * lampan halkar sekunder efter ljudet.
 *
 * Noble håller redan rätt på outstanding-paket per HCI-anslutning:
 *   noble._bindings._hci._aclConnections.get(handle).pending
 * Den räknaren ökas i flushAcl() (paket skickat till socket) och minskas i
 * EVT_NUMBER_OF_COMPLETED_PACKETS-handlern (controller har sänt klart).
 *
 * Vi exponerar en getOutstandingPackets()-funktion som returnerar:
 *   pending (i controllern) + queued (väntar i noble's ACL-queue för denna handle)
 *
 * Båda måste vara 0 för att kedjan verkligen ska vara tom. Om vi inte kan
 * läsa internalen (t.ex. annan noble-build) → fail-safe: returnera 0 så att
 * vi degraderar till lease-only beteende istället för att aldrig skriva.
 */

import { getNoble } from './noble-singleton.js';
import { dlog } from "./log.js";

const DRAIN_DIAG = process.env.DRAIN_DIAG === 'true';

let _attachedHandle: number | null = null;
let _attachedPeripheralUuid: string | null = null;
let _hci: any = null;
let _aclConnections: Map<number, any> | null = null;
let _aclQueue: any[] | null = null;

export function attachControllerDrain(peripheral: any): void {
  try {
    const n: any = getNoble();
    const uuid = peripheral?.uuid ?? peripheral?.id;
    if (!uuid) return;
    const bindings = n?._bindings;
    const handles = bindings?._handles;
    if (!handles) {
      console.warn('[controllerDrain] noble._bindings._handles saknas — drain-gate degraderas till lease-only');
      return;
    }
    const handle = handles[uuid];
    if (typeof handle !== 'number') {
      console.warn(`[controllerDrain] ingen HCI-handle för uuid=${uuid} — drain-gate degraderas till lease-only`);
      return;
    }
    _attachedHandle = handle;
    _attachedPeripheralUuid = uuid;
    _hci = bindings?._hci ?? null;
    _aclConnections = _hci?._aclConnections ?? null;
    _aclQueue = Array.isArray(_hci?._aclQueue) ? _hci._aclQueue : null;
    dlog(`[controllerDrain] attached uuid=${uuid} handle=${handle}`);
  } catch (e: any) {
    console.warn(`[controllerDrain] attach FEL: ${e?.message ?? e} — drain-gate degraderas`);
    _attachedHandle = null;
    _attachedPeripheralUuid = null;
    _hci = null;
    _aclConnections = null;
    _aclQueue = null;
  }
}

export function detachControllerDrain(): void {
  if (_attachedHandle != null) {
    dlog(`[controllerDrain] detached handle=${_attachedHandle}`);
  }
  _attachedHandle = null;
  _attachedPeripheralUuid = null;
  _hci = null;
  _aclConnections = null;
  _aclQueue = null;
}

/**
 * Returnerar antal outstanding ACL-paket för aktuell länk:
 *   pending  = paket som controller ännu inte rapporterat färdiga
 *   queued   = paket som noble köat i _aclQueue för denna handle
 *
 * Returnerar 0 om vi inte kan introspekta noble (degraderar till lease-only,
 * vilket är säkrare än att aldrig släppa fram en write).
 */
let _lastDiagLog = 0;
let _maxPendingSeen = 0;
let _maxQueuedSeen = 0;

export function getOutstandingPackets(): number {
  if (_attachedHandle == null || !_hci) return 0;
  try {
    const conn = _aclConnections?.get(_attachedHandle);
    const pending = conn?.pending ?? 0;
    let queued = 0;
    if (_aclQueue) {
      for (let i = 0; i < _aclQueue.length; i++) {
        if (_aclQueue[i]?.handle === _attachedHandle) queued++;
      }
    }

    if (DRAIN_DIAG) {
      // Diagnostik: logga max-värden 1 ggr/s så vi ser om pending fastnar.
      if (pending > _maxPendingSeen) _maxPendingSeen = pending;
      if (queued > _maxQueuedSeen) _maxQueuedSeen = queued;
      const now = Date.now();
      if (now - _lastDiagLog > 1000) {
        _lastDiagLog = now;
        const hasConn = !!conn;
        const hasAclQueue = !!_aclQueue;
        const connKeys = conn ? Object.keys(conn).join(',') : '(no-conn)';
        dlog(`[controllerDrain:diag] pending=${pending} queued=${queued} maxPending=${_maxPendingSeen} maxQueued=${_maxQueuedSeen} hasConn=${hasConn} hasAclQueue=${hasAclQueue} connKeys=${connKeys}`);
        _maxPendingSeen = 0;
        _maxQueuedSeen = 0;
      }
    }

    return pending + queued;
  } catch {
    return 0;
  }
}

/**
 * Returnerar bara queued-delen (paket som väntar i noble's _aclQueue för
 * denna handle). Detta är vad UI:t visar som "Kö" — pending-räknaren är
 * controller-internt och hör inte hemma i ett kö-mått.
 */
export function getQueuedPackets(): number {
  if (_attachedHandle == null || !_aclQueue) return 0;
  try {
    let queued = 0;
    for (let i = 0; i < _aclQueue.length; i++) {
      if (_aclQueue[i]?.handle === _attachedHandle) queued++;
    }
    return queued;
  } catch {
    return 0;
  }
}

export function isControllerDrainAttached(): boolean {
  return _attachedHandle != null;
}

export function getAttachedHandle(): number | null {
  return _attachedHandle;
}
