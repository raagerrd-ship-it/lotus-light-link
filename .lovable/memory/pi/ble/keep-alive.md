---
name: BLE keep-alive alltid på när connected
description: Keep-alive @200ms körs alltid när BLE är connected, oavsett playing-state. Mic-write har företräde via lastWriteTime-gate. Skydd mot BLEDOM reason=8 supervision timeout även när engine ger 'no-change' i flera sekunder.
type: feature
---
BLEDOM på Raspberry Pi droppar länken med `reason=8` (BT_HCI_ERR_CONNECTION_TIMEOUT) inom ~1.5–2s om inga writes sker. Pi kan inte sätta connection interval ("HCI access limited") vilket leder till kort supervision timeout.

**Kontrakt (`pi/src/piEngine.ts` + `pi/src/ble/protocol.ts`):**
- `onBleConnected()` startar `startKeepAlive()` ALLTID. Sätter owner till `'active'` om `playing=true`, annars `'idle'`.
- `setPlaying(true/false)` byter bara owner-flaggan + kör `forceIdleNow()` vid pause. Stoppar/startar ALDRIG keep-alive.
- `onBleDisconnected()` är enda som stoppar keep-alive.

**Default:** `KEEPALIVE_MS = 200` (5 pkt/s minimum). MÅSTE vara ≤ 500ms.

**Varför alltid på:** Tidigare stoppades keep-alive vid `→active` med antagandet att mic-driven `sendToBLE` håller länken. Men om engine-tickarna levererar identisk färg+brightness flera sekunder i rad returnerar `sendToBLE` `'no-change'` → ingen write → reason=8.

**Säkerhet mot dubbel-write:** Keep-alive hoppar över om `elapsed < KEEPALIVE_MS * 0.8` (160ms) sedan senaste write — active-mode mic-writes får företräde, keep-alive fyller bara luckor.

Keep-alive seedar `lastWriteTime = performance.now()` vid start så första tick fyrar på schema. Räknas i `keepAliveSentCount` + `bleStats.sentCount` (UI:t pkt/s ser BÅDA vägarna).
