---
name: Halvöppen ACL rivs via path-aktiverad root-service
description: Motorn får inte riva BLE-länken själv (ambient caps → CapAmb=0). Vid VARJE connect-failure skrivs PCC_DATA_DIR/ble-drop.req → lotus-ble-drop.path → root-service river bara länkar mot vår MAC.
type: feature
---
**Problem:** HCI tror länken lever (halvöppen ACL) → noble vägrar återansluta → GATT dör.
`sudo` i motorn ger "unable to change to root gid"; ambient caps rapporterar `CapAmb=0`.

**Lösning:** `pi/src/ble-driver/connect.ts` skriver `<PCC_DATA_DIR>/ble-drop.req` med
lampans MAC vid varje misslyckat connect-försök. En systemd `.path`-unit
(`lotus-ble-drop.path`) triggar `lotus-ble-drop.service` som kör som root och river
enbart länkar mot den MAC:en. Finns ingen länk → no-op.

**Villkoret får ALDRIG bli "smartare"** än varje misslyckande: felsträngen är lika ofta
`connect in-flight watchdog (30s)` som `already connected`. Matcha inte på errorsträng.
