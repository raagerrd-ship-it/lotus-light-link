

## Djupgranskning: stabilitetsrisker på Pi-engine

Granskningen täcker timers, listeners, oändliga loopar, logg-spam och resursläckor i `pi/src/`. Jag har hittat **6 reella problem** + 2 mindre observationer.

---

### Problem 1: Auto-reconnect-loop kan bli oändlig + parallell med fast-fail-restart
`pi/src/ble/connect-hardcoded.ts`

- `scheduleAutoReconnect()` har **ingen övre gräns** på antal försök — backar bara av till max 30s och fortsätter för evigt.
- Loopen anropar `connectHardcoded()`, som i sin tur räknar `_consecutiveFailures` och vid 2 i rad gör `process.exit(0)` för systemd-restart.
- Under boot körs `consumeReconnectOnBootFlag` → ny connect → fail → ny exit. **Risk för boot-loop** om lampan är permanent borta (t.ex. släckt).
- **Fix:** lägg max-attempts (t.ex. 20 försök ≈ 10 min total backoff), pausa loopen efter det och kräv manuell trigger.

---

### Problem 2: Parallella triggers — keep-alive-fail OCH peripheral.disconnect kan båda schemalägga reconnect
`pi/src/ble/protocol.ts` (rad 138–148) + `connect-hardcoded.ts` peripheral.once('disconnect')

- Vid supervision-timeout: keep-alive failar 5x → `forceCleanupStalePeripheral` → `scheduleAutoReconnect`. Men **disconnect-eventet** kan fyra parallellt och göra samma sak.
- `_connectInFlight`-guarden hjälper bara delvis; race-fönster där två `connectHardcoded` kallas tätt ger dubbla CALL-loggar (vi ser detta i `_connectCallCount`-spam).
- **Fix:** central kö för "request reconnect" som debouncar 1s.

---

### Problem 3: writeSlotWatchdog kan dubbel-schemaläggas och "stuck-count" spammar logg
`pi/src/ble/protocol.ts` rad 305–313

- Vid varje `sendToBLE` clearas och sätts `writeSlotWatchdog` om. Om writeAsync hänger, loggas `[BLE] writeAsync stuck >500ms` — men nästa tick efter watchdog kan trigga **igen direkt** eftersom sloten just släpptes. Risk för rate-limit-loggspam i journald (kan fylla disken på Pi:n efter dagar/veckor).
- **Fix:** rate-limita warn-loggen (max 1/10s) och räkna stuck silent.

---

### Problem 4: micReadyWaiters läcker om man startar/stoppar mic snabbt
`pi/src/alsaMic.ts` rad 53–99

- `waitForFirstAudio` lägger en waiter med setTimeout som rejectar efter timeoutMs. Om `stopMic()` kallas innan timeouten triggar `rejectMicReadyWaiters` (bra). Men om `startMic` kallas igen direkt efter, finns inget skydd mot att gamla waiters fortfarande har timers — `clearMicReadyWaiters` returnerar dem men gör ingen `clearTimeout`. Mindre läcka men ok.
- **Fix:** `clearTimeout(waiter.timer)` i `clearMicReadyWaiters` även när vi inte resolvar.

---

### Problem 5: BLE disconnect-listeners kan stapla på noble._peripherals via cache-purge
`pi/src/ble/connect-hardcoded.ts` rad 178–197 + onDiscover rad 292–306

- Vi `removeAllListeners('disconnect:<uuid>')` på noble innan vi sätter ny listener — bra. Men om peripheral redan finns i `noble._peripherals` (cache hit) och vi inte purgade rätt key (case-mismatch på UUID), staplas listeners.
- Symptom: `MaxListenersExceededWarning` efter ~10 reconnects → långsam memory creep + node-spam i journal.
- **Fix:** sätt `n.setMaxListeners(0)` defensivt + logga `n.listenerCount(disconnectEvent)` vid varje connect för verifiering.

---

### Problem 6: Sonos pollTimer fortsätter parallellt med SSE — dubbla parseStatus-anrop
`pi/src/sonosPoller.ts` rad 330–360

- Både SSE OCH pollTimer kör parseStatus var 2:a sekund. Inga konsekvenser för korrekthet (parseStatus är idempotent), men onödigt CPU och nätverkstrafik. På Pi Zero 2W räknas det.
- **Fix:** stäng av pollTimer när SSE är ansluten, starta om vid SSE-error.

---

### Mindre observationer (inte fix nu)
- `bleStats` växer aldrig — räknare är OK.
- `_connectionLog` har MAX_EVENTS=200 cap — bra.
- onsetBuffer / windowedBuf / ringBuf är pre-allokerade — zero-alloc i hot path. Bra.
- `_diag` muteras in-place — bra.

---

### Föreslagen åtgärdsordning (default mode)

1. **Problem 1 + 2** (boot-loop + dubbla reconnects) — högst prio, kan ta ner Pi:n
2. **Problem 3** (logg-spam) — fyller journald över tid
3. **Problem 5** (listener-stacking) — slow leak
4. **Problem 6** (SSE+poll redundans) — CPU-besparing
5. **Problem 4** (micReadyWaiters) — kosmetisk

Vill du att jag implementerar alla 5 i en sweep, eller plockar 1+2+3 nu (de kritiska) och sparar resten?

