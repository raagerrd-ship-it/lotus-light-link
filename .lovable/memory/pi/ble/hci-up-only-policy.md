---
name: HCI up-only policy — engine får aldrig ta ner hci0
description: Engine får ALDRIG kalla hciconfig hci0 down/reset eller hci.stop(). Bara unblock+up. SSH-bevis 2026-04-19 visade att hci0 är stabil UP RUNNING tills vår kod tar ner den, sen failar up-restore ofta och adaptern fastnar DOWN.
type: constraint
---
**Förbjudet i engine:**
- `hciconfig hci0 down`
- `hciconfig hci0 reset`
- `noble._bindings._hci.stop()`
- Allt annat som potentiellt lämnar adaptern i DOWN-state.

**Tillåtet:**
- `rfkill unblock bluetooth`
- `hciconfig hci0 up` (idempotent, säker)
- noble's egna refresh-hooks (pollIsDevUp, setSocketFilter, init)

**Bevis (2026-04-19):**
SSH-test visade `UP RUNNING` stabilt i 30s+ utan att vi rörde adaptern. Loggen visade `hci_reset` triggas upprepade gånger av engine, varje gång slutade adaptern DOWN. Eftersom up-restore ofta failar (rfkill-race, noble socket konflikt) blev nettoresultatet att Lotus själv tog ner sin egen adapter.

**Build-tag som etablerade policyn:** `2026-04-19/hci-up-only`.

**Filer som följer policyn:**
- `pi/src/ble/connect.ts` — `resetHciAdapter` är up-only
- `pi/src/ble/scan.ts` — pre/post-scan är up-only
- `pi/src/ble/adapter.ts` — `restartNobleHci` har inte längre `hci.stop()`, `ensureAdapterUp` är up-only
