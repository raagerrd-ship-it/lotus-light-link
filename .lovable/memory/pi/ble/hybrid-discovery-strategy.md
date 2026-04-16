---
name: Hybrid BLE discovery strategy
description: noble scan API för discovery, noble.connectAsync(address) för direktanslutning, GATT handle caching för snabbare reconnect.
type: feature
---
Systemet använder nobles officiella API för hela BLE-flödet:

**Filstruktur:**
- `scan.ts` — noble startScanningAsync/stopScanningAsync → enhetslista
- `save.ts` — selectDevice(), forgetDevice(), savePeripheralMetadata()
- `connect.ts` — noble.connectAsync(address) direktanslutning + GATT discovery + autoConnectSaved()
- `protocol.ts` — BLEDOM-paket, write pipeline, keep-alive (proaktiv reconnect vid 5+ failures)
- `reconnect.ts` — backoff-strategi via autoConnectSaved(), demand-baserad reconnect
- `adapter.ts` — HCI-hantering, adapter init/retry
- `state.ts` — delat state, stats, noble-referens, GATT handle cache

**Discovery (scan.ts):**
- `noble.startScanningAsync([], true)` — alla tjänster, allow duplicates för RSSI-uppdateringar
- `discover`-event ger peripheral med namn, MAC, RSSI direkt
- Ingen shell-exec, ingen ANSI-parsing, ingen HCI-release
- Noble behåller HCI-socketen genom hela scan+connect-flödet

**Anslutning (connect.ts):**
- nobleDirectConnect(): använder officiellt `noble.connectAsync(address, {addressType, timeout})`
- nobleConnect(): kort noble-scan för första gången (selectDevice), sparar metadata
- connectPeripheral(): GATT discovery (med handle-cache) + connection interval + disconnect handler
- autoConnectSaved(): kräver addressType, annars return 0 och glöm enhet
- withTimeout(): rensas vid resolve (ingen timer-läcka)
- Disconnect-handler registreras FÖRE setDevice() (ingen race condition)

**GATT Handle Caching:**
- Efter första GATT discovery sparas serviceHandle + charHandle
- Vid reconnect försöker systemet använda cached handles först
- Fallback till full discovery om cache misslyckas
- Handles rensas när enhet glöms

**Reconnect (reconnect.ts):**
- Använder alltid autoConnectSaved() — inga stale peripheral-objekt
- Exponentiell backoff: 2s → 4s → 8s → max 30s
- Nollställer consecutive failures efter HCI-reset

**Flöde vid selectDevice():**
1. Spara grundläggande info (id, name, mac)
2. nobleConnect → kort scan → hittar peripheral → sparar addressType/connectable/serviceUuids
3. connectPeripheral → GATT discovery → cachetar handles

**Flöde vid autoConnectSaved():**
1. Kräver addressType — saknas den, glöm enheten (return 0)
2. nobleDirectConnect → noble.connectAsync(address) → peripheral (redan connected)
3. connectPeripheral(skipL2cap=true) → GATT discovery (cached) → klar

**Viktigt:**
- Noble äger HCI-socketen genom hela livscykeln (scan + connect)
- Officiellt API (noble.connectAsync + startScanningAsync) — inga interna hacks
