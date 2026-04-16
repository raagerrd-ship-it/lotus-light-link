---
name: Hybrid BLE discovery strategy
description: bluetoothctl scan för discovery, noble för GATT-anslutning. ANSI-strippning krävs.
type: feature
---
Systemet använder en tvåstegs-strategi för BLE:

**Discovery (scan.ts):**
- `systemctl restart bluetooth` innan scan för att säkerställa att daemon äger adaptern (noble kan ha låst HCI)
- `bluetoothctl --timeout N scan le` med output till fil/pipe
- Parsar `[NEW] Device MAC Name`-rader från scan-outputen (INTE `bluetoothctl devices` som bara visar parade enheter)
- ANSI-färgkoder måste strippas (`\x1b[0;92m` etc.) innan regex-matchning — bluetoothctl bäddar in dessa
- RSSI extraheras från `[CHG] Device MAC RSSI: 0xNN (dBm)`-rader

**Anslutning (discover.ts):**
- noble används för GATT-anslutning via `nobleConnect()`
- noble måste scanna kort för att populera sin interna peripheral-cache innan `connectAsync` fungerar
- HCI växlas mellan bluetoothctl (scan) → noble (connect) via `restartNobleHci()`

**Viktigt:**
- `bluetoothctl devices` visar INTE nyupptäckta enheter — bara parade/cachade
- noble kan inte scanna samtidigt som bluetoothctl — HCI-kontention
- `hcitool lescan` fungerar på Pi Zero 2W men kraschar vid pipe — bluetoothctl är mer pålitligt
