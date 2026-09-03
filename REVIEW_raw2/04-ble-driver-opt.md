# ANDRA PASS (opt/förenkla) — Agent 4: ble-driver/ + ble/

## 1 · simplify · HIGH — withTimeout clearar aldrig sin timer + scan-timern clearas ej vid match → RACET KVAR
- connect.ts:374-378 withTimeout race:ar p mot setTimeout(rej,ms) men clearTimeout:ar ALDRIG → varje lyckad
  wrapped call (connectAsync 4s, GATT 8s, anchor 3s) lämnar en rej-timer armerad hela durationen efter await
  löst. Yttre scan-timer (6000) clearas BARA i finish() — onDiscover sätter matched=true (:391) men clearar
  INTE. GATT inre timeout (8000 :448) > 6000 yttre → yttre kan fyra mid-GATT på långsam länk → finish({connected:
  false}) medan setDevice/attachControllerDrain/_onConnected kör efteråt. **B1 (must-fix) verkar EJ ha landat
  clearTimeout-on-match — racet kvarstår.** De 4 `if(resolved)return`-vakterna (:404-410/468-71/511-14/526-29)
  finns bara för att plåstra dessa två timer-races.
- Kan fortf. ge falskt "connect failed" → _consecutiveFailures++ → 4 st → process.exit(0) (watchdog-restarten
  designen undviker). ~35 rad svårläst branching. + upp till 3 kvardröjande rej-timers/connect (loop-wakeups
  som konkurrerar med WiFi).
- Fix (staged): (a) clearTimeout i withTimeout vid settle (standard); (b) clearTimeout(timer) högst i onDiscover
  när matched=true → yttre bounder bara scan→match, inre withTimeouts bounder connect. Sen är matched-grenen
  (:539-44) + 4 vakter onåbara → radera. ⚠️ Land (a)+(b) FÖRST (additivt/säkert, fixar racet), ta bort vakter som
  verifierad follow-up (de kom från fält-incidenter, late-connect-timeout-race.md). VERIFIERA B1-status.

## 2 · simplify · MED — Döda bleStats-fält skeppas som permanenta mätare (samma klass som borttagna writeStuckCount)
- state.ts:57 effectiveIntervalMs, :60 reconnectCount, :61 lastDisconnectReason, :65 actualIntervalMs; död
  hot-path-gren protocol.ts:355-357. Via configServer.ts:497 (stats:bleStats).
- reconnectCount + effectiveIntervalMs ALDRIG skrivna/lästa (permanent 0). bleStats.lastDisconnectReason aldrig
  skriven (riktiga = connect.ts _lastDisconnectReason via getLastDisconnectReason() som configServer:542 använder)
  → bleStats-kopian permanent null (vilseledande dubbelkälla). intervalSource får aldrig 'estimated' →
  protocol.ts:355 `==='estimated'`-grenen (enda writer av actualIntervalMs) kör ALDRIG → actualIntervalMs alltid
  '—'. Grenen kör dessutom på varje lyckad writes .then (~50-66Hz) med alltid-falsk sträng-jämförelse.
- Renderas som 0/null/'—' på frys-dashboarden = falska spår vid frys-jakt. Fix: radera de 3-4 fälten + 'estimated'-
  grenen. Noll beteende. Confidence hög (grep repo-vid).

## 3 · simplify · MED — Device-teardown-kvartett duplicerad 4× + write-issue-block duplicerat 2×
- `_onDisconnected?.(); detachControllerDrain(); setDevice(null); resetLastSent();` @ connect.ts:207-10/237-40/
  308-11/428-31. Om en väg glömmer ett steg (t.ex. resetLastSent) läcker stale last-sent/lease till nästa connect.
  Write-issue-block (writePending/writePendingSince/++writeSeq/lastSendStartedAt/slotLockedUntil/writeAsync/finally)
  i BÅDE drainQueuedWrite (318-369) + startKeepAlive (401-434).
- Fix: extrahera teardownDeviceState() (säkert, cold path) — GÖR DENNA. Ev. issueWrite(buf) delad av drain+keep-
  alive (men keep-alive utelämnar sync-instrumentering + queuedFrame re-arm → behåll på call-sites). Noll beteende.

## 4 · optimize · LOW-MED — armDrain(0) allokerar en setTimeout-timer per frame (~50-66/s) → setImmediate
- protocol.ts:274-280, från sendToBLE:453. Off-tick-decoupling (BEHÅLL — single-slot-write-contract) använder
  setTimeout(cb,0) → Node klampar 1ms + timer-heap-insert. setImmediate = enklare FIFO (ingen heap, ingen klamp),
  kör fortf. off caller-stacken (bevarar "writeAsync ej på engine-tickens stack"), fyrar något tidigare. Skär
  ~50-66 timer-objekt/s från hetaste pathen (GC-churn = dokumenterad frys-orsak). Fix: setImmediate när delayMs===0
  (egen handle, clearas m drainTimer), behåll setTimeout för 1-25ms re-arm. Låg prio, lite bokförings-komplexitet.

## 5 · simplify · LOW — Bekräftat döda exporterade helpers (bundle-delete)
- noble-singleton.ts:18 getNobleLoadedAt, :25 onNobleStateChange (no-op), :29 getCachedNobleState; protocol.ts:245
  canWriteNow (bara createLampDriver-facaden re-exponerar, ingen caller — + håller en 2:a kopia av lease-grind-
  villkoret i synk för intet); connect.ts:192 getHardcodedPeripheral, :188 getAutoReconnectStatus, :106
  wasAutoDisconnected (0 refs). Radera. Behåll getLastDisconnectReason + getAttachedHandle (live).

## 6 · optimize · MED (residual) — Koden forcerar fortf. 15ms conn-interval medan docs säger 20ms
- forceConnInterval.ts:45-46/109/148 = 12 units=15ms. Header :19-27 + connect.ts:488 ("FORCE 20ms") + memory säger
  16 units=20ms. **ANVÄNDAREN BESLUTADE 15ms** — så fixen är docs→15 (i housekeeping-prompten, EJ körd än). Detta
  fynd är alltså redan hanterat/pending, inte nytt. (15ms≈66 events/s vs 20ms≈50; latens-vs-stabilitet.)

**Redan fixat (ej re-rapporterat): subsystem-state debounce (63-71). isDemandActive/bringHci0Up borta.
Intentionellt (rör ej): state/reconnect-flag/subsystem-state/noble-singleton-splittet; setTimeout-drain-
decoupling (load-bearing); buffrar förallokerade (writeBuf/brightBuf), LUT precomputad — write-hot-path redan tight
(#4 enda micro-opt kvar).**
