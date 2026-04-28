---
name: ACL-outstanding gate matchar HCI acl_max_pkt
description: protocol.ts blockerar nya writes när host-räknad outstanding ≥ ACL_MAX_OUTSTANDING (default 6, marginal under HCI:s 7) — annars logger kärnan dropped ACL och fade-smoothing glappar.
type: feature
---
**Build 2026-04-28/acl-outstanding-gate-6.**

HCI på Pi Zero 2W / Pi3 (BCM43438) rapporterar `acl_max_pkt=7`. Skickar host fler ACL-paket än så utan att vänta på `Number_Of_Completed_Packets` → kärnan tappar paket och loggar warnings, OCH fade-smoothing-takten glappar (controllern hinner inte med, paket köas i HCI-lagret, lampan halkar efter ljudet).

`pi/src/ble/protocol.ts::leaseAndDrainState()` har därför TRE gate-villkor:

1. `writePending` (en oavslutad `writeAsync`)
2. `now < slotLockedUntil` (tick-lease cadence)
3. `drainAttached && outstanding >= ACL_MAX_OUTSTANDING` ⇒ **busy**

Default `ACL_MAX_OUTSTANDING = 6` (en marginal under 7). Override via env `BLE_ACL_MAX_OUTSTANDING=N` (1–7) för tuning utan rebuild.

`outstanding` läses LIVE från `noble._bindings._hci._aclConnections.get(handle).pending + _aclQueue` (se `pi/src/ble/controllerDrain.ts`). Om drain INTE är attached (t.ex. annan noble-build) degraderar systemet till lease-only — säkrare än att aldrig släppa fram en write.

`sendToBLE` räknar orsaken så vi kan se i UI vad som dominerar:
- `skipInFlightCount` — writePending
- `skipLeaseLockedCount` — tick-lease
- `skipControllerBusyCount` — ACL-gate (controller hinner inte)

Stuck-detektion (>1000ms outstanding) räknar `controllerStuckCount` + warn (rate-limitad var 10s), men river INTE länken — det är diagnostik, inte recovery.

**Filer:**
- `pi/src/ble/protocol.ts` — `ACL_MAX_OUTSTANDING`, `leaseAndDrainState()`, gate i `sendToBLE` + `startKeepAlive`
- `pi/src/ble/controllerDrain.ts` — `getOutstandingPackets()`
- `pi/src/ble/state.ts` — `BLE_BUILD_TAG = '2026-04-28/acl-outstanding-gate-6'`
