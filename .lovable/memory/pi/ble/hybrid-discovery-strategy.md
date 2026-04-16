---
name: Hybrid BLE discovery strategy
description: bluetoothctl scan för discovery, noble för GATT. Direktanslutning via sparad metadata (addressType) utan scan.
type: feature
---
Systemet använder en hybridstrategi för BLE med tre anslutningsvägar:

**Discovery (scan.ts):**
- `systemctl restart bluetooth` innan scan för att säkerställa att daemon äger adaptern
- `bluetoothctl --timeout N scan le` med output till fil/pipe
- `bluetoothctl scan off` körs före och efter (finally) för att förhindra hängning
- Parsar `[NEW] Device MAC Name`-rader (INTE `bluetoothctl devices`)
- ANSI-färgkoder strippas innan regex-matchning
- RSSI extraheras från `[CHG] Device MAC RSSI:`-rader

**Direktanslutning (discover.ts → nobleDirectConnect):**
- Sparad metadata: id, name, mac, addressType, connectable, serviceUuids
- Skapar peripheral i nobles cache via `bindings.emit('discover', ...)` utan att scanna
- Försöks ALLTID först vid autoConnectSaved() om addressType finns sparad
- Fallback till scan-baserad anslutning om det misslyckas

**Scan-baserad anslutning (discover.ts → nobleConnect):**
- noble scan populerar intern peripheral-cache
- Uppdaterar sparad metadata med addressType/connectable från det hittade peripheral-objektet
- HCI växlas mellan bluetoothctl (scan) → noble (connect) via `restartNobleHci()`

**Flöde vid selectDevice():**
1. Spara grundläggande info (id, name, mac)
2. nobleConnect → kort scan → hittar peripheral → sparar addressType/connectable/serviceUuids
3. GATT-anslutning

**Flöde vid autoConnectSaved():**
1. Om addressType finns sparad → nobleDirectConnect (ingen scan, ~snabb)
2. Om det misslyckas → nobleConnect (scan + connect, ~5s)
3. Om det misslyckas → incrementera failures, eventuell HCI reset

**Viktigt:**
- `bluetoothctl devices` visar INTE nyupptäckta enheter — bara parade/cachade
- noble kan inte scanna samtidigt som bluetoothctl — HCI-kontention
- Noble's interna API (_bindings, _peripherals) kan ändras mellan versioner — säker degradering vid fel
