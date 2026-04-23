---
name: Strict lease-slot — kontrakt (1 tick = 1 BLE-paket)
description: BLE-write använder strict lease-slot. När en write accepteras låses sloten i HELA tickMs-fönstret oavsett när writeAsync(..., true) resolvar. Promise-resolution kan aldrig öppna sloten tidigare. Fail-closed watchdog.
type: constraint
---
**Kontrakt (2026-04-23):**

1. **Två tillstånd, INGEN promise-slot:**
   - `writePending: boolean` — det finns en oavslutad `writeAsync`
   - `slotLockedUntil: number` — sloten är reserverad fram till denna tidpunkt
   - `slotLeaseMs` = `engine.tickMs` (sätts via `setSlotLeaseMs` från `piEngine.setTickMs`)

2. **`sendToBLE()` flow:**
   ```
   if no device                  -> 'no-device'
   if writePending               -> 'busy'
   if now < slotLockedUntil      -> 'busy'
   if delta-skip (same RGB+br)   -> 'no-change'
   else:
     writePending = true
     slotLockedUntil = now + slotLeaseMs
     lastWriteTime = now
     writeAsync(buf, true)       (fire-and-forget)
     return 'sent'
   ```
   `.finally` släpper ENDAST `writePending`. `slotLockedUntil` håller sloten låst hela lease-fönstret även om promise resolvar på <1ms — detta är vad som hindrar HCI-kö-bygge.

3. **Keep-alive följer EXAKT samma gate:**
   - `if (writePending) return;`
   - `if (now < slotLockedUntil) return;`
   - Active path har företräde — keep-alive fyller bara luckor.

4. **Fail-closed stuck-detektion:**
   - Ingen watchdog som "force-releasar" sloten.
   - Om `writePending` varit true >1000ms → räkna `bleStats.writeStuckCount`, logga (rate-limitad var 10s), men öppna INTE sloten. Frames droppas tills writen resolvar eller länken rivs av reconnect-logik.

5. **Borttaget 2026-04-23:**
   - `writeSlot: Promise<void> | null` (promise-baserad slot)
   - `writeSlotWatchdog` (force-release efter 500ms)
   - `WriteResult.'rate-limited'` (separat rate-limit i active path)
   - Separat `minWriteIntervalMs`-koncept — `setMinWriteIntervalMs` är nu alias för `setSlotLeaseMs`
   - 60%-tick-regeln (`floor(tickMs * 0.6)`) — lease = exakt tickMs

6. **WriteResult:** `'sent' | 'busy' | 'no-change' | 'no-device'` (4 utfall, inte 5).

**Filer:**
- `pi/src/ble/protocol.ts` (writePending, slotLockedUntil, setSlotLeaseMs, sendToBLE, startKeepAlive)
- `pi/src/piEngine.ts` (constructor + setTickMs anropar setSlotLeaseMs(tickMs))
- `pi/src/configServer.ts` (`/api/tick-ms`, `/api/ble/rate-limit` rapporterar slotLeaseMs)
