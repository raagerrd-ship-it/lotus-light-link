---
name: Single-slot BLE-write — kontrakt
description: Två BLE-vägar med owner-switch — idle keep-alive @200ms ELLER active sendToBLE per tick. Aldrig båda samtidigt. Single-slot writeSlot, hard-fail vid busy.
type: constraint
---
**Kontrakt (2026-04-21):**

1. **Två vägar, EN ägare i taget** (`_bleOwner` i `piEngine.ts`):
   - `'none'` — BLE ej ansluten. Inga writes.
   - `'idle'` — keep-alive @200ms bär idle-färg + länk. `sendToBLE`-paths blockeras av tickInner-guard.
   - `'active'` — `sendToBLE` per FFT-tick under play. `stopKeepAlive()` körs vid övergång in.

2. **Övergångar:**
   | Event | Action |
   |---|---|
   | `onBleConnected` (playing=false) | owner→idle, `setIdleColor` + `startKeepAlive` |
   | `onBleConnected` (playing=true)  | owner→active |
   | `setPlaying(true)` från idle     | owner→active, `stopKeepAlive` |
   | `setPlaying(false)` från active  | owner→idle, `setIdleColor` + `startKeepAlive` |
   | `onBleDisconnected`              | owner→none, `stopKeepAlive` |

3. **Single-slot:** `writeSlot: Promise<void> | null` är gemensam för `sendToBLE` och keep-alive. Är den upptagen → `'busy'` / no-op. Eftersom bara EN ägare skriver i taget är slot-konflikter sällsynta (mest noble's egen latens).

4. **500ms watchdog:** `writeSlotWatchdog` tvångs-släpper sloten om writeAsync hänger.

5. **`setIdleColor(r,g,b)`:** Synkron buffer-uppdate (`writeBuf[4..6]` + dedup-state). INGEN write triggas. Keep-alive bär färgen vid nästa 200ms-tick. Ersätter tidigare `sendIdleForce`.

6. **Tick-guard:** `tickInner` returnerar tidigt om `_bleOwner !== 'active'` — skydd mot sen FFT-frame som anländer efter `setPlaying(false)`.

**Borttaget 2026-04-21:**
- `sendRawColor` (test-only, fade-test-API)
- `sendIdleForce` (ersatt av `setIdleColor` + förlitar på keep-alive)
- `/api/ble-fade-test*` endpoints
- 400ms KEEPALIVE_MS → 200ms (snabbare idle-färg-byte vid pause)

**Filer:**
- `pi/src/ble/protocol.ts` (sendToBLE, setIdleColor, startKeepAlive, KEEPALIVE_MS=200)
- `pi/src/piEngine.ts` (_bleOwner, onBleConnected, onBleDisconnected, setPlaying, tickInner-guard)
- `pi/src/ble/connect-hardcoded.ts` (setEngineBleCallbacks → engine owner-switch)
