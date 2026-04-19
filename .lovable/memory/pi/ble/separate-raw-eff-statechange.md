---
name: Separera raw / effektiv / stateChange
description: BLE-status delas i tre oberoende begrepp — raw noble.state, effektiv adapter (caps-aware), och stateChange-event observerat. Blanda aldrig ihop dem i loggar/UI.
type: feature
---
**Tre oberoende statusbegrepp i BLE-koden:**

1. **raw noble.state** — vad `noble.state`/`_state` rapporterar. Ligger ofta kvar på `'unknown'` på Pi trots att BLE fungerar perfekt (libuv-race vid boot åt stateChange-eventet).
2. **effektiv adapter-state** — `getAdapterState()` med caps-aware override: returnerar `'poweredOn'` om `processHasBtCaps()` + hci0 UP, även när raw är `'unknown'`. Detta är vad vi faktiskt opererar mot.
3. **stateChange observerat** — `hasNobleEverFiredStateChange()`. Helt oberoende av (1) och (2). Kan vara `false` även när BLE fungerar.

**Regler:**
- Heartbeat använder `eng:redo/vänta` + `raw:X(eff:Y)` + `sc:y/n` — aldrig `pow✓/✗` (förvirrande, blandar ihop sc med eng).
- Boot-loggen säger "BLE-motor redo" om eff=poweredOn även om raw=unknown och sc=n. Aldrig "noble ej poweredOn" som felmeddelande när motorn är operativ.
- `pi/src/ble/scan.ts`: om `waitForPoweredOnAsync` timeoutar men `getAdapterState()==='poweredOn' && processHasBtCaps()` → fortsätt scan ändå. Ingen auto-respawn (manual-only-policy).
- Pipeline-checklistan: `noble-state`-steget är `pending` (gult), inte `fail` (rött), när effektiv adapter är redo men sc inte fångats. Steget heter "noble stateChange-event fångat (informativt)".

Build-tag: `2026-04-19/separate-raw-eff-statechange`.
