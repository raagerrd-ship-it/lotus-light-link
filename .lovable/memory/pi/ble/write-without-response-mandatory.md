---
name: BLEDOM kräver writeAsync(..., true) — gate via controller-drain, INTE promise
description: writeAsync(buf, true) krävs (BLEDOM ger ingen ACK). Promise resolvar nästan direkt när noble accepterar paketet i sin egen ACL-kö, INTE när controller sänt över radio. Backpressure måste därför gate:as på noble._aclConnections.pending — inte på promise-resolve eller bara tidslease.
type: feature
---
På Pi/noble-stacken hänger `writeAsync(buf, false)` (med ACK) oändligt — endast `writeAsync(buf, true)` (withoutResponse) returnerar pålitligt. Anchor-write i `connect-hardcoded.ts` bevisar detta.

**Konsekvens:** `withoutResponse=true` resolvar när noble lagt paketet i sin interna `_aclQueue` / skickat till HCI-socket, INTE när BLE-controllern faktiskt sänt det över radio. En `writePending`-flagga eller ren tidslease ger därför otillräcklig backpressure — paket kan stapla i HCI-lagret och lampan halka sekunder efter ljudet.

**Skyddet (2026-04-23 — controller-drain-gate):**
Två-stegs gate i `pi/src/ble/protocol.ts` via `leaseAndDrainState()`:
1. **tick-lease** (`slotLockedUntil = now + tickMs`) styr cadence (max 1 försök/tick).
2. **controller-drain** (`getOutstandingPackets()` läser `noble._bindings._hci._aclConnections.get(handle).pending + _aclQueue`) styr om kedjan verkligen är tom.

Båda måste vara fria för att en ny write ska accepteras. Outstanding > 0 i > 1000ms → riv länken + reconnect (fail-closed). Sloten force-releasas aldrig.

**Se:** `mem://pi/ble/single-slot-write-contract` för fullt kontrakt.
