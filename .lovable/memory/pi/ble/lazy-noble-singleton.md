---
name: noble lazy singleton pattern
description: Noble får ALDRIG require:as på top-level. Använd noble-singleton.ts som lazy-laddar vid första access så event-loopen är ren när stateChange fyrar
type: constraint
---
**Regel:** `import noble from '@stoprocent/noble'` får ALDRIG ske på top-level i någon fil. All access till noble går via `pi/src/ble/noble-singleton.ts` som lazy-require:ar biblioteket vid första property-access.

**Varför:** noble emit:ar `stateChange` exakt en gång via libuv strax efter require(). Om require sker vid module-load (t.ex. via `import './ble/state.js'` från `configServer.ts`) blockerar andra synkrona imports event-loopen runt det fönstret → eventet tappas → `noble.state` fastnar i `'unknown'` för all framtid i processen. Se mem://pi/ble/noble-statechange-event-loop-race.

**Hur:** 
- Importera `noble` från `./noble-singleton.js` (Proxy som lazy-laddar)
- I `state.ts`: skydda `getNobleRawState()` och `releaseNobleResources()` med `if (!hasNobleLoaded()) return undefined`
- I diagnostik-endpoints: använd `hasNobleLoaded()` innan du läser `noble.state` direkt
- Subsystem-startern `startBleEngine()` är det enda stället där noble får laddas, och den körs ALDRIG vid boot — bara när användaren trycker "Anslut BLE-motor" i UI:t

**Resultat:** Engine-bootad utan att require:a `@stoprocent/noble`. Första noble-access sker när `startBleEngine()` kör `await import('./nobleBle.js')` → `ensureAdapterUp()` → `(noble as any).waitForPoweredOnAsync(...)` → då sker laddningen på en ren event-loop precis som i `pi/scripts/noble-scan-isolated.mjs`, och stateChange → poweredOn fångas inom ~300ms.
