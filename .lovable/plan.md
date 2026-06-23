# Bryt ut BLE-lampdriver + städa motorn

Mål: göra BLE-styrningen till en fristående, portabel driver som kan kopieras in i andra projekt, med den ljudreaktiva motorn som ett valfritt lager ovanpå. Samtidigt rensa kvarvarande dead-code-kommentarer.

## Arkitektur (två lager)

```text
pi/src/ble-driver/        ← LAGER 1: portabel BLE-lampdriver (noll app-beroenden)
   index.ts               createLampDriver(config) → publik API
   protocol.ts            paket, write-gate, gamma, keep-alive
   connect.ts             connect/disconnect/reconnect (var connect-hardcoded.ts)
   reconnect-flag.ts
   controllerDrain.ts
   forceConnInterval.ts
   adapter-hci-check.ts
   noble-singleton.ts
   state.ts               BARA BLE-core-state (device, noble, bleStats)
   types.ts
   README.md              minimal användning i annat projekt

pi/src/ble/               ← LAGER 2-glue: app-specifikt, importerar drivern
   subsystem-state.ts     mic/sonos/engine-tracking + transition-logg (DATA_DIR)
   engine-start-minimal.ts
   index.ts               re-exporterar drivern + subsystem-state (oförändrad yta mot appen)

pi/src/piEngine.ts        ← motorn: konsumerar driverns publika API
```

## Vad blir konfigurerbart (gör drivern portabel)

Idag är två saker hårdkodade/app-kopplade och måste injiceras:

1. **Mål-enhet** — `HARDCODED_DEVICE` (`ELK-BLEDOM01` / MAC) blir ett `config`-objekt till `createLampDriver({ device: { name, mac } })`. Pi-appen skickar in nuvarande värden, andra projekt sina egna.
2. **Logg/lagring** — `state.ts` importerar `DATA_DIR` enbart för subsystem-transition-loggen, som inte hör till BLE-styrning. Den flyttas ut till `pi/src/ble/subsystem-state.ts` (app-lagret). Drivern loggar via `console` med valfri injicerbar logger.

## Publik driver-API (`createLampDriver`)

Tunt skal runt befintlig logik — ingen ny funktionalitet:

```text
connect()/disconnect()         ← connect-hardcoded
setColor(r,g,b, brightness)    ← sendToBLE
setIdleColor(r,g,b)
setPower(on)                   ← sendPower
canWriteNow()
setDimmingGamma()/getDimmingGamma()
setSlotLeaseMs()
startKeepAlive()/stopKeepAlive()
getStats()                     ← bleStats
isConnected()
```

## Steg

1. **Skapa `pi/src/ble-driver/`** och flytta de rena BLE-core-filerna dit (`protocol`, `connect-hardcoded`→`connect`, `reconnect-flag`, `controllerDrain`, `forceConnInterval`, `adapter-hci-check`, `noble-singleton`, `types`). Justera interna relativa imports.
2. **Dela `state.ts`**: BLE-core-state (device, noble, bleStats, SERVICE/CHAR-UUID, build-tag) → `ble-driver/state.ts`. Subsystem-tracking + transition-logg (DATA_DIR) → `pi/src/ble/subsystem-state.ts`.
3. **Konfig-injektion**: `hardcoded-device.ts` blir en `device`-param i driver-config; behåll nuvarande Pi-värden som default i appen.
4. **`ble-driver/index.ts`**: exponera `createLampDriver(config)` + typer. Skriv `README.md` med ett minimalt exempel (connect → setColor → loop).
5. **Glue-lager `pi/src/ble/index.ts`**: re-exportera från drivern + subsystem-state så att resten av appen (`piEngine`, `configServer`, `engineLifecycle`, `index.ts`) importerar precis som idag — minimerad blast radius.
6. **Städning**: ta bort kvarvarande döda kommentarer som refererar avvecklad kod (`lightRecorder`, `playbackTick`) i `piEngine.ts`, `index.ts`, `configServer.ts`. (De faktiska identifierarna onsetExpress/DELTA_SKIP/_pb/hci-socket-probe finns redan inte kvar — verifieras med grep.)
7. **Verifiera**: `cd pi && npx tsc` rent. `grep -rn "lightRecorder\|playbackTick\|onsetExpress\|DELTA_SKIP\|hci-socket-probe" pi/src` → 0 träffar. `grep -rn "from '\.\./" pi/src/ble-driver` → inga imports utanför driver-mappen (bekräftar portabilitet).

## Viktigt / avgränsningar

- Ingen beteendeförändring i runtime — det här är en omflyttning + tunt API-skal. Cal-värden, write-gate, reconnect-logik och tickMs är oförändrade.
- Drivern blir Node-/noble-beroende (BLE på Pi/Linux). Den är portabel mellan **Node-projekt**, inte till webbläsare (matchar befintlig minnesregel: ingen Web-BLE i browser).
- Permanent på enheten först efter release + `/api/update`, som tidigare.

## Teknisk verifiering av framgång

- `npx tsc` exit 0.
- Pi-appen importerar oförändrat via `pi/src/ble/index.ts`.
- `pi/src/ble-driver/` har noll imports utanför sin egen mapp → kan kopieras rakt in i ett annat Node-projekt och drivas med bara `createLampDriver(config)`.
