---
name: Profiler och inställningar måste överleva uppdateringar
description: pi/data/ ägs av app:en och får ALDRIG röras av update/setup. storage.ts auto-migrerar mellan legacy-paths om DATA_DIR ändras (PCC_CONFIG_DIR av/på).
type: constraint
---
**Garanti:** Alla settings (profiles.json, light-calibration.json, device-modes m.fl.) lagras i `DATA_DIR` (default `/opt/lotus-light/pi/data`, override via `PCC_CONFIG_DIR` eller `LOTUS_DATA_DIR`) och MÅSTE överleva både OTA-update och re-setup.

**Skyddade kontrakt:**
1. `pi/update-services.sh` får ALDRIG `rm -rf` eller `cp` över `pi/data/`. Den rör endast `dist/`, `node_modules/`, `vendor/`, `package.json`, `services.json`, scripts.
2. `pi/setup-lotus.sh` får endast `mkdir -p pi/data` + `chown -R` — aldrig delete/overwrite av innehåll.
3. `pi/src/storage.ts` migrerar automatiskt vid boot: om aktiv `DATA_DIR` saknar *.json-filer letar den i kända legacy-paths (`/opt/lotus-light/pi/data`, gamla env-overrides) och kopierar över. Detta skyddar mot "förlorade profiler" om PCC senare börjar/slutar sätta `PCC_CONFIG_DIR`.

Verifierat 2026-04-22.
