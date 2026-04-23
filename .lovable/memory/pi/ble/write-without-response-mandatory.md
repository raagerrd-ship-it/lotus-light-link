---
name: BLEDOM writes använder withoutResponse=true — backpressure via strict lease-slot
description: writeAsync(buf, true) krävs (BLEDOM ger ingen ACK). Eftersom withoutResponse resolvar nästan direkt finns INGEN promise-baserad backpressure — det är slot-lease (1 tick = 1 paket) som hindrar HCI-kö-bygge.
type: feature
---
På Pi/noble-stacken hänger `writeAsync(buf, false)` (med ACK) oändligt — endast `writeAsync(buf, true)` (withoutResponse) returnerar pålitligt. Anchor-write i `connect-hardcoded.ts` bevisar detta.

**Konsekvens:** `withoutResponse=true` resolvar nästan direkt utan att vänta på att radion skickat paketet. En `writeInFlight`-flagga eller `writeSlot: Promise` ger därför INTE tillförlitlig backpressure — flaggan släpps innan radion ens börjat skicka.

**Skyddet (2026-04-23):** Strict lease-slot i `pi/src/ble/protocol.ts`. När en write accepteras låses `slotLockedUntil = now + engine.tickMs`. Promise-resolution kan ALDRIG öppna sloten tidigare. Default tickMs=25 → max 40 paket/s, vilket är säkert under BLEDOM:s ~30-pkt/s gräns med marginal för jitter.

**Se:** `mem://pi/ble/single-slot-write-contract` för fullt kontrakt.
