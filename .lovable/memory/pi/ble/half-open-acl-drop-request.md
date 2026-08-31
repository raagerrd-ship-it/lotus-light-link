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

**RÄTTELSE (2026-08-31):** ACL-rivningen botar INTE det vanliga felet. Skarpt: 7 anrop, 7× "ingen
länk", 0 faktiska rivningar — medan `Peripheral already connected` kom 17 gånger. Verkliga felet sitter
i nobles JS-cache (se mem://pi/ble/stale-peripheral-cache). Begäran är kvar som billig no-op.

**Eskalering (process-restart) endast när radion inte såg NÅGOT:** `/\(0 discover-events\)/` i felsträngen
+ ≥ CONSECUTIVE_FAIL_LIMIT. N > 0 = lampan är frånvarande; en omstart botar inte en urkopplad lampa.
`hcitool lescan` duger ALDRIG som hälsotest: den ger `Set scan parameters failed: Input/output error`
så fort bluetoothd håller adaptern (uppmätt: 0 enheter medan noble såg 85 discover-events).
