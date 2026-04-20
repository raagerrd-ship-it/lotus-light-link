---
name: Single-slot BLE-write — kontrakt
description: Endast EN aktiv writeAsync åt gången via writeSlot. Keep-alive följer BLE-anslutning (inte engine.start()). Hard-fail vid busy.
type: constraint
---
**Kontrakt (2026-04-20):**

1. **Single-slot:** `writeSlot: Promise<void> | null` är gemensam för alla write-vägar i `pi/src/ble/protocol.ts`. Är den upptagen → returnera direkt (`'busy'` / no-op).
2. **Ingen rate-limit:** `MIN_WRITE_INTERVAL_MS` är borta. Engine.tickMs styr maxtakten in, slot-checken fångar om noble fortfarande håller på.
3. **500ms watchdog:** `writeSlotWatchdog` tvångs-släpper sloten om writeAsync hänger.
4. **Keep-alive följer BLE-anslutning, INTE engine.start():**
   - `engine.start()` → ingen keep-alive (lampan är inte ansluten ännu).
   - `connect-hardcoded` (efter anchor write) → `_onConnected?.()` → `engine.onBleConnected()` → `startKeepAlive()` + `startIdleHeartbeat()` om Sonos pausad.
   - `peripheral.disconnect`-event → `_onDisconnected?.()` → `engine.onBleDisconnected()` → `stopKeepAlive()` + `stopIdleHeartbeat()`.
   - `setPlaying(true)` → stoppar keep-alive (mic-writes håller länken).
   - `setPlaying(false)` → startar keep-alive + heartbeat (men bara om `_bleConnected = true`).
5. **Connect-hardcoded får INTE starta egen keep-alive** — bara registrera engine-callback via `setEngineBleCallbacks`.
6. **sendIdleForce vid pause:** EN omedelbar write om sloten är ledig, annars dropp (keep-alive tar nästa skott inom 400ms). Ingen burst-loop.

**Varför:** (a) Två parallella writes (keep-alive + sendToBLE) bygger en kö i noble's interna characteristic-buffer som spelar ut sig själv över radio-länken under sekunder → osynk + släp efter pause. (b) Keep-alive innan connect = `writeAsync` mot null-device, ren slöseri.

**Filer:**
- `pi/src/ble/protocol.ts` (sendToBLE, sendIdleForce, sendRawColor, startKeepAlive)
- `pi/src/piEngine.ts` (onBleConnected, onBleDisconnected, setPlaying)
- `pi/src/ble/connect-hardcoded.ts` (setEngineBleCallbacks, kallar callbacks vid connect/disconnect)
- `pi/src/index.ts` (registrerar engine-callbacks vid boot)
