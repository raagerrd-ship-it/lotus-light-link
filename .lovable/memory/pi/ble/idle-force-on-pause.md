---
name: Idle force-write on pause
description: At pause, sendIdleForce bypasses busy/rate-limit/delta gates so keep-alive doesn't keep painting the last music frame for seconds.
type: feature
---
Vid pause stoppar engine sina ticks (sentCount fryses → UI 0 pkt/s), men keep-alive (var 400ms) fortsätter skicka senast lagrade `writeBuf`. Om idle-write fastnar i 'busy'/'rate-limited' uppdateras inte writeBuf → keep-alive målar musik-färgen tills nästa lyckade idle-tick (upp till 2s). Symptom: lampan blinkar vidare flera sek efter pause.

Lösning: `sendIdleForce(r,g,b)` i `pi/src/ble/protocol.ts` skriver idle direkt i writeBuf + synkar dedup-state + fire-and-forget en write så snart writeSlot släpps. Anropas från `PiLightEngine.startIdleHeartbeat` istället för det gamla `sendIdleColor()` (som går via `sendToBLE` och kan dedupas/blockas).
