---
name: BLE-driver utbruten till portabel ble-driver/
description: pi/src/ble-driver/ är en fristående BLE-lampdriver (noll imports utanför mappen). pi/src/ble/ är app-glue (shims + subsystem-state). Motorn (piEngine) är lager ovanpå via createLampDriver/låg-nivå-exports.
type: feature
---
**Lageruppdelning (2026-06):**

- `pi/src/ble-driver/` — portabel BLE-lampdriver (BLEDOM/ELK). **Inga imports utanför mappen** (verifiera: `grep -rnE "from ['\"]\.\./|import\(['\"]\.\./" pi/src/ble-driver/` → tomt). Innehåller: `protocol`, `connect` (var connect-hardcoded), `state` (BLE-core: device/bleStats/UUID), `controllerDrain`, `forceConnInterval`, `adapter-hci-check`, `noble-singleton`, `reconnect-flag`, `device-config` (var hardcoded-device, nu muterbar via `setDeviceConfig`), `log` (egen dlog, env-gated `LOTUS_DEBUG`, override via `setLogger`), `types`, `index` (`createLampDriver(config)`), `README.md`.
- `pi/src/ble/` — app-glue, endast 3 filer kvar: `index.ts` (re-exporterar drivern + subsystem-state), `subsystem-state.ts` (mic/sonos/engine-tracking + transition-logg i DATA_DIR — flyttat UT ur BLE-core), `engine-start-minimal.ts`. Shim-filerna (`state.ts`, `protocol.ts`, `connect-hardcoded.ts`, `controllerDrain.ts`, `noble-singleton.ts`, `hardcoded-device.ts`, `reconnect-flag.ts`) är BORTTAGNA (2026-06) — alla importörer (piEngine, index, configServer, engineLifecycle) pekar nu direkt på `../ble-driver/...`. Subsystem-symboler importeras från `./ble/subsystem-state.js`.

**Konfig-injektion:** mål-lampa via `createLampDriver({ device:{name,mac} })` eller `setDeviceConfig`. Restart-loggning är en hook: `setRestartHook(...)` wiras i `index.ts` boot (drivern importerar INTE restartLog). Standalone = noop.

**Regel:** ny BLE-kärnlogik läggs i `ble-driver/` och får aldrig importera utanför mappen. App-specifikt (subsystem, restart-logg, Sonos) hålls i `ble/`/app via hooks.
