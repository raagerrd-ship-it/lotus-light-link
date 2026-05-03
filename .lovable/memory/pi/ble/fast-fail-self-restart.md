---
name: BLE fast-fail + self-restart strategy
description: BLEDOM HCI-stuck recovery requires process.exit after 4 consecutive failures. Same-process retries are banned.
type: feature
---
**Empirisk observation:** BLEDOM-lampor på Raspberry Pi ansluter alltid på 1-2 sekunder eller aldrig. Längre timeout hjälper inte — när connect-försök börjar misslyckas i rad är noble's HCI-state internt fastnat och retries i samma process löser det inte. Manuell `systemctl restart lotus-light-engine` är enda fungerande fix.

**Permanent guardrail:** Lägg aldrig tillbaka samma-process-retry efter consecutive BLE failures. Tre separata försök har orsakat långvariga outages. Recovery måste vara `process.exit(0)` så systemd ger fresh noble-instans + fresh HCI socket.

**Implementation i `pi/src/ble/connect-hardcoded.ts`:**

- `connectHardcoded(timeoutMs = 6000)` (yttre watchdog, var 8000)
- Inre `withTimeout(connectAsync, 4000)` (var 5000)
- `_consecutiveFailures` räknare nollställs vid lyckad connect
- Efter `CONSECUTIVE_FAIL_LIMIT = 4` failures i rad:
  1. `setReconnectOnBootFlag()` → skapar `/tmp/lotus-auto-reconnect-on-boot`
  2. `setTimeout(() => process.exit(0), 500)` — låter HTTP-svar hinna ut
  3. systemd `Restart=always` startar processen igen efter 5s

**Boot-hook i `pi/src/index.ts`:**

Efter configServer up, kollar `consumeReconnectOnBootFlag()`. Om flaggan finns:
1. Kör `startBleEngineMinimal()` → noble laddas
2. 1.5s delay (poweredOn)
3. `connectHardcoded()` automatiskt — användaren slipper trycka knappar

**Komplement till auto-reconnect-loop** (`mem://pi/ble/auto-reconnect-loop`): loopen täcker disconnects EFTER lyckad connect. Fast-fail-mekanismen täcker situationen där `connectAsync` aldrig kommer fram (initial connect eller efter total HCI-fastlåsning).

**Filtrering:** flaggan sätts BARA av `connectHardcoded` failure-path, inte av t.ex. shutdown eller `disconnectHardcoded()`. Manuell `systemctl stop` lämnar inte flaggan kvar.
