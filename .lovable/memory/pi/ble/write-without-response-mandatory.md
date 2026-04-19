---
name: BLEDOM writes måste använda withoutResponse=true MEN med rate-limit
description: writeAsync(buf, true) krävs för att inte hänga, men eliminerar backpressure → måste rate-limitas
type: feature
---
På Pi/noble-stacken hänger `writeAsync(buf, false)` (med ACK) oändligt — endast `writeAsync(buf, true)` (withoutResponse) returnerar pålitligt. Anchor write i `connect-hardcoded.ts` bevisar detta.

**MEN:** `withoutResponse=true` returnerar nästan direkt utan att vänta på att radion skickat paketet. Det betyder att `writeInFlight`-flaggan INTE längre ger backpressure. Utan en explicit rate-limit bygger noble/HCI-buffern kö och lampan släpar 1-2s efter musiken; event-loopen blir överbelastad och HTTP-API:t timeoutar.

**Regel:** I `pi/src/ble/protocol.ts:sendToBLE` MÅSTE det finnas en `MIN_WRITE_INTERVAL_MS`-gate (default 20ms = 50 pkt/s tak) som dropar writes som kommer för tätt. BLEDOM klarar i praktiken ~30 pkt/s.
