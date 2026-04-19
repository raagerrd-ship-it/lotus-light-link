

## Vad jag har verifierat i `pi/scripts/noble-scan-isolated.mjs`

Ja, jag har läst scriptet rad för rad. Här är **exakt** vad det gör som vi måste spegla:

### 1. Import-ordning (kritiskt)
```js
const noble = (await import('@stoprocent/noble')).default;
```
- **Första** raden i filen som rör något native.
- Inga andra imports före. Inga andra native-bindningar laddade alls (ingen alsa, inget annat).
- Event-loopen är **helt ren** när noble require:as → libuv hinner emittera `stateChange` inom ~250-300ms.

### 2. Listeners attach:as OMEDELBART efter import
```js
for (const ev of ['stateChange', 'scanStart', 'scanStop', 'discover', ...]) {
  noble.on(ev, ...);
}
```
- Ingen `await`, ingen annan kod mellan import och `.on('stateChange', ...)`.

### 3. Vänta 1s på initial stateChange
```js
await new Promise(r => setTimeout(r, 1000));
```
- Ger libuv tid att fyra eventet innan vi gör något annat.

### 4. Försäkra poweredOn
```js
if (noble.state !== 'poweredOn') {
  await noble.waitForPoweredOnAsync(3000);
}
```

### 5. Scan
```js
await noble.startScanningAsync([], true);  // [], true = inga filter, allowDuplicates
// vänta 5s, samla discover-events i listener
await noble.stopScanningAsync();
```

### Vad som FÅR den att fungera (och vad vår engine bryter mot)

| noble-scan-isolated.mjs | Vår engine idag |
|---|---|
| `import noble` är allra första native-anropet | `configServer.ts` top-level-importerar `nobleBle.js` → noble laddas medan TS-moduler/alsa fortfarande blockerar event-loopen |
| Inga andra native-bindningar i processen | alsa-capture native-binding finns med |
| Listener attach direkt efter import | Listener attachades på olika ställen, ibland för sent |
| `startScanningAsync([], true)` | Scan-flödet hade watchdogs, retry, force-mutate-state-helpers |
| Connect via discovered peripheral | Vi har provat connect-by-address utan föregående scan |

### Slutsats för planen

Den nya `startBleEngine()` + `connect`-vägen måste:
1. **Aldrig** importera noble på top-level någonstans (lazy-singleton finns redan).
2. När användaren trycker "Starta motor": `await import('@stoprocent/noble')` som **första** native-anrop i den request-handlern, attach `stateChange`-listener i **samma synkrona block**, vänta upp till 5s på `poweredOn`.
3. För connect mot hårdkodad ELK-BLEDOM01: kör `startScanningAsync([], true)` i 5s, plocka peripheralet med matchande address (`be67001509 41` utan kolon, lowercase), `stopScanningAsync`, sedan `peripheral.connectAsync()` på det objektet. **Inte** connect-by-address utan scan — det är inte det isolerade scriptet bevisar.
4. Inga watchdogs, ingen reconnect-loop, inga force-mutates av `noble._state`.

## Plan (uppdaterad)

### Hårdkodning
`pi/src/ble/hardcoded-device.ts`:
```ts
export const HARDCODED_DEVICE = {
  name: 'ELK-BLEDOM01',
  mac: 'BE:67:00:15:09:41',
  addressLower: 'be:67:00:15:09:41',
  idNoColon: 'be67001509 41'.replace(/\s/g,''),
};
```

### Backend — 4 endpoints
`pi/src/configServer.ts`:
- `POST /api/ble/engine/start` → lazy-importera noble-singleton, attach stateChange direkt, vänta `poweredOn` (5s) → `{ ready, durationMs, rawState }`
- `POST /api/ble/connect` → kör **scan-then-connect** mot HARDCODED_DEVICE (precis som isolated-scriptet) → `{ connected, name, mac }`
- `POST /api/ble/disconnect` → `{ disconnected }`
- `GET /api/ble/state` → `{ engineReady, connected, device }`

**Ta bort:** alla scan-, save-manual-, forget-, select-, diagnostics-, watchdog-endpoints.

### Ny `pi/src/ble/connect-hardcoded.ts`
Speglar `noble-scan-isolated.mjs` exakt:
1. Vänta på `poweredOn` om inte redan.
2. `startScanningAsync([], true)`.
3. Lyssna på `discover`, matcha på `peripheral.address.toLowerCase() === HARDCODED_DEVICE.addressLower` ELLER `peripheral.id === HARDCODED_DEVICE.idNoColon`.
4. Vid match: `stopScanningAsync()` → `peripheral.connectAsync()` → spara peripheralet i state.
5. 8s timeout, returnera fel om ingen match.

### `pi/src/index.ts` `startBleEngine()`
Endast lazy-importera noble-singleton + vänta på `poweredOn`. Ingen scan, ingen reconnect, inga watchdogs.

### Frontend — minimerad

Ny `src/components/BleControlPanel.tsx`:
```text
┌─ BLE-motor ───────────────────────────┐
│ ● Redo            [Starta motor]      │
└───────────────────────────────────────┘
┌─ Lampa ───────────────────────────────┐
│ ELK-BLEDOM01                          │
│ BE:67:00:15:09:41                     │
│ ● Ansluten      [Anslut] [Koppla från]│
└───────────────────────────────────────┘
```

`SubsystemStartupPanel.tsx`: banta till mic + sonos. Disabled tills `connected === true`. Inga autostart, inga fel-expanders.

`src/pages/PiMobile.tsx`: rensa bort all felsöknings-UI (raw/effective state, hci-checklists, scan-metrics, workaround-counters, save-manual, scan-list, diagnostik). Montera `BleControlPanel` + bantad `SubsystemStartupPanel`.

## Filer
- `pi/src/ble/hardcoded-device.ts` — **NY**
- `pi/src/ble/connect-hardcoded.ts` — **NY**, scan-then-connect mot hårdkodad MAC
- `pi/src/configServer.ts` — krymp till 4 endpoints
- `pi/src/index.ts` — förenkla `startBleEngine`
- `src/components/BleControlPanel.tsx` — **NY**
- `src/components/SubsystemStartupPanel.tsx` — banta till mic+sonos
- `src/pages/PiMobile.tsx` — rensa felsöknings-UI

## Tas bort
Sök-UI, MAC-input, save/forget, diagnostik-paneler, raw state-rader, workaround-counters, autostart, auto-reconnect, scan-watchdog, fel-expanders. Återinförs när grundflödet bevisat fungerar.

