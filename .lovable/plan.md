## Mål

När Sonos säger PLAYING men `connectHardcoded()` failar ska lifecycle göra en kort retry-sekvens med backoff istället för att bara logga och ge upp. Idag stannar `toMotorOn()` med `engine.playing = true` men ingen lampa ansluten — användaren får trycka manuellt.

## Beteende

- Trigger: bara inom `toMotorOn()` i `pi/src/engineLifecycle.ts`, efter att första `connectHardcoded()` returnerat `connected: false` (eller kastat).
- Schema: **2s → 5s → 10s → 20s** (totalt 4 försök inkl. det första). Ger upp efter ~37s.
- Cancel-villkor (alla aborterar pågående retry-loop omedelbart):
  1. Sonos går till PAUSED (`scheduleShutdownToIgnition` triggas).
  2. Lifecycle går till `IGNITION_OFF` (manuell user-stop).
  3. Lampan blir `connected` (annan path lyckades, t.ex. en parallell scan).
- Idempotent: om en retry-loop redan kör för aktuell motor-on-cykel, starta inte en till.
- Räknaren nollställs när `toMotorOn()` startar en ny cykel (ny PLAYING efter shutdown).

## Files

**`pi/src/engineLifecycle.ts`**
- Lägg till modulvariabel `_connectRetryTimer: ReturnType<typeof setTimeout> | null` och `_connectRetryAbort: AbortController | null`.
- Ny intern `scheduleConnectRetries(deps)`:
  - Schema-array `[2000, 5000, 10000, 20000]`. Index 0 motsvarar första retry (efter att initial connect failat), så vi kör 3 till efter en initial fail. Justerbart om vi vill räkna initial som "försök 1".
  - För varje delay: `await sleep(delay)`, kolla abort-flagga + `state !== 'MOTOR_ON'` + `getHardcodedConnected().connected` → bail om något sant. Annars `await connectHardcoded()`. Logga `[Lifecycle] connect-retry n/3 efter Xms`.
  - Vid lyckad connect: nollställ + return.
- I `toMotorOn()`: efter `Promise.all(tasks)`, om `!deps.getHardcodedConnected().connected && state === 'MOTOR_ON'` → `void scheduleConnectRetries(deps)` (fire-and-forget, blockera inte motor-on-loopen).
- `cancelScheduledShutdown()` lämnas orörd. Lägg till `cancelConnectRetries()` som anropas från:
  - Början av `scheduleShutdownToIgnition()` (PAUSED kom).
  - Början av `userStopAll()`.
  - Början av `toMotorOn()` (säkerställ ren start).

**`pi/src/configServer.ts`** (valfritt, liten observability)
- Exponera `connectRetry: { active, attempt, nextInMs }` i `/api/status.lifecycle`. Hjälper UI/loggning men kan skippas i v1.

## Out of scope

- Ändra `CONSECUTIVE_FAIL_LIMIT` (4) eller `process.exit(0)`-pathen i `connect-hardcoded.ts` — låter den ligga, retry-loopen i lifecycle räknar oberoende.
- Auto-reconnect efter idle-shutdown (mots\u00e4ger idle-policy).
- Återinföra `auto-reconnect-loop.md`-modellen — denna retry är bunden till en aktiv motor-on-cykel, inte oändlig.

## Verifiering

1. Sonos PLAY, BLEDOM avstängd → loggrad per retry, ger upp efter 4 försök, `engine.playing` förblir true.
2. Sonos PAUSE under pågående retry → cancel-logg, ingen mer connect-attempt.
3. Retry #2 lyckas → loggar success, inga fler retries, lampa lyser.
4. PLAY → fail → PAUSE → PLAY igen inom grace → retry-loopen för gamla cykeln avbruten, ny `toMotorOn()` startar fresh räknare.

## Memory

- Uppdatera `mem://pi/runtime/sonos-driven-lifecycle.md` med stycke om "Connect-retry inom MOTOR_ON: 2/5/10/20s, cancelleras av PAUSED/IGNITION_OFF/connected".
