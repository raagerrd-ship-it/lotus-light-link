---
name: BLE manual-only — separation engine vs anslutning
description: BLE-MOTORN (rfkill unblock + hci0 up + noble poweredOn) startas automatiskt vid boot. ANSLUTNING till en specifik lampa (scan, connect, save-preview) sker ENDAST via användartryck. Ingen auto-reconnect, ingen auto-connect till sparad enhet, ingen auto-respawn av processen.
type: feature
---
**Beslut 2026-04-19 (uppdaterat):** Tydlig separation mellan BLE-INFRASTRUKTUR och LAMP-ANSLUTNING.

**Automatiskt vid boot (BLE-motorn = infrastruktur):**
1. `ensureAdapterUp()` körs i `pi/src/index.ts` STEP B.1b: rfkill unblock + hciconfig hci0 up. Idempotent och icke-destruktivt (mem://pi/ble/hci-up-only-policy).
2. Vänta upp till 15s på noble `poweredOn` via `waitForFirstStateChange` + `waitForPoweredOnAsync`.
3. Om noble fortfarande `unknown` efter 15s: logga varning, sätt `bootPhase=ready` ändå. **Ingen `triggerNobleRespawn`** — användaren får trycka "Återställ BLE-stack" i UI:t.

**Manuellt (användaråtgärd = anslutning till en lampa):**
1. `/api/ble/connect` → `requestConnect()` (single-shot).
2. `/api/ble/scan` + `/api/ble/select` (scan-flöde med 10s preview).
3. `/api/ble/save-manual` (kort 5s connect+blink+disconnect preview).
4. `/api/ble/disconnect`, `/api/ble/forget`.
5. `/api/ble/start` (legacy): kör `ensureAdapterUp()` + rapporterar status. Användarens "väck BLE-motorn" om bootens 15s inte räckte. Gör INGEN auto-connect.

**Reglerna för reconnect.ts:**
- `requestConnect()` = single-shot user-initierad connect.
- `releaseDemand()` = nollställer demand-flaggan för UI-visning.
- `startReconnectLoop()` = no-op (returneras för bakåtkompatibilitet).
- `setReconnectHandler` + `setReconnectTrigger` = no-ops så connect.ts disconnect-event aldrig triggar reconnect.

Build tag: `2026-04-19/active-ble-engine-manual-connect`.

Ersätter tidigare `2026-04-19/manual-only-no-auto-reconnect` (som var för passivt — rörde inte hci0/noble alls).
