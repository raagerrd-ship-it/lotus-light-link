---
name: Pi-engine stability hardening (apr 2026)
description: Sex stabilitetsfixar för långkörning på Pi Zero 2W — auto-reconnect cap, debounce, log-rate-limit, listener-stacking-skydd, mic-timer-cleanup, SSE/poll-koordinering.
type: feature
---
**Sweep 2026-04-22:** sex relaterade stabilitetsproblem som riskerade att ta ner Pi:n efter dagar/veckor av drift fixades samtidigt.

### 1+2: Auto-reconnect cap + debounce — `pi/src/ble/connect-hardcoded.ts`
- `AUTO_RECONNECT_MAX_ATTEMPTS = 20` (~10 min total backoff). Efter cap pausas loopen via `_autoReconnectGivenUp = true` och kräver manuell `/api/ble/connect`.
- `_lastReconnectRequestAt` + `RECONNECT_DEBOUNCE_MS = 1000` kollapsar dubbla triggers från keep-alive-fail OCH peripheral.disconnect-eventet.
- Intern loop-fortsättning bypassar debouncen genom att nollställa `_lastReconnectRequestAt` innan rekursivt anrop.
- Kombineras med befintlig fast-fail-self-restart (`mem://pi/ble/fast-fail-self-restart`): cap hindrar oändlig boot-loop om lampan permanent är borta.

### 3: Watchdog warn rate-limit — `pi/src/ble/protocol.ts`
- `lastStuckWarnAt` + `STUCK_WARN_INTERVAL_MS = 10_000`. `bleStats.writeStuckCount` räknar tyst varje stuck — bara EN warn-logg/10s. Hindrar journald-fyllning vid hängande BLE.

### 4: Mic waiter timer cleanup — `pi/src/alsaMic.ts`
- `clearMicReadyWaiters()` kallar nu `clearTimeout(w.timer)` för ALLA waiters innan arrayen töms. Hindrar timer-läcka vid snabba startMic/stopMic-cykler.

### 5: BLE listener-stacking-skydd — `pi/src/ble/connect-hardcoded.ts`
- `n.setMaxListeners(0)` defensivt vid varje connect.
- Verifierings-logg efter `removeAllListeners(disconnectEvent)`: om count > 0 → varning. Snabb diagnos om UUID case-mismatch leder till stale listeners.

### 6: Sonos SSE/poll koordinering — `pi/src/sonosPoller.ts`
- `sseActive` flagga togglas i `es.onopen` / `es.onerror`.
- Vid SSE active: `stopPollTimer()` — slutar dubbel-pollning. Sparar ~30 fetch/min på Pi Zero 2W.
- Vid SSE error: `startPollTimer()` återstartar pollen som fallback.

**Efterföljande symptom som dessa fixar adresserar:**
- Pi-process som tappas efter timmar/dagar (boot-loop från oändlig reconnect).
- journald som fyller diskutrymmet (writeAsync stuck-spam).
- `MaxListenersExceededWarning` i loggen efter ~10 reconnects.
- Onödigt CPU/nät-overhead på Pi Zero 2W från redundant Sonos-polling.
