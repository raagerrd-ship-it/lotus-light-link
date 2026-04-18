---
name: BLE keep-alive intervall
description: Keep-alive måste vara <500ms för att undvika BLEDOM reason=8 supervision timeout på Pi
type: feature
---
BLEDOM på Raspberry Pi droppar länken med `reason=8` (BT_HCI_ERR_CONNECTION_TIMEOUT) inom 7s om inga writes sker. Pi kan inte sätta connection interval ("HCI access limited") vilket leder till kort supervision timeout (~1.5–2s). 

**Regel:** Keep-alive intervallet i `pi/src/ble/protocol.ts` MÅSTE vara ≤ 500ms. Default är 400ms. Höj inte över detta utan att verifiera mot reason=8.

Keep-alive seedar `lastWriteTime = performance.now()` vid start så första tick fyrar på schema. Räknas i `keepAliveSentCount` och visas i disconnect-loggen som `ka=N`.
