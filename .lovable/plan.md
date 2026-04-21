

# Fix BLE-återanslutning efter tappad länk

## Problem

Första `Anslut` fungerar alltid. När lampan sedan tappar länken (typiskt: Sonos pausad → 400ms keep-alive failar i bakgrunden → BLEDOM:s radio-sida timeoutar utan att noble får ett rent `disconnect`-event), så fastnar nästa `Anslut`-försök på `Match hittad men connect hängde efter 8000ms`. Motor-restart löser det → bevisar att lampan är OK, men något i **noble-stackens cache** håller en halvdöd peripheral för den MAC:en, så `peripheral.connectAsync()` hänger oändligt.

I `connect-hardcoded.ts` rensar vi `_connected` när vi får `disconnect`-event, men:

1. Om disconnect-eventet aldrig kommer (tyst radio-timeout) fortsätter noble att ha en stale peripheral i sin interna `_peripherals`-cache.
2. När scan hittar samma MAC återanvänder noble den gamla peripheral-instansen — som internt fortfarande tror att den har en pågående GATT-session.
3. `connectAsync()` hänger då tyst.

## Lösning — pre-connect cleanup i `connectHardcoded`

Innan scan startas i `connectHardcoded()` ska vi alltid:

1. **Stoppa pågående scan** — `await noble.stopScanningAsync().catch(() => {})`. Säkerhetsåtgärd om en tidigare connect-cykel kraschade mitt i scan.
2. **Force-disconnect stale peripheral** — om `_connected` finns OCH `state !== 'connected'`, kör `_connected.disconnectAsync()` med 1s timeout, rensa alla listeners (`disconnect:<uuid>` på noble + `disconnect` på peripheralen), nolla `_connected`.
3. **Rensa noble's peripheral-cache för target-MAC** — `delete noble._peripherals[<id>]` om det finns. Detta tvingar noble att skapa en fresh peripheral-instans nästa gång scan ser MAC:en, vilket bryter den hängande GATT-sessionen.
4. **Engine-side state reset** — anropa `_onDisconnected?.()`, `setDevice(null)`, `resetLastSent()` för säkerhets skull (no-op om redan rent).

Detta körs alltid i början av `connectHardcoded()`, oavsett om vi tror att vi är frånkopplade eller inte. Idempotent: om allt redan är rent händer ingenting.

## Bonus — rapportera disconnect till UI snabbare

I dag märker UI:t att lampan tappade länken först när `_connected.state` ändras (vilket aldrig händer vid tyst radio-timeout). Lägg till: om keep-alive failar `KEEPALIVE_FAIL_THRESHOLD` (5) gånger i rad och vi INTE har `isDemandActive()` (alltid false i hardcoded-flödet), kör samma cleanup som ovan så `/api/ble/state` rapporterar `connected: false` direkt — användaren ser då att lampan är borta utan att behöva försöka anslut+vänta 8s timeout.

## Tekniska detaljer

**Filer som ändras:**
- `pi/src/ble/connect-hardcoded.ts` — ny `forceCleanupStalePeripheral()` helper, anropas först i `connectHardcoded()`. Exporteras även så keep-alive kan trigga den.
- `pi/src/ble/protocol.ts` — i `startKeepAlive`'s fail-handler, när `keepAliveFailCount >= KEEPALIVE_FAIL_THRESHOLD` och vi inte har `isDemandActive()`, anropa cleanup direkt istället för att bara öka räknaren.

**Loggning:**
- `[connect-hardcoded] cleanup: stale peripheral state=<x>, force-disconnecting`
- `[connect-hardcoded] cleanup: noble._peripherals[<id>] purged`
- `[BLE] keep-alive failed 5x — link lost, marking disconnected`

**Memory som skrivs efter fix:**
`mem://pi/ble/stale-peripheral-cache` — beskriv att noble's interna `_peripherals[id]` måste purgas mellan reconnects mot samma MAC, annars hänger `connectAsync` tyst.

**Inga ändringar i:**
- UI (BleControlPanel) — felmeddelandet visas redan, blir bara mindre vanligt nu.
- Sonos-poller, mic, scan-flödet i övrigt.
- Noble-singleton — den ska fortfarande aldrig laddas om i process-livstiden.

