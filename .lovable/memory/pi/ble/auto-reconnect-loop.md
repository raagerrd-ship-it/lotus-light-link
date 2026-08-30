---
name: BLE auto-reconnect loop (post-success only)
description: Auto-reconnect aktiveras först EFTER en lyckad connect. Backoff 2→4→8→16→30s, oändligt. Manuell disconnect stoppar loopen.
type: feature
---
`pi/src/ble/connect-hardcoded.ts` har en auto-reconnect-loop som triggas i peripheral disconnect-handlern.

**Aktiveras** när full connect lyckats (efter anchor write + setDevice) — då sätts `_autoReconnectEnabled = true`. Manuella connect-fel triggar därför INTE loopen (annars skulle "Anslut" + fel = oändlig bakgrunds-reconnect även om användaren inte vill).

**Backoff:** 2s → 4s → 8s → 16s → max 30s. Efter MAX_ATTEMPTS ges loopen ALDRIG upp permanent — den går över till lugn retry var 60:e sekund (tidigare parkerades den och krävde manuell trigger, vilket lämnade lampan mörk i timmar). Stoppas bara av `disconnectHardcoded()`.

**Stoppas av:**
- `disconnectHardcoded()` — manuell frånkoppling
- Lyckad reconnect → attempt-räknaren nollställs
- `_connected.state === 'connected'` (idempotent guard)

**Inte parallell med pågående connect:** `_connectInFlight` guard hindrar dubbla anrop. Om en HTTP-trigger körs samtidigt med en schemalagd reconnect, väntar den senare på den första.

**Status-endpoint:** `getAutoReconnectStatus()` returnerar `{enabled, attempt, pending}` — kan exponeras via /api/ble/state om UI:t vill visa "återansluter…".
