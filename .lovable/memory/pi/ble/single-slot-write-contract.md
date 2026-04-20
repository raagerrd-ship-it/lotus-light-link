---
name: Single-slot BLE-write — kontrakt
description: EN keep-alive @ 400ms bär både BLE-länk och idle-färg. Single-slot writeSlot, hard-fail vid busy. Keep-alive följer BLE-anslutning, inte engine.start().
type: constraint
---
**Kontrakt (2026-04-20):**

1. **Single-slot:** `writeSlot: Promise<void> | null` är gemensam för alla write-vägar i `pi/src/ble/protocol.ts`. Är den upptagen → returnera direkt (`'busy'` / no-op).
2. **Ingen rate-limit:** `MIN_WRITE_INTERVAL_MS` är borta. Engine.tickMs styr maxtakten in, slot-checken fångar om noble fortfarande håller på.
3. **500ms watchdog:** `writeSlotWatchdog` tvångs-släpper sloten om writeAsync hänger.
4. **EN mekanism för idle:** keep-alive @ 400ms bär BÅDE länken (förhindrar reason=8) OCH idle-färgen. `sendIdleForce` uppdaterar bara `writeBuf` + skickar EN omedelbar frame — sedan tar keep-alive över. **Ingen separat idle-heartbeat** (togs bort 2026-04-20 som redundant).
5. **Keep-alive följer BLE-anslutning, INTE engine.start():**
   - `engine.start()` → ingen keep-alive (lampan är inte ansluten ännu).
   - `connect-hardcoded` (efter anchor write) → `_onConnected?.()` → `engine.onBleConnected()` → `forceIdleNow()` + `startKeepAlive()` om Sonos pausad.
   - `peripheral.disconnect`-event → `_onDisconnected?.()` → `engine.onBleDisconnected()` → `stopKeepAlive()`.
   - `setPlaying(true)` → stoppar keep-alive (mic-writes håller länken).
   - `setPlaying(false)` → `forceIdleNow()` + `startKeepAlive()` (men bara om `_bleConnected = true`).
6. **Connect-hardcoded får INTE starta egen keep-alive** — bara registrera engine-callback via `setEngineBleCallbacks`.

**Varför EN mekanism räcker:** `sendIdleForce` skriver idle-färgen till `writeBuf`. Keep-alive läser samma buffer @ 400ms → varje keep-alive-tick bär idle-färgen. Två separata loopar mot samma lampa = parallella writes = noble-kö = osynk.

**Varför keep-alive bara efter connect:** `writeAsync` mot null-device = ren slöseri och loggspam innan användaren tryckt connect. noble's HCI-socket är öppen från `noble-singleton` oavsett — radion behöver ingen pre-connect keep-alive.

**Filer:**
- `pi/src/ble/protocol.ts` (sendToBLE, sendIdleForce, sendRawColor, startKeepAlive)
- `pi/src/piEngine.ts` (onBleConnected, onBleDisconnected, setPlaying — INGEN startIdleHeartbeat längre)
- `pi/src/ble/connect-hardcoded.ts` (setEngineBleCallbacks, kallar callbacks vid connect/disconnect)
- `pi/src/index.ts` (registrerar engine-callbacks vid boot)
