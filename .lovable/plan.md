
## Problem

Nuvarande strict lease-slot stoppar bara att appen själv kallar `writeAsync(...)` mer än en gång per 25 ms. Det bevisar inte att BLE-kedjan faktiskt är tom. Med `writeAsync(..., true)` får vi bara ett snabbt "packet accepted into stack/HCI", inte "packet left controller/radio". Därför kan kö ändå byggas under ytan och lampan fortsätta långt efter att låten slutat.

## Rotorsak

Nuvarande kontrakt i `pi/src/ble/protocol.ts` är:

- max 1 write-försök per tick
- men nästa tick får ändå skriva så fort lease-tiden gått ut
- utan någon signal om att föregående paket verkligen blivit färdigt i BLE-controller/HCI-ledet

Det betyder att vi idag har "single slot i appen", men inte "single outstanding packet i BLE-kedjan".

## Mål

Göra single-slot verkligt end-to-end:

- 1 tick = max 1 försök
- max 1 outstanding BLE-paket åt gången
- om controller/radio inte hunnit tömma föregående paket: droppa nästa frame
- om outstanding-läge fastnar: bryt länken och reconnecta, aldrig fortsätt mata på
- synk prioriteras över leveransgrad

## Lösning

### 1. Byt från lease-only till tvådelad gate: tick-slot + controller-drain
I `pi/src/ble/protocol.ts` behålls tick-lease som cadence-regel, men den blir inte ensam spärr längre.

Ny gate före varje write:

```text
if no device -> 'no-device'
if controllerOutstanding -> 'busy'
if now < slotLockedUntil -> 'busy'
if no-change -> 'no-change'
else:
  controllerOutstanding = true
  slotLockedUntil = now + tickMs
  writeAsync(..., true)
  return 'sent'
```

Skillnaden är att `controllerOutstanding` inte släpps av promise-resolution. Den släpps först när BLE-stacken signalerar att föregående paket verkligen är färdigt nedströms.

### 2. Koppla in verklig drain-signal från BLE/HCI
Lägg in en liten intern tracker för "packet completed" i BLE-lagret, kopplad vid anslutning och städad vid disconnect.

Implementationen ska använda noble-bindningens underliggande HCI-signal för completed packets / motsvarande sänd-kredit, så att vi kan veta när ett outbound-paket faktiskt lämnat outstanding-läget.

Detta läggs i BLE-lagret, t.ex. via:

- ny helperfil för controller-drain tracking, eller
- direkt i `connect-hardcoded.ts` om noble-internalen måste hookas där

Det viktiga kontraktet blir:

```text
send accepted -> outstanding = true
HCI completed-packets event -> outstanding = false
```

Inte:

```text
writeAsync promise resolved -> outstanding = false
```

### 3. Fail-closed om outstanding fastnar
Om ett outstanding-paket inte får drain-signal inom ett kort, definierat fönster:

- markera `writeStuckCount`
- logga tydligt backlog/stuck-reason
- stoppa vidare writes
- riv länken och låt reconnect-logiken ta över

Ingen force-release av sloten. Ingen fortsatt sändning "för säkerhets skull".

Detta gör att kö inte kan fortsätta byggas i tysthet. Antingen dräneras paketet, eller så bryts länken.

### 4. Keep-alive måste respektera samma outstanding-gate
`startKeepAlive()` i `pi/src/ble/protocol.ts` ska använda exakt samma villkor:

- skicka aldrig om `controllerOutstanding === true`
- skicka aldrig om lease är låst
- active path har alltid företräde

Keep-alive får alltså inte kunna lägga ett extra paket bakom ett redan outstanding paket.

### 5. Uppdatera diagnostik så problemet går att verifiera
Utöka `bleStats` i `pi/src/ble/state.ts` och API-svaren i `pi/src/configServer.ts` så att det går att se om vi verkligen slutat bygga kö.

Lägg till mätvärden som:

- `controllerOutstanding`
- `controllerBusyCount`
- `controllerCompleteCount`
- `controllerStuckCount`
- `outstandingAgeMs`
- senaste reconnect-orsak relaterad till stuck/backlog

Behåll gärna befintliga `skipBusyCount`, men separera tydligt:
- busy pga tick-lease
- busy pga outstanding packet
- stuck/reconnect

Då går det att se om systemet droppar färska frames korrekt i stället för att bufferera gamla.

### 6. Justera dokumentation och build tag
Uppdatera minnesfilerna så de inte längre beskriver lease-slot som tillräckligt skydd i sig.

Ny formulering ska vara ungefär:

- tick-slot styr cadence
- controller-drain styr om kedjan verkligen är tom
- promise-resolution är inte ett kvitto på att nästa paket är säkert att skicka

Bumpa även `BLE_BUILD_TAG` så det syns att Pi:n kör backlog-fixen.

## Filer att ändra

- `pi/src/ble/protocol.ts`
  - inför controller-outstanding gate
  - släpp inte på promise-resolution
  - stuck => disconnect/reconnect, inte reopen

- `pi/src/ble/connect-hardcoded.ts`
  - koppla in och rensa HCI/completed-packets-hook vid connect/disconnect

- `pi/src/ble/state.ts`
  - nya stats + bump av `BLE_BUILD_TAG`

- `pi/src/ble/index.ts`
  - exportera ev. ny controller-drain API/helper

- `pi/src/configServer.ts`
  - exponera nya diagnostikfält i status/output

- `.lovable/memory/pi/ble/single-slot-write-contract.md`
  - uppdatera kontraktet från "lease-only" till "lease + controller-drain"

- `.lovable/memory/pi/ble/write-without-response-mandatory.md`
  - förtydliga att `withoutResponse` kräver drain-baserad gate, inte bara tidslease

## Exakt beteende efter ändringen

```text
Tick N:
- inget outstanding
- lease ledig
- 1 write accepteras
- outstanding = true

Mellan tick N och N+1:
- promise kan resolva direkt
- outstanding ligger kvar = ingen ny write tillåts

Tick N+1:
- om outstanding kvarstår -> 'busy', droppa denna frame

När controller signalerar completed packet:
- outstanding = false

Nästa tick efter det:
- exakt 1 ny write får försöka gå ut
```

Om completed-signal inte kommer i tid:

```text
outstanding fastnar
-> droppa frames
-> disconnect/reconnect
-> aldrig fortsatt påmatning
```

## Förväntat resultat

- Lampan kan inte ligga 20 sekunder efter längre på grund av vår egen sändhantering
- Vid störning eller långsam BLE-länk tappas frames hellre än att gamla frames spelas upp sent
- Outputen blir "live" och nära aktuell musik, även om inte varje paket levereras
- `1 tick = 1 BLE-paket` blir sant i praktiken, inte bara i app-logiken

## Tekniska detaljer

Nuvarande lease-slot är fortfarande användbar, men bara som taktbegränsning. Den räcker inte ensam eftersom `writeAsync(..., true)` inte representerar faktisk drain i controller/radio. Den nödvändiga ändringen är därför inte "mer timing", utan att gate:a på verklig sänd-kedje-tömning i BLE-lagret.
