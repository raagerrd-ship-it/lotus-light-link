---
name: BLE manual-only — ingen auto-connect/reconnect
description: Engine och BLE-anslutning är HELT separerade. Anslutning sker ENDAST via användartryck på Anslut-knapp eller en kort save-preview. Ingen demand-baserad reconnect, ingen bakgrundsloop, ingen auto-connect på engine-start.
type: feature
---
**Beslut 2026-04-19:** Vi separerar engine från BLE-anslutning helt. Motorn körs alltid när Pi:n bootat, men lampan ansluts ENDAST när användaren själv begär det. Detta gör felsökning trivial — om engine kör men lampan är mörk är det inte ett "auto-connect försöker fortfarande"-problem utan ett tydligt "användaren har inte tryckt Anslut".

**Reglerna:**
1. `pi/src/ble/reconnect.ts` är manual-only:
   - `requestConnect()` = single-shot user-initierad connect (från `/api/ble/connect`).
   - `releaseDemand()` = bara nollställer demand-flaggan för UI-visning.
   - `startReconnectLoop()` = no-op interval (returneras för bakåtkompatibilitet).
   - `setReconnectHandler` + `setReconnectTrigger` sätts till no-ops så connect.ts disconnect-event aldrig triggar reconnect.
2. `/api/ble/start` triggar INTE auto-connect längre — bara rapporterar adapter-state.
3. `/api/ble/save-manual` kör en kort preview (5s connect+blink+disconnect) fire-and-forget så användaren ser att rätt lampa svarar.
4. `selectDevice` (scan-flöde) gör samma sak via befintlig `nobleConnect` + 10s preview-timer.
5. UI-text: "Inte ansluten — auto-connect försöker" → "Ej ansluten — tryck Anslut".

Build tag: `2026-04-19/manual-only-no-auto-reconnect`.

Bryter mot tidigare mem://pi/ble/connect-flow-hybrid antagande att `autoConnectSaved` triggas automatiskt — den körs nu bara när användaren explicit ber om det.
