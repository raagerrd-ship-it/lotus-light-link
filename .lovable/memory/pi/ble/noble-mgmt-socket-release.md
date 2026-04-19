---
name: noble äger mgmt-kanalen — använd noble för scan
description: Så fort noble importeras i en process håller den Bluetooth mgmt-kanalen. btmgmt find returnerar då "status 0x0a (Busy)" och hcitool lescan ger "Operation not permitted". Försöket att släppa noble (bindings.stop, hci.stop) visade sig INTE frigöra mgmt-kanalen — manuell btmgmt-test bekräftade fortsatt Busy. Slutsats: använd noble.startScanningAsync() för scan i denna process.
type: feature
---
Regel: Använd noble (`startScanningAsync` + `discover`-event) för all BLE-scan i Pi-engine. Försök ALDRIG köra `btmgmt`/`hcitool` parallellt i samma process — de kommer alltid att kollidera med noble's mgmt-socket.

Implementation:
- `pi/src/ble/scan.ts` använder `noble.on('discover')` + `noble.startScanningAsync([], true)` med en `setTimeout` för scan-duration.
- Adapterns mgmt/HCI behålls hela processens livstid — ingen `releaseNobleResources` eller `bindings.stop()`.
- `forgetDevice` rör inte noble — bara persisted state nollställs.

Bevis (2026-04-19):
- `sudo timeout 4 btmgmt find` medan engine kör (även EFTER bindings.stop+hci.stop) → `Unable to start discovery. status 0x0a (Busy)`.
- Slutsats: noble's mgmt-socket går inte att stänga utan att unloada hela modulen.
- Fristående `node ble-scan-helper.mjs` (utan engine) → 23 enheter på 4s — bekräftar att det är noble-importen i engine-processen som blockerar.

Alternativ som vi förkastade och varför:
- Lazy-loada noble vid behov: ~12 filers refaktor, hög regression-risk i fungerande connect/keep-alive. Skippades.
- Splittra state.ts: samma problem, många nedströms-imports.
- Använd btmgmt med setcap: lös inte mgmt-konflikten, bara permission-felet.

Build-tag som införde regeln: `2026-04-19/noble-native-scan`.
