---
name: Lease + controller-drain — kontrakt (1 tick = 1 BLE-paket, max 1 outstanding)
description: BLE-write gate:as på TVÅ saker — tick-lease (cadence) OCH controller-drain (verklig HCI outstanding count från noble._aclConnections). Promise-resolution är INTE drain-signal. Stuck → reconnect, aldrig force-release.
type: constraint
---
**Kontrakt (2026-04-23 — controller-drain-gate):**

1. **Tre tillstånd, INGEN promise-slot:**
   - `writePending: boolean` — det finns en oavslutad `writeAsync`
   - `slotLockedUntil: number` — tick-lease, sätts vid varje accepterad write till `now + slotLeaseMs`
   - `outstanding`: räknas LIVE från `noble._bindings._hci._aclConnections.get(handle).pending + _aclQueue` (se `pi/src/ble/controllerDrain.ts`)
   - `slotLeaseMs` = `engine.tickMs` (sätts via `setSlotLeaseMs` från `piEngine.setTickMs`)

2. **`sendToBLE()` flow (gate via `leaseAndDrainState()`):**
   ```
   if no device                  -> 'no-device'
   if writePending               -> 'busy' (skipInFlight)
   if now < slotLockedUntil      -> 'busy' (skipLeaseLocked)
   if outstanding > 0            -> 'busy' (skipControllerBusy)
   if delta-skip (same RGB+br)   -> 'no-change'
   else:
     writePending = true
     lastSendStartedAt = now
     slotLockedUntil = now + slotLeaseMs
     writeAsync(buf, true)       (fire-and-forget)
     return 'sent'
   ```
   `.finally` släpper ENDAST `writePending`. Drain räknas av noble's HCI-lager när
   controller skickar `EVT_NUMBER_OF_COMPLETED_PACKETS`. Promise-resolve kan
   ALDRIG släppa drain-gaten — det är vad som hindrar HCI-kö-bygge.

3. **Keep-alive följer EXAKT samma gate** (samma `leaseAndDrainState()`).

4. **Fail-closed stuck-detektion:**
   - Om `outstanding > 0` i > `STUCK_THRESHOLD_MS` (1000ms): räkna `bleStats.controllerStuckCount`,
     logga (rate-limitad var 10s), och **riv länken** + trigga `scheduleAutoReconnect()`.
   - Sloten "force-releasas" ALDRIG. Frames droppas tills antingen drain går till 0
     ELLER reconnect bygger en fresh länk.

5. **Diagnostik (`bleStats`):**
   - `skipBusyCount` (totalt) + `skipLeaseLockedCount` + `skipControllerBusyCount` + `skipInFlightCount`
   - `controllerCompleteCount` (drain gått > 0 → 0)
   - `controllerStuckCount` + `lastStuckReason`
   - `outstandingAgeMs` (live ålder för pågående outstanding-paket)

6. **Degradation:** Om vi inte kan introspekta noble (annan build, internalen flyttad)
   returnerar `getOutstandingPackets()` 0 → systemet faller tillbaka till lease-only.
   Säkrare än att aldrig släppa fram en write.

7. **WriteResult:** `'sent' | 'busy' | 'no-change' | 'no-device'` (oförändrat).

**Filer:**
- `pi/src/ble/controllerDrain.ts` (attach/detach + `getOutstandingPackets()`)
- `pi/src/ble/protocol.ts` (`leaseAndDrainState()`, `sendToBLE`, `startKeepAlive`)
- `pi/src/ble/connect-hardcoded.ts` (`attachControllerDrain` vid setDevice, detach vid disconnect/cleanup)
- `pi/src/ble/state.ts` (`BLE_BUILD_TAG = '2026-04-23/controller-drain-gate'`, nya stats-fält)
- `pi/src/configServer.ts` (`/api/ble/output` exponerar nya stats)
