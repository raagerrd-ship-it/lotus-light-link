---
name: Early stateChange listener kan missa noble's första event
description: Vår early-listener i state.ts kan missa noble's stateChange om event-loopen blockeras vid emit-ögonblicket. Använd recordObservedNobleState() från fallback-vägar (waitForPoweredOnAsync, getNobleRawState) för att markera observation.
type: feature
---
**Symptom:** UI:t visar "Tidig noble stateChange fångad ✗" trots att heartbeaten visar `noble:unknown→poweredOn`. BLE fungerar (scan/connect lyckas) men `hasNobleEverFiredStateChange()` returnerar `false`.

**Orsak:** noble emit:ar `stateChange` exakt EN gång via libuv. Vår early-listener i `pi/src/ble/state.ts` (rad ~78) registreras vid `import noble`, men om något (även mikroskopiskt) blockerar event-loopen vid exakt det ögonblick noble emit:ar → eventet förloras för OSS men noble själv har redan satt sin interna `state`-property.

**Fix:** `recordObservedNobleState(state)` i `state.ts`:
- Idempotent helper som sätter `_cachedNobleState`, `_firstStateChangeAt` och resolvar `_firstStateChangePromise` om vi observerar `state !== 'unknown'` via en fallback-väg.
- Anropas från:
  1. `getNobleRawState()` när vi läser `noble.state` direkt och får ett icke-unknown värde
  2. `index.ts` när `noble.waitForPoweredOnAsync` resolvar i Promise.race-fallbacken

**Regel:** Förlita dig ALDRIG enbart på early-listener för att avgöra om noble är redo. Använd alltid `Promise.race([waitForFirstStateChange, noble.waitForPoweredOnAsync])` + `recordObservedNobleState` på fallback-grenen. Build-tagg: `2026-04-18/record-observed-statechange-from-fallback`.
