
Du har helt rätt — jag drog det för långt. Nuvarande passive-boot rör inte ens hci0/noble, vilket gör att noble fastnar i `unknown` tills användaren trycker "Återställ BLE-stack". Det är fel nivå av "manuellt".

**Rätt separation:**
- **Automatiskt vid boot (BLE-motorn):** rfkill unblock, hciconfig hci0 up, vänta på noble `poweredOn`. Detta är infrastruktur — inte en anslutning till någon lampa.
- **Manuellt (användaråtgärd):** scan, connect, save-manual preview, disconnect, forget. Allt som rör en specifik lampa.

## Plan

**1. `pi/src/index.ts` — återställ aktiv boot, men utan respawn**
- STEP A: kör `ensureAdapterUp()` igen (rfkill unblock + hciconfig hci0 up). Detta är idempotent och icke-destruktivt enligt hci-up-only-policy.
- STEP B.2: vänta upp till 15s på noble `poweredOn` via `waitForFirstStateChange` + `waitForPoweredOnAsync`. Logga resultat.
- Om noble fortfarande `unknown` efter 15s: logga varning, sätt `bootPhase=ready` ändå (engine startar), men logga tydligt att användaren måste trycka "Återställ BLE-stack". **Ingen `triggerNobleRespawn`** — den raden är fortsatt borta.

**2. `pi/src/configServer.ts` — `/api/ble/start` blir aktiv igen**
- Återinför `await ensureAdapterUp()` i början av endpointen så användaren kan "väcka" BLE-motorn manuellt om bootens 15s inte räckte.
- Returnerar fortfarande bara status — ingen auto-connect till sparad enhet (den policyn behålls).

**3. Ingen ändring av manual-only-policyn för anslutning**
- `requestConnect`, `autoConnectSaved`, `startReconnectLoop`: oförändrade (single-shot, ingen reconnect-loop).
- `/api/ble/save-manual`: behåller preview-flow (connect → blink → disconnect).
- Ingen auto-respawn någonstans.

**4. Build-tag & memory**
- `BLE_BUILD_TAG` → `2026-04-19/active-ble-engine-manual-connect`.
- Uppdatera `mem://pi/ble/manual-only-connection-policy` med klargörande: "BLE-motorn (adapter+noble) startas automatiskt. Anslutning till lampa är manuell."

## Vad som INTE ändras
- Inga auto-reconnects, ingen auto-connect till sparad enhet vid boot, ingen `triggerNobleRespawn`, ingen destruktiv hci-mutering.

## Resultat
Vid boot: hci0 upp + noble redo → UI visar "Redo, ej ansluten — tryck Anslut". Tryck Anslut → scan/connect körs. Tryck Återställ BLE-stack → manuell HCI-reset om något fastnar.
