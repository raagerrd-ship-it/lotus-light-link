
## Mål

Göra BLE-sändningen strikt "single slot" på riktigt:

- 1 tick = max 1 försök till BLE-write
- om något fortfarande är upptaget när nästa tick kommer: droppa den nya framens write
- aldrig öppna en andra write bara för att `writeAsync(..., true)` råkade resolva tidigt
- prioritera synk framför leveransgrad

## Rotorsak i nuvarande kod

Kö kan fortfarande byggas trots 25 ms tick därför att nuvarande slot inte representerar radion, bara JavaScript-promisen:

1. `writeAsync(buf, true)` resolvar nästan direkt när paketet lämnas till stacken, inte när lampan faktiskt är klar.
2. `writeSlot` släpps därför för tidigt.
3. `WRITE_SLOT_TIMEOUT_MS` tvångs-släpper dessutom sloten efter 500 ms även om en gammal write fortfarande kan leva i noble/HCI.
4. Keep-alive delar samma writeväg, så om sloten släpps fel kan fler writes komma in bakom.

Det är just detta som gör att "single slot" inte längre är hårt nog.

## Lösning

### 1. Byt från promise-slot till strikt lease-slot i `pi/src/ble/protocol.ts`

Ersätt dagens modell:

- `writeSlot: Promise<void> | null`
- release i `.finally()`
- watchdog som öppnar sloten igen

med en strikt write-gate baserad på två separata tillstånd:

- `writePending: boolean` — det finns fortfarande en oavslutad `writeAsync`
- `slotLockedUntil: number` — sloten är reserverad för hela tick-fönstret

Nytt kontrakt:

```text
sendToBLE():
  if no device -> 'no-device'
  if writePending -> 'busy'
  if now < slotLockedUntil -> 'busy'
  annars:
    writePending = true
    slotLockedUntil = now + 25ms
    start writeAsync(..., true)
    return 'sent'
```

Viktigt:
- `.then/.catch/.finally` får bara uppdatera stats och sätta `writePending = false`
- promise-resolution får aldrig låsa upp sloten tidigare än lease-tiden
- lease-tiden blir den verkliga "1 tick = 1 slot"-gränsen

Detta gör att snabb promise-resolution inte längre kan öppna dörren för extra writes mellan två ticks.

### 2. Ta bort rate-limit som separat backpressure-mekanism

`minWriteIntervalMs` används idag som extra gate eftersom promise-sloten inte räcker. När sloten blir strikt behövs inte den dubbla logiken längre.

Ändring:
- `sendToBLE()` ska inte returnera `'rate-limited'` i active path
- ticken ska bara se: `sent`, `busy`, `no-change`, `no-device`
- om API:t `/api/ble/rate-limit` måste finnas kvar för kompatibilitet, låt det rapportera fixed/följa slot lease istället för en separat intern gate

Målet är att undvika två parallella mekanismer som kan maskera var problemet egentligen ligger.

### 3. Watchdog får aldrig öppna plats för en ny write

Nuvarande watchdog är farlig just för synk-kravet. I stället för att "force-release" sloten ska den göra fail-closed:

- om en write varit pending för länge:
  - räkna stuck
  - markera länken som dålig
  - trigga cleanup/reconnect
- men öppna inte sloten för fler writes innan den gamla transaktionen är avslutad eller anslutningen rivits

Detta är kärnan i att kö inte ska kunna byggas.

### 4. Keep-alive måste följa exakt samma single-slot-regel

Keep-alive ska fortsätta finnas för att inte tappa länken, men den får inte någonsin skapa en extra write bakom active mode.

Ändring i `pi/src/ble/protocol.ts`:
- keep-alive checkar samma `writePending` + `slotLockedUntil`
- om active path nyligen tagit sloten: skip
- om en write hängt: skip, inte försök parallellt

Det gör att hela BLE-kedjan verkligen blir "one writer, one slot".

### 5. Städa tick/rate-limit-kopplingen i engine och API

I `pi/src/piEngine.ts`:
- ta bort beroendet där `setTickMs()` driver BLE-rate-limit som separat koncept
- behåll bara ticken som engine-takt
- om tick är hårdkodad 25 ms ska BLE-slot lease också vara 25 ms

I `pi/src/configServer.ts`:
- uppdatera `/api/tick-ms` och `/api/ble/rate-limit` så svar/texter inte längre säger att rate-limit auto-följer eller använder andra värden än själva slot-kontraktet
- om tick-slidern är borttagen i UI:t, håll backend-semantiken konsekvent med fast 25 ms

## Exakt beteende efter ändringen

I active mode:

```text
Tick N:
- slot ledig
- write accepteras
- slot låses i 25 ms
- writeAsync startas fire-and-forget

Mellan tick N och N+1:
- även om promise resolvar efter 1 ms är sloten fortfarande låst

Tick N+1:
- om 25 ms inte passerat eller write fortfarande pending -> 'busy' och droppa frame
- annars får exakt en ny frame försöka skriva
```

Resultat:
- inga extra writes mellan ticks
- ingen intern app-kö
- om BLE halkar efter droppas frames hellre än att gamla frames lever kvar

Det matchar ditt krav: levererade paket ska vara så färska som möjligt, inte kompletta.

## Filer att ändra

- `pi/src/ble/protocol.ts`
  - ersätt promise-slot/backpressure med strict lease-slot
  - ta bort separat rate-limit i active path
  - gör watchdog fail-closed
  - låt keep-alive använda samma gate

- `pi/src/piEngine.ts`
  - ta bort kopplingen till separat `setMinWriteIntervalMs(...)`
  - behåll tydlig semantik: tick styr cadence, slot styr om en write får ske

- `pi/src/configServer.ts`
  - städa API-svar och texter kring tick/rate-limit så de matchar nya kontraktet

- `.lovable/memory/pi/ble/single-slot-write-contract.md`
  - uppdatera kontraktet från promise-slot till strict lease-slot

- `.lovable/memory/pi/ble/write-without-response-mandatory.md`
  - uppdatera noteringen så den inte längre säger att separat rate-limit är enda skyddet, utan att strict slot lease nu är primär spärr

## Vad jag medvetet inte ändrar

- `writeAsync(..., true)` behålls
- ingen ACK-baserad lösning
- ingen högre tick-frekvens
- ingen ny queue
- ingen retry av droppade frames

## Förväntat resultat

- Kö kan inte byggas i vår egen sändhantering
- En upptagen eller hängande write blockerar nya writes i stället för att gamla och nya blandas
- Vid belastning tappas frames, men de som går igenom ligger nära aktuell musik
- BLE-output blir "live" i stället för att kunna glida sekunder efter ljudet
