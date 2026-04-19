---
name: noble mgmt-socket måste släppas för btmgmt find
description: Noble håller Bluetooth mgmt-kanalen så fort modulen importeras. btmgmt find returnerar då "status 0x0a (Busy)" eftersom mgmt-API tillåter bara en aktiv discovery åt gången. Scan-helpern (ble-scan-helper.mjs) använder btmgmt find via mgmt-kanalen — den hcitool-baserade lescan-vägen ger "Set scan parameters failed: Operation not permitted" av samma underliggande orsak (noble äger HCI raw-socketen).
type: feature
---
Regel: När ingen sparad BLE-enhet finns ska noble's mgmt/HCI-resurser släppas så scan-helpern (btmgmt find) fungerar.

Implementation:
- `releaseNobleResources(reason)` i `pi/src/ble/state.ts` anropar `noble.stopScanningAsync()` + `bindings.stop()` + `bindings._hci.stop()`. Idempotent.
- Anropas vid boot i `pi/src/index.ts` om `getSavedDeviceId()` är null.
- Anropas i `forgetDevice()` (`pi/src/ble/save.ts`) så nästa scan funkar direkt efter att användaren glömt en enhet.

Logik:
- Ingen sparad enhet → noble inte aktiv → btmgmt har mgmt-kanalen → scan funkar.
- Sparad enhet finns → noble håller mgmt/HCI för connect/keep-alive → vi behöver inte scanna ändå.
- `forgetDevice()` → släpp noble → nästa scan funkar.

Bevis (2026-04-19):
- `sudo timeout 4 btmgmt find` medan engine kör → `Unable to start discovery. status 0x0a (Busy)`.
- `node ble-scan-helper.mjs` standalone (utan engine) → 23 enheter på 4s.
- Slutsats: noble själva importen blockerar mgmt, inte scan/connect-anrop.

Build-tag som införde regeln: `2026-04-19/release-noble-when-no-saved`.
