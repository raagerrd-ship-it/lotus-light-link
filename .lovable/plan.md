

# Riv hela legacy-BLE-flödet

UI:t använder bara hardcoded-flödet (`/api/ble/engine/start`, `/api/ble/connect`, `/api/ble/disconnect`, `/api/ble/state`, `/api/ble/output`). Allt annat — scan, select, forget, save-manual, diagnostik-pipeline, reset, respawn, demand-baserad reconnect, watchdog, hcitool-hybrid — rivs.

## Bakgrund

Legacy-flödet byggdes innan vi visste att noble på Pi Zero 2W vägrar leave `unknown`-state. Vi byggde watchdogs, force-mutate-skydd, scan-watchdogs, hcitool-fallback, mgmt-socket-release-rutiner. Sedan visade `noble-scan-isolated.mjs` att rätt sekvens (vänta passivt → scan → matcha → connect) bara fungerar. Hardcoded-flödet i `engine-start-minimal.ts` + `connect-hardcoded.ts` är vad som faktiskt körs nu.

## Backend som rivs

**Filer som tas bort i `pi/src/ble/`:**
- `connect.ts` (legacy connect + autoConnectSaved + GATT discovery via state)
- `scan.ts` + `scan-discover.ts` + `scan-watchdog.ts` + `scan-metrics.ts`
- `save.ts` (selectDevice/forgetDevice/saveManualDevice + savePeripheralMetadata)
- `reconnect.ts` (requestConnect/releaseDemand + reconnect-loop)
- `adapter.ts` (ensureAdapterUp/waitForNoblePoweredOn — engine-start-minimal har sin egen passiva isHci0Up-vänta)
- `heartbeat.ts` (loggande statusloop — connect-hardcoded loggar redan vid disconnect)
- `watchdog.ts` (noble-stuck respawn — det här problemet är borta sen vi väntar passivt på hci0)
- `sysExec.ts` (bara watchdog/adapter/heartbeat använde det)

**Slankas i `pi/src/ble/state.ts`:**
- Tar bort: savedDevice (id/name/address/addressType/connectable/serviceUuids), demandActive, scan-relaterad state, workaround-counters för raden ovan, force-mutation snapshot, hci-probe snapshot, getNobleRawState/recordObservedNobleState, BootPhase, SubsystemId/SubsystemState.
- Behålls: noble singleton-ref, bleStats (sentCount/writeFail/skipDelta/skipBusy/disconnectCount etc — används av `protocol.ts` + `/api/ble/output`), CHAR_UUID/SERVICE_UUID, brightMaxBuf-relevant connection-log för disconnect-event, BLE_BUILD_TAG.

**Filer som behålls i `pi/src/ble/`:**
- `engine-start-minimal.ts`, `connect-hardcoded.ts`, `hardcoded-device.ts`
- `protocol.ts`, `noble-singleton.ts`, `adapter-hci-check.ts`, `hci-socket-probe.ts`, `types.ts`
- `state.ts` (slank)
- `index.ts` (endast hardcoded-relevanta re-exports)

**Endpoints som tas bort i `pi/src/configServer.ts`:**
- `POST /api/ble/scan`
- `GET  /api/ble/devices`
- `POST /api/ble/select`
- `POST /api/ble/forget`
- `POST /api/ble/save-manual`
- Den dubblerade legacy `POST /api/ble/connect` (raden 462) — behåller hardcoded-versionen på rad 301
- Den dubblerade legacy `GET /api/ble/state` (raden 535) — behåller hardcoded-versionen på rad 326
- `POST /api/ble/start`, `POST /api/ble/stop`
- `POST /api/ble/reset`, `POST /api/ble/respawn`
- `GET  /api/ble/log`, `GET  /api/ble/saved-metadata`
- `GET  /api/ble/diagnostics`
- `POST /api/subsystem/ble-engine/start` ersätts av `/api/ble/engine/start` — tas bort. (`mic`/`sonos` subsystem-endpoints behålls.)

**Endpoints som behålls/förenklas:**
- `GET /api/health`, `GET /api/status`: rensar `savedDevice`/`demand`/`watchdogReason`-fält. Behåller `connected`, `adapterState`.
- `GET /api/ble/output` (lamp-VU-meter): orörd.
- `GET /api/ble/rate-limit`, `PUT /api/ble/rate-limit`: orörd.
- `POST /api/ble/autotune`: orörd.

**`pi/src/index.ts`:** `startBleEngine`-subsystem-funktionen tas bort (motorn startas via `/api/ble/engine/start` direkt). `nobleBle`-import + `disconnectAll(true)`-call i shutdown ersätts av direkt `disconnectHardcoded()`. Bara `mic` + `sonos` kvar som lazy-subsystem.

**`pi/src/nobleBle.ts`:** Tas bort. Inga konsumenter återstår efter ovan.

## Frontend som rivs

**`src/pages/PiMobile.tsx`:**
- BleDiagnosticsPanel-komponenten (~250 rader): hela steg-för-steg pipeline-rutan, BLE-toggle, BLE-event-logg, `requestBleScan`/`waitForBleRecovery`/`handleBleScan`/`handleSave`/save-manual-form. Allt borta.
- State för scan/save/picker (`bleScanResults`, `bleScanLog`, `bleSavedId`, `bleSavedName`, `bleSavedAddress`, `bleConnectedId`, `blePreview`, `showBlePicker` osv).
- `/api/ble/diagnostics`-poll-loopen.
- `/api/status`-läsningar av `ble.savedDeviceId`/`ble.savedDeviceName`/`ble.demand`/`ble.scanning` ersätts av en plain `connected: boolean` från `/api/ble/state` (som BleControlPanel redan exponerar via callback).

Resultat i UI: BLE-blocket består endast av `BleControlPanel` (Starta motor + Anslut + lamp-VU-meter).

**`src/components/SubsystemStartupPanel.tsx`:** `bleEngine`-blocket tas bort (det dubblerade `BleControlPanel`s "Starta motor"). Panelen hanterar bara `mic` + `sonos`.

## Subsystem-state-städning

`pi/src/ble/state.ts` har en SubsystemId='bleEngine'|'mic'|'sonos'|'engine'-modell. Vi tar bort 'bleEngine' helt — `connect-hardcoded.ts` rapporterar via sin egen `getHardcodedConnected()` istället. `getAllSubsystemStates()` returnerar bara mic+sonos+engine. `/api/subsystem/status` förblir, men utan bleEngine-fältet.

## Genomförande

1. Ta bort filer i `pi/src/ble/` (8 st) + `pi/src/nobleBle.ts`.
2. Slimma `pi/src/ble/state.ts` (ta bort saved-device + demand + scan + workaround-counters + bootPhase + bleEngine-subsystem).
3. Slimma `pi/src/ble/index.ts` så bara hardcoded-relevanta exports finns kvar.
4. Riv legacy-endpoints + import-listan i `pi/src/configServer.ts`. Fixa `/api/health` + `/api/status` så de inte refererar borttagna funktioner.
5. Slimma `pi/src/index.ts` — ta bort `startBleEngine`-subsystem.
6. Riv BleDiagnosticsPanel + scan-picker + saved-card + tillhörande state/effekter i `src/pages/PiMobile.tsx`.
7. Ta bort `bleEngine`-block i `src/components/SubsystemStartupPanel.tsx`.

## Risker

- `protocol.ts` använder `bleStats` och en del state-helpers — säkerställa att inget den importerar tas bort.
- `connect-hardcoded.ts` importerar `setDevice`, `bleStats`, `SERVICE_UUID`, `CHAR_UUID` från `state.ts` — alla behålls.
- Bygget körs via GitHub Actions (mem://pi/deployment/release-via-github-actions), så TS-kompilering är säkerhetsnätet.

