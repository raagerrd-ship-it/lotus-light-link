

## Granskning av connect-koden — kvarvarande risker

Jag gick igenom `connect.ts`, `reconnect.ts` och `scan.ts`. Den nya lock-säkerhetstimern fixade huvudproblemet, men jag hittade **6 kvarvarande svagheter** av samma karaktär (race conditions, dubbelresolve, oanslutna handlers, eller läckande tillstånd).

### Tankegång — vad är "samma typ av fel"?

Felet vi just fixade var: *en intern Promise/lås kunde aldrig lösas → låste hela connect-vägen för all framtid*. Jag letade efter alla ställen där:
1. `Promise` resolve/reject inte är garanterad i alla code paths
2. Globala flaggor sätts utan `try/finally`
3. Event-listeners adderas utan att tas bort vid alla utgångar
4. Nestlade lås kan uppstå (en låst funktion kallar en annan låst funktion)

---

### Hittade problem

**1. Nestlat lås — `nobleConnect` → `nobleScanConnect` → reconnect-handler → `autoConnectSaved`**
`nobleConnect` håller `withConnectLock`. Inuti `connectPeripheral` registreras `peripheral.once('disconnect', …)` som vid demand kallar `_reconnectWithBackoff` → `autoConnectSaved` → `withConnectLock` igen. Tack vare den nya "skip duplicate"-logiken bailer den nu, men reconnect-loopen hoppar över *första* försöket tyst. Bör vänta tills lock släppts innan reconnect försöker.

**2. `nobleScanConnect.attempt()` — `done`-flaggan kan dubbelresolva**
Inne i `onDiscover` sätts `done = true` *efter* `connectPeripheral` await:en. Om scan-timern går av samtidigt som vi precis hittat enheten, hinner `finish(false)` köras innan `connectPeripheral` returnerar → vi får både `resolve(false)` och senare en lyckad `setDevice()` utan att caller vet. Cleanup måste sätta `done` *före* asynkront arbete.

**3. `noble.on('discover', onDiscover)` — listener-läcka vid tidigt fel**
Om `startScanningAsync` rejectar synchronously eller `onDiscover` kastar (ej-await:ad async), körs `cleanup()` men `removeListener` matchar bara om referensen är intakt. OK i praktiken, men `noble.on` istället för `noble.once` kombinerat med att `nobleScanActive` flaggan bara nollställs i `cleanup()` betyder att en dubbel-discover (BLEDOM annonserar ofta) kan trigga `onDiscover` två gånger innan första `connectPeripheral` är klar.

**4. `connectPeripheral` recursion — `_retryCount` förlorar `skipL2cap`**
Vid GATT-fel anropas `connectPeripheral(peripheral, _retryCount + 1)` utan tredje argumentet → defaultar till `false` → försöker `connectAsync()` igen på en redan ansluten peripheral. På @stoprocent/noble kastar detta "already connected" och retry-strategin bränns.

**5. `requestConnectionInterval` — listener-läcka**
`hci.on('leConnUpdateComplete', …)` registreras alltid, tas bort efter 3s ELLER när rätt handle svarat. Om peripheralen disconnectar inom 3s och en *annan* peripheral connectar med samma handle, fångar listenern fel event. Mindre allvarligt men samma kategori.

**6. `STEP_TIMEOUT_MS = 3000` för GATT discovery**
BLEDOM tog i ditt REPL-test ~680ms för GATT, men på dålig länk har vi sett 2–4s. 3s är på gränsen. Bör vara 5s för GATT (L2CAP kan stå kvar på 3s).

---

### Plan — minimala, kirurgiska fixar i `pi/src/ble/connect.ts`

**Fix A** (problem 2+3): I `attempt()`, sätt `done = true` *innan* `connectPeripheral`-await så timern inte kan racea. Använd `noble.once`-mönster genom att tidigt `removeListener` när vi matchar target.

**Fix B** (problem 4): Skicka `skipL2cap = true` i recursion-anropet — peripheralen *är* ansluten när vi gör GATT-retry.

**Fix C** (problem 1): I `reconnectWithBackoff`, vänta lite extra om `activeConnectPromise` är non-null (exponera en `isConnectInProgress()` getter från connect.ts) så reconnect inte slösar sitt första attempt på en skip.

**Fix D** (problem 5): Spara handle-referensen i closure, jämför strikt, och använd `once` istället för `on` + `removeListener` i timern.

**Fix E** (problem 6): Gör `STEP_TIMEOUT_MS` per-steg konfigurerbart — `L2CAP=3000`, `GATT=5000`, `WRITE=2000`.

**Fix F** (säkerhet, problem 3): Lägg till `nobleScanActive = false` i `attempt()`-promise-konstruktorn ovillkorligt vid `finish()`, även om cleanup skulle kasta.

**Fix G** (BLE_BUILD_TAG): Bump till `2026-04-17/connect-hardening`.

---

### Tekniska detaljer (för referens)

```text
connect.ts ändringar (alla i samma fil):
─ rad ~341: omstrukturera attempt() — done=true före await
─ rad ~260: connectPeripheral(peripheral, _retryCount + 1, true)
─ rad ~174: STEP_TIMEOUT_MS → byt till TIMEOUTS = { l2cap, gatt, write }
─ rad ~507: requestConnectionInterval — once + handle-jämförelse
─ rad ~22:  ny export isConnectInProgress()

reconnect.ts ändring:
─ rad ~26: vänta ut pågående lock innan första attempt
```

Inga schema- eller API-förändringar. Diagnostics-endpoint påverkas inte. Build-tag bumpas så vi kan verifiera att Pi:n fått nya koden via `/api/ble/diagnostics`.

Efter implementation: trigga release via GitHub Actions, kör samma SSH-test som tidigare och bekräfta att flowet `Scan-connect → Found via scan → L2CAP → GATT OK → Fully ready` är reproducerbart utan några `Connect already in progress`-loops eller GATT-retry-failures.

