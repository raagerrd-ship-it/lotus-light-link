---
name: Lärd volym→gain — lär → LÅS → sparat (FIX 4b)
description: Per Sonos-volym ackumuleras ett stabilt aggregat (löpande medel av 4s-p90 över alla låtar). Efter lgLockAfterMs (20 min) låses ref:et och gainen står helt still. Persisteras per volym i mic-state.json. Omlärning via relearnGain()/POST /api/learned-gain/relearn.
type: feature
---
**Varför inte EMA (FIX 4, ersatt):** EMA:n stod aldrig still — drev ±25–30 % inom en låt och 4 dB mellan låtar vid samma volym. Aggregat-medel + lås ger ett värde som fryser.

**Implementation (`pi/src/alsaMic.ts`):**
- `LgEntry = { ref, sum, count, learnMs, locked }`, `lgTable: Map<vol, LgEntry>`.
- `learnGainSample(blockRms, blockSec)`: gate:ad (spelar, ej TV, ej tystnad < 0.0015, 3 s frys efter volymbyte). 4s-ring → p90 → `sum += p90; count++; ref = sum/count`. `learnMs += blockSec*1000`; `learnMs >= lgLockAfterMs` (default 1 200 000 ms) → `locked = true` och all vidare uppdatering hoppas över.
- `learnedGainFor(v)`: exakt lärt ref → log-interpolerade lärda grannars ref → `null` (då tvåpunkts-`interpolateGain` som prior). Gain = `lgTarget / ref` clampad.
- `relearnGain(vol?)`: raderar en volym eller hela tabellen, sparar direkt, `refreshAutoGain()`.
- Persistens: `learnedGain` i `mic-state.json` (debounced 30 s). Gammalt `learnedGainRefs` (volym→number) migreras till `{ref, sum:ref, count:1, learnMs:0, locked:false}`.
- Params: `setLearnedGainParams({enabled, target, winSec, lockAfterMs})`. `lgRefTauSec` borta.

**API:** `GET /api/learned-gain`, `POST /api/learned-gain/relearn` `{vol?}`, samt `live.learnedGain` i `/api/status` (per volym: ref, gain, learnMs, locked).

**Parat med:** `DEFAULT_CAL.adaptiveCeiling = false` i `piEngine.ts`.
