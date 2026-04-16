---
name: Hybrid BLE discovery strategy
description: bluetoothctl scan för discovery, noble för GATT. Direktanslutning via sparad metadata (addressType) utan scan.
type: feature
---
Systemet använder en hybridstrategi för BLE med renligt separerade filer:

**Filstruktur:**
- `scan.ts` — bluetoothctl-scan → enhetslista
- `save.ts` — selectDevice(), forgetDevice(), savePeripheralMetadata()
- `connect.ts` — direktanslutning + GATT discovery + autoConnectSaved()
- `protocol.ts` — BLEDOM-paket, write pipeline, keep-alive
- `reconnect.ts` — backoff-strategi, demand-baserad reconnect
- `adapter.ts` — HCI-arbitrering (noble ↔ bluetoothctl)
- `state.ts` — delat state, stats, noble-referens

**Discovery (scan.ts):**
- `systemctl restart bluetooth` innan scan
- `bluetoothctl --timeout N scan le` med output-parsing
- Parsar `[NEW] Device MAC Name`-rader, ANSI strippas
- RSSI från `[CHG] Device MAC RSSI:`-rader

**Sparande (save.ts):**
- selectDevice() → sparar grundinfo → nobleConnect() → sparar addressType/connectable/serviceUuids
- forgetDevice() → rensar alla sparade fält
- Om addressType saknas vid autoConnect → enheten glöms, användaren måste scanna igen

**Anslutning (connect.ts):**
- nobleDirectConnect(): skapar peripheral i nobles cache via `bindings.emit('discover', ...)` utan att scanna
- nobleConnect(): kort noble-scan för första gången (selectDevice), sparar metadata
- connectPeripheral(): L2CAP + GATT discovery + connection interval + disconnect handler
- autoConnectSaved(): kräver addressType, annars return 0 och glöm enhet

**Flöde vid selectDevice():**
1. Spara grundläggande info (id, name, mac)
2. nobleConnect → kort scan → hittar peripheral → sparar addressType/connectable/serviceUuids
3. connectPeripheral → GATT discovery

**Flöde vid autoConnectSaved():**
1. Kräver addressType — saknas den, glöm enheten (return 0)
2. nobleDirectConnect → skapa peripheral från metadata → connectPeripheral
3. Om det misslyckas → "Enheten är ev. avstängd eller utom räckhåll"

**Viktigt:**
- noble kan inte scanna samtidigt som bluetoothctl — HCI-kontention
- Noble's interna API (_bindings, _peripherals) kan ändras — säker degradering vid fel
