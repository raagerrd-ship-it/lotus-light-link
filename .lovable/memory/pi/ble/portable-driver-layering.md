---
name: BLE-driver utbruten till portabel ble-driver/
description: pi/src/ble-driver/ är en fristående BLE-lampdriver (noll imports utanför mappen). pi/src/ble/ är app-glue (shims + subsystem-state). Motorn (piEngine) är lager ovanpå via createLampDriver/låg-nivå-exports.
type: feature
---
**Lageruppdelning (2026-06):**

- `pi/src/ble-driver/` — portabel BLE-lampdriver (BLEDOM/ELK). **Inga imports utanför mappen** (verifiera: `grep -rnE "from ['\"]\.\./|import\(['\"]\.\./" pi/src/ble-driver/` → tomt). Innehåller: `protocol`, `connect` (var connect-hardcoded), `state` (BLE-core: device/bleStats/UUID), `controllerDrain`, `forceConnInterval`, `adapter-hci-check`, `noble-singleton`, `reconnect-flag`, `device-config` (var hardcoded-device, nu muterbar via `setDeviceConfig`), `log` (egen dlog, env-gated `LOTUS_DEBUG`, override via `setLogger`), `types`, `index` (`createLampDriver(config)`), `README.md`.
- `pi/src/ble/` — app-glue. `index.ts` re-exporterar drivern + subsystem-state. `subsystem-state.ts` = mic/sonos/engine-tracking + transition-logg (DATA_DIR) — flyttat UT ur BLE-core. Övriga `ble/*.ts` är **shims** (`export * from '../ble-driver/...'`) som bevarar befintliga importvägar (`./ble/state.js`, `./ble/connect-hardcoded.js`, osv.) — rör inte.

**Konfig-injektion:** mål-lampa via `createLampDriver({ device:{name,mac} })` eller `setDeviceConfig`. Restart-loggning är en hook: `setRestartHook(...)` wiras i `index.ts` boot (drivern importerar INTE restartLog). Standalone = noop.

**Regel:** ny BLE-kärnlogik läggs i `ble-driver/` och får aldrig importera utanför mappen. App-specifikt (subsystem, restart-logg, Sonos) hålls i `ble/`/app via hooks.
