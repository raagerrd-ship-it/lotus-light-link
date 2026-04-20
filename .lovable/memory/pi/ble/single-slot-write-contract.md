---
name: Single-slot BLE-write — kontrakt
description: Endast EN aktiv writeAsync åt gången via writeSlot. Alla write-vägar (sendToBLE, sendIdleForce, sendRawColor, keep-alive) hard-fail vid busy. Ingen rate-limit. Keep-alive bara i idle.
type: constraint
---
**Kontrakt (2026-04-20):**

1. **Single-slot:** `writeSlot: Promise<void> | null` är gemensam för alla write-vägar i `pi/src/ble/protocol.ts`. Är den upptagen → returnera direkt (`'busy'` / no-op).
2. **Ingen rate-limit:** `MIN_WRITE_INTERVAL_MS` är borta. Engine.tickMs styr maxtakten in, slot-checken fångar om noble fortfarande håller på.
3. **500ms watchdog:** `writeSlotWatchdog` tvångs-släpper sloten om writeAsync hänger.
4. **Keep-alive ägs av piEngine:**
   - `engine.start()` → `startKeepAlive()` + `startIdleHeartbeat()` (idle default).
   - `setPlaying(true)` → `stopKeepAlive()` + `stopIdleHeartbeat()` (mic-writes ~25-40ms håller länken).
   - `setPlaying(false)` → `startKeepAlive()` + `startIdleHeartbeat()` + `forceIdleNow()`.
5. **Connect-hardcoded får INTE starta egen keep-alive** — skulle ge parallella writes mot engine's egen heartbeat.
6. **sendIdleForce vid pause:** EN omedelbar write om sloten är ledig, annars dropp (keep-alive tar nästa skott inom 400ms). Ingen burst-loop.

**Varför:** Två parallella writes (t.ex. keep-alive `await writeAsync` + sendToBLE writeSlot) bygger en kö i noble's interna characteristic-buffer som spelar ut sig själv över radio-länken under sekunder → osynk mitt i låten + flera sekunders släp efter pause.

**Filer:**
- `pi/src/ble/protocol.ts` (sendToBLE, sendIdleForce, sendRawColor, startKeepAlive)
- `pi/src/piEngine.ts` (start, setPlaying)
- `pi/src/ble/connect-hardcoded.ts` (startar INTE keep-alive)
